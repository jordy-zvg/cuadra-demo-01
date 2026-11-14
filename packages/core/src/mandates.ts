import type { Centavos } from "./money.js";
import type { OutflowPurpose } from "./proposals.js";

export interface Mandate {
  id: string;
  merchant_id: string;
  payee_id: string;
  purpose: OutflowPurpose;
  per_op_cap_cents: Centavos;
  period_cap_cents: Centavos;
  period: "day" | "week" | "month";
  valid_from: Date;
  valid_until: Date;
  revoked_at: Date | null;
  /** Resultado de verificar la firma (passkey) con la que se creó. Lo calcula quien llama. */
  signature_valid: boolean;
}

/** Vigente: firma válida, no revocado y dentro de [valid_from, valid_until). */
export function isMandateActive(m: Mandate, now: Date): boolean {
  if (!m.signature_valid) return false;
  if (m.revoked_at !== null && m.revoked_at.getTime() <= now.getTime()) return false;
  return m.valid_from.getTime() <= now.getTime() && now.getTime() < m.valid_until.getTime();
}

/** Cubre al beneficiario y al propósito de la salida, para el mismo comercio. */
export function mandateCovers(
  m: Mandate,
  o: { merchant_id: string; payee_id: string; purpose: OutflowPurpose },
): boolean {
  return m.merchant_id === o.merchant_id && m.payee_id === o.payee_id && m.purpose === o.purpose;
}
