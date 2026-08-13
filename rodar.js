/**
 * RODAR — a mao, e tambem no GitHub Actions.
 *
 *   node rodar.js --seco     mostra o que anunciaria, sem postar e sem gravar
 *   node rodar.js            uma passada so
 *   MINUTOS=50 node rodar.js fica vivo 50 min, checando a cada minuto
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

const seco = process.argv.includes('--seco')
const webhook = process.env.DISCORD_WEBHOOK
const minutos = Number(process.env.MINUTOS || 0)
const intervalo = Number(process.env.INTERVALO_S || 60) * 1000

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
    }
    voltas++
    // Uma linha por volta, nao o JSON inteiro: 50 voltas de JSON afogam o log e
    // escondem justamente a volta em que algo aconteceu.
    const marca = new Date().toISOString().slice(11, 19)
    console.log(
      `${marca}  blocos ${r.blocos}  transf ${r.transferencias}  vendas ${r.vendas}` +
        `  anunciadas ${r.anunciadas}  [${r.estado}]`,
    )
    if (Date.now() >= ate) break
    await new Promise((f) => setTimeout(f, intervalo))
  } while (Date.now() < ate)

  if (minutos > 0) console.log(`fim: ${voltas} volta(s) em ${minutos} min`)
}
