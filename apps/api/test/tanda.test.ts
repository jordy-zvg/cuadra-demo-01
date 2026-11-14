import { type PeyTransaction, verifyProposalAssertion } from "@cuadra/adapters";
import { SoftAuthenticator } from "@cuadra/adapters/testing";
import { RuleInterpreter } from "@cuadra/agents";
import { CreateTanda } from "@cuadra/core";
import { type AssertionVerifier, DEMO, createTandaFromApproval, ledgerBalance, saveApproval, saveProposal, schema, seedDemo, setMemberBankAccount } from "@cuadra/db";
import { createTestDb } from "@cuadra/db/testing";
import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import type { ChargeGateway } from "../src/gateway.js";
import { CuadraService } from "../src/service.js";

const NOW = new Date("2026-11-14T11:00:00-06:00");
const RP = { rpID: "cuadra.test", origins: ["https://cuadra.test"] };
const M = DEMO.merchantId;
const CLABES = ["012180015826225713", "012180015913466252", "014180606004536217"];

class FakePey implements ChargeGateway {
  readonly name = "pey";
  readonly simulated = false;
  txs = new Map<string, PeyTransaction>();
  pushes: Array<Record<string, any>> = [];
  n = 0;
  async requestPayment(r: Parameters<ChargeGateway["requestPayment"]>[0]) {
    this.pushes.push(r);
    const id = `TX${++this.n}`;
    this.txs.set(id, { id, status: "PAID", amount_cents: r.amount_cents, base_cents: r.amount_cents, tip_cents: 0n, fee_cents: 0n, payment_method: "CODI", payable_type: "API_CODI_PN", payable_id: id, date_paid: NOW, payer_clabe: null, tracking_key: null, external_metadata: { ...r.metadata } });
    return { provider_charge_id: id };
  }
  async createQr(): Promise<never> { throw new Error("no"); }
  async getTransaction(id: string) { return this.txs.get(id)!; }
  async registerAccount(r: { clabe: string }) { return { id: `ba_${r.clabe.slice(-4)}`, status: "ACTIVE" }; }
  async accountStatus() { return "ACTIVE"; }
}

async function setup() {
  const { db, pg } = await createTestDb();
  await seedDemo(db, NOW);
  const auth = new SoftAuthenticator(RP.rpID, RP.origins[0]!);
  await db.insert(schema.passkeyCredentials).values({ id: auth.credentialId, merchantUserId: DEMO.ownerId, publicKey: auth.publicKeyCose });
  const verify: AssertionVerifier = (a) => verifyProposalAssertion({ ...a, config: RP });
  const gw = new FakePey();
  const svc = new CuadraService({
    db, merchantId: M, ownerId: DEMO.ownerId, interpreters: [new RuleInterpreter()], gateway: gw, verify,
    now: () => NOW, publicUrl: null, peyWebhookSecret: null, bankSim: false, udi: null, log: () => {},
  });
  const proposal = CreateTanda.parse({
    type: "CreateTanda", merchant_id: M, provenance: "user_direct", name: "Tanda del mercado", contribution_cents: 50000, period: "week",
    members: [{ name: "Ana", phone: "5511111111", clabe: CLABES[0] }, { name: "Bety", phone: "5522222222", clabe: CLABES[1] }, { name: "Caro", phone: "5533333333", clabe: CLABES[2] }],
  });
  const saved = await saveProposal(db, { id: "pr_t", actorId: DEMO.ownerId, proposal });
  await saveApproval(db, { id: "ap_t", proposalId: "pr_t", credentialId: auth.credentialId, assertion: auth.approve(saved.proposalHash), priorCounter: 0, now: NOW });
  await createTandaFromApproval(db, { tandaId: "td_1", proposalId: "pr_t", approvalId: "ap_t", now: NOW, verify });
  for (let i = 1; i <= 3; i++) await setMemberBankAccount(db, "td_1", i, `ba_${CLABES[i - 1]!.slice(-4)}`, "ACTIVE");
  const last = async (thread = "comercio") =>
    (await db.select().from(schema.messages).where(eq(schema.messages.thread, thread)).orderBy(schema.messages.id)).at(-1)?.body ?? "";
  const pay = (id: string) => svc.applyPayment(gw.txs.get(id)!);
  return { db, pg, svc, gw, last, pay };
}

describe("tanda sin pozo", () => {
  it("cada aportación va directo a la cuenta de quien le toca; la ronda se completa y avanza", async () => {
    const f = await setup();
    await f.svc.handleMerchantMessage("Cobra la tanda");
    expect(f.gw.pushes).toHaveLength(2);
    expect(f.gw.pushes.map((p) => p.phone10).sort()).toEqual(["5522222222", "5533333333"]);
    expect(f.gw.pushes.every((p) => p.bank_account_id === "ba_5713" && p.amount_cents === 50000n)).toBe(true);
    expect(await f.last()).toMatch(/Ronda 1 de 3.*le toca a Ana/);

    await f.pay("TX1");
    expect(await f.last()).toMatch(/aportó a la ronda 1\. Faltan: (Bety|Caro)/);
    await f.pay("TX1"); // reintento del webhook: no duplica
    await f.pay("TX2");
    expect(await f.last()).toMatch(/Pozo completo! \$1,000\.00 llegaron directo a la cuenta de Ana/);
    // Cuadra no tocó el dinero: el ledger del comercio no se mueve.
    expect(await ledgerBalance(f.db, M, "1100")).toBe(0n);

    await f.svc.handleMerchantMessage("Cobra la tanda");
    expect(f.gw.pushes.slice(2).every((p) => p.bank_account_id === "ba_6252")).toBe(true);
    expect(await f.last()).toMatch(/Ronda 2 de 3.*Bety/);
  });

  it("no arranca otra ronda mientras falte alguien; consulta de quién falta", async () => {
    const f = await setup();
    await f.svc.handleMerchantMessage("Cobra la tanda");
    await f.pay("TX1");
    await f.svc.handleMerchantMessage("Cobra la tanda");
    expect(await f.last()).toMatch(/La ronda 1 aún no se completa/);
    await f.svc.handleMerchantMessage("¿Cómo va la tanda?");
    expect(await f.last()).toMatch(/Ya pagaron: .*\n⏳ Faltan: /);
    await f.svc.handleMerchantMessage("recuérdales la tanda");
    expect(await f.last()).toMatch(/siguen vigentes/);
    expect(f.gw.pushes).toHaveLength(2);
  });

  it("pago doble de un integrante → discrepancia para devolver, sin romper el webhook", async () => {
    const f = await setup();
    await f.svc.handleMerchantMessage("Cobra la tanda");
    const bety = f.gw.pushes.findIndex((p) => p.phone10 === "5522222222");
    await f.pay(`TX${bety + 1}`);
    // Segunda solicitud para Bety (p. ej. tras un recordatorio) que también paga.
    const [c] = await f.db.select().from(schema.tandaCharges).where(and(eq(schema.tandaCharges.payerPosition, 2), eq(schema.tandaCharges.status, "paid")));
    await f.db.insert(schema.tandaCharges).values({ id: "tch_dup", tandaId: "td_1", round: 1, payerPosition: 2, recipientPosition: 1, amountCents: 50000n, provider: "pey", providerChargeId: "TXDUP" });
    f.gw.txs.set("TXDUP", { ...f.gw.txs.get(`TX${bety + 1}`)!, id: "TXDUP", payable_id: "TXDUP", external_metadata: { cuadra_tanda_charge_id: "tch_dup" } });
    await f.pay("TXDUP");
    expect(c).toBeTruthy();
    expect(await f.last()).toMatch(/pagó dos veces/);
  });

  it("si alguien cambia una CLABE en la base, la tanda se congela y no cobra", async () => {
    const f = await setup();
    await f.pg.exec(`UPDATE tanda_members SET clabe = '012180015355682429' WHERE tanda_id = 'td_1' AND position = 1`);
    await f.svc.handleMerchantMessage("Cobra la tanda");
    expect(await f.last()).toMatch(/no coincide con lo que firmaste/);
    expect(f.gw.pushes).toHaveLength(0);
    const [t] = await f.db.select().from(schema.tandas).where(eq(schema.tandas.id, "td_1"));
    expect(t!.status).toBe("frozen");
  });

  it("cuenta de quien recibe aún no activa en pey → no arranca", async () => {
    const f = await setup();
    await setMemberBankAccount(f.db, "td_1", 1, "ba_5713", "PENDING");
    f.gw.accountStatus = async () => "PROCESSING";
    await f.svc.handleMerchantMessage("Cobra la tanda");
    expect(await f.last()).toMatch(/aún no está activa para CoDi \(estado: PROCESSING\)/);
    expect(f.gw.pushes).toHaveLength(0);
  });
});
