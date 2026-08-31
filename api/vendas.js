/**
 * O GATILHO. Quem bate aqui é o WEBHOOK do indexador; a lógica mora em
 * `lib/ciclo.js`.
 *
 * NÃO EXISTE MAIS `vercel.json`, e isso é decisão, não esquecimento.
 * ---------------------------------------------------------------------------
 * Ele existia só pra declarar `{ path: /api/vendas, schedule: '* * * * *' }`, e
 * esse cron NUNCA funcionou: o plano Hobby só aceita cron diário. Com o gatilho
 * virando webhook, o arquivo ficou sem nada pra configurar -- a Vercel detecta
 * `api/*.js` como função serverless sozinha, sem config nenhuma.
 *
 * Tentei manter o arquivo com a explicação dentro, num campo `$comentario`. A
 * Vercel valida o `vercel.json` contra um schema ESTRITO e RECUSOU O DEPLOY:
 * "should NOT have additional property `$comentario`". JSON não tem comentário,
 * e esse schema não perdoa. Por isso a explicação vive aqui, num arquivo que
 * aceita comentário, ao lado do código que ela explica.
 *
 * Se um dia voltar a existir `vercel.json`, ele só pode conter chaves que a
 * Vercel conhece -- e cron ali, se houver, tem que ser diário.
 *
 * PROTEGIDO POR SEGREDO. Sem isso a URL fica pública e qualquer um pode forçar
 * uma passada — o que não posta venda falsa (a venda vem da cadeia), mas gasta
 * execução e pode fazer o ponteiro avançar na frente do anúncio. A Vercel manda
 * `Authorization: Bearer $CRON_SECRET` nos crons dela.
 */
import { umCiclo } from '../lib/ciclo.js'
import { usandoKv } from '../lib/estado.js'

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
  /* SEM REDIS, NÃO RODA. É o conserto mais valioso deste arquivo.
     ═══════════════════════════════════════════════════════════════════════
     `.estado.json` está no `.gitignore`, então ele NÃO EXISTE no deploy da
     Vercel. Se as variáveis do Upstash sumirem ou o token expirar aqui (já
     houve rotação neste projeto -- ver `.env.antes-da-rotacao`), o código cai
     no modo arquivo e o efeito é uma cascata, não um defeito:

       ponteiro nasce vazio a cada invocação  -> varre 200 blocos pra trás
       `pegaTrava` devolve true sempre         -> nenhuma serialização
       `jaAnunciado` devolve false sempre      -> nenhum dedup
       `gravaBloco` escreve em disco read-only -> EROFS -> HTTP 500
       a Alchemy vê o 500 e REENVIA            -> tudo de novo

     Resultado medido pelo raciocínio acima: cada venda sai 4 a 8 vezes, com
     preço certo, indistinguível de venda real. Profundidade de mercado
     fantasma -- exatamente o dano que este bot existe pra evitar.

     Recusar é melhor que tentar: 500 faz a Alchemy reenviar (o evento não se
     perde) e o vigia grita pelo atraso do ponteiro. Rodar sem Redis não é
     "degradar", é inundar o canal. */
  if (!usandoKv) {
    console.error('[ciclo] sem Redis -- recusando o ciclo em vez de inundar o canal')
    return res.status(500).json({ erro: 'sem Redis' })
  }
  try {
    const r = await umCiclo({ webhook: process.env.DISCORD_WEBHOOK })
    /* 200 SÓ SOBRE TRABALHO FEITO.
       ─────────────────────────────────────────────────────────────────────
       A Alchemy só reenvia quando a resposta NÃO é 2xx -- e não existe fila de
       reentrega, nem API pra listar entrega falha, e o log da Vercel Hobby some
       em ~1 hora. Um 200 sobre `pulado` (trava ocupada) ou `abortado` (Redis
       mudo) apaga aquele evento PRA SEMPRE, sem deixar rastro em lugar nenhum.
       503 é o que devolve a única garantia de entrega que este desenho tem.
       Sem efeito colateral no Actions: ele roda `node rodar.js` direto e não
       passa por aqui. */
    if (r.pulado || r.abortado) return res.status(503).json(r)
    return res.status(200).json(r)
  } catch (e) {
    console.error('[ciclo]', e)
    return res.status(500).json({ erro: String(e.message || e) })
  }
}
