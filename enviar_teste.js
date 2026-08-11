/**
 * UM ANUNCIO DE TESTE, com uma venda REAL que ja aconteceu.
 *
 *   node --env-file=.env enviar_teste.js
 *
 * Existe pra ver o formato no canal antes de o bot entrar no ar. Nao mexe no
 * ponteiro de blocos: o bot nao vai pular nada por causa disto.
 */
import { detalheDaVenda, metadados } from './lib/ronin.js'
import { anuncia } from './lib/discord.js'

const webhook = process.env.DISCORD_WEBHOOK
if (!webhook) { console.error('falta DISCORD_WEBHOOK'); process.exitCode = 1 }
else {
  const venda = await detalheDaVenda({
    tx: '0xd620173d987ad031d1c263bbf36e6b1d497434b6fc1840d93490e9268c629c57',
    id: 3369,
    de: '0x9f8bc9c10d6c344fd089ac27ec1cab694dd864f8',
    para: '0x138fefdb5117d6f37aeb39959e9a6fc516bfb834',
    bloco: 0,
  })
  const meta = await metadados(3369)
  const foi = await anuncia(webhook, venda, meta)
  console.log(foi ? `postado: #${venda.id} por ${venda.preco} RON (${venda.marketplace})`
                  : 'NAO postou — ver o aviso acima')
  process.exitCode = foi ? 0 : 1
}
