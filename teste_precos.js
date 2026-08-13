/**
 * PROVA DO DECODIFICADOR DE PREÇO, sozinho — antes de plugar em qualquer coisa.
 *
 *   node teste_precos.js
 *
 * `teste.js` prova o caminho inteiro. Este aqui prova SÓ `lib/precos.js`, contra
 * recibos reais baixados do RPC, e existe pra que uma falha lá na frente seja
 * respondível: se algo quebrar no anúncio, foi decodificação ou foi plumbing?
 * Com este arquivo verde, é plumbing.
 *
 * Os números abaixo não são "o que eu acho que a ordem diz" — foram medidos
 * contra a cadeia, e em vários casos a soma dos itens fecha AO WEI com o
 * `tx.value` da transação, que é o único teste que pega decodificação
 * silenciosamente errada.
 *
 * NÃO POSTA e NÃO grava nada: só lê a cadeia.
 */
import { COLECAO, transacaoERecibo } from './lib/ronin.js'
import { ehRon, precosPorItem } from './lib/precos.js'
import { weiExato } from './lib/discord.js'

let falhas = 0
const conf = (cond, msg, extra = '') => {
  if (!cond) {
    falhas++
    console.error('  FALHOU  ' + msg + '  ' + extra)
  } else console.log('  ok      ' + msg + (extra ? '  ' + extra : ''))
}

/*
 * A rede é real na primeira chamada de cada recibo e memorizada nas seguintes —
 * o RPC público publica 100 requisições por minuto e este arquivo confere a mesma
 * transação por mais de um ângulo. Ver o mesmo envelope em `teste.js`.
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

/** RON legível -> wei, sem passar por float. "459.98" -> 459980000000000000000n */
const wei = (s) => {
  const [i, f = ''] = String(s).split('.')
  return BigInt(i + f.padEnd(18, '0').slice(0, 18))
}

const CASOS = [
  {
    tx: '0x50f41a12d49471d4a8e36286a5da99ee52987a2546997b66be0cbee58d014da9',
    nome: 'o lote do bug — 3 NFTs, um comprador',
    precos: { 2985: '4200', 2986: '941', 5086: '1250' },
    fechaComTxValue: true,
  },
  {
    tx: '0x15c15b7c298754f7e23f812fa58a4031c734a8ca9f99e347fa0cf540425bb493',
    nome: 'dois itens iguais pela Seaport',
    precos: { 2432: '459.98', 4707: '459.98' },
    fechaComTxValue: true,
  },
  {
    tx: '0xc568b5ba075433e46f2b448e937cee46e0adb7b82f17c3eef0fca23aaf3862b8',
    nome: 'a varrida de 40 numa transação só',
    itens: 40,
    soma: '15138.315',
    fechaComTxValue: true,
  },
  {
    // A moeda vem da ORDEM. O WETH aqui era só a perna de financiamento.
    tx: '0xd2bb0c2e6ab65813b43ace1430a6cede340c6bd7f58ae34bbdd9f6ea60403cb6',
    nome: 'sweep de 10 financiado em WETH — a ordem diz WRON',
    itens: 10,
    precos: { 1234: '437', 2515: '444', 6603: '435' },
    todosEmRon: true,
  },
  {
    tx: '0x8d2c45a1907f71eb77e97a5550809499f31362f26ad290c48cbd816ac6921e04',
    nome: 'dois a 437 — NUNCA os 103.608 $RONKE da carteira',
    precos: { 256: '437', 1709: '437' },
    todosEmRon: true,
  },
  {
    tx: '0x34f2fc2b35be33c0692adf9e83d9d6e6ce3a69c0a8b5dbdb2877b6abfb2244cd',
    nome: 'seis itens, financiados em USDC de 6 casas',
    itens: 6,
    precos: { 781: '414.99', 1942: '469.69' },
    todosEmRon: true,
  },
  {
    // A prova de que a média morreu: 4 ids numa ordem só, 120 CADA. O uint80 da
    // ordem é unitário — 480/4 daria o mesmo número por acidente, e é esse
    // acidente que não pode virar caminho de código.
    tx: '0xef9f07a41d0f0cbaddc9456bc796f12eb1c77e15152ddb91b3cf779df4416edb',
    nome: 'quatro tokenIds numa ordem só, 120 cada (não 480, não 480/4)',
    precos: { 2869: '120', 4276: '120', 6209: '120', 6273: '120' },
  },
  {
    tx: '0xf2119f71010fd77641c43d706bed1d501ab0920109f9ecc636c33cd3939cba0d',
    nome: 'a armadilha da parcela nativa zero',
    precos: { 650: '396' },
  },
  {
    tx: '0x60b530b8e6ca949e1e6030e6290efa6eee59a9d489b664757a45a32b0ed7d452',
    nome: 'venda pelo próprio protocolo (decoder 4)',
    precos: { 3973: '406.8' },
  },
  {
    tx: '0x7ceee5b8100471cc370bec2da337bea7d126c113a0b997d41e9d7a756c29bd6c',
    nome: 'entrega de escrow — preço certo, e MARCADA como custódia',
    precos: { 1548: '150', 1906: '150', 2657: '150' },
    custodia: true,
  },
  {
    tx: '0x3f835be8d379c73187cd3ae0e99a8fbdb95b655878940517c2baf0182849a169',
    nome: 'consolidação de carteira — 20 transferências, mapa VAZIO',
    itens: 0,
  },
]

console.log('\nPREÇO POR ITEM — o decodificador contra recibos reais\n')

for (const c of CASOS) {
  const { tx, rec } = await transacaoERecibo(c.tx)
  const { mapa, avisos } = precosPorItem(rec, COLECAO)

  conf(avisos.length === 0, `${c.nome}: nenhum aviso de checksum`, avisos.join(' | '))

  if (c.itens !== undefined) {
    conf(mapa.size === c.itens, `${c.nome}: ${c.itens} item(ns) no mapa`, `${mapa.size}`)
  }

  for (const [id, esperado] of Object.entries(c.precos || {})) {
    const e = mapa.get(Number(id))
    conf(e?.wei === wei(esperado), `${c.nome}: #${id}`, e ? weiExato(e.wei) : '(sem preço)')
    if (e && c.custodia) conf(e.custodia === true, `${c.nome}: #${id} marcado custódia`)
  }

  let soma = 0n
  for (const [, e] of mapa) soma += e.wei
  if (c.soma) conf(soma === wei(c.soma), `${c.nome}: soma`, weiExato(soma))

  /*
   * A ASSERÇÃO QUE PEGA ERRO SILENCIOSO. Nenhuma inspeção visual distingue um
   * preço plausível de um preço certo; a soma fechar AO WEI com o que a
   * transação de fato movimentou, sim. Em BigInt — em Number a varrida de 40
   * imprime 15138.314999999999.
   */
  if (c.fechaComTxValue) {
    conf(soma === BigInt(tx.value), `${c.nome}: soma dos itens == tx.value`, weiExato(soma))
  }

  if (c.todosEmRon) {
    const todos = [...mapa.values()].every((e) => ehRon(e.moeda))
    conf(todos, `${c.nome}: paymentToken da ordem é WRON/nativo em todos`)
  }
}

/*
 * OS DOIS CASOS DE PREÇO DECRESCENTE — a prova de que o checksum novo não voltou
 * a ser o antigo.
 *
 * Não são Ronkeverse, e é de propósito: o que importa aqui é que o decodificador
 * ACEITE o log. O checksum antigo exigia `soma === basePrice`, e nestas duas
 * ordens `basePrice` é o preço INICIAL de uma listagem decrescente (44x o
 * executado na primeira). Se este teste falhar, o bot voltou a descartar venda
 * legível e a gritar falso alarme de upgrade do proxy.
 */
const DECRESCENTES = [
  {
    tx: '0xe697bebe15f974e0f58a0b2fe7d10238129a300264353377b4f5204b91b0998e',
    colecao: '0x32950db2a7164ae833121501c797d79e7b79d74c',
    id: 11365704,
    wei: 450000000000000n,
  },
  {
    tx: '0x13bccf995797b6a5b328b39ba870c95d55df9441c69cceba04f4301487bdd689',
    colecao: '0x32950db2a7164ae833121501c797d79e7b79d74c',
    id: 11424573,
    wei: 14122276785714286n,
  },
]

for (const d of DECRESCENTES) {
  const { rec } = await transacaoERecibo(d.tx)
  const { mapa, avisos } = precosPorItem(rec, d.colecao)
  conf(avisos.length === 0, `preço decrescente ${d.tx.slice(0, 10)}: decodifica sem erro`, avisos.join(' | '))
  conf(mapa.get(d.id)?.wei === d.wei, `preço decrescente ${d.tx.slice(0, 10)}: soma == preço do taker`, String(mapa.get(d.id)?.wei))
}

/*
 * DEGRADAÇÃO É POR ITEM, NUNCA POR TRANSAÇÃO.
 *
 * Um upgrade do proxy tem que APAGAR um número, nunca inventar outro nem derrubar
 * os vizinhos. Aqui o log do #2985 é corrompido de três jeitos diferentes e nos
 * três o #2986 e o #5086 têm que continuar saindo 941 e 1.250 certos.
 */
const ORDER_MATCHED = '0x109cee1a21fd2e7fba88adb0c288672b657beb8b4f5e36ea950cbebf8a901b6d'
const { rec: recLote } = await transacaoERecibo(CASOS[0].tx)

const troca = (rec, i, f) => {
  const copia = JSON.parse(JSON.stringify(rec))
  const alvos = copia.logs.filter((l) => l.topics[0] === ORDER_MATCHED)
  alvos[i].data = f(alvos[i].data)
  return copia
}
const SABOTAGENS = [
  ['valor de repasse trocado', (d) => d.slice(0, -64) + '0'.repeat(63) + '1'],
  ['ponteiro trocado', (d) => '0x' + 'f'.repeat(64) + d.slice(66)],
  ['data truncado', (d) => d.slice(0, d.length - 640)],
]
for (const [nome, sabota] of SABOTAGENS) {
  const { mapa, avisos } = precosPorItem(troca(recLote, 0, sabota), COLECAO)
  conf(!mapa.has(2985), `sabotagem (${nome}): #2985 sai SEM número`)
  conf(mapa.get(2986)?.wei === wei('941'), `sabotagem (${nome}): #2986 continua 941`)
  conf(mapa.get(5086)?.wei === wei('1250'), `sabotagem (${nome}): #5086 continua 1250`)
  conf(avisos.length > 0, `sabotagem (${nome}): vira aviso, não silêncio`, avisos[0] || '')
}

console.log(falhas ? `\n${falhas} FALHA(S)\n` : '\nTUDO OK\n')
process.exitCode = falhas ? 1 : 0
