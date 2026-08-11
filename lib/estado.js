/**
 * ============================================================================
 * ESTADO — até que bloco já foi anunciado
 * ============================================================================
 *
 * É O ÚNICO ESTADO DO BOT, e sem ele nada funciona: a função serverless nasce e
 * morre a cada execução, então sem memória entre chamadas ela reanunciaria as
 * mesmas vendas de minuto em minuto. É esse detalhe que separa "bot" de "spam".
 *
 * DUAS IMPLEMENTAÇÕES, e a escolha é automática:
 *
 *   KV (Upstash / Vercel KV) — quando `KV_REST_API_URL` e `KV_REST_API_TOKEN`
 *   existem. É o modo de produção: sobrevive a deploy, a reinício e a duas
 *   execuções concorrentes.
 *
 *   ARQUIVO — quando não existem. Serve pra rodar na sua máquina e pra GitHub
 *   Actions (que pode versionar o arquivo). Em serverless NÃO serve: o disco é
 *   descartado junto com a execução, e o bot repetiria tudo.
 *
 * O modo em uso é anunciado no log de propósito. "Por que ele está repetindo
 * anúncio" e "o KV não está configurado" são a mesma coisa vista de dois
 * lugares, e essa linha é o que liga as duas.
 */
import { readFile, writeFile } from 'node:fs/promises'

const CHAVE = 'ronkeverse:ultimo-bloco'
const ARQUIVO = new URL('../.estado.json', import.meta.url)

/*
 * DOIS NOMES PRA MESMA COISA, e não é preciosismo.
 *
 * O Upstash entrega as credenciais como `UPSTASH_REDIS_REST_URL/TOKEN`; o KV da
 * Vercel entrega exatamente o mesmo par como `KV_REST_API_URL/TOKEN`. Ler só um
 * dos nomes faz o bot cair no modo arquivo em silêncio — e o sintoma disso é
 * repetir anúncio, que ninguém liga a "esqueci de renomear uma variável".
 */
const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL
const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN
export const usandoKv = Boolean(url && token)

async function kv(caminho, corpo) {
  const r = await fetch(`${url}/${caminho}`, {
    method: corpo === undefined ? 'GET' : 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: corpo,
  })
  if (!r.ok) throw new Error(`KV ${caminho}: HTTP ${r.status}`)
  return (await r.json()).result
}

/** Último bloco já processado, ou null se o bot nunca rodou. */
export async function ultimoBloco() {
  try {
    if (usandoKv) {
      const v = await kv(`get/${CHAVE}`)
      return v == null ? null : Number(v)
    }
    const txt = await readFile(ARQUIVO, 'utf8')
    return Number(JSON.parse(txt).ultimoBloco) || null
  } catch {
    // Sem estado (primeira execução, arquivo ausente, KV vazio) é um caso
    // NORMAL, não um erro: quem chama decide de onde começar.
    return null
  }
}

export async function gravaBloco(n) {
  if (usandoKv) {
    await kv(`set/${CHAVE}/${n}`)
    return
  }
  await writeFile(ARQUIVO, JSON.stringify({ ultimoBloco: n }, null, 2) + '\n')
}
