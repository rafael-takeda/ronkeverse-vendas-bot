/**
 * ============================================================================
 * OPENSEA — os listings do Ronkeverse que nascem no OpenSea
 * ============================================================================
 *
 * ---------------------------------------------------------------------------
 * POR QUE PRECISA DE API, e de qual
 * ---------------------------------------------------------------------------
 * Listing no OpenSea é uma ordem Seaport ASSINADA e guardada no servidor
 * deles — como na Ronin Market, não passa pela cadeia. A API oficial v2 dá os
 * eventos de listing da coleção (`/events/collection/ronkeverse`). Medido em
 * 28/09/2026: 50 eventos em 23 h, todos Seaport (0x0000…b395) na Ronin, todos
 * em RON nativo (token 0x0), todos do contrato do Ronkeverse.
 *
 * ---------------------------------------------------------------------------
 * A CHAVE: o bot emite e renova a dele
 * ---------------------------------------------------------------------------
 * O OpenSea tem uma chave grátis instantânea (`POST /auth/keys`, sem conta),
 * que vale 7 dias e 600 leituras por hora. A doc deles diz que ela é "ideal
 * for AI agents, scripts" e que um agente de longa duração deve "mint a new
 * one or upgrade" antes de ela vencer. É o que `chaveOpenSea` faz: guarda a
 * chave no Redis e emite outra quando falta menos de um dia — no máximo UMA
 * emissão por hora (trava no Redis), pra uma falha não virar rajada. Com
 * `OPENSEA_API_KEY` no ambiente (a permanente, pedida em
 * opensea.io/settings/developer), ela vence tudo e nada é emitido.
 *
 * Só o laço do VPS emite (`podeEmitir`). A Vercel, que usa o OpenSea só pro
 * floor das vendas, LÊ a chave guardada e nunca emite.
 *
 * ORÇAMENTO, medido nos cabeçalhos em 28/09: eventos e listings dividem 600
 * leituras por hora. A passada pergunta uma vez por minuto (60/h), a
 * confirmação de listing ativo roda só pro que vai sair, e o floor só quando
 * há anúncio. O endpoint de estatísticas tem limite de 120 e NÃO é usado.
 */
import { COLECAO } from './ronin.js'
import { chaveOpenSeaGuardada, esqueceChaveOpenSea, guardaChaveOpenSea, travaEmissaoOpenSea } from './estado.js'

const API = 'https://api.opensea.io/api/v2'
const SLUG = process.env.OPENSEA_SLUG || 'ronkeverse'
const SEAPORT = '0x0000000000000068f116a894984e2db1123eb395'
const NATIVO = '0x0000000000000000000000000000000000000000'
const WRON = '0xe514d9deb7966c8be0ca922de8a064264ea6bcd4'
const TEMPO_MAXIMO_MS = 10_000

/** Renova quando falta menos que isto pra chave vencer. */
const RENOVA_ANTES_MS = 24 * 60 * 60_000

/** A chave fica em memória por 10 min: sem isso, cada passada seria um GET no Redis. */
let emMemoria = null

/* ============================================================================
   A CHAVE
   ============================================================================ */

async function emiteChave() {
  const r = await fetch(`${API}/auth/keys`, { method: 'POST', signal: AbortSignal.timeout(TEMPO_MAXIMO_MS) })
  if (!r.ok) throw new Error(`OpenSea: emitir chave deu HTTP ${r.status}`)
  const j = await r.json()
  const expira = Date.parse(j.expires_at)
  if (typeof j.api_key !== 'string' || !(expira > Date.now())) {
    throw new Error('OpenSea: resposta de chave sem api_key ou expires_at')
  }
  return { chave: j.api_key, expira }
}

/**
 * A chave a usar, ou null. Com `podeEmitir`, emite uma nova quando não há
 * chave guardada ou ela vence em menos de um dia. A chave NUNCA vai pro log.
 */
export async function chaveOpenSea({ podeEmitir = false } = {}) {
  if (process.env.OPENSEA_API_KEY) return process.env.OPENSEA_API_KEY
  if (emMemoria && emMemoria.ate > Date.now() && emMemoria.expira - Date.now() > RENOVA_ANTES_MS) return emMemoria.chave

  const guardada = await chaveOpenSeaGuardada()
  const lembra = (g) => {
    emMemoria = { ...g, ate: Date.now() + 10 * 60_000 }
    return g.chave
  }
  if (guardada && guardada.expira - Date.now() > RENOVA_ANTES_MS) return lembra(guardada)
  // Vencendo em menos de um dia (ou sem chave): só o laço do VPS renova.
  if (!podeEmitir || !(await travaEmissaoOpenSea())) return guardada ? lembra(guardada) : null
  let nova
  try {
    nova = await emiteChave()
  } catch (e) {
    // A que está guardada ainda vale até vencer; a trava tenta de novo em 1 h.
    if (guardada) {
      console.warn(`[opensea] não consegui renovar a chave (${e.message}); sigo com a atual`)
      return lembra(guardada)
    }
    throw e
  }
  await guardaChaveOpenSea(nova.chave, nova.expira)
  console.log(`[opensea] chave nova emitida, vence ${new Date(nova.expira).toISOString()}`)
  return lembra(nova)
}

/** GET na API. 404 vira null; chave recusada é esquecida pra a próxima passada emitir outra. */
async function pede(caminho, chave) {
  const r = await fetch(API + caminho, {
    headers: { 'x-api-key': chave, accept: 'application/json' },
    signal: AbortSignal.timeout(TEMPO_MAXIMO_MS),
  })
  if (r.status === 401) {
    emMemoria = null
    if (!process.env.OPENSEA_API_KEY) await esqueceChaveOpenSea()
    throw new Error('OpenSea: chave recusada (HTTP 401) -- a próxima passada emite outra')
  }
  if (r.status === 404) return null
  if (!r.ok) throw new Error(`OpenSea: HTTP ${r.status} em ${caminho.split('?')[0]}`)
  return r.json()
}

/* ============================================================================
   PEÇAS PURAS — testadas sem rede em teste_opensea.js
   ============================================================================ */

/**
 * O evento vira anúncio? Só listing público, Seaport, na Ronin, de UM item do
 * Ronkeverse, ainda não vencido. O protocolo filtra o que não é ordem do
 * próprio OpenSea: listing agregado de outra marketplace, se um dia aparecer,
 * já tem a fonte dele.
 */
export function eventoValido(e, agoraS = Date.now() / 1000) {
  return Boolean(
    e &&
      e.order_type === 'listing' &&
      !e.is_private_listing &&
      String(e.chain) === 'ronin' &&
      String(e.protocol_address).toLowerCase() === SEAPORT &&
      Number(e.quantity) === 1 &&
      e.asset &&
      String(e.asset.contract).toLowerCase() === COLECAO &&
      !e.asset.is_disabled &&
      Number(e.expiration_date) > agoraS &&
      e.payment &&
      /^\d+$/.test(String(e.payment.quantity)),
  )
}

/** Um evento de listing -> o formato que a passada e o discord.js entendem. */
export function normalizaEvento(e) {
  const a = e.asset
  const p = e.payment
  const token = String(p.token_address || '').toLowerCase()
  const preco = BigInt(p.quantity)
  return {
    marketplace: 'OpenSea',
    // Prefixo: a marca no Redis é por ordem, e a das duas fontes mora na
    // mesma chave-base. Hash de Seaport e id da Ronin Market não colidem, mas
    // com o prefixo dá pra saber de onde veio só de olhar.
    ordem: `os:${String(e.order_hash).toLowerCase()}`,
    hash: String(e.order_hash).toLowerCase(),
    id: String(a.identifier),
    nome: a.name || null,
    vendedor: String(e.maker).toLowerCase(),
    precoWei: preco,
    baseWei: preco,
    finalWei: null,
    moeda: (token === NATIVO || token === WRON) && Number(p.decimals) === 18 ? 'RON' : null,
    inicio: Number(e.event_timestamp),
    expira: Number(e.expiration_date),
    imagem: a.image_url || a.display_image_url || null,
    link: a.opensea_url || `https://opensea.io/assets/ronin/${COLECAO}/${a.identifier}`,
  }
}

/**
 * O floor do OpenSea SEM os tokens dados — a mesma ideia de `escolheFloor` do
 * mercado.js, na forma da resposta de `/listings/collection/…/best`.
 */
export function escolheFloorOpenSea(listings, excluir = [], agoraS = Date.now() / 1000) {
  const fora = new Set(excluir.map(String))
  let melhor = null
  for (const l of listings || []) {
    const par = l && l.protocol_data && l.protocol_data.parameters
    const oferta = par && par.offer && par.offer[0]
    const preco = l && l.price && l.price.current
    if (!oferta || !preco) continue
    if (l.status && l.status !== 'ACTIVE') continue
    if (String(oferta.token).toLowerCase() !== COLECAO || fora.has(String(oferta.identifierOrCriteria))) continue
    if (Number(par.endTime) > 0 && Number(par.endTime) <= agoraS) continue
    if (!['RON', 'WRON'].includes(preco.currency) || Number(preco.decimals) !== 18 || !/^\d+$/.test(String(preco.value))) continue
    const w = BigInt(preco.value)
    if (!melhor || w < melhor.precoWei) melhor = { id: String(oferta.identifierOrCriteria), precoWei: w }
  }
  return melhor
}

/* ============================================================================
   O QUE O RESTO DO BOT PEDE — todas LANÇAM, quem chama decide o que fazer
   ============================================================================ */

/** Os listings do OpenSea mais novos, do mais novo pro mais velho. */
export async function ultimosListingsOpenSea(quantos, chave) {
  const j = await pede(`/events/collection/${SLUG}?event_type=listing&limit=${Math.min(Math.max(quantos, 1), 50)}`, chave)
  if (!j || !Array.isArray(j.asset_events)) throw new Error('OpenSea: resposta sem asset_events')
  const agoraS = Date.now() / 1000
  return j.asset_events.filter((e) => eventoValido(e, agoraS)).map(normalizaEvento)
}

/**
 * O listing ainda está de pé? O "melhor listing" do NFT tem que ser ESTA
 * ordem. Medido em 28/09: o NFT cujo listing tinha vencido deu 404 ("No
 * listings found"), e o ativo devolveu o mesmo order_hash do evento.
 */
export async function listingAindaAtivo(l, chave) {
  const j = await pede(`/listings/collection/${SLUG}/nfts/${encodeURIComponent(l.id)}/best`, chave)
  return Boolean(j && String(j.order_hash).toLowerCase() === l.hash)
}

/** Os listings mais baratos do OpenSea, crus — pro floor (ver `escolheFloorOpenSea`). */
export async function melhoresListingsOpenSea(limite, chave) {
  const j = await pede(`/listings/collection/${SLUG}/best?limit=${Math.min(Math.max(limite, 1), 50)}`, chave)
  return j && Array.isArray(j.listings) ? j.listings : []
}
