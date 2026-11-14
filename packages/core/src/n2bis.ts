import { type Centavos, formatMXN } from "./money.js";

/**
 * Cuenta Nivel 2 Bis (Banxico, comunicado del 17-jun-2026, reforma a la Circular 3/2012):
 * pequeños comercios pueden recibir hasta 15,000 UDIs al mes, de las cuales al menos
 * 12,000 deben provenir de pagos digitales (es decir, a lo más 3,000 UDIs de otro origen).
 */
export const N2BIS_MONTHLY_UDIS = 15_000n;
export const N2BIS_MIN_DIGITAL_UDIS = 12_000n;
export const N2BIS_MAX_NON_DIGITAL_UDIS = N2BIS_MONTHLY_UDIS - N2BIS_MIN_DIGITAL_UDIS;

/** Valor de la UDI en millonésimas de peso (6 decimales, como lo publica Banxico). */
export type UdiMicro = bigint;

export function parseUdiValue(text: string): UdiMicro {
  const m = /^(\d{1,3})(?:\.(\d{1,6}))?$/.exec(text.trim());
  if (!m) throw new Error(`Valor de UDI inválido: "${text}"`);
  const v = BigInt(m[1]!) * 1_000_000n + BigInt((m[2] ?? "").padEnd(6, "0") || "0");
  if (v <= 0n) throw new Error("El valor de la UDI debe ser positivo");
  return v;
}

/** UDIs → centavos, redondeando hacia abajo (conservador para el tope). */
export function udisToCents(udis: bigint, udi: UdiMicro): Centavos {
  return (udis * udi) / 10_000n;
}

export type N2BisLevel = "ok" | "aviso" | "cerca" | "excedido";

export interface N2BisStatus {
  limit_cents: Centavos;
  non_digital_limit_cents: Centavos;
  received_cents: Centavos;
  non_digital_cents: Centavos;
  remaining_cents: Centavos;
  /** Porcentaje usado del tope mensual, entero (puede pasar de 100). */
  pct: number;
  level: N2BisLevel;
  non_digital_over: boolean;
  message: string;
}

/**
 * Estado del mes: depósitos digitales (CoDi/SPEI) y no digitales reportados contra los topes.
 * aviso ≥ 70 %, cerca ≥ 90 %, excedido > 100 % del tope mensual.
 */
export function n2bisStatus(i: { udi: UdiMicro; digital_cents: Centavos; non_digital_cents: Centavos }): N2BisStatus {
  if (i.digital_cents < 0n || i.non_digital_cents < 0n) throw new Error("Montos negativos");
  const limit = udisToCents(N2BIS_MONTHLY_UDIS, i.udi);
  const nonDigitalLimit = udisToCents(N2BIS_MAX_NON_DIGITAL_UDIS, i.udi);
  const received = i.digital_cents + i.non_digital_cents;
  const pct = Number((received * 100n) / limit);
  const remaining = limit > received ? limit - received : 0n;
  const nonDigitalOver = i.non_digital_cents > nonDigitalLimit;
  const level: N2BisLevel = received > limit ? "excedido" : pct >= 90 ? "cerca" : pct >= 70 ? "aviso" : "ok";
  const message =
    level === "excedido"
      ? `Este mes ya recibiste ${formatMXN(received)}, arriba del tope de tu cuenta Nivel 2 Bis (${formatMXN(limit)}). Habla con tu banco para subir a Nivel 3.`
      : level === "ok"
        ? `Vas en ${pct}% del tope mensual de tu cuenta Nivel 2 Bis; te quedan ${formatMXN(remaining)}.`
        : `Ojo: vas en ${pct}% del tope mensual de tu cuenta Nivel 2 Bis. Te quedan ${formatMXN(remaining)} este mes.`;
  return {
    limit_cents: limit,
    non_digital_limit_cents: nonDigitalLimit,
    received_cents: received,
    non_digital_cents: i.non_digital_cents,
    remaining_cents: remaining,
    pct,
    level,
    non_digital_over: nonDigitalOver,
    message,
  };
}
