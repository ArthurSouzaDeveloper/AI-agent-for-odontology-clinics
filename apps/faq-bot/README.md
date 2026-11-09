# faq-bot · atendente de dúvidas no WhatsApp (24h)

Responde horário de funcionamento, preços e dúvidas de um comércio pelo WhatsApp, mesmo com o celular do dono desligado. **Só tira dúvidas: não recebe pedidos** (isso é uma fase futura, integrada ao Gestrest).

## Como o bot decide a resposta

Em ordem, parando na primeira que serve:

1. **Pediu atendente** ("quero falar com o dono") → avisa o dono e diz quando a equipe responde.
2. **FAQ do dono** (perguntas e palavras-chave escritas por ele).
3. **Cardápio** → preço consultado numa tabela, por código ("quanto é o pastel de frango?").
4. **Regras fixas** → horário, "estão abertos?", endereço, entrega, pagamento. O horário é calculado por código com o fuso do negócio.
5. **Claude**, restrito à FAQ: só reformula o que está na base. Se não souber, responde `NAO_SEI` e o bot passa para um humano.
6. **Humano**: nada de chutar. Cliente nunca fica sem resposta.

Preço, horário e endereço **nunca** saem do LLM. O texto do modelo ainda passa por uma barreira que bloqueia números que não estão na base.

## Configuração do Rei do Suco

`src/tenants/rei-do-suco.ts` (horário de quarta a domingo, 18h às 23h30) e `src/menu.ts` (cardápio R/2026).

Já preenchidos pelo dono: horário, endereço, entrega por motoboy próprio e pagamento somente na entrega (débito, crédito e dinheiro; Pix não é aceito).

Taxas de entrega: 117 bairros de Americana e 115 de Santa Bárbara d'Oeste (`src/tenants/rei-do-suco-zones.ts`), com busca por `jd`, `pq` e `vl` (jardim, parque, vila). Se o mesmo nome existe nas duas cidades com valores diferentes, o bot mostra os dois e pergunta a cidade. A chave Pix do rodapé dos PDFs não foi copiada.

Jardim Mollon e Jardim Ferdinando Mollon são o mesmo bairro, taxa de R$ 5,00 (confirmado pelo dono).

**Pendente:** feriados. O bot não inventa: encaminha para um humano.

Para o dono mudar algo sem mexer no código, aponte `BUSINESS_CONFIG_PATH` para um JSON no formato de `BusinessConfig` (relido a cada mensagem).

## Variáveis de ambiente

| Variável | O que é |
|---|---|
| `META_APP_SECRET` | App Secret do app da Meta (valida a assinatura dos webhooks) |
| `META_VERIFY_TOKEN` | Texto que você inventa e cadastra no painel da Meta |
| `META_ACCESS_TOKEN` | Token permanente de um usuário do sistema |
| `META_PHONE_NUMBER_ID` | Id do número no WhatsApp Cloud API |
| `OWNER_WHATSAPP` | WhatsApp do dono, ex.: `5519999990000` |
| `ANTHROPIC_API_KEY` | Opcional. Sem ela o bot funciona sem o passo 5 |
| `FAQ_MODEL` | Opcional. Padrão `claude-opus-5-5`; `claude-haiku-5-5` é bem mais barato |
| `BUSINESS_CONFIG_PATH` | Opcional. JSON editável pelo dono |
| `API_TOKEN` | Opcional (mín. 24 caracteres). Liga `POST /api/reply` para Typebot/Leona |

## Usar por Typebot, Leona ou outra plataforma

Com `API_TOKEN` definido, a plataforma pode chamar o bot por HTTP e ficar responsável por receber e enviar no WhatsApp:

```
POST /api/reply
Authorization: Bearer <API_TOKEN>
{ "text": "entrega no jd ipiranga", "customerId": "5519999990000" }
→ { "type": "text", "text": "A taxa de entrega ...", "handoff": false }
```

`handoff: true` indica que um humano deve assumir; o dono é avisado como no canal direto. Hoje há um negócio por servidor (o configurado em `BUSINESS_CONFIG_PATH`).

## Colocar no ar

1. **Meta:** criar um app em developers.facebook.com, adicionar o produto WhatsApp e uma conta WhatsApp Business. Cada cliente deve ser dono da própria conta.
2. **Número:** um número só funciona na Cloud API depois de cadastrado nela. Confirme na documentação da Meta como o número atual do Rei do Suco convive com o app WhatsApp Business (existe um modo de convivência, com limitações) **antes** de migrar, para ele não perder o atendimento que tem hoje.
3. **Hospedagem:** qualquer serviço que rode Node 22 com HTTPS público (Fly.io, Railway, VPS). `pnpm install && pnpm --filter @app/faq-bot start`.
4. **Webhook:** no painel da Meta, URL `https://SEU_DOMINIO/webhook`, o `META_VERIFY_TOKEN`, e assinar o campo `messages`.
5. **Testar** com o número de teste da Meta antes de ligar o número real.

## Subir no Fly.io (passo a passo)

Precisa de uma conta no Fly.io e do `flyctl` instalado. Há `Dockerfile` e `fly.toml` nesta pasta. Na **raiz do repositório**:

```
fly launch --no-deploy --copy-config --config apps/faq-bot/fly.toml --dockerfile apps/faq-bot/Dockerfile
fly secrets set API_TOKEN="uma-senha-longa-com-24-ou-mais-caracteres" \
  META_APP_SECRET=x META_VERIFY_TOKEN=x META_ACCESS_TOKEN=x \
  META_PHONE_NUMBER_ID=123 OWNER_WHATSAPP=5519999990000
fly deploy --config apps/faq-bot/fly.toml --dockerfile apps/faq-bot/Dockerfile
```

O endereço final é `https://NOME-DO-APP.fly.dev`; confira com `curl https://NOME-DO-APP.fly.dev/health`. Se for usar **só** o Leona/Typebot e não a Meta direto, as variáveis `META_*` podem receber qualquer texto de 10+ caracteres (o servidor exige que existam), e `OWNER_WHATSAPP` fica sem uso até o aviso ao dono ser feito pela plataforma. Mantenha **uma** instância (`min_machines_running = 1`): a proteção contra mensagens repetidas fica em memória.

Railway e VPS servem do mesmo jeito: usam o mesmo `Dockerfile`.

## Limites conhecidos

- **Áudio:** ainda não transcreve; pede que o cliente escreva.
- **Aviso ao dono:** mensagem livre só chega se o dono falou com o número nas últimas 24h. Fora disso a Meta exige um *template* aprovado (a fazer).
- **Deduplicação e limite por cliente** ficam em memória: com mais de uma instância, trocar por Redis.
- **Foto, figurinha e vídeo:** o bot pede texto.

## Testes

`pnpm --filter @app/faq-bot test` (119 testes: horário, webhook, regras, cardápio, Claude simulado, envio).
