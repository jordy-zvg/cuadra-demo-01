import type { Centavos } from "@cuadra/core";
import { z } from "zod";

/** Lo que el executor le pide al proveedor. La CLABE sale de la DB, nunca de la propuesta. */
export interface TransferRequest {
  idempotency_key: string;
  clabe: string;
  holder_name: string;
  amount_cents: Centavos;
  concept: string;
}

export type TransferResponse =
  | { provider_ref: string; status: "sent" }
  | { provider_ref: string; status: "failed"; failure_reason: string };

/** Solo apps/executor instancia un PaymentProvider con credenciales. */
export interface PaymentProvider {
  readonly name: string;
  /** Debe ser idempotente por idempotency_key. */
  createTransfer(req: TransferRequest): Promise<TransferResponse>;
  getBalance(): Promise<Centavos>;
}

const cents = z.string().regex(/^\d{1,15}$/).transform((v) => BigInt(v));

/** Evento de webhook ya verificado y normalizado. */
export const ProviderEvent = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("transfer.confirmed"),
    event_id: z.string().min(1),
    provider_ref: z.string().min(1),
  }),
  z.object({
    type: z.literal("transfer.failed"),
    event_id: z.string().min(1),
    provider_ref: z.string().min(1),
    failure_reason: z.string(),
  }),
  z.object({
    type: z.literal("deposit.received"),
    event_id: z.string().min(1),
    clave_rastreo: z.string().min(1).max(30),
    amount_cents: cents,
    destination_clabe: z.string().optional(),
    ordering_clabe: z.string().optional(),
    reference: z.string().optional(),
    concept: z.string().optional(),
  }),
]);
export type ProviderEvent = z.infer<typeof ProviderEvent>;

export class WebhookSignatureError extends Error {}

export interface WebhookParser {
  /** Verifica firma y forma. Lanza WebhookSignatureError si la firma no es válida. */
  parseWebhook(rawBody: string, headers: Readonly<Record<string, string | undefined>>): ProviderEvent;
}
