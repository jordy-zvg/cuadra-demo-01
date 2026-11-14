import type { Centavos } from "./money.js";

/** Abono SPEI recibido, tal como lo reporta el proveedor. */
export interface Deposit {
  clave_rastreo: string;
  amount: Centavos;
  /** CLABE destino (virtual) si el proveedor asigna una por cliente. */
  destination_clabe?: string;
  ordering_clabe?: string;
  reference?: string;
  concept?: string;
}

export interface OpenCharge {
  customer_id: string;
  /** Referencia numérica asignada al cobro. */
  reference: string;
  /** Monto con centavos únicos asignado en el recordatorio. */
  unique_amount?: Centavos;
}

export interface MatchContext {
  /** CLABE virtual → cliente. */
  virtual_clabes: ReadonlyMap<string, string>;
  /** CLABE ordenante ya ligada → cliente. */
  linked_ordering_clabes: ReadonlyMap<string, string>;
  open_charges: readonly OpenCharge[];
}

export type MatchMethod = "virtual_clabe" | "ordering_clabe" | "reference" | "unique_amount";

export type MatchResult =
  | { matched: true; customer_id: string; method: MatchMethod }
  | { matched: false; account: "1300"; reason: string };

/** Devuelve el cliente solo si hay exactamente uno. Nunca adivina. */
function unique(ids: string[]): string | null {
  const set = new Set(ids);
  return set.size === 1 ? ids[0]! : null;
}

const digits = (s: string | undefined): string[] => s?.match(/\d+/g) ?? [];

/** Cascada de conciliación: gana el primer paso con un único cliente. */
export function matchDeposit(d: Deposit, ctx: MatchContext): MatchResult {
  const byVirtual = d.destination_clabe ? ctx.virtual_clabes.get(d.destination_clabe) : undefined;
  if (byVirtual) return { matched: true, customer_id: byVirtual, method: "virtual_clabe" };

  const byOrdering = d.ordering_clabe ? ctx.linked_ordering_clabes.get(d.ordering_clabe) : undefined;
  if (byOrdering) return { matched: true, customer_id: byOrdering, method: "ordering_clabe" };

  const tokens = new Set([...digits(d.reference), ...digits(d.concept)]);
  const byRef = unique(ctx.open_charges.filter((c) => tokens.has(c.reference)).map((c) => c.customer_id));
  if (byRef) return { matched: true, customer_id: byRef, method: "reference" };

  const byAmount = unique(
    ctx.open_charges.filter((c) => c.unique_amount === d.amount).map((c) => c.customer_id),
  );
  if (byAmount) return { matched: true, customer_id: byAmount, method: "unique_amount" };

  return {
    matched: false,
    account: "1300",
    reason: "No se pudo identificar al cliente; el abono queda por identificar y pasa a revisión.",
  };
}

export interface BalanceCheck {
  ok: boolean;
  /** (ledger − en vuelo) − proveedor. */
  difference: Centavos;
  freeze_outflows: boolean;
}

/**
 * Principio 9: si el ledger (1100) ≠ saldo del proveedor, se congelan salidas.
 * in_flight: transferencias ya enviadas (el proveedor ya las debitó) que aún no se
 * confirman; la 1100 solo baja al confirmarse, así que se descuentan para comparar.
 */
export function checkBalance(
  ledger_1100: Centavos,
  provider_balance: Centavos,
  in_flight: Centavos = 0n,
): BalanceCheck {
  const difference = ledger_1100 - in_flight - provider_balance;
  const ok = difference === 0n;
  return { ok, difference, freeze_outflows: !ok };
}
