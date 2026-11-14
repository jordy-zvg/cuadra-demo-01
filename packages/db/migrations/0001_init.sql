-- Cuadra: esquema inicial. Los invariantes del dinero viven también aquí, no solo en código.

-- ---------- Funciones ----------

-- Dígito verificador de CLABE (pesos 3,7,1 módulo 10). Principio 7.
CREATE FUNCTION clabe_is_valid(c text) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE STRICT AS $$
DECLARE
  s int := 0;
  w int[] := ARRAY[3, 7, 1];
BEGIN
  IF c !~ '^[0-9]{18}$' THEN RETURN false; END IF;
  FOR i IN 1..17 LOOP
    s := s + (substr(c, i, 1)::int * w[((i - 1) % 3) + 1]) % 10;
  END LOOP;
  RETURN (10 - s % 10) % 10 = substr(c, 18, 1)::int;
END $$;

-- Append-only: el ledger no se edita ni se borra. Correcciones con asientos de reverso.
CREATE FUNCTION forbid_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Ledger append-only: % no permitido en %', TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'P0001';
END $$;

-- Σdebe = Σhaber y al menos dos líneas, verificado al cerrar la transacción.
CREATE FUNCTION check_entry_balanced() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  eid bigint;
  d numeric;
  c numeric;
  n int;
BEGIN
  IF TG_TABLE_NAME = 'journal_entries' THEN eid := NEW.id; ELSE eid := NEW.entry_id; END IF;
  SELECT coalesce(sum(debit), 0), coalesce(sum(credit), 0), count(*)
    INTO d, c, n FROM journal_lines WHERE entry_id = eid;
  IF n < 2 OR d <> c THEN
    RAISE EXCEPTION 'Asiento % descuadrado: debe %, haber %, líneas %', eid, d, c, n
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END $$;

-- ---------- Comercios, usuarios, passkeys ----------

CREATE TABLE merchants (
  id text PRIMARY KEY,
  name text NOT NULL,
  daily_limit_cents bigint NOT NULL CHECK (daily_limit_cents >= 0),
  max_outflows_per_hour int NOT NULL CHECK (max_outflows_per_hour >= 0),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE merchant_users (
  id text PRIMARY KEY,
  merchant_id text NOT NULL REFERENCES merchants(id),
  phone text NOT NULL,
  phone_verified boolean NOT NULL DEFAULT false,
  role text NOT NULL CHECK (role IN ('comercio', 'organizadora', 'cliente')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (merchant_id, phone)
);

CREATE TABLE passkey_credentials (
  id text PRIMARY KEY,                       -- credential id (base64url)
  merchant_user_id text NOT NULL REFERENCES merchant_users(id),
  public_key bytea NOT NULL,                 -- COSE
  counter bigint NOT NULL DEFAULT 0 CHECK (counter >= 0),
  transports text[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Estado de riesgo (R12) y retenciones (R08).
CREATE TABLE risk_state (
  merchant_id text PRIMARY KEY REFERENCES merchants(id),
  kill_switch boolean NOT NULL DEFAULT false,
  account_frozen boolean NOT NULL DEFAULT false,
  reconciliation_mismatch boolean NOT NULL DEFAULT false,
  holds_cents bigint NOT NULL DEFAULT 0 CHECK (holds_cents >= 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- ---------- Clientes y beneficiarios ----------

CREATE TABLE customers (
  id text PRIMARY KEY,
  merchant_id text NOT NULL REFERENCES merchants(id),
  name text NOT NULL,
  phone text,
  opt_in boolean NOT NULL DEFAULT false,
  virtual_clabe text UNIQUE CHECK (virtual_clabe IS NULL OR clabe_is_valid(virtual_clabe)),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- CLABE ordenante ya ligada a un cliente (paso 2 de la cascada).
CREATE TABLE customer_ordering_clabes (
  merchant_id text NOT NULL REFERENCES merchants(id),
  clabe text NOT NULL CHECK (clabe_is_valid(clabe)),
  customer_id text NOT NULL REFERENCES customers(id),
  PRIMARY KEY (merchant_id, clabe)
);

CREATE TABLE payees (
  id text PRIMARY KEY,
  merchant_id text NOT NULL REFERENCES merchants(id),
  alias text NOT NULL,
  clabe text NOT NULL CHECK (clabe_is_valid(clabe)),
  holder_name text NOT NULL,
  holder_validated boolean NOT NULL DEFAULT false,
  whitelisted boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (merchant_id, clabe)
);

-- ---------- Propuestas, aprobaciones, mandatos ----------

CREATE TABLE proposals (
  id text PRIMARY KEY,
  merchant_id text NOT NULL REFERENCES merchants(id),
  actor_id text NOT NULL REFERENCES merchant_users(id),
  type text NOT NULL,
  provenance text NOT NULL CHECK (provenance IN ('user_direct', 'user_voice', 'third_party_content')),
  payload jsonb NOT NULL,                    -- Proposal canónica (montos como texto)
  proposal_hash text NOT NULL CHECK (proposal_hash ~ '^[0-9a-f]{64}$'),
  auditor_veto boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'awaiting_passkey', 'queued', 'executing', 'done', 'rejected')),
  decision jsonb,                            -- último GuardResult
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX proposals_merchant_idx ON proposals (merchant_id, created_at);

-- Aprobación con passkey: aserción WebAuthn cuyo challenge es el hash exacto de la propuesta.
CREATE TABLE approvals (
  id text PRIMARY KEY,
  merchant_id text NOT NULL REFERENCES merchants(id),
  proposal_id text NOT NULL REFERENCES proposals(id),
  proposal_hash text NOT NULL,
  credential_id text NOT NULL REFERENCES passkey_credentials(id),
  assertion jsonb NOT NULL,                  -- AuthenticationResponseJSON
  prior_counter bigint NOT NULL DEFAULT 0,   -- contador de la credencial antes de esta aserción
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  CHECK (expires_at <= created_at + interval '10 minutes')
);
CREATE INDEX approvals_proposal_idx ON approvals (proposal_id);

CREATE TABLE mandates (
  id text PRIMARY KEY,
  merchant_id text NOT NULL REFERENCES merchants(id),
  payee_id text NOT NULL REFERENCES payees(id),
  purpose text NOT NULL CHECK (purpose IN ('proveedor', 'tanda', 'devolucion')),
  per_op_cap_cents bigint NOT NULL CHECK (per_op_cap_cents > 0),
  period_cap_cents bigint NOT NULL CHECK (period_cap_cents > 0),
  period text NOT NULL CHECK (period IN ('day', 'week', 'month')),
  valid_from timestamptz NOT NULL,
  valid_until timestamptz NOT NULL CHECK (valid_until > valid_from),
  revoked_at timestamptz,
  -- Propuesta CreateMandate aprobada con passkey: es la "firma" del mandato.
  proposal_id text NOT NULL REFERENCES proposals(id),
  approval_id text NOT NULL REFERENCES approvals(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX mandates_lookup_idx ON mandates (merchant_id, payee_id, purpose);

-- ---------- Ledger ----------

CREATE TABLE journal_entries (
  id bigserial PRIMARY KEY,
  merchant_id text NOT NULL REFERENCES merchants(id),
  idempotency_key text NOT NULL UNIQUE,
  kind text NOT NULL CHECK (kind IN (
    'fiado', 'abono_identificado', 'abono_sin_identificar', 'abono_identificacion',
    'pago_proveedor_creado', 'pago_confirmado', 'tanda_aportacion', 'tanda_dispersion',
    'devolucion_saldo_a_favor', 'reverso')),
  memo text NOT NULL,
  content_hash text NOT NULL,                -- para detectar llaves reutilizadas con otro contenido
  reverses text REFERENCES journal_entries(idempotency_key),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((kind = 'reverso') = (reverses IS NOT NULL))
);
-- Un asiento solo se reversa una vez.
CREATE UNIQUE INDEX journal_entries_reverses_uq ON journal_entries (reverses) WHERE reverses IS NOT NULL;

CREATE TABLE journal_lines (
  id bigserial PRIMARY KEY,
  entry_id bigint NOT NULL REFERENCES journal_entries(id),
  account text NOT NULL CHECK (account IN ('1100','1200','1300','2100','2200','2400','4100','5100','5900')),
  subaccount text,
  debit bigint NOT NULL CHECK (debit >= 0),
  credit bigint NOT NULL CHECK (credit >= 0),
  CHECK ((debit > 0) <> (credit > 0))
);
CREATE INDEX journal_lines_account_idx ON journal_lines (account, subaccount);
CREATE INDEX journal_lines_entry_idx ON journal_lines (entry_id);

CREATE CONSTRAINT TRIGGER journal_entries_balanced AFTER INSERT ON journal_entries
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_entry_balanced();
CREATE CONSTRAINT TRIGGER journal_lines_balanced AFTER INSERT ON journal_lines
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_entry_balanced();

CREATE TRIGGER journal_entries_append_only BEFORE UPDATE OR DELETE ON journal_entries
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER journal_lines_append_only BEFORE UPDATE OR DELETE ON journal_lines
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER journal_entries_no_truncate BEFORE TRUNCATE ON journal_entries
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER journal_lines_no_truncate BEFORE TRUNCATE ON journal_lines
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();

-- ---------- Transferencias salientes ----------

CREATE TABLE transfers (
  id text PRIMARY KEY,
  merchant_id text NOT NULL REFERENCES merchants(id),
  idempotency_key text NOT NULL UNIQUE,      -- también se manda al proveedor
  proposal_id text NOT NULL UNIQUE REFERENCES proposals(id),
  proposal_hash text NOT NULL,
  purpose text NOT NULL CHECK (purpose IN ('proveedor', 'tanda', 'devolucion')),
  payee_id text NOT NULL REFERENCES payees(id),
  mandate_id text REFERENCES mandates(id),
  approval_id text REFERENCES approvals(id),
  amount_cents bigint NOT NULL CHECK (amount_cents > 0),
  concept text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'confirmed', 'failed')),
  provider_ref text UNIQUE,
  submitted_at timestamptz,                  -- primer intento de envío al proveedor
  failure_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX transfers_merchant_idx ON transfers (merchant_id, created_at);

-- Estados terminales y datos económicos inmutables.
CREATE FUNCTION transfers_guard_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.amount_cents <> OLD.amount_cents OR NEW.payee_id <> OLD.payee_id
     OR NEW.idempotency_key <> OLD.idempotency_key OR NEW.merchant_id <> OLD.merchant_id
     OR NEW.proposal_hash <> OLD.proposal_hash THEN
    RAISE EXCEPTION 'Datos económicos de la transferencia % son inmutables', OLD.id;
  END IF;
  IF OLD.status IN ('confirmed', 'failed') AND NEW.status <> OLD.status THEN
    RAISE EXCEPTION 'Transferencia % ya está en estado terminal %', OLD.id, OLD.status;
  END IF;
  IF OLD.submitted_at IS NOT NULL AND NEW.submitted_at IS DISTINCT FROM OLD.submitted_at THEN
    RAISE EXCEPTION 'submitted_at de la transferencia % no se puede cambiar', OLD.id;
  END IF;
  IF OLD.provider_ref IS NOT NULL AND NEW.provider_ref IS DISTINCT FROM OLD.provider_ref THEN
    RAISE EXCEPTION 'provider_ref de la transferencia % no se puede cambiar', OLD.id;
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $$;
CREATE TRIGGER transfers_update BEFORE UPDATE ON transfers
  FOR EACH ROW EXECUTE FUNCTION transfers_guard_update();
CREATE TRIGGER transfers_no_delete BEFORE DELETE ON transfers
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- ---------- Abonos entrantes ----------

CREATE TABLE deposits (
  id bigserial PRIMARY KEY,
  merchant_id text NOT NULL REFERENCES merchants(id),
  clave_rastreo text NOT NULL UNIQUE,
  amount_cents bigint NOT NULL CHECK (amount_cents > 0),
  destination_clabe text,
  ordering_clabe text,
  reference text,
  concept text,
  customer_id text REFERENCES customers(id),
  match_method text,
  received_at timestamptz NOT NULL DEFAULT now()
);

-- Cobros abiertos (referencia y centavos únicos asignados en el recordatorio).
CREATE TABLE charges (
  id text PRIMARY KEY,
  merchant_id text NOT NULL REFERENCES merchants(id),
  customer_id text NOT NULL REFERENCES customers(id),
  reference text NOT NULL,
  unique_amount_cents bigint CHECK (unique_amount_cents > 0),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'paid', 'cancelled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (merchant_id, reference)
);
CREATE UNIQUE INDEX charges_open_unique_amount ON charges (merchant_id, unique_amount_cents)
  WHERE status = 'open' AND unique_amount_cents IS NOT NULL;

-- ---------- Webhooks y conciliación ----------

CREATE TABLE webhook_events (
  provider text NOT NULL,
  event_id text NOT NULL,
  payload jsonb NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider, event_id)
);

CREATE TABLE reconciliation_runs (
  id bigserial PRIMARY KEY,
  merchant_id text NOT NULL REFERENCES merchants(id),
  run_at timestamptz NOT NULL DEFAULT now(),
  local_date date NOT NULL,                  -- fecha en America/Mexico_City
  ledger_1100_cents bigint NOT NULL,
  in_flight_cents bigint NOT NULL,
  provider_balance_cents bigint NOT NULL,
  ok boolean NOT NULL
);
CREATE INDEX reconciliation_runs_idx ON reconciliation_runs (merchant_id, local_date, run_at);
