import type { Centavos } from "@cuadra/core";
import type { Db } from "./client.js";
import { type DepositOutcome, recordDeposit } from "./deposits.js";
import { eq } from "drizzle-orm";
import { merchants, webhookEvents } from "./schema.js";
import { confirmTransfer, failTransfer, findTransferByRef, returnTransfer } from "./transfers.js";

/** Evento ya verificado (firma) y normalizado por el adapter del proveedor. */
export type VerifiedEvent =
  | { type: "transfer.confirmed"; event_id: string; provider_ref: string }
  | { type: "transfer.failed"; event_id: string; provider_ref: string; failure_reason: string }
  | { type: "transfer.returned"; event_id: string; provider_ref: string; return_reason: string }
  | { type: "ignored"; event_id: string; original_type: string }
  | {
      type: "deposit.received";
      event_id: string;
      clave_rastreo: string;
      amount_cents: Centavos;
      destination_clabe?: string | undefined;
      ordering_clabe?: string | undefined;
      reference?: string | undefined;
      concept?: string | undefined;
      provider_account_id?: string | undefined;
    };

export class UnknownTransferError extends Error {}

export type EventOutcome =
  | { status: "duplicate" }
  | { status: "ignored" }
  | { status: "transfer_confirmed" | "transfer_failed" | "transfer_returned"; transfer_id: string }
  | { status: "deposit"; outcome: DepositOutcome };

/** Comercio dueño de una cuenta operativa del proveedor (para rutear webhooks). */
export async function merchantByProviderAccount(db: Db, providerAccountId: string): Promise<string | null> {
  const [m] = await db.select({ id: merchants.id }).from(merchants).where(eq(merchants.providerAccountId, providerAccountId));
  return m?.id ?? null;
}

/**
 * Aplica un webhook una sola vez (provider + event_id). Si algo falla, la transacción se
 * revierte y el proveedor puede reintentar.
 */
export async function applyProviderEvent(
  db: Db,
  provider: string,
  merchantId: string,
  event: VerifiedEvent,
): Promise<EventOutcome> {
  return db.transaction(async (tx) => {
    const fresh = await tx
      .insert(webhookEvents)
      .values({ provider, eventId: event.event_id, payload: JSON.parse(JSON.stringify(event, (_k, v) => (typeof v === "bigint" ? v.toString() : v))) })
      .onConflictDoNothing()
      .returning({ id: webhookEvents.eventId });
    if (fresh.length === 0) return { status: "duplicate" };
    if (event.type === "ignored") return { status: "ignored" };

    if (event.type === "deposit.received") {
      const outcome = await recordDeposit(tx, merchantId, {
        clave_rastreo: event.clave_rastreo,
        amount: event.amount_cents,
        ...(event.destination_clabe ? { destination_clabe: event.destination_clabe } : {}),
        ...(event.ordering_clabe ? { ordering_clabe: event.ordering_clabe } : {}),
        ...(event.reference ? { reference: event.reference } : {}),
        ...(event.concept ? { concept: event.concept } : {}),
      });
      return { status: "deposit", outcome };
    }

    const t = await findTransferByRef(tx, event.provider_ref);
    if (!t || t.merchantId !== merchantId) {
      throw new UnknownTransferError(`Transferencia con provider_ref ${event.provider_ref} no encontrada`);
    }
    if (event.type === "transfer.confirmed") {
      await confirmTransfer(tx, t.id);
      return { status: "transfer_confirmed", transfer_id: t.id };
    }
    if (event.type === "transfer.returned") {
      await returnTransfer(tx, t.id, event.return_reason);
      return { status: "transfer_returned", transfer_id: t.id };
    }
    // En SPEI, "failed" solo ocurre desde pending: si ya se confirmó, algo no cuadra.
    if (t.status === "confirmed" || t.status === "returned") {
      throw new Error(`Evento de fallo para transferencia ${t.id} ya ${t.status}; requiere revisión`);
    }
    await failTransfer(tx, t.id, event.failure_reason);
    return { status: "transfer_failed", transfer_id: t.id };
  });
}
