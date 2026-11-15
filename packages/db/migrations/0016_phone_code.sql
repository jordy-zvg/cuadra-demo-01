-- Verificación del celular con código que manda Cuadra (decisión 15-nov-2026): Cuadra manda por
-- WhatsApp un código de 6 números (plantilla de autenticación «cuadra_codigo») y la persona lo escribe
-- en el portal. Vence en 10 minutos y admite 5 intentos. Solo se guarda el hash.
-- Si WhatsApp no lo puede entregar, sigue el camino de 0015 (la persona manda desde su celular el
-- código que le muestra el portal). Cada camino tiene su propio hash: un código nunca sirve por el otro.
ALTER TABLE portal_accounts ADD COLUMN otp_hash text;
ALTER TABLE portal_accounts ADD COLUMN otp_expires_at timestamptz;
ALTER TABLE portal_accounts ADD COLUMN otp_attempts integer NOT NULL DEFAULT 0;
ALTER TABLE portal_accounts ADD COLUMN otp_sent_at timestamptz;
-- Último envío que WhatsApp rechazó: por un rato se usa directo el respaldo, sin volver a llamar a Meta.
ALTER TABLE portal_accounts ADD COLUMN otp_failed_at timestamptz;

-- Códigos que sí salieron, por celular (no por cuenta: registrarse encima de una cuenta sin verificar
-- no reinicia el tope por hora). No guarda el código.
CREATE TABLE phone_code_sends (
  id bigserial PRIMARY KEY,
  phone text NOT NULL,
  sent_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX phone_code_sends_phone_sent_at ON phone_code_sends (phone, sent_at);
