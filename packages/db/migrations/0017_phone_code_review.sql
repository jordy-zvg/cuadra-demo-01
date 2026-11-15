-- Revisión de seguridad del código por WhatsApp de 0016 (15-nov-2026). En 0016 el código se guardaba
-- antes de mandarlo, así que se podía escribir mientras Meta contestaba aunque luego lo rechazara.
-- Además, los envíos rechazados no contaban y la espera vivía en la cuenta: registrarse otra vez la
-- borraba, y con eso los intentos para adivinar no tenían tope. Ahora:
-- 1. Cada intento de envío se aparta ANTES de llamar a Meta, bajo un candado por celular (uno a la
--    vez), y cuenta para los topes aunque Meta lo rechace. Estados: pending (llamando a Meta),
--    sent (WhatsApp lo aceptó) y failed (lo rechazó). sent_at es la hora del intento.
-- 2. El código se guarda en la cuenta solo después de que WhatsApp lo aceptó.
-- 3. Los códigos equivocados se anotan por celular: con muchos en 24 h ya no se mandan códigos a ese
--    celular y queda solo el respaldo (que exige escribir desde ese WhatsApp).
-- Las esperas y los topes ya no viven en la cuenta: se calculan con estas tablas, por celular.
ALTER TABLE phone_code_sends ADD COLUMN status text NOT NULL DEFAULT 'sent';
ALTER TABLE phone_code_sends ADD CONSTRAINT phone_code_sends_status_check CHECK (status IN ('pending', 'sent', 'failed'));
-- Presupuesto diario de todos los envíos (no solo por celular).
CREATE INDEX phone_code_sends_sent_at ON phone_code_sends (sent_at);

-- Códigos equivocados por celular (no guarda el código).
CREATE TABLE phone_code_misses (
  id bigserial PRIMARY KEY,
  phone text NOT NULL,
  missed_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX phone_code_misses_phone_missed_at ON phone_code_misses (phone, missed_at);

ALTER TABLE portal_accounts DROP COLUMN otp_sent_at;
ALTER TABLE portal_accounts DROP COLUMN otp_failed_at;
