/**
 * UM ANUNCIO DE TESTE, com uma venda REAL que ja aconteceu.
 *
 *   node --env-file=.env enviar_teste.js
 *
 * Existe pra ver o formato no canal antes de o bot entrar no ar. Nao mexe no
 * ponteiro de blocos: o bot nao vai pular nada por causa disto.
 */
import { metadados, nomeDaColecao, vendasDoGrupo } from './lib/ronin.js'
import { anunciaEmTodos, weiExato } from './lib/discord.js'

const webhook = process.env.DISCORD_WEBHOOK
if (!webhook) { console.error('falta DISCORD_WEBHOOK'); process.exitCode = 1 }
else {
  const [venda] = await vendasDoGrupo({
    tx: '0xd620173d987ad031d1c263bbf36e6b1d497434b6fc1840d93490e9268c629c57',
    comprador: '0x138fefdb5117d6f37aeb39959e9a6fc516bfb834',
    itens: [{ id: 3369, de: '0x9f8bc9c10d6c344fd089ac27ec1cab694dd864f8', bloco: 0, logIndex: 0 }],
  })
  const meta = await metadados(3369)
  // `anunciaEmTodos`, nao `anuncia`: a variavel pode ter VARIAS URLs, e mandar a
  // string inteira pra uma so vira uma URL invalida (404). Foi o que aconteceu
  // no dia em que o segundo servidor entrou.
  const colecao = await nomeDaColecao()
  const r = await anunciaEmTodos(webhook, venda, meta, colecao)
  console.log(`postado em ${r.ok}/${r.total} destino(s): #${venda.id} por ${weiExato(venda.precoWei)} RON (${venda.marketplace})`)
  process.exitCode = r.ok === r.total && r.total > 0 ? 0 : 1
}
