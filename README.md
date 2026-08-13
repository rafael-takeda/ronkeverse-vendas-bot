# Bot de vendas do Ronkeverse

Anuncia no Discord cada venda do [Ronkeverse](https://explorer.roninchain.com/token/0x810B6d1374ac7BA0E83612E7d49F49A13f1de019) na Ronin, com imagem, preço e link.

Sem chave de API, sem SDK, sem dependência: só o RPC público da Ronin e um webhook do Discord.

## Como ele sabe que foi uma venda

O Ronkeverse é vendido em pelo menos dois lugares, e eles liquidam de formas diferentes:

| | OpenSea (Seaport) | Ronin Market |
|---|---|---|
| Contrato | `0x0000…eb395` | `0x3ef2…f2c1` |
| Pagamento | RON nativo, no `value` da tx | WRON (ERC-20), `value` = 0 |

Reconhecer venda por lista de marketplace seria um bot que quebra calado quando aparecer a terceira. A regra usada é outra e vale pras duas:

> **O comprador é quem recebeu o NFT. Que saiu dinheiro da carteira dele é o que PROVA que houve venda** — e é isso que faz o bot sobreviver a uma marketplace nova. **QUANTO custou cada item vem do evento de ordem do próprio recibo**, casado por tokenId. Quando a ordem não dá pra ler, o item sai sem preço: preço incompleto é conferível, preço errado envenena o piso.

Isso também mata o falso positivo de graça: quem move um NFT entre as próprias carteiras não paga nada a si mesmo, então o bot ignora sozinho.

A separação entre as duas perguntas é recente e custou caro — ver *Detalhes que custaram tempo*.

## Provar que funciona

```bash
node teste.js
```

Roda contra **três vendas reais** já registradas na cadeia (uma da OpenSea, duas da Ronin Market) e confere se a regra reproduz os preços que elas de fato tiveram: 420, 375 e 370 RON. Confere também o contrário — uma carteira que não pagou nada não pode ser lida como compradora — e monta o embed que o Discord vai receber.

Depois vêm os **lotes**: a transação que produziu o bug de 13/08 (três NFTs, 4.200 / 941 / 1.250), a varrida de 40 NFTs numa transação só, a entrega por escrow (em que quem mandou o NFT **não** é o vendedor) e a transação em que três compradores distintos aparecem juntos. A asserção que pega erro silencioso é a soma dos itens fechar **ao wei** com o `value` da transação — em `BigInt`, porque em `Number` a varrida de 40 imprime `15138.314999999999`.

```bash
node teste_precos.js
```

Prova só o decodificador de ordem, isolado — inclusive corrompendo um log de propósito, pra confirmar que um item ilegível apaga **um** número e não quatro. Existe pra que uma falha lá na frente seja respondível: com este verde, o problema é plumbing e não decodificação.

Se alguma marketplace mudar o jeito de liquidar, é aqui que aparece primeiro.

```bash
node rodar.js --seco
```

Faz uma passada de verdade na cadeia, mostra o que anunciaria e **não posta nem grava nada**.

## Publicar

### 1. O webhook do Discord

No canal de vendas: **Editar canal → Integrações → Webhooks → Novo webhook**. Copie a URL.

Trave o canal pra só o webhook escrever. Um canal de vendas onde qualquer um posta é um canal que empresta sua credibilidade pro golpista.

> **A URL do webhook é senha.** Quem tiver ela posta no seu canal com o nome e a foto do bot — o cenário perfeito pra um link de golpe com cara de oficial. Ela nunca entra no repositório e nunca vai por chat: só como variável de ambiente.

### 2. A memória entre execuções

O bot precisa lembrar até que bloco já anunciou, senão repete tudo a cada passada. Crie um Redis grátis no [Upstash](https://upstash.com) (ou o KV da própria Vercel) e guarde as duas variáveis:

```
KV_REST_API_URL=
KV_REST_API_TOKEN=
```

Sem elas o bot cai num arquivo local. Isso serve pra testar na sua máquina e **não serve em serverless**: lá o disco morre junto com a execução, e o canal receberia as mesmas vendas de minuto em minuto. O modo em uso sai no log (`"estado": "kv"` ou `"arquivo"`) justamente pra esse sintoma ter uma pista.

### 3. Onde ele roda

**GitHub Actions — grátis, e é o que eu recomendo.** Já está pronto em `.github/workflows/vendas.yml`, de 5 em 5 minutos. Suba o repositório e cadastre em *Settings → Secrets and variables → Actions*: `DISCORD_WEBHOOK`, `KV_REST_API_URL`, `KV_REST_API_TOKEN`.

**Vercel — só no plano Pro.** O `vercel.json` pede uma passada por minuto, e [o plano Hobby só aceita cron diário](https://vercel.com/docs/cron-jobs/usage-and-pricing): o deploy **falha** com `Hobby accounts are limited to daily cron jobs`. No Pro, publique e cadastre as mesmas variáveis mais `CRON_SECRET` (que protege a rota de quem descobrir a URL).

De 5 em 5 minutos é de sobra: esta coleção passou 13 horas sem uma única transferência.

## Detalhes que custaram tempo

**O total da transação virou "Price" de três NFTs.** Em 13/08/2026, na tx `0x50f41a12`, alguém comprou #2985, #2986 e #5086 de uma vez por 4.200, 941 e 1.250 RON. O bot somava tudo que saía da carteira do comprador e chamava aquilo de preço — então o canal recebeu **6.391 RON três vezes**, cada um ao lado da arte de um NFT diferente. O número estava certo para a pergunta "quanto essa carteira gastou" e errado para a pergunta que o rótulo fazia. Hoje o pagamento é só o GATILHO; o preço de cada item sai do evento de ordem do recibo, casado por tokenId.

**O item sai sem número, nunca com um número alternativo.** O preço por item é recuperável em 361/361 itens da amostra, e é por isso que o bot lê a ordem. Mas o gateway `0x3b3adf14` é um `TransparentUpgradeableProxy` que já passou por um `initializeV2`: um dia ele muda e a leitura para de casar. Nesse dia a degradação correta é o campo dizer *price not published by this bot for this sale* — não a média, não o total, não o preço do vizinho. Média e total têm cara de dado confiável e envenenam o piso em silêncio; um campo vazio, não.

**O RPC público responde 403 pro User-Agent padrão de biblioteca.** Tem que mandar um de navegador — descoberto levando 403 no Python enquanto o `curl` passava.

**`eth_getLogs` aceita no máximo 200 blocos por chamada**, e recusa com erro em vez de truncar. Irrelevante pra este bot (um minuto de Ronin são ~20 blocos) e fatal pra varrer histórico — por isso o bot nunca varre histórico.

**Na primeira execução ele só olha 200 blocos pra trás.** Sem isso, estrear o bot despejaria as vendas da semana passada no canal como se fossem de agora.

**"Vendedor" é quem mandou o NFT, não quem recebeu o dinheiro.** Na Ronin Market o pagamento vai pra um contrato divisor que reparte depois — mostrar esse endereço como vendedor seria tecnicamente verdade e completamente inútil pra quem lê.

**Anuncia primeiro, avança o ponteiro depois.** Uma falha no meio faz a próxima passada tentar de novo. O risco oposto seria perder vendas em silêncio — e ninguém reclama do que não viu. A dedup por `(tx, tokenId)` estreita a repetição sem inverter a escolha: ela é reivindicada **depois** de um POST aceito e falha aberto, então nunca some com uma venda.

**Os anúncios já publicados não têm conserto por código.** O bot não edita nem apaga o que postou — o estado inteiro é um escalar. A retratação dos preços errados de 13/08 (#2985 = 4.200, #2986 = 941, #5086 = 1.250) e de 11/08 (#2432 e #4707 = 459,98 cada, tx `0x15c15b7c`) tem que ser postada **à mão**. Sem isso o piso continua envenenado mesmo com o bot já correto.

## Arquivos

```
lib/ronin.js     ler a cadeia e reconhecer venda   (o miolo)
lib/precos.js    quanto custou CADA item, lido do evento de ordem
lib/discord.js   montar e postar o anúncio
lib/estado.js    até que bloco já foi anunciado, e o que já saiu
lib/ciclo.js     uma passada completa
rodar.js         gatilho de terminal e do GitHub Actions
api/vendas.js    gatilho da Vercel
teste.js         a prova, contra vendas reais
teste_precos.js  a prova do decodificador de ordem, sozinho
```
