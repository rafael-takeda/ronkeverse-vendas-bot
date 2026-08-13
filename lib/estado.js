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
      await kv(`set/${encodeURIComponent(PREFIXO_VISTO + k)}/1?NX=true&EX=${VALIDADE_S}`)
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
