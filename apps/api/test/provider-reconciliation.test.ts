import type { PeyTransaction } from "@cuadra/adapters";
import { RuleInterpreter } from "@cuadra/agents";
import { DEMO, ledgerBalance, schema, seedDemo } from "@cuadra/db";
import { createTestDb } from "@cuadra/db/testing";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { type ChargeGateway, SimulatedGateway } from "../src/gateway.js";
import { CuadraService } from "../src/service.js";

const M = DEMO.merchantId;
const NOW = new Date();
const ago = (min: number) => new Date(NOW.getTime() - min * 60_000);

class FakePey implements ChargeGateway {
  readonly name = "pey";
  readonly simulated = false;
  txs: PeyTransaction[] = [];
  coveredSince: Date | null = null;
  n = 0;
  tx(over: Partial<PeyTransaction> & { cents: bigint; meta?: Record<string, string> }): PeyTransaction {
    const id = over.id ?? `TX${++this.n}`;
    const t: PeyTransaction = {
      id, status: "PAID", amount_cents: over.cents, base_cents: over.cents, tip_cents: 0n, fee_cents: 0n, payment_method: "CODI",
      payable_type: "API_CODI_PN", payable_id: over.payable_id ?? id, date_paid: ago(30), date_created: ago(31),
      payer_clabe: null, tracking_key: null, external_metadata: over.meta ?? {}, ...over,
    };
    this.txs.unshift(t);
    return t;
  }
  async requestPayment(r: Parameters<ChargeGateway["requestPayment"]>[0]) {
    const t = this.tx({ cents: r.amount_cents, meta: r.metadata, status: "PENDING" });
    return { provider_charge_id: t.id };
  }
  async createQr(): Promise<never> { throw new Error("no"); }
  async getTransaction(id: string) { return this.txs.find((t) => t.id === id)!; }
  async registerAccount() { return { id: "ba", status: "ACTIVE" }; }
  async accountStatus() { return "ACTIVE"; }
  async listRecentTransactions() { return { items: this.txs, coveredSince: this.coveredSince }; }
}

async function setup(gw?: (db: any) => ChargeGateway) {
  const { db } = await createTestDb();
  await seedDemo(db, NOW, { lupePhone: "8331550510" });
  const gateway = gw ? gw(db) : new FakePey();
  const svc = new CuadraService({
    db, merchantId: M, ownerId: DEMO.ownerId, interpreters: [new RuleInterpreter()], gateway,
    verify: async () => false, now: () => NOW, publicUrl: null, peyWebhookSecret: null, bankSim: false, udi: null, log: () => {},
  });
  const comercio = async () => (await db.select().from(schema.messages).where(eq(schema.messages.thread, "comercio")).orderBy(schema.messages.id)).map((m) => m.body);
  const frozen = async () => (await db.select().from(schema.riskState).where(eq(schema.riskState.merchantId, M)))[0]!.reconciliationMismatch;
  return { db, svc, gw: gateway as FakePey, comercio, frozen };
}

describe("conciliación contra pey", () => {
  it("webhook perdido: pey cobró y Cuadra no lo registró → se recupera una sola vez", async () => {
    const f = await setup();
    await f.db.insert(schema.charges).values({ id: "ch_x", merchantId: M, customerId: "c_lupe", reference: "7654321", amountCents: 18500n, provider: "pey", providerChargeId: "TXL", channel: "codi_pn", createdAt: ago(40) });
    const { fiado } = await import("@cuadra/core");
    const { postEntries } = await import("@cuadra/db");
    await postEntries(f.db, [fiado({ merchant_id: M, idempotency_key: "f1", amount: 18500n, customer_id: "c_lupe" })]);
    f.gw.tx({ id: "TXL", cents: 18500n, meta: { cuadra_charge_id: "ch_x" } });

    const r1 = await f.svc.reconcileProvider();
    expect(r1).toMatchObject({ skipped: false, checked: 1, recovered: ["TXL"], ok: true });
    expect(await ledgerBalance(f.db, M, "1200", "c_lupe")).toBe(0n);
    expect((await f.comercio()).some((b) => /recuperé 1 pago/.test(b))).toBe(true);

    const r2 = await f.svc.reconcileProvider();
    expect(r2).toMatchObject({ recovered: [], ok: true });
    expect(await ledgerBalance(f.db, M, "1100")).toBe(18500n);
    expect(await f.frozen()).toBe(false);
  });

  it("pago en Cuadra que pey no reporta → discrepancia, se congelan las salidas", async () => {
    const f = await setup();
    await f.db.insert(schema.deposits).values({ merchantId: M, claveRastreo: "pey:FANTASMA", amountCents: 5000n, provider: "pey", receivedAt: ago(20) });
    const r = await f.svc.reconcileProvider();
    expect(r.ok).toBe(false);
    expect(r.discrepancies).toEqual([expect.objectContaining({ kind: "no_existe_en_proveedor", transaction_id: "FANTASMA" })]);
    expect(await f.frozen()).toBe(true);
    expect((await f.comercio()).at(-1)).toMatch(/congelé las salidas/);
  });

  it("monto distinto o transacción no pagada en pey → discrepancia", async () => {
    const f = await setup();
    await f.db.insert(schema.deposits).values({ merchantId: M, claveRastreo: "pey:TXA", amountCents: 5000n, provider: "pey", receivedAt: ago(20) });
    await f.db.insert(schema.deposits).values({ merchantId: M, claveRastreo: "pey:TXB", amountCents: 100n, provider: "pey", receivedAt: ago(20) });
    f.gw.tx({ id: "TXA", cents: 4000n });
    f.gw.tx({ id: "TXB", cents: 100n, status: "PENDING" });
    const r = await f.svc.reconcileProvider();
    expect(r.discrepancies.map((d) => d.kind).sort()).toEqual(["monto_distinto", "no_pagado_en_proveedor"]);
  });

  it("registros muy recientes o fuera de lo que se leyó no se marcan", async () => {
    const f = await setup();
    await f.db.insert(schema.deposits).values({ merchantId: M, claveRastreo: "pey:RECIEN", amountCents: 100n, provider: "pey", receivedAt: ago(1) });
    await f.db.insert(schema.deposits).values({ merchantId: M, claveRastreo: "pey:VIEJO", amountCents: 100n, provider: "pey", receivedAt: ago(3 * 24 * 60) });
    f.gw.coveredSince = ago(2 * 24 * 60); // la lista se cortó hace 2 días
    const r = await f.svc.reconcileProvider();
    expect(r).toMatchObject({ ok: true, discrepancies: [] });
  });

  it("pago sin cobro conocido (p. ej. prueba manual) → se registra en 1300, no se adivina", async () => {
    const f = await setup();
    f.gw.tx({ id: "TXP", cents: 1n, meta: { cuadra_prueba: "si" } });
    const r = await f.svc.reconcileProvider();
    expect(r).toMatchObject({ recovered: ["TXP"], ok: true });
    expect(await ledgerBalance(f.db, M, "1300")).toBe(1n);
  });

  it("en modo simulado no corre", async () => {
    const f = await setup((db) => new SimulatedGateway(db));
    expect(await f.svc.reconcileProvider()).toMatchObject({ skipped: true });
  });

  it("dos corridas simultáneas no se pisan", async () => {
    const f = await setup();
    f.gw.tx({ id: "TXZ", cents: 1n });
    const [a, b] = await Promise.all([f.svc.reconcileProvider(), f.svc.reconcileProvider()]);
    expect(a).toBe(b);
    expect(await ledgerBalance(f.db, M, "1300")).toBe(1n);
  });
});
