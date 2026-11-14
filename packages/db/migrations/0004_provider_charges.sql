-- Cobros emitidos por un proveedor de cobro (pey: notificación push CoDi, QR o link de pago).
ALTER TABLE charges ADD COLUMN amount_cents bigint CHECK (amount_cents IS NULL OR amount_cents > 0);
ALTER TABLE charges ADD COLUMN provider text;
ALTER TABLE charges ADD COLUMN provider_charge_id text;
ALTER TABLE charges ADD COLUMN payment_url text;
ALTER TABLE charges ADD COLUMN channel text CHECK (channel IS NULL OR channel IN ('codi_pn', 'codi_qr', 'payment_link'));
CREATE UNIQUE INDEX charges_provider_charge_uq ON charges (provider, provider_charge_id) WHERE provider_charge_id IS NOT NULL;

-- Desglose de lo que reporta el proveedor (pey: base, propina, comisión al pagador).
ALTER TABLE deposits ADD COLUMN provider text;
ALTER TABLE deposits ADD COLUMN gross_cents bigint;
ALTER TABLE deposits ADD COLUMN tip_cents bigint;
ALTER TABLE deposits ADD COLUMN fee_cents bigint;
ALTER TABLE deposits ADD COLUMN tracking_key text;
ALTER TABLE deposits ADD COLUMN charge_id text REFERENCES charges(id);
