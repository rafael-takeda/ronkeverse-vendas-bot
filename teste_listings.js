/**
 * PROVA DO CANAL DE LISTINGS
 *
 *   node teste_listings.js
 *
 * Quase tudo aqui roda sem rede: o Redis, o Discord e a GraphQL são dublês,
 * porque o que se prova é a REGRA — o que sai no canal, o que fica marcado, e o
 * que acontece quando cada peça falha. A exceção é a última seção, que pergunta
 * à GraphQL da Ronin Market de verdade: ela não é API documentada, e o dia em
 * que mudar de formato tem que aparecer aqui antes de aparecer no canal.
 */
import { anunciaListings, montaEmbedDeListing } from './lib/discord.js'
import { listingJaAnunciado, marcaListing } from './lib/estado.js'
import { JANELA, criaPassadaDeListings, normaliza, ultimosListings } from './lib/listings.js'

let falhas = 0
const conf = (cond, msg, extra = '') => {
  if (!cond) {
    falhas++
    console.error('  FALHOU  ' + msg + '  ' + extra)
  } else console.log('  ok      ' + msg + (extra ? '  ' + extra : ''))
}

const RON = 10n ** 18n

/* Item CRU da GraphQL, copiado da resposta real de 22/09 (#5314). */
const CRU = {
  tokenId: '5314',
  name: 'Ronkeverse #5314',
  image: 'https://ronkeverse.s3.us-east-2.amazonaws.com/img/Ronkeverse_Final/5314.png',
  cdnImage: 'https://cdn.roninchain.com/imgineer/rnm/original/0x810b/5314.png?w=500',
  order: {
    id: 11395820,
    maker: '0x871fa8049a2732bf02da42818247edbd3f897886',
    paymentToken: '0xe514d9deb7966c8be0ca922de8a064264ea6bcd4',
    basePrice: '700000000000000000000',
    endedPrice: '0',
    currentPrice: '700000000000000000000',
    startedAt: 1790123880,
    expiredAt: 1792715880,
  },
}

console.log('\n  --- normaliza: da GraphQL pro formato do bot ---')
const l0 = normaliza(CRU)
conf(l0.ordem === '11395820', 'id da ordem vira string', l0.ordem)
conf(l0.id === '5314', 'tokenId', l0.id)
conf(l0.precoWei === 700n * RON, 'preço em wei, BigInt', String(l0.precoWei))
conf(l0.finalWei === null, 'endedPrice "0" é preço fixo, não leilão')
conf(l0.moeda === 'RON', 'WRON aparece como RON, igual na marketplace')
conf(
  normaliza({ ...CRU, order: { ...CRU.order, paymentToken: CRU.order.paymentToken.toUpperCase().replace('0X', '0x') } }).moeda === 'RON',
  'endereço da moeda em maiúscula ainda casa',
)
conf(normaliza({ ...CRU, order: { ...CRU.order, paymentToken: '0x' + '1'.repeat(40) } }).moeda === null, 'moeda desconhecida: null, sem chute')
conf(l0.imagem === CRU.image, 'imagem do S3 (a mesma do anúncio de venda) antes da CDN')
conf(normaliza({ ...CRU, image: null }).imagem === CRU.cdnImage, 'sem imagem do S3, usa a da CDN')
conf(
  l0.link === 'https://marketplace.roninchain.com/collections/ronkeverse/5314',
  'link do item na Ronin Market',
  l0.link,
)
conf(l0.inicio === 1790123880 && l0.expira === 1792715880, 'início e expiração em segundos')

console.log('\n  --- a mensagem ---')
const e0 = montaEmbedDeListing(l0, 'Ronkeverse')
conf(e0.title === 'Ronkeverse #5314 listed', 'título', e0.title)
conf(e0.url === l0.link, 'título leva pro item na marketplace')
conf(e0.fields[0].value === '**700 RON**', 'preço', e0.fields[0].value)
conf(e0.fields[1].value === '`0x871f…7886`', 'vendedor curto', e0.fields[1].value)
conf(e0.fields[2].value === '<t:1792715880:R>', 'expiração no fuso de quem lê', e0.fields[2].value)
conf(e0.image?.url === CRU.image, 'imagem grande, como no canal de vendas')
conf(e0.footer.text === 'Ronin · Ronin Market', 'rodapé', e0.footer.text)
conf(e0.timestamp === '2026-09-23T00:38:00.000Z', 'hora em que o listing nasceu, não a do post', e0.timestamp)
const preco = (wei) => montaEmbedDeListing({ ...l0, precoWei: wei }, 'Ronkeverse').fields[0].value
conf(preco(46969n * RON / 100n) === '**469.69 RON**', 'fiel até o centavo: 469,69 não vira 470', preco(46969n * RON / 100n))
conf(preco(269676n * RON / 1000n) === '**269.676 RON**', 'fiel além do centavo', preco(269676n * RON / 1000n))
conf(preco(1350n * RON) === '**1,350 RON**', 'milhar com vírgula, como no canal de vendas', preco(1350n * RON))
const leilao = montaEmbedDeListing({ ...l0, precoWei: 650n * RON, baseWei: 700n * RON, finalWei: 500n * RON }, 'Ronkeverse')
conf(
  leilao.fields[0].value === '**650 RON** · dropping to 500 RON',
  'leilão holandês: diz que o preço cai',
  leilao.fields[0].value,
)
const estranha = montaEmbedDeListing({ ...l0, moeda: null }, 'Ronkeverse')
conf(
  estranha.fields[0].value === 'not shown — priced in a token this bot does not price',
  'moeda desconhecida: sem número inventado',
)
conf(montaEmbedDeListing({ ...l0, nome: null }, 'Ronkeverse').title === 'Ronkeverse #5314 listed', 'sem nome, monta com a coleção')

console.log('\n  --- anunciaListings: mensagens de até 10 ---')
const fetchDaRede = globalThis.fetch
const W1 = 'https://discord.com/api/webhooks/1/aaa'
const W2 = 'https://discord.com/api/webhooks/2/bbb'
const doze = Array.from({ length: 12 }, (_, i) => ({ ...l0, ordem: String(100 + i), id: String(i) }))

let posts = []
globalThis.fetch = async (url, opt) => {
  posts.push({ url, embeds: JSON.parse(opt.body).embeds.length })
  return { status: 204, ok: true, text: async () => '' }
}
let r = await anunciaListings(W1, doze, 'Ronkeverse')
conf(posts.length === 2, '12 listings = 2 mensagens, não 12', `${posts.length} POSTs`)
conf(posts[0].embeds === 10 && posts[1].embeds === 2, '10 + 2 embeds', `${posts[0].embeds} + ${posts[1]?.embeds}`)
conf(r.aceitos.every(Boolean) && r.aceitos.length === 12, 'os 12 aceitos')

posts = []
let n = 0
globalThis.fetch = async (url, opt) => {
  n++
  posts.push({ url, embeds: JSON.parse(opt.body).embeds.length })
  return n === 1 ? { status: 500, ok: false, text: async () => 'erro' } : { status: 204, ok: true, text: async () => '' }
}
r = await anunciaListings(W1, doze, 'Ronkeverse')
conf(
  r.aceitos.slice(0, 10).every((x) => !x) && r.aceitos.slice(10).every(Boolean),
  'mensagem recusada não marca os 10 dela; a seguinte marca os 2 dela',
)

posts = []
n = 0
globalThis.fetch = async () => {
  n++
  return n === 1
    ? { status: 429, ok: false, json: async () => ({ retry_after: 0.01 }) }
    : { status: 204, ok: true, text: async () => '' }
}
r = await anunciaListings(W1, doze.slice(0, 1), 'Ronkeverse')
conf(r.aceitos[0] === true && n === 2, '429: reenvia, com a mesma política do canal de vendas', `${n} POSTs`)

posts = []
globalThis.fetch = async (url) => {
  posts.push({ url })
  return url === W1 ? { status: 404, ok: false, text: async () => 'Unknown Webhook' } : { status: 204, ok: true, text: async () => '' }
}
r = await anunciaListings(`${W1},${W2}`, doze.slice(0, 1), 'Ronkeverse')
conf(r.aceitos[0] === true && r.destinos === 2, 'um destino quebrado não impede o outro')

posts = []
r = await anunciaListings('https://discord.com/api/webhooks/', doze.slice(0, 3), 'Ronkeverse')
conf(posts.length === 0 && r.aceitos.every((x) => !x) && r.destinos === 0, 'sem destino válido: nada postado, nada aceito')
globalThis.fetch = fetchDaRede

console.log('\n  --- a passada: o que sai, o que fica marcado ---')

/* Redis de mentira, contando comandos: o custo por passada é parte da regra. */
function redisDeMentira() {
  const chaves = new Map()
  const s = {
    iniciado: false,
    gets: 0,
    sets: 0,
    quebraLeitura: false,
    quebraEscrita: false,
    chaves,
    estado: {
      jaAnunciado: async (o) => {
        s.gets++
        if (s.quebraLeitura) throw new Error('Redis fora')
        return chaves.has(o)
      },
      marca: async (o, exp) => {
        s.sets++
        if (s.quebraEscrita) throw new Error('Redis fora')
        chaves.set(o, exp)
      },
      iniciados: async () => {
        s.gets++
        if (s.quebraLeitura) throw new Error('Redis fora')
        return s.iniciado
      },
      marcaIniciados: async () => {
        s.sets++
        s.iniciado = true
      },
    },
  }
  return s
}

/* Discord de mentira: grava o que recebeu e aceita ou recusa conforme mandado. */
function discordDeMentira() {
  const d = {
    aceita: true,
    mensagens: [],
    anuncia: async (webhook, novos) => {
      d.mensagens.push(novos.map((l) => l.ordem))
      return { aceitos: novos.map(() => d.aceita), destinos: 1 }
    },
  }
  return d
}

/* Listing com id de ordem e hora; a GraphQL devolve do mais novo pro mais velho. */
const L = (ordem) => ({ ...l0, ordem: String(ordem), id: String(ordem), inicio: 1790000000 + ordem, expira: 1792000000 })
const janela = (...ordens) => ordens.sort((a, b) => b - a).map(L)

let red = redisDeMentira()
let dis = discordDeMentira()
let atual = janela(1, 2, 3)
let buscas = 0
const busca = async (q) => {
  buscas++
  if (q !== JANELA) conf(false, `pede a janela inteira (${JANELA})`, String(q))
  return atual
}
let passada = criaPassadaDeListings({
  busca,
  estado: red.estado,
  anuncia: dis.anuncia,
  nomeColecao: async () => 'Ronkeverse',
  temEstado: true,
})

let p = await passada({ webhook: W1 })
conf(p.semeados === 3, 'primeira passada da história: registra os 3 ativos', JSON.stringify(p))
conf(dis.mensagens.length === 0, 'primeira passada: NADA no canal')
conf(red.chaves.size === 3 && red.iniciado, 'os 3 marcados, e a marca de iniciado por último')

red.gets = 0
red.sets = 0
p = await passada({ webhook: W1 })
conf(p.novos === 0 && dis.mensagens.length === 0, 'sem novidade: nada no canal')
conf(red.gets === 0 && red.sets === 0, 'passada ociosa: ZERO comandos no Redis', `${red.gets} GET, ${red.sets} SET`)

atual = janela(1, 2, 3, 4)
p = await passada({ webhook: W1 })
conf(p.novos === 1 && p.anunciados === 1, 'listing novo: anunciado', JSON.stringify(p))
conf(JSON.stringify(dis.mensagens.at(-1)) === '["4"]', 'só o novo sai', JSON.stringify(dis.mensagens.at(-1)))
conf(red.chaves.has('4'), 'e fica marcado')
conf(red.gets === 1, 'custo: 1 GET pro listing novo', `${red.gets} GET`)

atual = janela(1, 2, 3, 4, 5, 6, 7)
p = await passada({ webhook: W1 })
conf(JSON.stringify(dis.mensagens.at(-1)) === '["5","6","7"]', 'vários novos: do mais velho pro mais novo', JSON.stringify(dis.mensagens.at(-1)))

console.log('\n  --- quando o Discord recusa ---')
dis.aceita = false
atual = janela(1, 2, 3, 4, 5, 6, 7, 8)
red.gets = 0
p = await passada({ webhook: W1 })
conf(p.anunciados === 0 && !red.chaves.has('8'), 'recusado: não marca')
dis.aceita = true
const getsAntes = red.gets
p = await passada({ webhook: W1 })
conf(p.anunciados === 1 && red.chaves.has('8'), 'passada seguinte: tenta de novo e marca')
conf(red.gets === getsAntes, 'e sem perguntar ao Redis outra vez (já sabia que não tinha saído)', `${red.gets - getsAntes} GET a mais`)

console.log('\n  --- quando o Redis cai ---')
atual = janela(1, 2, 3, 4, 5, 6, 7, 8, 9)
red.quebraLeitura = true
const mensagensAntes = dis.mensagens.length
let lancou = false
try {
  await passada({ webhook: W1 })
} catch {
  lancou = true
}
conf(lancou, 'leitura do Redis falhou: a passada LANÇA')
conf(dis.mensagens.length === mensagensAntes, 'e nada vai pro canal — "não sei" nunca vira "não anunciei"')
red.quebraLeitura = false
p = await passada({ webhook: W1 })
conf(p.anunciados === 1 && JSON.stringify(dis.mensagens.at(-1)) === '["9"]', 'Redis de volta: o #9 sai, uma vez')

red.quebraEscrita = true
atual = janela(1, 2, 3, 4, 5, 6, 7, 8, 9, 10)
p = await passada({ webhook: W1 })
conf(p.anunciados === 1 && !red.chaves.has('10'), 'escrita falhou depois do post: saiu, mas não ficou marcado')
red.quebraEscrita = false
p = await passada({ webhook: W1 })
conf(p.novos === 0, 'mesmo processo não reposta o #10 um minuto depois')

console.log('\n  --- o serviço reiniciou (a memória some, o Redis fica) ---')
red.gets = 0
dis.mensagens = []
atual = janela(1, 2, 3, 4, 5, 6, 7, 8, 9, 11)
passada = criaPassadaDeListings({
  busca,
  estado: red.estado,
  anuncia: dis.anuncia,
  nomeColecao: async () => 'Ronkeverse',
  temEstado: true,
})
p = await passada({ webhook: W1 })
conf(p.novos === 1 && JSON.stringify(dis.mensagens[0]) === '["11"]', 'só o que nasceu durante a queda sai', JSON.stringify(dis.mensagens))
conf(red.gets === 11, 'custo do reinício: 1 GET da marca + 1 por ordem da janela', `${red.gets} GET`)

console.log('\n  --- a janela anda ---')
atual = janela(2, 3, 4, 5, 6, 7, 8, 9, 11)
await passada({ webhook: W1 })
red.gets = 0
atual = janela(1, 2, 3, 4, 5, 6, 7, 8, 9, 11)
p = await passada({ webhook: W1 })
conf(p.novos === 0, 'ordem que saiu da janela e voltou: não reposta')
conf(red.gets === 1, 'e a memória não guarda o que saiu da janela (1 GET pra conferir)', `${red.gets} GET`)

console.log('\n  --- semeadura que cai no meio ---')
red = redisDeMentira()
dis = discordDeMentira()
atual = janela(1, 2, 3)
red.quebraEscrita = true
passada = criaPassadaDeListings({ busca, estado: red.estado, anuncia: dis.anuncia, nomeColecao: async () => 'x', temEstado: true })
lancou = false
try {
  await passada({ webhook: W1 })
} catch {
  lancou = true
}
conf(lancou && !red.iniciado, 'escrita falhou na semeadura: NÃO marca como iniciado')
red.quebraEscrita = false
p = await passada({ webhook: W1 })
conf(p.semeados === 3 && dis.mensagens.length === 0, 'próxima passada semeia de novo, sem postar nada')

console.log('\n  --- modo seco e sem Redis ---')
red = redisDeMentira()
dis = discordDeMentira()
passada = criaPassadaDeListings({ busca, estado: red.estado, anuncia: dis.anuncia, nomeColecao: async () => 'x', temEstado: true })
p = await passada({ webhook: W1, seco: true })
conf(p.semearia === 3 && red.sets === 0 && !red.iniciado, 'seco na primeira vez: diz quanto semearia, e não grava nada')
red.iniciado = true
atual = janela(1, 2, 3)
p = await passada({ webhook: W1, seco: true })
conf(p.novos === 3 && dis.mensagens.length === 0 && red.sets === 0, 'seco com novidade: mostra, não posta, não marca')

buscas = 0
passada = criaPassadaDeListings({ busca, estado: red.estado, anuncia: dis.anuncia, nomeColecao: async () => 'x', temEstado: false })
p = await passada({ webhook: W1 })
conf(p.pulado === 'sem-redis' && buscas === 0, 'sem Redis: nem consulta a marketplace')

console.log('\n  --- o que vai pro Redis de verdade (caminho e validade) ---')
const caminhos = []
globalThis.fetch = async (url) => {
  caminhos.push(String(url))
  return { ok: true, status: 200, json: async () => ({ result: caminhos.length === 1 ? 'OK' : null }) }
}
const agora = 1790000000
await marcaListing('11395820', agora + 30 * 86400, agora)
await marcaListing('7', agora - 5000, agora)
await marcaListing('8', agora + 181 * 86400, agora)
const jaFoi = await listingJaAnunciado('11395820')
globalThis.fetch = fetchDaRede
conf(caminhos[0].endsWith('/set/ronkeverse%3Alisting%3A11395820/1/ex/2678400'), 'validade = a da ordem + 1 dia (30 dias)', caminhos[0].split('/').slice(-5).join('/'))
conf(caminhos[1].endsWith('/ex/86400'), 'ordem já vencida: guarda 1 dia, nunca TTL negativo', caminhos[1].split('/').slice(-2).join('/'))
conf(caminhos[2].endsWith('/ex/15724800'), 'ordem de 181 dias: chave vive 182', caminhos[2].split('/').slice(-2).join('/'))
conf(caminhos[3].endsWith('/get/ronkeverse%3Alisting%3A11395820') && jaFoi === false, 'leitura pela mesma chave; null = não anunciado')

console.log('\n  --- a GraphQL de verdade (não é API documentada: se mudar, é aqui que aparece) ---')
try {
  const reais = await ultimosListings(5)
  conf(reais.length > 0, 'a Ronin Market devolveu listings do Ronkeverse', `${reais.length} itens`)
  conf(reais.every((l) => /^\d+$/.test(l.ordem)), 'todo item tem id de ordem')
  conf(reais.every((l) => l.precoWei > 0n), 'todo item tem preço')
  conf(reais.every((l) => l.moeda === 'RON'), 'todos em RON', reais.map((l) => l.moeda).join(','))
  conf(reais.every((l, i) => i === 0 || reais[i - 1].inicio >= l.inicio), 'do mais novo pro mais velho')
  conf(reais.every((l) => l.expira > l.inicio), 'expiração depois do início')
  console.log(`  (o mais novo: #${reais[0].id} por ${montaEmbedDeListing(reais[0], 'Ronkeverse').fields[0].value})`)
} catch (e) {
  conf(false, 'a GraphQL da Ronin Market respondeu no formato esperado', e.message)
}

console.log(falhas ? `\n${falhas} FALHA(S)\n` : '\nTUDO OK\n')
process.exitCode = falhas ? 1 : 0
