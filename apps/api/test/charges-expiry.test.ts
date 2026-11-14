import { PeyApiError, type PeyTransaction } from "@cuadra/adapters";
import { RuleInterpreter } from "@cuadra/agents";
import { DEMO, ledgerBalance, schema, seedDemo } from "@cuadra/db";
import { createTestDb } from "@cuadra/db/testing";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import type { ChargeGateway } from "../src/gateway.js";
import { CuadraService } from "../src/service.js";

const T0 = new Date("2026-11-14T11:00:00-06:00");
const M = DEMO.merchantId;

class FakePey implements ChargeGateway {
  readonly name = "pey";
  readonly simulated = false;
  txs = new Map<string, PeyTransaction>();
  pushes: Array<Record<string, unknown>> = [];
  qrs: Array<Record<string, unknown>> = [];
  n = 0;
  private add(kind: "API_CODI_PN" | "API_CODI_QR", r: { amount_cents: bigint; metadata: Record<string, string> }) {
    const id = `TX${++this.n}`;
    this.txs.set(id, { id, status: "PENDING", amount_cents: r.amount_cents, base_cents: r.amount_cents, tip_cents: 0n, fee_cents: 0n, payment_method: "CODI", payable_type: kind, payable_id: id, date_paid: null, payer_clabe: null, tracking_key: null, external_metadata: { ...r.metadata } });
    return id;
  }
  async requestPayment(r: Parameters<ChargeGateway["requestPayment"]>[0]) { this.pushes.push(r); return { provider_charge_id: this.add("API_CODI_PN", r) }; }
  async createQr(r: Parameters<ChargeGateway["createQr"]>[0]) { this.qrs.push(r); return { provider_charge_id: this.add("API_CODI_QR", r), image_png_base64: null }; }
  async getTransaction(id: string) { return this.txs.get(id)!; }
  async registerAccount() { return { id: "ba", status: "ACTIVE" }; }
  async accountStatus() { return "ACTIVE"; }
  pay(id: string) { this.txs.set(id, { ...this.txs.get(id)!, status: "PAID", date_paid: T0 }); }
}

async function setup() {
  const { db } = await createTestDb();
  await seedDemo(db, T0, { lupePhone: "8331550510" });
  const gw = new FakePey();
  let clock = T0;
  const logs: Array<Record<string, unknown>> = [];
  const svc = new CuadraService({
    db, merchantId: M, ownerId: DEMO.ownerId, interpreters: [new RuleInterpreter()], gateway: gw,
    verify: async () => false, now: () => clock, publicUrl: null, peyWebhookSecret: null, bankSim: false, udi: null, log: (r) => logs.push(r),
  });
  const say = async (text: string) => svc.handleMerchantMessage(text);
  const lastBody = async () => (await db.select().from(schema.messages).where(eq(schema.messages.thread, "comercio")).orderBy(schema.messages.id)).at(-1)!.body;
  const confirmLast = async () => {
    const msgs = await db.select().from(schema.messages).orderBy(schema.messages.id);
    await svc.confirm(msgs.filter((m) => m.actions?.some((a) => a.kind === "confirm")).at(-1)!.actions![0]!.proposal_id!);
  };
  const fiado = async (t: string) => { await say(t); await confirmLast(); };
  return { db, svc, gw, logs, say, lastBody, confirmLast, fiado, advance: (min: number) => { clock = new Date(clock.getTime() + min * 60_000); } };
}

describe("cobros vencidos no bloquean al cliente", () => {
  it("QR vencido (30 min + margen) → se puede emitir otro; el viejo queda vencido", async () => {
    const f = await setup();
    await f.fiado("Doña Lupe se llevó $0.01");
    await f.say("QR para Doña Lupe");
    expect(f.gw.qrs).toHaveLength(1);
    f.advance(31);
    await f.say("QR para Doña Lupe");
    expect(await f.lastBody()).toMatch(/ya tiene un cobro abierto/); // aún dentro del margen de 2 min
    f.advance(2);
    await f.say("QR para Doña Lupe");
    expect(f.gw.qrs).toHaveLength(2);
    const charges = await f.db.select().from(schema.charges).where(eq(schema.charges.customerId, "c_lupe")).orderBy(schema.charges.createdAt);
    expect(charges.map((c) => c.status)).toEqual(["expired", "open"]);
  });

  it("si llega tarde el pago de un cobro vencido, se aplica igual (sin cobrar doble)", async () => {
    const f = await setup();
    await f.fiado("Doña Lupe se llevó $0.01");
    await f.say("QR para Doña Lupe");
    f.advance(40);
    await f.say("QR para Doña Lupe"); // vence el primero y emite otro
    f.gw.pay("TX1");
    await f.svc.applyPayment(await f.gw.getTransaction("TX1"));
    expect(await ledgerBalance(f.db, M, "1200", "c_lupe")).toBe(0n);
    const [first] = await f.db.select().from(schema.charges).where(eq(schema.charges.providerChargeId, "TX1"));
    expect(first!.status).toBe("paid");
  });

  it("solicitud al celular vencida (1 h) → se puede volver a cobrar por QR", async () => {
    const f = await setup();
    await f.fiado("Doña Lupe se llevó $0.01");
    await f.say("Cóbrale a Doña Lupe");
    await f.confirmLast();
    expect(f.gw.pushes[0]).toMatchObject({ phone10: "8331550510", amount_cents: 1n });
    f.advance(63);
    await f.say("QR para Doña Lupe");
    expect(f.gw.qrs).toHaveLength(1);
  });
});

describe("solicitud al celular rechazada por pey", () => {
  it("el cobro se cancela, al cliente no le llega nada y se puede cobrar por QR de inmediato", async () => {
    const f = await setup();
    f.gw.requestPayment = async () => {
      throw new Error("Phone number not registered for CoDi");
    };
    await f.fiado("Doña Lupe se llevó $0.01");
    await f.say("Cóbrale a Doña Lupe");
    await f.confirmLast();
    expect(await f.lastBody()).toMatch(/No salió la solicitud CoDi de \$0\.01 a Doña Lupe: Phone number not registered for CoDi/);
    const lupeMsgs = await f.db.select().from(schema.messages).where(eq(schema.messages.thread, "c_lupe"));
    expect(lupeMsgs).toHaveLength(0);
    const [ch] = await f.db.select().from(schema.charges).where(eq(schema.charges.customerId, "c_lupe"));
    expect(ch!.status).toBe("cancelled");
    await f.say("QR para Doña Lupe");
    expect(f.gw.qrs).toHaveLength(1);
  });

  it("un intento fallido no cuenta como recordatorio: se puede reintentar al celular", async () => {
    const f = await setup();
    const real = f.gw.requestPayment.bind(f.gw);
    let fail = true;
    f.gw.requestPayment = async (r) => {
      if (fail) throw new Error("pey 503");
      return real(r);
    };
    await f.fiado("Doña Lupe se llevó $0.01");
    await f.say("Cóbrale a Doña Lupe");
    await f.confirmLast();
    fail = false;
    await f.say("Cóbrale a Doña Lupe");
    await f.confirmLast();
    expect(f.gw.pushes).toHaveLength(1);
    expect(await f.lastBody()).toMatch(/pey aceptó la solicitud CoDi de \$0\.01 para Doña Lupe/);
  });
});

describe("diagnóstico de la solicitud al celular", () => {
  it("sin saldo no ofrece un cobro de $0.00 ni pide confirmar", async () => {
    const f = await setup();
    await f.say("Cóbrale a Doña Lupe");
    expect(await f.lastBody()).toMatch(/Doña Lupe no te debe nada/);
    const msgs = await f.db.select().from(schema.messages).where(eq(schema.messages.thread, "comercio"));
    expect(msgs.some((m) => /\$0\.00/.test(m.body))).toBe(false);
    expect(msgs.some((m) => m.actions?.some((a) => a.kind === "confirm"))).toBe(false);
    expect(f.gw.pushes).toHaveLength(0);
  });

  it("pey la rechaza (4xx): se registra status, tipo y requestId y se sugiere revisar CoDi", async () => {
    const f = await setup();
    f.gw.requestPayment = async () => {
      throw new PeyApiError(400, "INVALID_REQUEST", "Phone not enrolled", "req_123");
    };
    await f.fiado("Doña Lupe se llevó $0.01");
    await f.say("Cóbrale a Doña Lupe");
    await f.confirmLast();
    expect(await f.lastBody()).toMatch(/Revisa que su celular esté registrado en CoDi/);
    expect(f.logs.find((l) => l.msg === "pey_pn_failed")).toMatchObject({ status: 400, type: "INVALID_REQUEST", request_id: "req_123" });
  });

  it("pey en mantenimiento (503): no culpa al registro en CoDi", async () => {
    const f = await setup();
    f.gw.requestPayment = async () => {
      throw new PeyApiError(503, "SERVICE_UNAVAILABLE", "This endpoint is under maintenance", null);
    };
    await f.fiado("Doña Lupe se llevó $0.01");
    await f.say("Cóbrale a Doña Lupe");
    await f.confirmLast();
    const body = await f.lastBody();
    expect(body).toMatch(/pey no respondió bien en este momento/);
    expect(body).not.toMatch(/registrado en CoDi/);
  });

  it("aceptada: guarda el folio de Banxico (codiId) para poder rastrearla con pey", async () => {
    const f = await setup();
    const real = f.gw.requestPayment.bind(f.gw);
    f.gw.requestPayment = async (r) => ({ ...(await real(r)), codi_id: "12345678901234567890" });
    await f.fiado("Doña Lupe se llevó $0.01");
    await f.say("Cóbrale a Doña Lupe");
    await f.confirmLast();
    expect(f.logs.find((l) => l.msg === "pey_pn_sent")).toMatchObject({ transaction_id: "TX1", codi_id: "12345678901234567890" });
    const done = (await f.db.select().from(schema.proposals)).find((p) => (p.decision as { codi_id?: string } | null)?.codi_id);
    expect(done).toBeDefined();
    expect(await f.lastBody()).toMatch(/vigente 60 min/);
  });
});

describe("cobro directo al celular en la demo", () => {
  it("los cobros simulados y los QR de mostrador no cuentan como recordatorio previo", async () => {
    const f = await setup();
    // Un cobro simulado de hoy (como los de la demo antes de conectar pey) y un QR pagado.
    await f.db.insert(schema.charges).values({ id: "ch_sim", merchantId: M, customerId: "c_lupe", reference: "1111111", amountCents: 100n, status: "paid", provider: "pey_sim", channel: "codi_pn", createdAt: T0 });
    await f.fiado("Doña Lupe se llevó $0.01");
    await f.say("QR para Doña Lupe");
    f.gw.pay("TX1");
    await f.svc.applyPayment(await f.gw.getTransaction("TX1"));
    await f.fiado("Doña Lupe se llevó $0.01");
    await f.say("Cóbrale a Doña Lupe");
    await f.confirmLast();
    expect(f.gw.pushes).toHaveLength(1);
    expect(f.gw.pushes[0]).toMatchObject({ phone10: "8331550510" });
    expect(await f.lastBody()).toMatch(/pey aceptó la solicitud CoDi de \$0\.01 para Doña Lupe/);
  });

  it("una solicitud real sí cuenta: no se manda otra en 72 h", async () => {
    const f = await setup();
    await f.fiado("Doña Lupe se llevó $0.01");
    await f.say("Cóbrale a Doña Lupe");
    await f.confirmLast();
    f.advance(120);
    await f.say("Cóbrale a Doña Lupe");
    await f.confirmLast();
    expect(f.gw.pushes).toHaveLength(1);
    expect(await f.lastBody()).toMatch(/últimas 72 horas/);
  });
});
