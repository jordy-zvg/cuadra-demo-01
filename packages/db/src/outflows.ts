import {
  type Centavos,
  CreateMandate,
  type GuardInput,
  type Mandate,
  OutflowProposal,
  type PasskeyApproval,
  Proposal,
  mxPeriodStart,
  mxDateKey,
  outflowPurpose,
  proposalHash,
  HOUR_MS,
} from "@cuadra/core";
import { and, desc, eq, gte, isNull, ne, sql } from "drizzle-orm";
import type { Db } from "./client.js";
import { ledgerBalance } from "./ledger-repo.js";
import { globalKillSwitch } from "./risk.js";
import {
  approvals,
  mandates,
  merchantUsers,
  merchants,
  passkeyCredentials,
  payees,
  proposals,
  reconciliationRuns,
  riskState,
  transfers,
} from "./schema.js";

/** Verificación criptográfica de una aserción WebAuthn (la inyecta quien llama). */
export type AssertionVerifier = (args: {
  assertion: unknown;
  proposalHash: string;
  credential: { id: string; publicKey: Uint8Array; counter: number };
}) => Promise<boolean>;

export class IntegrityError extends Error {}

type ProposalRow = typeof proposals.$inferSelect;
type ApprovalRow = typeof approvals.$inferSelect;
export type PayeeRow = typeof payees.$inferSelect;

/** Relee la propuesta guardada y comprueba que su hash y metadatos no se alteraron. */
export async function loadVerifiedProposal(db: Db, proposalId: string): Promise<{ row: ProposalRow; parsed: Proposal }> {
  const [row] = await db.select().from(proposals).where(eq(proposals.id, proposalId));
  if (!row) throw new IntegrityError(`Propuesta ${proposalId} no existe`);
  const parsed = Proposal.safeParse(row.payload);
  if (
    !parsed.success ||
    proposalHash(parsed.data) !== row.proposalHash ||
    parsed.data.merchant_id !== row.merchantId ||
    parsed.data.provenance !== row.provenance ||
    parsed.data.type !== row.type
  ) {
    throw new IntegrityError(`La propuesta ${proposalId} no coincide con su hash`);
  }
  return { row, parsed: parsed.data };
}

/**
 * Firma válida de una aprobación: aserción WebAuthn sobre el hash esperado, con una
 * credencial de un usuario verificado y autorizado del mismo comercio.
 */
export async function verifyApproval(
  db: Db,
  a: ApprovalRow,
  expectedHash: string,
  verify: AssertionVerifier,
): Promise<boolean> {
  if (a.proposalHash !== expectedHash) return false;
  const [cred] = await db
    .select({
      id: passkeyCredentials.id,
      publicKey: passkeyCredentials.publicKey,
      merchantId: merchantUsers.merchantId,
      phoneVerified: merchantUsers.phoneVerified,
      role: merchantUsers.role,
    })
    .from(passkeyCredentials)
    .innerJoin(merchantUsers, eq(merchantUsers.id, passkeyCredentials.merchantUserId))
    .where(eq(passkeyCredentials.id, a.credentialId));
  if (!cred || cred.merchantId !== a.merchantId || !cred.phoneVerified) return false;
  if (cred.role !== "comercio" && cred.role !== "organizadora") return false;
  return verify({
    assertion: a.assertion,
    proposalHash: expectedHash,
    credential: { id: cred.id, publicKey: cred.publicKey, counter: a.priorCounter },
  });
}

/** El mandato es válido solo si coincide con la propuesta CreateMandate aprobada con passkey. */
async function verifyMandate(db: Db, m: typeof mandates.$inferSelect, verify: AssertionVerifier): Promise<boolean> {
  let created;
  try {
    created = await loadVerifiedProposal(db, m.proposalId);
  } catch {
    return false;
  }
  const p = CreateMandate.safeParse(created.parsed);
  if (!p.success) return false;
  const terms = p.data;
  const matches =
    terms.merchant_id === m.merchantId &&
    terms.payee_id === m.payeeId &&
    terms.purpose === m.purpose &&
    terms.per_op_cap_cents === m.perOpCapCents &&
    terms.period_cap_cents === m.periodCapCents &&
    terms.period === m.period &&
    m.validUntil.getTime() - m.validFrom.getTime() <= terms.valid_days * 24 * HOUR_MS;
  if (!matches) return false;
  const [a] = await db.select().from(approvals).where(eq(approvals.id, m.approvalId));
  if (!a || a.proposalId !== m.proposalId) return false;
  return verifyApproval(db, a, created.row.proposalHash, verify);
}

async function sumTransfers(db: Db, where: ReturnType<typeof and>): Promise<Centavos> {
  const [r] = await db
    .select({ s: sql<string>`coalesce(sum(${transfers.amountCents}), 0)::text` })
    .from(transfers)
    .where(where);
  return BigInt(r?.s ?? "0");
}

export interface OutflowContext {
  proposal: ProposalRow;
  outflow: OutflowProposal;
  payee: PayeeRow | null;
  mandateId: string | null;
  approvalId: string | null;
  input: GuardInput;
}

/** Arma el GuardInput completo desde la DB. Lo usan la API (primera pasada) y el executor (revalidación). */
export async function loadOutflowContext(
  db: Db,
  proposalId: string,
  now: Date,
  verify: AssertionVerifier,
): Promise<OutflowContext> {
  const { row, parsed } = await loadVerifiedProposal(db, proposalId);
  const outflow = OutflowProposal.safeParse(parsed);
  if (!outflow.success) throw new IntegrityError(`La propuesta ${proposalId} no es una salida de dinero`);
  const p = outflow.data;
  const purpose = outflowPurpose(p);

  const [merchant] = await db.select().from(merchants).where(eq(merchants.id, row.merchantId));
  if (!merchant) throw new IntegrityError(`Comercio ${row.merchantId} no existe`);
  const [actor] = await db
    .select()
    .from(merchantUsers)
    .where(and(eq(merchantUsers.id, row.actorId), eq(merchantUsers.merchantId, row.merchantId)));
  const [payee] = await db
    .select()
    .from(payees)
    .where(and(eq(payees.id, p.payee_id), eq(payees.merchantId, row.merchantId)));
  const [risk] = await db.select().from(riskState).where(eq(riskState.merchantId, row.merchantId));

  // Mandato candidato más reciente no revocado; el guard decide si cubre.
  const [m] = await db
    .select()
    .from(mandates)
    .where(
      and(
        eq(mandates.merchantId, row.merchantId),
        eq(mandates.payeeId, p.payee_id),
        eq(mandates.purpose, purpose),
        isNull(mandates.revokedAt),
      ),
    )
    .orderBy(desc(mandates.createdAt))
    .limit(1);

  let mandate: Mandate | null = null;
  let mandateSpent = 0n;
  if (m) {
    mandate = {
      id: m.id,
      merchant_id: m.merchantId,
      payee_id: m.payeeId,
      purpose: m.purpose,
      per_op_cap_cents: m.perOpCapCents,
      period_cap_cents: m.periodCapCents,
      period: m.period,
      valid_from: m.validFrom,
      valid_until: m.validUntil,
      revoked_at: m.revokedAt,
      signature_valid: await verifyMandate(db, m, verify),
    };
    mandateSpent = await sumTransfers(
      db,
      and(eq(transfers.mandateId, m.id), ne(transfers.status, "failed"), gte(transfers.createdAt, mxPeriodStart(now, m.period))),
    );
  }

  const notFailed = and(eq(transfers.merchantId, row.merchantId), ne(transfers.status, "failed"));
  const spentToday = await sumTransfers(db, and(notFailed, gte(transfers.createdAt, mxPeriodStart(now, "day"))));
  const recent = await db
    .select({
      payee_id: transfers.payeeId,
      amount_cents: transfers.amountCents,
      concept: transfers.concept,
      created_at: transfers.createdAt,
    })
    .from(transfers)
    .where(and(notFailed, gte(transfers.createdAt, new Date(now.getTime() - HOUR_MS))));

  const [recon] = await db
    .select({ ok: reconciliationRuns.ok })
    .from(reconciliationRuns)
    .where(and(eq(reconciliationRuns.merchantId, row.merchantId), eq(reconciliationRuns.localDate, mxDateKey(now))))
    .orderBy(desc(reconciliationRuns.runAt))
    .limit(1);

  const [a] = await db
    .select()
    .from(approvals)
    .where(eq(approvals.proposalId, row.id))
    .orderBy(desc(approvals.createdAt))
    .limit(1);
  let approval: PasskeyApproval | null = null;
  if (a) {
    approval = {
      proposal_hash: a.proposalHash,
      signature_valid: await verifyApproval(db, a, row.proposalHash, verify),
      expires_at: a.expiresAt,
      used: a.usedAt !== null,
    };
  }

  const input: GuardInput = {
    proposal: row.payload,
    now,
    actor: actor ? { phone_verified: actor.phoneVerified, role: actor.role } : { phone_verified: false, role: "desconocido" },
    payee: payee
      ? {
          id: payee.id,
          merchant_id: payee.merchantId,
          clabe: payee.clabe,
          whitelisted: payee.whitelisted,
          holder_validated: payee.holderValidated,
          created_at: payee.createdAt,
        }
      : null,
    mandate,
    mandate_spent_in_period: mandateSpent,
    merchant: {
      daily_limit_cents: merchant.dailyLimitCents,
      spent_today_cents: spentToday,
      max_outflows_per_hour: merchant.maxOutflowsPerHour,
    },
    balances: {
      operating_1100: await ledgerBalance(db, row.merchantId, "1100"),
      in_transit_2400: await ledgerBalance(db, row.merchantId, "2400"),
      holds: risk?.holdsCents ?? 0n,
    },
    reconciliation_ok_today: recon?.ok === true,
    recent_outflows: recent,
    risk: {
      kill_switch: (risk?.killSwitch ?? false) || (await globalKillSwitch(db)),
      account_frozen: risk?.accountFrozen ?? false,
      reconciliation_mismatch: risk?.reconciliationMismatch ?? false,
      auditor_veto: row.auditorVeto,
    },
    approval,
  };

  return {
    proposal: row,
    outflow: p,
    payee: payee ?? null,
    mandateId: m?.id ?? null,
    approvalId: a?.id ?? null,
    input,
  };
}
