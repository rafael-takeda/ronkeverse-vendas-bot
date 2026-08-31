/**
 * ============================================================================
 * VIGIA — grita quando o bot fica mudo
 * ============================================================================
 *
 * POR QUE ISTO EXISTE
 *
 * Em 27/08/2026 o bot passou 6h23 sem processar bloco nenhum. (Na hora eu
 * anunciei 9h35, e estava errado: calculei com 3s por bloco quando a Ronin faz
 * 2s -- ver `SEG_POR_BLOCO`. O fato é o mesmo, o número não era.) Não quebrou:
 * o workflow estava `active`, sem falha, o Redis respondia, o RPC respondia,
 * as suítes passavam. Ele simplesmente não foi EXECUTADO — o cron do GitHub
 * parou de entregar, e nada no sistema tinha o trabalho de notar isso. Uma
 * venda real (#2382, 351 RON) ficou sem anúncio.
 *
 * Não foi a primeira vez. O README já registrava: "duas vendas ficaram sem
 * anuncio ate alguem reclamar". Descobrir por reclamação é o modo de falha
 * mais caro que existe, porque o custo cai em cima da comunidade.
 *
 * Toda alternativa de hospedagem que foi estudada — cron-job.org, Cloudflare
 * Cron Triggers, Deno Deploy, Supabase Cron, Oracle Always Free, GCP — foi
 * reprovada pelo MESMO defeito: monitoram se o GATILHO disparou, nunca se o
 * ANÚNCIO saiu. Trocar de hospedagem sem resolver isso é trocar de silêncio.
 *
 * ENTÃO O QUE ESTE ARQUIVO MEDE É O RESULTADO, NÃO O MEIO.
 * Ele não pergunta "o cron rodou?". Pergunta "o ponteiro andou?". É a única
 * pergunta que continua válida depois de qualquer migração — inclusive a do
 * webhook da Alchemy, que é pra onde este projeto vai.
 *
 * POR QUE ELE VIVE FORA DO CICLO
 * Um bot morto não consegue avisar que morreu. O vigia roda em workflow
 * próprio, com cron de 3 em 3 horas. Cron folgado o GitHub entrega; o de 1
 * minuto é que ele engole — e é justamente por isso que o vigia não pode
 * herdar a cadência do vigiado.
 *
 * DUAS CAMPAINHAS, e a segunda não precisa de configuração nenhuma:
 *   1. Discord, se DISCORD_WEBHOOK_ALERTA existir. Webhook SEPARADO de
 *      propósito: "o bot está mudo" no canal de vendas é ruído pra comunidade
 *      e não é assunto dela. Se a variável não existir, ele não posta.
 *   2. Saída != 0 SEMPRE que houver atraso. O GitHub manda e-mail pro dono
 *      quando um workflow agendado falha. Ou seja: mesmo sem configurar nada,
 *      o alarme toca. Foi escolhido assim pra que o vigia funcione no minuto
 *      em que for commitado, e não quando alguém lembrar de criar o webhook.
 */
import { falhaDePostRecente, ultimoBloco, usandoKv } from './lib/estado.js'
import { blocoAtual, transferencias } from './lib/ronin.js'

/* SEGUNDOS POR BLOCO NA RONIN: 2, MEDIDO -- eu tinha escrito 3, de cabeça.
   ═════════════════════════════════════════════════════════════════════════
   Medido em 28/08/2026 lendo o timestamp de dois blocos, em três janelas:

     sobre  1.000 blocos: 2,000 s/bloco
     sobre 10.000 blocos: 2,000 s/bloco
     sobre 18.611 blocos: 2,000 s/bloco

   Com o 3 antigo, TODO número que este arquivo imprime saía 50% inflado: um
   atraso real de 136 min era anunciado como 204. E o teto de 90 min disparava
   de fato aos 60 -- errava pro lado seguro, mas errava, e o número que ia pro
   Discord era mentira.

   Custou mais do que o alarme: eu usei o mesmo 3 pra calcular janela de
   varredura ao investigar, procurei uma venda em "12 horas" que na verdade
   eram 8, não achei, e afirmei ao dono do jogo que não tinha havido venda
   nenhuma -- enquanto o anúncio dela estava no Discord dele. A venda tinha
   10,3 horas.

   Se a Ronin mudar o tempo de bloco, este número tem que ser medido de novo,
   não estimado. */
const SEG_POR_BLOCO = 2

/* QUANTO ATRASO AINDA É NORMAL.
   Hoje o desenho é laço de 50 min + cron, então buracos de ~50 min acontecem
   sem nada de errado. 90 minutos é o primeiro número que NÃO tem explicação
   inocente na arquitetura atual.
   Depois da migração pro webhook (entrega em segundos), este teto deve cair
   pra uns 15 minutos -- por isso ele é variável de ambiente e não constante. */
const LIMITE_MIN = Number(process.env.VIGIA_LIMITE_MIN || 90)

/* NÃO REPETIR O MESMO GRITO A CADA 3 HORAS. Uma vez por período de silêncio é
   aviso; oito por dia é ruído, e ruído é como alarme deixa de ser lido. A
   marca vive no Redis com TTL, então ela se apaga sozinha. */
const CALADO_POR_H = Number(process.env.VIGIA_CALADO_POR_H || 6)

const agora = () => new Date().toISOString().replace('T', ' ').slice(0, 19)

/* A marca de "já avisei" usa o MESMO Redis do bot, pela mesma REST. Não vale a
   pena um segundo armazenamento: se o Redis cair, o vigia grita (sem marca ele
   avisa de novo), que é o lado certo pra errar. */
const kvUrl = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL
const kvToken = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN

async function jaAvisou() {
  if (!kvUrl || !kvToken) return false
  try {
    /* OPÇÕES NO CAMINHO (`/nx/ex/N`), não em query string. A forma com
       `?NX=true&EX=N` devolve HTTP 400 "ERR syntax error" no Upstash -- eu
       copiei ela do `marcaAnunciado` e ela estava errada LÁ TAMBÉM, calada por
       um `catch` que falha aberto. Foi este vigia que revelou o bug do bot. */
    const chave = encodeURIComponent('ronkeverse:vigia:avisado')
    const r = await fetch(`${kvUrl}/set/${chave}/1/nx/ex/${CALADO_POR_H * 3600}`,
      { headers: { Authorization: `Bearer ${kvToken}` } })
    const j = await r.json()
    /* SET NX devolve null quando a chave JÁ existia -- ou seja, já avisamos. */
    return j.result === null
  } catch { return false }
}

async function grita(texto) {
  const hook = process.env.DISCORD_WEBHOOK_ALERTA
  if (!hook) {
    console.log('  (sem DISCORD_WEBHOOK_ALERTA -- o alarme sai pelo e-mail de workflow falho)')
    return
  }
  try {
    const r = await fetch(hook, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: texto }),
    })
    console.log(r.ok ? '  aviso enviado ao Discord' : `  Discord recusou: HTTP ${r.status}`)
  } catch (e) { console.log('  não deu pra avisar no Discord: ' + e.message) }
}

/* TUDO DENTRO DE UMA FUNÇÃO, e não no topo do módulo, por um motivo medido:
   `process.exit()` com I/O pendente derruba o libuv no Windows ("Assertion
   failed: !(handle->flags & UV_HANDLE_CLOSING)") e pode CORTAR a saída antes
   de o aviso chegar ao Discord -- justo no caminho que existe pra avisar.
   Com função dá pra usar `return`, e o processo termina sozinho quando não há
   mais nada pendente. `process.exitCode` marca a falha sem forçar a saída. */
async function main() {
console.log(`\nVIGIA DO BOT DE VENDAS — ${agora()}\n`)

const salvo = await ultimoBloco()
const cabeca = await blocoAtual()

if (!usandoKv) {
  /* Modo arquivo em CI significa que as credenciais não chegaram, e o efeito
     disso não é o bot parar: é ele REPETIR toda venda a cada volta. É outro
     defeito, e igualmente silencioso. */
  console.log('  ATENÇÃO: rodando em modo ARQUIVO -- as credenciais do Redis não chegaram.')
  await grita('⚠️ **Bot de vendas sem Redis.** Ele está em modo arquivo, e nesse modo repete anúncio a cada execução. Confira `UPSTASH_REDIS_REST_URL` e `UPSTASH_REDIS_REST_TOKEN`.')
  process.exitCode = 1
}

if (salvo == null) {
  /* PONTEIRO AUSENTE NÃO É "PRIMEIRO DIA" -- É SINTOMA.
     ─────────────────────────────────────────────────────────────────────
     Isto saía VERDE, com a justificativa de que o bot ainda não tinha rodado.
     Estado de primeiro dia, não de regime: passada a primeira execução, a
     chave só some se o banco do Upstash foi recriado, se a credencial passou a
     apontar pra outro banco, ou se alguém apagou. Nesses casos o vigia
     declarava saúde PRA SEMPRE, enquanto não havia bot nenhum.
     E o custo de errar pro outro lado é um e-mail no primeiro dia. */
  console.log('  PONTEIRO NÃO EXISTE no Redis -- ou é a primeira execução, ou a chave sumiu')
  if (!(await jaAvisou())) {
    await grita('🔴 **O ponteiro do bot sumiu do Redis.** Se ele já rodou alguma vez, ' +
      'isso quer dizer que o banco foi recriado ou a credencial aponta pra outro lugar. ' +
      'O bot vai varrer só os últimos 200 blocos a cada volta e repetir anúncio.')
  }
  process.exitCode = 1
  return
}

const atrasoBlocos = cabeca - salvo
const atrasoMin = Math.round(atrasoBlocos * SEG_POR_BLOCO / 60)

console.log(`  último bloco processado : ${salvo}`)
console.log(`  cabeça da cadeia        : ${cabeca}`)
console.log(`  atraso                  : ${atrasoBlocos} blocos (~${atrasoMin} min)`)
console.log(`  teto aceitável          : ${LIMITE_MIN} min`)

/* O PONTEIRO EM DIA NÃO SIGNIFICA QUE O ANÚNCIO SAIU.
   ═════════════════════════════════════════════════════════════════════════
   Esta era a única falha do sistema com a qual o vigia CONCORDAVA: quando
   nenhum destino do Discord aceita, o `ciclo.js` avança o ponteiro assim mesmo
   (de propósito -- ver o comentário lá), então o atraso fica zero e este
   arquivo imprimia "em dia" com o canal mudo.
   A marca vem do `marcaFalhaDePost`, gravada no momento em que a venda foi
   recusada. É a única memória de que ela existiu. */
const falha = await falhaDePostRecente()
if (falha) {
  console.log('\n  ATENÇÃO: nas últimas 24h houve venda que NENHUM destino do Discord aceitou.')
  if (await jaAvisou()) console.log('  (já avisei nas últimas ' + CALADO_POR_H + 'h)')
  else {
    await grita('🟠 **Uma venda não conseguiu ser postada no canal.** O ponteiro seguiu em ' +
      'frente, então ela não volta sozinha. Confira o `DISCORD_WEBHOOK` e se o canal ainda existe.')
  }
  process.exitCode = 1
}

if (atrasoMin <= LIMITE_MIN) {
  console.log(process.exitCode === 1 ? '\n  ponteiro em dia, mas veja o aviso acima.\n' : '\n  em dia.\n')
  return
}

/* TEM VENDA PRESA NO BURACO? Muda o texto do aviso e a urgência: bot atrasado
   numa madrugada sem venda nenhuma é chato; atrasado com venda esperando é a
   comunidade sem saber que alguém comprou. Só a primeira fatia do buraco é
   varrida -- o objetivo é responder "sim/não", não fazer o trabalho do bot. */
let presas = null
try {
  const de = salvo + 1
  const ate = Math.min(cabeca, de + 199)
  presas = (await transferencias(de, ate)).length
} catch { /* se o RPC falhar aqui, o aviso sai sem este detalhe */ }

const linhas = [
  `🔴 **O bot de vendas está mudo há ~${atrasoMin} min.**`,
  `Último bloco processado: \`${salvo}\` · cabeça da cadeia: \`${cabeca}\` (${atrasoBlocos} blocos atrás).`,
]
if (presas != null) {
  linhas.push(presas > 0
    ? `Já há **${presas} transferência(s)** do Ronkeverse esperando anúncio nos primeiros 200 blocos do buraco.`
    : 'Nos primeiros 200 blocos do buraco não houve transferência -- pode não ter venda perdida ainda.')
}
linhas.push('Pra destravar agora: `gh workflow run vendas.yml --repo rafael-takeda/ronkeverse-vendas-bot`')

console.log('\n  ATRASADO -- gritando.\n')
if (await jaAvisou()) console.log('  (Discord já foi avisado nas últimas ' + CALADO_POR_H + 'h -- não repito)')
else await grita(linhas.join('\n'))

/* Sempre falha, mesmo quando não repete no Discord: o e-mail de workflow falho
   é a campainha que não depende de configuração nenhuma. */
process.exitCode = 1
}

await main()
