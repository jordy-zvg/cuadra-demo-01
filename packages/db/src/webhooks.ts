import type { Centavos } from "@cuadra/core";
import type { Db } from "./client.js";
import { type DepositOutcome, recordDeposit } from "./deposits.js";
import { webhookEvents } from "./schema.js";
import { confirmTransfer, failTransfer, findTransferByRef } from "./transfers.js";

/** Evento ya verificado (firma) y normalizado por el adapter del proveedor. */
export type VerifiedEvent =
  | { type: "transfer.confirmed"; event_id: string; provider_ref: string }
  | { type: "transfer.failed"; event_id: string; provider_ref: string; failure_reason: string }
  | {
      type: "deposit.received";
      event_id: string;
      clave_rastreo: string;
      amount_cents: Centavos;
      destination_clabe?: string | undefined;
      ordering_clabe?: string | undefined;
      reference?: string | undefined;
      concept?: string | undefined;
    };

export class UnknownTransferError extends Error {}

export type EventOutcome =
  | { status: "duplicate" }
  | { status: "transfer_confirmed" | "transfer_failed"; transfer_id: string }
  | { status: "deposit"; outcome: DepositOutcome };

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
    await failTransfer(tx, t.id, event.failure_reason);
    return { status: "transfer_failed", transfer_id: t.id };
  });
}
