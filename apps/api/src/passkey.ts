import { randomUUID } from "node:crypto";
import { verifyProposalAssertion } from "@cuadra/adapters";
import { CreateMandate, CreateTanda, PayoutRequest, Proposal, formatMXN, maskClabe } from "@cuadra/core";
import {
  type AssertionVerifier,
  type Db,
  createMandateFromApproval,
  createTandaFromApproval,
  setMemberBankAccount,
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
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { Store, StoreRegistry } from "./stores.js";

export interface PasskeyOpts {
  db: Db;
  /** Tiendas: cada propuesta se firma con la passkey del dueño de SU tienda. */
  registry: StoreRegistry;
  /** Tienda de la sesión (null sin sesión). */
  storeOf: (req: FastifyRequest) => Promise<Store | null>;
  rpID: string;
  origins: string[];
  now: () => Date;
  /** Log JSON del servidor (sin secretos ni PII). */
  log: (r: Record<string, unknown>) => void;
}

const CHALLENGE_TTL_MS = 5 * 60_000;

/** Lectura humana de lo que se firma: lo que ve el comercio debe ser lo que se hashea. */
async function describe(db: Db, p: Proposal): Promise<string> {
  const payeeName = async (id: string) =>
    (await db.select({ a: schema.payees.alias }).from(schema.payees).where(eq(schema.payees.id, id)))[0]?.a ?? id;
  if (p.type === "CreateMandate") {
    const per = { day: "día", week: "semana", month: "mes" }[p.period];
    return `Permiso para pagarle a ${await payeeName(p.payee_id)}: hasta ${formatMXN(p.per_op_cap_cents)} por pago y ${formatMXN(p.period_cap_cents)} por ${per}, vigente ${p.valid_days} días.`;
  }
  if (p.type === "CreateTanda") {
    const per = { week: "semana", biweek: "quincena", month: "mes" }[p.period];
    const turns = p.members.map((m, i) => `${i + 1}. ${m.name} (CLABE ${maskClabe(m.clabe)})`).join("; ");
    return `Tanda “${p.name}”: ${formatMXN(p.contribution_cents)} por ${per} cada quien, ${p.members.length} integrantes. Turnos: ${turns}. Cada aportación va directo a la cuenta de quien le toca.`;
  }
  if (p.type === "PayoutRequest") return `Pagar ${formatMXN(p.amount_cents)} a ${await payeeName(p.payee_id)} · “${p.concept}”.`;
  return p.type;
}

export function registerPasskeyRoutes(app: FastifyInstance, o: PasskeyOpts): void {
  const regChallenges = new Map<string, { challenge: string; at: number }>();
  const json = (raw: unknown) => JSON.parse(typeof raw === "string" && raw ? raw : "{}") as unknown;

  /** Propuesta por id con su tienda: la firma siempre es del dueño de la tienda de la propuesta. */
  const loadProposal = async (id: string) => {
    const [row] = await o.db.select().from(schema.proposals).where(eq(schema.proposals.id, id));
    if (!row) return null;
    const store = await o.registry.get(row.merchantId);
    return store ? { row, store } : null;
  };
  const credentials = (ownerId: string) =>
    o.db.select().from(schema.passkeyCredentials).where(eq(schema.passkeyCredentials.merchantUserId, ownerId));
  const noSession = (reply: FastifyReply) => reply.code(401).send({ error: "Entra a tu cuenta para continuar." });

  app.get("/aprobar/:id", (_req, reply) => reply.sendFile("aprobar.html"));
  app.get("/mandato", (_req, reply) => reply.sendFile("aprobar.html"));
  app.get("/permiso", (_req, reply) => reply.sendFile("aprobar.html")); // el mismo formulario, con la palabra que ve el comercio
  app.get("/tanda", (_req, reply) => reply.sendFile("tanda.html"));

  const TandaBody = z.object({
    name: z.string().min(1).max(80),
    contribution_pesos: z.number().positive().max(100_000),
    period: z.enum(["week", "biweek", "month"]),
    members: z.array(z.object({ name: z.string().min(1).max(80), phone: z.string(), clabe: z.string() })).min(2).max(20),
  });
  app.post("/api/tanda/propose", async (req, reply) => {
    const st = await o.storeOf(req);
    if (!st) return noSession(reply);
    const b = TandaBody.safeParse(json(req.body));
    if (!b.success) return reply.code(400).send({ error: "Datos de la tanda incompletos" });
    const parsed = CreateTanda.safeParse({
      type: "CreateTanda",
      merchant_id: st.merchantId,
      provenance: "user_direct",
      name: b.data.name.trim(),
      contribution_cents: Math.round(b.data.contribution_pesos * 100),
      period: b.data.period,
      members: b.data.members.map((m) => ({ name: m.name.trim(), phone: m.phone.replace(/\D/g, "").slice(-10), clabe: m.clabe.replace(/\s/g, "") })),
    });
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues.map((i) => i.message).join("; ") });
    const id = `pr_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
    await saveProposal(o.db, { id, actorId: st.ownerId, proposal: parsed.data });
    return { id };
  });

  app.get("/api/payees", async (req, reply) => {
    const st = await o.storeOf(req);
    if (!st) return noSession(reply);
    return (await o.db.select().from(schema.payees).where(eq(schema.payees.merchantId, st.merchantId))).map((p) => ({
      id: p.id,
      alias: p.alias,
      clabe_last4: p.clabe.slice(-4),
    }));
  });

  // Pública (la página de aprobación la usa desde el enlace de WhatsApp): con ?proposal=<id>
  // responde por el dueño de la tienda de esa propuesta; si no, por la tienda de la sesión.
  app.get("/api/passkey/status", async (req) => {
    const pid = (req.query as { proposal?: unknown }).proposal;
    const owner =
      typeof pid === "string" && pid.length <= 64 ? (await loadProposal(pid))?.store.ownerId : (await o.storeOf(req))?.ownerId;
    return { registered: owner ? (await credentials(owner)).length > 0 : false, rp_id: o.rpID };
  });

  app.post("/api/passkey/register/options", async (req, reply) => {
    const st = await o.storeOf(req);
    if (!st) return noSession(reply);
    const [owner] = await o.db.select().from(schema.merchantUsers).where(eq(schema.merchantUsers.id, st.ownerId));
    const existing = await credentials(st.ownerId);
    const opts = await generateRegistrationOptions({
      rpName: "Cuadra",
      rpID: o.rpID,
      userName: owner?.phone ?? st.ownerId,
      userDisplayName: "Comercio",
      userID: new TextEncoder().encode(st.ownerId),
      attestationType: "none",
      authenticatorSelection: { residentKey: "preferred", userVerification: "required" },
      excludeCredentials: existing.map((c) => ({ id: c.id })),
    });
    regChallenges.set(st.ownerId, { challenge: opts.challenge, at: Date.now() });
    return opts;
  });

  app.post("/api/passkey/register/verify", async (req, reply) => {
    const st = await o.storeOf(req);
    if (!st) return noSession(reply);
    const pending = regChallenges.get(st.ownerId);
    regChallenges.delete(st.ownerId);
    if (!pending || Date.now() - pending.at > CHALLENGE_TTL_MS) return reply.code(400).send({ error: "Pasó mucho tiempo. Intenta otra vez." });
    try {
      const v = await verifyRegistrationResponse({
        response: json(req.body) as Parameters<typeof verifyRegistrationResponse>[0]["response"],
        expectedChallenge: pending.challenge,
        expectedOrigin: o.origins,
        expectedRPID: o.rpID,
        requireUserVerification: true,
      });
      if (!v.verified) {
        o.log({ msg: "passkey_register_unverified", merchant_id: st.merchantId });
        return reply.code(400).send({ error: "No se pudo activar la aprobación en este dispositivo. Intenta otra vez." });
      }
      const c = v.registrationInfo.credential;
      await o.db
        .insert(schema.passkeyCredentials)
        .values({ id: c.id, merchantUserId: st.ownerId, publicKey: c.publicKey, counter: c.counter, transports: c.transports ?? [] })
        .onConflictDoNothing();
      return { ok: true };
    } catch (e) {
      // El detalle técnico (en inglés, de la librería) va al log; al comercio, en palabras simples.
      o.log({ msg: "passkey_register_invalid", merchant_id: st.merchantId, reason: String(e instanceof Error ? e.message : e).slice(0, 300) });
      return reply.code(400).send({ error: "No se pudo activar la aprobación en este dispositivo. Intenta otra vez." });
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
    const st = await o.storeOf(req);
    if (!st) return noSession(reply);
    const b = MandateBody.safeParse(json(req.body));
    if (!b.success) return reply.code(400).send({ error: "Revisa los topes y la vigencia del permiso." });
    // Solo proveedores de tu tienda.
    const [payee] = await o.db
      .select({ id: schema.payees.id })
      .from(schema.payees)
      .where(and(eq(schema.payees.id, b.data.payee_id), eq(schema.payees.merchantId, st.merchantId)));
    if (!payee) return reply.code(404).send({ error: "Ese proveedor no está en tu lista." });
    const toCents = (n: number) => Math.round(n * 100);
    const proposal = CreateMandate.parse({
      type: "CreateMandate",
      merchant_id: st.merchantId,
      provenance: "user_direct",
      payee_id: b.data.payee_id,
      purpose: "proveedor",
      per_op_cap_cents: toCents(b.data.per_op_pesos),
      period_cap_cents: toCents(b.data.period_cap_pesos),
      period: b.data.period,
      valid_days: b.data.valid_days,
    });
    const id = `pr_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
    await saveProposal(o.db, { id, actorId: st.ownerId, proposal });
    return { id };
  });

  app.get("/api/proposal/:id", async (req, reply) => {
    const found = await loadProposal(String((req.params as { id: string }).id).slice(0, 64));
    if (!found) return reply.code(404).send({ error: "No encontramos esta operación. Revisa que el enlace esté completo." });
    const { row } = found;
    const p = Proposal.parse(row.payload);
    return { id: row.id, type: row.type, status: row.status, hash: row.proposalHash, provenance: row.provenance, summary: await describe(o.db, p), decision: row.decision };
  });

  const ApproveBody = z.object({ proposal_id: z.string().min(1).max(64) });
  const approvable = (status: string, type: string) =>
    ((type === "CreateMandate" || type === "CreateTanda") && status === "pending") || (type === "PayoutRequest" && status === "awaiting_passkey");

  app.post("/api/approve/options", async (req, reply) => {
    const b = ApproveBody.safeParse(json(req.body));
    if (!b.success) return reply.code(400).send({ error: "Solicitud inválida." });
    const found = await loadProposal(b.data.proposal_id);
    if (!found || !approvable(found.row.status, found.row.type)) return reply.code(409).send({ error: "Esto ya no se puede aprobar." });
    const { row, store } = found;
    const creds = await credentials(store.ownerId);
    if (creds.length === 0) return reply.code(409).send({ error: "Primero activa la aprobación en este dispositivo." });
    // El challenge son los bytes del hash de la propuesta: la firma queda ligada a ella.
    return generateAuthenticationOptions({
      rpID: o.rpID,
      challenge: Buffer.from(row.proposalHash, "hex"),
      allowCredentials: creds.map((c) => ({ id: c.id })),
      userVerification: "required",
    });
  });

  const VerifyBody = z.object({ proposal_id: z.string().min(1).max(64), response: z.object({ id: z.string() }).passthrough() });
  const verifyApproval = async (input: z.infer<typeof VerifyBody>, reply: FastifyReply) => {
    const found = await loadProposal(input.proposal_id);
    if (!found || !approvable(found.row.status, found.row.type)) return reply.code(409).send({ error: "Esto ya no se puede aprobar." });
    const { row, store } = found;
    // Solo firma la passkey del dueño de la tienda de esta propuesta.
    const [cred] = await o.db
      .select()
      .from(schema.passkeyCredentials)
      .where(and(eq(schema.passkeyCredentials.id, input.response.id), eq(schema.passkeyCredentials.merchantUserId, store.ownerId)));
    if (!cred) {
      o.log({ msg: "approval_unknown_credential", merchant_id: store.merchantId, proposal_id: row.id });
      return reply.code(400).send({ error: "Esa llave de acceso no es de esta tienda. Usa el dispositivo donde activaste la aprobación." });
    }
    const ok = await verifyProposalAssertion({
      assertion: input.response,
      proposalHash: row.proposalHash,
      credential: { id: cred.id, publicKey: cred.publicKey, counter: cred.counter },
      config: { rpID: o.rpID, origins: o.origins },
    });
    if (!ok) {
      o.log({ msg: "approval_assertion_invalid", merchant_id: store.merchantId, proposal_id: row.id });
      return reply.code(400).send({ error: "La aprobación no corresponde a esta operación. Ábrela otra vez desde el enlace del chat." });
    }

    const now = o.now();
    const approvalId = `ap_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
    await saveApproval(o.db, { id: approvalId, proposalId: row.id, credentialId: cred.id, assertion: input.response, priorCounter: cred.counter, now });
    const counter = authenticatorCounter(input.response);
    if (counter > cred.counter) {
      await o.db.update(schema.passkeyCredentials).set({ counter }).where(eq(schema.passkeyCredentials.id, cred.id));
    }
    const p = Proposal.parse(row.payload);
    const verify: AssertionVerifier = (a) => verifyProposalAssertion({ ...a, config: { rpID: o.rpID, origins: o.origins } });
    const say = (body: string) =>
      o.db.insert(schema.messages).values({ merchantId: store.merchantId, thread: "comercio", direction: "out", body, createdAt: now });

    if (p.type === "CreateTanda") {
      const tandaId = `td_${row.id}`;
      await createTandaFromApproval(o.db, { tandaId, proposalId: row.id, approvalId, now, verify });
      // Cada integrante registra su CLABE como cuenta receptora CoDi en pey.
      let pending = 0;
      for (const [i, m] of p.members.entries()) {
        try {
          const acc = await store.gateway.registerAccount({ clabe: m.clabe, name: m.name, alias: `${p.name} · ${m.name}` });
          await setMemberBankAccount(o.db, tandaId, i + 1, acc.id, acc.status);
          if (acc.status !== "ACTIVE") pending++;
        } catch {
          pending++;
        }
      }
      await say(
        `✍️ Listo, quedó firmada. ${await describe(o.db, p)}` +
          (pending ? ` ${pending} cuenta(s) quedan en alta con Banxico (hasta 5 días hábiles).` : " Todas las cuentas están listas: escribe “cobra la tanda”."),
      );
    } else if (p.type === "CreateMandate") {
      await createMandateFromApproval(o.db, { mandateId: `md_${row.id}`, proposalId: row.id, approvalId, now, verify });
      await say(`✍️ Listo, quedó firmado. ${await describe(o.db, p)}`);
    } else if (PayoutRequest.safeParse(p).success) {
      // El executor revalida todo, incluida esta firma, antes de enviar.
      await setProposalStatus(o.db, row.id, "queued");
      await say(`✅ Aprobado. ${await describe(o.db, p)} Enviando…`);
    }
    return { ok: true, summary: await describe(o.db, p) };
  };

  // Una aprobación a la vez por operación: si llega otra igual mientras la primera sigue en curso
  // (doble toque, dos pestañas), se rechaza en lugar de guardar dos aprobaciones y avisar dos veces.
  // En memoria basta porque la API corre en un solo proceso; el executor revalida todo de todos modos.
  const approving = new Set<string>();
  app.post("/api/approve/verify", async (req, reply) => {
    const b = VerifyBody.safeParse(json(req.body));
    if (!b.success) return reply.code(400).send({ error: "Solicitud inválida." });
    const pid = b.data.proposal_id;
    if (approving.has(pid)) return reply.code(409).send({ error: "Esto ya se está aprobando. Espera un momento." });
    approving.add(pid);
    try {
      return await verifyApproval(b.data, reply);
    } finally {
      approving.delete(pid);
    }
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
