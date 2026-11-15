import type { PaymentProvider } from "@cuadra/adapters";
import { type GuardResult, checkRisk, evaluateOutflow, isValidClabe } from "@cuadra/core";
import {
  type AssertionVerifier,
  type Db,
  IntegrityError,
  failTransfer,
  globalKillSwitch,
  loadOutflowContext,
  lockMerchant,
  markTransferSent,
  markTransferSubmitted,
  reserveTransfer,
  schema,
  setProposalStatus,
} from "@cuadra/db";
import { eq } from "drizzle-orm";
import { z } from "zod";

export const MAX_RETRY_WINDOW_MS = 23 * 60 * 60 * 1000;

/** El trabajo solo trae el id: todo lo demás se relee de la DB y se revalida. */
export const OutflowJob = z.object({ proposal_id: z.string().min(1).max(64) }).strict();
export type OutflowJob = z.infer<typeof OutflowJob>;

export interface ExecutorDeps {
  db: Db;
  provider: PaymentProvider;
  verify: AssertionVerifier;
  now: () => Date;
  log: (record: Record<string, unknown>) => void;
  /** Horario de salidas sin passkey (R10, OUTFLOW_HOURS); debe ser el mismo que usa la API. */
  outflowHours?: readonly [number, number];
}

export type ExecResult =
  | { status: "noop"; reason: string }
  | { status: "rejected"; decision: GuardResult | { integrity_error: string } }
  | { status: "awaiting_passkey"; decision: GuardResult }
  | { status: "sent"; transfer_id: string; provider_ref: string }
  | { status: "failed"; transfer_id: string; reason: string };

type Transfer = typeof schema.transfers.$inferSelect;
type Phase1 = { kind: "done"; result: ExecResult; merchantId?: string } | { kind: "submit"; transfer: Transfer };

/**
 * Fase 1: con el comercio bloqueado, relee todo, corre el guard y, si permite, registra la
 * transferencia y su asiento en la misma transacción.
 */
export async function decideAndReserve(job: OutflowJob, deps: ExecutorDeps): Promise<Phase1> {
  const { db } = deps;
  const [peek] = await db.select().from(schema.proposals).where(eq(schema.proposals.id, job.proposal_id));
  if (!peek) return { kind: "done", result: { status: "noop", reason: "Propuesta inexistente" } };

  const done = (result: ExecResult): Phase1 => ({ kind: "done", result, merchantId: peek.merchantId });
  return db.transaction(async (tx): Promise<Phase1> => {
    await lockMerchant(tx, peek.merchantId);
    const [existing] = await tx
      .select()
      .from(schema.transfers)
      .where(eq(schema.transfers.proposalId, job.proposal_id));
    if (existing) return { kind: "submit", transfer: existing };

    const [p] = await tx.select().from(schema.proposals).where(eq(schema.proposals.id, job.proposal_id));
    if (p?.status !== "queued") {
      return done({ status: "noop", reason: `Propuesta en estado ${p?.status}` });
    }

    const now = deps.now();
    let ctx;
    try {
      ctx = await loadOutflowContext(tx, job.proposal_id, now, deps.verify, deps.outflowHours ? { outflowHours: deps.outflowHours } : {});
    } catch (e) {
      if (!(e instanceof IntegrityError)) throw e;
      const decision = { integrity_error: e.message };
      await setProposalStatus(tx, job.proposal_id, "rejected", decision);
      return done({ status: "rejected", decision });
    }

    const decision = evaluateOutflow(ctx.input);
    if (decision.decision === "deny") {
      await setProposalStatus(tx, job.proposal_id, "rejected", decision);
      return done({ status: "rejected", decision });
    }
    if (decision.decision === "require_passkey") {
      await setProposalStatus(tx, job.proposal_id, "awaiting_passkey", decision);
      return done({ status: "awaiting_passkey", decision });
    }

    const transfer = await reserveTransfer(tx, {
      proposalId: job.proposal_id,
      payload: ctx.proposal.payload,
      proposalHash: ctx.proposal.proposalHash,
      mandateId: ctx.mandateId,
      approvalId: ctx.approvalId,
      approvedByPasskey: decision.approved_by_passkey,
      now,
    });
    await setProposalStatus(tx, job.proposal_id, "executing", decision);
    return { kind: "submit", transfer };
  });
}

/**
 * Fase 2: revisa el estado de riesgo justo antes de enviar y llama al proveedor con la
 * llave de idempotencia de la transferencia. Si el envío ya se había intentado, solo se
 * reintenta (el proveedor deduplica); nunca se cancela algo que pudo haber salido.
 */
export async function submit(transfer: Transfer, deps: ExecutorDeps): Promise<ExecResult> {
  const { db } = deps;
  if (transfer.status === "sent" || transfer.status === "confirmed") {
    return { status: "noop", reason: `Transferencia ya ${transfer.status}` };
  }
  if (transfer.status === "failed") {
    return { status: "failed", transfer_id: transfer.id, reason: transfer.failureReason ?? "" };
  }

  if (transfer.submittedAt === null) {
    const [risk] = await db.select().from(schema.riskState).where(eq(schema.riskState.merchantId, transfer.merchantId));
    const [p] = await db.select().from(schema.proposals).where(eq(schema.proposals.id, transfer.proposalId));
    const blocked = checkRisk({
      kill_switch: (risk?.killSwitch ?? false) || (await globalKillSwitch(db)),
      account_frozen: risk?.accountFrozen ?? false,
      reconciliation_mismatch: risk?.reconciliationMismatch ?? false,
      auditor_veto: p?.auditorVeto ?? true,
    });
    if (blocked.length > 0) {
      const reason = blocked.map((f) => f.reason).join(" ");
      await failTransfer(db, transfer.id, reason);
      return { status: "failed", transfer_id: transfer.id, reason };
    }
  }

  const [payee] = await db.select().from(schema.payees).where(eq(schema.payees.id, transfer.payeeId));
  if (!payee || payee.merchantId !== transfer.merchantId || !isValidClabe(payee.clabe)) {
    // Solo puede pasar si la DB se alteró después del guard.
    if (transfer.submittedAt === null) {
      await failTransfer(db, transfer.id, "Beneficiario inválido al momento de enviar.");
      return { status: "failed", transfer_id: transfer.id, reason: "Beneficiario inválido al momento de enviar." };
    }
    throw new Error(`Beneficiario inválido en transferencia ya enviada ${transfer.id}; requiere revisión`);
  }

  // Fintoc puede olvidar la llave de idempotencia a las 24 h; pasado ese margen un
  // reintento podría crear un segundo pago. Se detiene para revisión humana.
  if (transfer.submittedAt !== null && deps.now().getTime() - transfer.submittedAt.getTime() > MAX_RETRY_WINDOW_MS) {
    throw new Error(`Transferencia ${transfer.id} sin resultado tras 23 h; requiere revisión manual`);
  }
  await markTransferSubmitted(db, transfer.id, deps.now());
  const res = await deps.provider.createTransfer({
    idempotency_key: transfer.idempotencyKey,
    clabe: payee.clabe,
    holder_name: payee.holderName,
    amount_cents: transfer.amountCents,
    concept: transfer.concept,
  });
  if (res.status === "failed") {
    await failTransfer(db, transfer.id, res.failure_reason, res.provider_ref);
    return { status: "failed", transfer_id: transfer.id, reason: res.failure_reason };
  }
  await markTransferSent(db, transfer.id, res.provider_ref);
  return { status: "sent", transfer_id: transfer.id, provider_ref: res.provider_ref };
}

/** Procesa un trabajo de la cola "outflows". Errores transitorios se lanzan para reintento. */
export async function executeOutflow(rawJob: unknown, deps: ExecutorDeps): Promise<ExecResult> {
  const job = OutflowJob.parse(rawJob);
  const phase1 = await decideAndReserve(job, deps);
  const result = phase1.kind === "done" ? phase1.result : await submit(phase1.transfer, deps);
  const transferKey = phase1.kind === "submit" ? phase1.transfer.idempotencyKey : null;
  deps.log({
    msg: "outflow",
    proposal_id: job.proposal_id,
    merchant_id: phase1.kind === "submit" ? phase1.transfer.merchantId : phase1.merchantId,
    idempotency_key: transferKey,
    status: result.status,
    rules_failed:
      "decision" in result && "rules_failed" in result.decision
        ? result.decision.rules_failed.map((f) => f.rule_id)
        : undefined,
  });
  return result;
}
