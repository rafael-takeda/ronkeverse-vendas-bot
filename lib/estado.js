/**
 * ============================================================================
 * ESTADO — até que bloco já foi anunciado, e o que já saiu
 * ============================================================================
 *
 * É O ÚNICO ESTADO DO BOT, e sem ele nada funciona: a função serverless nasce e
 * morre a cada execução, então sem memória entre chamadas ela reanunciaria as
 * mesmas vendas de minuto em minuto. É esse detalhe que separa "bot" de "spam".
 *
 * DUAS IMPLEMENTAÇÕES, e a escolha é automática:
 *
 *   KV (Upstash / Vercel KV) — quando `KV_REST_API_URL` e `KV_REST_API_TOKEN`
 *   existem. É o modo de produção: sobrevive a deploy, a reinício e a duas
 *   execuções concorrentes.
 *
 *   ARQUIVO — quando não existem. Serve pra rodar na sua máquina e pra GitHub
 *   Actions (que pode versionar o arquivo). Em serverless NÃO serve: o disco é
 *   descartado junto com a execução, e o bot repetiria tudo.
 *
 * O modo em uso é anunciado no log de propósito. "Por que ele está repetindo
 * anúncio" e "o KV não está configurado" são a mesma coisa vista de dois
 * lugares, e essa linha é o que liga as duas.
 */
import { readFile, writeFile } from 'node:fs/promises'

const CHAVE = 'ronkeverse:ultimo-bloco'
const PREFIXO_VISTO = 'ronkeverse:visto:'
const ARQUIVO = new URL('../.estado.json', import.meta.url)

/** Uma venda repetida depois de 24h é problema de outra natureza. Ver o rodapé. */
const VALIDADE_S = 24 * 60 * 60
/** Quantos (tx, tokenId) o modo arquivo guarda. 200 blocos nunca chegam perto. */
const LEMBRA_NO_ARQUIVO = 400

/*
 * DOIS NOMES PRA MESMA COISA, e não é preciosismo.
 *
 * O Upstash entrega as credenciais como `UPSTASH_REDIS_REST_URL/TOKEN`; o KV da
 * Vercel entrega exatamente o mesmo par como `KV_REST_API_URL/TOKEN`. Ler só um
 * dos nomes faz o bot cair no modo arquivo em silêncio — e o sintoma disso é
 * repetir anúncio, que ninguém liga a "esqueci de renomear uma variável".
 */
const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL
const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN
export const usandoKv = Boolean(url && token)

async function kv(caminho, corpo) {
  const r = await fetch(`${url}/${caminho}`, {
    method: corpo === undefined ? 'GET' : 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: corpo,
  })
  if (!r.ok) throw new Error(`KV ${caminho}: HTTP ${r.status}`)
  return (await r.json()).result
}

/**
 * AVISO ALTO, uma vez por processo: em GitHub Actions o modo arquivo não guarda
 * NADA entre execuções.
 *
 * `.estado.json` está no `.gitignore` e o runner é descartado — sem ponteiro, o
 * ciclo seguinte varre 200 blocos pra trás; sem lista de vistos, ele reanuncia o
 * que achar lá. Isso não é hipótese: já aconteceu em produção, com os segredos
 * gravados como `UPSTASH_*` e passados ao workflow como `KV_REST_API_*`. Eles
 * chegaram vazios, `usandoKv` virou false, e o único sintoma foi o canal
 * repetindo venda.
 */
if (!usandoKv) {
  console.warn(
    '[estado] MODO ARQUIVO — sem KV nao ha dedup nem ponteiro entre execucoes ' +
      'em runner descartavel (.estado.json esta no .gitignore). Em producao, configure ' +
      'KV_REST_API_URL/KV_REST_API_TOKEN.',
  )
}

async function leArquivo() {
  let txt
  try {
    txt = await readFile(ARQUIVO, 'utf8')
  } catch (e) {
    // Arquivo ausente é "primeira execução". Falha de I/O de verdade (permissão,
    // disco cheio) sobe — ela não se resolve reescrevendo. Ver `ultimoBloco`.
    if (e.code === 'ENOENT') return null
    throw e
  }

  try {
    return JSON.parse(txt)
  } catch {
    /*
     * ARQUIVO CORROMPIDO SE CURA SOZINHO, e isso é deliberado.
     *
     * A escrita não é atômica (`writeFile` direto) e o runner do Actions morre
     * por `timeout-minutes` — JSON truncado no meio não é hipótese.
     *
     * A primeira versão deste conserto relançava aqui, junto com o erro de I/O.
     * O efeito era pior que o problema: `ultimoBloco` propagava, o ciclo abortava,
     * e o `gravaBloco` também não conseguia reparar, porque ele lê antes de
     * escrever. Bot mudo pra sempre, em toda volta, com um `console.warn` como
     * único sintoma.
     *
     * Tratar conteúdo ilegível como "sem estado" devolve a autocura que existia
     * antes do conserto: o `gravaBloco` da volta seguinte reescreve o arquivo
     * inteiro. O preço é uma varredura de 200 blocos pra trás, que a dedup por
     * `(tx, tokenId)` absorve — e mesmo sem ela, republicar é um erro que se vê e
     * se conserta. Ficar mudo não.
     */
    console.warn('[estado] .estado.json ilegivel — tratando como vazio, sera reescrito')
    return null
  }
}

async function gravaArquivo(dados) {
  await writeFile(ARQUIVO, JSON.stringify(dados, null, 2) + '\n')
}

/**
 * Último bloco já processado, ou null se o bot nunca rodou.
 *
 * NULL SÓ QUANDO A CHAVE NÃO EXISTE. Antes esta função engolia TODA exceção e
 * devolvia null, o que confundia "primeira execução" com "KV quebrado" — e as
 * duas levam a caminhos opostos. Com null o `ciclo.js` começa 200 blocos atrás;
 * se a causa foi o KV pifar, o bot reanuncia ~10 minutos de cadeia A CADA VOLTA,
 * e a dedup que seguraria isso usa a MESMA credencial que acabou de falhar. As
 * duas falham juntas, por construção.
 *
 * Agora falha de LEITURA relança e o ciclo aborta: o ponteiro fica onde está e a
 * próxima volta pega tudo. É o comportamento que este repositório já escolheu de
 * propósito em toda decisão parecida — atrasar é recuperável, repetir não é.
 */
export async function ultimoBloco() {
  if (usandoKv) {
    const v = await kv(`get/${CHAVE}`)
    return v == null ? null : Number(v)
  }
  const dados = await leArquivo()
  return dados ? Number(dados.ultimoBloco) || null : null
}

export async function gravaBloco(n) {
  if (usandoKv) {
    await kv(`set/${CHAVE}/${n}`)
    return
  }
  /*
   * READ-MODIFY-WRITE, e não `writeFile` do ponteiro sozinho.
   *
   * A versão anterior escrevia `{ ultimoBloco: n }` inteiro, o que APAGAVA a
   * lista de vistos gravada durante o laço de anúncio — no mesmo ciclo, na última
   * linha dele. A dedup existia e era destruída antes de servir pra alguma coisa.
   */
  const dados = (await leArquivo()) || {}
  dados.ultimoBloco = n
  await gravaArquivo(dados)
}

const chaveDoItem = (tx, id) => `${tx}|${id}`

/**
 * Este (tx, tokenId) já foi anunciado?
 *
 * FALHA ABERTO: qualquer erro devolve `false` e o anúncio sai. Dedup é higiene e
 * não pode ter poder de derrubar o ciclo — um 429 do Upstash no meio de um lote
 * de 10 mataria o processo e, no `rodar.js`, os ~48 minutos restantes daquele run
 * junto. No pior caso desta escolha o canal repete um anúncio; no pior caso da
 * outra, ele fica meia hora fora do ar.
 */
export async function jaAnunciado(tx, id) {
  try {
    const k = chaveDoItem(tx, id)
    if (usandoKv) return (await kv(`get/${encodeURIComponent(PREFIXO_VISTO + k)}`)) != null
    const dados = await leArquivo()
    return Boolean(dados?.vistos?.includes(k))
  } catch (e) {
    console.warn('[estado] dedup indisponivel na leitura:', e.message)
    return false
  }
}

/**
 * Marca (tx, tokenId) como anunciado.
 *
 * SÓ DEPOIS DE UM POST ACEITO, nunca antes. Se a chave fosse reivindicada antes e
 * o processo morresse entre reivindicar e postar, a venda sumiria pra sempre — o
 * inverso exato do princípio escrito no `ciclo.js`: repetição alguém percebe e
 * reclama, venda perdida ninguém vê.
 */
export async function marcaAnunciado(tx, id) {
  try {
    const k = chaveDoItem(tx, id)
    if (usandoKv) {
      /* OPÇÕES COMO SEGMENTO DE CAMINHO, NÃO COMO QUERY STRING.
         ═══════════════════════════════════════════════════════════════════
         Isto era `?NX=true&EX=${VALIDADE_S}` e o Upstash respondia
         HTTP 400 {"error":"ERR syntax error"} -- sempre, desde o primeiro dia.
         O `catch` logo abaixo engolia, porque o dedup falha aberto de
         propósito. Resultado: `marcaAnunciado` nunca gravou nada,
         `jaAnunciado` nunca achou nada, e a camada de dedup deste bot NUNCA
         EXISTIU em produção.

         O sintoma que isso libera é preciso: o ponteiro de bloco só é gravado
         no FIM do ciclo, então uma execução que POSTA e morre antes do
         `gravaBloco` faz a seguinte varrer a mesma faixa e repetir tudo. O
         dedup era o cinto contra esse caso -- e estava desafivelado.

         Medido na REST real, com a mesma credencial de produção:
           set/k/1/nx/ex/600    -> 1a {"result":"OK"}  2a {"result":null}  ok
           set/k/1?NX=true&EX=  -> {"error":"ERR syntax error"}            nao

         Achado por acidente: o `vigia.js` copiou esta linha, e só apareceu
         porque fui conferir se a marca DELE estava mesmo sendo gravada. */
      await kv(`set/${encodeURIComponent(PREFIXO_VISTO + k)}/1/nx/ex/${VALIDADE_S}`)
      return
    }
    const dados = (await leArquivo()) || {}
    const vistos = Array.isArray(dados.vistos) ? dados.vistos : []
    if (!vistos.includes(k)) vistos.push(k)
    dados.vistos = vistos.slice(-LEMBRA_NO_ARQUIVO)
    await gravaArquivo(dados)
  } catch (e) {
    console.warn('[estado] dedup indisponivel na escrita:', e.message)
  }
}

/*
 * O QUE ESTA DEDUP É, E O QUE ELA NÃO É.
 *
 * Ela cobre os DOIS furos confirmados de republicação: o processo morrer entre
 * postar e gravar o ponteiro, e o cron da Vercel rodar junto com o GitHub Actions
 * lendo a mesma chave. Ela NÃO é dedup permanente — a janela é de 24h e no modo
 * arquivo dentro do Actions ela não existe de verdade.
 *
 * Isso importa mais depois do conserto de preço do que antes: o replay antigo
 * produzia duplicatas obviamente erradas (6.391 três vezes) que alguém denunciava.
 * Agora produziria duplicatas com preço certo e linha Batch, indistinguíveis de
 * venda real — profundidade de mercado fantasma, que é exatamente a métrica que
 * este bot existe pra proteger.
 */

/**
 * ============================================================================
 * TRAVA — uma execução por vez
 * ============================================================================
 *
 * POR QUE ISTO PASSA A EXISTIR AGORA
 *
 * Hoje a serialização é acidental: o `concurrency: vendas-do-ronkeverse` do
 * GitHub Actions garante um run por vez, e dentro do `rodar.js` o laço é
 * sequencial. Nada disso é do bot — é do agendador.
 *
 * Quando o gatilho virar WEBHOOK (o indexador empurra, a função nasce), essa
 * proteção some. E o que ela estava segurando é real: o par
 * `jaAnunciado -> post -> marcaAnunciado` é read-then-write NÃO atômico. Duas
 * invocações que se sobreponham leem o MESMO ponteiro, varrem a MESMA faixa, e
 * postam em dobro tudo o que a primeira ainda não terminou de anunciar.
 *
 * Um NFT vendido uma vez aparecendo duas no canal é exatamente a "profundidade
 * de mercado fantasma" que o comentário logo acima diz que este bot existe pra
 * proteger.
 *
 * FALHA ABERTO, pelo mesmo princípio do resto do arquivo: se o Redis não
 * responder, o ciclo roda SEM trava em vez de não rodar. Repetição alguém
 * percebe e reclama; venda perdida ninguém vê.
 *
 * TTL DE 5 MINUTOS. Ciclo ocioso medido: ~1s. Mesmo a varrida de 9h de atraso
 * (11.529 blocos) coube com folga. O TTL existe pro caso de o processo morrer
 * segurando a trava — sem ele, um crash calaria o bot pra sempre.
 *
 * O `soltaTrava` confere o dono antes de apagar, pra não derrubar a trava de
 * OUTRA execução caso a nossa tenha expirado no meio. Get-then-del não é
 * atômico, e assumo isso: a janela é de milissegundos e o pior caso é duas
 * execuções concorrentes — o mesmo que teríamos sem trava nenhuma.
 */
const CHAVE_TRAVA = 'ronkeverse:trava'
/* 120, e o 600 de ontem era uma COLISAO EXATA com o teto de retry da Alchemy.
   ═════════════════════════════════════════════════════════════════════════
   Ontem subi de 300 pra 600 pra ficar acima do teto de duracao da funcao na
   Vercel. Raciocinio correto, numero fatal: o retry da Alchemy no plano free
   desiste depois de 10 MINUTOS -- exatamente 600 segundos. Os dois numeros
   ficaram iguais, e o efeito e o pior possivel:

     processo morre segurando a trava
       -> toda invocacao seguinte devolve 503 (`pulado`)
       -> a Alchemy reenvia, reenvia, reenvia... por 10 min
       -> aos 600s ela DESISTE e descarta o evento PARA SEMPRE
       -> aos 600s a trava expira, um segundo tarde demais

   Ou seja: a trava consumia a janela inteira de reentrega e o evento morria
   sem deixar rastro. E a Alchemy nao tem API de auditoria de entrega nem
   reenvio manual -- entao esse evento nao volta de jeito nenhum.
   E a hipotese mais provavel pra venda #4365 (429,68 RON) ter ficado 58 min
   sem anuncio em 01/09: silencio longo, sem incidente publico, sem erro de
   filtro, sem estouro de cota. Nao deu pra provar (o log da Vercel dura ~1h e
   ja tinha expirado), mas e a unica explicacao que fecha.

   COM 120: uma trava orfa libera com ~8 minutos de janela de retry sobrando, e
   a tentativa seguinte da Alchemy entra.

   O QUE ISSO CUSTA, dito na cara: um ciclo que passe de 120s perde a trava no
   meio, e uma execucao concorrente pode postar em dobro o que ele ainda nao
   marcou. Aceito por tres razoes: o ciclo ocioso medido leva ~1s; o dedup
   (consertado em 27/08, ver `marcaAnunciado`) cobre tudo o que JA saiu, entao
   a exposicao real e a janela estreita entre postar e marcar; e este projeto ja
   escolheu esse lado em toda decisao parecida -- repeticao alguem percebe e
   reclama, venda perdida ninguem ve.

   O conserto mais correto seria renovar a trava por heartbeat durante o ciclo,
   e ai o TTL curto nunca expiraria debaixo de um ciclo vivo. Fica anotado como
   o proximo passo; nao entrou agora pra nao mexer na garantia anti-duplicata
   as vesperas de uma viagem. */
const TRAVA_S = 120

export async function pegaTrava(dono) {
  /* modo arquivo = processo único na sua máquina; não há o que serializar */
  if (!usandoKv) return true
  try {
    const r = await kv(`set/${encodeURIComponent(CHAVE_TRAVA)}/${encodeURIComponent(dono)}/nx/ex/${TRAVA_S}`)
    return r === 'OK'
  } catch (e) {
    console.warn('[trava] indisponivel, seguindo sem ela:', e.message)
    return true
  }
}

export async function soltaTrava(dono) {
  if (!usandoKv) return
  try {
    if ((await kv(`get/${encodeURIComponent(CHAVE_TRAVA)}`)) === dono) {
      await kv(`del/${encodeURIComponent(CHAVE_TRAVA)}`)
    }
  } catch (e) {
    /* não solta = a trava expira sozinha em TRAVA_S. Não vale derrubar o ciclo
       por causa disso, e o ciclo já terminou de qualquer jeito. */
    console.warn('[trava] nao consegui soltar:', e.message)
  }
}

/**
 * ============================================================================
 * A VENDA QUE NÃO CONSEGUIU SER POSTADA
 * ============================================================================
 *
 * O `ciclo.js` avança o ponteiro TODA volta (`gravaBloco(agora)`), mesmo quando
 * nenhum anúncio saiu. Isso é decisão antiga e certa -- segurar o ponteiro num
 * item que o Discord recusa em definitivo (embed inválido, webhook revogado)
 * congelaria o bot pra sempre, a faixa de varredura cresceria ~43.000 blocos por
 * dia, e passadas 24h o dedup expira e ele passaria a REPUBLICAR o dia inteiro,
 * uma vez por dia. O remédio seria pior.
 *
 * Mas o preço disso é que a venda recusada NÃO VOLTA. E até aqui ela sumia sem
 * deixar rastro: o aviso no ciclo era `if (r.ok < r.total)`, que com nenhum
 * destino configurado vira `0 < 0` -- falso. Canal mudo, log limpo, ponteiro
 * colado na cabeça, e o vigia imprimindo "em dia".
 *
 * Esta chave é a única memória de que a venda existiu. Ela não conserta nada --
 * conserta quem lê. O vigia passa a olhar pra cá e gritar.
 *
 * TTL de 24h porque é aviso, não contabilidade: se ninguém olhou em um dia, o
 * problema já é outro.
 */
const CHAVE_FALHA = 'ronkeverse:falha-post'

export async function marcaFalhaDePost() {
  if (!usandoKv) return
  try {
    await kv(`set/${encodeURIComponent(CHAVE_FALHA)}/${Date.now()}/ex/86400`)
  } catch (e) {
    console.warn('[estado] nao consegui marcar a falha de post:', e.message)
  }
}

export async function falhaDePostRecente() {
  if (!usandoKv) return null
  try {
    return await kv(`get/${encodeURIComponent(CHAVE_FALHA)}`)
  } catch {
    return null
  }
}

/**
 * ============================================================================
 * LIVRO-CAIXA DE ENTREGAS — porque a Alchemy não tem um
 * ============================================================================
 *
 * Em 01/09 a venda #4365 ficou 58 minutos sem anúncio e não deu pra saber por
 * quê. O log da Vercel dura ~1h e já tinha expirado; a Alchemy NÃO tem endpoint
 * de histórico de entrega, e o reenvio manual está como "Coming Soon" na doc
 * deles. Ou seja: a frase "não há POST no log" não distinguia três mundos bem
 * diferentes --
 *
 *   1. a Alchemy nunca disparou
 *   2. disparou e a entrega não chegou
 *   3. chegou, e o ciclo não fez nada
 *
 * -- e sem essa distinção toda investigação futura bate na mesma parede.
 *
 * Então o bot passa a guardar o próprio registro. Lista circular de 500
 * entradas: quem chamou, por qual porta entrou, e o que foi devolvido.
 *
 * CUSTO: 2 comandos por evento. A ~20 eventos/dia dá ~1.200/mês contra os 500
 * mil do plano free do Upstash -- 0,24%. Barato demais pra não ter.
 *
 * FALHA ABERTO, como o resto do arquivo: registrar é higiene e não pode ter
 * poder de derrubar um ciclo.
 */
const CHAVE_LIVRO = 'ronkeverse:entregas'
const LEMBRA_ENTREGAS = 500

export async function anotaEntrega(dados) {
  if (!usandoKv) return
  try {
    const linha = JSON.stringify({ q: new Date().toISOString(), ...dados })
    await kv(`lpush/${encodeURIComponent(CHAVE_LIVRO)}/${encodeURIComponent(linha)}`)
    await kv(`ltrim/${encodeURIComponent(CHAVE_LIVRO)}/0/${LEMBRA_ENTREGAS - 1}`)
  } catch (e) {
    console.warn('[estado] nao anotei a entrega:', e.message)
  }
}

export async function ultimasEntregas(quantas = 20) {
  if (!usandoKv) return []
  try {
    const r = await kv(`lrange/${encodeURIComponent(CHAVE_LIVRO)}/0/${quantas - 1}`)
    return (r || []).map((x) => { try { return JSON.parse(x) } catch { return { cru: x } } })
  } catch { return [] }
}
