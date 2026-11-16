-- Abonos de fiado en efectivo (16-nov-2026). El comercio dice «Doña Lupe me pagó $100 en efectivo» y
-- Cuadra lo registra: D 1050 Efectivo en caja / H 1200 CxC del cliente, solo hasta su saldo.
-- 1050 es una cuenta nueva del catálogo; 1100 (cuenta operativa) sigue siendo solo el espejo del
-- proveedor, así que la conciliación y el saldo disponible de las salidas (R08) no cambian.
ALTER TABLE journal_lines DROP CONSTRAINT journal_lines_account_check;
ALTER TABLE journal_lines ADD CONSTRAINT journal_lines_account_check
  CHECK (account IN ('1050','1100','1200','1300','2100','2200','2400','4100','5100','5900'));
ALTER TABLE journal_entries DROP CONSTRAINT journal_entries_kind_check;
ALTER TABLE journal_entries ADD CONSTRAINT journal_entries_kind_check CHECK (kind IN (
  'fiado', 'abono_identificado', 'abono_sin_identificar', 'abono_identificacion', 'abono_efectivo',
  'pago_proveedor_creado', 'pago_confirmado', 'tanda_aportacion', 'tanda_dispersion',
  'devolucion_saldo_a_favor', 'reverso'));
