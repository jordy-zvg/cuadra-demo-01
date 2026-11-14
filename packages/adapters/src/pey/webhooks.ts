/**
 * Webhooks de pey: firmados con Standard Webhooks (headers webhook-id, webhook-timestamp,
 * webhook-signature). webhook-id es la llave de idempotencia.
 * Fuente: https://docs.pey.mx/en/docs/webhooks/introduction
 */
import { Webhook, WebhookVerificationError } from "standardwebhooks";
import { z } from "zod";
import { WebhookSignatureError } from "../payments/types.js";

const CodiPayment = z.object({
  type: z.enum(["codi.pn.payment_received", "codi.qr.payment_received"]),
  transactionId: z.string().min(1),
  amount: z.number(),
  numRef: z.string().optional(),
  concept: z.string().optional(),
  datePaid: z.number().optional(),
  codiQrId: z.string().optional(),
});
const LinkUpdate = z.object({
  type: z.literal("payment_link.status_updated"),
  paymentLinkId: z.string(),
  status: z.string(),
  clientReferenceId: z.string().optional(),
  transactions: z.array(z.object({ transactionId: z.string() }).passthrough()).default([]),
});

export type PeyWebhookEvent =
  | { kind: "payment"; event_id: string; transaction_ids: string[]; source: string }
  | { kind: "ignored"; event_id: string; original_type: string };

/**
 * Verifica la firma y devuelve qué transacciones hay que confirmar. No confiamos en el
 * monto del webhook: quien llama confirma cada transacción con GET /transaction/{id}.
 */
export function parsePeyWebhook(
  rawBody: string,
  headers: Readonly<Record<string, string | undefined>>,
  secret: string,
): PeyWebhookEvent {
  const h = {
    "webhook-id": headers["webhook-id"] ?? "",
    "webhook-timestamp": headers["webhook-timestamp"] ?? "",
    "webhook-signature": headers["webhook-signature"] ?? "",
  };
  try {
    new Webhook(secret).verify(rawBody, h);
  } catch (e) {
    if (e instanceof WebhookVerificationError || e instanceof Error) {
      throw new WebhookSignatureError(`Firma de pey inválida: ${e.message}`);
    }
    throw e;
  }
  const event_id = h["webhook-id"];
  const body: unknown = JSON.parse(rawBody);
  const pay = CodiPayment.safeParse(body);
  if (pay.success) return { kind: "payment", event_id, transaction_ids: [pay.data.transactionId], source: pay.data.type };
  const link = LinkUpdate.safeParse(body);
  if (link.success) {
    if (link.data.status !== "paid") return { kind: "ignored", event_id, original_type: `payment_link.${link.data.status}` };
    return { kind: "payment", event_id, transaction_ids: link.data.transactions.map((t) => t.transactionId), source: link.data.type };
  }
  const type = z.object({ type: z.string() }).safeParse(body);
  return { kind: "ignored", event_id, original_type: type.success ? type.data.type : "desconocido" };
}

/** Solo para tests y el simulador: firma como lo haría pey. */
export function signPeyWebhook(secret: string, id: string, body: string, at = new Date()): Record<string, string> {
  return {
    "webhook-id": id,
    "webhook-timestamp": Math.floor(at.getTime() / 1000).toString(),
    "webhook-signature": new Webhook(secret).sign(id, at, body),
  };
}
