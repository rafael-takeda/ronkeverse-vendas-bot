/**
 * CHECAGEM DE AMBIENTE — antes de subir pro GitHub, não depois.
 *
 *   node --env-file=.env checar.js
 *
 * Confere as três coisas que o bot precisa e que só falham em produção, quando
 * ninguém está olhando:
 *
 *   1. o Redis responde E aceita gravar (só ler não prova nada — o token de
 *      leitura do Upstash passa no GET e falha no SET)
 *   2. o webhook do Discord existe e é do canal certo
 *   3. o RPC da Ronin responde
 *
 * NÃO POSTA NADA no canal e não mexe no ponteiro de blocos do bot.
 */
import { usandoKv } from './lib/estado.js'
import { blocoAtual } from './lib/ronin.js'
import { listaDeWebhooks } from './lib/discord.js'

let falhas = 0
const ok = (m, extra = '') => console.log('  ok      ' + m + (extra ? '  ' + extra : ''))
const mal = (m, extra = '') => {
  falhas++
  console.error('  FALHOU  ' + m + (extra ? '  ' + extra : ''))
}

console.log('\nCHECAGEM DO AMBIENTE\n')

// ------------------------------------------------------------------ Redis
const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL
const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN

if (!url || !token) {
  mal('Redis não configurado', 'faltam as duas variáveis — o bot vai repetir anúncio em produção')
} else {
  try {
    const marca = `checagem-${Date.now()}`
    const escreve = await fetch(`${url}/set/ronkeverse:checagem/${marca}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    })
    if (!escreve.ok) throw new Error(`HTTP ${escreve.status} ao gravar`)
    const le = await fetch(`${url}/get/ronkeverse:checagem`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    const volta = (await le.json()).result
    if (volta === marca) ok('Redis grava e lê', new URL(url).host)
    else mal('Redis leu valor diferente do que gravou', String(volta))
    // limpa a chave de teste — não deixa lixo no banco de produção
    await fetch(`${url}/del/ronkeverse:checagem`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    })
  } catch (e) {
    mal('Redis não respondeu', e.message)
  }
}
console.log(`          (o bot vai usar: ${usandoKv ? 'REDIS' : 'ARQUIVO — errado em produção'})`)

// ---------------------------------------------------------------- Discord
// CADA destino é conferido, não só o primeiro. Com vários servidores, um
// webhook revogado ficaria invisível se a checagem parasse no primeiro que
// responde — e o sintoma seria "um dos canais parou de receber".
const destinos = listaDeWebhooks(process.env.DISCORD_WEBHOOK)
if (destinos.length === 0) {
  mal('DISCORD_WEBHOOK não configurado')
} else {
  for (const [i, w] of destinos.entries()) {
    try {
      // GET no webhook devolve os dados dele SEM postar nada no canal.
      const r = await fetch(w)
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      const d = await r.json()
      ok(`webhook ${i + 1}/${destinos.length} válido`, `${d.name} · canal ${d.channel_id}`)
    } catch (e) {
      mal(`webhook ${i + 1}/${destinos.length} não respondeu`, e.message)
    }
  }
}

// ------------------------------------------------------------------ Ronin
try {
  ok('RPC da Ronin responde', `bloco ${await blocoAtual()}`)
} catch (e) {
  mal('RPC da Ronin não respondeu', e.message)
}

console.log(falhas ? `\n${falhas} PROBLEMA(S) — corrija antes de subir\n` : '\nTUDO PRONTO\n')
// `exitCode` e não `process.exit()`: cortar o processo com conexões de `fetch`
// ainda abertas faz o Node no Windows cuspir um "Assertion failed" do libuv
// DEPOIS do relatório — que se lê como falha do bot e não é.
process.exitCode = falhas ? 1 : 0
