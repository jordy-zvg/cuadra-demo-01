# Cuadra — CLAUDE.md

## Qué es
Agente de WhatsApp que cobra, concilia y paga por SPEI para la economía de barrio (fiado, tandas, proveedores).
El dinero vive en una cuenta operativa de una entidad licenciada (vía API). Cuadra nunca custodia fondos.
Lee BRIEF.md antes de cualquier decisión de producto.

## Prioridades
1. Que el dinero nunca se mueva mal. 2. Demo que funcione en vivo sin fallar. 3. Velocidad.
Ante la duda, elige lo simple, determinista y testeable.

## Principios innegociables
1. **El LLM propone, el código decide.** Los agentes solo devuelven `Proposal` validadas con Zod. Nunca escriben en DB, nunca llaman a proveedores de pago, nunca ven secretos.
2. **Ejecutor aislado.** `apps/executor` es el ÚNICO proceso con credenciales del proveedor. Antes de ejecutar, revalida guard + firma del mandato/aprobación + estado de riesgo. Recibe trabajos solo desde la cola, nunca del LLM.
3. **Guard determinista.** Funciones puras en `packages/core/guard`, 100% cubiertas por tests. Cada rechazo devuelve `rule_id` y motivo legible en español.
4. **Ledger de partida doble append-only.** Σdebe = Σhaber por asiento (constraint en DB + test de propiedad). Correcciones solo con asientos de reverso. Montos en centavos (`bigint`), nunca floats.
5. **Idempotencia en todo.** `idempotency_key` único por asiento y por transferencia; `clave_rastreo` único por abono; webhooks reintentables sin duplicar.
6. **Procedencia (taint).** Toda propuesta lleva `provenance`: `user_direct` | `user_voice` | `third_party_content` (foto, documento, mensaje reenviado). `third_party_content` nunca crea beneficiarios ni ejecuta pagos sin passkey.
7. **Datos bancarios solo del sistema.** Toda CLABE mostrada sale de la DB y pasa validación de dígito verificador. El LLM nunca produce una CLABE que se use.
8. **Toda salida de dinero** requiere: mandato vigente que la cubra, O aprobación con passkey ligada al hash exacto de la propuesta. Nunca basta un "sí" en el chat.
9. **Conciliación continua.** Si saldo del ledger (cuenta 1100) ≠ saldo del proveedor, se congelan salidas automáticamente.
10. **Alcance cerrado.** El agente rechaza temas fuera de fiado, cobros, tandas y pagos a proveedores (política WhatsApp 2026).
11. **Secretos.** Nunca en código, logs, prompts ni commits. `.env` en `.gitignore`. Nunca loggear headers de auth.
12. Si una API externa no se comporta como dice este archivo, detente y reporta request/response (sin secretos). No inventes campos.

## Stack
- Monorepo pnpm + TypeScript estricto. Node 20+.
- `apps/api`: Fastify (webhooks de WhatsApp y proveedor, API interna).
- `apps/executor`: worker BullMQ, único con llaves de pago.
- `apps/worker`: BullMQ (recordatorios, conciliación, red team, simulador).
- `apps/web`: Next.js App Router + Tailwind (aprobación con passkey, panel, chat simulado).
- `packages/core`: dominio puro (money, clabe, ledger, guard, mandates, reminder-policy, reconciliation). Sin I/O.
- `packages/agents`: intérprete, auditor, red team; `LLMProvider` intercambiable (Anthropic por defecto).
- `packages/adapters`: `payments/` (mock, fintoc; opcionales belvo, juno), `channels/` (whatsapp, websim), `stt/`, `ocr/`.
- `packages/db`: Drizzle + Postgres, migraciones, seed.
- Redis + BullMQ. Zod. Vitest + fast-check. @simplewebauthn/server y /browser.
- Docker compose para local (postgres, redis).
- Zona horaria America/Mexico_City. Mensajes en español mexicano, claros y cortos.

## Pipeline de una instrucción
mensaje (canal) → normalización (STT/OCR) → intérprete ×3 → consenso → `Proposal` + provenance
→ guard → [si requiere aprobación: enlace passkey de un solo uso, 10 min, ligado a hash(proposal)]
→ auditor (solo veto) → cola → executor (revalida) → proveedor → webhook → ledger → notificación.

## Tipos de Proposal
AddCredit (fiado) · RegisterCashPayment · SendReminder · CreateCustomer · CreatePayee · PayoutRequest
CreateMandate · RevokeMandate · CreateTanda · TandaContribution · TandaPayout · RefundCredit · Query (solo lectura)

## Catálogo de cuentas (por comercio)
1100 Cuenta operativa (espejo del saldo del proveedor)
1200 CxC clientes (subcuenta por cliente)
1300 SPEI por identificar
2100 Saldo a favor clientes
2200 Pozo de tanda por dispersar (subcuenta por tanda)
2400 Pagos en tránsito
4100 Ventas a crédito
5100 Compras a proveedores
5900 Diferencias y ajustes

## Asientos (generados solo por código)
- Fiado: D 1200 / H 4100
- Abono identificado: D 1100 / H 1200 (hasta el saldo) ; excedente H 2100
- Abono sin identificar: D 1100 / H 1300 → al identificar: D 1300 / H 1200
- Pago a proveedor creado: D 5100 / H 2400 → confirmado: D 2400 / H 1100 → fallido: reverso
- Tanda **sin pozo** (decisión 14-nov-2026): cada aportación se cobra por CoDi (pey) directo a la cuenta
  registrada del integrante en turno (`bankAccountId`). Cuadra no recibe ni dispersa dinero de tanda: **no hay
  asientos en el ledger del comercio**; el control vive en `tandas` / `tanda_members` / `tanda_charges`
  (idempotente por transacción del proveedor, una aportación pagada por integrante y ronda). Integrantes, CLABEs
  y orden se firman con passkey (CreateTanda) y se revalidan antes de cada ronda; si no coinciden, la tanda se
  congela. Las cuentas 2200 y el flujo de dispersión quedan sin uso.
- Devolución saldo a favor: D 2100 / H 2400 → confirmada: D 2400 / H 1100

## Guard de salidas (12 reglas)
R01 Schema válido; monto entero > 0 en centavos.
R02 Actor autorizado: teléfono verificado y rol correcto (comercio u organizadora).
R03 Beneficiario en lista blanca, CLABE con dígito verificador válido, titular validado.
R04 Beneficiario con menos de 24 h desde su alta → requiere passkey.
R05 Mandato vigente que cubre beneficiario y propósito; si no → requiere passkey.
R06 Tope por operación del mandato.
R07 Tope acumulado por periodo (mandato) y tope global diario del comercio.
R08 Saldo disponible suficiente (1100 − 2400 − retenciones) y conciliación del día OK.
R09 Duplicado: mismo beneficiario + monto + concepto en ventana de 10 min.
R10 Velocidad y horario: máx. N salidas/hora; fuera de 07:00–22:00 → requiere passkey.
R11 Procedencia: `third_party_content` no crea beneficiarios ni ejecuta sin passkey; datos bancarios solo del sistema.
R12 Estado de riesgo: kill switch, cuenta congelada, conciliación descuadrada o veto del auditor → deny.
Resultado: `allow` | `require_passkey` | `deny`, con `rules_failed[]`.

## Backlog acordado
- Registrar pagos en efectivo (RegisterCashPayment): requiere cuenta de caja en el catálogo; sirve para medir
  la parte no digital del tope Nivel 2 Bis (≤ 3,000 de 15,000 UDIs).

## Política de recordatorios (separada del guard)
Saldo en ledger > 0 · monto = saldo · máx. 1 por cliente cada 72 h · horario 09:00–20:00 · cliente con opt-in · tono dentro de plantilla aprobada.
Reenvío (decisión 14-nov-2026): la solicitud CoDi al celular dura 6 min (mínimo de pey). Si venció sin pago, el
comercio puede reenviarla (solo la solicitud, sin otro mensaje) hasta 3 veces por recordatorio; nunca mientras
haya una viva (pagaría doble) y nunca desde los recordatorios programados. Solo en desarrollo,
`REMINDER_MIN_INTERVAL_MINUTES` baja las 72 h (p. ej. 0 para probar seguido); en producción no se define.

## Conciliación de abonos (cascada)
1. CLABE virtual del cliente (si el proveedor la ofrece).
2. CLABE ordenante ya ligada a un cliente.
3. Referencia numérica o concepto que coincide con un cobro abierto.
4. Monto con centavos únicos asignado en el recordatorio.
5. Si nada coincide → 1300 y cola de revisión. Nunca adivinar.

## Convenciones
- Tests primero en `packages/core`. Cada PR con tests verdes.
- Nombres de dominio en español (cliente, fiado, tanda, mandato); código e identificadores técnicos en inglés está bien.
- Logs JSON con `merchant_id`, `proposal_id`, `idempotency_key`; sin PII innecesaria.
- No cambies invariantes del ledger ni reglas del guard sin pedir confirmación.
