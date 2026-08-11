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

> **O comprador é quem recebeu o NFT. O preço é tudo que saiu da carteira dele naquela transação** — seja RON nativo, seja token.

Isso também mata o falso positivo de graça: quem move um NFT entre as próprias carteiras não paga nada a si mesmo, então o bot ignora sozinho.

## Provar que funciona

```bash
node teste.js
```

Roda contra **três vendas reais** já registradas na cadeia (uma da OpenSea, duas da Ronin Market) e confere se a regra reproduz os preços que elas de fato tiveram: 420, 375 e 370 RON. Confere também o contrário — uma carteira que não pagou nada não pode ser lida como compradora — e monta o embed que o Discord vai receber.

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

**O RPC público responde 403 pro User-Agent padrão de biblioteca.** Tem que mandar um de navegador — descoberto levando 403 no Python enquanto o `curl` passava.

**`eth_getLogs` aceita no máximo 200 blocos por chamada**, e recusa com erro em vez de truncar. Irrelevante pra este bot (um minuto de Ronin são ~20 blocos) e fatal pra varrer histórico — por isso o bot nunca varre histórico.

**Na primeira execução ele só olha 200 blocos pra trás.** Sem isso, estrear o bot despejaria as vendas da semana passada no canal como se fossem de agora.

**"Vendedor" é quem mandou o NFT, não quem recebeu o dinheiro.** Na Ronin Market o pagamento vai pra um contrato divisor que reparte depois — mostrar esse endereço como vendedor seria tecnicamente verdade e completamente inútil pra quem lê.

**Anuncia primeiro, avança o ponteiro depois.** Uma falha no meio faz a próxima passada tentar de novo. O risco oposto seria perder vendas em silêncio — e ninguém reclama do que não viu.

## Arquivos

```
lib/ronin.js     ler a cadeia e reconhecer venda   (o miolo)
lib/discord.js   montar e postar o anúncio
lib/estado.js    até que bloco já foi anunciado
lib/ciclo.js     uma passada completa
rodar.js         gatilho de terminal e do GitHub Actions
api/vendas.js    gatilho da Vercel
teste.js         a prova, contra vendas reais
```
