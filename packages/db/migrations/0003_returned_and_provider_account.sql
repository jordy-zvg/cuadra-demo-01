-- SPEI: una transferencia ya liquidada puede ser devuelta por el banco receptor
-- (Fintoc: transfer.outbound.returned). Se corrige con reversos, nunca editando asientos.
ALTER TABLE transfers DROP CONSTRAINT transfers_status_check;
ALTER TABLE transfers ADD CONSTRAINT transfers_status_check
  CHECK (status IN ('pending', 'sent', 'confirmed', 'failed', 'returned'));

CREATE OR REPLACE FUNCTION transfers_guard_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.amount_cents <> OLD.amount_cents OR NEW.payee_id <> OLD.payee_id
     OR NEW.idempotency_key <> OLD.idempotency_key OR NEW.merchant_id <> OLD.merchant_id
     OR NEW.proposal_hash <> OLD.proposal_hash THEN
    RAISE EXCEPTION 'Datos económicos de la transferencia % son inmutables', OLD.id;
  END IF;
  -- Terminales: failed y returned. confirmed solo puede pasar a returned.
  IF OLD.status IN ('failed', 'returned') AND NEW.status <> OLD.status THEN
    RAISE EXCEPTION 'Transferencia % ya está en estado terminal %', OLD.id, OLD.status;
  END IF;
  IF OLD.status = 'confirmed' AND NEW.status NOT IN ('confirmed', 'returned') THEN
    RAISE EXCEPTION 'Transferencia % confirmada solo puede pasar a returned', OLD.id;
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

-- Cuenta operativa del comercio en el proveedor (p. ej. acc_... de Fintoc), para rutear webhooks.
ALTER TABLE merchants ADD COLUMN provider_account_id text UNIQUE;
