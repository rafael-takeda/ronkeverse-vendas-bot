/**
 * O GATILHO DA VERCEL. O cron bate aqui; a lógica mora em `lib/ciclo.js`.
 *
 * PROTEGIDO POR SEGREDO. Sem isso a URL fica pública e qualquer um pode forçar
 * uma passada — o que não posta venda falsa (a venda vem da cadeia), mas gasta
 * execução e pode fazer o ponteiro avançar na frente do anúncio. A Vercel manda
 * `Authorization: Bearer $CRON_SECRET` nos crons dela.
 */
import { umCiclo } from '../lib/ciclo.js'

export default async function handler(req, res) {
  const segredo = process.env.CRON_SECRET
  if (segredo && req.headers.authorization !== `Bearer ${segredo}`) {
    return res.status(401).json({ erro: 'nao autorizado' })
  }
  try {
    const r = await umCiclo({ webhook: process.env.DISCORD_WEBHOOK })
    return res.status(200).json(r)
  } catch (e) {
    console.error('[ciclo]', e)
    return res.status(500).json({ erro: String(e.message || e) })
  }
}
