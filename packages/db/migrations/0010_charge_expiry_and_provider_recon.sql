-- Los cobros vencen igual que en el proveedor (QR 30 min, solicitud al celular 1 h). Un cobro
-- vencido ya no bloquea uno nuevo; si de todos modos llega su pago, se aplica igual.
ALTER TABLE charges DROP CONSTRAINT charges_status_check;
ALTER TABLE charges ADD CONSTRAINT charges_status_check
  CHECK (status IN ('open', 'paid', 'cancelled', 'expired'));
ALTER TABLE charges ADD COLUMN expires_at timestamptz;

-- Conciliación por transacción contra el proveedor de cobro (pey no expone saldo).
CREATE TABLE provider_reconciliation_runs (
  id bigserial PRIMARY KEY,
  merchant_id text NOT NULL REFERENCES merchants(id),
  provider text NOT NULL,
  run_at timestamptz NOT NULL DEFAULT now(),
  checked int NOT NULL,
  recovered int NOT NULL,
  discrepancies jsonb NOT NULL,
  ok boolean NOT NULL
);
CREATE INDEX provider_reconciliation_runs_idx ON provider_reconciliation_runs (merchant_id, provider, run_at);
