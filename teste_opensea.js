/**
 * PROVA DOS LISTINGS DO OPENSEA
 *
 *   node --env-file-if-exists=.env teste_opensea.js
 *
 * Quase tudo sem rede: eventos copiados da resposta real de 28/09/2026, Redis
 * e Discord de mentira. O que se prova é a REGRA — qual evento vira anúncio,
 * como a relistagem é barrada, o piso próprio do OpenSea, e o que acontece
 * quando o listing já saiu do ar. A última seção pergunta à API de verdade,
 * mas só se houver chave guardada (ela NÃO emite chave nova).
 */
import { montaEmbedDeListing } from './lib/discord.js'
import { criaPassadaDeListings, ehRelistagem } from './lib/listings.js'
import {
  chaveOpenSea,
  escolheFloorOpenSea,
  eventoValido,
  listingAindaAtivo,
  melhoresListingsOpenSea,
  normalizaEvento,
  ultimosListingsOpenSea,
} from './lib/opensea.js'

let falhas = 0
const conf = (cond, msg, extra = '') => {
  if (!cond) {
    falhas++
    console.error('  FALHOU  ' + msg + '  ' + extra)
  } else console.log('  ok      ' + msg + (extra ? '  ' + extra : ''))
}

const RON = 10n ** 18n
const COLECAO = '0x810b6d1374ac7ba0e83612e7d49f49a13f1de019'
const AGORA = 1790610000 // 28/09/2026, depois dos eventos abaixo

/* Evento REAL de 28/09 (#3232, 800 RON), sem os campos que o bot não lê. */
const EVENTO = {
  event_type: 'order',
  event_timestamp: 1790602783,
  order_hash: '0x49b240e31e731c3ec2869dbfb6cb076e9cd572a558a55a142d339d58a31c95bd',
  protocol_address: '0x0000000000000068f116a894984e2db1123eb395',
  chain: 'ronin',
  payment: { quantity: '800000000000000000000', token_address: '0x0000000000000000000000000000000000000000', decimals: 18, symbol: 'RON' },
  order_type: 'listing',
  start_date: 1790602775,
  expiration_date: 1798378775,
  quantity: 1,
  maker: '0x0dc5e2954183730c67f3f5d48bd9c9b6b7e5d71f',
  taker: '',
  criteria: null,
  is_private_listing: false,
  asset: {
    identifier: '3232',
    name: 'Ronkeverse #3232',
    contract: COLECAO,
    collection: 'ronkeverse',
    opensea_url: `https://opensea.io/assets/ronin/${COLECAO}/3232`,
    image_url: 'https://i2c.seadn.io/ronin/0x810b6d1374ac7ba0e83612e7d49f49a13f1de019/7536e11f2e9c279411f3b6e62cae79/f77536e11f2e9c279411f3b6e62cae79.png',
    is_disabled: false,
  },
}

console.log('\nQUAL EVENTO VIRA ANÚNCIO\n')
{
  conf(eventoValido(EVENTO, AGORA), 'o evento real de 28/09 passa')
  const com = (mudanca) => eventoValido({ ...EVENTO, ...mudanca }, AGORA)
  const comAsset = (mudanca) => eventoValido({ ...EVENTO, asset: { ...EVENTO.asset, ...mudanca } }, AGORA)
  conf(!com({ is_private_listing: true }), 'listing privado (pra um comprador só): fora')
  conf(!com({ order_type: 'offer' }), 'oferta não é listing: fora')
  conf(!com({ protocol_address: '0x' + '9'.repeat(40) }), 'outro protocolo (não é ordem do OpenSea): fora')
  conf(!com({ chain: 'ethereum' }), 'outra rede: fora')
  conf(!com({ quantity: 2 }), 'mais de um item: fora')
  conf(!com({ expiration_date: AGORA - 1 }), 'já vencido quando o bot viu: fora')
  conf(!com({ payment: { ...EVENTO.payment, quantity: 'abc' } }), 'preço torto: fora')
  conf(!comAsset({ contract: '0x' + '1'.repeat(40) }), 'outra coleção: fora')
  conf(!comAsset({ is_disabled: true }), 'item desativado no OpenSea: fora')
  conf(!eventoValido(null, AGORA) && !eventoValido({}, AGORA), 'evento vazio: fora, sem quebrar')

  const l = normalizaEvento(EVENTO)
  conf(l.marketplace === 'OpenSea' && l.ordem === 'os:' + EVENTO.order_hash, 'marcado como OpenSea, ordem com prefixo', l.ordem.slice(0, 14))
  conf(l.id === '3232' && l.nome === 'Ronkeverse #3232', 'id e nome do item')
  conf(l.vendedor === EVENTO.maker && l.precoWei === 800n * RON && l.moeda === 'RON', 'vendedor e preço (800 RON, fiel até o wei)')
  conf(l.inicio === 1790602783 && l.expira === 1798378775, 'hora do listing e expiração')
  conf(l.link === EVENTO.asset.opensea_url && l.imagem === EVENTO.asset.image_url, 'link e imagem do próprio OpenSea')
  const wron = normalizaEvento({ ...EVENTO, payment: { ...EVENTO.payment, token_address: '0xE514D9DEB7966C8BE0CA922DE8A064264EA6BCD4', symbol: 'WRON' } })
  conf(wron.moeda === 'RON', 'WRON também é RON (em qualquer caixa)')
  const outra = normalizaEvento({ ...EVENTO, payment: { ...EVENTO.payment, token_address: '0x' + '3'.repeat(40), symbol: 'USDC', decimals: 6 } })
  conf(outra.moeda === null, 'moeda desconhecida: null, sem chute de casas decimais')
}

console.log('\nFLOOR DO OPENSEA — sem os próprios itens\n')
{
  const L = (id, ron, extra = {}) => ({
    status: 'ACTIVE',
    price: { current: { currency: 'RON', decimals: 18, value: String(ron * RON) } },
    protocol_data: { parameters: { endTime: String(AGORA + 86400), offer: [{ token: COLECAO, identifierOrCriteria: String(id) }] } },
    ...extra,
  })
  // Os três mais baratos de 28/09, na ordem da API.
  const reais = [L(5047, 650n), L(1212, 650n), L(1871, 700n)]
  conf(escolheFloorOpenSea(reais, [], AGORA).id === '5047', 'o mais barato')
  conf(escolheFloorOpenSea(reais, ['5047'], AGORA).id === '1212', 'o próprio item fica de fora')
  conf(escolheFloorOpenSea([L(9, 500n, { status: 'INACTIVE' }), ...reais], [], AGORA).id === '5047', 'listing inativo é pulado')
  const vencido = L(9, 500n)
  vencido.protocol_data.parameters.endTime = String(AGORA - 1)
  conf(escolheFloorOpenSea([vencido, ...reais], [], AGORA).id === '5047', 'listing vencido é pulado')
  const usdc = L(9, 5n)
  usdc.price.current = { currency: 'USDC', decimals: 6, value: '5000000' }
  conf(escolheFloorOpenSea([usdc, ...reais], [], AGORA).id === '5047', 'listing em outra moeda é pulado')
  conf(escolheFloorOpenSea([], [], AGORA) === null && escolheFloorOpenSea(null, [], AGORA) === null, 'sem listing: null')
}

console.log('\nRELISTAGEM — a regra\n')
{
  const l = (ron, moeda = 'RON') => ({ precoWei: ron, moeda })
  conf(ehRelistagem(l(58998n * RON / 100n), null) === false, 'nunca anunciado: sai')
  conf(ehRelistagem(l(58998n * RON / 100n), 58998n * RON / 100n) === true, 'mesmo preço: relistagem (o robô de 28/09)')
  conf(ehRelistagem(l(58997n * RON / 100n), 58998n * RON / 100n) === true, '0,01 RON mais barato: ainda relistagem')
  conf(ehRelistagem(l(600n * RON), 58998n * RON / 100n) === true, 'mais caro: relistagem (não é notícia pra quem compra)')
  conf(ehRelistagem(l(580n * RON), 590n * RON) === true, 'queda de 1,7%: relistagem')
  conf(ehRelistagem(l(578n * RON), 590n * RON) === false, 'queda de 2%+: SAI (é baixa de preço de verdade)')
  conf(ehRelistagem(l(5n * RON, null), 590n * RON) === true, 'moeda que o bot não compara, já anunciado: não sai de novo')
}

/* Redis de mentira: marca por ordem, piso, e a régua de preço por NFT+vendedor. */
function redisDeMentira({ inicio = null } = {}) {
  const s = { inicio, ordens: new Map(), precos: new Map() }
  s.estado = {
    jaAnunciado: async (o) => s.ordens.has(o),
    marca: async (o, exp) => void s.ordens.set(o, exp),
    inicio: async () => s.inicio,
    marcaInicio: async (ms) => void (s.inicio = ms),
    precoAnunciado: async (id, v) => s.precos.get(`${id}|${v}`) ?? null,
    guardaPreco: async (id, v, w) => void s.precos.set(`${id}|${v}`, w),
  }
  return s
}

/* Discord de mentira: grava o que saiu. */
function discordDeMentira() {
  const d = { mensagens: [] }
  d.anuncia = async (webhook, novos) => {
    d.mensagens.push(...novos.map((l) => `${l.id}@${l.precoWei / 10n ** 16n}`))
    return { aceitos: novos.map(() => true), destinos: 1 }
  }
  return d
}

const ROBO = '0xcfb424000000000000000000000000000000e83e'
const PISO = (AGORA - 3600) * 1000
/* Um listing do OpenSea no formato normalizado; a hora cresce com o número. */
const OS = (n, id, ron, vendedor = ROBO) => ({
  marketplace: 'OpenSea',
  ordem: `os:0x${String(n).padStart(64, '0')}`,
  hash: `0x${String(n).padStart(64, '0')}`,
  id: String(id),
  nome: `Ronkeverse #${id}`,
  vendedor,
  precoWei: ron,
  baseWei: ron,
  finalWei: null,
  moeda: 'RON',
  inicio: AGORA - 3000 + n,
  expira: AGORA + 2220,
  imagem: null,
  link: `https://opensea.io/assets/ronin/${COLECAO}/${id}`,
})
const passadaCom = (red, dis, janela, extra = {}) =>
  criaPassadaDeListings({
    busca: async () => janela(),
    estado: red.estado,
    anuncia: dis.anuncia,
    nomeColecao: async () => 'Ronkeverse',
    temEstado: true,
    relogio: () => AGORA * 1000,
    enriquece: async (novos) => novos.map(() => ({})),
    ...extra,
  })

console.log('\nA PASSADA — o robô que relista a cada 37 minutos\n')
{
  const red = redisDeMentira({ inicio: PISO })
  const dis = discordDeMentira()
  const P = 58998n * RON / 100n
  let janela = [OS(1, 3275, P)]
  let passada = passadaCom(red, dis, () => [...janela].reverse())
  let r = await passada({ webhook: 'w' })
  conf(r.anunciados === 1 && dis.mensagens.join() === '3275@58998', 'primeiro listing do NFT: sai', dis.mensagens.join())

  // 37 min depois: o mesmo NFT, o mesmo preço, ordem nova.
  janela = [OS(1, 3275, P), OS(2, 3275, P)]
  r = await passada({ webhook: 'w' })
  conf(r.novos === 0 && r.relistagens === 1 && dis.mensagens.length === 1, 'relist no mesmo preço: ignorado', JSON.stringify(r))
  conf(red.ordens.has(OS(2, 3275, P).ordem), 'e marcado: não é reavaliado a cada minuto')

  // Processo novo (restart): a régua mora no Redis, não na memória.
  passada = passadaCom(red, dis, () => [...janela].reverse())
  janela = [OS(1, 3275, P), OS(2, 3275, P), OS(3, 3275, P)]
  r = await passada({ webhook: 'w' })
  conf(r.relistagens === 1 && dis.mensagens.length === 1, 'depois de reiniciar, o relist continua barrado')

  // Duas relistagens na mesma passada (a janela trouxe as duas de uma vez): fica a mais nova.
  const red2 = redisDeMentira({ inicio: PISO })
  const dis2 = discordDeMentira()
  const duas = [OS(10, 2058, P), OS(11, 2058, P)]
  r = await passadaCom(red2, dis2, () => [...duas].reverse())({ webhook: 'w' })
  conf(r.anunciados === 1 && r.relistagens === 1 && dis2.mensagens.length === 1, 'duas ordens do mesmo NFT na mesma passada: sai uma', JSON.stringify(r))

  // Baixa de preço de verdade (-2%+): sai de novo.
  janela = [OS(1, 3275, P), OS(2, 3275, P), OS(3, 3275, P), OS(4, 3275, 575n * RON)]
  r = await passada({ webhook: 'w' })
  conf(r.anunciados === 1 && dis.mensagens[1] === '3275@57500', 'baixa de 2,5%: sai', dis.mensagens.join(' '))
  conf(red.precos.get(`3275|${ROBO}`) === 575n * RON, 'e a régua passa a ser o preço novo')
}

console.log('\nA PASSADA — o mesmo NFT nas duas marketplaces\n')
{
  // A régua é compartilhada: a Ronin Market já anunciou o #5047 a 567,99.
  const DONO = '0x028361000000000000000000000000000000abcd'
  const red = redisDeMentira({ inicio: PISO })
  red.precos.set(`5047|${DONO}`, 56799n * RON / 100n)
  const dis = discordDeMentira()
  let janela = [OS(20, 5047, 64999n * RON / 100n, DONO)]
  const passada = passadaCom(red, dis, () => [...janela].reverse())
  let r = await passada({ webhook: 'w' })
  conf(r.relistagens === 1 && dis.mensagens.length === 0, 'mais caro no OpenSea do que já saiu da Ronin Market: não sai (medido em 28/09: 649,99 x 567,99)')
  janela = [OS(20, 5047, 64999n * RON / 100n, DONO), OS(21, 5047, 540n * RON, DONO)]
  r = await passada({ webhook: 'w' })
  conf(r.anunciados === 1 && dis.mensagens[0] === '5047@54000', 'mais barato no OpenSea: sai', dis.mensagens.join())
}

console.log('\nA PASSADA — listing que saiu do ar antes de ser postado\n')
{
  const red = redisDeMentira({ inicio: PISO })
  const dis = discordDeMentira()
  const vivos = new Set()
  let apiFora = false
  const confirma = async (l) => {
    if (apiFora) throw new Error('OpenSea fora')
    return vivos.has(l.ordem)
  }
  const janela = [OS(30, 777, 700n * RON, '0x' + 'a'.repeat(40)), OS(31, 888, 710n * RON, '0x' + 'b'.repeat(40))]
  vivos.add(janela[1].ordem)
  const passada = passadaCom(red, dis, () => [...janela].reverse(), { confirma })
  let r = await passada({ webhook: 'w' })
  conf(r.inativos === 1 && r.anunciados === 1 && dis.mensagens.join() === '888@71000', 'vencido/cancelado: não sai; o ativo sai', JSON.stringify(r))
  conf(red.ordens.has(janela[0].ordem), 'o que saiu do ar fica marcado')

  const red2 = redisDeMentira({ inicio: PISO })
  const dis2 = discordDeMentira()
  const p2 = passadaCom(red2, dis2, () => [OS(40, 999, 720n * RON, '0x' + 'c'.repeat(40))], { confirma })
  apiFora = true
  r = await p2({ webhook: 'w' })
  conf(r.novos === 0 && dis2.mensagens.length === 0 && red2.ordens.size === 0, 'API fora na confirmação: não posta e NÃO marca')
  apiFora = false
  vivos.add(OS(40, 999, 720n * RON).ordem)
  r = await p2({ webhook: 'w' })
  conf(r.anunciados === 1 && dis2.mensagens.join() === '999@72000', 'API de volta: sai na passada seguinte')
}

console.log('\nA PASSADA — o piso próprio do OpenSea\n')
{
  const red = redisDeMentira({ inicio: null })
  const dis = discordDeMentira()
  const janela = [OS(50, 111, 700n * RON), OS(51, 222, 710n * RON, '0x' + 'd'.repeat(40))]
  const passada = passadaCom(red, dis, () => [...janela].reverse())
  const r = await passada({ webhook: 'w' })
  conf(r.semeados === 2 && dis.mensagens.length === 0 && red.inicio === AGORA * 1000, 'primeira passada do OpenSea: marca o início e NÃO posta nada', JSON.stringify(r))
}

console.log('\nA MENSAGEM\n')
{
  const e = montaEmbedDeListing(normalizaEvento(EVENTO), 'Ronkeverse')
  conf(e.footer.text === 'Ronin · OpenSea', 'rodapé: Ronin · OpenSea', e.footer.text)
  conf(e.url === EVENTO.asset.opensea_url, 'título leva pro item no OpenSea')
  conf(e.fields[0].value === '**800 RON**', 'preço', e.fields[0].value)
  const rm = montaEmbedDeListing({ ...normalizaEvento(EVENTO), marketplace: undefined }, 'Ronkeverse')
  conf(rm.footer.text === 'Ronin · Ronin Market', 'listing sem marketplace (a Ronin Market): rodapé de sempre')
}

console.log('\nA API DE VERDADE\n')
{
  let chave = null
  try {
    chave = await chaveOpenSea() // só lê a guardada; nunca emite
  } catch {}
  if (!chave) {
    console.log('  (pulado: sem chave guardada -- rode com o .env do bot: node --env-file-if-exists=.env teste_opensea.js)')
  } else {
    const ls = await ultimosListingsOpenSea(50, chave)
    conf(Array.isArray(ls), 'a consulta de eventos responde', `${ls.length} listing(s) de pé na janela`)
    conf(ls.every((l) => l.ordem.startsWith('os:0x') && /^\d+$/.test(l.id) && l.precoWei > 0n), 'todos no formato do bot')
    if (ls[0]) conf(await listingAindaAtivo(ls[0], chave), `o mais novo (#${ls[0].id}) confirma como ativo`)
    const floor = escolheFloorOpenSea(await melhoresListingsOpenSea(5, chave))
    conf(floor && floor.precoWei > 0n, 'floor do OpenSea', floor ? `${floor.precoWei / RON} RON (#${floor.id})` : 'nulo')
  }
}

console.log(falhas ? `\n${falhas} FALHA(S)\n` : '\ntudo certo\n')
process.exitCode = falhas ? 1 : 0
