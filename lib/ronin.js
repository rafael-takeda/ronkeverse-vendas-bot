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
 *     QUE SAIU DINHEIRO DA CARTEIRA DELE é o que PROVA que houve venda.
 *
 * Isso cobre RON nativo e token com a mesma frase, e mata o falso positivo de
 * graça: quem move um NFT entre as próprias carteiras não paga nada a si mesmo,
 * então não há dinheiro saindo do lado que recebe — e o bot ignora sozinho, sem
 * precisar de lista de exceção.
 *
 * ---------------------------------------------------------------------------
 * GATILHO NÃO É FONTE — a correção de 13/08/2026
 * ---------------------------------------------------------------------------
 * Durante meses este arquivo respondia "QUANTO custou" com o mesmo número com
 * que respondia "houve venda?": o total que saiu da carteira. Numa compra de um
 * NFT só as duas perguntas têm a mesma resposta, e 80% do fluxo é assim. Na tx
 * 0x50f41a12 (três NFTs de uma vez) elas se separaram: 4.200 + 941 + 1.250 saíram
 * da carteira como 6.391, e o canal recebeu 6.391 TRÊS VEZES, sob o rótulo
 * "Price", ao lado da arte de um NFT.
 *
 * Agora são duas fontes, de propósito:
 *
 *   GATILHO — a carteira. Continua aqui, sem nenhuma mudança, porque é ela que
 *   faz o bot anunciar uma venda numa marketplace que ninguém previu.
 *
 *   PREÇO — o evento de ordem do próprio recibo, casado por tokenId (lib/precos.js).
 *   Quando a ordem não dá pra ler, o item sai SEM preço: preço incompleto é
 *   conferível, preço errado envenena o piso que este canal existe pra registrar.
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

import { ehRon, precosPorItem } from './precos.js'

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
  // Quarta porta: o contrato que emite `NFTSoldByProtocol` e vende do estoque do
  // proprio protocolo. Sao 44 dos 361 itens da amostra de 240 recibos -- longe de
  // ser caso raro, e ate 13/08/2026 todos saiam com rodape "Ronin" pelado.
  '0x16bb753b48fbeac599a1a7a291b3f87aa3dbdf19': 'Ronin Market',
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

/**
 * Wei -> número legível, para LOG e TESTE. O anúncio não passa por aqui.
 *
 * As 18 casas não são "tudo na Ronin tem 18 casas" — isso é falso, o USDC tem 6.
 * Elas valem porque só chega aqui WRON ou RON nativo: qualquer outro
 * `paymentToken` é suprimido antes, ainda em `vendasDoGrupo`. Foi assim que o bug
 * de casas decimais do USDC virou inalcançável sem ninguém precisar ler
 * `decimals()`.
 *
 * E o embed recebe o BigInt cru, não isto: `Number` perde casa em valor grande, e
 * a varrida de 40 (15.138,315 RON) já é grande o bastante pra virar
 * 15138.314999999999.
 */
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
 *
 * AS FATIAS SÃO DISJUNTAS, E ISSO VIROU LOAD-BEARING. `[ini, fim]` é inclusivo
 * dos dois lados, `ini += MAX_BLOCOS` e `fim = min(ini+199, ate)`: nenhum bloco
 * cai em duas chamadas e nenhum bloco é partido no meio. É isso que garante que
 * todos os logs de uma MESMA transação voltem na MESMA lista — e o `ciclo.js`
 * depende disso pra agrupar os itens de um lote por (tx, comprador). Quem trocar
 * este laço por faixas sobrepostas ("pra não perder nada na borda") quebra o
 * agrupamento sem nunca abrir o ciclo.js: um lote de 3 viraria dois grupos, e a
 * linha "Batch" de cada um mentiria sobre o tamanho da varrida.
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
        // A POSIÇÃO NO RECIBO, e não a posição neste array: é ela que numera o
        // "1 of 3" do anúncio. Assim o membro confere a numeração linha a linha
        // contra o explorer, em vez de acreditar na ordem em que o bot montou a
        // lista.
        logIndex: paraNum(l.logIndex),
        de: endereco(l.topics[1]),
        para: endereco(l.topics[2]),
        id: Number(BigInt(l.topics[3])),
      })
    }
  }
  return saida
}

/**
 * A transação e o recibo dela, nas duas chamadas que sempre andam juntas.
 *
 * Exportado porque o teste prova contra RECIBO REAL, e não contra dado sintético
 * — e sem esta porta cada arquivo de teste reescreveria o `fetch` com o
 * User-Agent de navegador, que é justamente a armadilha 1 do cabeçalho.
 */
export async function transacaoERecibo(hash) {
  const [tx, rec] = await Promise.all([
    rpc('eth_getTransactionByHash', [hash]),
    rpc('eth_getTransactionReceipt', [hash]),
  ])
  return { tx, rec }
}

/**
 * As transferências de UM COMPRADOR numa transação foram vendas? Devolve uma
 * venda por item (array, possivelmente vazio).
 *
 *   vendasDoGrupo({ tx, comprador, itens: [{ id, de, bloco, logIndex }, ...] })
 *
 * POR QUE UM GRUPO E NÃO UM NFT. Duas razões, e as duas doeram.
 *
 * A cara: os dois RPCs abaixo rodavam UMA VEZ POR NFT. A varrida de 40 numa
 * transação só (0xc568b5ba) custava 80 chamadas contra os 100 req/min publicados,
 * e o `rodar.js` faz isso de minuto em minuto. Por grupo, custa 2.
 *
 * A que dá mentira: a linha "Batch" do anúncio precisa de um denominador, e o
 * denominador certo é POR COMPRADOR, não por transação. Medido na tx 0x0906c539:
 * um vendedor aceita três ofertas de uma vez, três compradores diferentes,
 * 310,03 / 310,02 / 310. Agrupado por transação o bot imprimiria "930,05 RON
 * total" nos três — um agregado que nenhuma carteira gastou. Agrupado por
 * (tx, comprador) cada grupo tem 1 item, a linha Batch nem aparece, e os três
 * anúncios ficam iguais aos de uma venda unitária, que é o que eles são.
 */
export async function vendasDoGrupo(grupo) {
  const { tx, rec } = await transacaoERecibo(grupo.tx)
  if (!tx || !rec || paraNum(rec.status) !== 1) return []

  const comprador = grupo.comprador
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
  let moedaDaCarteira = 'RON'
  /*
   * PORTÃO DE ESCOPO — só interessa ao fallback, e só existe por causa dele.
   *
   * Se o comprador recebeu ERC-721 de OUTRA coleção nesta mesma transação, então
   * `pago` pagou coisas além do Ronkeverse e não é o preço de coisa nenhuma
   * daqui. É a mesma varredura de `rec.logs` que já está na mão, então custa uma
   * condição.
   */
  let comprouForaDaColecao = false
  // tokenIds da coleção que ESTE comprador de fato recebeu neste recibo
  const recebidos = new Set()
  for (const l of rec.logs) {
    if (l.topics[0] !== TRANSFER) continue
    if (l.topics.length === 3) {
      if (endereco(l.topics[1]) !== comprador) continue
      pago += BigInt(l.data || '0x0')
      if (l.address.toLowerCase() !== WRON) moedaDaCarteira = 'TOKEN'
    } else if (l.topics.length === 4) {
      if (endereco(l.topics[2]) !== comprador) continue
      if (l.address.toLowerCase() === COLECAO) recebidos.add(Number(BigInt(l.topics[3])))
      else comprouForaDaColecao = true
    }
  }

  const { mapa, avisos } = precosPorItem(rec, COLECAO)

  /*
   * TOPIC0 CONHECIDO QUE NÃO DECODIFICOU É ALARME, e é o único que este
   * repositório tem. "A marketplace ficou quieta" e "meu decodificador quebrou"
   * são indistinguíveis do lado de fora — dentro não podem ser. O gateway
   * 0x3b3adf14 é um proxy atualizável: no dia em que a implementação mudar, esta
   * linha no log do Actions é o que separa "nada aconteceu" de "pare tudo".
   */
  for (const a of avisos) console.warn(`[precos] ${grupo.tx}: ${a}`)

  // A ordem do recibo é a ordem do anúncio: ver o comentário do `logIndex`.
  const itens = [...grupo.itens].sort((a, b) => (a.logIndex ?? 0) - (b.logIndex ?? 0))
  const n = itens.length

  /*
   * GATILHO EM UNIÃO: pagamento OU ordem.
   *
   * `pago > 0n` sozinho deixava de fora a perna de ENTREGA de uma oferta com
   * escrow — o dinheiro andou na transação do depósito, blocos antes, e nesta
   * aqui o comprador não gasta nada (tx 0x7ceee5b8: tx.value = 0, zero ERC-20
   * saindo dele, e mesmo assim três NFTs mudam de dono por 150 RON cada, escrito
   * no evento de ordem do próprio recibo).
   *
   * A união não afrouxa o contra-exemplo que importa: consolidação de carteira
   * (tx 0x3f835be8, 20 NFTs) tem pagamento zero E mapa vazio, então continua
   * sendo silêncio. Silêncio não é mentira.
   *
   * E o ramo da ordem exige `recebidos`: só vale se o RECIBO mostra aquele
   * tokenId indo pra ESTE comprador. É o único ramo capaz de anunciar sem
   * dinheiro nenhum ter se movido, então ele precisa estar ancorado em algo que o
   * próprio recibo prove — senão bastaria uma ordem citando o tokenId pra
   * qualquer endereço virar comprador dele.
   */
  const temOrdem = itens.some((t) => mapa.has(t.id) && recebidos.has(t.id))
  if (pago === 0n && !temOrdem) return []

  /*
   * O RÓTULO SAI DE QUEM EMITIU A ORDEM, e só depois do recibo — `tx.to` saiu da
   * conta. Na tx do bug ele era 0x21a0a1c0, um roteador de compra em lote que não
   * está no mapa, e por isso os três anúncios saíram com rodapé "Ronin" pelado
   * enquanto a venda tinha acontecido na Ronin Market. Quem liquidou a ordem sabe
   * onde ela foi; o contrato que a transação chamou primeiro, não.
   */
  const marketplaceDoRecibo =
    rec.logs.map((l) => MARKETPLACES[l.address.toLowerCase()]).find(Boolean) || null

  const vendas = itens.map((t, i) => {
    const ordem = mapa.get(t.id)
    let precoWei = null
    let fonte = null
    let motivo = null

    if (ordem && ehRon(ordem.moeda)) {
      precoWei = ordem.wei
      fonte = 'ordem'
    } else if (ordem) {
      /*
       * MOEDA DA ORDEM, NUNCA DA CARTEIRA. Três transações pareciam exigir este
       * caminho (0xd2bb0c2e em WETH, 0x8d2c45a1 em $RONKE, 0x34f2fc2b em USDC) e
       * nas três a ORDEM declara WRON: o token exótico era só a perna de
       * financiamento, trocada por WRON no meio do caminho. Um portão de moeda
       * lido da carteira publicaria "este bot não precifica" sobre venda cotada
       * em WRON — falso, e pela mesma raiz do bug original.
       */
      motivo = 'moeda'
    } else if (n > 1) {
      /*
       * FALLBACK PROIBIDO EM LOTE — é literalmente o bug que este conserto existe
       * pra matar. Com mais de um item, `pago` é o gasto da CARTEIRA na
       * transação inteira; carimbá-lo aqui é publicar 6.391 três vezes.
       */
      motivo = 'lote'
    } else if (comprouForaDaColecao) {
      motivo = 'lote-misto'
    } else if (moedaDaCarteira !== 'RON') {
      /*
       * Sem ordem legível, a carteira não responde sobre a moeda do item — ela
       * responde sobre a transação. Então aqui o bot não sabe, e dizer "não sei"
       * é a única frase verdadeira disponível.
       */
      motivo = 'sem-decodificador'
    } else if (pago > 0n) {
      /*
       * O FALLBACK, e é só ele: um item, um comprador, RON.
       *
       * É o que mantém de pé a promessa que já salvou o bot em produção — uma
       * marketplace nova, sem decodificador nenhum, continua virando anúncio COM
       * preço. Aqui as duas perguntas ("houve venda?" e "quanto custou?") de fato
       * têm a mesma resposta, porque não há um segundo item pra dividir o total.
       */
      precoWei = pago
      fonte = 'fallback'
    } else {
      motivo = 'sem-decodificador'
    }

    if (precoWei === null) {
      console.warn(`[precos] ${grupo.tx} #${t.id} sem preco (${motivo})`)
    }

    const custodia = Boolean(ordem?.custodia)
    return {
      id: t.id,
      tx: grupo.tx,
      bloco: t.bloco,
      logIndex: t.logIndex ?? 0,
      /*
       * VENDEDOR É QUEM MANDOU O NFT — menos quando quem mandou foi o contrato
       * que emitiu a ordem. Aí o NFT saiu da custódia da marketplace (perna de
       * entrega de uma oferta) e `t.de` é 0x3ef2…f2c1, o próprio "Ronin Market".
       * São 11 itens na amostra de 240 recibos; sem esta linha esse endereço
       * viraria o vendedor mais recorrente do canal, e cada aparição dele é uma
       * pessoa real apagada.
       *
       * E NÃO tentar recuperar o vendedor verdadeiro do último par de repasses do
       * evento: bateu em 92,5% das ordens auditadas, o que é hábito e não
       * garantia — e o custo de errar é nomear a pessoa errada numa venda.
       */
      vendedor: custodia ? null : t.de,
      vendedorMotivo: custodia ? 'escrow' : null,
      comprador,
      precoWei,
      fonte,
      motivo,
      // A unidade sai da ORDEM. Quando não há número não há unidade nenhuma pra
      // afirmar — e é por isso que este campo é null em vez de 'RON' otimista.
      moeda: precoWei === null ? null : 'RON',
      marketplace: (ordem && MARKETPLACES[ordem.emissor]) || marketplaceDoRecibo,
      custodia,
      itensDoComprador: n,
      posicao: i + 1,
    }
  })

  /*
   * O TOTAL DA LINHA "BATCH" É SOMA DOS ITENS, NUNCA `pago`.
   *
   * Nesta distinção mora a diferença entre um número conferível e um chute com
   * cara de fato: na tx 0xd2bb0c2e o `pago` daria 0,1229 (em WETH) contra 4.370
   * RON de preço real. E o total só existe quando os N itens fecham: um item sem
   * preço torna a soma um subtotal, e subtotal anunciado como total é a mesma
   * classe de defeito que este arquivo acabou de consertar.
   */
  const precificados = vendas.filter((v) => v.precoWei !== null)
  const fecha = precificados.length === n
  const total = fecha ? precificados.reduce((s, v) => s + v.precoWei, 0n) : null
  for (const v of vendas) {
    v.precificadosDoGrupo = precificados.length
    v.totalDoGrupoWei = total
  }

  return vendas
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
