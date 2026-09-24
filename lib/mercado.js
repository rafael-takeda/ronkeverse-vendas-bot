/**
 * ============================================================================
 * MERCADO — o contexto que a cadeia não dá
 * ============================================================================
 *
 * Floor, cotação do RON, quanto o vendedor pagou, nome de perfil, raridade e
 * Ronke Score de quem compra e de quem vende. A cadeia diz QUE houve venda e
 * por quanto; o resto desta lista mora em duas fontes de fora.
 *
 * ---------------------------------------------------------------------------
 * TUDO AQUI É ENFEITE, e é isso que define o desenho
 * ---------------------------------------------------------------------------
 * Nenhuma função exportada daqui LANÇA pra quem monta o anúncio. Fonte fora do
 * ar, formato mudado, chave nova exigida: o campo simplesmente não aparece e a
 * venda sai como saía antes. Anúncio de venda atrasado ou perdido por causa de
 * um floor seria trocar o produto pelo enfeite.
 *
 * Por isso cada fonte tem DISJUNTOR: a primeira falha põe a fonte em pausa por
 * 2 minutos, e nesse tempo toda consulta a ela desiste na hora em vez de
 * esperar o tempo máximo. Sem isso, uma varrida de 40 NFTs com a fonte
 * pendurada custaria 40 × 4 s dentro do mesmo ciclo — e na Vercel a função
 * morre em 60 s.
 *
 * ---------------------------------------------------------------------------
 * AS TRÊS FONTES, e o que cada uma garante
 * ---------------------------------------------------------------------------
 * 1. GraphQL da Ronin Market (a mesma de `listings.js`): floor, histórico de
 *    venda do token e nome de perfil. NÃO É API DOCUMENTADA — ver o cabeçalho
 *    de `listings.js`. Responde sem chave. A cotação que ela TAMBÉM tem está
 *    parada e errada — ver `cotacaoRon`, mais abaixo.
 *
 * 2. Ronke Score API (ronke-analytics.vercel.app/api/v1): raridade oficial da
 *    coleção, Ronke Score de carteira, nome `.ron` e números da coleção.
 *    DOCUMENTADA, pública, sem chave, com versão no caminho (v1 dura 90 dias
 *    depois de anunciada a v2). Mas é uma FOTO DIÁRIA, refeita às 07:00 UTC:
 *    o score de quem comprou agora só muda amanhã, e o `owner` que ela devolve
 *    pode estar um dia velho. Por isso comprador e vendedor vêm SEMPRE da
 *    cadeia; daqui só sai o que é estável num dia.
 *
 * 3. CoinGecko: só a cotação do RON em dólar, e só se atualizada há menos de
 *    1 h. Ver `cotacaoRon`.
 */
import { COLECAO } from './ronin.js'

const GRAPHQL = 'https://marketplace-graphql.skymavis.com/graphql'
const RONKE_API = 'https://ronke-analytics.vercel.app/api/v1'
const WRON = '0xe514d9deb7966c8be0ca922de8a064264ea6bcd4'

/** Teto por consulta. O anúncio espera por isto; mais que isso vira atraso visível. */
const TEMPO_MAXIMO_MS = 4000

/** Quanto tempo uma fonte fica em pausa depois de falhar. Ver o cabeçalho. */
const PAUSA_APOS_FALHA_MS = 2 * 60_000

/**
 * CARTEIRAS QUE TÊM NOME DE VERDADE, mesmo sem perfil.
 *
 * `0x16bb75…` é a carteira do RonkeStrategy — o protocolo que compra Ronkeverse
 * no floor e revende do próprio estoque. Quem diz é a Ronke Score API, que a
 * devolve como "RonkeStrategy wallet" no `owner` dos NFTs que ela segura
 * (medido em 24/09/2026 no #4345). Sem perfil na Ronin Market, ela sairia no
 * canal como um endereço qualquer — e "o protocolo comprou" é justamente uma
 * das informações mais interessantes que o canal pode dar.
 */
export const RONKESTRATEGY = '0x16bb753b48fbeac599a1a7a291b3f87aa3dbdf19'
export const ROTULOS = { [RONKESTRATEGY]: 'RonkeStrategy' }

/* ============================================================================
   PEÇAS PURAS — decidem o que aparece. Testadas sem rede em teste_mercado.js.
   ============================================================================ */

/**
 * O floor SEM os tokens dados: o listing mais barato, em RON, que não é
 * nenhum deles.
 *
 * Por que excluir: no listing, o próprio item costuma ser o mais barato — e
 * comparar com ele mesmo daria "+0%" justamente no caso que o canal existe pra
 * destacar. Na venda, o item vendido pode continuar listado na GraphQL por
 * alguns segundos, e aí ele seria o floor contra o qual a própria venda se
 * compara.
 *
 * Ordem em outra moeda é pulada: ordenar preço de moedas diferentes não diz
 * nada. As 100 ordens medidas em 22/09 eram todas em WRON.
 */
export function escolheFloor(resultados, excluir = []) {
  const fora = new Set(excluir.map(String))
  for (const t of resultados || []) {
    const o = t && t.order
    if (!o || fora.has(String(t.tokenId))) continue
    if (String(o.paymentToken).toLowerCase() !== WRON) continue
    return { id: String(t.tokenId), precoWei: BigInt(o.currentPrice) }
  }
  return null
}

/**
 * Quanto o VENDEDOR pagou — ou null. A regra é estreita de propósito.
 *
 * O histórico da Ronin Market só registra venda feita NELA: compra no OpenSea,
 * compra do estoque do RonkeStrategy e transferência entre carteiras não
 * aparecem. Medido em 24/09 no #4345: a entrada mais recente era alguém
 * vendendo pro RonkeStrategy por 429 RON, e o dono atual (que comprou do
 * protocolo depois) não está em linha nenhuma. Pegar "a última venda" teria
 * publicado o preço de OUTRA pessoa como se fosse dele.
 *
 * Então: a entrada mais recente tem que ser uma compra FEITA PELO VENDEDOR, em
 * RON, com preço. Qualquer outra coisa é "não sei", e "não sei" não vira campo.
 *
 * `ignoraTx` é a própria venda sendo anunciada: se a GraphQL já a indexou, ela
 * é a entrada mais recente e tem que ser pulada — a compra que interessa é a
 * de antes dela.
 */
export function compraDoVendedor(historico, vendedor, ignoraTx = null) {
  if (!vendedor) return null
  const quem = String(vendedor).toLowerCase()
  const pula = ignoraTx ? String(ignoraTx).toLowerCase() : null
  const h = (historico || []).find((x) => x && (!pula || String(x.txHash).toLowerCase() !== pula))
  if (!h || String(h.to).toLowerCase() !== quem) return null
  if (h.paymentToken && String(h.paymentToken).toLowerCase() !== WRON) return null
  const preco = BigInt(h.withPrice || '0')
  if (preco <= 0n) return null
  return { precoWei: preco, quando: Number(h.timestamp) > 0 ? Number(h.timestamp) : null }
}

/** O nome que a Ronin Market dá a quem nunca escolheu um. */
const NOME_PADRAO = /^Lunacian #\d+$/i

/**
 * NOME DE PERFIL É TEXTO DE QUALQUER UM, publicado com a cara do nosso bot.
 *
 * Qualquer pessoa escolhe o próprio nome na Ronin Market. Sem filtro, bastaria
 * se chamar "[resgate seu airdrop](https://golpe…)" e comprar um NFT pra o
 * canal oficial publicar um link de golpe clicável. Por isso: nome com cara de
 * link ou de convite é descartado inteiro (o endereço continua lá). O ESCAPE da
 * marcação (um link mascarado precisa de [ ] ( ), e escapado ele vira texto)
 * acontece no `discord.js`, na hora de montar a mensagem — um lugar só, que
 * vale pro nome e pro traço.
 */
const PARECE_LINK =
  /(https?:|www\.|discord\.(gg|com)|t\.me\/|\.(com|net|org|io|xyz|gg|app|me|co|link|site|online|club|top|info|pro|vip|live|fun|shop|store|ru|cn)\b)/i
const MENCAO = /@(everyone|here)|<[@#:]/i
const TAMANHO_MAXIMO = 32

export function nomeApresentavel(bruto) {
  if (typeof bruto !== 'string') return null
  // NFKC desfaz letra "estilizada" (𝓓𝓮𝓶𝓮𝓽𝓮𝓻 -> Demeter); \p{C} tira controle e
  // os caracteres invisíveis que invertem a direção do texto.
  let n = bruto.normalize('NFKC').replace(/\p{C}/gu, '').replace(/\s+/g, ' ').trim()
  if (!n || NOME_PADRAO.test(n) || PARECE_LINK.test(n) || MENCAO.test(n)) return null
  const letras = [...n]
  if (letras.length > TAMANHO_MAXIMO) n = letras.slice(0, TAMANHO_MAXIMO - 1).join('') + '…'
  return n
}

/**
 * O nome a mostrar pra um endereço, nesta ordem: rótulo conhecido, nome
 * escolhido na Ronin Market, nome `.ron`. O `.ron` vem por último porque o da
 * marketplace é o que a pessoa vê de si mesma quando negocia — e passa pelo
 * mesmo filtro, porque também é texto que qualquer um registra.
 */
export function nomeDoEndereco(endereco, perfil, ron = null) {
  if (!endereco) return null
  return ROTULOS[String(endereco).toLowerCase()] || nomeApresentavel(perfil) || nomeApresentavel(ron)
}

/**
 * Raridade oficial resumida: o rank (ou o tier, pra 1/1) e o traço mais raro.
 *
 * 1/1 vem com `rarity_rank` null DE PROPÓSITO — a doc da API diz que eles
 * ficam fora da escada 1..N, não no topo dela. Então 1/1 mostra o tier, nunca
 * um rank inventado.
 */
export function resumoDeRaridade(nft) {
  if (!nft) return null
  const tier = String(nft.tier || 'standard')
  const rank = Number.isInteger(nft.rarity_rank) && nft.rarity_rank > 0 ? nft.rarity_rank : null
  if (rank === null && !/1of1/.test(tier)) return null
  const traco = [...(nft.traits || [])]
    .filter((t) => t && Number(t.probability) > 0)
    .sort((a, b) => Number(a.probability) - Number(b.probability))[0]
  return {
    rank,
    tier,
    traco: traco ? { tipo: String(traco.trait_type), valor: String(traco.value), prob: Number(traco.probability) } : null,
  }
}

/** Ronke Score resumido. `found:false` é "sem pontuação ainda", não erro — vira null. */
export function resumoDeScore(s) {
  if (!s || !s.found || !Number.isInteger(s.rank)) return null
  return { rank: s.rank, pontos: Number(s.score) }
}

/* ============================================================================
   A REDE — com disjuntor e memória curta.
   ============================================================================ */

function criaFonte(nome) {
  let pausaAte = 0
  return async function pede(fn) {
    if (Date.now() < pausaAte) throw new Error(`${nome} em pausa`)
    try {
      return await fn()
    } catch (e) {
      // Só avisa ao ENTRAR em pausa: dentro dela o log fica quieto, senão uma
      // fonte fora por uma hora encheria o journal do VPS com a mesma linha.
      pausaAte = Date.now() + PAUSA_APOS_FALHA_MS
      console.warn(`[mercado] ${nome} falhou, pausada por 2 min: ${e.message}`)
      throw e
    }
  }
}

const roninMarket = criaFonte('Ronin Market')
const ronkeScore = criaFonte('Ronke Score')

/**
 * Memória de processo com validade. No VPS o processo vive 24 h; na Vercel,
 * uma invocação. Guarda `null` também ("perguntei, não tem") — por isso `tem`
 * e `le` são separados. As DUAS respeitam a validade: um `le` que devolvesse o
 * valor vencido faria o dólar sair com a cotação de horas atrás.
 */
function memoria(validadeMs, teto = 2000) {
  const m = new Map()
  const vivo = (k) => {
    const x = m.get(k)
    if (!x) return null
    if (Date.now() > x.ate) {
      m.delete(k)
      return null
    }
    return x
  }
  return {
    tem: (k) => vivo(k) !== null,
    le: (k) => vivo(k)?.v,
    grava: (k, v) => {
      m.set(k, { v, ate: Date.now() + validadeMs })
      if (m.size > teto) m.delete(m.keys().next().value)
    },
  }
}

// Raridade não muda (a API guarda 24 h na borda); score, nome e números da
// coleção mudam no máximo uma vez por dia. A cotação é a que envelhece rápido.
const memNft = memoria(6 * 60 * 60_000)
const memScore = memoria(60 * 60_000)
const memNome = memoria(60 * 60_000)
const memRon = memoria(60 * 60_000)
const memColecao = memoria(60 * 60_000, 1)
const memCotacao = memoria(5 * 60_000, 1)

async function graphql(query, variables) {
  const r = await fetch(GRAPHQL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(TEMPO_MAXIMO_MS),
  })
  if (!r.ok) throw new Error(`HTTP ${r.status}`)
  const j = await r.json()
  // Erro PARCIAL não derruba: carteira sem perfil volta null no campo dela. Só
  // a resposta sem `data` nenhum (consulta recusada inteira) é falha.
  if (!j.data) throw new Error((j.errors && j.errors[0] && j.errors[0].message) || 'resposta sem data')
  return j.data
}

async function ronke(caminho) {
  const r = await fetch(RONKE_API + caminho, { signal: AbortSignal.timeout(TEMPO_MAXIMO_MS) })
  if (!r.ok) throw new Error(`HTTP ${r.status} em ${caminho.split('?')[0]}`)
  const j = await r.json()
  if (!j.data) throw new Error((j.error && j.error.message) || 'resposta sem data')
  return j.data
}

/** O floor sem os tokens dados. LANÇA. */
async function floorSem(excluir) {
  const quantos = Math.min(excluir.length + 1, 50)
  const d = await roninMarket(() =>
    graphql(
      `query($a:String!,$n:Int!){floor:erc721Tokens(tokenAddress:$a,from:0,size:$n,auctionType:Sale,sort:PriceAsc){results{tokenId order{currentPrice paymentToken}}}}`,
      { a: COLECAO, n: quantos },
    ),
  )
  return escolheFloor(d.floor && d.floor.results, excluir)
}

/*
 * ============================================================================
 * A COTAÇÃO DO RON NÃO VEM DA RONIN MARKET — e o porquê custou caro
 * ============================================================================
 * A GraphQL da Ronin Market tem `exchangeRate { ron { usd } }`, e foi dela que
 * o dólar saiu no primeiro dia. Em 24/09/2026 ela devolvia US$ 0,91 com o RON
 * a US$ 0,058 no CoinGecko — 16× a mais, e parada (sem hora de atualização
 * pra denunciar). O canal publicou "≈ $427,451" num listing de ~US$ 27 mil, e
 * quem pegou foi o dono, de cabeça. Nenhuma faixa de "valor plausível" teria
 * pegado: US$ 0,91 é um preço de RON perfeitamente crível.
 *
 * O CoinGecko devolve `last_updated_at`, e é ISSO que a regra confere: cotação
 * sem hora, ou com mais de 1 h, é recusada — e sem cotação o dólar não sai. O
 * defeito que já aconteceu foi um número PARADO; a guarda é contra ele.
 */
const COINGECKO = 'https://api.coingecko.com/api/v3/simple/price?ids=ronin&vs_currencies=usd&include_last_updated_at=true'
const IDADE_MAXIMA_DA_COTACAO_S = 3600
const coingecko = criaFonte('CoinGecko')

/** A cotação que passa: positiva E atualizada há menos de 1 h. Senão, null. */
export function cotacaoValida(resposta, agoraSeg) {
  const r = resposta && resposta.ronin
  const usd = r ? Number(r.usd) : NaN
  const quando = r ? Number(r.last_updated_at) : NaN
  if (!(usd > 0) || !(quando > 0)) return null
  if (agoraSeg - quando > IDADE_MAXIMA_DA_COTACAO_S) return null
  return usd
}

/** RON em dólar, com memória de 5 min. LANÇA — quem chama usa `ouVazio`. */
async function cotacaoRon() {
  if (memCotacao.tem('ron')) return memCotacao.le('ron')
  const usd = await coingecko(async () => {
    const r = await fetch(COINGECKO, { signal: AbortSignal.timeout(TEMPO_MAXIMO_MS) })
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
    const v = cotacaoValida(await r.json(), Date.now() / 1000)
    // Dentro do disjuntor de propósito: cotação parada também pausa a fonte,
    // em vez de ser perguntada de novo a cada anúncio.
    if (v === null) throw new Error('cotação ausente ou parada há mais de 1 h')
    return v
  })
  memCotacao.grava('ron', usd)
  return usd
}

/**
 * Histórico dos tokens e nome dos perfis, numa consulta só (campos com apelido).
 * Nome já lembrado não é perguntado de novo. LANÇA.
 */
async function historicosENomes(ids, enderecos) {
  const novos = [...new Set(enderecos.map((e) => String(e).toLowerCase()))].filter((e) => !memNome.tem(e))
  const defs = ['$a:String!']
  const vars = { a: COLECAO }
  const partes = []
  ids.forEach((id, i) => {
    defs.push(`$i${i}:String!`)
    vars[`i${i}`] = String(id)
    partes.push(
      `h${i}:erc721Token(tokenAddress:$a,tokenId:$i${i}){transferHistory(from:0,size:3){results{timestamp withPrice paymentToken to txHash}}}`,
    )
  })
  novos.forEach((e, j) => {
    defs.push(`$e${j}:String!`)
    vars[`e${j}`] = e
    partes.push(`p${j}:publicProfileWithRoninAddress(roninAddress:$e${j}){name}`)
  })
  const historicos = new Map()
  if (partes.length) {
    const d = await roninMarket(() => graphql(`query(${defs.join(',')}){${partes.join(' ')}}`, vars))
    ids.forEach((id, i) => historicos.set(String(id), d[`h${i}`]?.transferHistory?.results || []))
    novos.forEach((e, j) => memNome.grava(e, d[`p${j}`]?.name ?? null))
  }
  const perfis = new Map(enderecos.map((e) => [String(e).toLowerCase(), memNome.le(String(e).toLowerCase()) ?? null]))
  return { historicos, perfis }
}

/** Raridade de cada token (uma chamada por token, com memória de 6 h). Não lança: token que falhar fica sem raridade. */
async function raridades(ids) {
  const r = new Map()
  const faltam = [...new Set(ids.map(String))].filter((id) => !memNft.tem(id))
  // Quatro por vez: uma varrida de 40 não vira uma rajada de 40 contra a API.
  for (let i = 0; i < faltam.length; i += 4) {
    await Promise.all(
      faltam.slice(i, i + 4).map(async (id) => {
        try {
          memNft.grava(id, resumoDeRaridade(await ronkeScore(() => ronke(`/nft/${id}`))))
        } catch {
          // Sem memorizar a falha: a próxima venda deste token tenta de novo.
        }
      }),
    )
  }
  for (const id of ids.map(String)) r.set(id, memNft.le(id) ?? null)
  return r
}

/** Ronke Score das carteiras (lote de até 50 numa chamada, memória de 1 h). LANÇA. */
async function scores(enderecos) {
  const todos = [...new Set(enderecos.map((e) => String(e).toLowerCase()))]
  const faltam = todos.filter((e) => !memScore.tem(e)).sort() // ordenado: a doc pede, pro cache da borda
  if (faltam.length) {
    const d = await ronkeScore(() => ronke(`/scores?addresses=${faltam.slice(0, 50).join(',')}`))
    for (const s of d.scores || []) memScore.grava(String(s.address).toLowerCase(), resumoDeScore(s))
  }
  return new Map(todos.map((e) => [e, memScore.le(e) ?? null]))
}

/**
 * Nome `.ron` de cada carteira — pelo `/wallet`, o ÚNICO endpoint que o traz.
 *
 * A doc sugere o `/score`, e ele tem o campo `name`. Medido em 24/09 nas 10
 * primeiras carteiras com nome do leaderboard: `/score/{endereço}` devolveu
 * `name: null` em 10 de 10, o lote `/scores` também, e o `/wallet` trouxe o
 * nome nas 10. (O `/score` só preenche quando a consulta é FEITA pelo nome.)
 * Não lança: carteira que falhar fica sem `.ron`.
 */
export async function nomesRon(enderecos) {
  const todos = [...new Set(enderecos.filter(Boolean).map((e) => String(e).toLowerCase()))]
  const faltam = todos.filter((e) => !memRon.tem(e))
  for (let i = 0; i < faltam.length; i += 4) {
    await Promise.all(
      faltam.slice(i, i + 4).map(async (e) => {
        try {
          const d = await ronkeScore(() => ronke(`/wallet/${e}`))
          memRon.grava(e, d && typeof d.name === 'string' && d.name ? d.name : null)
        } catch {
          // Sem memorizar a falha: o próximo anúncio desta carteira tenta de novo.
        }
      }),
    )
  }
  return new Map(todos.map((e) => [e, memRon.le(e) ?? null]))
}

/**
 * Holders e volume de 7 dias da coleção, pro rodapé. Foto diária da Ronke
 * Score API (1.850 holders e 20.565 RON em 24/09). Não lança.
 */
async function numerosDaColecao() {
  if (memColecao.tem('c')) return memColecao.le('c')
  try {
    const d = await ronkeScore(() => ronke('/stats'))
    const n = d && d.ronkeverse_nft
    const holders = n && Number.isInteger(n.holders) && n.holders > 0 ? n.holders : null
    const volume7d = n && Number(n.volume_7d_wron) > 0 ? Number(n.volume_7d_wron) : null
    const r = holders || volume7d ? { holders, volume7d } : null
    memColecao.grava('c', r)
    return r
  } catch {
    return null
  }
}

/** Espera a promessa e devolve o valor dela, ou `vazio` se ela falhar. Nunca lança. */
async function ouVazio(promessa, vazio) {
  try {
    return await promessa
  } catch {
    return vazio
  }
}

/* ============================================================================
   O QUE OS ANÚNCIOS PEDEM — nenhuma destas lança.
   ============================================================================ */

/**
 * O que vale pro CICLO INTEIRO de vendas: floor (sem nenhum dos itens vendidos
 * agora) e cotação. Uma consulta por ciclo, não uma por venda.
 */
export async function contextoDoCiclo(vendas) {
  const [floor, usd, colecao] = await Promise.all([
    ouVazio(floorSem(vendas.map((v) => String(v.id))), null),
    ouVazio(cotacaoRon(), null),
    numerosDaColecao(),
  ])
  return { floor, usd, colecao }
}

/**
 * Os extras de UMA venda. `doCiclo` vem de `contextoDoCiclo`.
 *
 * As três buscas saem juntas e cada uma cai sozinha: Ronin Market fora não
 * apaga a raridade, e Ronke Score fora não apaga o floor.
 */
export async function extrasDaVenda(v, doCiclo = null) {
  /* VENDA DO RONKESTRATEGY TEM VENDEDOR — o próprio protocolo.
     O NFT sai do contrato que emitiu a venda, e a guarda de custódia do
     `ronin.js` (feita pra Ronin Market, onde o dono real depositou blocos
     antes) deixa `vendedor` vazio. Aqui não há dono escondido: o estoque É do
     protocolo. Com o endereço dele, o "Seller paid" vira quanto o RonkeStrategy
     pagou no floor — a margem do protocolo, que é informação que o canal quer. */
  const vendedor = v.vendedor || (v.marketplace === ROTULOS[RONKESTRATEGY] ? RONKESTRATEGY : null)
  const enderecos = [v.comprador, vendedor].filter(Boolean)
  // O `.ron` sai junto, não depois do nome da marketplace: esperar um pra
  // decidir se precisa do outro somaria as duas latências no anúncio. Com
  // memória de 1 h, perguntar à toa pela mesma carteira custa uma vez.
  const [hn, rar, sc, ron] = await Promise.all([
    ouVazio(historicosENomes([v.id], enderecos), null),
    ouVazio(raridades([v.id]), null),
    ouVazio(scores(enderecos), null),
    nomesRon(enderecos),
  ])
  const baixo = (e) => (e ? String(e).toLowerCase() : null)
  // Carteira de protocolo tem Ronke Score (o RonkeStrategy era o #487 em
  // 24/09), mas "posição no ranking de holders" de um contrato só confunde.
  const scoreDe = (e) => (!e || !sc || ROTULOS[baixo(e)] ? null : sc.get(baixo(e)) ?? null)
  return {
    usd: doCiclo ? doCiclo.usd : null,
    floor: doCiclo ? doCiclo.floor : null,
    pagou: hn ? compraDoVendedor(hn.historicos.get(String(v.id)), vendedor, v.tx) : null,
    vendedorEfetivo: vendedor,
    nomeComprador: nomeDoEndereco(v.comprador, hn && hn.perfis.get(baixo(v.comprador)), ron.get(baixo(v.comprador))),
    nomeVendedor: vendedor ? nomeDoEndereco(vendedor, hn && hn.perfis.get(baixo(vendedor)), ron.get(baixo(vendedor))) : null,
    scoreComprador: scoreDe(v.comprador),
    scoreVendedor: scoreDe(vendedor),
    raridade: rar ? rar.get(String(v.id)) ?? null : null,
    colecao: doCiclo ? doCiclo.colecao ?? null : null,
  }
}

/**
 * Os extras de uma leva de LISTINGS, na mesma ordem. O floor exclui a leva
 * inteira: dois listings novos abaixo do floor antigo não viram o "floor" um
 * do outro.
 *
 * O NOME DO VENDEDOR VEM DAQUI, e não da consulta de listings. Pedir
 * `makerProfile` lá seria de graça, mas prenderia o canal inteiro a um campo
 * de enfeite: se a Sky Mavis o renomear, a consulta toda é recusada e nenhum
 * listing sai. Aqui ele vai junto com os históricos, na mesma consulta, e se
 * falhar só o nome some.
 */
export async function extrasDosListings(listings) {
  if (!listings.length) return []
  const ids = listings.map((l) => String(l.id))
  const vendedores = listings.map((l) => l.vendedor)
  // Até 10 por consulta: a leva é quase sempre 1 ou 2, mas uma rajada de 18
  // não pode virar uma consulta gigante.
  const historicos = new Map()
  const perfis = new Map()
  for (let i = 0; i < ids.length; i += 10) {
    const parte = await ouVazio(historicosENomes(ids.slice(i, i + 10), i === 0 ? vendedores : []), null)
    if (!parte) continue
    for (const [k, h] of parte.historicos) historicos.set(k, h)
    for (const [k, p] of parte.perfis) perfis.set(k, p)
  }
  const [floor, usd, rar, sc, ron, colecao] = await Promise.all([
    ouVazio(floorSem(ids), null),
    ouVazio(cotacaoRon(), null),
    ouVazio(raridades(ids), null),
    ouVazio(scores(vendedores), null),
    nomesRon(vendedores),
    numerosDaColecao(),
  ])
  return listings.map((l) => {
    const quem = String(l.vendedor).toLowerCase()
    return {
      usd,
      floor,
      pagou: historicos.has(String(l.id)) ? compraDoVendedor(historicos.get(String(l.id)), l.vendedor) : null,
      nomeVendedor: nomeDoEndereco(l.vendedor, perfis.get(quem), ron.get(quem)),
      scoreVendedor: sc && !ROTULOS[quem] ? sc.get(quem) ?? null : null,
      raridade: rar ? rar.get(String(l.id)) ?? null : null,
      colecao,
    }
  })
}
