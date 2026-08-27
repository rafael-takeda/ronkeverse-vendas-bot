/**
 * ============================================================================
 * O CICLO — uma passada do bot
 * ============================================================================
 *
 * Fica separado do gatilho de propósito. Quem chama isto pode ser o cron da
 * Vercel, o GitHub Actions ou você no terminal; a lógica não muda e nenhuma das
 * três precisa saber das outras.
 *
 * ---------------------------------------------------------------------------
 * A ORDEM IMPORTA: anuncia, DEPOIS avança o ponteiro
 * ---------------------------------------------------------------------------
 * Se o ponteiro subisse antes, uma falha no meio do caminho perderia vendas pra
 * sempre — e venda perdida é invisível, ninguém reclama do que não viu. Do jeito
 * que está, uma falha faz a próxima execução tentar de novo. O preço é o risco
 * oposto (anunciar duas vezes se o processo morrer entre postar e gravar), e
 * esse é o lado certo pra errar: repetição alguém percebe e reclama.
 *
 * A dedup por (tx, tokenId) do `estado.js` estreita esse risco sem inverter a
 * escolha: ela é consultada antes do post e reivindicada DEPOIS dele, e falha
 * aberto. Ela nunca some com uma venda; no máximo deixa passar uma repetição.
 */
import { blocoAtual, metadados, nomeDaColecao, transferencias, vendasDoGrupo } from './ronin.js'
import { anunciaEmTodos, listaDeWebhooks, weiExato } from './discord.js'
import { gravaBloco, jaAnunciado, marcaAnunciado, pegaTrava, soltaTrava, ultimoBloco, usandoKv } from './estado.js'

/**
 * DE QUANTO ATRÁS COMEÇAR quando não há estado nenhum.
 *
 * 200 blocos são ~10 minutos. Pequeno de propósito: na primeira execução o bot
 * não pode despejar no canal as vendas da semana passada como se fossem de
 * agora. Quem quiser preencher histórico faz isso à mão, uma vez.
 */
const INICIO_SEM_ESTADO = 200

/**
 * Respiro entre dois posts do MESMO lote.
 *
 * A varrida de 40 NFTs numa transação (0xc568b5ba) existe e é real. Espaçar é o
 * que evita provocar o 429 em vez de só reagir a ele.
 */
const RESPIRO_MS = 400

const espera = (ms) => new Promise((f) => setTimeout(f, ms))

/**
 * Junta as transferências em grupos de (transação, comprador).
 *
 * Exportado pra ficar sob teste: é uma linha de agrupamento que decide se o
 * anúncio diz a verdade sobre o contexto. Ver o comentário em `umCiclo`.
 */
export function agrupa(movimentos) {
  const grupos = new Map()
  for (const t of movimentos) {
    const chave = `${t.tx}|${t.para}`
    if (!grupos.has(chave)) grupos.set(chave, { tx: t.tx, comprador: t.para, itens: [] })
    grupos.get(chave).itens.push(t)
  }
  return grupos
}

/**
 * UMA EXECUÇÃO POR VEZ — o embrulho que segura a trava.
 * ============================================================================
 * A função de verdade é a `cicloInterno`, logo abaixo. Este embrulho existe
 * porque ela tem vários pontos de saída (aborta sem estado, `de > agora`, fim
 * normal), e trava que só é solta em UM deles é trava esquecida — o bot ficaria
 * mudo até o TTL expirar. Com `try/finally` a devolução é única, aconteça o que
 * acontecer, inclusive exceção.
 *
 * QUEM É PULADO NÃO É ERRO. Devolve `pulado: true` e números zerados: outra
 * execução está processando a mesma faixa neste instante, e insistir só
 * produziria anúncio em dobro. O `rodar.js` e o `api/vendas.js` já tratam o
 * retorno como dado, não como falha.
 *
 * O modo seco também pega trava, de propósito: se ele não pegasse, um `--seco`
 * rodando na sua máquina durante um ciclo real leria o mesmo ponteiro e mostraria
 * na tela vendas que o outro está anunciando naquele segundo — leitura confusa
 * justamente na hora em que você está investigando alguma coisa.
 */
export async function umCiclo({ webhook, seco = false } = {}) {
  const dono = crypto.randomUUID()
  if (!(await pegaTrava(dono))) {
    console.log('  [trava] outra execucao esta no ar -- pulei esta volta')
    return { blocos: 0, transferencias: 0, vendas: 0, anunciadas: 0, pulado: true, estado: usandoKv ? 'kv' : 'arquivo' }
  }
  try {
    return await cicloInterno({ webhook, seco })
  } finally {
    await soltaTrava(dono)
  }
}

async function cicloInterno({ webhook, seco = false } = {}) {
  const agora = await blocoAtual()

  let salvo
  try {
    salvo = await ultimoBloco()
  } catch (e) {
    /*
     * LEITURA DE ESTADO QUEBRADA NÃO PODE VIRAR VARREDURA ÀS CEGAS.
     *
     * Com o `null` antigo, o ciclo começaria 200 blocos atrás e reanunciaria ~10
     * minutos de cadeia — a cada volta, enquanto o KV estivesse fora. Abortar
     * deixa o ponteiro onde está: a próxima volta que conseguir ler pega tudo o
     * que passou. Atraso é recuperável, republicação não.
     */
    console.warn('[estado] leitura falhou, ciclo abortado:', e.message)
    return { blocos: 0, transferencias: 0, vendas: 0, anunciadas: 0, abortado: true, estado: usandoKv ? 'kv' : 'arquivo' }
  }

  const de = salvo ? salvo + 1 : agora - INICIO_SEM_ESTADO

  /* `estado` TAMBEM NO CAMINHO OCIOSO. Sem ele o log da volta sem novidade
     saia '[undefined]' -- e esse campo e o unico sinal de que o bot esta em modo
     arquivo (que faz ele repetir anuncio). O caminho mais comum era justamente
     o que apagava o aviso. */
  if (de > agora) return { blocos: 0, transferencias: 0, vendas: 0, anunciadas: 0, estado: usandoKv ? 'kv' : 'arquivo' }

  const movimentos = await transferencias(de, agora)

  /*
   * AGRUPAR POR (TRANSAÇÃO, COMPRADOR) — a chave é composta, e a segunda metade
   * dela não é detalhe.
   *
   * Por transação, a economia de RPC sairia igual (2 chamadas em vez de 2 por
   * NFT), mas a linha "Batch" do anúncio passaria a afirmar que compradores sem
   * relação nenhuma participaram da mesma varrida. Medido na tx 0x0906c539: um
   * vendedor aceita três ofertas de uma vez, três compradores distintos, e o
   * agrupamento por transação imprimiria "930,05 RON total" — número que nenhuma
   * carteira gastou. Por (tx, comprador), cada um desses grupos tem 1 item e a
   * linha Batch nem aparece.
   */
  const grupos = agrupa(movimentos)

  const vendas = []
  for (const g of grupos.values()) vendas.push(...(await vendasDoGrupo(g)))

  const colecao = vendas.length ? await nomeDaColecao() : null

  let anunciadas = 0
  let primeira = true
  for (const v of vendas) {
    if (seco) {
      const preco = v.precoWei === null ? 'sem preco' : `${weiExato(v.precoWei)} RON`
      const contexto = v.itensDoComprador > 1 ? ` — ${v.posicao} de ${v.itensDoComprador} nesta tx` : ''
      console.log(`  [seco] #${v.id} por ${preco} (${v.marketplace ?? 'desconhecida'})${contexto}`)
      anunciadas++
      continue
    }
    // A dedup vem ANTES dos metadados: item repetido não precisa custar uma
    // chamada de `tokenURI` mais um GET no S3.
    if (await jaAnunciado(v.tx, v.id)) {
      console.log(`  [dedup] #${v.id} ja anunciado nesta tx`)
      continue
    }
    const meta = await metadados(v.id)
    if (!primeira) await espera(RESPIRO_MS)
    primeira = false
    const r = await anunciaEmTodos(webhook, v, meta, colecao)
    if (r.ok > 0) {
      anunciadas++
      await marcaAnunciado(v.tx, v.id)
    }
    if (r.ok < r.total) console.warn(`[ciclo] #${v.id}: ${r.ok}/${r.total} destinos aceitaram`)
  }

  if (!seco) await gravaBloco(agora)

  return {
    de,
    ate: agora,
    blocos: agora - de + 1,
    transferencias: movimentos.length,
    grupos: grupos.size,
    vendas: vendas.length,
    anunciadas,
    destinos: listaDeWebhooks(webhook).length,
    estado: usandoKv ? 'kv' : 'arquivo',
  }
}
