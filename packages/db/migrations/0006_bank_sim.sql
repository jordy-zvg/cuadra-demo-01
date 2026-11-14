-- Cuenta operativa SIMULADA (solo demo): pey cobra a la CLABE del comercio pero no expone
-- saldo ni paga; este libro hace de "banco" para salidas simuladas y para conciliar 1100.
CREATE TABLE bank_sim_movements (
  id bigserial PRIMARY KEY,
  merchant_id text NOT NULL REFERENCES merchants(id),
  idempotency_key text NOT NULL UNIQUE,
  amount_cents bigint NOT NULL CHECK (amount_cents <> 0),   -- + entra, − sale
  kind text NOT NULL CHECK (kind IN ('fondeo', 'cobro', 'transferencia', 'devolucion')),
  ref text NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'settled' CHECK (status IN ('sent', 'settled', 'failed')),
  created_at timestamptz NOT NULL DEFAULT now()
);
