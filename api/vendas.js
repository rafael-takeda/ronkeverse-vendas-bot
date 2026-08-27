/**
 * O GATILHO DA VERCEL. O cron bate aqui; a lógica mora em `lib/ciclo.js`.
 *
 * PROTEGIDO POR SEGREDO. Sem isso a URL fica pública e qualquer um pode forçar
 * uma passada — o que não posta venda falsa (a venda vem da cadeia), mas gasta
 * execução e pode fazer o ponteiro avançar na frente do anúncio. A Vercel manda
 * `Authorization: Bearer $CRON_SECRET` nos crons dela.
 */
import { umCiclo } from '../lib/ciclo.js'

/**
 * O SEGREDO TAMBÉM VALE NA URL (`?k=...`), e não é preguiça.
 * ============================================================================
 * O gatilho deste endpoint deixou de ser o cron da Vercel e passou a ser o
 * WEBHOOK do indexador. E a Alchemy NÃO manda `Authorization`: ela assina o
 * corpo com HMAC-SHA256 e põe no header `X-Alchemy-Signature`. Ou seja, do
 * jeito antigo só havia dois desfechos, os dois ruins -- ou `CRON_SECRET` fica
 * vazio e a URL é pública, ou fica preenchido e todo webhook leva 401.
 *
 * O que a Alchemy deixa você controlar é a URL inteira. Então o segredo entra
 * por lá.
 *
 * O QUE ISSO CUSTA, dito na cara: segredo em query string aparece em log de
 * acesso, em histórico de navegador e no painel da Alchemy. É PIOR que header.
 * Aceitei porque a alternativa real aqui não é "header", é "sem autenticação
 * nenhuma" -- e porque o estrago de um vazamento é limitado: quem tiver a URL
 * consegue FORÇAR uma passada, não inventar venda (a venda vem da cadeia) nem
 * ler nada. Com a trava do `umCiclo`, nem duplicar anúncio consegue.
 *
 * O jeito certo de fechar isso de vez é validar o `X-Alchemy-Signature` contra
 * o corpo CRU (a Alchemy insiste que seja o cru, nunca o JSON re-serializado),
 * o que exige desligar o bodyParser da Vercel. Vale fazer quando o webhook
 * estiver de pé e provado -- não antes, pra não depurar duas coisas juntas.
 */
export default async function handler(req, res) {
  const segredo = process.env.CRON_SECRET
  if (segredo) {
    const naUrl = new URL(req.url, 'http://x').searchParams.get('k')
    const ok = req.headers.authorization === `Bearer ${segredo}` || naUrl === segredo
    if (!ok) return res.status(401).json({ erro: 'nao autorizado' })
  }
  try {
    const r = await umCiclo({ webhook: process.env.DISCORD_WEBHOOK })
    return res.status(200).json(r)
  } catch (e) {
    console.error('[ciclo]', e)
    return res.status(500).json({ erro: String(e.message || e) })
  }
}
