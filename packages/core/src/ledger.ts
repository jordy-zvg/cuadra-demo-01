import { type Centavos, minCentavos } from "./money.js";

/** Catálogo de cuentas por comercio. */
export const ACCOUNTS = {
  /** Efectivo que el comercio recibió en mano (abonos de fiado). Nunca entra a la cuenta operativa. */
  "1050": { name: "Efectivo en caja", normal: "debit" },
  "1100": { name: "Cuenta operativa", normal: "debit" },
  "1200": { name: "CxC clientes", normal: "debit" },
  "1300": { name: "SPEI por identificar", normal: "credit" },
  "2100": { name: "Saldo a favor clientes", normal: "credit" },
  "2200": { name: "Pozo de tanda por dispersar", normal: "credit" },
  "2400": { name: "Pagos en tránsito", normal: "credit" },
  "4100": { name: "Ventas a crédito", normal: "credit" },
  "5100": { name: "Compras a proveedores", normal: "debit" },
  "5900": { name: "Diferencias y ajustes", normal: "debit" },
} as const;

export type AccountCode = keyof typeof ACCOUNTS;

export interface EntryLine {
  account: AccountCode;
  /** Subcuenta: id de cliente (1200, 2100) o de tanda (2200). */
  subaccount?: string;
  debit: Centavos;
  credit: Centavos;
}

export type EntryKind =
  | "fiado"
  | "abono_identificado"
  | "abono_sin_identificar"
  | "abono_identificacion"
  | "abono_efectivo"
  | "pago_proveedor_creado"
  | "pago_confirmado"
  | "tanda_aportacion"
  | "tanda_dispersion"
  | "devolucion_saldo_a_favor"
  | "reverso";

export interface JournalEntry {
  merchant_id: string;
  idempotency_key: string;
  kind: EntryKind;
  memo: string;
  lines: EntryLine[];
  /** idempotency_key del asiento que este reversa (solo kind = "reverso"). */
  reverses?: string;
}

export class LedgerError extends Error {}

const D = (account: AccountCode, amount: Centavos, subaccount?: string): EntryLine =>
  subaccount === undefined
    ? { account, debit: amount, credit: 0n }
    : { account, subaccount, debit: amount, credit: 0n };
const H = (account: AccountCode, amount: Centavos, subaccount?: string): EntryLine =>
  subaccount === undefined
    ? { account, debit: 0n, credit: amount }
    : { account, subaccount, debit: 0n, credit: amount };

/** Invariantes de un asiento: Σdebe = Σhaber, cada línea con un solo lado > 0. */
export function validateEntry(entry: JournalEntry): void {
  if (!entry.idempotency_key) throw new LedgerError("Asiento sin idempotency_key");
  if (!entry.merchant_id) throw new LedgerError("Asiento sin merchant_id");
  if (entry.lines.length < 2) throw new LedgerError("Un asiento necesita al menos dos líneas");
  let debit = 0n;
  let credit = 0n;
  for (const l of entry.lines) {
    if (!(l.account in ACCOUNTS)) throw new LedgerError(`Cuenta desconocida: ${l.account}`);
    if (l.debit < 0n || l.credit < 0n) throw new LedgerError("Montos negativos no permitidos");
    if ((l.debit > 0n) === (l.credit > 0n)) {
      throw new LedgerError("Cada línea lleva exactamente un lado (debe o haber) mayor a cero");
    }
    debit += l.debit;
    credit += l.credit;
  }
  if (debit !== credit) throw new LedgerError(`Asiento descuadrado: debe ${debit} ≠ haber ${credit}`);
}

interface Base {
  merchant_id: string;
  idempotency_key: string;
  amount: Centavos;
  memo?: string;
}

function build(b: Base, kind: EntryKind, lines: EntryLine[], defaultMemo: string): JournalEntry {
  if (b.amount <= 0n) throw new LedgerError("El monto debe ser mayor a cero");
  const entry: JournalEntry = {
    merchant_id: b.merchant_id,
    idempotency_key: b.idempotency_key,
    kind,
    memo: b.memo ?? defaultMemo,
    lines: lines.filter((l) => l.debit > 0n || l.credit > 0n),
  };
  validateEntry(entry);
  return entry;
}

/** Fiado: D 1200 / H 4100 */
export function fiado(b: Base & { customer_id: string }): JournalEntry {
  return build(b, "fiado", [D("1200", b.amount, b.customer_id), H("4100", b.amount)], "Fiado");
}

/** Abono identificado: D 1100 / H 1200 (hasta el saldo); excedente H 2100. */
export function abonoIdentificado(
  b: Base & { customer_id: string; customer_balance: Centavos },
): JournalEntry {
  const [toCxC, excess] = splitAbono(b.amount, b.customer_balance);
  return build(
    b,
    "abono_identificado",
    [D("1100", b.amount), H("1200", toCxC, b.customer_id), H("2100", excess, b.customer_id)],
    "Abono por SPEI",
  );
}

/**
 * Abono en efectivo: D 1050 / H 1200. Solo hasta el saldo del cliente: el efectivo de más se lo
 * regresa el comercio en mano, no queda como saldo a favor. No toca 1100 (la cuenta operativa sigue
 * siendo el espejo del proveedor) ni cuenta para el saldo disponible de las salidas (R08).
 */
export function abonoEfectivo(b: Base & { customer_id: string; customer_balance: Centavos }): JournalEntry {
  if (b.amount > b.customer_balance) {
    throw new LedgerError("Un abono en efectivo no puede pasar del saldo del cliente");
  }
  return build(b, "abono_efectivo", [D("1050", b.amount), H("1200", b.amount, b.customer_id)], "Abono en efectivo");
}

/** Abono sin identificar: D 1100 / H 1300 */
export function abonoSinIdentificar(b: Base): JournalEntry {
  return build(b, "abono_sin_identificar", [D("1100", b.amount), H("1300", b.amount)], "SPEI por identificar");
}

/** Identificación posterior: D 1300 / H 1200 (hasta el saldo); excedente H 2100. */
export function identificarAbono(
  b: Base & { customer_id: string; customer_balance: Centavos },
): JournalEntry {
  const [toCxC, excess] = splitAbono(b.amount, b.customer_balance);
  return build(
    b,
    "abono_identificacion",
    [D("1300", b.amount), H("1200", toCxC, b.customer_id), H("2100", excess, b.customer_id)],
    "Abono identificado",
  );
}

function splitAbono(amount: Centavos, balance: Centavos): [Centavos, Centavos] {
  const toCxC = minCentavos(amount, balance > 0n ? balance : 0n);
  return [toCxC, amount - toCxC];
}

/** Pago a proveedor creado: D 5100 / H 2400 */
export function pagoProveedorCreado(b: Base): JournalEntry {
  return build(b, "pago_proveedor_creado", [D("5100", b.amount), H("2400", b.amount)], "Pago a proveedor");
}

/** Salida confirmada por el proveedor (pago, dispersión o devolución): D 2400 / H 1100 */
export function pagoConfirmado(b: Base): JournalEntry {
  return build(b, "pago_confirmado", [D("2400", b.amount), H("1100", b.amount)], "Salida confirmada");
}

/** Aportación de tanda: D 1100 / H 2200 */
export function tandaAportacion(b: Base & { tanda_id: string }): JournalEntry {
  return build(b, "tanda_aportacion", [D("1100", b.amount), H("2200", b.amount, b.tanda_id)], "Aportación de tanda");
}

/** Dispersión de tanda: D 2200 / H 2400 */
export function tandaDispersion(b: Base & { tanda_id: string }): JournalEntry {
  return build(b, "tanda_dispersion", [D("2200", b.amount, b.tanda_id), H("2400", b.amount)], "Dispersión de tanda");
}

/** Devolución de saldo a favor: D 2100 / H 2400 */
export function devolucionSaldoAFavor(b: Base & { customer_id: string }): JournalEntry {
  return build(
    b,
    "devolucion_saldo_a_favor",
    [D("2100", b.amount, b.customer_id), H("2400", b.amount)],
    "Devolución de saldo a favor",
  );
}

/** Reverso: mismo asiento con debe y haber invertidos. Única forma de corregir. */
export function reverso(original: JournalEntry, idempotency_key: string): JournalEntry {
  const entry: JournalEntry = {
    merchant_id: original.merchant_id,
    idempotency_key,
    kind: "reverso",
    memo: `Reverso de: ${original.memo}`,
    reverses: original.idempotency_key,
    lines: original.lines.map((l) => ({ ...l, debit: l.credit, credit: l.debit })),
  };
  validateEntry(entry);
  return entry;
}

/**
 * Saldo de una cuenta según su naturaleza (deudora: debe − haber; acreedora: haber − debe).
 * Si se pasa subaccount, solo esa subcuenta.
 */
export function accountBalance(
  entries: readonly JournalEntry[],
  account: AccountCode,
  subaccount?: string,
): Centavos {
  let debit = 0n;
  let credit = 0n;
  for (const e of entries) {
    for (const l of e.lines) {
      if (l.account !== account) continue;
      if (subaccount !== undefined && l.subaccount !== subaccount) continue;
      debit += l.debit;
      credit += l.credit;
    }
  }
  return ACCOUNTS[account].normal === "debit" ? debit - credit : credit - debit;
}

/**
 * Aplica asientos a un libro en memoria respetando idempotencia: una llave repetida no se
 * vuelve a registrar. Devuelve un libro nuevo (append-only, sin mutar el original).
 */
export function appendEntries(
  book: readonly JournalEntry[],
  entries: readonly JournalEntry[],
): JournalEntry[] {
  const seen = new Set(book.map((e) => e.idempotency_key));
  const out = [...book];
  for (const e of entries) {
    if (seen.has(e.idempotency_key)) continue;
    validateEntry(e);
    seen.add(e.idempotency_key);
    out.push(e);
  }
  return out;
}

/** Asiento de creación de una salida según su propósito (los tres acreditan 2400). */
export function salidaCreada(
  b: Base & { purpose: "proveedor" | "tanda" | "devolucion"; tanda_id?: string; customer_id?: string },
): JournalEntry {
  switch (b.purpose) {
    case "proveedor":
      return pagoProveedorCreado(b);
    case "tanda":
      if (!b.tanda_id) throw new LedgerError("Dispersión de tanda sin tanda_id");
      return tandaDispersion({ ...b, tanda_id: b.tanda_id });
    case "devolucion":
      if (!b.customer_id) throw new LedgerError("Devolución sin customer_id");
      return devolucionSaldoAFavor({ ...b, customer_id: b.customer_id });
  }
}
