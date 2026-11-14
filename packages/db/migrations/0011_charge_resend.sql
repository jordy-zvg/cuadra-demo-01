-- Reenvío de una solicitud CoDi vencida sin pago (decisión 14-nov-2026). El reenvío apunta al
-- recordatorio original: no cuenta como recordatorio nuevo (P03) y se limita por recordatorio (P08).
ALTER TABLE charges ADD COLUMN resend_of text REFERENCES charges(id);
CREATE INDEX charges_resend_of_idx ON charges (resend_of) WHERE resend_of IS NOT NULL;
