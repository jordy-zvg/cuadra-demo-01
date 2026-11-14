-- Tanda sin pozo: cada aportación se cobra por CoDi directo a la cuenta del integrante en
-- turno. Cuadra no recibe el dinero: no hay asientos en el ledger del comercio, solo control.
CREATE TABLE tandas (
  id text PRIMARY KEY,
  merchant_id text NOT NULL REFERENCES merchants(id),
  name text NOT NULL,
  contribution_cents bigint NOT NULL CHECK (contribution_cents > 0),
  period text NOT NULL CHECK (period IN ('week', 'biweek', 'month')),
  members_count int NOT NULL CHECK (members_count BETWEEN 2 AND 20),
  -- Propuesta CreateTanda firmada con passkey: fuente de verdad de integrantes, CLABEs y orden.
  proposal_id text NOT NULL UNIQUE REFERENCES proposals(id),
  approval_id text NOT NULL REFERENCES approvals(id),
  current_round int NOT NULL DEFAULT 0 CHECK (current_round >= 0 AND current_round <= members_count),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'done', 'frozen')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE tanda_members (
  tanda_id text NOT NULL REFERENCES tandas(id),
  position int NOT NULL CHECK (position >= 1),
  name text NOT NULL,
  phone text NOT NULL CHECK (phone ~ '^[0-9]{10}$'),
  clabe text NOT NULL CHECK (clabe_is_valid(clabe)),
  -- Cuenta receptora en pey (POST /bank-account); debe estar ACTIVE para recibir.
  bank_account_id text,
  bank_account_status text NOT NULL DEFAULT 'PENDING',
  PRIMARY KEY (tanda_id, position),
  UNIQUE (tanda_id, phone),
  UNIQUE (tanda_id, clabe)
);

CREATE TABLE tanda_charges (
  id text PRIMARY KEY,
  tanda_id text NOT NULL REFERENCES tandas(id),
  round int NOT NULL CHECK (round >= 1),
  payer_position int NOT NULL,
  recipient_position int NOT NULL,
  amount_cents bigint NOT NULL CHECK (amount_cents > 0),
  provider text,
  provider_charge_id text,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'paid', 'expired', 'mismatch')),
  transaction_id text UNIQUE,
  paid_cents bigint,
  created_at timestamptz NOT NULL DEFAULT now(),
  paid_at timestamptz,
  CHECK (payer_position <> recipient_position),
  FOREIGN KEY (tanda_id, payer_position) REFERENCES tanda_members(tanda_id, position),
  FOREIGN KEY (tanda_id, recipient_position) REFERENCES tanda_members(tanda_id, position)
);
CREATE UNIQUE INDEX tanda_charges_provider_uq ON tanda_charges (provider, provider_charge_id) WHERE provider_charge_id IS NOT NULL;
-- Una sola aportación pagada por integrante y ronda.
CREATE UNIQUE INDEX tanda_charges_one_paid ON tanda_charges (tanda_id, round, payer_position) WHERE status = 'paid';
