import { signPeyWebhook } from "@cuadra/adapters";
import { RuleInterpreter } from "@cuadra/agents";
import { DEMO, assignAccountStores, ledgerBalance, schema, seedDemo, storeOfPhone } from "@cuadra/db";
import { createTestDb } from "@cuadra/db/testing";
import { and, eq, ne } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { createStoreRegistry } from "../src/app.js";
import { SimulatedGateway } from "../src/gateway.js";
import { buildServer } from "../src/server.js";
import { handlePeyWebhookForStores, merchantOfTransaction } from "../src/stores.js";
import { WhatsAppChannel, senderPhone10 } from "../src/whatsapp.js";

const NOW = new Date("2026-11-14T17:00:00Z"); // 11:00 en CDMX
// Dueña de la tienda demo: 5511110000. Doña Lupe, clienta de la demo: 5512345678.
const OWNER = "5511110000";
const LUPE = "5512345678";

class FakeWhatsApp {
  sent: Array<{ to: string; body: string }> = [];
  async sendText(to: string, body: string) { this.sent.push({ to, body }); return "w"; }
  async sendButtons(to: string, body: string) { this.sent.push({ to, body }); return "w"; }
  async sendTemplate(to: string, name: string) { this.sent.push({ to, body: `plantilla:${name}` }); return "w"; }
  async uploadMedia() { return "m"; }
  async sendImage(to: string, _m: string, caption?: string) { this.sent.push({ to, body: caption ?? "" }); return "w"; }
}

type StateJson = {
  merchant: { name: string };
  customers: Array<{ id: string; name: string; owes: string }>;
  messages: Array<{ thread: string; body: string; actions?: Array<{ kind: string; proposal_id?: string }> | null }>;
  charges: Array<{ id: string; customer_id: string; status: string }>;
};

async function setup(opts: { verification?: "whatsapp" | "off" } = {}) {
  const { db } = await createTestDb();
  await seedDemo(db, NOW, { ownerPhone: OWNER, lupePhone: LUPE });
  const gateway = new SimulatedGateway(db);
  const wa = new FakeWhatsApp();
  const channel = new WhatsAppChannel({ db, client: wa, log: () => {}, now: () => NOW });
  const registry = createStoreRegistry({
    db, liveGateway: gateway, interpreters: [new RuleInterpreter()], verify: async () => false, now: () => NOW, publicUrl: null,
    peyWebhookSecret: null, bankSim: false, udi: null, log: () => {}, channels: [channel],
  });
  const server = buildServer({
    db, registry, liveMerchantId: DEMO.merchantId, liveGateway: gateway, peyWebhookSecret: null, bankSim: false, log: () => {},
    portalAuth: { shopCode: null, secureCookies: false, now: () => NOW, verification: { mode: opts.verification ?? "off", waNumber: "15550001111" } },
    passkey: { rpID: "localhost", origins: ["http://localhost"], now: () => NOW },
  });
  const user = async (name: string, phone: string) => {
    const r = await server.inject({ method: "POST", url: "/api/auth/register", payload: { name, phone, pin: "2580" } });
    expect(r.statusCode, r.body).toBe(200);
    const cookie = String(r.headers["set-cookie"]).split(";")[0]!;
    const u = {
      cookie,
      state: async () => (await server.inject({ url: "/api/state", headers: { cookie } })).json() as StateJson,
      say: (text: string) => server.inject({ method: "POST", url: "/api/chat", headers: { cookie }, payload: { text } }),
      confirm: (proposal_id: string) => server.inject({ method: "POST", url: "/api/confirm", headers: { cookie }, payload: { proposal_id } }),
      cancel: (proposal_id: string) => server.inject({ method: "POST", url: "/api/cancel", headers: { cookie }, payload: { proposal_id } }),
      debts: async () => (await server.inject({ url: "/api/me/debts", headers: { cookie } })).json() as { debts: Array<{ store: string; owes: string }> },
      get: (url: string) => server.inject({ url, headers: { cookie } }),
      post: (url: string, payload: object = {}) => server.inject({ method: "POST", url, headers: { cookie }, payload }),
      lastProposal: async () => {
        const s = await u.state();
        return s.messages.filter((m) => m.actions?.some((a) => a.kind === "confirm")).at(-1)!.actions![0]!.proposal_id!;
      },
      lastBody: async () => (await u.state()).messages.filter((m) => m.thread === "comercio").at(-1)?.body ?? "",
    };
    return u;
  };
  return { db, server, registry, wa, channel, user };
}

describe("una libreta por persona", () => {
  it("cada registro tiene su propia tienda: lo que anota uno no lo ve el otro", async () => {
    const f = await setup();
    const ana = await f.user("Ana Ruiz", "5521111111");
    const memo = await f.user("Memo Díaz", "5522222222");
    expect((await ana.state()).merchant.name).toBe("La tienda de Ana");
    expect((await memo.state()).merchant.name).toBe("La tienda de Memo");
    expect((await ana.state()).customers).toEqual([]);

    await ana.say("Rosa se llevó $100");
    await ana.confirm(await ana.lastProposal());
    expect((await ana.state()).customers.map((c) => [c.name, c.owes])).toEqual([["Rosa", "10000"]]);
    // Memo no ve a Rosa, ni sus mensajes, ni nada de la demo.
    const m = await memo.state();
    expect(m.customers).toEqual([]);
    expect(m.messages.some((x) => /Rosa/.test(x.body))).toBe(false);
    expect(JSON.stringify(m)).not.toMatch(/Doña Lupe|Abarrotes La Esquina/);
  });

  it("nadie puede confirmar, cancelar ni cobrar lo de otra tienda", async () => {
    const f = await setup();
    const ana = await f.user("Ana Ruiz", "5521111111");
    const memo = await f.user("Memo Díaz", "5522222222");
    await ana.say("Rosa se llevó $100");
    await ana.confirm(await ana.lastProposal());
    await ana.say("Rosa se llevó $50");
    const pending = await ana.lastProposal();

    await memo.confirm(pending);
    await memo.cancel(pending);
    expect((await ana.state()).customers[0]!.owes).toBe("10000"); // ni se anotó ni se canceló
    await ana.confirm(pending);
    expect((await ana.state()).customers[0]!.owes).toBe("15000");

    await ana.say("QR para Rosa");
    const [charge] = await f.db.select().from(schema.charges).where(and(eq(schema.charges.status, "open"), ne(schema.charges.merchantId, DEMO.merchantId)));
    expect(charge, await ana.lastBody()).toBeDefined();
    expect((await memo.post(`/api/sim/pay/${charge!.id}`)).statusCode).toBe(409);
    expect((await ana.state()).customers[0]!.owes).toBe("15000");
    expect((await ana.post(`/api/sim/pay/${charge!.id}`)).statusCode).toBe(200);
    expect((await ana.state()).customers[0]!.owes).toBe("0");
  });

  it("el celular es único en todo Cuadra y quien tiene el celular de la dueña entra a la demo", async () => {
    const f = await setup();
    await f.user("Ana Ruiz", "5521111111");
    const again = await f.server.inject({ method: "POST", url: "/api/auth/register", payload: { name: "Otra Ana", phone: "55 2111 1111", pin: "1357" } });
    expect(again.statusCode).toBe(409);
    const owner = await f.user("Mari López", OWNER);
    const s = await owner.state();
    expect(s.merchant.name).toBe("Abarrotes La Esquina");
    expect(s.customers.map((c) => c.name)).toContain("Doña Lupe");
    // Entrar con NIP desde otro lado lleva a la misma tienda.
    const login = await f.server.inject({ method: "POST", url: "/api/auth/login", payload: { phone: OWNER, pin: "2580" } });
    const cookie = String(login.headers["set-cookie"]).split(";")[0]!;
    expect(((await f.server.inject({ url: "/api/state", headers: { cookie } })).json() as StateJson).merchant.name).toBe("Abarrotes La Esquina");
  });

  it("“Lo que debo”: ves tu deuda con cada tienda que te tiene como cliente, y nada más de esa tienda", async () => {
    const f = await setup();
    const owner = await f.user("Mari López", OWNER);
    await owner.say("Doña Lupe se llevó $185");
    await owner.confirm(await owner.lastProposal());
    const lupe = await f.user("Lupe Hernández", LUPE);
    expect((await lupe.state()).merchant.name).toBe("La tienda de Lupe"); // su propia libreta, vacía
    expect((await lupe.state()).customers).toEqual([]);
    const d = await lupe.debts();
    expect(d.debts).toEqual([{ store: "Abarrotes La Esquina", owes: "18500", credit: "0", open_charge: null }]);
    expect(JSON.stringify(d)).not.toMatch(/Beto|Chela|c_lupe|m_esquina/);
    // Otra tienda que también le fía a Lupe aparece aparte.
    const ana = await f.user("Ana Ruiz", "5521111111");
    await ana.say(`Agrega a Lupe, ${LUPE.slice(0, 2)} ${LUPE.slice(2, 6)} ${LUPE.slice(6)}`);
    await ana.confirm(await ana.lastProposal());
    await ana.say("Lupe se llevó $20");
    await ana.confirm(await ana.lastProposal());
    expect((await lupe.debts()).debts.map((x) => [x.store, x.owes])).toEqual([["Abarrotes La Esquina", "18500"], ["La tienda de Ana", "2000"]]);
    // A quien no le deben nada no ve deudas de otros.
    expect((await ana.debts()).debts).toEqual([]);
  });

  it("tandas: solo las de tu tienda (aunque no tengas ninguna)", async () => {
    const f = await setup();
    await f.db.insert(schema.proposals).values({
      id: "p_x", merchantId: DEMO.merchantId, actorId: DEMO.ownerId, type: "CreateTanda", provenance: "user_direct", payload: {}, proposalHash: "a".repeat(64), status: "done",
    });
    await f.db.insert(schema.passkeyCredentials).values({ id: "c", merchantUserId: DEMO.ownerId, publicKey: new Uint8Array([1]), counter: 0, transports: [] });
    await f.db.insert(schema.approvals).values({
      id: "a_x", merchantId: DEMO.merchantId, proposalId: "p_x", proposalHash: "a".repeat(64), credentialId: "c", assertion: {}, expiresAt: NOW,
    });
    await f.db.insert(schema.tandas).values({
      id: "t_demo", merchantId: DEMO.merchantId, name: "Tanda de la cuadra", contributionCents: 50_000n, period: "week",
      membersCount: 3, proposalId: "p_x", approvalId: "a_x", status: "done",
    });
    const owner = await f.user("Mari López", OWNER);
    const ana = await f.user("Ana Ruiz", "5521111111");
    expect(((await owner.get("/api/state")).json() as { tanda: { name: string } | null }).tanda?.name).toBe("Tanda de la cuadra");
    const s = (await ana.get("/api/state")).json() as { tanda: unknown };
    expect(s.tanda).toBeNull();
    expect(JSON.stringify(s)).not.toMatch(/Tanda de la cuadra/);
  });

  it("proveedores y mandatos: solo los de tu tienda", async () => {
    const f = await setup();
    const owner = await f.user("Mari López", OWNER);
    const ana = await f.user("Ana Ruiz", "5521111111");
    const payees = (await owner.get("/api/payees")).json() as Array<{ id: string }>;
    expect(payees.length).toBeGreaterThan(0);
    expect((await ana.get("/api/payees")).json()).toEqual([]);
    const steal = await ana.post("/api/mandate/propose", { payee_id: payees[0]!.id, per_op_pesos: 100, period_cap_pesos: 200, period: "week", valid_days: 30 });
    expect(steal.statusCode).toBe(404);
  });

  it("las cuentas de antes (todas en la demo) pasan a su propia tienda; la de la dueña se queda", async () => {
    const f = await setup();
    await f.db.insert(schema.portalAccounts).values([
      { id: "a_owner", merchantId: DEMO.merchantId, name: "Mari", phone: OWNER, pinHash: "x" },
      { id: "a_lupe", merchantId: DEMO.merchantId, name: "Lupe", phone: LUPE, pinHash: "x" },
      // Número ficticio (empieza con 0): tampoco se queda en la tienda de otro.
      { id: "a_ficticio", merchantId: DEMO.merchantId, name: "Prueba", phone: "0123456789", pinHash: "x" },
    ]);
    expect(await assignAccountStores(f.db, NOW)).toBe(2);
    const accts = await f.db.select().from(schema.portalAccounts);
    expect(accts.find((a) => a.id === "a_owner")!.merchantId).toBe(DEMO.merchantId);
    expect(accts.find((a) => a.id === "a_lupe")!.merchantId).not.toBe(DEMO.merchantId);
    const ficticio = accts.find((a) => a.id === "a_ficticio")!.merchantId;
    expect([DEMO.merchantId, accts.find((a) => a.id === "a_lupe")!.merchantId]).not.toContain(ficticio);
    expect(await assignAccountStores(f.db, NOW)).toBe(0); // idempotente
  });
});

describe("WhatsApp por celular", () => {
  it("el código del portal verifica el celular; antes, WhatsApp no le hace caso ni le escribe", async () => {
    const f = await setup({ verification: "whatsapp" });
    const r = await f.server.inject({ method: "POST", url: "/api/auth/register", payload: { name: "Ana Ruiz", phone: "5521111111", pin: "2580" } });
    const cookie = String(r.headers["set-cookie"]).split(";")[0]!;
    const route = async (merchantId: string) => (await f.registry.get(merchantId))?.service ?? null;
    // Sin verificar: sus mensajes no llegan a ninguna tienda y no se le contesta.
    await f.channel.handleInbound([{ kind: "text", id: "w0", from: "5215521111111", text: "Pepe se llevó $30", forwarded: false }], route);
    expect(f.wa.sent).toEqual([]);
    const code = ((await f.server.inject({ method: "POST", url: "/api/auth/verify/start", headers: { cookie }, payload: {} })).json() as { message: string }).message;
    // Otro celular manda el código: no verifica. Tampoco uno de otro país que termina igual.
    await f.channel.handleInbound([{ kind: "text", id: "w1", from: "5215599990000", text: code, forwarded: false }], route);
    await f.channel.handleInbound([{ kind: "text", id: "w1b", from: "15521111111", text: code, forwarded: false }], route);
    expect((await f.server.inject({ url: "/api/state", headers: { cookie } })).statusCode).toBe(403);
    // Ella lo manda desde su celular: verificada, se le contesta y ya entra a su libreta.
    await f.channel.handleInbound([{ kind: "text", id: "w2", from: "5215521111111", text: code, forwarded: false }], route);
    expect(f.wa.sent.at(-1)).toEqual({ to: "525521111111", body: "✅ Listo, Ana: tu celular quedó verificado. Regresa a Cuadra para seguir." });
    expect((await f.server.inject({ url: "/api/state", headers: { cookie } })).statusCode).toBe(200);
    const store = (await storeOfPhone(f.db, "5521111111"))!;
    const [owner] = await f.db.select().from(schema.merchantUsers).where(eq(schema.merchantUsers.id, store.ownerId));
    expect(owner!.phoneVerified).toBe(true);
    // Ahora sus mensajes van a su tienda y se le contesta por WhatsApp.
    await f.channel.handleInbound([{ kind: "text", id: "w3", from: "5215521111111", text: "Pepe se llevó $30", forwarded: false }], route);
    expect(f.wa.sent.at(-1)!.to).toBe("525521111111");
    expect(f.wa.sent.at(-1)!.body).toMatch(/Pepe/);
    const state = (await f.server.inject({ url: "/api/state", headers: { cookie } })).json() as StateJson;
    expect(state.messages.some((m) => /Pepe/.test(m.body))).toBe(true);
    // Un celular sin cuenta no llega a ninguna tienda, ni uno de otro país que termina igual que el de ella.
    const before = f.wa.sent.length;
    await f.channel.handleInbound([{ kind: "text", id: "w4", from: "5215599990000", text: "Pepe se llevó $30", forwarded: false }], route);
    await f.channel.handleInbound([{ kind: "text", id: "w5", from: "15521111111", text: "Paco se llevó $40", forwarded: false }], route);
    expect(f.wa.sent.length).toBe(before);
    expect(JSON.stringify((await f.server.inject({ url: "/api/state", headers: { cookie } })).json())).not.toMatch(/Paco/);
  });

  it("solo acepta remitentes de México (52 o 521 y 10 dígitos)", () => {
    expect(senderPhone10("5215521111111")).toBe("5521111111");
    expect(senderPhone10("525521111111")).toBe("5521111111");
    for (const x of ["15521111111", "5521111111", "6591234567", "4415521111111", "52055211111", "520123456789", ""]) expect(senderPhone10(x)).toBeNull();
  });
});

describe("pagos de pey a la tienda correcta", () => {
  it("la transacción se liga a la tienda de su cobro; lo que no se reconoce va a la tienda en vivo", async () => {
    const f = await setup();
    const ana = await f.user("Ana Ruiz", "5521111111");
    await ana.say("Rosa se llevó $100");
    await ana.confirm(await ana.lastProposal());
    await ana.say("QR para Rosa");
    const [c] = await f.db.select().from(schema.charges).where(and(eq(schema.charges.status, "open"), ne(schema.charges.merchantId, DEMO.merchantId)));
    const tx = { id: "TXA", payable_id: null, external_metadata: { cuadra_charge_id: c!.id } } as never;
    expect(await merchantOfTransaction(f.db, tx)).toBe(c!.merchantId);
    expect(c!.merchantId).not.toBe(DEMO.merchantId);
    expect(await merchantOfTransaction(f.db, { id: "TXZ", payable_id: null, external_metadata: {} } as never)).toBeNull();
  });

  it("el webhook aplica el pago en la tienda dueña del cobro (y no en la demo)", async () => {
    const f = await setup();
    const ana = await f.user("Ana Ruiz", "5521111111");
    await ana.say("Rosa se llevó $100");
    await ana.confirm(await ana.lastProposal());
    await ana.say("QR para Rosa");
    const [c] = await f.db.select().from(schema.charges).where(and(eq(schema.charges.status, "open"), ne(schema.charges.merchantId, DEMO.merchantId)));
    const paid = { id: "TXA", status: "PAID", amount_cents: 10000n, base_cents: 10000n, tip_cents: 0n, fee_cents: 0n, payment_method: "CODI",
      payable_type: "API_CODI_QR", payable_id: "QRA", date_paid: NOW, payer_clabe: null, tracking_key: null, external_metadata: { cuadra_charge_id: c!.id } };
    const live = { name: "pey", simulated: false, getTransaction: async () => paid } as never;
    const secret = "whsec_" + Buffer.from("secreto-de-prueba").toString("base64");
    const body = JSON.stringify({ type: "codi.qr.payment_received", transactionId: "TXA", amount: 100, codiQrId: "QRA" });
    const r = await handlePeyWebhookForStores(
      { db: f.db, registry: f.registry, secret, gateway: live, liveMerchantId: DEMO.merchantId },
      body,
      signPeyWebhook(secret, "evt_1", body, new Date()),
    );
    expect(r).toEqual({ status: 200, body: { ok: true } });
    expect(await ledgerBalance(f.db, c!.merchantId, "1200", c!.customerId)).toBe(0n);
    expect((await ana.lastBody())).toMatch(/pag/i);
    const demo = await f.db.select().from(schema.messages).where(eq(schema.messages.merchantId, DEMO.merchantId));
    expect(demo.some((m) => /Rosa/.test(m.body))).toBe(false);
  });
});
