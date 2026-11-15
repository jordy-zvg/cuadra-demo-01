import { SoftAuthenticator } from "@cuadra/adapters/testing";
import { RuleInterpreter } from "@cuadra/agents";
import { CreateMandate, CreateTanda, PayoutRequest } from "@cuadra/core";
import { DEMO, saveProposal, schema, seedDemo, setProposalStatus } from "@cuadra/db";
import { createTestDb } from "@cuadra/db/testing";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { createStoreRegistry } from "../src/app.js";
import { SimulatedGateway } from "../src/gateway.js";
import { buildServer } from "../src/server.js";

const RP = { rpID: "localhost", origins: ["http://localhost"] };
const NOW = new Date("2026-11-14T17:00:00Z");

/** Servidor real con la tienda demo, una llave de acceso de prueba del dueño y un pago esperando aprobación. */
async function setup() {
  const now = () => new Date(NOW);
  const { db } = await createTestDb();
  await seedDemo(db, NOW);
  const auth = new SoftAuthenticator(RP.rpID, RP.origins[0]!);
  await db.insert(schema.passkeyCredentials).values({ id: auth.credentialId, merchantUserId: DEMO.ownerId, publicKey: auth.publicKeyCose });
  const gateway = new SimulatedGateway(db);
  const registry = createStoreRegistry({
    db, liveGateway: gateway, interpreters: [new RuleInterpreter()], verify: async () => false, now, publicUrl: null,
    peyWebhookSecret: null, bankSim: false, udi: null, log: () => {},
  });
  const logs: Array<Record<string, unknown>> = [];
  const server = buildServer({
    db, registry, liveMerchantId: DEMO.merchantId, liveGateway: gateway, peyWebhookSecret: null, bankSim: false,
    demoPassword: null, log: (r) => logs.push(r),
    portalAuth: { shopCode: null, secureCookies: false, llave: "off", now },
    passkey: { ...RP, now },
  });
  const [payee] = await db.select().from(schema.payees).where(eq(schema.payees.merchantId, DEMO.merchantId));
  const payout = PayoutRequest.parse({
    type: "PayoutRequest", merchant_id: DEMO.merchantId, provenance: "user_direct", payee_id: payee!.id, amount_cents: 120000, concept: "Surtido",
  });
  const saved = await saveProposal(db, { id: "pr_pago", actorId: DEMO.ownerId, proposal: payout });
  await setProposalStatus(db, "pr_pago", "awaiting_passkey");
  const chat = async () => (await db.select().from(schema.messages).where(eq(schema.messages.thread, "comercio"))).map((m) => m.body);
  const verify = (response: unknown) =>
    server.inject({ method: "POST", url: "/api/approve/verify", payload: { proposal_id: "pr_pago", response } });
  return { db, server, auth, saved, logs, chat, verify, payee: payee! };
}

describe("aprobación de un pago (rutas)", () => {
  it("doble toque: dos aprobaciones al mismo tiempo dejan una sola aprobación y un solo aviso", async () => {
    const f = await setup();
    const response = f.auth.approve(f.saved.proposalHash);
    const codes = (await Promise.all([f.verify(response), f.verify(response)])).map((r) => r.statusCode).sort();
    expect(codes).toEqual([200, 409]);
    expect(await f.db.select().from(schema.approvals).where(eq(schema.approvals.proposalId, "pr_pago"))).toHaveLength(1);
    const [p] = await f.db.select().from(schema.proposals).where(eq(schema.proposals.id, "pr_pago"));
    expect(p!.status).toBe("queued");
    const avisos = (await f.chat()).filter((b) => b.startsWith("✅ Aprobado."));
    expect(avisos).toEqual([expect.stringMatching(/^✅ Aprobado\. Pagar \$1,200\.00 a .+ · “Surtido”\. Enviando…$/)]);
    // Ya aprobada: otro intento recibe 409 (la página entonces vuelve a leer el estado y lo explica).
    expect((await f.verify(f.auth.approve(f.saved.proposalHash))).statusCode).toBe(409);
  });

  it("lo que ve el comercio no dice passkey ni mandato, y los errores son claros", async () => {
    const f = await setup();
    expect((await f.server.inject({ url: "/api/proposal/pr_no_existe" })).json()).toEqual({
      error: "No encontramos esta operación. Revisa que el enlace esté completo.",
    });
    const mandate = CreateMandate.parse({
      type: "CreateMandate", merchant_id: DEMO.merchantId, provenance: "user_direct", payee_id: f.payee.id, purpose: "proveedor",
      per_op_cap_cents: 150000, period_cap_cents: 300000, period: "week", valid_days: 90,
    });
    const permiso = await saveProposal(f.db, { id: "pr_permiso", actorId: DEMO.ownerId, proposal: mandate });
    const summary = (await f.server.inject({ url: "/api/proposal/pr_permiso" })).json().summary as string;
    expect(summary).toMatch(/^Permiso para pagarle a .+: hasta \$1,500\.00 por pago y \$3,000\.00 por semana, vigente 90 días\.$/);
    // Una aprobación de otra operación no sirve; el motivo queda en el log (sin secretos ni datos personales).
    const wrong = await f.verify(f.auth.approve("0".repeat(64)));
    expect(wrong.statusCode).toBe(400);
    expect(wrong.json().error).toBe("La aprobación no corresponde a esta operación. Ábrela otra vez desde el enlace del chat.");
    expect(f.logs).toContainEqual({ msg: "approval_assertion_invalid", merchant_id: DEMO.merchantId, proposal_id: "pr_pago" });
    // Firmar el permiso y una tanda: el aviso del chat usa las palabras del comercio.
    const sign = (id: string, hash: string) =>
      f.server.inject({ method: "POST", url: "/api/approve/verify", payload: { proposal_id: id, response: f.auth.approve(hash) } });
    expect((await sign("pr_permiso", permiso.proposalHash)).statusCode).toBe(200);
    const tanda = CreateTanda.parse({
      type: "CreateTanda", merchant_id: DEMO.merchantId, provenance: "user_direct", name: "Tanda del mercado", contribution_cents: 50000, period: "week",
      members: [
        { name: "Ana", phone: "5511111111", clabe: "012180015826225713" },
        { name: "Bety", phone: "5522222222", clabe: "012180015913466252" },
        { name: "Caro", phone: "5533333333", clabe: "014180606004536217" },
      ],
    });
    const t = await saveProposal(f.db, { id: "pr_tanda", actorId: DEMO.ownerId, proposal: tanda });
    expect((await sign("pr_tanda", t.proposalHash)).statusCode).toBe(200);
    const chat = await f.chat();
    expect(chat).toContainEqual(expect.stringMatching(/^✍️ Listo, quedó firmado\. Permiso para pagarle a .+: hasta \$1,500\.00 por pago y \$3,000\.00 por semana, vigente 90 días\.$/));
    expect(chat).toContainEqual(expect.stringMatching(/^✍️ Listo, quedó firmada\. Tanda “Tanda del mercado”: \$500\.00 por semana cada quien, 3 integrantes\./));
    expect(chat.join("\n")).not.toMatch(/passkey|mandato/i);
  });
});
