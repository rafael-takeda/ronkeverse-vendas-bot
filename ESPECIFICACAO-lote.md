# Especificacao: preco por item em compra de lote

Gerada por revisao multi-agente (14 agentes). Todos os numeros abaixo foram
verificados contra a cadeia ao vivo. NAO IMPLEMENTAR SEM LER AS FALHAS FATAIS.

## Resumo

Implementar o DESENHO 1 com os enxertos do painel e as 4 correcoes que os ceticos provaram necessarias. A raiz do bug e gramatical: `lib/ronin.js:223` faz `preco: deWei(pago)`, onde `pago` (calculado em lib/ronin.js:186-215) e o total da TRANSACAO, e `lib/discord.js:42` escreve esse numero sob o rotulo `Price` ao lado da arte de UM NFT. A correcao separa GATILHO de FONTE: `pago` continua respondendo "houve venda?" (e e isso que faz o bot sobreviver a marketplace nova, lib/ronin.js:11-31), e o PRECO passa a vir do evento de ordem do proprio recibo, casado por tokenId. Verifiquei ao vivo contra a cadeia agora: na tx do bug (0x50f41a12) os tres NFTs saem 4200 / 941 / 1250 e a soma fecha ao wei com o tx.value de 6391; na varrida de 40 NFTs (0xc568b5ba) os 40 saem precificados e somam 15138.315 = tx.value exato.

QUATRO ACHADOS DOS CETICOS QUE CONFIRMEI AO VIVO E QUE MUDAM O DESENHO:
(1) FATAL — escrow. Na tx 0x7ceee5b8 (entrega de oferta por atributo) o Transfer do NFT sai de 0x3ef234bc, o PROPRIO contrato da marketplace que emitiu o evento. O decoder 3 dispara, o checksum passa, e o bot publicaria "Seller 0x3ef2…f2c1". Precisa de guarda explicita.
(2) FATAL — checksum triplo errado. `soma === basePrice` quebra em listagem de preco decrescente. Medi em 0xe697bebe: soma = taker = 450000000000000, basePrice = 20000000000000000 (44x). A checagem certa e `soma === precoTaker` mais `endedPrice <= soma <= basePrice` quando `endedAt > 0`. Confirmei os offsets: order+224 = endedAt, order+256 = endedPrice.
(3) SERIO — a linha "Batch" tem que agrupar por (tx, COMPRADOR), nao por tx. Medi 0x0906c539: 3 NFTs, 3 compradores diferentes, 310.03 / 310.02 / 310. Agrupando por tx o bot imprimiria "930.05 RON total" que ninguem pagou.
(4) MENOR — o prototipo do scratchpad faz `r.total / BigInt(r.itens.length)`, uma media dentro da ordem. Tem que morrer: decoder 3 usa o uint80 unitario que a ordem carrega; decoders 1 e 2 recusam a ordem que citar mais de um item da colecao.

Sao 7 passos. Cada um deixa o bot rodando: 1-2 so adicionam arquivos que ninguem importa ainda; 3 muda so o custo de RPC e o agrupamento (comportamento identico, bug ainda em pe, e a suite atual continua verde); o BUG MORRE NO PASSO 4; 5-7 sao endurecimento.

## Passos

### 1. lib/precos.js (ARQUIVO NOVO, ~180 linhas)

Os quatro decodificadores de evento de ordem, sobre um leitor de bytes que SEGUE PONTEIRO ABI. Ponto de partida pronto e validado: C:\Users\taked\AppData\Local\Temp\claude\C--Users-taked-Desktop-Claude-ronke-defense\e4413c79-8d53-41fc-b7cc-8a5e87a9286d\scratchpad\precos.mjs — copie a classe `Fita` (palavra/uint/salto/endereco) e as quatro funcoes, e aplique as TRES correcoes abaixo, que o prototipo nao tem.

EXPORTA: `precosPorItem(rec)` -> `{ mapa: Map(tokenId -> {wei:BigInt, moeda, fonte, emissor, itensNaOrdem}), avisos: string[] }` e `ehRon(moeda)`.

CORRECAO A — CHECKSUM DO OrderMatched (0x109cee1a…, emissor 0x3b3adf14). O prototipo exige `soma === precoTaker && soma === basePrice` (precos.mjs:71). A segunda metade esta ERRADA e eu medi: em 0xe697bebe (kind=1, ERC-721 puro) soma = precoTaker = 450000000000000 e basePrice = 20000000000000000; em 0x13bccf99 soma = 14122276785714286 e basePrice = 15000000000000000. Sao listagens de preco DECRESCENTE — basePrice e o preco inicial, endedPrice e o piso. Trocar por:
    const endedAt    = f.uint(order + 7*32)
    const endedPrice = f.uint(order + 8*32)
    if (soma !== precoTaker) throw ...
    if (endedAt === 0n) { if (soma !== basePrice) throw ... }
    else if (soma < endedPrice || soma > basePrice) throw ...
Os dois offsets estao confirmados por medicao contra a assinatura do openchain (campo 7 = endedAt, campo 8 = endedPrice do struct Order).

CORRECAO B — NADA DE MEDIA DENTRO DA ORDEM. Apagar `const porItem = r.total / BigInt(r.itens.length)` (precos.mjs:210). Cada decoder passa a devolver `itens: [{contrato, id, wei}]`, com o preco JA por item:
  - leOrderMatched e leSeaport: se a ordem citar MAIS DE UM item da COLECAO, recusar a ordem inteira (throw com motivo 'ordem agregada'). Nao existe nenhuma assim na amostra (0 em 204 OrderMatched, 0 em 94 Seaport) — o dia que existir, o item sai sem preco em vez de sair com media.
  - leRoninAntigo: usar o uint80 lido em `t1 + 7*32` como preco de CADA tokenId (ele ja e unitario). Manter `unitario * n === soma(repasses)` so como checksum.

CORRECAO C — GUARDA DE ESCROW, dentro de `precosPorItem`. Antes de inserir um item no mapa, comparar o `from` do Transfer ERC-721 daquele tokenId (o prototipo ja monta esse mapa em precos.mjs:189-193) com `l.address` do evento. Se forem IGUAIS, o NFT saiu do proprio contrato que emitiu a ordem: e entrega de custodia, nao venda direta. Marcar `custodia: true` no item em vez de descartar. MEDIDO AGORA: tx 0x7ceee5b8100471cc370bec2da337bea7d126c113a0b997d41e9d7a756c29bd6c, os tres Transfer de #1548/#1906/#2657 tem de = 0x3ef234bc2a04d86f6041e419458d9acbd077f2c1, que e exatamente o emissor do evento 0x4ada96fd e esta em MARKETPLACES (lib/ronin.js:70).

**Porque:** Arquivo separado porque decodificacao ABI e a unica parte do repo que depende de contrato de terceiro e pode apodrecer sem aviso — isolar torna revisavel. Seguir ponteiro em vez de indice de palavra cravado e o que sobrevive a uma ordem com 5 destinatarios de royalty em vez de 4. As tres correcoes vem de medicao, nao de teoria: sem A o bot descarta venda legivel e grita falso alarme de upgrade; sem B a aritmetica proibida sobrevive escondida como caminho de codigo, com fonte:'ordem' passando pela trava de proveniencia; sem C o bot publica o contrato da marketplace como se fosse pessoa.

### 2. teste_precos.js (ARQUIVO NOVO)

Prova de lib/precos.js sozinha, contra recibos reais, ANTES de plugar em qualquer coisa. Baixa o recibo pelo RPC e confere `precosPorItem`:
  0x50f41a12d49471d4a8e36286a5da99ee52987a2546997b66be0cbee58d014da9 -> 2985=4200, 2986=941, 5086=1250, soma = tx.value (0x15a74f11f07e17c0000)
  0x15c15b7c298754f7e23f812fa58a4031c734a8ca9f99e347fa0cf540425bb493 -> 2432=459.98, 4707=459.98, soma = tx.value
  0xc568b5ba075433e46f2b448e937cee46e0adb7b82f17c3eef0fca23aaf3862b8 -> 40 itens, TODOS com preco, soma = 15138.315 = tx.value (medi agora, fecha ao wei)
  0xd2bb0c2e6ab65813b43ace1430a6cede340c6bd7f58ae34bbdd9f6ea60403cb6 -> 10 itens, 437/436/444/435/435/440/438/435/435/435, moeda WRON em todos (o WETH era so a perna de financiamento)
  0x8d2c45a1907f71eb77e97a5550809499f31362f26ad290c48cbd816ac6921e04 -> 2 itens a 437, moeda WRON (NUNCA 103.608)
  0x34f2fc2b35be33c0692adf9e83d9d6e6ce3a69c0a8b5dbdb2877b6abfb2244cd -> 6 itens, 414.99 a 469.69
  0xef9f07a41d0f0cbaddc9456bc796f12eb1c77e15152ddb91b3cf779df4416edb -> 4 tokenIds numa ordem so, 120 CADA (nao 480, nao 480/4 por divisao)
  0xf2119f71010fd77641c43d706bed1d501ab0920109f9ecc636c33cd3939cba0d -> #650 = 396 (a armadilha da parcela nativa zero)
  0x60b530b8e6ca949e1e6030e6290efa6eee59a9d489b664757a45a32b0ed7d452 -> #3973 = 406.8 (decoder 4)
  0x7ceee5b8100471cc370bec2da337bea7d126c113a0b997d41e9d7a756c29bd6c -> 3 itens a 150 E `custodia === true` nos tres
  0x3f835be8d379c73187cd3ae0e99a8fbdb95b655878940517c2baf0182849a169 -> mapa VAZIO (consolidacao de carteira, 20 transferencias, zero eventos)
Mais dois casos de preco decrescente, que sao a prova da CORRECAO A e que precisam decodificar SEM erro: 0xe697bebe15f974e0f58a0b2fe7d10238129a300264353377b4f5204b91b0998e e 0x13bccf995797b6a5b328b39ba870c95d55df9441c69cceba04f4301487bdd689 (nao sao Ronkeverse; assere so que o decoder aceita e que soma === precoTaker).

**Porque:** O repo ja tem a cultura de provar contra hash real (teste.js:1-12) e nao contra dado sintetico. Testar o decoder isolado, antes de ligar, e o que permite os passos seguintes serem cirurgicos: se algo quebrar no passo 4, da pra saber se foi decodificacao ou plumbing. Os dois casos de preco decrescente sao os unicos que provam que o checksum novo nao voltou a ser o antigo.

### 3. lib/ronin.js:143-170 (transferencias) e lib/ronin.js:178-227 (detalheDaVenda)

PASSO SEM MUDANCA DE COMPORTAMENTO — so agrupamento e custo de RPC.

(a) `transferencias` passa a carregar `logIndex: paraNum(l.logIndex)` no objeto de saida (hoje descartado em lib/ronin.js:160-166).

(b) `detalheDaVenda(t)` vira `vendasDoGrupo({ tx, comprador, itens })`, onde `itens` sao TODAS as transferencias da colecao daquela tx para AQUELE comprador. Os dois RPCs de lib/ronin.js:179-182 passam a rodar uma vez por grupo, nao uma por NFT. O calculo de `pago` (lib/ronin.js:186-215) fica IDENTICO, linha por linha, inclusive os comentarios — nesta fase ele ainda e a fonte do preco. Devolve um ARRAY de vendas, uma por item, com `preco: deWei(pago)` em todas (ou seja, o bug continua em pe, de proposito).

(c) Acrescentar ao objeto de venda: `itensDoComprador` (= itens.length) e `logIndex`.

(d) Acrescentar ACIMA de lib/ronin.js:145 um comentario do PORQUE o agrupamento e seguro: as fatias sao `[ini, fim]` inclusivas e disjuntas (`ini += MAX_BLOCOS`, `fim = min(ini+199, ate)`), entao nenhum bloco e partido entre duas chamadas e os logs de uma mesma transacao nunca se separam. Quem trocar isso por faixas sobrepostas quebra o agrupamento sem nunca ler ciclo.js.

(e) Acrescentar 0x16bb753b48fbeac599a1a7a291b3f87aa3dbdf19 ao mapa MARKETPLACES (lib/ronin.js:68-80) — e o emissor do NFTSoldByProtocol, 44 de 361 itens da amostra.

**Porque:** Separar o refactor de plumbing do conserto de verdade. Depois deste passo a suite atual (teste.js) tem que continuar verde com os MESMOS numeros 420/375/370, o que prova que o agrupamento nao mexeu em nada — e ai o passo 4 fica sendo uma mudanca de uma coisa so. O ganho imediato e de orcamento: a varrida de 40 NFTs que eu confirmei existir (0xc568b5ba) gasta hoje 80 chamadas de recibo contra os 100 req/min publicados; passa a gastar 2.

### 3. lib/ciclo.js:41-44 e lib/ciclo.js:49-59

Entre `transferencias` (ciclo.js:39) e o laco, agrupar `movimentos` por `${t.tx}|${t.para}` — chave composta, NAO so por tx. Chamar `vendasDoGrupo` uma vez por grupo e concatenar os arrays devolvidos em `vendas`. O segundo laco (ciclo.js:49-59) continua iterando venda a venda e postando um embed por NFT, exatamente como hoje.

A linha do modo seco (ciclo.js:52) ganha o contexto do grupo: `[seco] #2985 por 4200 RON (Ronin Market) — 1 de 3 nesta tx`.

**Porque:** Agrupar por (tx, comprador) e nao por tx e o conserto do achado 3 dos ceticos, e ele precisa entrar JA no passo de plumbing porque e ele que define o denominador da linha Batch do passo 4. Medi ao vivo na tx 0x0906c5395c8bfc676a9ab19636902946636440eb6b9b1a5533c70126f4699495: 3 NFTs da colecao, 3 compradores distintos, precos 310.03 / 310.02 / 310. Agrupado por tx, os tres embeds imprimiriam '930.05 RON total' — um agregado que nenhuma carteira gastou. Agrupado por (tx, comprador), cada grupo tem 1 item, a linha Batch nem aparece, e os tres embeds ficam iguais aos de venda unitaria, que e o certo.

### 3. teste.js:54-65 e teste.js:96-102

Adaptar as chamadas: onde hoje ha `detalheDaVenda({tx, id, de, para, bloco})`, passar a montar o grupo `{ tx, comprador: c.para, itens: [{id: c.id, de: c.de, bloco: 0, logIndex: 0}] }` e pegar `[0]` do array devolvido. Os valores esperados (420 / 375 / 370, marketplace, comprador, vendedor) NAO mudam. O contra-exemplo de teste.js:75-82 (comprador 0x…dead) continua tendo que devolver lista vazia.

**Porque:** E a prova de que o passo 3 e neutro. Se algum dos tres numeros mudar aqui, o agrupamento mexeu em algo que nao devia e o passo 4 nao pode comecar.

### 4. lib/ronin.js — dentro de vendasDoGrupo (o que era lib/ronin.js:186-226)

AQUI O BUG MORRE. `pago` e rebaixado de fonte de preco a gatilho, e o preco passa a vir de `precosPorItem(rec)`.

1. GATILHO EM UNIAO: e venda se `pago > 0n` OU se existe entrada no mapa de precos para algum tokenId do grupo. O gate `if (pago === 0n) return null` (lib/ronin.js:215) deixa de matar o grupo sozinho — quem mata e a uniao dar vazio. Isso mantem a consolidacao de carteira ignorada (0x3f835be8: 20 itens, mapa vazio, pago 0 -> nada) e passa a cobrir a entrega de escrow, onde pago = 0 mas a ordem existe.

2. PRECO DE CADA ITEM = `mapa.get(id)`. Se existe e `ehRon(moeda)`, `preco = {wei, fonte: 'ordem'}`. Se existe e a moeda NAO e WRON nem nativo, `preco = null`, `motivo = 'moeda'`. Se nao existe, cai na regra 3.

3. FALLBACK, E SO ELE: sem entrada no mapa, o item so recebe numero quando `itensDoComprador === 1` E `moeda === 'RON'` (o campo que ja e calculado em lib/ronin.js:207-212 e hoje jogado fora) E o PORTAO DE ESCOPO passar. Ai `preco = {wei: pago, fonte: 'fallback'}`. Com `itensDoComprador > 1` o fallback e PROIBIDO por codigo, com comentario dizendo que ali `pago` e o total da carteira e publica-lo e literalmente o bug que este arquivo existe pra consertar.

4. PORTAO DE ESCOPO (so para o fallback): no mesmo laco de `rec.logs` que ja esta na mao (lib/ronin.js:208), contar Transfer com 4 topics cujo `topics[2]` e o comprador e cujo `l.address !== COLECAO`. Se houver algum, o total pagou coisas alem do Ronkeverse: `preco = null`, `motivo = 'lote-misto'`.

5. CUSTODIA: item marcado `custodia: true` pelo decoder sai com o preco normal (150 RON e verdade) mas com `vendedor = null` e `vendedorMotivo = 'escrow'`. Nunca imprimir `t.de` como vendedor quando ele e o emissor da ordem. NAO tentar recuperar o vendedor real do ultimo par de repasses: e inferencia (92,5% e habito, nao garantia) e o custo de errar e nomear a pessoa errada numa venda.

6. MARKETPLACE: `MARKETPLACES[emissor do evento de ordem]` em primeiro lugar; se nao houve evento, o primeiro `l.address` do recibo que esteja no mapa; so entao `null`. `tx.to` deixa de ser consultado (lib/ronin.js:225) — na tx do bug ele era 0x21a0a1c0, um roteador de bulk fora do mapa, e por isso os tres anuncios sairam com rodape 'Ronin' pelado.

7. `deWei` (lib/ronin.js:105-107) para de ser chamado aqui — o wei vai cru pro discord.js. Corrigir o comentario 'Tudo na Ronin que este bot ve tem 18 casas', que virou falso: o certo e 'so chega aqui WRON ou RON nativo; qualquer outro paymentToken e suprimido antes'.

8. console.warn OBRIGATORIO, com hash e topic0, toda vez que `avisos` de `precosPorItem` vier nao-vazio (topic0 conhecido que falhou o checksum) e toda vez que um item sair sem numero. Sao dois estados internos DIFERENTES e so o primeiro justifica alarme: 'sem-decodificador' e normal, 'checksum-falhou' e sinal de que o proxy 0x3b3adf14 pode ter sido atualizado.

**Porque:** E a mudanca de uma coisa so: de onde vem o numero. Lendo da ORDEM em vez da carteira, tres bugs morrem juntos porque todos eram 'o pago virou preco' — o lote (6.391 x3), os 103.608 $RONKE (0x8d2c45a1: a ordem diz WRON, o $RONKE era so a perna de financiamento) e os 0,12 'RON' em dez NFTs de ~437 (0xd2bb0c2e, mesma coisa com WETH). O bug de casas decimais do USDC vira inalcancavel sem precisar ler decimals(). O gatilho continua sendo o pagamento, entao a promessa que ja salvou o bot em producao — marketplace nova desconhecida vira anuncio do mesmo jeito — fica de pe.

### 4. lib/discord.js:32-36 (precoTexto) e lib/discord.js:38-55 (montaEmbed)

(a) `precoTexto` passa a receber BigInt de wei e formatar EXATO: parte inteira com separador de milhar, parte fracionaria com os zeros a direita cortados e nenhuma casa descartada. Medido: 36 dos 361 itens da amostra (10%) imprimem hoje um numero diferente do real — #2645 vale 269.676 e sai '269.68'; a varrida de 40 soma 15138.315 e sai '15,138.32'. O comentario de lib/discord.js:20-31 ja conta que arredondar quebrou a confianca do canal uma vez (469,69 anunciado como 470); e a mesma classe de defeito, uma casa decimal adiante.

(b) O campo de preco (lib/discord.js:42) para de escrever 'RON' fixo. A unidade sai da moeda da ORDEM. Quando nao ha numero, o valor vira o texto do motivo (ver a secao de anuncios). O nome do campo continua 'Price' — a convencao do ecossistema troca por 'Total Amount' em lote porque aqueles bots NAO conseguem o unitario; este consegue, e trocar o rotulo seria pedir desculpa por um numero certo.

(c) O campo 'Seller' (lib/discord.js:44) aceita `vendedor === null` e imprime `escrow · see transaction`.

(d) CAMPO NOVO 'Batch', nao-inline, so quando `itensDoComprador > 1`. Duas formas, e so duas:
  - todos os N itens do comprador tem preco de ordem: `i of N Ronkeverse in this transaction · TOTAL RON total`, onde TOTAL e a SOMA DOS ITENS, nunca `pago`.
  - algum item ficou sem preco: `i of N Ronkeverse in this transaction · K of N priced`, SEM total. Total so aparece quando os N fecham.
O `i` vem da ordem de `logIndex` (carregado no passo 3), nao da posicao no array — e o que torna o anuncio conferivel contra o recibo. A palavra 'Ronkeverse' na frase (o nome vindo de `nomeDaColecao`) e o que mantem a linha verdadeira quando a mesma tx compra outras colecoes: o escopo esta escrito.

**Porque:** O campo Batch nao e enfeite, e componente de verdade: sem ele, uma varrida de 10 coloca dez datapoints de 'Price' no canal, e dez precos de sweep entre 435 e 444 nao sao dez observacoes independentes de piso — sao um comprador limpando uma parede. E o total dele so pode existir quando for soma conferida, porque `pago` e limite superior e nao fato (troco por chamada interna nao gera log).

### 4. teste.js:25-50 (CASOS) e teste.js:96-111 (prova do embed)

Entram os casos de lote com preco esperado POR TOKEN — os mesmos hashes do passo 2, agora atravessando ronin.js + discord.js inteiros. Mais TRES asercoes estruturais novas, que sao a trava de longo prazo:

(A) PROVENIENCIA: para todo item com `fonte === 'fallback'`, tem que valer `itensDoComprador === 1`. Proibe a ORIGEM, nao a aparencia da string — e o que impede alguem reintroduzir media ou total-por-item daqui a seis meses achando que esta melhorando.

(B) SOMA: para lote pago em RON nativo direto, a soma dos itens tem que bater ao wei com `tx.value`. Vale como TESTE, nunca como gate de runtime (uma varrida que misture colecoes quebra a igualdade legitimamente). E o unico mecanismo que pega decodificacao silenciosamente errada. Fecha em 0x50f41a12 (6391), 0x15c15b7c (919.96) e 0xc568b5ba (15138.315).

(C) O caso 0x7ceee5b8 tem que produzir 3 anuncios a 150 RON com o campo Seller SEM endereco — e nenhum embed pode conter a string '0x3ef2'.

**Porque:** Sem (A) a correcao dura ate a proxima pessoa; sem (B) um upgrade que mude o significado dos campos passa calado; sem (C) o achado fatal dos ceticos volta na primeira refatoracao. Os tres casos atuais de 1 NFT ficam onde estao — sao a prova de que o caminho feliz nao regrediu.

### 5. lib/discord.js:104-130 (anuncia) e lib/ciclo.js:49-59

Parar de DESCARTAR o anuncio no 429 (lib/discord.js:114-120). Honrar `retry_after` do corpo da resposta, ate 3 tentativas, e espacar ~400ms os posts do mesmo grupo. O comentario de lib/discord.js:116 ('com o volume desta colecao isto nao deve acontecer nunca') esta medido como falso: existe varrida de 40 NFTs numa unica transacao (0xc568b5ba, confirmei ao vivo — 40 Transfer, comprador unico, tx.value 15.138,315 RON, todos os 40 precificados), e o codigo posta os 40 em sequencia no mesmo webhook.

NAO implementar o teto de '~10 itens + card and N more' que o painel enxertou. Ele institucionaliza a perda de 30 pontos de piso ja decodificados: `gravaBloco` (lib/ciclo.js:61) avanca o ponteiro no fim do ciclo e nao existe fila de repostagem, entao o que nao saiu nao sai nunca mais. Se o volume incomodar, a decisao certa e mudar o FORMATO (um post por transacao), e isso e uma decisao de produto separada desta correcao.

**Porque:** Perder anuncio no meio de um lote e perder dado de piso — o oposto exato do objetivo. E o modo de falha e silencioso: o ciclo so emite um console.warn (ciclo.js:58) e grava o bloco do mesmo jeito.

### 6. lib/estado.js:52-73 e lib/ciclo.js:49-61

TRES coisas, e a primeira e a mais importante:

(a) `ultimoBloco()` (lib/estado.js:52-65) hoje engole TODA excecao e devolve null. Isso confunde 'primeira execucao' com 'KV quebrado', e a consequencia e replay: com null, ciclo.js:35 faz `de = agora - 200` e o bot reanuncia ~10 minutos de cadeia. Separar: devolve null SO quando a chave nao existe; quando a LEITURA falhou, relancar. Em `umCiclo`, abortar com log (`[estado] leitura falhou, ciclo abortado`) em vez de varrer 200 blocos as cegas — o ponteiro fica onde esta e a proxima volta pega tudo.

(b) Dedup por `(tx, tokenId)` — nao por (tx, comprador), porque aqui o post continua sendo por NFT. KV: SET com NX e EX de 24h. A chave e reivindicada DEPOIS de um POST aceito, nunca antes: se o processo morrer entre reivindicar e postar, a venda sumiria pra sempre, que e o inverso do principio escrito em lib/ciclo.js:10-18. Toda chamada de dedup em try/catch que falha ABERTO (deixa o anuncio passar): dedup e higiene e nao pode ter poder de derrubar o ciclo — hoje `kv()` lanca em qualquer resposta nao-ok (lib/estado.js:47), `umCiclo` nao tem try/catch e `rodar.js:39` tambem nao, entao um 429 do Upstash no meio de um lote mataria o processo e os ~48 minutos restantes daquele run.

(c) Modo ARQUIVO: `gravaBloco` (lib/estado.js:72) faz `writeFile` de sobrescrita total, entao qualquer lista de vistos gravada durante o laco seria apagada na ultima linha do mesmo ciclo. Fazer read-modify-write do mesmo JSON. E registrar no log, alto, que em GitHub Actions o modo arquivo nao tem dedup NEM ponteiro entre execucoes — `.estado.json` esta no .gitignore:4 e o runner e descartado. Isso ja aconteceu em producao (documentado em .github/workflows/vendas.yml:61-66: segredos gravados como UPSTASH_* passados como KV_REST_API_*, chegaram vazios, `usandoKv` virou false calado).

(d) Mais um try/catch por volta em rodar.js:38-50, pra uma volta ruim nao encerrar as 50.

**Porque:** Enquanto uma tx virava N posts, hash de transacao nao servia de chave; agora serve. Existem DOIS caminhos confirmados de republicacao: o processo morrer entre postar e gravar, e o cron da Vercel (api/vendas.js:17) rodar junto com o Actions lendo o mesmo 'ronkeverse:ultimo-bloco'. Hoje o replay produz duplicatas obviamente erradas (6.391 tres vezes) que alguem denuncia; depois do conserto ele produz duplicatas com preco certo e linha Batch, indistinguiveis de venda real — profundidade de mercado fantasma. Nao vender isso como dedup permanente: a janela cobre crash e cron duplo, e so.

### 7. README.md:16-20 e README.md:67-78

A regra publicada em blockquote na linha 18 fica FALSA depois do passo 4 e precisa mudar, senao o proximo mantenedor vai busca-la ali:

  DE:  'O comprador e quem recebeu o NFT. O preco e tudo que saiu da carteira dele naquela transacao — seja RON nativo, seja token.'
  PARA: 'O comprador e quem recebeu o NFT. Que saiu dinheiro da carteira dele e o que PROVA que houve venda — e e isso que faz o bot sobreviver a uma marketplace nova. QUANTO custou cada item vem do evento de ordem do proprio recibo, casado por tokenId. Quando a ordem nao da pra ler, o item sai sem preco: preco incompleto e conferivel, preco errado envenena o piso.'

Em 'Detalhes que custaram tempo' (README.md:67-78) entra o paragrafo do caso real: 13/08/2026, tx 0x50f41a12, tres NFTs anunciados a 6.391 RON cada quando valeram 4.200, 941 e 1.250 — o total da transacao carimbado tres vezes sob o rotulo 'Price'.

E o caminho de evolucao como DECISAO, nao como TODO: o preco por item e recuperavel em 361/361 itens da amostra, e por isso o bot le; mas o gateway 0x3b3adf14 e TransparentUpgradeableProxy que ja teve initializeV2, entao a degradacao correta e o item sair SEM numero e nunca com um numero alternativo.

FORA DO CODIGO, e nenhum conserto cobre: o canal ja tem mentira publicada e o bot nao consegue editar nem apagar (o estado inteiro e um escalar, lib/estado.js:26). Postar A MAO a retratacao com os precos certos — #2985 = 4.200, #2986 = 941, #5086 = 1.250 (13/08) e #2432 e #4707 = 459,98 cada (11/08, tx 0x15c15b7c). Sem isso o piso continua envenenado mesmo com o bot correto.

**Porque:** Deixar o README afirmando a regra antiga e manter a mentira viva no lugar onde ela sera procurada. E a retratacao e a unica parte que nao tem como ser automatizada: nao ha dedup nem historico, o unico ponto de acerto do bot e antes do POST.

## Anuncios (texto literal, sao assercao de teste)

### Venda unica

IDENTICO AO DE HOJE, byte a byte. Caso real: tx 0xd620173d…c57, #3369, OpenSea, 420 RON — o primeiro caso de teste.js:26-33. Nenhum campo novo, nenhum campo Batch, `image` grande (nao thumbnail).

┌──────────────────────────────────────────────────────────
│ **Ronkeverse #3369 sold**            ← titulo, link: explorer.roninchain.com/tx/0xd620173d…
│
│ Price              Buyer               Seller
│ **420 RON**        `0x138f…b834`       `0x9f8b…64f8`
│
│ [ imagem grande do #3369 ]
│ Ronin · OpenSea
└──────────────────────────────────────────────────────────

JSON dos campos, literal:
  { "name": "Price",  "value": "**420 RON**",      "inline": true }
  { "name": "Buyer",  "value": "`0x138f…b834`",    "inline": true }
  { "name": "Seller", "value": "`0x9f8b…64f8`",    "inline": true }
  footer.text = "Ronin · OpenSea"

ISSO E ASSERCAO DE TESTE, nao so descricao: teste.js:104-111 tem que continuar passando sem alteracao de valor esperado. O caminho de 1 NFT e ~80% do fluxo e nao pode regredir por causa de um conserto de lote.

### Lote, preco por item conhecido

A tx do bug, 0x50f41a12d49471d4a8e36286a5da99ee52987a2546997b66be0cbee58d014da9. Continuam sendo TRES posts, um por NFT — o que muda e o numero e a linha de contexto. Precos verificados ao vivo agora: 4200 / 941 / 1250, somando 6391 = tx.value ao wei.

┌──────────────────────────────────────────────────────────
│ **Ronkeverse #2985 sold**
│
│ Price              Buyer               Seller
│ **4,200 RON**      `0xc056…d7e3`       `0x2018…939d`
│
│ Batch
│ 1 of 3 Ronkeverse in this transaction · 6,391 RON total
│
│ [ imagem grande do #2985 ]
│ Ronin · Ronin Market
└──────────────────────────────────────────────────────────

┌──────────────────────────────────────────────────────────
│ **Ronkeverse #2986 sold**
│
│ Price              Buyer               Seller
│ **941 RON**        `0xc056…d7e3`       `0x2018…939d`
│
│ Batch
│ 2 of 3 Ronkeverse in this transaction · 6,391 RON total
│
│ [ imagem grande do #2986 ]
│ Ronin · Ronin Market
└──────────────────────────────────────────────────────────

┌──────────────────────────────────────────────────────────
│ **Ronkeverse #5086 sold**
│
│ Price              Buyer               Seller
│ **1,250 RON**      `0xc056…d7e3`       `0x1810…8d13`
│
│ Batch
│ 3 of 3 Ronkeverse in this transaction · 6,391 RON total
│
│ [ imagem grande do #5086 ]
│ Ronin · Ronin Market
└──────────────────────────────────────────────────────────

Campo Batch, literal:
  { "name": "Batch", "value": "1 of 3 Ronkeverse in this transaction · 6,391 RON total", "inline": false }

QUATRO DIFERENCAS EM RELACAO AO QUE FOI PUBLICADO:
1. 4.200 / 941 / 1.250 em vez de 6.391 tres vezes. O piso deixa de ganhar tres vendas fantasmas.
2. A linha Batch existe pra ninguem ler o 941 isolado e achar que o piso desabou. Ela diz que foi varrida, e o total confere com a transacao linkada no titulo.
3. O rodape diz 'Ronin Market'. Hoje dizia so 'Ronin', porque o rotulo saia de tx.to = 0x21a0a1c0, um roteador de bulk fora do mapa.
4. O `i` vem do logIndex (3, 8, 13 no recibo), entao a numeracao e conferivel linha a linha contra o explorer.

O TOTAL DA LINHA BATCH E SOMA DOS ITENS, NUNCA `pago`. Nesta tx os dois coincidem; na tx 0xd2bb0c2e nao coincidiriam (`pago` daria 0,1229 em WETH contra 4.370 reais), e e por isso que a regra e escrita pela origem e nao pelo resultado.

CASO DE CUSTODIA — mesma forma, com o Seller trocado (tx 0x7ceee5b8, tres itens a 150, verificado):
│ Price              Buyer               Seller
│ **150 RON**        `0xf022…4e98`       escrow · see transaction
│ Batch
│ 1 of 3 Ronkeverse in this transaction · 450 RON total
O NFT saiu do proprio contrato que emitiu a ordem, entao `t.de` NAO e o vendedor — e imprimi-lo seria fabricar um vendedor recorrente que nao existe.

### Lote, preco por item desconhecido

Duas situacoes, e nenhuma produz numero inventado. Nunca o total, nunca media. A media esta reprovada por medicao: no lote real ela daria 2.130,33 para itens de 4.200, 941 e 1.250; na varrida de 40 (0xc568b5ba) ela erraria quase todos e apagaria a dispersao inteira, que ia de 300 a 429,69.

A — LOTE PARCIALMENTE PRECIFICADO (marketplace sem decodificador conhecido cobrindo parte dos itens). Cada item mostra o preco da SUA ordem, que e verdadeiro independente dos vizinhos; os sem ordem saem sem numero; e o TOTAL some da linha Batch, porque total so existe quando os N fecham.

┌──────────────────────────────────────────────────────────
│ **Ronkeverse #4231 sold**
│
│ Price                                    Buyer               Seller
│ price not published by this bot for       `0xabcd…1234`       `0x9876…4321`
│ this sale — open the transaction
│
│ Batch
│ 1 of 4 Ronkeverse in this transaction · 3 of 4 priced
│
│ [ imagem grande do #4231 ]
│ Ronin
└──────────────────────────────────────────────────────────

Os outros tres embeds da mesma varrida saem com preco normal e a MESMA linha Batch ('2 of 4 … · 3 of 4 priced'). A degradacao e por ITEM, nao por transacao: um log ilegivel apaga um numero, nao quatro.

B — PAGAMENTO EM MOEDA QUE O BOT NAO PRECIFICA (o paymentToken declarado NA ORDEM nao e WRON nem RON nativo):

│ Price                                    Buyer               Seller
│ not shown — paid in a token this bot      `0x3f86…014d`       `0x1c0e…8b21`
│ does not price — open the transaction
│ Batch
│ 1 of 10 Ronkeverse in this transaction · 0 of 10 priced

ATENCAO — ESSE CASO E MAIS RARO DO QUE PARECE, E ISSO E DE PROPOSITO. O criterio e o paymentToken DA ORDEM, nunca o token que saiu da carteira. Nas tres transacoes que pareciam exigir esse texto (0xd2bb0c2e em WETH, 0x8d2c45a1 em $RONKE, 0x34f2fc2b em USDC) a ordem declara WRON nas tres: o token exotico era so a perna de financiamento, trocada por WRON no meio do caminho. Elas saem COM numero. Um portao de moeda baseado na carteira publicaria 'this bot does not price' sobre venda cotada em WRON — frase falsa, e pela mesma raiz do bug original: a carteira responde sobre a transacao, a ordem responde sobre o item.

POR QUE O TEXTO FALA DO BOT E NAO DA MARKETPLACE. A frase tentadora — 'this marketplace doesn't publish a per-item price' — e uma afirmacao sobre um terceiro que o bot nao tem como sustentar. No dia em que a Axie atualizar o proxy 0x3b3adf14 e o checksum passar a falhar, o bot estaria dizendo que a Ronin Market nao publica preco por item enquanto a propria Ronin Market mostra o preco na tela. O texto tem que falar do que o bot sabe.

INTERNAMENTE SAO DOIS ESTADOS DIFERENTES, mesmo com texto igual pro membro: 'sem-decodificador' (topic0 desconhecido — normal, silencioso) e 'checksum-falhou' (topic0 conhecido que nao decodificou — console.warn OBRIGATORIO com hash e topic0). So o segundo e sinal de que algo quebrou. Do lado de fora 'o decoder quebrou' e 'a marketplace ficou quieta' sao indistinguiveis, e num repo de uma pessoa so o log do Actions e o unico alarme que existe.

CASO C — nada saiu da carteira e nenhuma ordem cita o item (`pago === 0n` e mapa vazio): continua SEM ANUNCIO NENHUM, como hoje. E o que segue ignorando consolidacao de carteira — a tx 0x3f835be8 move 20 NFTs, tem zero eventos de ordem e zero pagamento. Silencio nao e mentira.

## Testes exigidos

- COMO TESTAR CONTRA A TRANSACAO QUE PRODUZIU O BUG — 0x50f41a12d49471d4a8e36286a5da99ee52987a2546997b66be0cbee58d014da9, bloco 59577501. Nao precisa esperar venda nova nem mexer em webhook: a faixa de um bloco so reproduz o caminho inteiro. `node teste.js` depois de cada passo, e no passo 4 os tres NFTs tem que sair 4200 / 941 / 1250 onde hoje saem 6391 / 6391 / 6391.
- REPRODUZIR O BUG ANTES DE CONSERTAR (faca isso primeiro, com o codigo como esta, pra ter o antes): `import { transferencias, detalheDaVenda } from './lib/ronin.js'` e rodar `await transferencias(59577501, 59577501)` — devolve exatamente 3 itens (ids 2985, 2986, 5086) com UM unico hash. Passar cada um por detalheDaVenda e imprimir montaEmbed: os tres saem com preco 6391, moeda RON, marketplace null, campo '**6,391 RON**' e rodape 'Ronin'. Guarde essa saida; ela e o baseline contra o qual o passo 4 e julgado.
- PASSO 3 E NEUTRO — a prova: `node teste.js` tem que continuar dando 420 / 375 / 370, mesma marketplace, mesmo comprador, mesmo vendedor, e o contra-exemplo do 0x…dead continua sem virar venda. Se qualquer um desses numeros mudar, o refactor de agrupamento mexeu em algo que nao devia e o passo 4 nao pode comecar.
- PASSO 3, PROVA DO AGRUPAMENTO: rodar sobre 0x50f41a12 e contar chamadas de RPC. Tem que cair de 6 (2 por transferencia, lib/ronin.js:179-182) para 2. Sobre 0xc568b5ba (40 NFTs) cai de 80 para 2 — e esse e o numero que importa contra os 100 req/min publicados, porque rodar.js faz isso de minuto em minuto.
- PASSO 4, A ASSERCAO DECISIVA — nao e 'o preco por item parece plausivel', e 'a soma dos itens bate ao wei com o tx.value'. Confirmei ao vivo: 0x50f41a12 soma 6391 e tx.value = 0x15a74f11f07e17c0000 (6391); 0x15c15b7c soma 919.96 = tx.value; 0xc568b5ba soma 15138.315 = tx.value. Comparar em BigInt, nunca em Number — em Number a varrida de 40 imprime 15138.314999999999. Esta assercao pega erro de decodificacao silencioso, que nenhuma inspecao visual pega.
- PASSO 4, PROVA DE QUE A DEGRADACAO E POR ITEM: corromper o log #4 do recibo de 0x50f41a12 de tres jeitos (trocar um valor de repasse, trocar um ponteiro, truncar o data) e conferir que nos tres o #2985 sai sem numero e o #2986 e o #5086 continuam saindo 941 e 1.250 certos. Um upgrade do proxy tem que apagar um numero, nunca inventar outro nem derrubar os vizinhos.
- PASSO 4, PROVA DA CORRECAO DO CHECKSUM (a que os ceticos acharam): 0xe697bebe15f974e0f58a0b2fe7d10238129a300264353377b4f5204b91b0998e e 0x13bccf995797b6a5b328b39ba870c95d55df9441c69cceba04f4301487bdd689 tem que DECODIFICAR SEM ERRO. Medi: soma = precoTaker nas duas, mas basePrice difere (44x na primeira). Se o teste falhar aqui, o checksum voltou a exigir basePrice e o bot passou a descartar listagem de preco decrescente como se fosse upgrade quebrado.
- PASSO 4, PROVA DA GUARDA DE ESCROW: 0x7ceee5b8100471cc370bec2da337bea7d126c113a0b997d41e9d7a756c29bd6c tem que produzir 3 anuncios a 150 RON e NENHUM embed pode conter a string '0x3ef2'. Medi ao vivo: os tres Transfer saem de 0x3ef234bc2a04d86f6041e419458d9acbd077f2c1, que e o proprio emissor do evento. Sem a guarda, esse endereco vira o vendedor mais recorrente do canal.
- PASSO 4, PROVA DE QUE A MOEDA VEM DA ORDEM E NAO DA CARTEIRA: 0xd2bb0c2e (WETH), 0x8d2c45a1 ($RONKE) e 0x34f2fc2b (USDC de 6 casas) tem que sair COM numero, em RON — porque o paymentToken declarado nas ordens e WRON nas tres. Se sairem 'not shown', o portao de moeda foi implementado olhando a carteira do comprador, que e a raiz do bug original.
- PASSO 4, OS CONTRA-EXEMPLOS: 0x3f835be8d379c73187cd3ae0e99a8fbdb95b655878940517c2baf0182849a169 (20 NFTs, consolidacao de carteira) tem que produzir ZERO anuncios — o gate de 'nem pagamento nem ordem' sobreviveu. E 0x60b530b8e6ca949e1e6030e6290efa6eee59a9d489b664757a45a32b0ed7d452 tem que CONTINUAR saindo com 406,8 no #3973, provando que nenhum portao novo engoliu o caminho feliz.
- PASSO 4, PROVA DO AGRUPAMENTO POR COMPRADOR: 0x0906c5395c8bfc676a9ab19636902946636440eb6b9b1a5533c70126f4699495 tem 3 NFTs e 3 compradores diferentes (310.03 / 310.02 / 310, medido). Os tres embeds tem que sair SEM campo Batch e nenhum deles pode conter a string '930'. Repetir em 0xf5ef853623891951220d4cee6b549fc3fb56b6cc6b447a423ea6a1798b15bc18 (nao pode conter '560') e 0xc5a5aa466c5792a4b26e55f53c0a49badedba7b20a5c8749397c6ed1b836f576 (nao pode conter '347').
- PASSO 4, FIDELIDADE DE FORMATACAO: #2645 tem que imprimir '269.676' e nao '269.68'; a varrida de 40 tem que somar '15,138.315'. Sao 36 dos 361 itens da amostra (10%) que hoje saem com numero diferente do real — e o README ja registra que arredondar quebrou a confianca do canal uma vez.
- PASSO 5: simular 429 do Discord (webhook falso que responde 429 com retry_after) e conferir que o anuncio e reenviado e nao descartado. Hoje lib/discord.js:114-120 devolve false e a venda some, e ciclo.js:56-61 grava o bloco mesmo assim.
- PASSO 6: rodar duas instancias em paralelo apontando pro mesmo KV (e o cenario real do cron da Vercel junto com o Actions) e conferir que cada (tx, tokenId) sai UMA vez. Depois derrubar o KV no meio de um lote e conferir que o ciclo NAO morre — a dedup falha aberto, o anuncio sai, e no maximo repete.
- ULTIMO — `node rodar.js --seco` numa janela real da cadeia, lendo a saida linha a linha antes de qualquer post. E a unica coisa que o dono ve antes de publicar, e depois do passo 3 ela precisa mostrar o contexto do grupo, nao so o item.

## O que NAO resolve

- A PERNA DE DEPOSITO DA OFERTA POR ATRIBUTO continua sem anuncio. Na tx 0x83f9fe44 (e na 0x8acdb477) o vendedor deposita os NFTs no contrato 0x3ef234bc, o dinheiro do ofertante vai pra marketplace, e nenhum topic0 conhecido aparece (sao 0x0306217c, 0x5ab769b1, 0x33685a13, 0xcc2c6816, 0x58e509cc). Nada e anunciado ali. A venda so aparece no canal na perna de ENTREGA, tres blocos depois, com o preco certo e o Seller como 'escrow'. Nao piora nem melhora o que existe hoje, mas o vendedor real fica fora do anuncio.
- O TOTAL DA LINHA BATCH E SOMA DE ORDENS, e ordens sao o que a marketplace declarou. Se um dia um roteador aceitar msg.value a mais e devolver troco por chamada interna (que nao gera log), a soma das ordens continua certa mas nao vai bater com o tx.value — e a assercao (B) do teste vai falhar num caso legitimo. Isso e o comportamento desejado (falhar o teste e melhor que publicar calado), mas alguem vai precisar decidir caso a caso.
- MARKETPLACE NOVA QUE VENDA EM LOTE passa a produzir anuncio SEM preco ate alguem escrever o decoder. E regressao visivel em relacao ao 'sempre sai um numero' de hoje, e e o preco de nao mentir. Venda de 1 NFT numa marketplace nova continua saindo COM numero pelo fallback, entao a promessa que ja salvou o bot em producao fica de pe.
- UM UPGRADE DO PROXY 0x3b3adf14 QUE MANTENHA OS CAMPOS COERENTES ENTRE SI E MUDE O SIGNIFICADO passa calado. O checksum protege contra ler lixo, nao contra o significado mudar. O console.warn obrigatorio e o unico alarme, e a suite de regressao pina bytes do passado — ela continua verde pra sempre depois de um upgrade quebrar a leitura do futuro. Nao ha conserto barato pra isso; ha so a consciencia de que existe.
- UM POST POR NFT NUM SWEEP DE 40 SAO 40 EMBEDS SEGUIDOS. O passo 5 impede a perda, nao a parede. A convencao do ecossistema (um post por transacao) resolveria, mas troca o formato de TODOS os anuncios — e uma decisao de produto que eu deixei fora de proposito, porque acoplar ela a este conserto atrasa o conserto ate o debate fechar.
- A DEDUP TEM JANELA DE 24h NO KV e nao existe de verdade em modo arquivo dentro do GitHub Actions (.gitignore:4 + runner descartado). Cobre crash e cron duplo, que sao os dois furos confirmados. Nao e dedup permanente e nao deve ser vendida como tal.
- O RECEBEDOR DO NFT PODE SER UM CONTRATO (vault, agregador). O anuncio vai dizer que um contrato comprou. Isso ja e verdade hoje, item a item; nao muda.
- A COBERTURA DE 361/361 VEM DE AMOSTRA RECENTE — 240 transacoes. Uma marketplace que a colecao usou ha meses e parou de usar nao esta representada, e um decoder que nunca viu esse formato vai degradar pro lado seguro sem ninguem saber que existe um quinto formato.
- OS ANUNCIOS JA PUBLICADOS NAO TEM CONSERTO POR CODIGO. O bot nao edita nem apaga o que postou; o estado inteiro e um escalar (lib/estado.js:26). A retratacao manual do passo 7 e obrigatoria, senao o piso continua envenenado com o bot ja correto.

## FALHAS QUE OS CETICOS PROVARAM (cada uma tem que estar tratada)

### [FATAL] O gatilho-uniao faz o bot anunciar a perna de ENTREGA do escrow com o contrato da marketplace no campo Seller e um "450 RON total" que nao existe no recibo linkado. O desenho afirma nos RISCOS que esse fluxo continua fora do alcance — a verificacao dele olhou a metade errada das duas transacoes.

**Sequencia:** Bloco 57033821, tx 0x83f9fe44: o vendedor real 0x4dbb38f4 deposita #1548/#1906/#2657 no contrato 0x3ef234bc e 450 WRON saem do ofertante 0xf0229d63 para a marketplace. Medi: nenhum decoder do desenho dispara (topic0s 0x0306217c, 0x5ab769b1, 0x33685a13, 0xcc2c6816, 0x58e509cc) e pago=0 para o "comprador" (=marketplace). Nada e anunciado, correto. DOIS BLOCOS DEPOIS, bloco 57033823, tx 0x7ceee5b8100471cc370bec2da337bea7d126c113a0b997d41e9d7a756c29bd6c: os 3 NFTs vao de 0x3ef234bc para 0xf0229d63, tx.value=0x0, nenhum ERC-20 sai do comprador -> pago=0 -> o bot de HOJE devolve null e nao anuncia. Mas essa tx EMITE 0x4ada96fd (1312 bytes, emissor 0x3ef234bc). Decodifiquei com o layout do proprio desenho: colecao=0x810b6d13 (Ronkeverse), paymentToken=WRON, uint80=150, tokenIds=[1548,1906,2657], 4 repasses = 9 + 2,25 + 22,5 + 416,25 = 450 = 150x3. Ou seja: Decoder 3 dispara, o checksum triplo PASSA, o gatilho-uniao aceita e saem TRES anuncios novos. Preco 150 esta certo; `vendedor` vem de t.de = 0x3ef2…f2c1, o proprio contrato da marketplace. O vendedor de verdade (0x4dbb38f4, 92,5%) esta no ULTIMO par de repasses do mesmo evento, e o desenho proibe explicitamente le-lo de la ("Nao tirar comprador nem vendedor do evento de ordem"). E a linha Batch imprime "· 450 RON total" numa transacao onde tx.value=0 e zero token saiu do comprador: quem clicar no link do titulo (lib/discord.js:48) nao acha os 450 em lugar nenhum. A dedup (tx, tokenId) proposta e cega pra isso — sao dois hashes diferentes, e o pagamento e a entrega vivem em transacoes separadas.

**Conserto:** Antes de aceitar um item vindo do evento, exigir que `t.de` NAO seja o endereco que emitiu o evento de ordem. Quando for (custodia/escrow), tirar o vendedor do ultimo par do array de repasses — que foi 92,5% em 100% das ordens auditadas, inclusive nesta — ou nao anunciar. E travar a linha Batch: o TOTAL so pode ser impresso quando ele for conferivel no recibo (tx.value nativo do comprador, ou soma de ERC-20 saindo do comprador); caso contrario a linha vira "3 of 3 priced in this transaction", sem numero de total.

### [SERIO] A deduplicacao em modo ARQUIVO e apagada pelo proprio gravaBloco na ultima linha de cada ciclo — e em GitHub Actions o arquivo nem sobrevive entre execucoes, porque esta no .gitignore.

**Sequencia:** lib/estado.js:72 faz `writeFile(ARQUIVO, JSON.stringify({ ultimoBloco: n }, null, 2) + '\n')` — sobrescrita total, sem read-modify-write. Rodei a linha ao pe da letra: `{ultimoBloco:100, vistos:["0xabc|2985","0xabc|2986"]}` vira `{ultimoBloco:101}`. O enxerto manda "lista circular de 200 dentro do mesmo .estado.json, com o ponteiro de lib/estado.js:26,52-73 INTACTO" — seguido literalmente, a lista e escrita durante o laco de anuncio (lib/ciclo.js:49-59) e destruida em lib/ciclo.js:61, no mesmo ciclo. Pior: .gitignore:4 lista `.estado.json`, o runner do Actions e descartado e o passo de commit so toca `.sinal` (.github/workflows/vendas.yml:80-90) — em modo arquivo nao ha dedup NEM ponteiro entre execucoes. E o modo arquivo nao e hipotetico: .github/workflows/vendas.yml:61-66 documenta que isso JA ACONTECEU em producao (segredos gravados como UPSTASH_* passados como KV_REST_API_*, chegaram vazios, `usandoKv` virou false calado em lib/estado.js:39). Sequencia: um segredo e renomeado ou expira -> usandoKv=false -> ultimoBloco() devolve null -> lib/ciclo.js:35 faz de = agora-200 -> o bot reanuncia 10 minutos de vendas a cada volta de 60s, agora com precos por item que parecem legitimos, e a dedup que seguraria isso esta no arquivo que gravaBloco acabou de zerar.

**Conserto:** Se a dedup so existe de verdade em KV, entao `usandoKv === false` tem que ABORTAR o ciclo (ou forcar modo seco) com log explicito, em vez de degradar em silencio. Se for pra manter o modo arquivo, gravaBloco precisa ler-modificar-gravar o mesmo JSON e `.estado.json` tem que sair do .gitignore e ser comitado pelo workflow — as duas coisas, nao uma.

### [SERIO] Pôr escrita de KV dentro do laco de anuncio transforma um soluco do Upstash em ciclo inteiro descartado e mata os ~50 minutos de cobertura continua do Actions. Hoje a unica escrita de KV acontece depois de todos os anuncios, entao esse modo de falha nao existe.

**Sequencia:** lib/estado.js:47 (`if (!r.ok) throw new Error(...)`) lanca em QUALQUER resposta nao-ok do KV. umCiclo nao tem try/catch, e rodar.js:39 tambem nao — o `await umCiclo(...)` esta cru dentro do do-while de topo do modulo. Verifiquei o comportamento do Node com o mesmo formato de laco: a primeira rejeicao encerra o processo com exit 1, o do-while nao continua. Sequencia: sweep de 10 NFTs numa tx (0xd2bb0c2e6ab65813b43ace1430a6cede340c6bd7f58ae34bbdd9f6ea60403cb6 e real, 435 a 444 RON cada) -> itens 1..7 postados no Discord -> o SET NX do item 8 leva 429 do Upstash -> kv() lanca -> umCiclo rejeita -> `gravaBloco(agora)` (lib/ciclo.js:61) nunca roda -> em rodar.js o processo morre e os ~48 minutos restantes daquele run se perdem; a corrente so se refaz no passo `chama a proxima execucao` (.github/workflows/vendas.yml:107-111), com o atraso de partida de um run novo. Na volta seguinte o resultado depende de uma ordem que o desenho nunca especifica: se a chave e reivindicada DEPOIS do POST, o item 8 sai em dobro; se e reivindicada ANTES, uma morte entre o SET e o POST some com a venda pra sempre — exatamente o inverso do principio escrito em lib/ciclo.js:10-18 e README.md:77 ("ninguem reclama do que nao viu").

**Conserto:** Especificar a ordem: reivindicar a chave DEPOIS de um POST aceito, nunca antes. E envolver toda chamada de dedup em try/catch que falha ABERTO (deixa o anuncio passar) — a dedup e higiene, nao pode ter poder de derrubar o ciclo. Mais um try/catch por volta em rodar.js:39, para que uma volta ruim nao encerre as 50.

### [SERIO] A dedup e o gatilho da reanuncia dependem da MESMA credencial e do MESMO helper, entao falham juntas: o erro de KV que dispara o replay de 200 blocos e o mesmo erro que desliga a dedup que seguraria esse replay.

**Sequencia:** lib/estado.js:60-64: `ultimoBloco()` engole TODA excecao e devolve null, por desenho, porque nao sabe distinguir "primeira execucao" de "KV quebrado" — o proprio comentario diz que isso e normal. Com null, lib/ciclo.js:35 faz `de = agora - INICIO_SEM_ESTADO` = agora-200. Sequencia: o Upstash devolve 500 (ou estoura cota; a dedup adiciona 1 comando por item ao 1 get + 1 set por ciclo de hoje, a 1 ciclo/minuto) -> ultimoBloco() devolve null SEM NENHUM LOG -> o ciclo varre 200 blocos (~10 min de cadeia) e reanuncia tudo que houve neles -> e cada SET NX de dedup vai pelo mesmo `kv()` (lib/estado.js:41-49), pra mesma instancia que acabou de falhar. Hoje esse replay produz duplicatas obviamente erradas (6.391 tres vezes) que alguem denuncia; depois do conserto ele produz duplicatas com preco certo e linha Batch, indistinguiveis de venda real pra quem le o canal. Isso e profundidade de mercado fantasma — a metrica exata que o desenho existe pra proteger.

**Conserto:** Separar os dois casos em lib/estado.js: `ultimoBloco()` devolve null SO quando a chave nao existe, e RELANCA quando a leitura falhou. No relance, abortar o ciclo com log (`[estado] leitura falhou, ciclo abortado`) em vez de varrer 200 blocos as cegas. O ponteiro fica onde estava e a proxima volta pega tudo — que e o comportamento que o repo ja escolheu de proposito.

### [SERIO] O teto de "~10 itens, posta os primeiros e fecha com um card and N more" descarta permanentemente os pontos de piso que o desenho diz estar defendendo, e nada no bot os revisita.

**Sequencia:** lib/ciclo.js:61 avanca o ponteiro no fim do ciclo independentemente do que foi postado, nao existe fila de repostagem e a chave (tx, tokenId) proposta nao tem estado de "pendente" — so "ja saiu" ou "nao saiu". Sequencia: um sweep de 12 NFTs numa tx -> 10 embeds + 1 card generico -> gravaBloco(agora) -> as 2 vendas restantes nao existem em lugar nenhum e nunca mais serao consideradas, porque o ponteiro ja passou do bloco. O maior sweep PAGO que consegui verificar nesta colecao tem exatamente 10 itens (0xd2bb0c2e...), ou seja, o teto esta cravado no tamanho do caso real que o proprio desenho usa como caso de teste. O enxerto se justifica com "perder anuncio no meio de um lote e perder dado de piso, que e o oposto do objetivo" e em seguida institucionaliza a perda. (Confirmei tambem que o sweep de 20 citado como contra-exemplo, 0x3f835be8, e consolidacao: 20 transferencias, zero decoders, pago=0 — nao entra nessa conta.)

**Conserto:** Suprimir a MENSAGEM, nunca o DADO: o card de fechamento tem que listar tokenId e preco de cada item suprimido. Cabe folgado — o limite do Discord e 25 campos e 6000 chars por embed, e teste.js:110-111 ja assere isso — e um segundo embed na mesma mensagem dobra o espaco. Se ainda assim nao couber, entao o teto tem que gravar os itens pendentes no estado e postar na volta seguinte, e nao simplesmente deixar o ponteiro passar por cima.

### [SERIO] A linha 'Batch i of N in this transaction · TOTAL RON total' agrupa por TRANSACAO, nao por comprador. Numa tx onde um vendedor aceita varios lances de compradores DIFERENTES, cada embed afirma que aquele comprador participou de uma varrida que ele nao fez, e imprime um total que ninguem pagou. O desenho atual acerta o preco e erra o contexto — e o contexto foi justamente o que ele acrescentou para 'ninguem ler o numero isolado errado'.

**Sequencia:** Verificado ao vivo na tx 0xc5a5aa466c5792a4b26e55f53c0a49badedba7b20a5c8749397c6ed1b836f576 (bloco 57969022, Seaport, selector 0x87201b41): o vendedor 0x945feb89 aceita 2 lances numa unica tx. #5821 vai para 0x9955…9197 por 190 RON; #122 vai para 0xac3a…83d7 por 157,05 RON. Sao dois compradores sem relacao. itensNaTx do desenho = 2 (conta todos os Transfer da colecao no recibo), entao o embed de #5821 sai 'Price 190 RON / Batch 1 of 2 in this transaction · 347.05 RON total'. O membro le que o dono de 0x9955 varreu 2 NFTs por 347,05; ele comprou UM por 190, e 347,05 nao e o gasto de ninguem. Hoje o bot imprime so '190 RON' e '157.05 RON' — corretos. Mesmo padrao em 0x0906c5395c8bfc676a9ab19636902946636440eb6b9b1a5533c70126f4699495 (3 NFTs, 3 compradores, 310,03 / 310,02 / 310 → total falso de 930,05) e em 0xf5ef853623891951220d4cee6b549fc3fb56b6cc6b447a423ea6a1798b15bc18. O portao de escopo enxertado nao salva: ele so conta ERC-721 de OUTRA colecao indo PARA o comprador, e na 0x0906c539 os 17 NFTs de outras colecoes vao para enderecos diferentes do nosso comprador, entao o total e impresso do mesmo jeito.

**Conserto:** Agrupar a linha Batch por (tx, comprador), nao por tx: itensNaTx = Transfer da colecao naquela tx CUJO topics[2] e o mesmo comprador, e TOTAL = soma dos precos so desses itens. Com N=1 apos o agrupamento, o campo Batch simplesmente nao aparece (que e o certo nas 3 tx medidas). O agrupamento por `${t.tx}|${t.para}` ja estava descrito nos enxertos — o desenho vencedor so precisa adota-lo para a contagem, nao so para o RPC.

### [SERIO] O gatilho em uniao ('existe evento de ordem citando o tokenId' OU 'saiu dinheiro do comprador') passa a anunciar as ENTREGAS de oferta com escrow, e nelas o campo Seller mostra o contrato da marketplace em vez do vendedor real. O desenho troca silencio por afirmacao falsa sobre quem vendeu — e a propria secao RISCOS afirma o contrario, porque o autor conferiu so a tx de deposito e nao a de entrega.

**Sequencia:** Par verificado ao vivo. Deposito, tx 0x8acdb477deaf77a5c1cecbd8c504414b4fd408ed3e3a44b33489989c5fea9dbc (bloco 57067344): o vendedor real 0x4dbb38f4384c01aff149e0b915c58e3401c37a69 manda #404, #4841 e #6046 para 0x3ef234bc (Ronin Market) e o comprador 0xf0229d63 manda 450 WRON. Topics: 0x33685a13, 0xcc2c6816, 0x5ab769b1, 0x0306217c, 0x58e509cc — nenhum decoder reconhece, pago=0, mudo. Ate aqui o desenho esta certo. Tres blocos depois, entrega na tx 0x6cf948226823b007e03cb10edf34bc3b2f336dd3639f8335dcb05ac15af6482d (bloco 57067347): os 3 NFTs vao de 0x3ef234bc para 0xf0229d63 e o recibo EMITE 0x4ada96fd… (OrderFulfilled antigo) com unit=150 e ids 404,4841,6046 — decoder 3 do desenho, checksum 150x3=450 passa. Como `vendedor = t.de`, saem 3 embeds 'Price 150 RON / Buyer 0xf022…4e98 / Seller 0x3ef2…f2c1' — o Seller e o contrato da marketplace. Na amostra de 240 recibos isso acontece em 11 itens (0x4be19cbf x2, 0x6cf9482268 x3, 0x6de2e51b, 0x7765490b, 0x7ceee5b8 x3, 0x8846e57a), e o endereco 0x3ef2…f2c1 vira o maior 'vendedor' recorrente do canal. Hoje o bot nao publica nada nesses 11.

**Conserto:** Antes de montar o embed, checar se `t.de` (ou `t.para`) e um endereco de marketplace/escrow conhecido. Se for, ou (a) omitir o campo Seller com 'escrow — see transaction', ou (b) resolver o vendedor real lendo o Transfer do mesmo tokenId para aquele contrato (esta 3 blocos atras e o bot ja varre por faixa). O que nao pode e imprimir o contrato como se fosse pessoa. Consertar tambem a secao RISCOS, que afirma 'nada e anunciado' para o fluxo de escrow — medido, e falso na tx de entrega.

### [SERIO] Um post por NFT nao sobrevive ao maior evento real da colecao. Existe varrida de 40 NFTs numa unica transacao; o codigo posta sequencialmente, descarta o anuncio no HTTP 429 sem retry (lib/discord.js:114-120) e avanca o ponteiro de blocos mesmo assim (lib/ciclo.js:56-61) — perda permanente. E o enxerto que tampa isso ('teto de ~10 itens + card and N more') transforma perda aleatoria em perda deliberada de 30 precos por item, que sao exatamente o produto do conserto.

**Sequencia:** Verificado ao vivo: tx 0xc568b5ba075433e46f2b448e937cee46e0adb7b82f17c3eef0fca23aaf3862b8 (bloco 58134061, roteador 0x21a0a1c0), comprador unico 0x413bb2458b, tx.value 15.138,315 RON, 40 NFTs da colecao, todos os 40 com preco por ordem (369 / 429,69 x11 / 360 / 325 / 300 / 375 / 337,69 x11 / 399,995 / 400 / 388 / 399 / 333 …) e a soma fecha ao wei com o tx.value. Sequencia: o ciclo monta 40 vendas, chama anuncia() 40 vezes seguidas no mesmo webhook, o Discord responde 429 a partir de certo ponto, cada 429 vira `return false`, o ciclo so escreve um console.warn e chama gravaBloco(agora) — os itens recusados nunca mais sao tentados. Com o teto de 10 do enxerto, 30 dos 40 precos por item nao sao publicados por decisao. Na amostra, 66 dos 361 itens vendidos (18,3%) estao em transacoes com mais de 10 vendas (uma de 40, uma de 15, uma de 11). O comentario de lib/discord.js:116 ('com o volume desta colecao isto nao deve acontecer nunca') esta medido como falso.

**Conserto:** Nao descartar no 429: honrar `retry_after` do corpo da resposta e reenfileirar; espacar os posts do mesmo lote; e, para lote grande, um unico embed com a lista '#id — preco' por item (formatSweepField do kenryu ja faz isso) em vez de N mensagens — o preco por item continua publicado e o canal recebe 1 post. Se ainda assim algum destino recusar, nao avancar o ponteiro sem registrar os (tx, tokenId) pendentes.

### [MENOR] O formatador continua truncando o preco em 2 casas, e isso desmente 10% dos numeros que o desenho acabou de recuperar com exatidao ao wei. E o mesmo defeito que o README registra como ja tendo quebrado a confianca do canal uma vez (469,69 anunciado como 470) — so que agora em uma casa decimal a mais.

**Sequencia:** precoTexto em lib/discord.js:32-36 usa maximumFractionDigits=2. Medido sobre os 361 itens com preco de ordem: 36 (10,0%) imprimem um numero diferente do real. Exemplos reais decodificados da cadeia: #2645 vale 269,676 e sai '269.68'; #5195 vale 293,988 e sai '293.99'; #1728 vale 287,628 e sai '287.63'; #3388 vale 395,988 e sai '395.99'. Na varrida de 40 o total 15.138,315 sai '15,138.32'. Sequencia: o membro abre a Ronin Market ou o explorer, ve 269,676, ve 269,68 no canal e conclui que o bot arredonda — que e o mesmo julgamento que o README diz ter custado credibilidade, e a credibilidade e o que faz esses numeros valerem como piso.

**Conserto:** Formatar a partir do BigInt em wei, nao de um Number: cortar zeros a direita e imprimir todas as casas significativas restantes (269.676, 15,138.315). Custa uma funcao de string e elimina de vez a classe de bug que ja reincidiu uma vez.

### [MENOR] O texto do campo sem preco afirma um fato sobre a marketplace que o bot nao tem como saber. 'not shown — this marketplace doesn t publish a per-item price' e indistinguivel, do lado de fora, de 'meu decoder quebrou' — e o caminho de degradacao e o MESMO para os dois casos, por construcao do desenho.

**Sequencia:** O gateway 0x3b3adf1422f84254b7fbb0e7ca62bd0865133fe3 e TransparentUpgradeableProxy e ja passou por initializeV2 (a implementacao atual e 0x56b90d7b). Sequencia: a Axie publica um upgrade que desloca uma palavra no OrderMatched; o checksum triplo do desenho falha (e falha certo, degradando para item sem preco); a partir dali toda venda em lote da Ronin Market imprime no canal 'this marketplace doesn t publish a per-item price' enquanto a propria Ronin Market mostra o preco por item na tela. O bot passa a afirmar uma falsidade sobre um terceiro, com a autoridade de quem sempre acertou, e o mantenedor so descobre se estiver lendo o log do Actions. O mesmo texto sai para uma marketplace nova cujo decoder simplesmente ainda nao foi escrito — situacao em que a frase tambem e falsa.

**Conserto:** Trocar por uma frase que fale do bot e nao do terceiro: 'price not published by this bot for this sale — open the transaction'. E separar os dois estados internamente (sem decoder conhecido x decoder conhecido que falhou o checksum), porque so o segundo justifica o console.warn obrigatorio ja enxertado.

### [FATAL] O gatilho em UNIÃO ('existe evento de ordem OU saiu dinheiro') mais o DECODER 3 (topic0 0x4ada96fd) fazem o bot anunciar a ENTREGA de escrow como venda, e nela o vendedor é o contrato da marketplace. O desenho afirma o contrário no próprio registro de riscos ('Vender por oferta com escrow continua fora do alcance... nada é anunciado. Não piora nem melhora o que existe hoje'). Isso é falso e eu medi: são 11 anúncios NOVOS com Seller = 0x3ef234bc2a04d86f6041e419458d9acbd077f2c1. Pior, o decoder 3 cobre só 19 dos 361 itens da amostra, e 11 desses 19 (58% do que ele cobre) saem com vendedor fabricado.

**Sequencia:** Sequência verificada ao vivo (eth_getTransactionReceipt): (1) bloco 57067344, tx 0x8acdb477deaf77a5c1cecbd8c504414b4fd408ed3e3a44b33489989c5fea9dbc — o vendedor real 0x4dbb38f4384c01aff149e0b915c58e3401c37a69 deposita #404, #4841 e #6046 NO CONTRATO 0x3ef234bc (os três Transfer apontam para a marketplace), e 450 WRON vão de 0xf0229d63 para 0x3ef234bc. Aqui `pago` do 'comprador' (=a marketplace) é 0 e nenhum decoder dispara: nada é anunciado, certo. (2) três blocos depois, bloco 57067347, tx 0x6cf948226823b007e03cb10edf34bc3b2f336dd3639f8335dcb05ac15af6482d — logs #9/#11/#13 são os três Transfer com de=0x3ef234bc, para=0xf0229d63, e o log #15 é topic0 0x4ada96fdf5993ba7ebe767e11099cdb1bd14fe57636e904bbd9ae8e1873c442f, emissor 0x3ef234bc, uint80=150, 3 ids, repasses somando 450 (checksum 150x3=450 PASSA). O `pago` do comprador nessa tx é ZERO (o WRON que anda é 0x3ef234bc -> 0xcaf3e62b), então o bot de HOJE devolve null três vezes e fica calado. Com o desenho novo o ramo 'existe evento citando esse tokenId' dispara e saem TRÊS embeds: '#404 sold — 150 RON — Buyer 0xf022…4e98 — Seller `0x3ef2…f2c1`'. O vendedor de verdade (0x4dbb38f4) não aparece em lugar nenhum, e 0x3ef2…f2c1 é justamente um endereço que o próprio lib/ronin.js:70 rotula como 'Ronin Market'. Mesma sequência, mesmos 11 itens, em: 0x7ceee5b8100471cc370bec2da337bea7d126c113a0b997d41e9d7a756c29bd6c (#1548/#1906/#2657 a 150), 0x4be19cbf2304b677bff9ee651f86986e8ee7f4431ffe5cb31310e0b3c76bf7b4 (#2362/#4817 a 250), 0x6de2e51b47caeec884e322a8167998a9e2d02cbf57a3afeeb06c55c45341b99c (#2086 a 386), 0x7765490b266f4e6a13d7a7bc352e8ee31eb4732e06b215bceef71ab351e11799 (#3153 a 350) e 0x8846e57a66fbc3b95786f6d384dc707cff933b49e872c3313795dcc4bc2f2c3f (#5920 a 302). Efeito no canal: 0x3ef2…f2c1 aparece como vendedor recorrente, e quem olha o histórico lê como uma carteira só despejando — quando na verdade são vendedores diferentes cujo NFT passou pelo escrow.

**Conserto:** Antes de aceitar um item, checar se o `de` do Transfer ERC-721 é um endereço de marketplace conhecido (a mesma lista de MARKETPLACES em lib/ronin.js:68-80, que o desenho já passa a consultar pelo emissor do evento). Se for, é entrega de escrow e não a venda: ou (a) não anunciar, mantendo o silêncio de hoje, ou (b) recuperar o vendedor real do primeiro uint256[]/tupla do evento 0x4ada96fd, que carrega o maker da ordem — mas só depois de verificar que o maker ali não troca de papel como troca no OrderMatched (kind=0 vs kind=1, já documentado no dossiê). A opção segura e barata é (a). O mesmo teste vale espelhado: se o `para` do Transfer for marketplace conhecida (o depósito, tx 0x8acdb477), nunca tratar esse endereço como comprador.

### [SERIO] A linha 'Batch — i of N in this transaction · TOTAL RON total', que o desenho criou justamente para dizer a verdade sobre o contexto, publica um agregado monetário que NINGUÉM pagou quando a transação tem mais de um comprador. `itensNaTx` conta itens da coleção na TRANSAÇÃO, não por comprador, e o padrão 'um vendedor aceita várias ofertas de uma vez' produz exatamente isso: N compradores independentes numa tx só. É um número inventado chegando ao embed — a classe de defeito que o desenho inteiro existe para eliminar — e o portão de escopo enxertado (que conta NFTs de outras coleções indo PARA O MESMO COMPRADOR) não pega, porque os outros NFTs vão para outros compradores.

**Sequencia:** Sequência verificada ao vivo: tx 0x0906c5395c8bfc676a9ab19636902946636440eb6b9b1a5533c70126f4699495, bloco 59034154 (2026-07-31T22:31:35Z), tx.to = Seaport 0x0000000000000068f116a894984e2db1123eb395, tx.value = 0. O signatário 0xc0e12721b5d111ade1043d8f95b4b5297ecab50d é o VENDEDOR dos três e aceita três ofertas de coleção numa transação: log #61 #6006 -> 0x445566795544c9bc72fa6175d2f1ddb3fb378159 por 310,03; log #63 #2845 -> 0x0dc5e2954183730c67f3f5d48bd9c9b6b7e5d71f por 310,02; log #65 #6077 -> 0x4dbb38f4384c01aff149e0b915c58e3401c37a69 por 310. Três compradores distintos, cada um pagou ~310 (conferi: o `pago` de cada carteira bate exatamente com o preço da sua ordem). A mesma tx ainda move 17 NFTs de três outras coleções, mas para outros compradores. O desenho monta itensNaTx=3 e imprime nos TRÊS embeds: '1 of 3 in this transaction · 930.05 RON total'. Ninguém gastou 930,05. E o sentido fica invertido: a linha existe 'pra ninguém ler o 941 isolado e achar que o piso desabou', mas aqui ela sugere uma varrida de 930 quando o fato é um holder despejando três peças em ofertas permanentes — sinal oposto. Repete em 0xf5ef853623891951220d4cee6b549fc3fb56b6cc6b447a423ea6a1798b15bc18 (bloco 58333366, 2026-07-15, 280,06 + 280,05, imprimiria '560.11 RON total') e 0xc5a5aa466c5792a4b26e55f53c0a49badedba7b20a5c8749397c6ed1b836f576 (bloco 57969022, 2026-07-07, 190 + 157,05, imprimiria '347.05 RON total'). São 3 das 240 tx amostradas e 7 dos 361 itens; e a estrutura é garantida, não probabilística: toda vez que um vendedor aceitar 2+ lances numa tx, o total sai errado.

**Conserto:** Agrupar por (tx, comprador) e não por tx. `itensNaTx` vira 'itens desta coleção que ESTE comprador recebeu nesta transação', e o TOTAL vira a soma só das ordens dele. Nos três casos acima isso zera o problema: cada comprador tem 1 item, a linha Batch some, e os embeds ficam idênticos aos de venda unitária. Na tx de lote real (0x50f41a12, 1 comprador, 3 itens) nada muda — continua '1 of 3 · 6.391 RON total'. É uma linha de agrupamento e mantém intacto o enxerto que proíbe `pago` de alcançar o embed.

### [SERIO] O CHECKSUM TRIPLO do decoder 1 está errado na premissa. O desenho afirma que soma dos repasses, preço do taker e basePrice são 'três leituras independentes do mesmo número dentro do mesmo log'. Não são: basePrice é o preço INICIAL de uma listagem com preço decrescente, e endedPrice é o piso dela. Em listagem de preço fixo os três coincidem (foi o que a validação de 204 ordens da Ronkeverse mediu — mas a Ronkeverse só usou preço fixo até hoje, é acidente do hábito da coleção, não propriedade do evento). Em leilão decrescente basePrice != preço executado POR CONSTRUÇÃO, e o desenho descarta um log perfeitamente legível.

**Sequencia:** Medido em 690 eventos OrderMatched (topic0 0x109cee1a…, emissor 0x3b3adf1422f84254b7fbb0e7ca62bd0865133fe3) colhidos ao vivo nos blocos 59580417–59583216: entre os 306 que são ERC-721 puro (quantidade=0, kind=1 — exatamente a forma de uma venda Ronkeverse), 41 (13,4%) têm endedAt>0 e endedPrice!=basePrice, e nos 41 vale soma(repasses)==precoTaker mas != basePrice. Exemplos: 0xe697bebe15f974e0f58a0b2fe7d10238129a300264353377b4f5204b91b0998e (basePrice 0,02 decaindo para 0,00045 em 24h; executado 0,00045 — 44x de diferença entre o campo do checksum e o preço real), 0x13bccf995797b6a5b328b39ba870c95d55df9441c69cceba04f4301487bdd689 (0,015 -> 0,012 em 168h; executado 0,014122276785714287), 0x6c4fc9634736c8800a0a52d55fe3cb8a7326ed24832462c6af78f7fa7f340464 (0,001715209290822857 -> 0,001559281173475325 em 8h) e 0xc4a51f1a1fa228a5abd64bc1d641370dc0f8f1bf9dd22453578e7b75f27ef18c (0,0008 -> 0,0003 em 1200h; executado 0,000775660185185186). Sequência para a Ronkeverse: um holder lista #1234 com preço decrescente de 500 para 300 RON em 24h; um comprador leva por 412 RON; o gateway emite OrderMatched com basePrice=500, endedPrice=300, precoTaker=soma(repasses)=412; o desenho roda `soma !== basePrice` e DESCARTA o log; o item cai na REGRA 2 e sai '**not published**'; e, pelo enxerto que promoveu o console.warn a requisito, o mantenedor vê 'checksum falhou' no log do Actions e conclui que o proxy 0x3b3adf14 foi atualizado — quando nada quebrou. Nas 204 ordens Ronkeverse do cache: 0 leilões decrescentes, então isso ainda não aconteceu com esta coleção; mas é o mesmo contrato, o mesmo topic0, a mesma struct de Order, e a opção de listagem é da marketplace, não da coleção. Na janela amostrada só vendedores de Axie (0x32950db2…) usaram esse tipo de listagem.

**Conserto:** Tirar basePrice do checksum. As duas leituras que são de fato do preço executado — soma(array de repasses) e o preço pago pelo taker (byte bargain+32) — continuam sendo checagem cruzada e bateram em 100% dos 306 casos ERC-721 (inclusive nos 41 decrescentes). Se quiser manter uma terceira validação, use a relação correta: exigir `endedPrice <= soma <= basePrice` quando endedAt>0, e `soma == basePrice` só quando endedAt==0. Bônus: ler endedAt/endedPrice (order+224 e order+256) permite o embed dizer que foi leilão decrescente, o que é informação verdadeira sobre o piso.

### [MENOR] O único protótipo do desenho vencedor (scratchpad/precos.mjs, funcao precosPorItem) já diverge do desenho no ponto em que o desenho é mais enfático: ele faz `porItem = r.total / BigInt(r.itens.length)` — uma MÉDIA dentro da ordem — em vez de ler o uint80 de preço unitário que o próprio desenho especifica para o decoder 3 ('Em T1: … +224 = o uint80 que é o PRECO UNITARIO'). Hoje o resultado é idêntico porque o checksum do decoder 3 (unitario x n == soma) força uniformidade, então a divisão é exata. Mas é a aritmética proibida sobrevivendo como caminho de código, na única família de eventos em que uma ordem carrega vários tokenIds.

**Sequencia:** Nas 240 tx amostradas existem 5 ordens que carregam mais de um tokenId da coleção, todas do decoder 3: 0xef9f07a41d0f0cbaddc9456bc796f12eb1c77e15152ddb91b3cf779df4416edb (4 ids: 2869, 4276, 6209, 6273; total 480), 0x6cf948226823b007e03cb10edf34bc3b2f336dd3639f8335dcb05ac15af6482d (3 ids, total 450), 0x7ceee5b8100471cc370bec2da337bea7d126c113a0b997d41e9d7a756c29bd6c (3 ids, total 450), 0x4be19cbf2304b677bff9ee651f86986e8ee7f4431ffe5cb31310e0b3c76bf7b4 (2 ids, total 500) e 0xd7b5f101b06b46294e25149dfee871cc5143a735f5f53b42aa4a46c9b6904b36 (2 ids, total 390). Em todas o preço por item sai de 480/4=120, 450/3=150 etc. — certo por acidente. A sequência que quebra: no dia em que a marketplace antiga (ou um decoder futuro escrito no mesmo molde) emitir uma ordem cujos itens tenham preços diferentes, a divisão passa a produzir uma média silenciosamente, com a mesma cara de número confiável e com fonte:'ordem' — passando pela trava de proveniência que o painel enxertou, que só proíbe valores originados de `pago`. Além disso a divisão é BigInt e trunca: se algum dia o total não for divisível pelo número de itens, cada item perde wei e a asserção de regressão 'soma dos itens == tx.value' falha sem que ninguém saiba por quê.

**Conserto:** No decoder 3, atribuir o uint80 lido em T1+224 diretamente a cada tokenId, como o desenho manda, e manter `unitario * n == soma(repasses)` só como checksum. Nos decoders 1 e 2, em vez de dividir, recusar a ordem se ela citar mais de um item da coleção (não existe nenhuma na amostra: 0 em 204 OrderMatched e 0 em 94 Seaport) e emitir o console.warn — ordem com preço agregado não tem preço por item, e o desenho já decidiu que nesse caso o item sai sem número. Estender a trava de proveniência do teste: fonte 'ordem' só é aceita quando a ordem citou exatamente 1 item da coleção OU trouxe preço unitário explícito.
