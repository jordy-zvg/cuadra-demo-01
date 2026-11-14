import { type Centavos, formatMXN } from "./money.js";
import { HOUR_MS, isWithinMxHours } from "./time.js";

export const REMINDER_MIN_INTERVAL_HOURS = 72;
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
  if (
    i.last_reminder_at !== null &&
    i.now.getTime() - i.last_reminder_at.getTime() < REMINDER_MIN_INTERVAL_HOURS * HOUR_MS
  ) {
    f.push({ rule_id: "P03", reason: "Ya se envió un recordatorio a este cliente en las últimas 72 horas." });
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
