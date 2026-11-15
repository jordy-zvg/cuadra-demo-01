-- Comprobar el celular cuenta para la SESIÓN que lo comprobó (segunda revisión, 15-nov-2026).
-- Antes, verificar el celular dejaba verificadas TODAS las sesiones de la cuenta. Con la Llave CDMX de
-- demo (que no comprueba identidad: basta CURP y celular) alguien abría una sesión en la cuenta de otra
-- persona, que quedaba sin verificar; cuando la dueña volvía a comprobar su celular, la sesión del otro
-- también quedaba verificada. Ahora, al comprobarlo, se cierran las demás sesiones de la cuenta.
-- El código del respaldo (el que la persona manda desde su WhatsApp) vive en la sesión que lo pidió:
-- otra sesión ya no puede reemplazarlo ni aprovecharlo.
ALTER TABLE portal_sessions ADD COLUMN verify_code_hash text;
ALTER TABLE portal_sessions ADD COLUMN verify_expires_at timestamptz;

-- Códigos del respaldo vigentes al desplegar (vencen en 15 minutos): pasan a las sesiones de su cuenta.
UPDATE portal_sessions s
SET verify_code_hash = a.verify_code_hash, verify_expires_at = a.verify_expires_at
FROM portal_accounts a
WHERE s.account_id = a.id AND a.verify_code_hash IS NOT NULL;

ALTER TABLE portal_accounts DROP COLUMN verify_code_hash;
ALTER TABLE portal_accounts DROP COLUMN verify_expires_at;
