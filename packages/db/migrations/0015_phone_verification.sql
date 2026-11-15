-- Verificación del celular por WhatsApp (decisión 15-nov-2026): la persona manda desde su celular
-- un código que le muestra el portal. Hasta verificar no entra a su libreta, a "Lo que debo" ni a
-- una tienda que ya existía con ese celular. Solo se guarda el hash del código.
ALTER TABLE portal_accounts ADD COLUMN phone_verified_at timestamptz;
ALTER TABLE portal_accounts ADD COLUMN verify_code_hash text;
ALTER TABLE portal_accounts ADD COLUMN verify_expires_at timestamptz;
