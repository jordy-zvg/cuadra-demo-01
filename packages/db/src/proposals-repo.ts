import { CreateMandate, HOUR_MS, type Proposal, proposalHash } from "@cuadra/core";
import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "./client.js";
import { type AssertionVerifier, IntegrityError, loadVerifiedProposal, verifyApproval } from "./outflows.js";
import { approvals, mandates, proposals } from "./schema.js";

const APPROVAL_TTL_MS = 10 * 60 * 1000;

/** JSON con bigint como texto (el esquema Zod lo vuelve a bigint al leer). */
export function toJsonPayload(p: Proposal): Record<string, unknown> {
  return JSON.parse(JSON.stringify(p, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
}

export async function saveProposal(
  db: Db,
  args: { id: string; actorId: string; proposal: Proposal; auditorVeto?: boolean },
): Promise<{ id: string; proposalHash: string }> {
  const hash = proposalHash(args.proposal);
  await db.insert(proposals).values({
    id: args.id,
    merchantId: args.proposal.merchant_id,
    actorId: args.actorId,
    type: args.proposal.type,
    provenance: args.proposal.provenance,
    payload: toJsonPayload(args.proposal),
    proposalHash: hash,
    auditorVeto: args.auditorVeto ?? false,
  });
  return { id: args.id, proposalHash: hash };
}

/** Guarda una aserción de passkey para una propuesta. Expira en 10 minutos. */
export async function saveApproval(
  db: Db,
  args: { id: string; proposalId: string; credentialId: string; assertion: unknown; priorCounter: number; now: Date },
): Promise<void> {
  const [p] = await db.select().from(proposals).where(eq(proposals.id, args.proposalId));
  if (!p) throw new IntegrityError(`Propuesta ${args.proposalId} no existe`);
  await db.insert(approvals).values({
    id: args.id,
    merchantId: p.merchantId,
    proposalId: p.id,
    proposalHash: p.proposalHash,
    credentialId: args.credentialId,
    assertion: args.assertion as Record<string, unknown>,
    priorCounter: args.priorCounter,
    createdAt: args.now,
    expiresAt: new Date(args.now.getTime() + APPROVAL_TTL_MS),
  });
}

/**
 * Crea el mandato a partir de una propuesta CreateMandate aprobada con passkey vigente.
 * La aprobación se consume.
 */
export async function createMandateFromApproval(
  db: Db,
  args: { mandateId: string; proposalId: string; approvalId: string; now: Date; verify: AssertionVerifier },
): Promise<void> {
  await db.transaction(async (tx) => {
    const { row, parsed } = await loadVerifiedProposal(tx, args.proposalId);
    const terms = CreateMandate.parse(parsed);
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
    await tx.insert(mandates).values({
      id: args.mandateId,
      merchantId: terms.merchant_id,
      payeeId: terms.payee_id,
      purpose: terms.purpose,
      perOpCapCents: terms.per_op_cap_cents,
      periodCapCents: terms.period_cap_cents,
      period: terms.period,
      validFrom: args.now,
      validUntil: new Date(args.now.getTime() + terms.valid_days * 24 * HOUR_MS),
      proposalId: row.id,
      approvalId: a.id,
    });
    await tx.update(proposals).set({ status: "done", updatedAt: args.now }).where(eq(proposals.id, row.id));
  });
}

export async function revokeMandate(db: Db, merchantId: string, mandateId: string, now: Date): Promise<void> {
  await db
    .update(mandates)
    .set({ revokedAt: now })
    .where(and(eq(mandates.id, mandateId), eq(mandates.merchantId, merchantId), isNull(mandates.revokedAt)));
}
