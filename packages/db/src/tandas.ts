import { type Centavos, CreateTanda, type RoundStatus, roundStatus } from "@cuadra/core";
import { and, asc, eq, isNull } from "drizzle-orm";
import type { Db } from "./client.js";
import { type AssertionVerifier, IntegrityError, loadVerifiedProposal, verifyApproval } from "./outflows.js";
import { approvals, proposals, tandaCharges, tandaMembers, tandas } from "./schema.js";

export type TandaRow = typeof tandas.$inferSelect;
export type TandaMemberRow = typeof tandaMembers.$inferSelect;

/**
 * Crea la tanda desde una propuesta CreateTanda aprobada con passkey vigente. La aprobación
 * se consume. Integrantes, CLABEs y orden salen de la propuesta firmada, no de otra fuente.
 */
export async function createTandaFromApproval(
  db: Db,
  args: { tandaId: string; proposalId: string; approvalId: string; now: Date; verify: AssertionVerifier },
): Promise<TandaRow> {
  return db.transaction(async (tx) => {
    const { row, parsed } = await loadVerifiedProposal(tx, args.proposalId);
    const t = CreateTanda.parse(parsed);
    const [a] = await tx
      .select()
      .from(approvals)
      .where(and(eq(approvals.id, args.approvalId), eq(approvals.proposalId, row.id)))
      .for("update");
    if (!a || a.usedAt !== null || a.expiresAt.getTime() <= args.now.getTime()) {
      throw new IntegrityError("Aprobación inexistente, usada o vencida");
    }
    if (!(await verifyApproval(tx, a, row.proposalHash, args.verify))) {
      throw new IntegrityError("La firma de la aprobación no es válida");
    }
    await tx.update(approvals).set({ usedAt: args.now }).where(and(eq(approvals.id, a.id), isNull(approvals.usedAt)));
    const [tanda] = await tx
      .insert(tandas)
      .values({
        id: args.tandaId,
        merchantId: t.merchant_id,
        name: t.name,
        contributionCents: t.contribution_cents,
        period: t.period,
        membersCount: t.members.length,
        proposalId: row.id,
        approvalId: a.id,
        createdAt: args.now,
      })
      .returning();
    await tx.insert(tandaMembers).values(
      t.members.map((m, i) => ({ tandaId: args.tandaId, position: i + 1, name: m.name, phone: m.phone, clabe: m.clabe })),
    );
    await tx.update(proposals).set({ status: "done", updatedAt: args.now }).where(eq(proposals.id, row.id));
    return tanda!;
  });
}

export async function tandaMembersOf(db: Db, tandaId: string): Promise<TandaMemberRow[]> {
  return db.select().from(tandaMembers).where(eq(tandaMembers.tandaId, tandaId)).orderBy(asc(tandaMembers.position));
}

/**
 * Revalida antes de cada cobro: los integrantes, CLABEs, orden y monto en la base deben ser
 * exactamente los de la propuesta firmada, y la firma debe seguir siendo válida.
 */
export async function verifyTandaIntegrity(db: Db, tandaId: string, verify: AssertionVerifier): Promise<boolean> {
  const [t] = await db.select().from(tandas).where(eq(tandas.id, tandaId));
  if (!t) return false;
  let signed;
  try {
    signed = CreateTanda.parse((await loadVerifiedProposal(db, t.proposalId)).parsed);
  } catch {
    return false;
  }
  const [p] = await db.select().from(proposals).where(eq(proposals.id, t.proposalId));
  const [a] = await db.select().from(approvals).where(eq(approvals.id, t.approvalId));
  if (!p || !a || a.proposalId !== p.id || !(await verifyApproval(db, a, p.proposalHash, verify))) return false;
  if (signed.merchant_id !== t.merchantId || signed.contribution_cents !== t.contributionCents) return false;
  if (signed.members.length !== t.membersCount) return false;
  const members = await tandaMembersOf(db, tandaId);
  if (members.length !== signed.members.length) return false;
  return members.every((m, i) => {
    const s = signed.members[i]!;
    return m.position === i + 1 && m.clabe === s.clabe && m.phone === s.phone && m.name === s.name;
  });
}

export async function setMemberBankAccount(
  db: Db,
  tandaId: string,
  position: number,
  bankAccountId: string,
  status: string,
): Promise<void> {
  await db
    .update(tandaMembers)
    .set({ bankAccountId, bankAccountStatus: status })
    .where(and(eq(tandaMembers.tandaId, tandaId), eq(tandaMembers.position, position)));
}

/** Estado de la ronda según las aportaciones pagadas. */
export async function tandaRoundStatus(db: Db, t: TandaRow, round = t.currentRound): Promise<RoundStatus | null> {
  if (round < 1) return null;
  const paid = await db
    .select({ p: tandaCharges.payerPosition })
    .from(tandaCharges)
    .where(and(eq(tandaCharges.tandaId, t.id), eq(tandaCharges.round, round), eq(tandaCharges.status, "paid")));
  return roundStatus(round, t.membersCount, paid.map((x) => x.p));
}

/** Abre la siguiente ronda si la actual ya se completó (o si no ha empezado). */
export async function openNextRound(db: Db, tandaId: string): Promise<{ ok: true; round: number } | { ok: false; reason: string }> {
  return db.transaction(async (tx) => {
    const [t] = await tx.select().from(tandas).where(eq(tandas.id, tandaId)).for("update");
    if (!t) return { ok: false, reason: "La tanda no existe." };
    if (t.status !== "active") return { ok: false, reason: `La tanda está ${t.status === "done" ? "terminada" : "congelada"}.` };
    const st = await tandaRoundStatus(tx, t);
    if (st && !st.complete) return { ok: false, reason: `La ronda ${t.currentRound} aún no se completa.` };
    if (t.currentRound >= t.membersCount) {
      await tx.update(tandas).set({ status: "done" }).where(eq(tandas.id, tandaId));
      return { ok: false, reason: "La tanda ya terminó: todos recibieron su turno." };
    }
    const round = t.currentRound + 1;
    await tx.update(tandas).set({ currentRound: round }).where(eq(tandas.id, tandaId));
    return { ok: true, round };
  });
}

export async function insertTandaCharge(
  db: Db,
  c: { id: string; tandaId: string; round: number; payer: number; recipient: number; amount: Centavos; now: Date },
): Promise<void> {
  await db.insert(tandaCharges).values({
    id: c.id,
    tandaId: c.tandaId,
    round: c.round,
    payerPosition: c.payer,
    recipientPosition: c.recipient,
    amountCents: c.amount,
    createdAt: c.now,
  });
}

export async function attachTandaProviderCharge(db: Db, chargeId: string, provider: string, providerChargeId: string): Promise<void> {
  await db.update(tandaCharges).set({ provider, providerChargeId }).where(eq(tandaCharges.id, chargeId));
}

export async function findTandaCharge(db: Db, provider: string, ids: string[], hintChargeId: string | null) {
  for (const i of ids) {
    const [c] = await db
      .select()
      .from(tandaCharges)
      .where(and(eq(tandaCharges.provider, provider), eq(tandaCharges.providerChargeId, i)));
    if (c) return c;
  }
  if (hintChargeId) {
    const [c] = await db.select().from(tandaCharges).where(eq(tandaCharges.id, hintChargeId));
    if (c) return c;
  }
  return null;
}

export type TandaPaymentOutcome =
  | { kind: "duplicate" }
  | { kind: "mismatch"; charge: typeof tandaCharges.$inferSelect; paid: Centavos; doublePayment: boolean }
  | { kind: "paid"; charge: typeof tandaCharges.$inferSelect; tanda: TandaRow; status: RoundStatus };

/**
 * Aportación confirmada por el proveedor. Idempotente por transacción; una sola aportación
 * pagada por integrante y ronda (índice único). El monto debe ser exactamente la aportación.
 */
export async function recordTandaPayment(
  db: Db,
  chargeId: string,
  p: { transactionId: string; baseCents: Centavos; now: Date },
): Promise<TandaPaymentOutcome> {
  return db.transaction(async (tx) => {
    const [dup] = await tx.select().from(tandaCharges).where(eq(tandaCharges.transactionId, p.transactionId));
    if (dup) return { kind: "duplicate" };
    const [c] = await tx.select().from(tandaCharges).where(eq(tandaCharges.id, chargeId)).for("update");
    if (!c) throw new Error(`Cobro de tanda ${chargeId} no existe`);
    if (c.status === "paid") return { kind: "duplicate" };
    const [already] = await tx
      .select({ id: tandaCharges.id })
      .from(tandaCharges)
      .where(and(eq(tandaCharges.tandaId, c.tandaId), eq(tandaCharges.round, c.round), eq(tandaCharges.payerPosition, c.payerPosition), eq(tandaCharges.status, "paid")));
    if (already || p.baseCents !== c.amountCents) {
      const [m] = await tx
        .update(tandaCharges)
        .set({ status: "mismatch", transactionId: p.transactionId, paidCents: p.baseCents, paidAt: p.now })
        .where(eq(tandaCharges.id, c.id))
        .returning();
      return { kind: "mismatch", charge: m!, paid: p.baseCents, doublePayment: !!already };
    }
    const [paid] = await tx
      .update(tandaCharges)
      .set({ status: "paid", transactionId: p.transactionId, paidCents: p.baseCents, paidAt: p.now })
      .where(eq(tandaCharges.id, c.id))
      .returning();
    const [t] = await tx.select().from(tandas).where(eq(tandas.id, c.tandaId));
    const status = (await tandaRoundStatus(tx, t!, c.round))!;
    return { kind: "paid", charge: paid!, tanda: t!, status };
  });
}
