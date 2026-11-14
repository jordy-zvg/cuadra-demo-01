import { type Centavos, formatMXN } from "./money.js";
import { HOUR_MS, isWithinMxHours } from "./time.js";

/** Máx. 1 recordatorio por cliente en este intervalo. Solo en desarrollo se configura otro (REMINDER_MIN_INTERVAL_MINUTES). */
export const REMINDER_MIN_INTERVAL_HOURS = 72;
/** Reenvíos de una solicitud CoDi vencida sin pago, por recordatorio (decisión 14-nov-2026). */
export const REMINDER_MAX_RESENDS = 3;
export const REMINDER_FROM_HOUR = 9;
export const REMINDER_TO_HOUR = 20;

export interface ReminderInput {
  now: Date;
  /** Saldo del cliente en el ledger (1200, subcuenta del cliente). */
  ledger_balance: Centavos;
  /** Monto que se pretende cobrar en el recordatorio. */
  amount: Centavos;
  last_reminder_at: Date | null;
  opt_in: boolean;
  template_id: string;
  approved_template_ids: readonly string[];
  /** Espera mínima entre recordatorios al mismo cliente; por defecto 72 h. La demo la baja por variable de entorno. */
  min_interval_ms?: number;
}

/** "72 horas", "1 minuto", "90 minutos"... para explicar la regla P03. */
function describeInterval(ms: number): string {
  const min = Math.round(ms / 60_000);
  if (min % 60 === 0) return `${min / 60} hora${min === 60 ? "" : "s"}`;
  return `${min} minuto${min === 1 ? "" : "s"}`;
}

export interface PolicyFailure {
  rule_id: string;
  reason: string;
}

export interface ReminderDecision {
  allow: boolean;
  rules_failed: PolicyFailure[];
}

export function evaluateReminder(i: ReminderInput): ReminderDecision {
  const f: PolicyFailure[] = [];
  if (i.ledger_balance <= 0n) {
    f.push({ rule_id: "P01", reason: "El cliente no tiene saldo pendiente." });
  }
  if (i.amount !== i.ledger_balance) {
    f.push({
      rule_id: "P02",
      reason: `El monto del recordatorio debe ser igual al saldo (${formatMXN(i.ledger_balance)}).`,
    });
  }
  const interval = i.min_interval_ms ?? REMINDER_MIN_INTERVAL_HOURS * HOUR_MS;
  if (i.last_reminder_at !== null && i.now.getTime() - i.last_reminder_at.getTime() < interval) {
    f.push({ rule_id: "P03", reason: `Ya se envió un recordatorio a este cliente en las últimas ${describeInterval(interval)}.` });
  }
  if (!isWithinMxHours(i.now, REMINDER_FROM_HOUR, REMINDER_TO_HOUR)) {
    f.push({ rule_id: "P04", reason: "Los recordatorios solo se envían entre 9:00 y 20:00." });
  }
  if (!i.opt_in) {
    f.push({ rule_id: "P05", reason: "El cliente no ha aceptado recibir mensajes." });
  }
  if (!i.approved_template_ids.includes(i.template_id)) {
    f.push({ rule_id: "P06", reason: "El mensaje no usa una plantilla aprobada." });
  }
  return { allow: f.length === 0, rules_failed: f };
}

export interface ResendInput {
  /** Último cobro del ciclo (el recordatorio o su último reenvío); null si no hay. */
  last_charge: { status: "open" | "paid" | "cancelled" | "expired"; channel: "codi_pn" | "codi_qr" | "payment_link" | null } | null;
  /** Reenvíos ya hechos del recordatorio vigente. */
  resends_in_cycle: number;
}

/**
 * Reenvío de una solicitud CoDi al celular. No es un recordatorio nuevo: no lleva mensaje y no
 * reinicia el plazo de P03. Solo cuando lo único que impide recordar es P03, la solicitud anterior
 * venció sin pago (no hay una viva que se pueda pagar dos veces) y no se pasó del máximo.
 */
export function evaluateResend(reminder: ReminderDecision, i: ResendInput): ReminderDecision {
  const others = reminder.rules_failed.filter((r) => r.rule_id !== "P03");
  if (!reminder.rules_failed.some((r) => r.rule_id === "P03")) {
    // Sin P03 no hay nada que reenviar: lo que procede es un recordatorio normal.
    return { allow: false, rules_failed: [...others, { rule_id: "P07", reason: "No hay un recordatorio reciente que reenviar." }] };
  }
  const f: PolicyFailure[] = [...others];
  if (!i.last_charge || i.last_charge.channel !== "codi_pn" || i.last_charge.status !== "expired") {
    f.push({ rule_id: "P07", reason: "Solo se reenvía una solicitud CoDi al celular que venció sin pago." });
  }
  if (i.resends_in_cycle >= REMINDER_MAX_RESENDS) {
    f.push({ rule_id: "P08", reason: `Ya se reenvió la solicitud ${REMINDER_MAX_RESENDS} veces.` });
  }
  return { allow: f.length === 0, rules_failed: f };
}
