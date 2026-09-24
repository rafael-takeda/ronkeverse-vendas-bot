/**
 * PROVA DO CONTEXTO DE MERCADO — floor, dólar, quanto o vendedor pagou, nome,
 * Ronke Score e raridade.
 *
 *   node teste_mercado.js
 *
 * Três partes, nesta ordem e por um motivo:
 *   1. REGRAS, sem rede, sobre dados copiados das respostas reais de 24/09/2026.
 *   2. AS DUAS APIS DE VERDADE — nenhuma das duas é nossa, e o dia em que o
 *      formato mudar tem que aparecer aqui antes de aparecer no canal.
 *   3. FALHA — por último porque derruba o disjuntor das fontes, e depois dele
 *      a parte 2 não teria mais rede pra perguntar.
 */
import { montaEmbed, montaEmbedDeListing, variacao } from './lib/discord.js'
import {
  RONKESTRATEGY,
  compraDoVendedor,
  cotacaoValida,
  contextoDoCiclo,
  escolheFloor,
  extrasDaVenda,
  extrasDosListings,
  nomesRon,
  nomeApresentavel,
  nomeDoEndereco,
  resumoDeRaridade,
  resumoDeScore,
} from './lib/mercado.js'
import { ultimosListings } from './lib/listings.js'

let falhas = 0
const conf = (cond, msg, extra = '') => {
  if (!cond) {
    falhas++
    console.error('  FALHOU  ' + msg + '  ' + extra)
  } else console.log('  ok      ' + msg + (extra ? '  ' + extra : ''))
}

const RON = 10n ** 18n
const WRON = '0xe514d9deb7966c8be0ca922de8a064264ea6bcd4'
const MARCUS = '0x871fa8049a2732bf02da42818247edbd3f897886'
const DEMETER = '0xa7e93f0000000000000000000000000000c0242c'
const BD93 = '0xbd937cdaacb1a7854e1bbd01f6704a4009c4afb6'

/* ============================================================================
   1. REGRAS
   ============================================================================ */

console.log('\nFLOOR — o mais barato em RON que não é o próprio item\n')
{
  // Os três mais baratos de 24/09, na ordem da GraphQL.
  const res = [
    { tokenId: '4345', order: { currentPrice: String(563n * RON), paymentToken: WRON } },
    { tokenId: '2062', order: { currentPrice: String(56399n * RON / 100n), paymentToken: WRON } },
    { tokenId: '2973', order: { currentPrice: String(564n * RON), paymentToken: WRON } },
  ]
  conf(escolheFloor(res).id === '4345', 'sem exclusão: o primeiro')
  conf(escolheFloor(res, ['4345']).id === '2062', 'o próprio listing é pulado -- senão todo listing barato sairia "+0%"')
  conf(escolheFloor(res, ['4345', '2062']).precoWei === 564n * RON, 'a leva inteira fica de fora')
  const outra = [{ tokenId: '1', order: { currentPrice: '5', paymentToken: '0x' + '1'.repeat(40) } }, ...res]
  conf(escolheFloor(outra).id === '4345', 'ordem em outra moeda é pulada: preço de moedas diferentes não se compara')
  conf(escolheFloor([]) === null && escolheFloor(null) === null, 'sem listing: null, nada inventado')
}

console.log('\nQUANTO O VENDEDOR PAGOU — só se a compra mais recente foi DELE\n')
{
  // #5314, 24/09: o dono atual (marcussanders) comprou por 600 em 21/09.
  const h5314 = [{ timestamp: 1789985000, withPrice: String(600n * RON), paymentToken: WRON, to: MARCUS, txHash: '0x5855' }]
  const p = compraDoVendedor(h5314, MARCUS)
  conf(p && p.precoWei === 600n * RON && p.quando === 1789985000, '#5314: 600 RON, com data', JSON.stringify(p, (k, v) => (typeof v === 'bigint' ? String(v) : v)))
  conf(compraDoVendedor(h5314, MARCUS.toUpperCase().replace('0X', '0x')) !== null, 'endereço em caixa mista ainda casa')

  // #4345, 24/09: a entrada mais recente é alguém VENDENDO PRO RONKESTRATEGY
  // por 429. O Demeter comprou do protocolo depois, fora do histórico. Foi
  // exatamente esse número que quase saiu no canal como sendo dele.
  const h4345 = [{ timestamp: 1788232000, withPrice: String(429n * RON), paymentToken: WRON, to: RONKESTRATEGY, txHash: '0x794c' }]
  conf(compraDoVendedor(h4345, DEMETER) === null, '#4345: a última compra é de OUTRA carteira -> nada (não o preço dela)')
  conf(compraDoVendedor(h4345, RONKESTRATEGY).precoWei === 429n * RON, 'a mesma entrada, com o protocolo vendendo: 429 é o que ELE pagou')

  // Venda que a GraphQL já indexou: ela é a mais recente e tem que ser pulada.
  const hVenda = [
    { timestamp: 1790200000, withPrice: String(700n * RON), paymentToken: WRON, to: BD93, txHash: '0xAAAA' },
    { timestamp: 1789985000, withPrice: String(600n * RON), paymentToken: WRON, to: MARCUS, txHash: '0x5855' },
  ]
  conf(compraDoVendedor(hVenda, MARCUS, '0xaaaa').precoWei === 600n * RON, 'venda já indexada: pula ela e acha a compra de antes')
  conf(compraDoVendedor(hVenda, MARCUS) === null, 'sem saber qual é a venda atual, não chuta')

  const velho = [{ timestamp: 0, withPrice: String(71n * RON), paymentToken: WRON, to: MARCUS, txHash: '0x72a4' }]
  const pv = compraDoVendedor(velho, MARCUS)
  conf(pv.precoWei === 71n * RON && pv.quando === null, 'entrada antiga (timestamp 0): preço sim, data não')
  conf(compraDoVendedor([{ ...h5314[0], paymentToken: '0x' + '2'.repeat(40) }], MARCUS) === null, 'compra em outra moeda: nada -- não sai "0,12 RON"')
  conf(compraDoVendedor([{ ...h5314[0], withPrice: '0' }], MARCUS) === null, 'sem preço (transferência): nada')
  conf(compraDoVendedor(h5314, null) === null && compraDoVendedor([], MARCUS) === null, 'sem vendedor ou sem histórico: nada')
}

console.log('\nNOME DE PERFIL — texto de qualquer um, publicado com a cara do bot\n')
{
  conf(nomeApresentavel('Demeter') === 'Demeter', 'nome escolhido passa')
  conf(nomeApresentavel('Bryan ⚡️') === 'Bryan ⚡️', 'emoji passa')
  conf(nomeApresentavel('Lunacian #24') === null, 'nome padrão ("Lunacian #N") não diz nada: fica só o endereço')
  conf(nomeApresentavel('Lunacian #26283904') === null, 'nome padrão com número grande também')
  conf(nomeApresentavel('[free airdrop](https://golpe.xyz)') === null, 'link mascarado: descartado inteiro')
  conf(nomeApresentavel('claim at discord.gg/abc') === null, 'convite de Discord: descartado')
  conf(nomeApresentavel('ronke-drop.com') === null, 'domínio: descartado')
  conf(nomeApresentavel('@everyone look') === null, 'menção em massa: descartada')
  conf(nomeApresentavel('𝓓𝓮𝓶𝓮𝓽𝓮𝓻') === 'Demeter', 'letra "estilizada" vira letra comum (NFKC)')
  conf(nomeApresentavel('abc\u202Edcba') === 'abcdcba', 'caractere que inverte a direção do texto some')
  conf([...nomeApresentavel('x'.repeat(50))].length === 32 && nomeApresentavel('x'.repeat(50)).endsWith('…'), 'nome enorme: 32 caracteres, com reticências')
  conf(nomeApresentavel(null) === null && nomeApresentavel('   ') === null, 'vazio: null')
  conf(nomeDoEndereco(RONKESTRATEGY, 'qualquer') === 'RonkeStrategy', 'rótulo conhecido vence o perfil')
  conf(nomeDoEndereco(MARCUS, 'marcussanders') === 'marcussanders', 'sem rótulo, vale o perfil')
  conf(nomeDoEndereco(MARCUS, 'marcussanders', 'marcus.ron') === 'marcussanders', 'nome da marketplace vence o .ron')
  conf(nomeDoEndereco(MARCUS, null, 'marcus.ron') === 'marcus.ron', 'sem perfil: vale o .ron')
  conf(nomeDoEndereco(MARCUS, 'Lunacian #24', 'marcus.ron') === 'marcus.ron', 'perfil com nome padrão: vale o .ron')
  conf(nomeDoEndereco(RONKESTRATEGY, null, 'outro.ron') === 'RonkeStrategy', 'rótulo vence até o .ron')
  conf(nomeDoEndereco(MARCUS, null, 'https://golpe.xyz') === null, 'o .ron passa pelo mesmo filtro')
}

console.log('\nRARIDADE E RONKE SCORE — o que a API diz, sem inventar\n')
{
  const r = resumoDeRaridade({
    rarity_rank: 4722,
    tier: 'standard',
    traits: [
      { trait_type: 'Body', value: 'The Ronke Tattoo', probability: 0.05 },
      { trait_type: 'Hair - Headwear', value: 'Ronin Helmet', probability: 0.0076 },
    ],
  })
  conf(r.rank === 4722 && r.traco.valor === 'Ronin Helmet' && r.traco.prob === 0.0076, '#6857: rank 4722, traço mais raro Ronin Helmet')
  const um = resumoDeRaridade({ rarity_rank: null, tier: 'community_1of1', traits: [] })
  conf(um.rank === null && um.tier === 'community_1of1' && um.traco === null, '1/1: tier, SEM rank inventado (a API os deixa fora da escada)')
  conf(resumoDeRaridade({ rarity_rank: null, tier: 'standard' }) === null, 'standard sem rank: nada')
  conf(resumoDeRaridade(null) === null, 'sem resposta: nada')
  conf(resumoDeScore({ found: false, score: 0, rank: null }) === null, 'carteira sem score (found:false) é "sem pontuação", não erro')
  const s = resumoDeScore({ found: true, score: 7008, rank: 2, percentile: 99.97 })
  conf(s.rank === 2 && s.pontos === 7008, 'o #2 do ranking (vendedor do #6857)')
}

console.log('\nCOTAÇÃO — só vale se estiver fresca\n')
{
  // A resposta real do CoinGecko em 24/09, e a regra que pegaria o defeito
  // que aconteceu: a cotação da Ronin Market estava PARADA em 0,91.
  const agora = 1790224800
  const fresca = { ronin: { usd: 0.058037, last_updated_at: 1790224750 } }
  conf(cotacaoValida(fresca, agora) === 0.058037, 'cotação de 50 s atrás: vale')
  conf(cotacaoValida({ ronin: { usd: 0.91, last_updated_at: agora - 2 * 3600 } }, agora) === null, 'cotação parada há 2 h: recusada (o dólar não sai)')
  conf(cotacaoValida({ ronin: { usd: 0.91 } }, agora) === null, 'cotação sem hora: recusada -- sem hora não dá pra saber se está parada')
  conf(cotacaoValida({ ronin: { usd: 0, last_updated_at: agora } }, agora) === null, 'cotação zero: recusada')
  conf(cotacaoValida({}, agora) === null && cotacaoValida(null, agora) === null, 'resposta vazia: recusada')
}

console.log('\nVARIAÇÃO — em milésimos de BigInt\n')
{
  conf(variacao(650n * RON, 563n * RON) === '+15%', '650 sobre 563: +15%', variacao(650n * RON, 563n * RON))
  conf(variacao(650n * RON, 530n * RON) === '+23%', '650 sobre 530: +23%', variacao(650n * RON, 530n * RON))
  conf(variacao(563n * RON, 56399n * RON / 100n) === '-0.1%', '563 sob 563,99: -0.1%', variacao(563n * RON, 56399n * RON / 100n))
  conf(variacao(500n * RON, 563n * RON) === '-11%', '500 sob 563: -11%', variacao(500n * RON, 563n * RON))
  conf(variacao(4696969n * RON / 10n, 562n * RON) === '836×', 'o 1/1 #4820 a 469.696,9 com floor 562: "836×", não "+83486%"', variacao(4696969n * RON / 10n, 562n * RON))
  conf(variacao(700n * RON, 32n * RON) === '21.8×', 'comprou a 32 há muito tempo, vende a 700: 21.8×', variacao(700n * RON, 32n * RON))
  conf(variacao(99n * RON, 10n * RON) === '+890%', 'logo abaixo de 10×: ainda porcentagem', variacao(99n * RON, 10n * RON))
  conf(variacao(563n * RON, 563n * RON) === null, 'igual: null (vira "at floor" na mensagem)')
  conf(variacao(1n, 0n) === null && variacao(1n, null) === null, 'base zero ou ausente: null')
}

console.log('\nA MENSAGEM DE VENDA\n')
{
  const venda = {
    id: '6857', tx: '0x' + 'ab'.repeat(32), comprador: MARCUS, vendedor: BD93,
    precoWei: 650n * RON, moeda: 'RON', marketplace: 'Ronin Market', itensDoComprador: 1,
  }
  const antes = montaEmbed(venda, {}, 'Ronkeverse')
  conf(antes.fields.length === 3, 'SEM extras: os mesmos 3 campos de antes')
  conf(antes.fields[0].value === '**650 RON**', 'SEM extras: preço idêntico', antes.fields[0].value)
  conf(antes.fields[1].value === '`0x871f…7886`', 'SEM extras: comprador idêntico', antes.fields[1].value)

  const extra = {
    usd: 0.058037, // CoinGecko, 24/09 -- NÃO o 0,91 parado da Ronin Market
    floor: { id: '4345', precoWei: 563n * RON },
    pagou: { precoWei: 530n * RON, quando: 1789787509 },
    nomeComprador: 'marcussanders',
    nomeVendedor: null,
    scoreComprador: { rank: 225, pontos: 1811 },
    scoreVendedor: { rank: 2, pontos: 7008 },
    raridade: { rank: 4722, tier: 'standard', traco: { tipo: 'Hair - Headwear', valor: 'Ronin Helmet', prob: 0.0076 } },
  }
  const e = montaEmbed(venda, {}, 'Ronkeverse', extra)
  const campo = (n) => e.fields.find((f) => f.name === n)
  conf(e.fields.map((f) => f.name).join(',') === 'Price,Buyer,Seller,Floor,Seller paid,Rarity', 'duas fileiras: quem/quanto, depois o contexto', e.fields.map((f) => f.name).join(','))
  conf(campo('Price').value === '**650 RON**\n≈ $37.72', 'preço fiel + dólar com centavos (abaixo de US$ 100)', JSON.stringify(campo('Price').value))
  conf(campo('Buyer').value === 'marcussanders\n`0x871f…7886`\nRonke Score #225', 'comprador: nome, endereço, score', JSON.stringify(campo('Buyer').value))
  conf(campo('Seller').value === '`0xbd93…afb6`\nRonke Score #2', 'vendedor sem nome: endereço e score', JSON.stringify(campo('Seller').value))
  conf(campo('Floor').value === '563 RON (+15%)', 'floor com variação', campo('Floor').value)
  conf(campo('Seller paid').value === '530 RON (+23%)\n<t:1789787509:R>', 'quanto pagou, lucro e quando', JSON.stringify(campo('Seller paid').value))
  conf(campo('Rarity').value === 'Rank #4,722\nRonin Helmet · 0.76%', 'raridade oficial', JSON.stringify(campo('Rarity').value))

  const noFloor = montaEmbed({ ...venda, precoWei: 563n * RON }, {}, 'Ronkeverse', extra)
  conf(noFloor.fields.find((f) => f.name === 'Floor').value === '563 RON (at floor)', 'venda no floor: "at floor", não "+0%"')

  const golpe = montaEmbed(venda, {}, 'Ronkeverse', { nomeComprador: 'a_b*c [x](y)' })
  conf(golpe.fields[1].value.startsWith('a\\_b\\*c \\[x\\]\\(y\\)'), 'marcação no nome é escapada: vira texto, nunca link', JSON.stringify(golpe.fields[1].value))

  const lote = montaEmbed({ ...venda, itensDoComprador: 3, posicao: 1, totalDoGrupoWei: 1500n * RON }, {}, 'Ronkeverse', extra)
  conf(lote.fields[lote.fields.length - 1].name === 'Batch', 'varrida: a linha Batch continua a última')

  const semPreco = montaEmbed({ ...venda, precoWei: null }, {}, 'Ronkeverse', extra)
  conf(!semPreco.fields.some((f) => f.name === 'Floor') && !semPreco.fields[0].value.includes('$'), 'venda sem preço: sem floor e sem dólar (nada pra comparar)')

  // Venda do RonkeStrategy: sem vendedor no recibo (guarda de custódia), mas o
  // `mercado.js` devolve o protocolo como vendedor efetivo.
  const prot = { ...venda, vendedor: null, marketplace: 'RonkeStrategy' }
  const semX = montaEmbed(prot, {}, 'Ronkeverse')
  conf(semX.fields[2].value === 'escrow · see transaction', 'RonkeStrategy SEM extras: igual a antes')
  const comX = montaEmbed(prot, {}, 'Ronkeverse', { vendedorEfetivo: RONKESTRATEGY, nomeVendedor: 'RonkeStrategy' })
  conf(comX.fields[2].value === 'RonkeStrategy\n`0x16bb…df19`', 'RonkeStrategy COM extras: o protocolo como vendedor', JSON.stringify(comX.fields[2].value))
  conf(comX.footer.text === 'Ronin · RonkeStrategy', 'rodapé: RonkeStrategy', comX.footer.text)

  const comNumeros = montaEmbed(venda, {}, 'Ronkeverse', { colecao: { holders: 1850, volume7d: 20564.91517709862 } })
  conf(
    comNumeros.footer.text === 'Ronin · Ronin Market · 1,850 holders · 20,565 RON 7d volume',
    'rodapé com os números da coleção',
    comNumeros.footer.text,
  )
  const soHolders = montaEmbed(venda, {}, 'Ronkeverse', { colecao: { holders: 1850, volume7d: null } })
  conf(soHolders.footer.text === 'Ronin · Ronin Market · 1,850 holders', 'sem volume: só holders, sem "null"', soHolders.footer.text)
  conf(antes.footer.text === 'Ronin · Ronin Market', 'SEM extras: rodapé de antes', antes.footer.text)
}

console.log('\nA MENSAGEM DE LISTING\n')
{
  const l = {
    ordem: '1', id: '6857', nome: 'Ronkeverse #6857', vendedor: BD93, precoWei: 650n * RON, baseWei: 650n * RON,
    finalWei: null, moeda: 'RON', inicio: 1790138367, expira: 1792730367, imagem: null, link: 'https://x',
  }
  const antes = montaEmbedDeListing(l, 'Ronkeverse')
  conf(antes.fields.map((f) => f.name).join(',') === 'Price,Seller,Expires', 'SEM extras: Price · Seller · Expires, como antes')

  const extra = {
    usd: 0.058037, // CoinGecko, 24/09 -- NÃO o 0,91 parado da Ronin Market
    floor: { id: '4345', precoWei: 563n * RON },
    pagou: { precoWei: 530n * RON, quando: 1789787509 },
    nomeVendedor: null,
    scoreVendedor: { rank: 2, pontos: 7008 },
    raridade: { rank: 4722, tier: 'standard', traco: { tipo: 'Hair - Headwear', valor: 'Ronin Helmet', prob: 0.0076 } },
  }
  const e = montaEmbedDeListing(l, 'Ronkeverse', extra)
  conf(e.fields.map((f) => f.name).join(',') === 'Price,Floor,Seller paid,Seller,Rarity,Expires', 'duas fileiras: preço e contexto, depois quem/quão raro/até quando', e.fields.map((f) => f.name).join(','))
  // O #4820 de 24/09, com a cotação CERTA: foi aqui que o canal publicou
  // "≈ $427,451" com a cotação parada da Ronin Market.
  const caro = montaEmbedDeListing({ ...l, precoWei: 4696969n * RON / 10n }, 'Ronkeverse', extra)
  conf(caro.fields[0].value === '**469,696.9 RON**\n≈ $27,260', 'o #4820: ≈ $27,260 (e não $427,451)', JSON.stringify(caro.fields[0].value))
  conf(e.fields[1].value === '563 RON (+15%)', 'acima do floor: variação', e.fields[1].value)
  const novo = montaEmbedDeListing({ ...l, precoWei: 500n * RON }, 'Ronkeverse', extra)
  conf(novo.fields[1].value === '**New floor**\nprev. 563 RON', 'abaixo do floor: NEW FLOOR, com o floor anterior', JSON.stringify(novo.fields[1].value))
  const igual = montaEmbedDeListing({ ...l, precoWei: 563n * RON }, 'Ronkeverse', extra)
  conf(igual.fields[1].value === '563 RON (at floor)', 'no floor: "at floor"')
  const um = montaEmbedDeListing(l, 'Ronkeverse', { raridade: { rank: null, tier: 'community_1of1', traco: null } })
  conf(um.fields.find((f) => f.name === 'Rarity').value === '1/1 · community', '1/1 da comunidade: o tier, sem rank')
  const oficial = montaEmbedDeListing(l, 'Ronkeverse', {
    raridade: { rank: null, tier: 'official_1of1', traco: { tipo: 'Type', valor: '1/1', prob: 0.0075 } },
  })
  conf(oficial.fields.find((f) => f.name === 'Rarity').value === '1/1 · official', '1/1 oficial (o #4820): só o tier, sem repetir "1/1 · 0.75%"', JSON.stringify(oficial.fields.find((f) => f.name === 'Rarity').value))
  const novoTier = montaEmbedDeListing(l, 'Ronkeverse', { raridade: { rank: null, tier: 'legendary_1of1', traco: null } })
  conf(novoTier.fields.find((f) => f.name === 'Rarity').value === '1/1', 'tier de 1/1 que a API inventar depois: "1/1", sem chute')
  const estranha = montaEmbedDeListing({ ...l, moeda: null }, 'Ronkeverse', extra)
  conf(!estranha.fields.some((f) => f.name === 'Floor') && !estranha.fields[0].value.includes('$'), 'moeda desconhecida: sem floor e sem dólar')
  const comNumeros = montaEmbedDeListing(l, 'Ronkeverse', { colecao: { holders: 1850, volume7d: 20564.9 } })
  conf(comNumeros.footer.text === 'Ronin · Ronin Market · 1,850 holders · 20,565 RON 7d volume', 'listing: rodapé com os números', comNumeros.footer.text)
  conf(antes.footer.text === 'Ronin · Ronin Market', 'listing SEM extras: rodapé de antes')
}

/* ============================================================================
   2. AS DUAS APIS DE VERDADE
   ============================================================================ */

console.log('\nAS APIS DE VERDADE (Ronin Market e Ronke Score)\n')
{
  const ctx = await contextoDoCiclo([{ id: '999999' }])
  conf(ctx.floor && ctx.floor.precoWei > 0n, 'floor de verdade', ctx.floor ? `${ctx.floor.precoWei / RON} RON (#${ctx.floor.id})` : 'nulo')
  conf(ctx.usd > 0 && ctx.usd < 100, 'cotação do RON de verdade (CoinGecko, fresca)', String(ctx.usd))
  // Trava de regressão: 0.91005804 era o valor PARADO da Ronin Market em 24/09.
  // Se ele voltar a aparecer aqui, alguém religou a fonte errada.
  conf(ctx.usd !== 0.91005804, 'a cotação NÃO é a parada da Ronin Market')
  conf(ctx.colecao && ctx.colecao.holders > 0, 'números da coleção de verdade', ctx.colecao ? `${ctx.colecao.holders} holders, ${Math.round(ctx.colecao.volume7d)} RON em 7d` : 'nulo')

  // O .ron vem do /wallet (o /score devolve name null -- ver `nomesRon`). O
  // leaderboard diz quem TEM nome; o /wallet tem que devolver o mesmo.
  const lb = await (await fetch('https://ronke-analytics.vercel.app/api/v1/leaderboard?limit=50')).json()
  const comNome = lb.data.entries.find((e) => e.name)
  if (comNome) {
    const ron = await nomesRon([comNome.address])
    conf(ron.get(comNome.address.toLowerCase()) === comNome.name, 'o .ron do /wallet bate com o do leaderboard', `${comNome.name} (#${comNome.rank})`)
  } else conf(false, 'o leaderboard deveria ter alguém com .ron')

  // #5314: raridade é estável (não muda com venda), então dá pra conferir o
  // valor; score e dono mudam, então só a FORMA.
  const x = await extrasDaVenda({ id: '5314', tx: '0x' + '0'.repeat(64), comprador: BD93, vendedor: MARCUS, precoWei: 700n * RON, moeda: 'RON' }, ctx)
  conf(x.raridade && Number.isInteger(x.raridade.rank) && x.raridade.rank > 0, 'raridade oficial do #5314', x.raridade ? `rank ${x.raridade.rank}, ${x.raridade.traco && x.raridade.traco.valor}` : 'nula')
  conf(x.raridade && x.raridade.traco && x.raridade.traco.prob > 0 && x.raridade.traco.prob < 1, 'traço com probabilidade entre 0 e 1')
  conf(x.scoreComprador === null || Number.isInteger(x.scoreComprador.rank), 'Ronke Score: posição inteira (ou sem score)', x.scoreComprador ? `#${x.scoreComprador.rank}` : 'sem score')
  conf(x.nomeVendedor === null || typeof x.nomeVendedor === 'string', 'nome de perfil: texto ou nada', String(x.nomeVendedor))
  conf(x.pagou === null || x.pagou.precoWei > 0n, 'quanto pagou: número positivo ou nada', x.pagou ? `${x.pagou.precoWei / RON} RON` : 'nada')

  const reais = await ultimosListings(3)
  const xs = await extrasDosListings(reais)
  conf(xs.length === reais.length, 'um extra por listing, na mesma ordem')
  conf(xs.every((e) => e.nomeVendedor === null || typeof e.nomeVendedor === 'string'), 'nome do vendedor: dos extras, texto ou nada', xs.map((e) => e.nomeVendedor).join(' | '))
  conf(xs.every((e) => e.floor === null || e.floor.id !== undefined), 'floor dos listings sem os próprios itens')
  console.log(`  (mais novo: #${reais[0].id}, rank ${xs[0].raridade && xs[0].raridade.rank}, floor ${xs[0].floor && xs[0].floor.precoWei / RON} RON)`)
}

/* ============================================================================
   3. FALHA — fonte pendurada custa UMA espera, não uma por venda
   ============================================================================ */

console.log('\nFALHA — as fontes fora do ar não seguram o anúncio\n')
{
  const original = globalThis.fetch
  // Fetch que nunca responde: só termina quando o tempo máximo aborta.
  globalThis.fetch = (url, opts = {}) =>
    new Promise((_, rejeita) => opts.signal && opts.signal.addEventListener('abort', () => rejeita(new Error('pendurado'))))
  // O timer do `AbortSignal.timeout` não segura o processo aberto. Com fetch de
  // verdade a conexão segura; com este dublê não há conexão nenhuma, e sem este
  // intervalo o Node sairia no meio da espera ("unsettled top-level await").
  const vivo = setInterval(() => {}, 250)
  try {
    const v = { id: '1234', tx: '0x' + '1'.repeat(64), comprador: '0x' + '3'.repeat(40), vendedor: '0x' + '4'.repeat(40), precoWei: 500n * RON, moeda: 'RON' }
    let t = Date.now()
    const x1 = await extrasDaVenda(v, null)
    const primeira = Date.now() - t
    conf(x1.pagou === null && x1.raridade === null && x1.scoreComprador === null, 'fonte pendurada: extras vazios, SEM exceção')
    conf(primeira < 6000, 'a primeira espera é o tempo máximo, uma vez', `${primeira} ms`)
    t = Date.now()
    const x2 = await extrasDaVenda({ ...v, id: '1235' }, null)
    const segunda = Date.now() - t
    conf(segunda < 200, 'a SEGUNDA venda não espera nada: o disjuntor está aberto', `${segunda} ms`)
    conf(x2.raridade === null, 'e continua sem extras, sem exceção')
    const e = montaEmbed(v, {}, 'Ronkeverse', x2)
    conf(e.fields.length === 3 && e.fields[0].value === '**500 RON**', 'a mensagem sai como saía antes')
    const xs = await extrasDosListings([{ id: '1236', vendedor: '0x' + '5'.repeat(40) }])
    conf(xs.length === 1 && xs[0].raridade === null, 'listings também: sem exceção')
  } finally {
    globalThis.fetch = original
    clearInterval(vivo)
  }
}

console.log(falhas ? `\n${falhas} FALHA(S)\n` : '\ntudo certo\n')
process.exitCode = falhas ? 1 : 0
