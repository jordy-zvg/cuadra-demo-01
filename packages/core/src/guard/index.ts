import { isValidClabe } from "../clabe.js";
import { isMandateActive, mandateCovers, type Mandate } from "../mandates.js";
import { type Centavos, formatMXN } from "../money.js";
import {
  OutflowProposal,
  outflowPurpose,
  proposalHash,
  type Provenance,
} from "../proposals.js";
import { HOUR_MS, MINUTE_MS, isAllDay, isValidHourRange, isWithinMxHours } from "../time.js";

export type RuleId =
  | "R01" | "R02" | "R03" | "R04" | "R05" | "R06"
  | "R07" | "R08" | "R09" | "R10" | "R11" | "R12";

export type GuardDecision = "allow" | "require_passkey" | "deny";

export interface RuleFailure {
  rule_id: RuleId;
  effect: "deny" | "require_passkey";
  /** Motivo legible en español. */
  reason: string;
}

export interface GuardResult {
  decision: GuardDecision;
  rules_failed: RuleFailure[];
  /** true si la salida se permite gracias a una aprobación con passkey ligada al hash exacto. */
  approved_by_passkey: boolean;
}

export const NEW_PAYEE_HOURS = 24;
export const DUPLICATE_WINDOW_MINUTES = 10;
export const OUTFLOW_FROM_HOUR = 7;
export const OUTFLOW_TO_HOUR = 22;
const AUTHORIZED_ROLES: readonly string[] = ["comercio", "organizadora"];
const BANK_DATA_KEYS: readonly string[] = ["clabe", "account_number", "cuenta", "tarjeta", "card_number"];

export interface GuardPayee {
  id: string;
  merchant_id: string;
  /** CLABE leída de la DB, nunca de la propuesta. */
  clabe: string;
  whitelisted: boolean;
  holder_validated: boolean;
  created_at: Date;
}

export interface RecentOutflow {
  payee_id: string;
  amount_cents: Centavos;
  concept: string;
  created_at: Date;
}

/** Aprobación con passkey ya verificada criptográficamente por quien llama. */
export interface PasskeyApproval {
  proposal_hash: string;
  signature_valid: boolean;
  expires_at: Date;
  used: boolean;
}

export interface GuardInput {
  /** Propuesta cruda (sin validar): R01 la valida. */
  proposal: unknown;
  now: Date;
  actor: { phone_verified: boolean; role: string };
  /** Beneficiario leído de la DB por payee_id; null si no existe. */
  payee: GuardPayee | null;
  /** Mandato candidato del comercio para este beneficiario; null si no hay. */
  mandate: Mandate | null;
  /** Acumulado ya ejecutado con este mandato en su periodo vigente. */
  mandate_spent_in_period: Centavos;
  merchant: {
    daily_limit_cents: Centavos;
    spent_today_cents: Centavos;
    max_outflows_per_hour: number;
  };
  balances: { operating_1100: Centavos; in_transit_2400: Centavos; holds: Centavos };
  reconciliation_ok_today: boolean;
  /** Salidas recientes del comercio (creadas o en tránsito), sin incluir la actual. */
  recent_outflows: readonly RecentOutflow[];
  risk: {
    kill_switch: boolean;
    account_frozen: boolean;
    reconciliation_mismatch: boolean;
    auditor_veto: boolean;
  };
  approval: PasskeyApproval | null;
  /**
   * Horario de salidas sin passkey [desde, hasta) en CDMX (R10). Sin valor o inválido: 7 a 22.
   * [0, 24] = sin límite de hora (OUTFLOW_HOURS, decisión 14-nov-2026 para la demo). El tope de
   * salidas por hora de R10 aplica siempre.
   */
  outflow_hours?: readonly [number, number];
}

const deny = (rule_id: RuleId, reason: string): RuleFailure => ({ rule_id, effect: "deny", reason });
const passkey = (rule_id: RuleId, reason: string): RuleFailure => ({
  rule_id,
  effect: "require_passkey",
  reason,
});

function finish(failures: RuleFailure[], approvalOk: boolean): GuardResult {
  if (failures.some((f) => f.effect === "deny")) {
    return { decision: "deny", rules_failed: failures, approved_by_passkey: false };
  }
  if (failures.length > 0 && !approvalOk) {
    return { decision: "require_passkey", rules_failed: failures, approved_by_passkey: false };
  }
  return { decision: "allow", rules_failed: failures, approved_by_passkey: failures.length > 0 };
}

const normalize = (s: string): string => s.trim().toLowerCase().replace(/\s+/g, " ");

/** R12 — Estado de riesgo. */
export function checkRisk(risk: GuardInput["risk"]): RuleFailure[] {
  const f: RuleFailure[] = [];
  if (risk.kill_switch) f.push(deny("R12", "Las salidas están detenidas (interruptor de emergencia)."));
  if (risk.account_frozen) f.push(deny("R12", "La cuenta está congelada."));
  if (risk.reconciliation_mismatch) {
    f.push(deny("R12", "El saldo no cuadra con el del proveedor; las salidas están congeladas."));
  }
  if (risk.auditor_veto) f.push(deny("R12", "El auditor vetó esta operación."));
  return f;
}

/** R11 (parte dura) — la propuesta no puede traer datos bancarios. */
function carriesBankData(raw: unknown): boolean {
  return (
    typeof raw === "object" &&
    raw !== null &&
    Object.keys(raw).some((k) => BANK_DATA_KEYS.includes(k.toLowerCase()))
  );
}

/**
 * Guard de salidas. Función pura: misma entrada, mismo resultado.
 * El executor la vuelve a correr justo antes de ejecutar.
 */
export function evaluateOutflow(input: GuardInput): GuardResult {
  const f: RuleFailure[] = [];

  // R01 — Schema válido; monto entero > 0 en centavos.
  const parsed = OutflowProposal.safeParse(input.proposal);
  if (carriesBankData(input.proposal)) {
    f.push(deny("R11", "La instrucción trae datos bancarios; solo se usan los guardados en el sistema."));
  }
  if (!parsed.success) {
    f.push(deny("R01", "La instrucción no es válida o el monto no es un entero positivo en centavos."));
    f.push(...checkRisk(input.risk));
    return finish(f, false);
  }
  const p = parsed.data;
  const amount = p.amount_cents;
  const purpose = outflowPurpose(p);
  const now = input.now.getTime();

  // R02 — Actor autorizado.
  if (!input.actor.phone_verified) f.push(deny("R02", "El teléfono no está verificado."));
  if (!AUTHORIZED_ROLES.includes(input.actor.role)) {
    f.push(deny("R02", "Solo el comercio o la organizadora pueden pedir salidas de dinero."));
  }

  // R03 — Beneficiario en lista blanca, CLABE válida, titular validado.
  const payee = input.payee;
  if (payee === null || payee.id !== p.payee_id || payee.merchant_id !== p.merchant_id) {
    f.push(deny("R03", "El beneficiario no está dado de alta en este comercio."));
  } else {
    if (!payee.whitelisted) f.push(deny("R03", "El beneficiario no está en la lista autorizada."));
    if (!isValidClabe(payee.clabe)) f.push(deny("R03", "La CLABE del beneficiario no es válida."));
    if (!payee.holder_validated) f.push(deny("R03", "El titular de la cuenta no ha sido validado."));

    // R04 — Beneficiario con menos de 24 h desde su alta.
    if (now - payee.created_at.getTime() < NEW_PAYEE_HOURS * HOUR_MS) {
      f.push(passkey("R04", "El beneficiario se dio de alta hace menos de 24 horas."));
    }
  }

  // R05 — Mandato vigente que cubre beneficiario y propósito.
  const m = input.mandate;
  const covered =
    m !== null &&
    isMandateActive(m, input.now) &&
    mandateCovers(m, { merchant_id: p.merchant_id, payee_id: p.payee_id, purpose });
  if (!covered) {
    f.push(passkey("R05", "No hay un permiso vigente que cubra este pago."));
  } else {
    // R06 — Tope por operación del mandato.
    if (amount > m.per_op_cap_cents) {
      f.push(
        passkey("R06", `El monto rebasa el tope por operación del permiso (${formatMXN(m.per_op_cap_cents)}).`),
      );
    }
    // R07a — Tope acumulado por periodo del mandato.
    if (input.mandate_spent_in_period + amount > m.period_cap_cents) {
      f.push(
        passkey("R07", `El pago rebasa el tope del periodo del permiso (${formatMXN(m.period_cap_cents)}).`),
      );
    }
  }

  // R07b — Tope global diario del comercio.
  if (input.merchant.spent_today_cents + amount > input.merchant.daily_limit_cents) {
    f.push(deny("R07", `El pago rebasa el tope diario (${formatMXN(input.merchant.daily_limit_cents)}).`));
  }

  // R08 — Saldo disponible suficiente y conciliación del día OK.
  const available =
    input.balances.operating_1100 - input.balances.in_transit_2400 - input.balances.holds;
  if (amount > available) {
    f.push(deny("R08", `Saldo disponible insuficiente (${formatMXN(available)}).`));
  }
  if (!input.reconciliation_ok_today) {
    f.push(deny("R08", "La conciliación de hoy aún no está en orden."));
  }

  // R09 — Duplicado en ventana de 10 min.
  const concept = normalize(p.concept);
  const duplicate = input.recent_outflows.some(
    (o) =>
      o.payee_id === p.payee_id &&
      o.amount_cents === amount &&
      normalize(o.concept) === concept &&
      now - o.created_at.getTime() < DUPLICATE_WINDOW_MINUTES * MINUTE_MS,
  );
  if (duplicate) {
    f.push(deny("R09", "Ya hay un pago igual (mismo beneficiario, monto y concepto) en los últimos 10 minutos."));
  }

  // R10 — Velocidad y horario.
  const lastHour = input.recent_outflows.filter((o) => now - o.created_at.getTime() < HOUR_MS).length;
  if (lastHour >= input.merchant.max_outflows_per_hour) {
    f.push(deny("R10", "Se alcanzó el máximo de salidas por hora."));
  }
  const [fromH, toH] =
    input.outflow_hours && isValidHourRange(input.outflow_hours) ? input.outflow_hours : [OUTFLOW_FROM_HOUR, OUTFLOW_TO_HOUR];
  if (!isAllDay([fromH, toH]) && !isWithinMxHours(input.now, fromH, toH)) {
    f.push(passkey("R10", `Fuera del horario de ${fromH}:00 a ${toH}:00.`));
  }

  // R11 — Procedencia.
  if (p.provenance === "third_party_content") {
    f.push(passkey("R11", "La instrucción viene de una foto, documento o mensaje reenviado."));
  }

  // R12 — Estado de riesgo.
  f.push(...checkRisk(input.risk));

  // Principio 8: la aprobación vale solo si está ligada al hash exacto de la propuesta.
  const a = input.approval;
  const approvalOk =
    a !== null &&
    a.signature_valid &&
    !a.used &&
    now < a.expires_at.getTime() &&
    a.proposal_hash === proposalHash(p);

  return finish(f, approvalOk);
}

/**
 * Alta de beneficiario (no mueve dinero). R11: contenido de terceros nunca crea
 * beneficiarios sin passkey. R12 aplica igual.
 */
export function evaluateCreatePayee(input: {
  provenance: Provenance;
  actor: GuardInput["actor"];
  risk: GuardInput["risk"];
  passkey_approved: boolean;
}): GuardResult {
  const f: RuleFailure[] = [];
  if (!input.actor.phone_verified) f.push(deny("R02", "El teléfono no está verificado."));
  if (!AUTHORIZED_ROLES.includes(input.actor.role)) {
    f.push(deny("R02", "Solo el comercio o la organizadora pueden dar de alta beneficiarios."));
  }
  if (input.provenance === "third_party_content") {
    f.push(passkey("R11", "Los datos vienen de una foto, documento o mensaje reenviado."));
  }
  f.push(...checkRisk(input.risk));
  return finish(f, input.passkey_approved);
}
