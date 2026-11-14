/** Montos siempre en centavos como bigint. Nunca floats. */
export type Centavos = bigint;

const PESOS_RE = /^\$?\s*(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?$/;

/** Convierte un texto en pesos ("1,234.50", "$80", "80.5") a centavos. Lanza si no es válido. */
export function parsePesos(text: string): Centavos {
  const m = PESOS_RE.exec(text.trim());
  if (!m) throw new Error(`Monto inválido: "${text}"`);
  const pesos = BigInt(m[1]!.replace(/,/g, ""));
  const cents = BigInt((m[2] ?? "").padEnd(2, "0") || "0");
  return pesos * 100n + cents;
}

/** Formatea centavos como "$1,234.50". */
export function formatMXN(amount: Centavos): string {
  const neg = amount < 0n;
  const abs = neg ? -amount : amount;
  const pesos = (abs / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const cents = (abs % 100n).toString().padStart(2, "0");
  return `${neg ? "-" : ""}$${pesos}.${cents}`;
}

export function minCentavos(a: Centavos, b: Centavos): Centavos {
  return a < b ? a : b;
}
