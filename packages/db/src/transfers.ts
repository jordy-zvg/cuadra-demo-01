import { type JournalEntry, OutflowProposal, outflowPurpose, pagoConfirmado, reverso, salidaCreada } from "@cuadra/core";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import type { Db } from "./client.js";
import { getEntry, postEntries } from "./ledger-repo.js";
import { approvals, merchants, proposals, transfers } from "./schema.js";

export const transferKeys = (id: string) => ({
  created: `transfer:${id}:created`,
  confirmed: `transfer:${id}:confirmed`,
  reversed: `transfer:${id}:reversed`,
  returnedConfirmed: `transfer:${id}:returned:confirmed`,
  returnedCreated: `transfer:${id}:returned:created`,
});

/** Bloquea al comercio hasta el fin de la transacción: serializa salidas y abonos. */
export async function lockMerchant(db: Db, merchantId: string): Promise<void> {
  await db.execute(sql`SELECT id FROM ${merchants} WHERE ${merchants.id} = ${merchantId} FOR UPDATE`);
}

export async function setProposalStatus(
  db: Db,
  proposalId: string,
  status: typeof proposals.$inferSelect.status,
  decision?: unknown,
): Promise<void> {
  await db
    .update(proposals)
    .set({ status, updatedAt: new Date(), ...(decision === undefined ? {} : { decision }) })
    .where(eq(proposals.id, proposalId));
}

/**
 * Registra la transferencia y su asiento de creación (… / H 2400) y consume la aprobación.
 * Debe correr en la misma transacción en la que el guard dio "allow".
 */
export async function reserveTransfer(
  tx: Db,
  args: {
    proposalId: string;
    payload: unknown;
    proposalHash: string;
    mandateId: string | null;
    approvalId: string | null;
    approvedByPasskey: boolean;
    now: Date;
  },
): Promise<typeof transfers.$inferSelect> {
  const p = OutflowProposal.parse(args.payload);
  const id = `tr_${args.proposalId}`;
  const [t] = await tx
    .insert(transfers)
    .values({
      id,
      merchantId: p.merchant_id,
      idempotencyKey: `proposal:${args.proposalId}`,
      proposalId: args.proposalId,
      proposalHash: args.proposalHash,
      purpose: outflowPurpose(p),
      payeeId: p.payee_id,
      // Si la autorizó un passkey, no consume tope del mandato.
      mandateId: args.approvedByPasskey ? null : args.mandateId,
      approvalId: args.approvedByPasskey ? args.approvalId : null,
      amountCents: p.amount_cents,
      concept: p.concept,
      createdAt: args.now,
      updatedAt: args.now,
    })
    .returning();
  if (!t) throw new Error("No se pudo registrar la transferencia");

  if (args.approvedByPasskey) {
    if (args.approvalId === null) throw new Error("Aprobación requerida y ausente");
    const used = await tx
      .update(approvals)
      .set({ usedAt: args.now })
      .where(and(eq(approvals.id, args.approvalId), isNull(approvals.usedAt)))
      .returning({ id: approvals.id });
    if (used.length !== 1) throw new Error("La aprobación ya fue usada");
  }

  await postEntries(tx, [
    salidaCreada({
      merchant_id: p.merchant_id,
      idempotency_key: transferKeys(id).created,
      amount: p.amount_cents,
      purpose: outflowPurpose(p),
      ...(p.type === "TandaPayout" ? { tanda_id: p.tanda_id } : {}),
      ...(p.type === "RefundCredit" ? { customer_id: p.customer_id } : {}),
      memo: p.concept,
    }),
  ]);
  await setProposalStatus(tx, args.proposalId, "executing");
  return t;
}

/** Marca el primer intento de envío. Devuelve false si ya se había intentado. */
export async function markTransferSubmitted(db: Db, id: string, now: Date): Promise<boolean> {
  const r = await db
    .update(transfers)
    .set({ submittedAt: now })
    .where(and(eq(transfers.id, id), isNull(transfers.submittedAt)))
    .returning({ id: transfers.id });
  return r.length === 1;
}

export async function markTransferSent(db: Db, id: string, providerRef: string): Promise<void> {
  await db
    .update(transfers)
    .set({ status: "sent", providerRef })
    .where(and(eq(transfers.id, id), eq(transfers.status, "pending")));
}

/** Fallo: estado terminal + reverso del asiento de creación. Idempotente. */
export async function failTransfer(db: Db, id: string, reason: string, providerRef?: string): Promise<void> {
  await db.transaction(async (tx) => {
    const [t] = await tx.select().from(transfers).where(eq(transfers.id, id)).for("update");
    if (!t) throw new Error(`Transferencia ${id} no existe`);
    if (t.status === "failed") return;
    if (t.status === "confirmed") throw new Error(`Transferencia ${id} ya confirmada; no puede fallar`);
    await tx
      .update(transfers)
      .set({ status: "failed", failureReason: reason, ...(providerRef && !t.providerRef ? { providerRef } : {}) })
      .where(eq(transfers.id, id));
    const created = await getEntry(tx, transferKeys(id).created);
    if (!created) throw new Error(`Falta el asiento de creación de ${id}`);
    await postEntries(tx, [reverso(created, transferKeys(id).reversed)]);
    await setProposalStatus(tx, t.proposalId, "rejected", { failure_reason: reason });
  });
}

/** Confirmación: D 2400 / H 1100. Idempotente. */
export async function confirmTransfer(db: Db, id: string): Promise<void> {
  await db.transaction(async (tx) => {
    const [t] = await tx.select().from(transfers).where(eq(transfers.id, id)).for("update");
    if (!t) throw new Error(`Transferencia ${id} no existe`);
    if (t.status === "confirmed" || t.status === "returned") return;
    if (t.status !== "sent") throw new Error(`Transferencia ${id} en estado ${t.status}; no se puede confirmar`);
    await tx.update(transfers).set({ status: "confirmed" }).where(eq(transfers.id, id));
    const entry: JournalEntry = pagoConfirmado({
      merchant_id: t.merchantId,
      idempotency_key: transferKeys(id).confirmed,
      amount: t.amountCents,
      memo: t.concept,
    });
    await postEntries(tx, [entry]);
    await setProposalStatus(tx, t.proposalId, "done");
  });
}

/**
 * Devolución SPEI de una transferencia ya liquidada: reversa la confirmación
 * (D 1100 / H 2400) y la creación (… / D 2400). Si llega antes que la confirmación
 * (webhooks desordenados), primero confirma. Idempotente.
 */
export async function returnTransfer(db: Db, id: string, reason: string): Promise<void> {
  await db.transaction(async (tx) => {
    const [t] = await tx.select().from(transfers).where(eq(transfers.id, id)).for("update");
    if (!t) throw new Error(`Transferencia ${id} no existe`);
    if (t.status === "returned") return;
    if (t.status !== "sent" && t.status !== "confirmed") {
      throw new Error(`Transferencia ${id} en estado ${t.status}; no se puede devolver`);
    }
    if (t.status === "sent") await confirmTransfer(tx, id);
    const keys = transferKeys(id);
    const confirmed = await getEntry(tx, keys.confirmed);
    const created = await getEntry(tx, keys.created);
    if (!confirmed || !created) throw new Error(`Faltan asientos de la transferencia ${id}`);
    await postEntries(tx, [reverso(confirmed, keys.returnedConfirmed), reverso(created, keys.returnedCreated)]);
    await tx.update(transfers).set({ status: "returned", failureReason: reason }).where(eq(transfers.id, id));
    await setProposalStatus(tx, t.proposalId, "rejected", { returned: reason });
  });
}

export async function findTransferByRef(db: Db, providerRef: string) {
  const [t] = await db.select().from(transfers).where(eq(transfers.providerRef, providerRef));
  return t ?? null;
}

/** Monto ya enviado al proveedor y aún no confirmado (para conciliar). */
export async function inFlightCents(db: Db, merchantId: string): Promise<bigint> {
  const [r] = await db
    .select({ s: sql<string>`coalesce(sum(${transfers.amountCents}), 0)::text` })
    .from(transfers)
    .where(and(eq(transfers.merchantId, merchantId), inArray(transfers.status, ["sent"])));
  return BigInt(r?.s ?? "0");
}
