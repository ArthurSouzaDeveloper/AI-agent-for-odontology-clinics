-- Núcleo de agendamento. Propositalmente sem vocabulário clínico: "provider"
-- é quem presta o serviço (dentista, barbeiro, veterinário) e "subject" é quem
-- recebe (paciente, cliente, tutor do animal). A vertical odontológica entra
-- por configuração (tenants.config) e pelos pacotes de triagem.

CREATE EXTENSION IF NOT EXISTS btree_gist;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------------------------------------------------------------- tenants

CREATE TABLE tenants (
  id            text PRIMARY KEY,
  name          text        NOT NULL,
  vertical      text        NOT NULL DEFAULT 'odontology',
  timezone      text        NOT NULL DEFAULT 'America/Sao_Paulo',
  -- priority_levels, min_lead_time_min, hold_ttl_min, cancellation_policy,
  -- faq, business_hours extras: tudo por tenant, nada em constante de código.
  config        jsonb       NOT NULL DEFAULT '{}'::jsonb,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------- catálogo

CREATE TABLE providers (
  id            text PRIMARY KEY,
  tenant_id     text        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  display_name  text        NOT NULL,
  specialties   text[]      NOT NULL DEFAULT '{}',
  active        boolean     NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX providers_tenant_idx ON providers (tenant_id) WHERE active;

CREATE TABLE services (
  id                 text PRIMARY KEY,
  tenant_id          text        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  code               text        NOT NULL,
  name               text        NOT NULL,
  duration_min       integer     NOT NULL CHECK (duration_min > 0),
  min_priority       integer     NOT NULL DEFAULT 0 CHECK (min_priority BETWEEN 0 AND 100),
  bookable_by_agent  boolean     NOT NULL DEFAULT true,
  active             boolean     NOT NULL DEFAULT true,
  created_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, code)
);

CREATE TABLE provider_services (
  provider_id text NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
  service_id  text NOT NULL REFERENCES services(id)  ON DELETE CASCADE,
  PRIMARY KEY (provider_id, service_id)
);

-- ---------------------------------------------------------------- jornada

CREATE TABLE working_hours (
  id                   bigserial PRIMARY KEY,
  provider_id          text    NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
  -- 1 = segunda ... 7 = domingo (ISO-8601, igual a EXTRACT(ISODOW))
  weekday              smallint NOT NULL CHECK (weekday BETWEEN 1 AND 7),
  start_time           time    NOT NULL,
  end_time             time    NOT NULL,
  slot_granularity_min integer NOT NULL DEFAULT 15 CHECK (slot_granularity_min > 0),
  CHECK (end_time > start_time)
);
CREATE INDEX working_hours_provider_idx ON working_hours (provider_id, weekday);

-- Férias, almoço, congresso. Também usado para feriados (por provider).
CREATE TABLE schedule_blocks (
  id          text PRIMARY KEY,
  provider_id text        NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
  period      tstzrange   NOT NULL,
  reason      text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX schedule_blocks_period_idx ON schedule_blocks USING gist (provider_id, period);

-- Janelas que só pedidos acima de uma prioridade podem ocupar: os "encaixes"
-- de urgência da clínica, o horário VIP da barbearia, etc.
CREATE TABLE reserved_windows (
  id           text PRIMARY KEY,
  provider_id  text        NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
  period       tstzrange   NOT NULL,
  min_priority integer     NOT NULL CHECK (min_priority BETWEEN 0 AND 100),
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX reserved_windows_period_idx ON reserved_windows USING gist (provider_id, period);

-- ---------------------------------------------------------------- pessoas

-- Dados pessoais ficam em colunas *_enc (criptografia de campo com KMS na
-- aplicação). A busca por telefone usa HMAC com pepper, nunca o número.
CREATE TABLE subjects (
  id              text PRIMARY KEY,
  tenant_id       text        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  phone_hash      bytea,
  phone_enc       bytea,
  full_name_enc   bytea       NOT NULL,
  birth_date_enc  bytea,
  is_minor        boolean     NOT NULL DEFAULT false,
  guardian_name_enc bytea,
  created_via     text        NOT NULL DEFAULT 'dashboard',
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX subjects_phone_hash_idx ON subjects (tenant_id, phone_hash)
  WHERE phone_hash IS NOT NULL;

-- Conversa do WhatsApp. O vínculo conversa -> subject é o que impede o agente
-- de tocar em dados de terceiros.
CREATE TABLE conversations (
  id          text PRIMARY KEY,
  tenant_id   text        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  channel     text        NOT NULL DEFAULT 'whatsapp',
  subject_id  text        REFERENCES subjects(id) ON DELETE SET NULL,
  state       text        NOT NULL DEFAULT 'GREETING',
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------- agenda

CREATE TABLE appointments (
  id                text PRIMARY KEY,
  tenant_id         text        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  provider_id       text        NOT NULL REFERENCES providers(id),
  service_id        text        NOT NULL REFERENCES services(id),
  subject_id        text        NOT NULL REFERENCES subjects(id),
  conversation_id   text        REFERENCES conversations(id) ON DELETE SET NULL,
  period            tstzrange   NOT NULL,
  status            text        NOT NULL DEFAULT 'scheduled',
  priority          integer     NOT NULL DEFAULT 10 CHECK (priority BETWEEN 0 AND 100),
  source            text        NOT NULL DEFAULT 'dashboard',
  classification_id text,
  confirmation_text text,
  notes             text,
  version           integer     NOT NULL DEFAULT 1,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  cancelled_at      timestamptz,
  cancel_reason     text,
  CONSTRAINT appointments_status_check CHECK (
    status IN ('scheduled','confirmed','checked_in','completed','cancelled','no_show')
  )
);

-- A garantia de que dois clientes nunca pegam o mesmo horário mora AQUI, no
-- banco, e não no código da aplicação: vale para o bot, para a recepção e para
-- qualquer script futuro.
ALTER TABLE appointments
  ADD CONSTRAINT appointments_no_overlap
  EXCLUDE USING gist (provider_id WITH =, period WITH &&)
  WHERE (status IN ('scheduled','confirmed','checked_in','completed'));

CREATE INDEX appointments_agenda_idx ON appointments USING gist (provider_id, period);
CREATE INDEX appointments_tenant_start_idx ON appointments (tenant_id, lower(period));
CREATE INDEX appointments_subject_idx ON appointments (subject_id, lower(period));

-- Reserva temporária enquanto o cliente confirma pelo WhatsApp.
CREATE TABLE slot_holds (
  id              text PRIMARY KEY,
  tenant_id       text        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  provider_id     text        NOT NULL REFERENCES providers(id),
  service_id      text        NOT NULL REFERENCES services(id),
  conversation_id text        REFERENCES conversations(id) ON DELETE CASCADE,
  period          tstzrange   NOT NULL,
  priority        integer     NOT NULL DEFAULT 10,
  expires_at      timestamptz NOT NULL,
  consumed_at     timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- Holds pendentes também não podem se sobrepor entre si. O predicado não pode
-- usar now() (precisa ser imutável), então um hold expirado continua travando
-- até ser removido: quem cria um hold apaga os expirados do mesmo provider na
-- mesma transação, e um job faz a varredura periódica.
ALTER TABLE slot_holds
  ADD CONSTRAINT slot_holds_no_overlap
  EXCLUDE USING gist (provider_id WITH =, period WITH &&)
  WHERE (consumed_at IS NULL);

CREATE INDEX slot_holds_active_idx ON slot_holds (expires_at) WHERE consumed_at IS NULL;
CREATE INDEX slot_holds_conversation_idx ON slot_holds (conversation_id) WHERE consumed_at IS NULL;

-- ---------------------------------------------------------------- infra

-- Gravado na MESMA transação do agendamento: não existe "salvou mas não
-- notificou" o painel.
CREATE TABLE outbox_events (
  id            bigserial PRIMARY KEY,
  tenant_id     text        NOT NULL,
  type          text        NOT NULL,
  payload       jsonb       NOT NULL,
  occurred_at   timestamptz NOT NULL DEFAULT now(),
  published_at  timestamptz
);
CREATE INDEX outbox_unpublished_idx ON outbox_events (id) WHERE published_at IS NULL;

-- Retentativa de rede do agente não cria agendamento duplicado.
CREATE TABLE idempotency_keys (
  key           text PRIMARY KEY,
  tenant_id     text        NOT NULL,
  route         text        NOT NULL,
  request_hash  text        NOT NULL,
  status_code   integer,
  response      jsonb,
  created_at    timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL DEFAULT now() + interval '24 hours'
);
CREATE INDEX idempotency_expires_idx ON idempotency_keys (expires_at);

-- Append-only, sem conteúdo clínico: quem fez o quê, quando.
CREATE TABLE audit_logs (
  id          bigserial PRIMARY KEY,
  tenant_id   text        NOT NULL,
  actor_type  text        NOT NULL,
  actor_id    text,
  action      text        NOT NULL,
  entity      text        NOT NULL,
  entity_id   text,
  request_id  text,
  ip          inet,
  at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_logs_entity_idx ON audit_logs (tenant_id, entity, entity_id);
REVOKE UPDATE, DELETE ON audit_logs FROM PUBLIC;
