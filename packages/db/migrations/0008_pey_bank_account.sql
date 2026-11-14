-- Cuenta receptora del comercio registrada en pey (bankAccountId): el cobro CoDi va directo
-- a la CLABE del comercio; Cuadra no custodia.
ALTER TABLE merchants ADD COLUMN pey_bank_account_id text;
