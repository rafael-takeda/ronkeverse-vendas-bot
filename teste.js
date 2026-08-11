/**
 * PROVA DA DETECÇÃO — contra vendas reais, não contra o que eu acho.
 *
 *   node teste.js
 *
 * As três transações abaixo foram vendas de verdade do Ronkeverse, uma pela
 * OpenSea e duas pela Ronin Marketplace. Elas existem aqui porque a regra do
 * bot ("o preço é tudo que saiu da carteira do comprador") só vale se reproduzir
 * os números que essas transações já registraram na cadeia.
 *
 * Se um dia alguma marketplace mudar o jeito de liquidar, é aqui que aparece.
 */
import { detalheDaVenda, metadados } from './lib/ronin.js'
import { montaEmbed } from './lib/discord.js'

let falhas = 0
const conf = (cond, msg, extra = '') => {
  if (!cond) {
    falhas++
    console.error('  FALHOU  ' + msg + '  ' + extra)
  } else console.log('  ok      ' + msg + (extra ? '  ' + extra : ''))
}

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
  const v = await detalheDaVenda({ tx: c.tx, id: c.id, de: c.de, para: c.para, bloco: 0 })
  if (!v) {
    falhas++
    console.error(`  FALHOU  #${c.id} não foi reconhecida como venda`)
    continue
  }
  conf(v.preco === c.preco, `#${c.id} preço`, `${v.preco} ${v.moeda} (esperado ${c.preco})`)
  conf(v.marketplace === c.onde, `#${c.id} marketplace`, `${v.marketplace}`)
  conf(v.comprador === c.para, `#${c.id} comprador`, v.comprador.slice(0, 12) + '..')
  conf(v.vendedor === c.de, `#${c.id} vendedor`, v.vendedor.slice(0, 12) + '..')
}

/*
 * O CONTRA-EXEMPLO É METADE DO TESTE.
 *
 * Sem ele, um bug que devolvesse "venda" pra qualquer transferência passaria em
 * todos os casos acima e só apareceria no canal do Discord, anunciando venda
 * onde ninguém pagou nada. Aqui a transação é real e o comprador é FALSO — como
 * nada saiu da carteira dele, a resposta certa é null.
 */
const falso = await detalheDaVenda({
  tx: CASOS[0].tx,
  id: 3369,
  de: CASOS[0].de,
  para: '0x000000000000000000000000000000000000dead',
  bloco: 0,
})
conf(falso === null, 'quem não pagou nada não é comprador', String(falso))

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
const vendaOk = await detalheDaVenda({
  tx: CASOS[0].tx,
  id: 3369,
  de: CASOS[0].de,
  para: CASOS[0].para,
  bloco: 0,
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

console.log('\n  --- o que o Discord vai receber ---')
console.log(
  JSON.stringify(e, null, 2)
    .split('\n')
    .map((l) => '  ' + l)
    .join('\n'),
)

console.log(falhas ? `\n${falhas} FALHA(S)\n` : '\nTUDO OK\n')
process.exitCode = falhas ? 1 : 0
