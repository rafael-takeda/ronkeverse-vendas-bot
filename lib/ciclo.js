/**
 * ============================================================================
 * O CICLO — uma passada do bot
 * ============================================================================
 *
 * Fica separado do gatilho de propósito. Quem chama isto pode ser o cron da
 * Vercel, o GitHub Actions ou você no terminal; a lógica não muda e nenhuma das
 * três precisa saber das outras.
 *
 * ---------------------------------------------------------------------------
 * A ORDEM IMPORTA: anuncia, DEPOIS avança o ponteiro
 * ---------------------------------------------------------------------------
 * Se o ponteiro subisse antes, uma falha no meio do caminho perderia vendas pra
 * sempre — e venda perdida é invisível, ninguém reclama do que não viu. Do jeito
 * que está, uma falha faz a próxima execução tentar de novo. O preço é o risco
 * oposto (anunciar duas vezes se o processo morrer entre postar e gravar), e
 * esse é o lado certo pra errar: repetição alguém percebe e reclama.
 */
import { blocoAtual, detalheDaVenda, metadados, transferencias } from './ronin.js'
import { anuncia } from './discord.js'
import { gravaBloco, ultimoBloco, usandoKv } from './estado.js'

/**
 * DE QUANTO ATRÁS COMEÇAR quando não há estado nenhum.
 *
 * 200 blocos são ~10 minutos. Pequeno de propósito: na primeira execução o bot
 * não pode despejar no canal as vendas da semana passada como se fossem de
 * agora. Quem quiser preencher histórico faz isso à mão, uma vez.
 */
const INICIO_SEM_ESTADO = 200

export async function umCiclo({ webhook, seco = false } = {}) {
  const agora = await blocoAtual()
  const salvo = await ultimoBloco()
  const de = salvo ? salvo + 1 : agora - INICIO_SEM_ESTADO

  if (de > agora) return { blocos: 0, transferencias: 0, vendas: 0, anunciadas: 0 }

  const movimentos = await transferencias(de, agora)
  const vendas = []
  for (const t of movimentos) {
    const v = await detalheDaVenda(t)
    if (v) vendas.push(v)
  }

  let anunciadas = 0
  for (const v of vendas) {
    const meta = await metadados(v.id)
    if (seco) {
      console.log(`  [seco] #${v.id} por ${v.preco} RON (${v.marketplace ?? 'desconhecida'})`)
      anunciadas++
      continue
    }
    if (await anuncia(webhook, v, meta)) anunciadas++
  }

  if (!seco) await gravaBloco(agora)

  return {
    de,
    ate: agora,
    blocos: agora - de + 1,
    transferencias: movimentos.length,
    vendas: vendas.length,
    anunciadas,
    estado: usandoKv ? 'kv' : 'arquivo',
  }
}
