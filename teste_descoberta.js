/**
 * PROVA DO DESCOBRIDOR — o elo que o `teste.js` não cobre.
 *
 *   node teste_descoberta.js
 *
 * `teste.js` prova o DECODIFICADOR: dada uma transação, tirar o preço certo.
 * Isso pressupõe que alguém entregou a transação. Quem entrega é `transferencias`,
 * varrendo blocos — e essa metade nunca tinha rodado com resultado não-vazio,
 * porque desde que o bot subiu não houve venda nenhuma.
 *
 * Aqui a varredura roda de verdade, nas faixas de bloco onde as vendas conhecidas
 * aconteceram. É o caminho completo (varrer -> achar -> reconhecer), só que
 * mirando o passado em vez de esperar o futuro.
 *
 * NÃO POSTA e NÃO grava ponteiro: só lê a cadeia.
 */
import { transferencias, detalheDaVenda } from './lib/ronin.js'

let falhas = 0
const conf = (cond, msg, extra = '') => {
  if (!cond) {
    falhas++
    console.error('  FALHOU  ' + msg + '  ' + extra)
  } else console.log('  ok      ' + msg + (extra ? '  ' + extra : ''))
}

// Bloco de cada venda conhecida, e o que a varredura tem que achar lá.
const CASOS = [
  { bloco: 59451867, id: 3369, preco: 420, onde: 'OpenSea' },
  { bloco: 59437640, id: 6886, preco: 375, onde: 'Ronin Market' },
  { bloco: 59448195, id: 5895, preco: 370, onde: 'Ronin Market' },
]

console.log('\nDESCOBRIDOR — varrer blocos e achar a venda\n')

for (const c of CASOS) {
  // Uma janela estreita em volta do bloco. Estreita de propósito: se eu pedisse
  // 200 blocos, achar a venda não provaria que a varredura mira certo.
  const achadas = await transferencias(c.bloco - 1, c.bloco + 1)
  const alvo = achadas.find((t) => t.id === c.id)

  conf(achadas.length > 0, `bloco ${c.bloco}: a varredura achou transferência`, `${achadas.length}`)
  if (!alvo) {
    falhas++
    console.error(`  FALHOU  #${c.id} não apareceu na varredura`)
    continue
  }

  const v = await detalheDaVenda(alvo)
  conf(v !== null, `#${c.id} reconhecida como venda`)
  if (v) {
    conf(v.preco === c.preco, `#${c.id} preço pelo caminho completo`, `${v.preco} RON`)
    conf(v.marketplace === c.onde, `#${c.id} marketplace`, String(v.marketplace))
  }
}

/*
 * E O SILÊNCIO TAMBÉM É RESPOSTA CERTA.
 *
 * Uma faixa sem venda nenhuma tem que devolver lista vazia sem erro. Parece
 * bobagem até lembrar que é o estado em que o bot passa 99% do tempo: se a
 * varredura estourasse com faixa vazia, ele quebraria a cada 5 minutos e só
 * seria notado quando uma venda fosse perdida.
 */
const vazio = await transferencias(59451900, 59451920)
conf(Array.isArray(vazio) && vazio.length === 0, 'faixa sem venda devolve vazio sem erro', `${vazio.length}`)

console.log(falhas ? `\n${falhas} FALHA(S)\n` : '\nTUDO OK\n')
process.exitCode = falhas ? 1 : 0
