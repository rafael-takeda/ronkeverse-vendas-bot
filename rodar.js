/**
 * RODAR — a mao, e tambem no GitHub Actions.
 *
 *   node rodar.js --seco     mostra o que anunciaria, sem postar e sem gravar
 *   node rodar.js            uma passada so
 *   MINUTOS=50 node rodar.js fica vivo 50 min, checando a cada minuto
 *
 * Com DISCORD_WEBHOOK_LISTINGS no ambiente, cada volta tambem posta os listings
 * novos da Ronin Market num canal proprio. Ver `lib/listings.js`.
 *
 * ---------------------------------------------------------------------------
 * POR QUE EXISTE O MODO QUE FICA VIVO
 * ---------------------------------------------------------------------------
 * O workflow pede uma execucao a cada 5 minutos. MEDIDO em 11/08/2026: o GitHub
 * entrega uma por HORA, com buracos de ate 91 minutos. Agendamento no Actions e
 * "melhor esforco", e frequencia alta e a primeira coisa que eles descartam.
 *
 * O bot nunca perdeu venda -- ele varre o buraco inteiro na proxima vez (foram
 * de 1.291 a 2.733 blocos por execucao). Mas anunciar uma venda 90 minutos
 * depois de acontecer nao e um bot de vendas, e um relatorio.
 *
 * Em vez de brigar com o agendador, cada execucao FICA VIVA: acorda de minuto em
 * minuto por ~50 min e depois sai. Mesmo que o GitHub so dispare de hora em
 * hora, a cobertura fica continua. Minuto de Actions em repositorio publico e
 * ilimitado, entao isso nao custa nada.
 */
import { umCiclo } from './lib/ciclo.js'
import { listaDeWebhooks } from './lib/discord.js'
import { usandoKv } from './lib/estado.js'
import { criaPassadaDeListings } from './lib/listings.js'

const seco = process.argv.includes('--seco')
const webhook = process.env.DISCORD_WEBHOOK
const minutos = Number(process.env.MINUTOS || 0)
const intervalo = Number(process.env.INTERVALO_S || 60) * 1000

/*
 * LISTINGS SÓ LIGAM COM DESTINO DE VERDADE E COM REDIS.
 *
 * Destino inválido não é detalhe: com zero webhooks válidos nenhum post é
 * aceito, nada é marcado, e cada volta voltaria a perguntar ao Redis pelas
 * mesmas ordens. Recusar aqui, UMA vez e com o motivo no log, custa menos que
 * descobrir pela conta do Upstash. No modo seco liga sem destino, pra mostrar
 * o que sairia.
 */
const webhookListings = process.env.DISCORD_WEBHOOK_LISTINGS
const destinosListings = listaDeWebhooks(webhookListings).length
let listings = null
if (!usandoKv && (seco || webhookListings)) {
  console.warn('[listings] DESLIGADO: sem Redis nao ha como saber o que ja foi anunciado')
} else if (seco) {
  listings = criaPassadaDeListings()
  console.log('[listings] modo seco: mostra os listings novos, sem postar e sem marcar')
} else if (destinosListings) {
  listings = criaPassadaDeListings()
  console.log(`[listings] ligado: ${destinosListings} destino(s)`)
} else if (webhookListings) {
  console.warn('[listings] DESLIGADO: DISCORD_WEBHOOK_LISTINGS nao tem endereco de webhook valido')
} else {
  console.log('[listings] desligado (sem DISCORD_WEBHOOK_LISTINGS)')
}

if (!seco && !webhook) {
  console.error('Falta DISCORD_WEBHOOK. Use --seco pra testar sem postar.')
  process.exitCode = 1
} else {
  const ate = Date.now() + minutos * 60_000
  let voltas = 0

  do {
    /*
     * UMA VOLTA RUIM NAO PODE ENCERRAR AS 50.
     *
     * Sem este try/catch, a primeira rejeicao dentro de `umCiclo` derruba o
     * processo com exit 1 e leva junto os ~48 minutos restantes daquele run --
     * a corrente so se refaz quando o Actions disparar de novo, e o agendamento
     * dele ja foi medido entregando uma execucao por HORA. O ponteiro nao avanca
     * numa volta que falhou, entao a volta seguinte pega o buraco inteiro.
     */
    let r
    try {
      r = await umCiclo({ webhook, seco })
    } catch (e) {
      console.warn(`[rodar] volta falhou: ${e.message}`)
      r = { blocos: 0, transferencias: 0, vendas: 0, anunciadas: 0, estado: 'erro' }
      /* SAIR VERMELHO. Com o laco de 50 minutos, uma volta ruim em 50 era ruido
         e engolir fazia sentido. Agora e UMA volta por execucao: "a volta
         falhou" passou a significar "este run nao fez absolutamente nada" -- e
         ele ficava VERDE no Actions. A rede de seguranca podia estar falhando
         nas ~96 execucoes diarias sem gerar um unico e-mail.
         So e seguro porque o passo do sinal de vida ganhou `if: always()`: sem
         ele, sair 1 pularia o commit que mantem o agendador ligado. */
      process.exitCode = 1
    }
    /* `abortado` = nao deu pra ler o ponteiro; o ciclo nao fez nada. Vale
       e-mail. `pulado` NAO: significa que outra execucao esta trabalhando
       agora, e isso e o desenho funcionando, nao falha. */
    if (r.abortado) process.exitCode = 1
    voltas++
    // Uma linha por volta, nao o JSON inteiro: 50 voltas de JSON afogam o log e
    // escondem justamente a volta em que algo aconteceu.
    const marca = new Date().toISOString().slice(11, 19)
    console.log(
      `${marca}  blocos ${r.blocos}  transf ${r.transferencias}  vendas ${r.vendas}` +
        `  anunciadas ${r.anunciadas}  [${r.estado}]`,
    )
    /*
     * LISTINGS DEPOIS DAS VENDAS, E ISOLADOS DELAS.
     *
     * A fonte dos listings é uma GraphQL não documentada da Sky Mavis (ver
     * `lib/listings.js`); no dia em que ela mudar, esta passada começa a lançar
     * — e o que não pode acontecer é isso calar o anúncio de vendas. Por isso ela
     * vem depois do ciclo, no próprio try/catch, e NÃO mexe no `exitCode`: o
     * vermelho do processo continua significando "as vendas falharam".
     *
     * Só imprime quando há o que dizer. Uma linha por volta já existe; dobrar o
     * log pra repetir "nada novo" enterraria justamente a volta em que algo
     * aconteceu.
     */
    if (listings) {
      try {
        const l = await listings({ webhook: webhookListings, seco })
        if (l.semeados !== undefined) {
          console.log(`${marca}  listings: primeira passada -- o canal conta a partir de agora (os ativos de antes ficam de fora)`)
        } else if (l.semearia !== undefined) {
          console.log(`${marca}  listings: [seco] a primeira passada marcaria o inicio do canal agora, sem postar nada`)
        } else if (l.novos) {
          console.log(`${marca}  listings: ${l.novos} novo(s), ${l.anunciados ?? 0} no canal`)
        }
      } catch (e) {
        console.warn(`[listings] passada falhou: ${e.message}`)
      }
    }
    if (Date.now() >= ate) break
    await new Promise((f) => setTimeout(f, intervalo))
  } while (Date.now() < ate)

  if (minutos > 0) console.log(`fim: ${voltas} volta(s) em ${minutos} min`)
}
