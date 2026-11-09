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

**Pendente, não constava nos materiais:** endereço, entrega (taxa e área), formas de pagamento, feriados. Enquanto vazios, o bot encaminha para um humano.

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

## Colocar no ar

1. **Meta:** criar um app em developers.facebook.com, adicionar o produto WhatsApp e uma conta WhatsApp Business. Cada cliente deve ser dono da própria conta.
2. **Número:** um número só funciona na Cloud API depois de cadastrado nela. Confirme na documentação da Meta como o número atual do Rei do Suco convive com o app WhatsApp Business (existe um modo de convivência, com limitações) **antes** de migrar, para ele não perder o atendimento que tem hoje.
3. **Hospedagem:** qualquer serviço que rode Node 22 com HTTPS público (Fly.io, Railway, VPS). `pnpm install && pnpm --filter @app/faq-bot start`.
4. **Webhook:** no painel da Meta, URL `https://SEU_DOMINIO/webhook`, o `META_VERIFY_TOKEN`, e assinar o campo `messages`.
5. **Testar** com o número de teste da Meta antes de ligar o número real.

## Limites conhecidos

- **Áudio:** ainda não transcreve; pede que o cliente escreva.
- **Aviso ao dono:** mensagem livre só chega se o dono falou com o número nas últimas 24h. Fora disso a Meta exige um *template* aprovado (a fazer).
- **Deduplicação e limite por cliente** ficam em memória: com mais de uma instância, trocar por Redis.
- **Foto, figurinha e vídeo:** o bot pede texto.

## Testes

`pnpm --filter @app/faq-bot test` (80 testes: horário, webhook, regras, cardápio, Claude simulado, envio).
