import type { PeyTransaction } from "@cuadra/adapters";
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
  const svc = new CuadraService({
    db, merchantId: M, ownerId: DEMO.ownerId, interpreters: [new RuleInterpreter()], gateway: gw,
    verify: async () => false, now: () => clock, publicUrl: null, peyWebhookSecret: null, bankSim: false, udi: null, log: () => {},
  });
  const say = async (text: string) => svc.handleMerchantMessage(text);
  const lastBody = async () => (await db.select().from(schema.messages).where(eq(schema.messages.thread, "comercio")).orderBy(schema.messages.id)).at(-1)!.body;
  const confirmLast = async () => {
    const msgs = await db.select().from(schema.messages).orderBy(schema.messages.id);
    await svc.confirm(msgs.filter((m) => m.actions?.some((a) => a.kind === "confirm")).at(-1)!.actions![0]!.proposal_id!);
  };
  const fiado = async (t: string) => { await say(t); await confirmLast(); };
  return { db, svc, gw, say, lastBody, confirmLast, fiado, advance: (min: number) => { clock = new Date(clock.getTime() + min * 60_000); } };
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
    expect(await f.lastBody()).toMatch(/enviado a Doña Lupe por CoDi vía pey/);
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
