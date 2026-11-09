# Projeto técnico · Agente de IA para WhatsApp (clínicas odontológicas)

Agente que atende pacientes pelo WhatsApp, principalmente fora do horário comercial: recebe texto e áudio, faz triagem de urgência, orienta com segurança em emergências e agenda consultas de forma autônoma num sistema de agendamento próprio, com reflexo em tempo real no painel da doutora.

| Documento | Conteúdo |
|---|---|
| [01 · Arquitetura e Tech Stack](./01-arquitetura.md) | Componentes, stack recomendada, pipeline de mensagens, modelo de dados, anti-overbooking, tempo real, segurança e LGPD |
| [02 · Fluxo Conversacional](./02-fluxo-conversacional.md) | Níveis de urgência, máquina de estados, interrupções globais, exceções e mensagens-modelo |
| [03 · System Prompt](./03-system-prompt.md) | Prompt do LLM (personalidade + regras de triagem), definição das tools e guardrails |
| [04 · API de Agendamento](./04-api-agendamento.md) | Endpoints REST, autenticação/escopos, eventos em tempo real, erros e LGPD |

## Decisões principais

1. **Code-first em TypeScript** (Fastify + PostgreSQL + Redis/BullMQ + React), não n8n/Typebot como núcleo.
2. **WhatsApp Business Cloud API oficial** — nada de bibliotecas não-oficiais com dados de saúde.
3. **LLM conversa e classifica; código decide.** Máquina de estados explícita, tools liberadas por estado, red flags determinísticas que só elevam a urgência.
4. **Emergência nunca é agendada:** mensagem fixa revisada pela doutora, SAMU 192 e alerta ao plantão.
5. **Overbooking impossível no banco:** `EXCLUDE USING gist` + reserva em duas fases (hold → confirm) + `Idempotency-Key`.
6. **Tempo real via Transactional Outbox + SSE** para o dashboard.
7. **LGPD por padrão:** dados mínimos, criptografia de campo, PII fora de URLs e logs, áudio descartado após transcrição, RLS multi-clínica, auditoria.

## Pontos que precisam de validação com a doutora

- Lista final de red flags e mensagens fixas de emergência (texto clínico deve ser aprovado por ela).
- Quantos horários de encaixe de urgência reservar por dia.
- Se haverá plantão (quem recebe o alerta fora do horário e em quanto tempo responde).
- FAQ de preços/convênios que o bot pode responder.
- Suite de ≥ 200 casos de triagem rotulados por ela antes do piloto.
