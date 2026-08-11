/**
 * RODAR À MÃO — pra testar e pra o GitHub Actions.
 *
 *   node rodar.js --seco     mostra o que anunciaria, sem postar e sem gravar
 *   node rodar.js            anuncia de verdade (precisa de DISCORD_WEBHOOK)
 */
import { umCiclo } from './lib/ciclo.js'

const seco = process.argv.includes('--seco')
const webhook = process.env.DISCORD_WEBHOOK

if (!seco && !webhook) {
  console.error('Falta DISCORD_WEBHOOK. Use --seco pra testar sem postar.')
  process.exit(1)
}

const r = await umCiclo({ webhook, seco })
console.log(JSON.stringify(r, null, 2))
