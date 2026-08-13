/**
 * ============================================================================
 * PREÇOS — quanto custou CADA item, lido do evento de ordem do próprio recibo
 * ============================================================================
 *
 * POR QUE ESTE ARQUIVO EXISTE, e por que ele é separado do `ronin.js`.
 *
 * O bot reconhece venda pela carteira: "saiu dinheiro do comprador" é o gatilho,
 * e é isso que faz ele sobreviver a uma marketplace que ninguém previu. Só que a
 * carteira responde sobre a TRANSAÇÃO INTEIRA. Numa compra de três NFTs por
 * 4.200 + 941 + 1.250, ela responde 6.391 — e o bot carimbou 6.391 nos três
 * anúncios (tx 0x50f41a12, 13/08/2026). O total é resposta certa pra pergunta
 * errada.
 *
 * A pergunta "quanto custou ESTE tokenId" só tem uma fonte honesta: o evento que
 * a marketplace emitiu na mesma transação, casado por tokenId. É isso que este
 * módulo faz, e nada além disso.
 *
 * SEPARADO PORQUE APODRECE SOZINHO. Decodificar ABI de contrato de terceiro é a
 * única parte deste repositório que depende de código que outra empresa pode
 * trocar sem avisar (o gateway 0x3b3adf14 é um `TransparentUpgradeableProxy` e
 * já passou por um `initializeV2`). Isolado, um upgrade quebra um arquivo
 * revisável em vez de espalhar suspeita pelo bot inteiro.
 *
 * ---------------------------------------------------------------------------
 * DUAS REGRAS QUE NÃO SE NEGOCIAM AQUI
 * ---------------------------------------------------------------------------
 * 1. NUNCA DIVIDIR. Se uma ordem carrega vários itens e não traz preço unitário
 *    explícito, ela não tem preço por item — e a resposta certa é NENHUM número,
 *    não a média. A média sobrevive escondida: ela tem cara de dado confiável e
 *    passa por qualquer trava que só proíba o total. No lote real ela diria
 *    2.130,33 para itens de 4.200, 941 e 1.250.
 * 2. SEGUIR PONTEIRO, nunca índice de palavra cravado. Uma ordem com 5
 *    destinatários de royalty em vez de 4 desloca tudo que vem depois; quem lê
 *    "palavra 25" lê lixo com confiança total. Quem segue o offset lê certo ou
 *    estoura — e estourar aqui só apaga um número.
 *
 * Um log que não decodifica NÃO derruba os outros: ele só não entra no mapa, e o
 * item dele sai sem preço. A degradação é por ITEM, nunca por transação.
 */

/** `Transfer(address,address,uint256)` — o mesmo topic pra ERC-721 e ERC-20. */
const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'

const WRON = '0xe514d9deb7966c8be0ca922de8a064264ea6bcd4'
const NATIVO = '0x0000000000000000000000000000000000000000'

/**
 * Os quatro topic0 que este arquivo sabe ler. Um topic0 FORA desta lista é
 * silêncio normal (marketplace que ninguém escreveu decodificador ainda); um
 * topic0 DENTRO dela que não decodifica é alarme — ver `avisos`.
 */
const ORDER_MATCHED = '0x109cee1a21fd2e7fba88adb0c288672b657beb8b4f5e36ea950cbebf8a901b6d'
const SEAPORT_FULFILLED = '0x9d9af8e38d66c62e2c12f0225249fd9d721c54b83f48d9352c97c6cacdcb6f31'
const RONIN_ANTIGO_FULFILLED = '0x4ada96fdf5993ba7ebe767e11099cdb1bd14fe57636e904bbd9ae8e1873c442f'
const PROTOCOLO_VENDEU = '0x89c3b465a41d0ab0891833425d7da4f89bafffceffba56a40bfafff01d68d51e'

/** WRON é RON embrulhado 1:1, e RON nativo é RON. Pro leitor os dois são "RON". */
export const ehRon = (m) => m === WRON || m === NATIVO

/* -------------------------------------------------------------------------- */
/* leitor de bytes                                                            */
/* -------------------------------------------------------------------------- */
/**
 * Tudo em BYTE, nada em "palavra 25". O construtor recebe o `data` do log SEM o
 * `0x`, e todo acesso fora da fita estoura em vez de devolver string curta —
 * porque `slice` de string não reclama de nada e um `undefined` silencioso viraria
 * preço zero lá na frente.
 */
class Fita {
  constructor(hexSemPrefixo) {
    this.h = hexSemPrefixo
  }
  palavra(b) {
    const i = b * 2
    if (b < 0 || i + 64 > this.h.length) throw new Error(`fora da fita: byte ${b}`)
    return this.h.slice(i, i + 64)
  }
  uint(b) {
    return BigInt('0x' + this.palavra(b))
  }
  /**
   * Ponteiro ABI: o valor da palavra em `b`, somado a `base` (0 no topo do
   * `data`, o começo da tupla quando o ponteiro é interno a ela). O teto existe
   * pra um campo que não é ponteiro — um preço em wei, por exemplo — não virar
   * um índice gigante e um erro de memória em vez de um erro de leitura.
   */
  salto(b, base = 0) {
    const v = this.uint(b)
    if (v > 100000n) throw new Error(`offset absurdo em ${b}: ${v}`)
    return base + Number(v)
  }
  endereco(b) {
    const w = this.palavra(b)
    if (w.slice(0, 24) !== '0'.repeat(24)) throw new Error(`nao e endereco em ${b}`)
    return '0x' + w.slice(24)
  }
}

/* -------------------------------------------------------------------------- */
/* 1. Ronin Market atual — OrderMatched (gateway 0x3b3adf14)                   */
/* -------------------------------------------------------------------------- */
/**
 * O CHECKSUM AQUI JÁ ESTEVE ERRADO, e o erro custaria vendas legíveis.
 *
 * A tentação é dizer que soma(repasses), preço do taker e `basePrice` são três
 * leituras do mesmo número. Não são: `basePrice` é o preço INICIAL e `endedPrice`
 * é o piso de uma listagem de preço DECRESCENTE. Medido em 690 eventos ao vivo:
 * entre os 306 que são ERC-721 puro, 41 (13,4%) têm `endedAt > 0` e
 * `basePrice != preço executado` — em 0xe697bebe a diferença é de 44x.
 *
 * Exigir `soma === basePrice` descartaria esses 41 como se o proxy tivesse sido
 * atualizado: o item sairia sem preço E o mantenedor veria "checksum falhou" no
 * log de um dia em que nada quebrou. A Ronkeverse só usou preço fixo até hoje,
 * mas isso é hábito da coleção, não propriedade do evento — a opção de listagem
 * é da marketplace.
 */
function leOrderMatched(log, colecao) {
  const f = new Fita(log.data.slice(2))
  const moeda = '0x' + log.topics[2].slice(-40)

  // cabeçalho: [0]=ponteiro p/ bargain, [1]=parcela nativa, [2]=preço, [3]=ponteiro p/ repasses
  const bargain = f.salto(0)
  const repasses = f.salto(96)

  // bargain: [0]=ponteiro p/ Order (relativo ao bargain), [1]=preço do taker
  const order = f.salto(bargain, bargain)
  const precoTaker = f.uint(bargain + 32)

  // Order: [0]=maker [1]=kind [2]=ponteiro p/ ativos [6]=basePrice [7]=endedAt [8]=endedPrice
  const ativos = f.salto(order + 64, order)
  const basePrice = f.uint(order + 6 * 32)
  const endedAt = f.uint(order + 7 * 32)
  const endedPrice = f.uint(order + 8 * 32)

  // ativos: [len] + 4 palavras por item (tipo, contrato, tokenId, quantidade)
  const n = Number(f.uint(ativos))
  if (n < 1 || n > 64) throw new Error(`ativos=${n}`)
  const itens = []
  for (let i = 0; i < n; i++) {
    const p = ativos + 32 + i * 128
    itens.push({ contrato: f.endereco(p + 32), id: Number(f.uint(p + 64)) })
  }

  // repasses: [len] + pares (destinatário, valor). A SOMA é o preço executado.
  const nr = Number(f.uint(repasses))
  if (nr < 1 || nr > 64) throw new Error(`repasses=${nr}`)
  let soma = 0n
  for (let i = 0; i < nr; i++) soma += f.uint(repasses + 32 + i * 64 + 32)

  if (soma !== precoTaker) {
    throw new Error(`checksum: repasses=${soma} taker=${precoTaker}`)
  }
  if (endedAt === 0n) {
    if (soma !== basePrice) throw new Error(`checksum preco fixo: ${soma} != base ${basePrice}`)
  } else if (soma < endedPrice || soma > basePrice) {
    throw new Error(`fora da curva: ${soma} nao esta em [${endedPrice}, ${basePrice}]`)
  }

  /*
   * ORDEM AGREGADA NÃO TEM PREÇO POR ITEM. `soma` é o preço da ORDEM; só é preço
   * do item quando a ordem tem um item. Não existe nenhuma assim na amostra (0
   * em 204 OrderMatched); no dia em que existir, o item sai sem número em vez de
   * sair com média — e o aviso vira console.warn pra alguém escrever o decoder
   * certo.
   */
  if (itens.length > 1) throw new Error(`ordem agregada: ${itens.length} itens`)

  return {
    itens: itens.map((x) => ({ ...x, wei: soma })),
    moeda,
    fonte: 'OrderMatched',
    itensNaOrdem: itens.length,
  }
}

/* -------------------------------------------------------------------------- */
/* 2. OpenSea — Seaport OrderFulfilled                                        */
/* -------------------------------------------------------------------------- */
/**
 * O MESMO EVENTO DESCREVE OS DOIS SENTIDOS, e confundi-los troca preço por NFT.
 * Numa listagem o NFT está em `offer` e o dinheiro em `consideration`; numa
 * oferta aceita é o contrário. Por isso o lado do NFT é procurado, não assumido.
 */
function leSeaport(log, colecao) {
  const f = new Fita(log.data.slice(2))
  // [0]=orderHash [1]=recipient [2]=ponteiro offer [3]=ponteiro consideration
  const off = f.salto(64)
  const con = f.salto(96)

  const lerItens = (base, larg) => {
    const n = Number(f.uint(base))
    if (n > 64) throw new Error(`itens=${n}`)
    const r = []
    for (let i = 0; i < n; i++) {
      const p = base + 32 + i * larg
      r.push({
        tipo: Number(f.uint(p)),
        token: f.endereco(p + 32),
        id: Number(f.uint(p + 64)),
        valor: f.uint(p + 96),
      })
    }
    return r
  }
  const oferta = lerItens(off, 128) // SpentItem   (4 palavras)
  const consid = lerItens(con, 160) // ReceivedItem (5 palavras)

  const ehNft = (x) => x.tipo === 2 || x.tipo === 3
  const nosso = (x) => ehNft(x) && x.token === colecao
  const dinheiro = (x) => x.tipo === 0 || x.tipo === 1

  let lado, pagamento
  if (oferta.some(nosso)) {
    lado = oferta
    pagamento = consid.filter(dinheiro)
  } else if (consid.some(nosso)) {
    lado = consid
    pagamento = oferta.filter(dinheiro)
  } else {
    return null // ordem sem a coleção: não é assunto deste bot
  }
  if (!pagamento.length) return null

  const moedas = new Set(pagamento.map((x) => x.token))
  if (moedas.size !== 1) throw new Error('pagamento em mais de uma moeda')
  const total = pagamento.reduce((s, x) => s + x.valor, 0n)

  // Mesma regra do decoder 1: total de ordem só é preço de item quando a ordem
  // tem um item só. 0 agregadas em 94 Seaport da amostra.
  const nfts = lado.filter(ehNft)
  if (nfts.length > 1) throw new Error(`ordem agregada: ${nfts.length} itens`)

  return {
    itens: nfts.map((x) => ({ contrato: x.token, id: x.id, wei: total })),
    moeda: [...moedas][0],
    fonte: 'Seaport',
    itensNaOrdem: nfts.length,
  }
}

/* -------------------------------------------------------------------------- */
/* 3. Ronin Market antiga — OrderFulfilled (0x3ef234bc)                       */
/* -------------------------------------------------------------------------- */
/**
 * A ÚNICA FAMÍLIA EM QUE UMA ORDEM CARREGA VÁRIOS tokenIds — e por isso a única
 * em que a divisão seria tentadora. Ela não é necessária: a tupla da ordem traz
 * um `uint80` que JÁ É o preço unitário. `unitario * n === soma(repasses)` fica
 * só como conferência cruzada, e nesse papel ele é útil de graça.
 *
 * Nas 5 ordens multi-item da amostra a divisão daria o mesmo resultado (480/4,
 * 450/3, 500/2...) — "certo por acidente", porque o próprio checksum força
 * uniformidade. No dia em que uma ordem tiver itens de preços diferentes, a
 * divisão produziria uma média com `fonte: 'ordem'` carimbada nela. O uint80 não
 * tem esse dia.
 */
function leRoninAntigo(log, colecao) {
  const f = new Fita(log.data.slice(2))
  const t1 = f.salto(0) // tupla da ordem
  const t2 = f.salto(32) // tupla do preenchimento
  const repasses = f.salto(64)

  const contrato = f.endereco(t1 + 32) // campo 2 da tupla 1
  const moeda = f.endereco(t1 + 4 * 32) // campo 5
  const unitario = f.uint(t1 + 7 * 32) // campo 8 (uint80) = PREÇO POR ITEM

  // tupla 2, campo 4 = uint256[] tokenIds (ponteiro relativo a t2)
  const ids = f.salto(t2 + 3 * 32, t2)
  const n = Number(f.uint(ids))
  if (n < 1 || n > 64) throw new Error(`ids=${n}`)
  const itens = []
  for (let i = 0; i < n; i++) {
    itens.push({ contrato, id: Number(f.uint(ids + 32 + i * 32)), wei: unitario })
  }

  const nr = Number(f.uint(repasses))
  if (nr < 1 || nr > 64) throw new Error(`repasses=${nr}`)
  let soma = 0n
  for (let i = 0; i < nr; i++) soma += f.uint(repasses + 32 + i * 64 + 32)

  if (unitario * BigInt(n) !== soma) {
    throw new Error(`checksum antigo: ${unitario}x${n} != ${soma}`)
  }
  return { itens, moeda, fonte: 'RoninAntigo', itensNaOrdem: n }
}

/* -------------------------------------------------------------------------- */
/* 4. Venda pelo próprio protocolo — NFTSoldByProtocol                        */
/* -------------------------------------------------------------------------- */
/**
 * ESTE EVENTO NÃO DIZ DE QUE COLEÇÃO ELE FALA. Sem amarra, qualquer contrato que
 * emitisse este topic0 com um `tokenId` que por acaso existe no Ronkeverse
 * conseguiria carimbar preço num NFT nosso. A amarra é a mesma transação: só
 * vale se o NFT com AQUELE tokenId saiu do contrato que emitiu o evento.
 */
function leProtocolo(log, nossos, colecao) {
  const f = new Fita(log.data.slice(2))
  const id = Number(BigInt(log.topics[1]))
  if (nossos.get(id) !== log.address.toLowerCase()) return null
  return {
    itens: [{ contrato: colecao, id, wei: f.uint(0) }],
    moeda: NATIVO,
    fonte: 'Protocolo',
    itensNaOrdem: 1,
  }
}

/* -------------------------------------------------------------------------- */
/* o mapa da transação                                                        */
/* -------------------------------------------------------------------------- */
/**
 * Lê TODOS os eventos de ordem do recibo.
 *
 *   -> { mapa: Map(tokenId -> { wei, moeda, fonte, emissor, itensNaOrdem, custodia }),
 *        avisos: string[] }
 *
 * `colecao` é parâmetro em vez de constante de módulo de propósito: o endereço da
 * coleção mora em `ronin.js` (é a única linha que troca este bot de coleção) e
 * duplicá-lo aqui criaria dois lugares pra alguém mudar um só.
 *
 * `avisos` só recebe topic0 CONHECIDO que falhou. Topic0 desconhecido não é
 * aviso nenhum — é uma marketplace pra qual ninguém escreveu decodificador, o
 * estado normal do mundo. Confundir os dois transforma o único alarme que este
 * repositório tem em ruído de fundo.
 */
export function precosPorItem(rec, colecao) {
  const alvo = String(colecao).toLowerCase()
  const mapa = new Map()
  const avisos = []

  // tokenId -> quem MANDOU o NFT, só da nossa coleção. Serve de amarra pro
  // decoder 4 e de guarda de escrow pra todos.
  const nossos = new Map()
  for (const l of rec.logs) {
    if (l.address.toLowerCase() !== alvo) continue
    if (l.topics[0] !== TRANSFER || l.topics.length !== 4) continue
    nossos.set(Number(BigInt(l.topics[3])), '0x' + l.topics[1].slice(-40))
  }

  for (const l of rec.logs) {
    let r = null
    try {
      if (l.topics[0] === ORDER_MATCHED) r = leOrderMatched(l, alvo)
      else if (l.topics[0] === SEAPORT_FULFILLED) r = leSeaport(l, alvo)
      else if (l.topics[0] === RONIN_ANTIGO_FULFILLED) r = leRoninAntigo(l, alvo)
      else if (l.topics[0] === PROTOCOLO_VENDEU) r = leProtocolo(l, nossos, alvo)
    } catch (e) {
      avisos.push(`log ${Number(BigInt(l.logIndex))} topic0 ${l.topics[0].slice(0, 10)}: ${e.message}`)
      continue
    }
    if (!r) continue

    const emissor = l.address.toLowerCase()
    for (const it of r.itens) {
      if (it.contrato !== alvo) continue
      /*
       * GUARDA DE ESCROW — medida, não teórica.
       *
       * Na tx 0x7ceee5b8 os três Transfer de #1548/#1906/#2657 saem de
       * 0x3ef234bc, que é EXATAMENTE o contrato que emitiu o evento de ordem (e
       * que o `ronin.js` rotula como "Ronin Market"). O NFT não veio de uma
       * pessoa: veio da custódia da própria marketplace, na perna de ENTREGA de
       * uma oferta cujo depósito aconteceu em outra transação, blocos antes.
       *
       * O preço ali é verdade. O `de` do Transfer NÃO é o vendedor. Marcar em vez
       * de descartar mantém a venda anunciada e deixa o `ronin.js` decidir o que
       * fazer com o vendedor — que é onde essa decisão pertence. Sem esta marca,
       * 0x3ef2…f2c1 vira o vendedor mais recorrente do canal (11 itens na amostra
       * de 240 recibos), e cada um deles é uma pessoa diferente apagada.
       */
      mapa.set(it.id, {
        wei: it.wei,
        moeda: r.moeda,
        fonte: r.fonte,
        emissor,
        itensNaOrdem: r.itensNaOrdem,
        custodia: nossos.get(it.id) === emissor,
      })
    }
  }
  return { mapa, avisos }
}
