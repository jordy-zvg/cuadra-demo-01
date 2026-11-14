-- Entrar con Llave CDMX (por ahora en modo demo). Se guarda solo el identificador que entrega
-- la Llave (en demo: hash de la CURP), nunca la CURP. Una cuenta creada por Llave no tiene NIP.
ALTER TABLE portal_accounts ADD COLUMN llave_sub text;
ALTER TABLE portal_accounts ALTER COLUMN pin_hash DROP NOT NULL;
CREATE UNIQUE INDEX portal_accounts_llave_idx ON portal_accounts (merchant_id, llave_sub) WHERE llave_sub IS NOT NULL;
