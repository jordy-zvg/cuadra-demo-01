import type { Centavos } from "@cuadra/core";

/** pey usa pesos como número JSON. Convertimos solo en la frontera, sin aritmética flotante. */
export function centsToPesos(c: Centavos): number {
  if (c < 0n) throw new Error("Monto negativo");
  return Number(`${c / 100n}.${(c % 100n).toString().padStart(2, "0")}`);
}

/** Pesos (número JSON) a centavos exactos. Rechaza más de 2 decimales o notación rara. */
export function pesosToCents(n: number): Centavos {
  if (!Number.isFinite(n) || n < 0) throw new Error(`Monto inválido de pey: ${n}`);
  const s = String(n);
  const m = /^(\d+)(?:\.(\d{1,2}))?$/.exec(s);
  if (!m) throw new Error(`Monto con más de 2 decimales o formato inesperado: ${s}`);
  return BigInt(m[1]!) * 100n + BigInt((m[2] ?? "").padEnd(2, "0") || "0");
}
