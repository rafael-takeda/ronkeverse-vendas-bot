/**
 * ============================================================================
 * RONIN — ler a cadeia e reconhecer uma venda
 * ============================================================================
 *
 * Só o RPC público. Sem chave, sem API de terceiro, sem SDK. O que este módulo
 * precisa saber está todo em `eth_getLogs`, `eth_getTransactionByHash` e
 * `eth_getTransactionReceipt`.
 *
 * ---------------------------------------------------------------------------
 * COMO SE RECONHECE UMA VENDA — e por que NÃO é olhando a marketplace
 * ---------------------------------------------------------------------------
 * O Ronkeverse é vendido em pelo menos dois lugares, e eles não se parecem:
 *
 *   OpenSea (Seaport, 0x0000...eb395) — o comprador paga RON NATIVO, e o valor
 *   aparece no `value` da própria transação. Medido: 420 RON no #3369.
 *
 *   Ronin Marketplace (0x3ef2...f2c1) — o `value` é ZERO e o pagamento é em
 *   WRON, um token ERC-20. Medido: 375 e 370 WRON nos #6886 e #5895.
 *
 * Manter uma lista de contratos de marketplace seria um bot que quebra calado
 * no dia em que aparecer a terceira. Então a regra aqui é outra, e vale pras
 * duas sem citar nenhuma:
 *
 *     O COMPRADOR é quem recebeu o NFT.
 *     O PREÇO é tudo que saiu da carteira dele naquela transação.
 *
 * Isso cobre RON nativo e token com a mesma frase, e mata o falso positivo de
 * graça: quem move um NFT entre as próprias carteiras não paga nada a si mesmo,
 * então não há dinheiro saindo do lado que recebe — e o bot ignora sozinho, sem
 * precisar de lista de exceção.
 *
 * ---------------------------------------------------------------------------
 * DUAS ARMADILHAS DO RPC PÚBLICO, as duas medidas na marra
 * ---------------------------------------------------------------------------
 * 1. Ele responde 403 pro User-Agent padrão de biblioteca. Tem que mandar um de
 *    navegador. Descobri isso levando 403 com o `urllib` do Python enquanto o
 *    `curl` passava.
 * 2. `eth_getLogs` aceita no máximo 200 blocos por chamada. Isso é irrelevante
 *    pra este bot (um minuto de Ronin são ~20 blocos) e fatal pra varrer
 *    histórico — o que explica por que este arquivo nunca varre histórico.
 */

const RPC = process.env.RONIN_RPC || 'https://api.roninchain.com/rpc'

/**
 * O contrato da coleção. Trocar esta variável é TUDO que separa este bot de um
 * bot pra qualquer outra coleção ERC-721 da Ronin — o nome, a imagem e os
 * metadados saem do proprio contrato, não daqui.
 */
export const COLECAO =
  (process.env.CONTRATO || '0x810B6d1374ac7BA0E83612E7d49F49A13f1de019').toLowerCase()

/** `Transfer(address,address,uint256)` — o mesmo topic pra ERC-721 e ERC-20. */
const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'

/** Teto do RPC público. Ver o cabeçalho. */
export const MAX_BLOCOS = 200

/**
 * Nome bonito da marketplace, quando ela é conhecida.
 *
 * É SÓ ENFEITE, de propósito: a detecção da venda não passa por aqui. Um
 * contrato desconhecido vira `null` e a venda é anunciada do mesmo jeito, sem o
 * nome do lugar — que é o comportamento que faz o bot envelhecer em vez de
 * quebrar.
 */
const MARKETPLACES = {
  '0x0000000000000068f116a894984e2db1123eb395': 'OpenSea',
  '0x3ef234bc2a04d86f6041e419458d9acbd077f2c1': 'Ronin Market',
  // Terceira porta, achada numa venda real (#4129, 446,99 RON, 11/08/2026): um
  // `TransparentUpgradeableProxy` cuja implementacao se chama `MarketGateway`.
  // Tambem e Ronin Market -- a Axie fundiu os contratos do App.axie com os da
  // marketplace, entao existem duas entradas pro mesmo lugar.
  //
  // O bot JA TINHA ANUNCIADO essa venda sem saber o nome, e e o ponto: a
  // deteccao nunca dependeu desta lista. Ela e enfeite, e por isso um contrato
  // novo custa uma linha de rotulo em vez de uma venda perdida.
  '0x3b3adf1422f84254b7fbb0e7ca62bd0865133fe3': 'Ronin Market',
}

/** WRON é RON embrulhado, 1:1. Pro leitor do Discord os dois são "RON". */
const WRON = '0xe514d9deb7966c8be0ca922de8a064264ea6bcd4'

async function rpc(method, params) {
  const r = await fetch(RPC, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      // Ver armadilha 1 no cabeçalho: sem isto o RPC devolve 403.
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })
  if (!r.ok) throw new Error(`RPC ${method}: HTTP ${r.status}`)
  const d = await r.json()
  if (d.error) throw new Error(`RPC ${method}: ${d.error.message}`)
  return d.result
}

const paraNum = (hex) => (hex ? Number(BigInt(hex)) : 0)
const endereco = (topic) => '0x' + topic.slice(-40).toLowerCase()

/** Wei -> número legível. Tudo na Ronin que este bot vê tem 18 casas. */
export function deWei(bruto) {
  return Number(bruto) / 1e18
}

/**
 * Nome da coleção, lido do contrato uma vez por execução.
 *
 * Existe pra o anúncio não precisar de configuração: `name()` responde
 * "Ronkeverse" neste contrato e o nome certo em qualquer outro. Sem isto o bot
 * teria o nome da coleção escrito à mão em dois lugares, e apontá-lo pra outra
 * coleção anunciaria vendas de uma com o nome da outra.
 */
let nomeCache = null
export async function nomeDaColecao() {
  if (nomeCache !== null) return nomeCache
  try {
    const res = await rpc('eth_call', [{ to: COLECAO, data: '0x06fdde03' }, 'latest'])
    const h = res.slice(2)
    const off = Number(BigInt('0x' + h.slice(0, 64))) * 2
    const tam = Number(BigInt('0x' + h.slice(off, off + 64)))
    nomeCache = Buffer.from(h.slice(off + 64, off + 64 + tam * 2), 'hex').toString('utf8')
  } catch {
    nomeCache = 'NFT' // contrato sem `name()` ainda pode ser anunciado
  }
  return nomeCache
}

export async function blocoAtual() {
  return paraNum(await rpc('eth_blockNumber', []))
}

/**
 * Transferências do NFT numa faixa de blocos.
 *
 * A faixa é fatiada em pedaços de `MAX_BLOCOS` porque o RPC recusa mais que
 * isso — e recusa com erro, não truncando, então sem o fatiamento a chamada
 * inteira falha em vez de devolver menos.
 */
export async function transferencias(de, ate) {
  const saida = []
  for (let ini = de; ini <= ate; ini += MAX_BLOCOS) {
    const fim = Math.min(ini + MAX_BLOCOS - 1, ate)
    const logs = await rpc('eth_getLogs', [
      {
        address: COLECAO,
        topics: [TRANSFER],
        fromBlock: '0x' + ini.toString(16),
        toBlock: '0x' + fim.toString(16),
      },
    ])
    for (const l of logs) {
      // ERC-721 tem 4 topics (o quarto é o tokenId indexado). Três topics seria
      // um ERC-20, que neste endereço não existe — mas a checagem é barata e
      // impede um log estranho virar `tokenId` undefined lá na frente.
      if (l.topics.length !== 4) continue
      saida.push({
        bloco: paraNum(l.blockNumber),
        tx: l.transactionHash,
        de: endereco(l.topics[1]),
        para: endereco(l.topics[2]),
        id: Number(BigInt(l.topics[3])),
      })
    }
  }
  return saida
}

/**
 * A transferência foi uma VENDA? Devolve os detalhes, ou null.
 *
 * Aplica a regra do cabeçalho: soma tudo que saiu da carteira do COMPRADOR
 * nesta transação. Zero = não foi venda (transferência, mint, presente).
 */
export async function detalheDaVenda(t) {
  const [tx, rec] = await Promise.all([
    rpc('eth_getTransactionByHash', [t.tx]),
    rpc('eth_getTransactionReceipt', [t.tx]),
  ])
  if (!tx || !rec || paraNum(rec.status) !== 1) return null

  const comprador = t.para
  let pago = 0n

  /*
   * RON NATIVO — o caso da OpenSea.
   *
   * Só conta se quem ASSINOU a transação é o comprador. Sem essa condição, um
   * contrato que repassa valor no meio do caminho seria lido como pagamento do
   * comprador, e o preço sairia inflado.
   */
  if (tx.from.toLowerCase() === comprador && tx.value && tx.value !== '0x0') {
    pago += BigInt(tx.value)
  }

  /*
   * TOKEN — o caso da Ronin Marketplace (WRON).
   *
   * Todo `Transfer` de ERC-20 cujo remetente é o comprador. Note que o mesmo
   * valor aparece DUAS vezes no recibo (comprador -> marketplace, e depois
   * marketplace -> quem recebe); só a primeira tem o comprador como remetente,
   * então somar por remetente não duplica.
   */
  let moeda = 'RON'
  for (const l of rec.logs) {
    if (l.topics[0] !== TRANSFER || l.topics.length !== 3) continue
    if (endereco(l.topics[1]) !== comprador) continue
    pago += BigInt(l.data || '0x0')
    if (l.address.toLowerCase() !== WRON) moeda = 'TOKEN'
  }

  if (pago === 0n) return null // não foi venda

  return {
    id: t.id,
    tx: t.tx,
    bloco: t.bloco,
    vendedor: t.de, // quem MANDOU o NFT — ver o README sobre o divisor de pagamento
    comprador,
    preco: deWei(pago),
    moeda,
    marketplace: MARKETPLACES[(tx.to || '').toLowerCase()] || null,
  }
}

/**
 * Nome e imagem do NFT, do `tokenURI`.
 *
 * NUNCA DERRUBA O ANÚNCIO: se os metadados não responderem, a venda é postada
 * sem imagem. Um alerta sem arte é feio; um alerta que não sai porque um S3
 * piscou é uma venda que ninguém viu.
 */
export async function metadados(id) {
  try {
    const dado = '0xc87b56dd' + id.toString(16).padStart(64, '0')
    const res = await rpc('eth_call', [{ to: COLECAO, data: dado }, 'latest'])
    const h = res.slice(2)
    const off = Number(BigInt('0x' + h.slice(0, 64))) * 2
    const tam = Number(BigInt('0x' + h.slice(off, off + 64)))
    const uri = Buffer.from(h.slice(off + 64, off + 64 + tam * 2), 'hex').toString('utf8')
    const r = await fetch(uri, { headers: { 'User-Agent': 'Mozilla/5.0 Chrome/126' } })
    if (!r.ok) return {}
    const m = await r.json()
    return { nome: m.name, imagem: m.image }
  } catch {
    return {}
  }
}
