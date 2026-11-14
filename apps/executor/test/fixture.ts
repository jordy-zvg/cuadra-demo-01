import { MockPaymentProvider, verifyProposalAssertion } from "@cuadra/adapters";
import { SoftAuthenticator } from "@cuadra/adapters/testing";
import { Proposal } from "@cuadra/core";
import {
  DEMO,
  type Db,
  applyProviderEvent,
  createMandateFromApproval,
  runReconciliation,
  saveApproval,
  saveProposal,
  schema,
  seedDemo,
} from "@cuadra/db";
import { createTestDb } from "@cuadra/db/testing";
import { eq } from "drizzle-orm";
import type { ExecutorDeps } from "../src/execute.js";

export const RP = { rpID: "cuadra.test", origins: ["https://cuadra.test"] };
export const NOW = new Date("2026-11-14T12:00:00-06:00");

export async function setup(opts: { funded?: bigint } = {}) {
  const { db, pg } = await createTestDb();
  await seedDemo(db, NOW);
  const provider = new MockPaymentProvider("whsec_test");
  const auth = new SoftAuthenticator(RP.rpID, RP.origins[0]!);
  await db.insert(schema.passkeyCredentials).values({
    id: auth.credentialId,
    merchantUserId: DEMO.ownerId,
    publicKey: auth.publicKeyCose,
  });
  const logs: Record<string, unknown>[] = [];
  let clock = NOW;
  const deps: ExecutorDeps = {
    db,
    provider,
    verify: (a) => verifyProposalAssertion({ ...a, config: RP }),
    now: () => clock,
    log: (r) => logs.push(r),
  };
  const M = DEMO.merchantId;

  const webhook = async (w: { body: string; headers: Record<string, string> }) =>
    applyProviderEvent(db, "mock", M, provider.parseWebhook(w.body, w.headers));

  // Fondea la cuenta operativa con un SPEI entrante y concilia el día.
  if ((opts.funded ?? 1_000_000n) > 0n) {
    await webhook(provider.incomingSpei({ clave_rastreo: "FONDEO1", amount_cents: opts.funded ?? 1_000_000n }));
  }
  await runReconciliation(db, M, await provider.getBalance(), NOW);

  let seq = 0;
  const propose = async (fields: Record<string, unknown>, status: "queued" | "pending" = "queued") => {
    const id = `pr_${++seq}`;
    const proposal = Proposal.parse({ merchant_id: M, provenance: "user_direct", ...fields });
    const saved = await saveProposal(db, { id, actorId: DEMO.ownerId, proposal });
    await db.update(schema.proposals).set({ status }).where(eq(schema.proposals.id, id));
    return saved;
  };

  const approve = async (proposalId: string, hash: string, signer = auth) => {
    const id = `ap_${++seq}`;
    await saveApproval(db, { id, proposalId, credentialId: auth.credentialId, assertion: signer.approve(hash), priorCounter: 0, now: clock });
    return id;
  };

  const payout = (amount: number, extra: Record<string, unknown> = {}) =>
    propose({ type: "PayoutRequest", payee_id: DEMO.payees.refrescos.id, amount_cents: amount, concept: "Refrescos", ...extra });

  const mandate = async (terms: Record<string, unknown> = {}) => {
    const p = await propose(
      {
        type: "CreateMandate",
        payee_id: DEMO.payees.refrescos.id,
        purpose: "proveedor",
        per_op_cap_cents: 300_000,
        period_cap_cents: 1_000_000,
        period: "week",
        valid_days: 30,
        ...terms,
      },
      "pending",
    );
    const approvalId = await approve(p.id, p.proposalHash);
    const mandateId = `md_${p.id}`;
    await createMandateFromApproval(db, { mandateId, proposalId: p.id, approvalId, now: clock, verify: deps.verify });
    return mandateId;
  };

  return {
    db: db as Db,
    pg,
    provider,
    auth,
    deps,
    logs,
    M,
    webhook,
    propose,
    approve,
    payout,
    mandate,
    setNow: (d: Date) => {
      clock = d;
    },
  };
}
