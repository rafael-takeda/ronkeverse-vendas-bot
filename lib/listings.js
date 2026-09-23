/**
 * ============================================================================
 * LISTINGS — o que acabou de ser posto à venda na Ronin Market
 * ============================================================================
 *
 * ---------------------------------------------------------------------------
 * POR QUE NÃO VEM DA CADEIA, como as vendas
 * ---------------------------------------------------------------------------
 * Listing na Ronin Market é uma ASSINATURA guardada no servidor da marketplace,
 * não uma transação. Medido em 22/09: o vendedor 0x871f…7886 listou os #5144,
 * #5242 e #5314 entre 00:28 e 00:38 UTC, e o nonce dele subiu UMA vez na janela
 * — o `setApprovalForAll` (0xf835547a…), a autorização que a marketplace pede
 * uma vez só, 1 segundo antes do primeiro listing. Os três listings em si não
 * deixaram rastro na cadeia. Nem `transferencias` nem o webhook da Alchemy têm
 * o que ver aqui.
 *
 * ---------------------------------------------------------------------------
 * DE ONDE VEM, e o risco disso escrito na cara
 * ---------------------------------------------------------------------------
 * Da GraphQL que o próprio site da Ronin Market usa
 * (marketplace-graphql.skymavis.com). Responde sem chave e ordena pelo listing
 * mais novo. MAS NÃO É API DOCUMENTADA: a doc da Sky Mavis só lista a "Ronin
 * Market Partner API", que em 22/09 fazia refresh de metadado e nada de ordem.
 * A Sky Mavis pode mudar o formato ou exigir chave sem avisar. Quando isso
 * acontecer, `ultimosListings` LANÇA com a mensagem da própria GraphQL, o
 * `rodar.js` loga "[listings] passada falhou" a cada volta, e as VENDAS seguem
 * intactas — é pra isso que a passada de listings roda isolada, depois do ciclo
 * e dentro do próprio try/catch.
 *
 * Só Ronin Market. O OpenSea também negocia Ronkeverse, mas listing de lá só
 * sai pela API deles, que exige chave.
 *
 * ---------------------------------------------------------------------------
 * A JANELA: os 50 mais novos, a cada volta do laço
 * ---------------------------------------------------------------------------
 * 50 é o teto da API (100 volta "must be less than or equal to 50"). Medido em
 * 22/09: 18 listings nas últimas 24h e 80 na semana; a maior rajada foi de 18
 * do mesmo vendedor em 2 minutos. No VPS o laço roda a cada 60 s, então perder
 * listing exigiria mais de 50 num minuto — ou o servidor fora do ar por dias
 * num período de muito movimento.
 *
 * Listing que nasce e morre (vendido ou cancelado) entre duas passadas não sai
 * no canal. É o comportamento certo: não há o que anunciar de algo que já não
 * está à venda.
 *
 * ---------------------------------------------------------------------------
 * O PISO: só conta o que foi listado DEPOIS que o canal nasceu
 * ---------------------------------------------------------------------------
 * A janela são os 50 mais novos de ~300 ativos. Quando os mais novos são
 * vendidos, listing antigo sobe pra janela — e sem piso ele sairia no canal
 * como se fosse de agora. A primeira passada da história grava a hora de
 * início (ver `inicioDosListings`), e dali em diante listing com `startedAt`
 * anterior a ela é ignorado ANTES de custar qualquer consulta ao Redis.
 */
import { COLECAO, nomeDaColecao } from './ronin.js'
import { anunciaListings, weiExato } from './discord.js'
import {
  inicioDosListings,
  listingJaAnunciado,
  marcaInicioDosListings,
  marcaListing,
  usandoKv,
} from './estado.js'

const GRAPHQL = 'https://marketplace-graphql.skymavis.com/graphql'

/** Teto do `size` na GraphQL — medido, ver o cabeçalho. */
export const JANELA = 50

/** O nome da coleção na URL da marketplace: marketplace.roninchain.com/collections/<slug>. */
const SLUG = process.env.LISTINGS_SLUG || 'ronkeverse'

/**
 * Moedas que o bot sabe escrever. As 100 ordens medidas em 22/09 eram TODAS em
 * WRON — que pro membro é RON, e é assim que a própria marketplace mostra.
 *
 * Moeda fora daqui sai sem número (ver `valorDoListing` no discord.js): sem
 * saber as casas decimais do token, qualquer número impresso seria chute.
 */
const MOEDAS = { '0xe514d9deb7966c8be0ca922de8a064264ea6bcd4': 'RON' }

/** Uma GraphQL pendurada não pode segurar o laço — que é o mesmo das vendas. */
const TEMPO_MAXIMO_MS = 15_000

const CONSULTA = `query ListingsRecentes($contrato: String!, $quantos: Int!) {
  erc721Tokens(tokenAddress: $contrato, from: 0, size: $quantos, auctionType: Sale, sort: Latest) {
    results {
      tokenId name image cdnImage
      order { id maker paymentToken basePrice endedPrice currentPrice startedAt expiredAt }
    }
  }
}`

/** Um item da GraphQL -> o formato que o resto do bot entende. */
export function normaliza(t) {
  const o = t.order
  return {
    ordem: String(o.id),
    id: String(t.tokenId),
    nome: t.name || null,
    vendedor: String(o.maker).toLowerCase(),
    precoWei: BigInt(o.currentPrice),
    baseWei: BigInt(o.basePrice),
    // `endedPrice` "0" é preço fixo (as 100 ordens medidas); diferente de zero
    // é leilão holandês descendo até ele.
    finalWei: o.endedPrice && o.endedPrice !== '0' ? BigInt(o.endedPrice) : null,
    moeda: MOEDAS[String(o.paymentToken).toLowerCase()] || null,
    inicio: Number(o.startedAt),
    expira: Number(o.expiredAt),
    // A mesma imagem do S3 que o anúncio de venda usa (via tokenURI). A da CDN
    // da Ronin é só reserva.
    imagem: t.image || t.cdnImage || null,
    link: `https://marketplace.roninchain.com/collections/${SLUG}/${t.tokenId}`,
  }
}

/** Os listings ativos mais novos da coleção, do mais novo pro mais velho. LANÇA. */
export async function ultimosListings(quantos = JANELA) {
  const r = await fetch(GRAPHQL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query: CONSULTA, variables: { contrato: COLECAO, quantos } }),
    signal: AbortSignal.timeout(TEMPO_MAXIMO_MS),
  })
  if (!r.ok) throw new Error(`GraphQL da Ronin Market: HTTP ${r.status}`)
  const j = await r.json()
  if (j.errors?.length) throw new Error(`GraphQL da Ronin Market: ${j.errors[0].message}`)
  const lista = j.data?.erc721Tokens?.results
  if (!Array.isArray(lista)) throw new Error('GraphQL da Ronin Market: resposta sem `results`')
  // A consulta já pede só os que estão à venda, mas item sem ordem derrubaria a
  // passada inteira num `null.id`. Conferir custa uma linha.
  return lista.filter((t) => t && t.order).map(normaliza)
}

const ESTADO = {
  jaAnunciado: listingJaAnunciado,
  marca: marcaListing,
  inicio: inicioDosListings,
  marcaInicio: marcaInicioDosListings,
}

/**
 * Cria a passada de listings — COM MEMÓRIA DO PROCESSO, e é por isso que é
 * fábrica e não função solta.
 *
 * `vistos` guarda as ordens da janela que já estão anunciadas (conferido no
 * Redis ou postado agora). É ela que zera o custo da passada ociosa: sem
 * listing novo, nenhum comando no Redis. `pendentes` guarda as que o Redis
 * disse que NÃO saíram mas o Discord recusou — com o Discord fora por uma hora,
 * a passada tenta repostar sem perguntar de novo ao Redis a cada minuto.
 *
 * Nenhuma das duas é fonte da verdade — o Redis é. Perder as duas (o serviço
 * reinicia todo dia, MINUTOS=1440) custa, na primeira passada seguinte, uma
 * leitura do piso e uma conferência por listing da janela posterior a ele.
 *
 * As dependências entram por parâmetro pra que o teste rode sem rede, sem Redis,
 * sem Discord e sem relógio. Em produção é `criaPassadaDeListings()`, sem
 * argumento.
 */
export function criaPassadaDeListings({
  busca = ultimosListings,
  estado = ESTADO,
  anuncia = anunciaListings,
  nomeColecao = nomeDaColecao,
  temEstado = usandoKv,
  relogio = () => Date.now(),
} = {}) {
  const vistos = new Set()
  const pendentes = new Set()
  /** Ms desde quando o canal conta. null = este processo ainda não perguntou. */
  let piso = null

  /** Só o que ainda está na janela importa: o que saiu dela não volta a ser buscado. */
  function poda(lista) {
    const naJanela = new Set(lista.map((l) => l.ordem))
    for (const o of vistos) if (!naJanela.has(o)) vistos.delete(o)
    for (const o of pendentes) if (!naJanela.has(o)) pendentes.delete(o)
  }

  return async function passada({ webhook, seco = false } = {}) {
    /* SEM REDIS, SEM LISTINGS. Aqui não existe o modo arquivo das vendas: sem
       memória entre execuções, cada restart repostaria a janela inteira. Canal
       parado é melhor que canal inundado. */
    if (!temEstado) return { pulado: 'sem-redis' }

    const lista = await busca(JANELA)

    /* O PISO, perguntado ao Redis uma vez por processo. Na primeira passada da
       história ele não existe: grava agora e não posta nada — tudo que está
       ativo neste instante é, por definição, anterior ao canal. */
    if (piso === null) {
      const salvo = await estado.inicio()
      if (salvo === null) {
        if (seco) return { seco: true, semearia: lista.length }
        const agora = relogio()
        await estado.marcaInicio(agora)
        piso = agora
        return { semeados: lista.length }
      }
      piso = salvo
    }

    /* O QUE ESTE PROCESSO AINDA NÃO SABE, do mais velho pro mais novo: a API
       devolve o mais novo primeiro, e o canal se lê de cima pra baixo. O piso
       vem ANTES da memória e do Redis: listing de antes do canal não custa
       nem uma consulta, por mais que entre e saia da janela. */
    const candidatos = lista.filter((l) => l.inicio * 1000 >= piso && !vistos.has(l.ordem)).reverse()

    /* CONFERE TUDO ANTES DE POSTAR QUALQUER COISA. Se o Redis falhar no meio,
       o erro sobe com nada postado nesta passada, e a próxima recomeça do
       mesmo ponto — nunca "não sei" virando "não anunciei". */
    const novos = []
    for (const l of candidatos) {
      if (pendentes.has(l.ordem)) {
        novos.push(l)
      } else if (await estado.jaAnunciado(l.ordem)) {
        vistos.add(l.ordem)
      } else {
        pendentes.add(l.ordem)
        novos.push(l)
      }
    }

    if (!novos.length) {
      poda(lista)
      return { novos: 0 }
    }

    if (seco) {
      for (const l of novos) {
        const preco = l.moeda ? `${weiExato(l.precoWei)} ${l.moeda}` : 'moeda desconhecida'
        console.log(`  [seco] listing #${l.id} por ${preco} (ordem ${l.ordem})`)
      }
      return { seco: true, novos: novos.length }
    }

    const colecao = await nomeColecao()
    const { aceitos, destinos } = await anuncia(webhook, novos, colecao)

    let anunciados = 0
    for (let i = 0; i < novos.length; i++) {
      if (!aceitos[i]) continue
      anunciados++
      const l = novos[i]
      // Memória ANTES do Redis: se a marca falhar, este processo pelo menos
      // não reposta a mesma ordem daqui a um minuto. O pior caso vira UMA
      // repetição depois do próximo restart — repetição alguém vê e reclama.
      vistos.add(l.ordem)
      pendentes.delete(l.ordem)
      try {
        await estado.marca(l.ordem, l.expira)
      } catch (e) {
        console.warn(`[listings] ordem ${l.ordem} saiu no canal mas nao foi marcada: ${e.message}`)
      }
    }
    if (anunciados < novos.length) {
      console.warn(
        `[listings] ${novos.length - anunciados} de ${novos.length} nao sairam ` +
          `(${destinos} destino(s)) -- tento de novo na proxima passada`,
      )
    }
    poda(lista)
    return { novos: novos.length, anunciados, destinos }
  }
}
