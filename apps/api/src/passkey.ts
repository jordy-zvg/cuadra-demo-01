import { randomUUID } from "node:crypto";
import { verifyProposalAssertion } from "@cuadra/adapters";
import { CreateMandate, PayoutRequest, Proposal, formatMXN } from "@cuadra/core";
import {
  type AssertionVerifier,
  type Db,
  createMandateFromApproval,
  saveApproval,
  saveProposal,
  schema,
  setProposalStatus,
} from "@cuadra/db";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";
import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";

export interface PasskeyOpts {
  db: Db;
  merchantId: string;
  ownerId: string;
  rpID: string;
  origins: string[];
  now: () => Date;
}

const CHALLENGE_TTL_MS = 5 * 60_000;

/** Lectura humana de lo que se firma: lo que ve el comercio debe ser lo que se hashea. */
async function describe(db: Db, p: Proposal): Promise<string> {
  const payeeName = async (id: string) =>
    (await db.select({ a: schema.payees.alias }).from(schema.payees).where(eq(schema.payees.id, id)))[0]?.a ?? id;
  if (p.type === "CreateMandate") {
    const per = { day: "día", week: "semana", month: "mes" }[p.period];
    return `Mandato para ${await payeeName(p.payee_id)}: hasta ${formatMXN(p.per_op_cap_cents)} por pago y ${formatMXN(p.period_cap_cents)} por ${per}, vigente ${p.valid_days} días.`;
  }
  if (p.type === "PayoutRequest") return `Pagar ${formatMXN(p.amount_cents)} a ${await payeeName(p.payee_id)} · “${p.concept}”.`;
  return p.type;
}

export function registerPasskeyRoutes(app: FastifyInstance, o: PasskeyOpts): void {
  const regChallenges = new Map<string, { challenge: string; at: number }>();
  const json = (raw: unknown) => JSON.parse(typeof raw === "string" && raw ? raw : "{}") as unknown;

  const loadProposal = async (id: string) => {
    const [row] = await o.db
      .select()
      .from(schema.proposals)
      .where(and(eq(schema.proposals.id, id), eq(schema.proposals.merchantId, o.merchantId)));
    return row ?? null;
  };
  const credentials = () =>
    o.db.select().from(schema.passkeyCredentials).where(eq(schema.passkeyCredentials.merchantUserId, o.ownerId));

  app.get("/aprobar/:id", (_req, reply) => reply.sendFile("aprobar.html"));
  app.get("/mandato", (_req, reply) => reply.sendFile("aprobar.html"));

  app.get("/api/payees", async () =>
    (await o.db.select().from(schema.payees).where(eq(schema.payees.merchantId, o.merchantId))).map((p) => ({
      id: p.id,
      alias: p.alias,
      clabe_last4: p.clabe.slice(-4),
    })),
  );

  app.get("/api/passkey/status", async () => ({ registered: (await credentials()).length > 0, rp_id: o.rpID }));

  app.post("/api/passkey/register/options", async () => {
    const [owner] = await o.db.select().from(schema.merchantUsers).where(eq(schema.merchantUsers.id, o.ownerId));
    const existing = await credentials();
    const opts = await generateRegistrationOptions({
      rpName: "Cuadra",
      rpID: o.rpID,
      userName: owner?.phone ?? o.ownerId,
      userDisplayName: "Comercio",
      userID: new TextEncoder().encode(o.ownerId),
      attestationType: "none",
      authenticatorSelection: { residentKey: "preferred", userVerification: "required" },
      excludeCredentials: existing.map((c) => ({ id: c.id })),
    });
    regChallenges.set(o.ownerId, { challenge: opts.challenge, at: Date.now() });
    return opts;
  });

  app.post("/api/passkey/register/verify", async (req, reply) => {
    const pending = regChallenges.get(o.ownerId);
    regChallenges.delete(o.ownerId);
    if (!pending || Date.now() - pending.at > CHALLENGE_TTL_MS) return reply.code(400).send({ error: "Reto vencido; intenta de nuevo." });
    try {
      const v = await verifyRegistrationResponse({
        response: json(req.body) as Parameters<typeof verifyRegistrationResponse>[0]["response"],
        expectedChallenge: pending.challenge,
        expectedOrigin: o.origins,
        expectedRPID: o.rpID,
        requireUserVerification: true,
      });
      if (!v.verified) return reply.code(400).send({ error: "No se pudo verificar la passkey." });
      const c = v.registrationInfo.credential;
      await o.db
        .insert(schema.passkeyCredentials)
        .values({ id: c.id, merchantUserId: o.ownerId, publicKey: c.publicKey, counter: c.counter, transports: c.transports ?? [] })
        .onConflictDoNothing();
      return { ok: true };
    } catch (e) {
      return reply.code(400).send({ error: e instanceof Error ? e.message : "Registro inválido" });
    }
  });

  const MandateBody = z.object({
    payee_id: z.string().min(1).max(64),
    per_op_pesos: z.number().positive().max(1_000_000),
    period_cap_pesos: z.number().positive().max(10_000_000),
    period: z.enum(["day", "week", "month"]),
    valid_days: z.number().int().min(1).max(365),
  });
  app.post("/api/mandate/propose", async (req, reply) => {
    const b = MandateBody.safeParse(json(req.body));
    if (!b.success) return reply.code(400).send({ error: "Datos del mandato inválidos" });
    const toCents = (n: number) => Math.round(n * 100);
    const proposal = CreateMandate.parse({
      type: "CreateMandate",
      merchant_id: o.merchantId,
      provenance: "user_direct",
      payee_id: b.data.payee_id,
      purpose: "proveedor",
      per_op_cap_cents: toCents(b.data.per_op_pesos),
      period_cap_cents: toCents(b.data.period_cap_pesos),
      period: b.data.period,
      valid_days: b.data.valid_days,
    });
    const id = `pr_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
    await saveProposal(o.db, { id, actorId: o.ownerId, proposal });
    return { id };
  });

  app.get("/api/proposal/:id", async (req, reply) => {
    const row = await loadProposal((req.params as { id: string }).id);
    if (!row) return reply.code(404).send({ error: "No existe" });
    const p = Proposal.parse(row.payload);
    return { id: row.id, type: row.type, status: row.status, hash: row.proposalHash, provenance: row.provenance, summary: await describe(o.db, p), decision: row.decision };
  });

  const ApproveBody = z.object({ proposal_id: z.string().min(1).max(64) });
  const approvable = (status: string, type: string) =>
    (type === "CreateMandate" && status === "pending") || (type === "PayoutRequest" && status === "awaiting_passkey");

  app.post("/api/approve/options", async (req, reply) => {
    const b = ApproveBody.safeParse(json(req.body));
    if (!b.success) return reply.code(400).send({ error: "inválido" });
    const row = await loadProposal(b.data.proposal_id);
    if (!row || !approvable(row.status, row.type)) return reply.code(409).send({ error: "Esta propuesta ya no se puede aprobar." });
    const creds = await credentials();
    if (creds.length === 0) return reply.code(409).send({ error: "Primero registra tu passkey." });
    // El challenge son los bytes del hash de la propuesta: la firma queda ligada a ella.
    return generateAuthenticationOptions({
      rpID: o.rpID,
      challenge: Buffer.from(row.proposalHash, "hex"),
      allowCredentials: creds.map((c) => ({ id: c.id })),
      userVerification: "required",
    });
  });

  const VerifyBody = z.object({ proposal_id: z.string().min(1).max(64), response: z.object({ id: z.string() }).passthrough() });
  app.post("/api/approve/verify", async (req, reply) => {
    const b = VerifyBody.safeParse(json(req.body));
    if (!b.success) return reply.code(400).send({ error: "inválido" });
    const row = await loadProposal(b.data.proposal_id);
    if (!row || !approvable(row.status, row.type)) return reply.code(409).send({ error: "Esta propuesta ya no se puede aprobar." });
    const [cred] = await o.db
      .select()
      .from(schema.passkeyCredentials)
      .where(and(eq(schema.passkeyCredentials.id, b.data.response.id), eq(schema.passkeyCredentials.merchantUserId, o.ownerId)));
    if (!cred) return reply.code(400).send({ error: "Passkey desconocida." });
    const ok = await verifyProposalAssertion({
      assertion: b.data.response,
      proposalHash: row.proposalHash,
      credential: { id: cred.id, publicKey: cred.publicKey, counter: cred.counter },
      config: { rpID: o.rpID, origins: o.origins },
    });
    if (!ok) return reply.code(400).send({ error: "La firma no corresponde a esta propuesta." });

    const now = o.now();
    const approvalId = `ap_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
    await saveApproval(o.db, { id: approvalId, proposalId: row.id, credentialId: cred.id, assertion: b.data.response, priorCounter: cred.counter, now });
    const counter = authenticatorCounter(b.data.response);
    if (counter > cred.counter) {
      await o.db.update(schema.passkeyCredentials).set({ counter }).where(eq(schema.passkeyCredentials.id, cred.id));
    }
    const p = Proposal.parse(row.payload);
    const verify: AssertionVerifier = (a) => verifyProposalAssertion({ ...a, config: { rpID: o.rpID, origins: o.origins } });
    const say = (body: string) =>
      o.db.insert(schema.messages).values({ merchantId: o.merchantId, thread: "comercio", direction: "out", body, createdAt: now });

    if (p.type === "CreateMandate") {
      await createMandateFromApproval(o.db, { mandateId: `md_${row.id}`, proposalId: row.id, approvalId, now, verify });
      await say(`✍️ Mandato firmado con passkey. ${await describe(o.db, p)}`);
    } else if (PayoutRequest.safeParse(p).success) {
      // El executor revalida todo, incluida esta firma, antes de enviar.
      await setProposalStatus(o.db, row.id, "queued");
      await say(`🔐 Aprobado con passkey: ${await describe(o.db, p)} Enviando…`);
    }
    return { ok: true, summary: await describe(o.db, p) };
  });
}

/** Contador de firmas del autenticador (bytes 33–36 de authenticatorData). */
function authenticatorCounter(resp: unknown): number {
  try {
    const ad = (resp as { response?: { authenticatorData?: string } }).response?.authenticatorData;
    if (!ad) return 0;
    const buf = Buffer.from(ad, "base64url");
    return buf.length >= 37 ? buf.readUInt32BE(33) : 0;
  } catch {
    return 0;
  }
}
