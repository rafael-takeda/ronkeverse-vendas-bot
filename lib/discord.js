/**
 * ============================================================================
 * DISCORD — o anúncio
 * ============================================================================
 *
 * WEBHOOK, NÃO BOT. Um bot de verdade exige aplicação, token, permissões e
 * conexão aberta com o gateway; um webhook é uma URL que aceita POST. Pra
 * "postar quando vender" o segundo faz tudo e não tem o que manter de pé.
 *
 * A URL DO WEBHOOK É SENHA. Quem tiver ela posta no canal com o nome e a foto
 * do bot — o cenário perfeito pra um link de golpe com cara de oficial. Ela vem
 * de variável de ambiente e não entra no repositório. Ver o README.
 */

/** Verde-arroz. Só pra faixa lateral do embed. */
const COR = 0x7fd48a

const curto = (end) => end.slice(0, 6) + '…' + end.slice(-4)

/**
 * Preço legível — MAS FIEL, e agora fiel ATÉ O WEI.
 *
 * Arredondava valores acima de 100 pra inteiro, e isso quebrou a confiança numa
 * venda real: a marketplace mostrava 469,69 RON e o canal disse 470. Quem
 * confere os dois conclui que o bot está errado — e num canal de vendas, o bot
 * ser conferível é metade do serviço.
 *
 * A correção da época (2 casas) deixou o mesmo defeito uma casa adiante: medido
 * sobre os 361 itens da amostra, 36 (10%) imprimiam número diferente do real —
 * #2645 vale 269,676 e saía "269.68"; a varrida de 40 soma 15.138,315 e saía
 * "15,138.32". Reincidência da MESMA classe de bug, e a segunda vez custa mais
 * caro que a primeira.
 *
 * Agora a conta é de STRING sobre o BigInt em wei, e por isso não existe casa
 * descartada nem `Number` pra perder precisão no caminho. Corta só zero à toa:
 * 470 continua "470", 269,676 sai "269.676".
 */
const CASAS = 18n

/** "4200000000000000000" -> "4200.5" (sem separador de milhar). */
export function weiExato(wei) {
  const neg = wei < 0n
  const abs = neg ? -wei : wei
  const base = 10n ** CASAS
  const inteiro = (abs / base).toString()
  const fracao = (abs % base).toString().padStart(Number(CASAS), '0').replace(/0+$/, '')
  return (neg ? '-' : '') + inteiro + (fracao ? '.' + fracao : '')
}

function precoTexto(wei) {
  const [inteiro, fracao] = weiExato(wei).split('.')
  const comMilhar = BigInt(inteiro).toLocaleString('en-US')
  return fracao ? `${comMilhar}.${fracao}` : comMilhar
}

/*
 * OS DOIS TEXTOS DE "SEM NÚMERO", e por que os dois falam do BOT.
 *
 * A frase tentadora era "this marketplace doesn't publish a per-item price". Ela
 * é uma afirmação sobre um terceiro que o bot não tem como sustentar: no dia em
 * que o proxy da Ronin Market for atualizado e o decodificador parar de casar, o
 * canal estaria dizendo que a Ronin Market não publica preço por item enquanto a
 * própria Ronin Market mostra o preço na tela. O bot só pode falar do que ele
 * sabe — e o que ele sabe é que ELE não publicou.
 *
 * Do lado de dentro os dois estados que levam ao primeiro texto são bem
 * diferentes (topic0 desconhecido x topic0 conhecido que falhou), e só o segundo
 * vira console.warn. Do lado de fora eles são a mesma frase, porque pro membro a
 * diferença não muda nada: em ambos o número não está publicado aqui.
 */
const SEM_PRECO = 'price not published by this bot for this sale — open the transaction'
const MOEDA_ESTRANHA = 'not shown — paid in a token this bot does not price — open the transaction'

function valorDoPreco(venda) {
  if (venda.precoWei === null || venda.precoWei === undefined) {
    return venda.motivo === 'moeda' ? MOEDA_ESTRANHA : SEM_PRECO
  }
  return `**${precoTexto(venda.precoWei)} ${venda.moeda}**`
}

/*
 * ============================================================================
 * CONTEXTO DE MERCADO — floor, dólar, quanto o vendedor pagou, nome, Ronke
 * Score e raridade. De onde cada número vem, e por que nada disso pode segurar
 * um anúncio, está em `mercado.js`; aqui mora só a cara.
 * ============================================================================
 * REGRA ÚNICA: campo sem dado NÃO APARECE. Nada de "Floor: —". Campo vazio
 * afirma que o bot sabe que não sabe; campo ausente não afirma nada, e é o
 * certo quando uma fonte de fora falhou. Sem `extra`, a mensagem sai idêntica
 * à de antes — e os testes antigos conferem exatamente isso.
 */

/** Tudo que o Discord trata como marcação. Escapado, vira texto. Ver `mercado.js`. */
const escapa = (s) => String(s).replace(/([\\`*_~|<>[\]()#.-])/g, '\\$1')

/**
 * Variação de `preco` sobre `base`, com sinal: "+15%", "-0.2%". null quando a
 * diferença some no arredondamento (menos de 0,1%).
 *
 * Conta em BigInt de milésimos, sem `Number` no meio: com preço em wei, a
 * divisão em ponto flutuante já erraria a terceira casa.
 */
export function variacao(precoWei, baseWei) {
  if (baseWei === null || baseWei === undefined || baseWei <= 0n) return null
  const milesimos = ((precoWei - baseWei) * 1000n) / baseWei
  if (milesimos === 0n) return null
  // De 10× pra cima, multiplicador. Medido em 24/09: o 1/1 oficial #4820 estava
  // listado por 469.696,9 RON com o floor em 562 — "+83486%" é verdade e é
  // ilegível; "836×" diz a mesma coisa de relance.
  if (milesimos >= 9000n) {
    const vezes = Number((precoWei * 10n) / baseWei) / 10
    return `${vezes >= 100 ? Math.round(vezes).toLocaleString('en-US') : vezes.toFixed(1).replace(/\.0$/, '')}×`
  }
  const pct = Math.abs(Number(milesimos)) / 10
  const texto = pct >= 10 ? String(Math.round(pct)) : pct.toFixed(1).replace(/\.0$/, '')
  return `${milesimos > 0n ? '+' : '-'}${texto}%`
}

/**
 * "≈ $592". CONVERSÃO DE EXIBIÇÃO: o número conferível continua sendo o preço
 * em RON logo acima, fiel até o wei. O dólar é arredondado de propósito — com
 * cotação de 5 minutos atrás, centavo seria precisão fingida.
 */
function linhaDolar(precoWei, moeda, extra) {
  if (!extra.usd || precoWei === null || precoWei === undefined || moeda !== 'RON') return ''
  const valor = (Number(precoWei) / 1e18) * extra.usd
  if (!(valor > 0)) return ''
  return `\n≈ $${valor.toLocaleString('en-US', { maximumFractionDigits: valor >= 100 ? 0 : 2 })}`
}

/**
 * Comprador ou vendedor: o nome (quando há um que valha mostrar), o endereço
 * curto SEMPRE, e a posição no Ronke Score. O endereço fica mesmo com nome
 * porque nome não é único — qualquer um pode se chamar "Demeter", e só o
 * endereço prova quem é.
 */
function pessoa(endereco, nome, score) {
  const linhas = []
  if (nome) linhas.push(escapa(nome))
  linhas.push(`\`${curto(endereco)}\``)
  if (score) linhas.push(`Ronke Score #${score.rank.toLocaleString('en-US')}`)
  return linhas.join('\n')
}

/** Floor numa VENDA: onde o preço caiu em relação ao listing mais barato. */
function campoFloorDaVenda(venda, extra) {
  const f = extra.floor
  if (!f || venda.precoWei === null || venda.precoWei === undefined || venda.moeda !== 'RON') return null
  return { name: 'Floor', value: `${precoTexto(f.precoWei)} RON (${variacao(venda.precoWei, f.precoWei) || 'at floor'})`, inline: true }
}

/**
 * Floor num LISTING. Abaixo do floor anterior, o listing É o novo floor — e
 * esse é o caso que o canal existe pra destacar. "-3%" diria o mesmo com
 * menos força, e "+0%" (comparar com ele mesmo) apagaria a notícia.
 */
function campoFloorDoListing(l, extra) {
  const f = extra.floor
  if (!f || l.moeda !== 'RON') return null
  if (l.precoWei < f.precoWei) {
    return { name: 'Floor', value: `**New floor**\nprev. ${precoTexto(f.precoWei)} RON`, inline: true }
  }
  return { name: 'Floor', value: `${precoTexto(f.precoWei)} RON (${variacao(l.precoWei, f.precoWei) || 'at floor'})`, inline: true }
}

/** Quanto o vendedor pagou, a variação até o preço de agora, e quando. */
function campoPagou(precoWei, moeda, extra) {
  const p = extra.pagou
  if (!p) return null
  const v = precoWei !== null && precoWei !== undefined && moeda === 'RON' ? variacao(precoWei, p.precoWei) : null
  const linhas = [`${precoTexto(p.precoWei)} RON${v ? ` (${v})` : ''}`]
  // Entrada antiga do histórico vem com timestamp 0: preço sim, data não.
  if (p.quando) linhas.push(`<t:${p.quando}:R>`)
  return { name: 'Seller paid', value: linhas.join('\n'), inline: true }
}

/**
 * Rodapé com os números da coleção: "Ronin · Ronin Market · 1,850 holders ·
 * 20,565 RON 7d volume". Foto diária da Ronke Score API — número de contexto,
 * não de conferência, então o volume sai inteiro.
 */
function rodape(base, extra) {
  const c = extra.colecao
  if (!c) return base
  const partes = [base]
  if (c.holders) partes.push(`${c.holders.toLocaleString('en-US')} holders`)
  if (c.volume7d) partes.push(`${Math.round(c.volume7d).toLocaleString('en-US')} RON 7d volume`)
  return partes.join(' · ')
}

function porcentagemDoTraco(p) {
  const pct = p * 100
  if (pct >= 10) return `${Math.round(pct)}%`
  if (pct >= 1) return `${pct.toFixed(1).replace(/\.0$/, '')}%`
  return `${pct.toFixed(2)}%`
}

/**
 * Raridade OFICIAL (Ronke Score API): o rank, e o traço mais raro com a fatia
 * da coleção que o tem. 1/1 mostra o tier e nunca um rank — a API os deixa
 * fora da escada 1..N de propósito.
 */
function campoRaridade(extra) {
  const r = extra.raridade
  if (!r) return null
  // Os dois tiers de 1/1 que a API usava em 24/09: `official_1of1` (o #4820) e
  // `community_1of1`. Tier novo que ela inventar sai como "1/1" pelado.
  const tipo1de1 = { official_1of1: '1/1 · official', community_1of1: '1/1 · community' }
  const topo = r.rank !== null ? `Rank #${r.rank.toLocaleString('en-US')}` : tipo1de1[r.tier] || '1/1'
  const linhas = [topo]
  // No 1/1 o tier JÁ É a notícia, e o "traço mais raro" dele é o próprio
  // traço "1/1" (medido no #4820: "1/1 · 0.75%" logo abaixo de "1/1 ·
  // official"). Repetir confunde; o traço só aparece em quem tem rank.
  if (r.traco && r.rank !== null) linhas.push(`${escapa(r.traco.valor)} · ${porcentagemDoTraco(r.traco.prob)}`)
  return { name: 'Rarity', value: linhas.join('\n'), inline: true }
}

/**
 * A LINHA "BATCH" — contexto, não enfeite.
 *
 * Sem ela, uma varrida de 10 coloca dez "Price" no canal e dez preços entre 435 e
 * 444 parecem dez observações independentes de piso. São uma carteira só limpando
 * uma parede. E o nome da coleção aparece na frase de propósito: quando a mesma
 * transação compra outras coleções, é ele que mantém a linha verdadeira — o
 * escopo está escrito, não subentendido.
 *
 * DUAS FORMAS E SÓ DUAS. Com total, quando os N itens do comprador fecham; sem
 * total, quando algum ficou sem preço — aí sai "K of N priced", porque um
 * subtotal chamado de total é exatamente a mentira que este conserto matou.
 *
 * O TOTAL É SOMA DOS ITENS, NUNCA `pago`. Na tx 0xd2bb0c2e os dois divergiriam em
 * três ordens de grandeza (0,1229 em WETH contra 4.370 RON de preço real), e é
 * por isso que a regra é escrita pela ORIGEM do número e não pelo resultado.
 * Numa entrega de escrow o `tx.value` é zero e mesmo assim o total aparece: ele
 * continua sendo conferível no recibo linkado, onde os repasses da ordem somam
 * exatamente esse número — o que não está lá é o gasto do comprador, que
 * aconteceu na transação do depósito.
 */
function campoBatch(venda, colecao) {
  const { posicao, itensDoComprador: n, totalDoGrupoWei: total } = venda
  const cabeca = `${posicao} of ${n} ${colecao} in this transaction`
  const cauda =
    total !== null && total !== undefined
      ? `${precoTexto(total)} RON total`
      : `${venda.precificadosDoGrupo} of ${n} priced`
  return { name: 'Batch', value: `${cabeca} · ${cauda}`, inline: false }
}

export function montaEmbed(venda, meta, colecao = 'NFT', extra = {}) {
  const x = extra || {}
  const nome = meta.nome || `${colecao} #${venda.id}`
  const onde = venda.marketplace ? ` · ${venda.marketplace}` : ''
  // Na venda do RonkeStrategy o vendedor é o próprio protocolo, e é o
  // `mercado.js` que sabe disso (ver `extrasDaVenda`).
  const vendedor = venda.vendedor || x.vendedorEfetivo || null
  const campos = [
    { name: 'Price', value: valorDoPreco(venda) + linhaDolar(venda.precoWei, venda.moeda, x), inline: true },
    { name: 'Buyer', value: pessoa(venda.comprador, x.nomeComprador, x.scoreComprador), inline: true },
    {
      name: 'Seller',
      // O NFT que sai da custódia da marketplace não tem vendedor legível NESTE
      // recibo — ele foi depositado noutra transação, blocos antes. Imprimir o
      // contrato aqui seria fabricar uma pessoa; mandar o leitor pra transação é
      // o que o bot pode honestamente oferecer.
      value: vendedor ? pessoa(vendedor, x.nomeVendedor, x.scoreVendedor) : 'escrow · see transaction',
      inline: true,
    },
    // Segunda fileira: o contexto de mercado. Cada campo só entra com dado.
    ...[campoFloorDaVenda(venda, x), campoPagou(venda.precoWei, venda.moeda, x), campoRaridade(x)].filter(Boolean),
  ]
  if (venda.itensDoComprador > 1) campos.push(campoBatch(venda, colecao))
  return {
    title: `${nome} sold`,
    url: `https://explorer.roninchain.com/tx/${venda.tx}`,
    color: COR,
    fields: campos,
    // `image` e não `thumbnail`: arte de PFP num quadradinho de 80px não se vê.
    image: meta.imagem ? { url: meta.imagem } : undefined,
    footer: { text: rodape(`Ronin${onde}`, x) },
  }
}

/**
 * Separa a lista de webhooks. Uma venda pode ser anunciada em MAIS DE UM
 * servidor — o do jogo e o da coleção, por exemplo.
 *
 * Um bot por servidor seria dois Redis, dois agendadores e duas cópias do
 * código pra divergir na primeira correção. Um bot com vários destinos usa a
 * MESMA leitura da cadeia e o MESMO ponteiro de blocos: se o anúncio sai, sai
 * igual nos dois; se falha num, não repete no outro.
 */
export function listaDeWebhooks(bruto) {
  /*
   * EXIGE `/webhooks/<id>/<token>`, não só "começa com https".
   *
   * Aconteceu de verdade: o arquivo onde o dono colava a URL tinha, no texto de
   * instrução, a frase "ela começa com https://discord.com/api/webhooks/". O
   * filtro antigo aceitou essa frase como destino e o bot passou a ter um
   * webhook que só devolve 404 — quieto, porque falha de destino não derruba os
   * outros. Endereço de webhook tem forma; conferir a forma custa uma linha.
   */
  return String(bruto || '')
    .split(/[\s,]+/)
    .map((u) => u.trim())
    .filter((u) => /^https:\/\/\S*\/webhooks\/\d+\/\S+/.test(u))
}

/**
 * Posta uma venda em TODOS os destinos. Devolve quantos aceitaram.
 *
 * Um destino quebrado (canal apagado, webhook revogado) não pode impedir os
 * outros — por isso cada um é tentado por conta própria e a falha vira aviso,
 * não exceção.
 */
export async function anunciaEmTodos(webhooks, venda, meta, colecao, extra = {}) {
  const destinos = listaDeWebhooks(webhooks)
  let ok = 0
  for (const w of destinos) if (await anuncia(w, venda, meta, colecao, 3, extra)) ok++
  return { ok, total: destinos.length }
}

/**
 * Posta uma venda num destino. Devolve true se o Discord aceitou.
 *
 * NÃO LANÇA. Uma venda que falhou ao postar não pode derrubar o laço e impedir
 * as outras — e, principalmente, não pode impedir o avanço do ponteiro de
 * blocos, senão a próxima execução tentaria tudo de novo e o canal receberia em
 * dobro o que deu certo.
 */
const espera = (ms) => new Promise((f) => setTimeout(f, ms))

/** Teto de segurança pro `retry_after` que o Discord mandar. */
const ESPERA_MAXIMA_S = 30

export async function anuncia(webhook, venda, meta, colecao = 'NFT', tentativas = 3, extra = {}) {
  const corpo = JSON.stringify({
    username: colecao,
    embeds: [montaEmbed(venda, meta, colecao, extra)],
  })
  return postaCorpo(webhook, corpo, tentativas)
}

/**
 * O POST DE VERDADE, com o 429 honrado — e compartilhado.
 *
 * Saiu de dentro de `anuncia` quando o canal de listings chegou: ele posta outro
 * corpo (até 10 embeds por mensagem), mas tem que obedecer EXATAMENTE à mesma
 * política de retentativa. Duas cópias deste laço divergiriam no primeiro
 * conserto, e o 429 já custou anúncio uma vez.
 *
 * Devolve true se o Discord aceitou. NÃO LANÇA — ver o comentário de `anuncia`.
 */
export async function postaCorpo(webhook, corpo, tentativas = 3) {
  for (let t = 1; t <= tentativas; t++) {
    try {
      const r = await fetch(webhook, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: corpo,
      })
      /*
       * 429 NÃO É MAIS DESCARTE.
       *
       * O comentário que estava aqui dizia "com o volume desta coleção isto não
       * deve acontecer nunca". Está medido como falso: existe varrida de 40 NFTs
       * numa única transação (0xc568b5ba), e o ciclo posta os 40 em sequência no
       * mesmo webhook. Descartar no 429 perde ponto de piso JÁ DECODIFICADO — e
       * perde em silêncio, porque `gravaBloco` avança o ponteiro no fim do ciclo
       * de qualquer jeito e não existe fila de repostagem: o que não saiu, não sai
       * nunca mais.
       *
       * O `retry_after` vem do CORPO da resposta e é o próprio Discord dizendo
       * quanto esperar. Honrá-lo é o oposto de martelar o webhook.
       */
      if (r.status === 429) {
        let segundos = 1
        try {
          const d = await r.json()
          if (Number(d.retry_after) > 0) segundos = Number(d.retry_after)
        } catch {}
        segundos = Math.min(segundos, ESPERA_MAXIMA_S)
        if (t === tentativas) {
          console.warn(`[discord] rate limit — desisti apos ${t} tentativas`)
          return false
        }
        console.warn(`[discord] rate limit — nova tentativa em ${segundos}s (${t}/${tentativas})`)
        await espera(segundos * 1000)
        continue
      }
      if (!r.ok) {
        console.warn(`[discord] HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`)
        return false
      }
      return true
    } catch (e) {
      console.warn('[discord] falhou:', e.message)
      return false
    }
  }
  return false
}

/*
 * ============================================================================
 * LISTINGS — o anúncio de "acabou de ser posto à venda"
 * ============================================================================
 * Canal separado, webhook separado. De onde os listings vêm, e por que não é da
 * cadeia, está no cabeçalho de `listings.js`; aqui mora só a cara da mensagem.
 */

/** Azul do macaco. Separa listing de venda até pra quem só bate o olho. */
const COR_LISTING = 0x4aa3df

/**
 * O preço do listing, com a mesma fidelidade ATÉ O WEI do preço de venda — um
 * canal de listings que arredonda 469,69 pra 470 perde a conferência do mesmo
 * jeito que o de vendas perdeu.
 *
 * LEILÃO HOLANDÊS: a Ronin Market aceita ordem com preço que cai com o tempo
 * (`basePrice` descendo até `endedPrice`). Nenhum dos 100 listings medidos em
 * 22/09 era assim — todos tinham `endedPrice` zero, que é preço fixo —, mas se
 * aparecer, o número mostrado é o do momento do anúncio, e a mensagem diz que
 * ele vai cair. Omitir isso faria o canal afirmar um preço que muda sozinho.
 */
function valorDoListing(l) {
  if (!l.moeda) return 'not shown — priced in a token this bot does not price'
  const agora = `**${precoTexto(l.precoWei)} ${l.moeda}**`
  const leilao = l.finalWei !== null && l.finalWei !== undefined && l.finalWei !== l.baseWei
  return leilao ? `${agora} · dropping to ${precoTexto(l.finalWei)} ${l.moeda}` : agora
}

export function montaEmbedDeListing(l, colecao = 'NFT', extra = {}) {
  const x = extra || {}
  return {
    title: `${l.nome || `${colecao} #${l.id}`} listed`,
    url: l.link,
    color: COR_LISTING,
    // Primeira fileira: o preço e o que dá sentido a ele (floor, quanto o
    // vendedor pagou). Segunda: quem, quão raro, até quando. Sem extras, sobram
    // Price · Seller · Expires — a mensagem de antes, na mesma ordem.
    fields: [
      { name: 'Price', value: valorDoListing(l) + linhaDolar(l.precoWei, l.moeda, x), inline: true },
      campoFloorDoListing(l, x),
      campoPagou(l.precoWei, l.moeda, x),
      { name: 'Seller', value: pessoa(l.vendedor, x.nomeVendedor, x.scoreVendedor), inline: true },
      campoRaridade(x),
      // `<t:…:R>` o Discord desenha no idioma e no fuso de QUEM LÊ ("in 30
      // days", "em 30 dias"). Escrever a data à mão fixaria um fuso pra todos.
      { name: 'Expires', value: `<t:${l.expira}:R>`, inline: true },
    ].filter(Boolean),
    image: l.imagem ? { url: l.imagem } : undefined,
    footer: { text: rodape('Ronin · Ronin Market', x) },
    // A hora em que o listing NASCEU, não a do post: depois de uma queda do
    // servidor o bot anuncia atrasado, e aí só este campo conta a verdade.
    timestamp: new Date(l.inicio * 1000).toISOString(),
  }
}

/** Teto do Discord: 10 embeds por mensagem. */
const EMBEDS_POR_MENSAGEM = 10

/** Respiro entre duas mensagens da mesma passada — o mesmo do ciclo de vendas. */
const RESPIRO_ENTRE_MENSAGENS_MS = 400

/**
 * Posta listings em TODOS os destinos, em mensagens de até 10 embeds.
 *
 * AGRUPAR NÃO É ESTÉTICA: medido em 22/09, um vendedor pôs 18 à venda em menos
 * de 2 minutos. Uma mensagem por listing seriam 18 POSTs seguidos no mesmo
 * webhook — convite ao 429 — e 18 notificações pra quem segue o canal. Em
 * mensagens de 10 são 2.
 *
 * Devolve, POR LISTING, se ao menos um destino aceitou a mensagem que o
 * continha: é isso que decide o que fica marcado como anunciado. Mensagem
 * recusada em todos os destinos não marca nada, e a próxima passada tenta de
 * novo. NÃO LANÇA, pelo mesmo motivo de `anuncia`.
 */
export async function anunciaListings(webhooks, listings, colecao = 'NFT', extras = []) {
  const destinos = listaDeWebhooks(webhooks)
  const aceitos = listings.map(() => false)
  for (let i = 0; i < listings.length; i += EMBEDS_POR_MENSAGEM) {
    if (i > 0) await espera(RESPIRO_ENTRE_MENSAGENS_MS)
    const lote = listings.slice(i, i + EMBEDS_POR_MENSAGEM)
    const corpo = JSON.stringify({
      username: colecao,
      embeds: lote.map((l, j) => montaEmbedDeListing(l, colecao, extras[i + j] || {})),
    })
    let ok = 0
    for (const w of destinos) if (await postaCorpo(w, corpo)) ok++
    if (ok > 0) lote.forEach((_, j) => (aceitos[i + j] = true))
    if (ok > 0 && ok < destinos.length) console.warn(`[listings] ${ok}/${destinos.length} destinos aceitaram`)
  }
  return { aceitos, destinos: destinos.length }
}
