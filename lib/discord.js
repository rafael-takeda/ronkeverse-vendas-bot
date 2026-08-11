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
 * Preço legível — MAS FIEL.
 *
 * Arredondava valores acima de 100 pra inteiro, e isso quebrou a confiança numa
 * venda real: a marketplace mostrava 469,69 RON e o canal disse 470. Quem
 * confere os dois conclui que o bot está errado — e num canal de vendas, o bot
 * ser conferível é metade do serviço.
 *
 * Agora mostra até 2 casas e corta zero à toa: 470 continua "470", 469,69
 * continua "469.69". `maximumFractionDigits` sozinho já derruba os zeros
 * finais, então não há caso de "470.00".
 */
function precoTexto(v) {
  const n = Number(v)
  const casas = n >= 1 ? 2 : 6
  return n.toLocaleString('en-US', { maximumFractionDigits: casas })
}

export function montaEmbed(venda, meta, colecao = 'NFT') {
  const nome = meta.nome || `${colecao} #${venda.id}`
  const onde = venda.marketplace ? ` · ${venda.marketplace}` : ''
  const campos = [
    { name: 'Price', value: `**${precoTexto(venda.preco)} RON**`, inline: true },
    { name: 'Buyer', value: `\`${curto(venda.comprador)}\``, inline: true },
    { name: 'Seller', value: `\`${curto(venda.vendedor)}\``, inline: true },
  ]
  return {
    title: `${nome} sold`,
    url: `https://explorer.roninchain.com/tx/${venda.tx}`,
    color: COR,
    fields: campos,
    // `image` e não `thumbnail`: arte de PFP num quadradinho de 80px não se vê.
    image: meta.imagem ? { url: meta.imagem } : undefined,
    footer: { text: `Ronin${onde}` },
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
export async function anunciaEmTodos(webhooks, venda, meta, colecao) {
  const destinos = listaDeWebhooks(webhooks)
  let ok = 0
  for (const w of destinos) if (await anuncia(w, venda, meta, colecao)) ok++
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
export async function anuncia(webhook, venda, meta, colecao = 'NFT') {
  try {
    const r = await fetch(webhook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: colecao,
        embeds: [montaEmbed(venda, meta, colecao)],
      }),
    })
    if (r.status === 429) {
      // Rate limit do Discord. Com o volume desta coleção isto não deve
      // acontecer nunca; se acontecer, é melhor perder um anúncio do que
      // martelar o webhook e ser bloqueado.
      console.warn('[discord] rate limit — anúncio descartado')
      return false
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
