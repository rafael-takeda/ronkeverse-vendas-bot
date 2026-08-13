/**
 * PROVA DA DETECÇÃO — contra vendas reais, não contra o que eu acho.
 *
 *   node teste.js
 *
 * As três primeiras transações abaixo foram vendas de verdade do Ronkeverse, uma
 * pela OpenSea e duas pela Ronin Marketplace. Elas existem aqui porque a regra do
 * bot ("saiu dinheiro da carteira do comprador") só vale se reproduzir os números
 * que essas transações já registraram na cadeia.
 *
 * Depois delas vêm os LOTES, e eles provam a outra metade da regra: o gatilho
 * continua sendo a carteira, mas QUANTO custou cada item vem do evento de ordem
 * do recibo. Os três casos de 1 NFT ficam onde estão, com os mesmos números de
 * sempre — são a prova de que o caminho feliz (~80% do fluxo) não regrediu por
 * causa de um conserto de lote.
 *
 * Se um dia alguma marketplace mudar o jeito de liquidar, é aqui que aparece.
 */
import { COLECAO, deWei, metadados, transacaoERecibo, vendasDoGrupo } from './lib/ronin.js'
import { agrupa } from './lib/ciclo.js'
import { anuncia, montaEmbed, weiExato } from './lib/discord.js'
import { gravaBloco, jaAnunciado, marcaAnunciado, ultimoBloco } from './lib/estado.js'

let falhas = 0
const conf = (cond, msg, extra = '') => {
  if (!cond) {
    falhas++
    console.error('  FALHOU  ' + msg + '  ' + extra)
  } else console.log('  ok      ' + msg + (extra ? '  ' + extra : ''))
}

/*
 * A REDE, DUBLADA SÓ NA REPETIÇÃO.
 *
 * A primeira chamada de cada transação vai pra cadeia DE VERDADE — o valor deste
 * arquivo está inteiro nisso, e um dublê de recibo provaria só que eu sei
 * escrever JSON. O que este envelope corta é a REPETIÇÃO: várias asserções
 * conferem a mesma transação por ângulos diferentes, e o RPC público publica
 * 100 requisições por minuto. Sem isto a suíte não roda duas vezes seguidas, e
 * uma suíte que falha por cadência ensina a ignorar falha.
 */
const fetchDaRede = globalThis.fetch
const memoria = new Map()
globalThis.fetch = async (url, opt) => {
  const chave = opt?.body ? `${url}|${opt.body}` : null
  if (chave && memoria.has(chave)) {
    const d = memoria.get(chave)
    return { ok: true, status: 200, json: async () => d }
  }
  const r = await fetchDaRede(url, opt)
  if (!chave || !r.ok) return r
  const d = await r.json()
  memoria.set(chave, d)
  return { ok: true, status: 200, json: async () => d }
}

const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'

/**
 * As transferências da coleção num recibo, no mesmo formato que `transferencias`
 * devolve varrendo blocos. Serve pra apontar o teste a uma transação pelo hash,
 * sem precisar saber em que bloco ela caiu.
 */
function movimentosDaTx(hash, rec) {
  return rec.logs
    .filter((l) => l.address.toLowerCase() === COLECAO && l.topics[0] === TRANSFER && l.topics.length === 4)
    .map((l) => ({
      tx: hash,
      bloco: Number(BigInt(l.blockNumber)),
      logIndex: Number(BigInt(l.logIndex)),
      de: '0x' + l.topics[1].slice(-40).toLowerCase(),
      para: '0x' + l.topics[2].slice(-40).toLowerCase(),
      id: Number(BigInt(l.topics[3])),
    }))
}

/** Todas as vendas de uma transação, pelo mesmo caminho que o ciclo percorre. */
async function vendasDaTx(hash) {
  const { rec } = await transacaoERecibo(hash)
  const saida = []
  for (const g of agrupa(movimentosDaTx(hash, rec)).values()) {
    saida.push(...(await vendasDoGrupo(g)))
  }
  return saida
}

/** Todas as vendas que este arquivo produziu, pras travas estruturais do fim. */
const TUDO = []

// (tx, tokenId, quem recebeu o NFT, preço esperado, marketplace esperada)
const CASOS = [
  {
    tx: '0xd620173d987ad031d1c263bbf36e6b1d497434b6fc1840d93490e9268c629c57',
    id: 3369,
    para: '0x138fefdb5117d6f37aeb39959e9a6fc516bfb834',
    de: '0x9f8bc9c10d6c344fd089ac27ec1cab694dd864f8',
    preco: 420,
    onde: 'OpenSea',
  },
  {
    tx: '0x0de5e65c752eaf4fe39eafb0dfd5d3e5634b40ed8974f84c876c46e9bb098990',
    id: 6886,
    para: '0xc8b7aefc4a85bbec9c2e7db9850c56eddd2800b2',
    de: '0xd8e99daf1bd735e934e4236a138a6e836b686e04',
    preco: 375,
    onde: 'Ronin Market',
  },
  {
    tx: '0x97c31710276b077053974bceb679b541d4fda8043440eb43a0a4e1890dc42721',
    id: 5895,
    para: '0x1cdcbd5de75bceda4e3c929afa5c7269b8b81303',
    de: '0xdc7fb37230315d6b17172c4fd121441b17eb11c9',
    preco: 370,
    onde: 'Ronin Market',
  },
]

console.log('\nDETECÇÃO DE VENDA — contra a cadeia\n')

for (const c of CASOS) {
  const [v] = await vendasDoGrupo({
    tx: c.tx,
    comprador: c.para,
    itens: [{ id: c.id, de: c.de, bloco: 0, logIndex: 0 }],
  })
  if (!v) {
    falhas++
    console.error(`  FALHOU  #${c.id} não foi reconhecida como venda`)
    continue
  }
  TUDO.push(v)
  conf(deWei(v.precoWei) === c.preco, `#${c.id} preço`, `${deWei(v.precoWei)} ${v.moeda} (esperado ${c.preco})`)
  conf(v.marketplace === c.onde, `#${c.id} marketplace`, `${v.marketplace}`)
  conf(v.comprador === c.para, `#${c.id} comprador`, v.comprador.slice(0, 12) + '..')
  conf(v.vendedor === c.de, `#${c.id} vendedor`, String(v.vendedor).slice(0, 12) + '..')
  conf(v.itensDoComprador === 1, `#${c.id} venda unitária não vira lote`, `${v.itensDoComprador}`)
}

/*
 * O CONTRA-EXEMPLO É METADE DO TESTE.
 *
 * Sem ele, um bug que devolvesse "venda" pra qualquer transferência passaria em
 * todos os casos acima e só apareceria no canal do Discord, anunciando venda
 * onde ninguém pagou nada. Aqui a transação é real e o comprador é FALSO — como
 * nada saiu da carteira dele E nenhuma ordem cita o item pra ele, a resposta
 * certa é lista vazia.
 */
const falso = await vendasDoGrupo({
  tx: CASOS[0].tx,
  comprador: '0x000000000000000000000000000000000000dead',
  itens: [{ id: 3369, de: CASOS[0].de, bloco: 0, logIndex: 0 }],
})
conf(falso.length === 0, 'quem não pagou nada não é comprador', falso.map((v) => v.id).join(','))

// Metadados: o alerta precisa de nome e imagem, e eles vêm de fora da cadeia.
const m = await metadados(3369)
conf(m.nome === 'Ronkeverse #3369', 'nome do NFT', m.nome ?? '(vazio)')
conf(!!m.imagem && m.imagem.startsWith('http'), 'imagem do NFT', m.imagem ?? '(vazia)')

/*
 * O EMBED — é o que o Discord de fato recebe.
 *
 * A detecção pode estar perfeita e o anúncio sair quebrado: campo vazio, título
 * gigante, imagem sem URL. O Discord recusa a mensagem inteira com 400 nesses
 * casos, e o sintoma seria "o bot não posta" sem nenhuma pista de por quê.
 */
const [vendaOk] = await vendasDoGrupo({
  tx: CASOS[0].tx,
  comprador: CASOS[0].para,
  itens: [{ id: 3369, de: CASOS[0].de, bloco: 0, logIndex: 0 }],
})
const e = montaEmbed(vendaOk, m)
conf(e.title === 'Ronkeverse #3369 sold', 'título do embed', e.title)
conf(e.fields.length === 3, 'três campos', e.fields.map((f) => f.name).join(', '))
conf(/420/.test(e.fields[0].value), 'preço no embed', e.fields[0].value)
conf(e.url.includes(CASOS[0].tx), 'link pra transação')
conf(!!e.image?.url, 'imagem no embed', e.image?.url ?? '(sem)')
conf(e.footer.text === 'Ronin · OpenSea', 'rodapé com a marketplace', e.footer.text)
// Limites do Discord: título 256 chars, 25 campos, 6000 no embed inteiro.
conf(e.title.length <= 256 && JSON.stringify(e).length <= 6000, 'dentro dos limites do Discord')

/* ========================================================================== */
console.log('\nLOTE — um preço por item, e um contexto que não mente\n')
/* ========================================================================== */

/*
 * A TRANSAÇÃO QUE PRODUZIU O BUG. Antes deste conserto os três anúncios saíam
 * "**6,391 RON**" — o total da carteira, carimbado três vezes.
 */
const LOTE = '0x50f41a12d49471d4a8e36286a5da99ee52987a2546997b66be0cbee58d014da9'
const lote = await vendasDaTx(LOTE)
TUDO.push(...lote)
const esperadoLote = { 2985: '4,200', 2986: '941', 5086: '1,250' }
conf(lote.length === 3, 'lote: três vendas', `${lote.length}`)
for (const v of lote) {
  const emb = montaEmbed(v, {}, 'Ronkeverse')
  conf(
    emb.fields[0].value === `**${esperadoLote[v.id]} RON**`,
    `lote: #${v.id} preço do ITEM`,
    emb.fields[0].value,
  )
  conf(v.fonte === 'ordem', `lote: #${v.id} preço veio da ordem`, String(v.fonte))
  conf(
    emb.fields[3]?.value === `${v.posicao} of 3 Ronkeverse in this transaction · 6,391 RON total`,
    `lote: #${v.id} linha Batch`,
    emb.fields[3]?.value,
  )
  conf(emb.footer.text === 'Ronin · Ronin Market', `lote: #${v.id} rodapé`, emb.footer.text)
}
// O `i` sai do logIndex do recibo (3, 8 e 13), não da posição no array — é o que
// torna a numeração conferível linha a linha contra o explorer.
conf(
  lote.map((v) => `${v.posicao}:${v.id}`).join(' ') === '1:2985 2:2986 3:5086',
  'lote: a numeração segue o logIndex do recibo',
  lote.map((v) => `${v.posicao}:${v.id}@${v.logIndex}`).join(' '),
)

/*
 * (B) A ASSERÇÃO DECISIVA — a soma dos itens bate AO WEI com o `tx.value`.
 *
 * Não é "o preço parece plausível": é o único mecanismo que pega decodificação
 * silenciosamente errada. Vale como TESTE e nunca como portão de runtime — uma
 * varrida que misture coleções quebra a igualdade legitimamente.
 */
const SOMAS = [
  { tx: LOTE, nome: 'o lote do bug' },
  { tx: '0x15c15b7c298754f7e23f812fa58a4031c734a8ca9f99e347fa0cf540425bb493', nome: 'dois a 459,98' },
  { tx: '0xc568b5ba075433e46f2b448e937cee46e0adb7b82f17c3eef0fca23aaf3862b8', nome: 'a varrida de 40' },
]
for (const s of SOMAS) {
  const { tx } = await transacaoERecibo(s.tx)
  const vs = await vendasDaTx(s.tx)
  TUDO.push(...vs)
  const soma = vs.reduce((a, v) => a + (v.precoWei ?? 0n), 0n)
  conf(soma === BigInt(tx.value), `${s.nome}: soma dos itens == tx.value`, weiExato(soma))
  conf(
    vs.every((v) => v.totalDoGrupoWei === soma),
    `${s.nome}: o total da linha Batch é a soma dos ITENS`,
  )
}

/*
 * (C) O CASO DE CUSTÓDIA — a falha que os céticos mediram.
 *
 * O NFT saiu do PRÓPRIO contrato que emitiu a ordem (0x3ef2…f2c1, que o bot
 * rotula "Ronin Market"). O preço, 150, é verdade. O vendedor não está neste
 * recibo — ele depositou os NFTs três blocos atrás, noutra transação. Sem esta
 * guarda, 0x3ef2…f2c1 viraria o vendedor mais recorrente do canal.
 */
const ESCROW = '0x7ceee5b8100471cc370bec2da337bea7d126c113a0b997d41e9d7a756c29bd6c'
const escrow = await vendasDaTx(ESCROW)
TUDO.push(...escrow)
conf(escrow.length === 3, 'escrow: três anúncios', `${escrow.length}`)
for (const v of escrow) {
  const emb = montaEmbed(v, {}, 'Ronkeverse')
  conf(emb.fields[0].value === '**150 RON**', `escrow: #${v.id} preço`, emb.fields[0].value)
  conf(emb.fields[2].value === 'escrow · see transaction', `escrow: #${v.id} Seller sem endereço`, emb.fields[2].value)
  conf(!JSON.stringify(emb).includes('0x3ef2'), `escrow: #${v.id} o embed não contém 0x3ef2`)
}

/*
 * O AGRUPAMENTO POR COMPRADOR — a outra falha fatal.
 *
 * Um vendedor aceita várias ofertas numa transação só. Agrupado por transação, o
 * bot imprimiria um total que nenhuma carteira gastou. Por (tx, comprador), cada
 * grupo tem um item, a linha Batch some, e cada anúncio volta a ser o que sempre
 * foi: uma venda unitária.
 */
const MULTI = [
  { tx: '0x0906c5395c8bfc676a9ab19636902946636440eb6b9b1a5533c70126f4699495', n: 3, proibido: '930' },
  { tx: '0xf5ef853623891951220d4cee6b549fc3fb56b6cc6b447a423ea6a1798b15bc18', n: 2, proibido: '560' },
  { tx: '0xc5a5aa466c5792a4b26e55f53c0a49badedba7b20a5c8749397c6ed1b836f576', n: 2, proibido: '347' },
]
for (const c of MULTI) {
  const vs = await vendasDaTx(c.tx)
  TUDO.push(...vs)
  conf(vs.length === c.n, `${c.tx.slice(0, 10)}: ${c.n} vendas, compradores distintos`, `${vs.length}`)
  const embeds = vs.map((v) => montaEmbed(v, {}, 'Ronkeverse'))
  conf(
    embeds.every((x) => x.fields.length === 3),
    `${c.tx.slice(0, 10)}: nenhum campo Batch (cada comprador levou 1)`,
  )
  conf(
    !embeds.some((x) => JSON.stringify(x).includes(c.proibido)),
    `${c.tx.slice(0, 10)}: nenhum embed contém "${c.proibido}"`,
  )
}

/*
 * A MOEDA VEM DA ORDEM, NUNCA DA CARTEIRA. Nas três o token exótico era só a
 * perna de financiamento; as ordens declaram WRON e por isso saem COM número. Um
 * portão de moeda lido da carteira publicaria "this bot does not price" sobre
 * venda cotada em WRON — falso, e pela mesma raiz do bug original.
 */
const MOEDAS = [
  { tx: '0xd2bb0c2e6ab65813b43ace1430a6cede340c6bd7f58ae34bbdd9f6ea60403cb6', nome: 'WETH', n: 10 },
  { tx: '0x8d2c45a1907f71eb77e97a5550809499f31362f26ad290c48cbd816ac6921e04', nome: '$RONKE', n: 2, proibido: '103' },
  { tx: '0x34f2fc2b35be33c0692adf9e83d9d6e6ce3a69c0a8b5dbdb2877b6abfb2244cd', nome: 'USDC', n: 6 },
]
for (const c of MOEDAS) {
  const vs = await vendasDaTx(c.tx)
  TUDO.push(...vs)
  conf(vs.length === c.n, `financiado em ${c.nome}: ${c.n} vendas`, `${vs.length}`)
  conf(
    vs.every((v) => v.precoWei !== null && v.moeda === 'RON'),
    `financiado em ${c.nome}: todos saem COM número, em RON`,
  )
  if (c.proibido) {
    conf(
      !vs.some((v) => JSON.stringify(montaEmbed(v, {}, 'Ronkeverse')).includes(c.proibido)),
      `financiado em ${c.nome}: nenhum embed contém "${c.proibido}"`,
    )
  }
}

/*
 * OS CONTRA-EXEMPLOS DO PASSO 4. Consolidação de carteira continua muda (nem
 * pagamento nem ordem), e a venda pelo próprio protocolo continua saindo com o
 * número que sempre teve — nenhum portão novo engoliu o caminho feliz.
 */
const consolidacao = await vendasDaTx('0x3f835be8d379c73187cd3ae0e99a8fbdb95b655878940517c2baf0182849a169')
conf(consolidacao.length === 0, 'consolidação de carteira: ZERO anúncios', `${consolidacao.length}`)

const protocolo = await vendasDaTx('0x60b530b8e6ca949e1e6030e6290efa6eee59a9d489b664757a45a32b0ed7d452')
TUDO.push(...protocolo)
conf(protocolo.length === 1, 'venda pelo protocolo: um anúncio', `${protocolo.length}`)
conf(
  montaEmbed(protocolo[0], {}, 'Ronkeverse').fields[0].value === '**406.8 RON**',
  'venda pelo protocolo: #3973 continua 406,8',
  montaEmbed(protocolo[0], {}, 'Ronkeverse').fields[0].value,
)

/*
 * FIDELIDADE DE FORMATAÇÃO. 10% dos itens da amostra imprimiam número diferente
 * do real com 2 casas. O README já registra que arredondar quebrou a confiança do
 * canal uma vez (469,69 anunciado como 470); esta é a mesma classe de defeito uma
 * casa adiante.
 */
const fiel = await vendasDaTx('0x0bc1fb7c2ec6a2688590e3487e180c92178ec6cdce395d3ddbb3daf0d21b2f0b')
TUDO.push(...fiel)
const v2645 = fiel.find((v) => v.id === 2645)
conf(
  montaEmbed(v2645, {}, 'Ronkeverse').fields[0].value === '**269.676 RON**',
  '#2645 imprime 269.676, não 269.68',
  montaEmbed(v2645, {}, 'Ronkeverse').fields[0].value,
)
const varrida = await vendasDaTx('0xc568b5ba075433e46f2b448e937cee46e0adb7b82f17c3eef0fca23aaf3862b8')
conf(
  montaEmbed(varrida[0], {}, 'Ronkeverse').fields[3].value.includes('15,138.315 RON total'),
  'a varrida de 40 soma 15,138.315, não 15,138.32',
  montaEmbed(varrida[0], {}, 'Ronkeverse').fields[3].value,
)

/*
 * (A) PROVENIÊNCIA — a trava de longo prazo.
 *
 * Ela proíbe a ORIGEM do número, não a aparência da string: nenhum item pode ter
 * recebido preço do fallback (`pago`, o gasto da carteira na transação) enquanto
 * o comprador levou mais de um NFT. É o que impede alguém reintroduzir média ou
 * total-por-item daqui a seis meses achando que está melhorando o bot — e o que
 * mantém `fonte` sendo um campo com consequência, não um enfeite.
 */
const fallbacksEmLote = TUDO.filter((v) => v.fonte === 'fallback' && v.itensDoComprador !== 1)
conf(fallbacksEmLote.length === 0, 'proveniência: fallback só existe com 1 item por comprador', JSON.stringify(fallbacksEmLote.map((v) => v.id)))
conf(
  TUDO.every((v) => v.precoWei === null || v.fonte === 'ordem' || v.fonte === 'fallback'),
  'proveniência: todo número tem origem declarada',
)

/*
 * AS DUAS FRASES DE "SEM NÚMERO" — o texto é assersão, não descrição.
 *
 * Não há transação real que produza estes dois estados hoje (os 364 itens da
 * amostra decodificam), e é justamente por isso que eles precisam estar fixados
 * aqui: são o caminho de degradação que só vai rodar no dia em que a marketplace
 * mudar alguma coisa — o pior dia possível pra descobrir que o texto regrediu.
 *
 * O TOTAL SOME quando um item do grupo fica sem preço. Um subtotal chamado de
 * total é a mesma classe de defeito que este arquivo inteiro existe pra matar.
 */
const semPreco = {
  id: 4231,
  tx: LOTE,
  comprador: '0xabcd000000000000000000000000000000001234',
  vendedor: '0x9876000000000000000000000000000000004321',
  precoWei: null,
  motivo: 'sem-decodificador',
  moeda: null,
  marketplace: null,
  itensDoComprador: 4,
  posicao: 1,
  precificadosDoGrupo: 3,
  totalDoGrupoWei: null,
}
const embSemPreco = montaEmbed(semPreco, {}, 'Ronkeverse')
conf(
  embSemPreco.fields[0].value === 'price not published by this bot for this sale — open the transaction',
  'sem decodificador: o texto fala do BOT, não da marketplace',
  embSemPreco.fields[0].value,
)
conf(
  embSemPreco.fields[3].value === '1 of 4 Ronkeverse in this transaction · 3 of 4 priced',
  'lote parcialmente precificado: Batch sem total',
  embSemPreco.fields[3].value,
)
const embMoeda = montaEmbed({ ...semPreco, motivo: 'moeda' }, {}, 'Ronkeverse')
conf(
  embMoeda.fields[0].value === 'not shown — paid in a token this bot does not price — open the transaction',
  'moeda da ordem fora do par RON/WRON: texto próprio',
  embMoeda.fields[0].value,
)

/*
 * O 429 DO DISCORD NÃO PODE MAIS DESCARTAR O ANÚNCIO.
 *
 * Existe varrida de 40 NFTs numa transação e o ciclo posta os 40 em sequência no
 * mesmo webhook. Aqui a rede é dublada: o primeiro POST leva 429 com
 * `retry_after`, o segundo é aceito. Antes deste conserto a venda simplesmente
 * sumia — e sumia em silêncio, porque o ponteiro de blocos avançava do mesmo
 * jeito e não existe fila de repostagem.
 */
const fetchAntes = globalThis.fetch
let tentativas = 0
globalThis.fetch = async () => {
  tentativas++
  if (tentativas === 1) {
    return { status: 429, ok: false, json: async () => ({ retry_after: 0.01 }) }
  }
  return { status: 204, ok: true, text: async () => '' }
}
const saiu = await anuncia('https://discord.com/api/webhooks/1/x', vendaOk, m, 'Ronkeverse')
globalThis.fetch = fetchAntes
conf(saiu === true, '429: o anúncio é reenviado, não descartado')
conf(tentativas === 2, '429: exatamente uma retentativa', `${tentativas} POSTs`)

/*
 * A DEDUP DO MODO ARQUIVO SOBREVIVE AO `gravaBloco` DO MESMO CICLO.
 *
 * A versão anterior de `gravaBloco` escrevia `{ ultimoBloco: n }` inteiro, na
 * última linha do ciclo — apagando a lista de vistos que o laço de anúncio tinha
 * acabado de gravar. A dedup existia e era destruída antes de servir pra alguma
 * coisa; este teste é a única coisa que impede isso voltar.
 *
 * Salva e restaura o `.estado.json` de verdade: um teste não pode mexer no
 * ponteiro de blocos de quem estiver rodando o bot nesta máquina.
 */
const ARQ = new URL('./.estado.json', import.meta.url)
const { readFile, writeFile, unlink } = await import('node:fs/promises')
let antes = null
try {
  antes = await readFile(ARQ, 'utf8')
} catch {}
try {
  await writeFile(ARQ, JSON.stringify({ ultimoBloco: 100 }) + '\n')
  await marcaAnunciado('0xabc', 2985)
  await gravaBloco(101)
  conf(await jaAnunciado('0xabc', 2985), 'dedup em arquivo sobrevive ao gravaBloco do mesmo ciclo')
  conf(!(await jaAnunciado('0xabc', 2986)), 'dedup em arquivo não inventa item que não saiu')
  conf((await ultimoBloco()) === 101, 'o ponteiro continua sendo gravado', String(await ultimoBloco()))
} finally {
  if (antes === null) await unlink(ARQ).catch(() => {})
  else await writeFile(ARQ, antes)
}

console.log('\n  --- o que o Discord vai receber ---')
console.log(
  JSON.stringify(e, null, 2)
    .split('\n')
    .map((l) => '  ' + l)
    .join('\n'),
)

console.log(falhas ? `\n${falhas} FALHA(S)\n` : '\nTUDO OK\n')
process.exitCode = falhas ? 1 : 0
