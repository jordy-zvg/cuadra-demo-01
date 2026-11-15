-- Cada persona se identifica por su celular (decisión 14-nov-2026): una cuenta del portal por celular
-- en todo Cuadra, y cada cuenta es dueña de su propia tienda (libreta). Antes todas las cuentas
-- colgaban de la tienda de demo y veían los mismos clientes y deudas.
ALTER TABLE portal_accounts DROP CONSTRAINT portal_accounts_merchant_id_phone_key;
ALTER TABLE portal_accounts ADD CONSTRAINT portal_accounts_phone_key UNIQUE (phone);
DROP INDEX portal_accounts_llave_idx;
CREATE UNIQUE INDEX portal_accounts_llave_sub_idx ON portal_accounts (llave_sub) WHERE llave_sub IS NOT NULL;

-- Solo una tienda con su cuenta receptora cobra y paga en vivo; las demás, en modo simulado,
-- para que el dinero de una tienda nunca llegue a la cuenta de otra.
ALTER TABLE merchants ADD COLUMN live_payments boolean NOT NULL DEFAULT false;

-- Buscar al dueño de una tienda por su celular (WhatsApp y registro).
CREATE INDEX merchant_users_phone_idx ON merchant_users (phone);
