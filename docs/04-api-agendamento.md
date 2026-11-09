# 04 · Esboço da API de Agendamento

> Parte do projeto técnico do Agente de IA para WhatsApp. Índice em [`docs/README.md`](./README.md).

## 1. Convenções

| Item | Convenção |
|---|---|
| Base URL | `https://api.{dominio}/v1` (versão no path) |
| Formato | JSON, `snake_case`, datas em ISO 8601 **com fuso** (`2026-11-10T09:00:00-03:00`) |
| IDs | Prefixados e opacos (`pat_...`, `apt_...`, `slt_...`, `hld_...`) — ULID/UUIDv7 por baixo |
| Erros | RFC 9457 `application/problem+json` com `code` estável (ex.: `SLOT_TAKEN`) |
| Idempotência | Header `Idempotency-Key` obrigatório em `POST` que criam recursos; resposta repetida por 24 h |
| Concorrência otimista | `ETag` / `If-Match` em `PATCH` (campo `version`) |
| Paginação | Cursor: `?cursor=...&limit=50` → `{ data: [], next_cursor }` |
| Rastreamento | `X-Request-Id` em toda requisição/resposta; aparece no `audit_logs` |
| **PII** | **Nunca em query string ou path** (vai para logs de proxy). Busca por telefone é `POST`. |
| Multi-clínica | `clinic_id` vem do token, nunca do corpo |

## 2. Autenticação e escopos

- **Bot (máquina):** OAuth2 *client credentials* → JWT de curta duração (15 min), audiência `scheduling-api`. Opcionalmente mTLS entre worker e API.
- **Humanos (dashboard):** OIDC (Authorization Code + PKCE) com MFA; papéis `dentist`, `receptionist`, `admin`.
- Toda chamada do bot inclui o header `X-Conversation-Id`; a API amarra a conversa ao `patient_id` e recusa acesso a dados de outros pacientes.

| Escopo | Bot | Recepção | Dentista | Admin |
|---|:-:|:-:|:-:|:-:|
| `availability:read` | ✅ | ✅ | ✅ | ✅ |
| `holds:write` | ✅ | ✅ | ✅ | ✅ |
| `appointments:create` | ✅ | ✅ | ✅ | ✅ |
| `appointments:read:own_conversation` | ✅ | | | |
| `appointments:read` / `:update` | | ✅ | ✅ | ✅ |
| `patients:lookup` / `patients:create` | ✅ | ✅ | ✅ | ✅ |
| `patients:read` (dados completos) | | ✅ | ✅ | ✅ |
| `triage:write` | ✅ | | | |
| `triage:read` / `triage:review` | | 👁 resumo | ✅ | ✅ |
| `conversations:read` (transcrição) | | | ✅ | ✅ (auditado) |
| `alerts:write` | ✅ | | | |
| `schedule:manage` (jornada, bloqueios) | | ✅ | ✅ | ✅ |
| `privacy:admin` (exportar/anonimizar) | | | | ✅ |

## 3. Endpoints

### 3.1 Catálogo

| Método | Rota | Descrição |
|---|---|---|
| `GET` | `/practitioners` | Profissionais ativos (`id`, `display_name`, `specialties`) |
| `GET` | `/services` | Serviços agendáveis (`id`, `code`, `name`, `duration_min`, `allowed_urgencies`, `bookable_by_bot`) |
| `GET` | `/clinic/business-hours` | Horário de funcionamento, feriados, `is_open_now`, `next_opening` (o bot usa para saber se está fora do horário) |
| `GET` | `/clinic/faq` | FAQ aprovada pela clínica (injetada no prompt) |

### 3.2 Disponibilidade

`GET /availability`

| Parâmetro | Tipo | Obrigatório | Nota |
|---|---|:-:|---|
| `service_id` | string | ✅ | Define a duração |
| `urgency_level` | enum | ✅ | `URGENCIA` libera slots de encaixe reservados |
| `from` / `to` | date-time | | Padrão: agora + antecedência mínima até +21 dias (urgência: +2 dias) |
| `practitioner_id` | string | | Se omitido, todos que fazem o serviço |
| `period` | `manha` \| `tarde` \| `qualquer` | | |
| `weekdays` | `1,2,3` | | 1 = segunda |
| `limit` | int (1–20) | | Padrão 3 para o bot |

```http
GET /v1/availability?service_id=svc_avaliacao&urgency_level=ROTINA&period=manha&limit=3
Authorization: Bearer eyJ...
X-Conversation-Id: cnv_01JD...
```

```json
{
  "data": [
    {
      "slot_id": "slt_01JD8Q",
      "practitioner": { "id": "prc_ana", "display_name": "Dra. Ana" },
      "service_id": "svc_avaliacao",
      "start": "2026-11-10T09:00:00-03:00",
      "end": "2026-11-10T09:40:00-03:00",
      "label_pt": "Ter, 10/11 às 9h00",
      "is_urgency_reserved": false
    }
  ],
  "generated_at": "2026-11-09T02:31:00-03:00"
}
```

`slot_id` é um token assinado (HMAC de `practitioner_id + start + service_id`, validade 30 min), para que o bot não consiga "inventar" um slot que a API não ofereceu.

### 3.3 Reservas temporárias (holds)

| Método | Rota | Descrição |
|---|---|---|
| `POST` | `/slot-holds` | Cria hold de 10 min. Body: `{ "slot_id": "slt_..." }` |
| `GET` | `/slot-holds/{hold_id}` | Estado do hold |
| `DELETE` | `/slot-holds/{hold_id}` | Libera o hold (paciente desistiu) |

```json
// 201 Created
{
  "hold_id": "hld_01JD9A",
  "slot": { "start": "2026-11-10T09:00:00-03:00", "end": "2026-11-10T09:40:00-03:00", "practitioner_id": "prc_ana" },
  "expires_at": "2026-11-09T02:41:00-03:00"
}
```

Erros: `409 SLOT_TAKEN`, `410 SLOT_TOKEN_EXPIRED`, `422 SLOT_INVALID`.

### 3.4 Agendamentos

| Método | Rota | Descrição | Quem usa |
|---|---|---|---|
| `POST` | `/appointments` | Cria a partir de um hold (bot) ou de horário livre (dashboard) | Bot, recepção |
| `GET` | `/appointments` | Lista por período/profissional/status (`from`, `to`, `practitioner_id`, `status`) | Dashboard |
| `GET` | `/appointments/{id}` | Detalhe | Bot (só da própria conversa), dashboard |
| `GET` | `/conversations/{id}/appointments` | Agendamentos futuros do paciente vinculado à conversa | Bot (`MANAGE_APPOINTMENT`) |
| `PATCH` | `/appointments/{id}` | Remarcar (`new_hold_id`) ou editar notas; requer `If-Match` | Bot, dashboard |
| `POST` | `/appointments/{id}/cancel` | Cancela com `reason` e `cancelled_by` | Bot, dashboard |
| `POST` | `/appointments/{id}/status` | `confirmed`, `checked_in`, `completed`, `no_show` | Dashboard |

Criação pelo bot:

```http
POST /v1/appointments
Authorization: Bearer eyJ...
X-Conversation-Id: cnv_01JD...
Idempotency-Key: cnv_01JD...:hld_01JD9A
Content-Type: application/json

{
  "hold_id": "hld_01JD9A",
  "service_id": "svc_avaliacao",
  "triage_id": "trg_01JD7Z",
  "source": "whatsapp_agent",
  "patient_confirmation_text": "pode confirmar sim"
}
```

```json
// 201 Created
{
  "id": "apt_01JD9C",
  "status": "scheduled",
  "start": "2026-11-10T09:00:00-03:00",
  "end": "2026-11-10T09:40:00-03:00",
  "practitioner": { "id": "prc_ana", "display_name": "Dra. Ana" },
  "service": { "id": "svc_avaliacao", "name": "Avaliação" },
  "location": { "address": "Rua X, 123 — Sala 4" },
  "urgency_level": "URGENCIA_LEVE",
  "confirmation_label_pt": "terça, 10/11, às 9h00",
  "version": 1
}
```

O `patient_id` **não vem no body**: a API o obtém da conversa. Erros: `409 SLOT_TAKEN` (constraint `23P01`), `410 HOLD_EXPIRED`, `409 PATIENT_ALREADY_BOOKED_SAME_DAY` (regra configurável), `422 SERVICE_NOT_BOOKABLE_BY_BOT`.

Status possíveis: `scheduled → confirmed → checked_in → completed`, com saídas `cancelled` e `no_show`.

### 3.5 Pacientes

| Método | Rota | Descrição |
|---|---|---|
| `POST` | `/patients/lookup` | Body `{ "phone_e164": "+5511..." }` → `{ found, patient_id, first_name, is_minor }`. Mínimo necessário. |
| `POST` | `/patients` | Cria com `full_name`, `birth_date`, `phone_e164`, `guardian_name?`, `created_via` |
| `POST` | `/conversations/{id}/link-patient` | Vincula a conversa ao paciente (quando agenda para outra pessoa) |
| `GET` | `/patients/{id}` | Dados completos (somente humanos) |
| `PATCH` | `/patients/{id}` | Atualização (somente humanos) |

`lookup` tem rate limit agressivo (ex.: 10/min por conversa) para impedir enumeração de números.

### 3.6 Triagem, alertas e handoff

| Método | Rota | Descrição |
|---|---|---|
| `POST` | `/triage-records` | Grava a triagem (`conversation_id`, `urgency_level`, `red_flags[]`, `chief_complaint`, `pain_score`, `confidence`, `llm_model`, `prompt_version`, `rule_version`, `final_level_source: llm\|rules`) |
| `GET` | `/triage-records?status=pending_review` | Fila de revisão da doutora |
| `POST` | `/triage-records/{id}/review` | Doutora marca `agreed` / `reclassified_to` (vira dado de avaliação do prompt) |
| `POST` | `/alerts/on-call` | Dispara alerta `critical`/`high` ao plantão (push no dashboard + template WhatsApp/SMS). Retorna `alert_id`; requer `ack` |
| `POST` | `/alerts/{id}/ack` | Plantonista confirma que viu (sem `ack` em 10 min → escalona para contato secundário) |
| `POST` | `/handoffs` | Cria pendência para humano com `reason` e `summary` |
| `POST` | `/handoffs/{id}/resolve` | Humano assumiu/encerrou; devolve ou não o controle ao bot |
| `POST` | `/waitlist` | Entrada na lista de espera (`service_id`, `urgency_level`, preferências) |

### 3.7 Gestão de agenda (dashboard)

| Método | Rota | Descrição |
|---|---|---|
| `GET` / `PUT` | `/practitioners/{id}/working-hours` | Jornada semanal |
| `GET` / `POST` / `DELETE` | `/practitioners/{id}/blocks` | Bloqueios (férias, almoço, congresso) |
| `GET` / `PUT` | `/practitioners/{id}/urgency-slots` | Janelas reservadas para encaixe de urgência |
| `GET` / `PUT` | `/clinic/settings` | Horário comercial, antecedência mínima, política de cancelamento, comportamento do bot em horário comercial |

### 3.8 Tempo real

| Método | Rota | Descrição |
|---|---|---|
| `GET` | `/events/stream` | **SSE** autenticado (cookie de sessão HttpOnly). Suporta `Last-Event-ID` para reconexão sem perda |

Eventos:

```text
event: appointment.created
id: 01JD9C...
data: {"appointment_id":"apt_01JD9C","start":"2026-11-10T09:00:00-03:00","practitioner_id":"prc_ana","urgency_level":"URGENCIA_LEVE","source":"whatsapp_agent"}
```

| Evento | Uso no dashboard |
|---|---|
| `appointment.created` / `.updated` / `.cancelled` | Atualiza a agenda |
| `triage.created` | Fila de triagens da noite |
| `emergency.alert` | Banner vermelho + som + notificação do navegador |
| `handoff.created` | Caixa de pendências |
| `hold.created` / `.expired` | (opcional) mostra horário "em negociação" em cinza |

Os payloads de eventos levam **IDs e metadados, não dados clínicos**; o dashboard busca o detalhe via REST com o token do usuário (assim RBAC e auditoria valem também para o realtime).

### 3.9 Webhooks de saída (API → agent-worker)

Quando a recepção altera algo pelo dashboard, a API chama `POST {agent}/internal/webhooks/scheduling` com header `X-Signature: sha256=...` (HMAC do corpo + timestamp, janela de 5 min contra replay). O worker então avisa o paciente via template.

### 3.10 LGPD / direitos do titular

| Método | Rota | Descrição |
|---|---|---|
| `POST` | `/privacy/requests` | Registra pedido do titular (acesso, correção, eliminação, portabilidade) |
| `GET` | `/patients/{id}/data-export` | Exportação JSON de tudo do titular (assíncrono, link expira em 24 h) |
| `POST` | `/patients/{id}/anonymize` | Anonimiza dados não sujeitos a guarda obrigatória (prontuário fica retido conforme lei) |
| `POST` | `/patients/{id}/consents` / `DELETE .../{consent_id}` | Concede/revoga consentimentos específicos (ex.: lembretes) |
| `GET` | `/audit-logs` | Consulta de auditoria (somente admin, ela própria auditada) |

## 4. Erros (exemplo)

```json
// 409 Conflict — application/problem+json
{
  "type": "https://api.{dominio}/errors/slot-taken",
  "title": "Horário indisponível",
  "status": 409,
  "code": "SLOT_TAKEN",
  "detail": "O horário foi ocupado por outro agendamento.",
  "request_id": "req_01JD9D"
}
```

| Código | HTTP | O que o bot faz |
|---|---|---|
| `SLOT_TAKEN` | 409 | Pede desculpas e volta para `SLOT_SEARCH` |
| `HOLD_EXPIRED` | 410 | "A reserva expirou, vou buscar de novo" → `SLOT_SEARCH` |
| `SLOT_TOKEN_EXPIRED` | 410 | Busca de novo silenciosamente |
| `SERVICE_NOT_BOOKABLE_BY_BOT` | 422 | Agenda "Avaliação" no lugar |
| `RATE_LIMITED` | 429 | Retry com *backoff* |
| `CONVERSATION_PATIENT_MISMATCH` | 403 | Alerta de segurança + handoff |
| 5xx | — | Não promete nada; registra pendência para recepção |

## 5. Rate limits sugeridos

| Rota | Limite |
|---|---|
| `/patients/lookup` | 10/min por conversa, 300/min por cliente |
| `/availability` | 30/min por conversa |
| `/slot-holds` | 5 holds ativos por conversa (o anterior é liberado ao criar novo) |
| `/appointments` (POST) | 3/h por conversa |

## 6. Próximo passo de implementação

Escrever os schemas em `packages/contracts` (Zod) e gerar o `openapi.yaml` a partir deles com `@fastify/swagger` / `zod-to-openapi`, para que dashboard, bot e API compartilhem exatamente o mesmo contrato.
