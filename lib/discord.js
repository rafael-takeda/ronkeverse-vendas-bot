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

export function montaEmbed(venda, meta, colecao = 'NFT') {
  const nome = meta.nome || `${colecao} #${venda.id}`
  const onde = venda.marketplace ? ` · ${venda.marketplace}` : ''
  const campos = [
    { name: 'Price', value: valorDoPreco(venda), inline: true },
    { name: 'Buyer', value: `\`${curto(venda.comprador)}\``, inline: true },
    {
      name: 'Seller',
      // O NFT que sai da custódia da marketplace não tem vendedor legível NESTE
      // recibo — ele foi depositado noutra transação, blocos antes. Imprimir o
      // contrato aqui seria fabricar uma pessoa; mandar o leitor pra transação é
      // o que o bot pode honestamente oferecer.
      value: venda.vendedor ? `\`${curto(venda.vendedor)}\`` : 'escrow · see transaction',
      inline: true,
    },
  ]
  if (venda.itensDoComprador > 1) campos.push(campoBatch(venda, colecao))
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
const espera = (ms) => new Promise((f) => setTimeout(f, ms))

/** Teto de segurança pro `retry_after` que o Discord mandar. */
const ESPERA_MAXIMA_S = 30

export async function anuncia(webhook, venda, meta, colecao = 'NFT', tentativas = 3) {
  const corpo = JSON.stringify({
    username: colecao,
    embeds: [montaEmbed(venda, meta, colecao)],
  })

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
