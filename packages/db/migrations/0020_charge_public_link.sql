-- Enlace público de un cobro (26-nov-2026). Cada cobro nuevo lleva un token aleatorio de 128 bits;
-- el cliente abre /cobro/<token> desde su mensaje y ve a qué tienda le debe, cuánto, y si su
-- solicitud sigue viva, ya se pagó o venció. Solo lectura: el enlace no cobra ni mueve dinero.
-- Los cobros anteriores se quedan sin enlace (NULL).
ALTER TABLE charges ADD COLUMN public_token text;
CREATE UNIQUE INDEX charges_public_token_key ON charges (public_token) WHERE public_token IS NOT NULL;
