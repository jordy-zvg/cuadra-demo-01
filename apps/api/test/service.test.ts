import { type PeyTransaction, signPeyWebhook } from "@cuadra/adapters";
import { RuleInterpreter } from "@cuadra/agents";
import { DEMO, ledgerBalance, runReconciliation, schema, seedDemo } from "@cuadra/db";
import { createTestDb } from "@cuadra/db/testing";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import type { ChargeGateway } from "../src/gateway.js";
import { SimulatedGateway } from "../src/gateway.js";
import { seedHistory } from "../src/seed-history.js";
import { CuadraService } from "../src/service.js";

const NOW = new Date("2026-11-14T11:00:00-06:00");
const SECRET = `whsec_${Buffer.from("secreto-de-prueba-32-bytes-xxxxx").toString("base64")}`;
const M = DEMO.merchantId;

/** pey falso: emite transacciones y responde GET /transaction como la API real. */
class FakePey implements ChargeGateway {
  readonly name = "pey";
  readonly simulated = false;
  txs = new Map<string, PeyTransaction>();
  pushes: Array<Record<string, unknown>> = [];
  n = 0;
  async requestPayment(r: Parameters<ChargeGateway["requestPayment"]>[0]) {
    this.pushes.push(r);
    const id = `01TX${++this.n}`;
    this.txs.set(id, {
      id, status: "PENDING", amount_cents: r.amount_cents, base_cents: r.amount_cents, tip_cents: 0n, fee_cents: 0n,
      payment_method: "CODI", payable_type: "API_CODI_PN", payable_id: id, date_paid: null,
      payer_clabe: "012180015826225713", tracking_key: "TK1", external_metadata: { ...r.metadata },
    });
    return { provider_charge_id: id };
  }
  qrs: Array<Record<string, unknown>> = [];
  async createQr(r: Parameters<ChargeGateway["createQr"]>[0]) {
    this.qrs.push(r);
    const id = `01QRTX${++this.n}`;
    this.txs.set(id, {
      id, status: "PENDING", amount_cents: r.amount_cents, base_cents: r.amount_cents, tip_cents: 0n, fee_cents: 0n,
      payment_method: "CODI", payable_type: "API_CODI_QR", payable_id: id, date_paid: null,
      payer_clabe: null, tracking_key: null, external_metadata: { ...r.metadata },
    });
    return { provider_charge_id: id, image_png_base64: "iVBORw0KGgo=" };
  }
  accounts: Array<Record<string, unknown>> = [];
  accountStatusValue = "ACTIVE";
  async registerAccount(r: { clabe: string; name: string; alias: string }) {
    this.accounts.push(r);
    return { id: `ba_${r.clabe.slice(-4)}`, status: this.accountStatusValue };
  }
  async accountStatus() {
    return this.accountStatusValue;
  }
  async getTransaction(id: string) {
    const t = this.txs.get(id);
    if (!t) throw new Error("404");
    return t;
  }
  pay(id: string, over: Partial<PeyTransaction> = {}) {
    const t = this.txs.get(id)!;
    this.txs.set(id, { ...t, status: "PAID", date_paid: NOW, ...over });
  }
}

async function setup(gateway?: (db: Awaited<ReturnType<typeof createTestDb>>["db"]) => ChargeGateway, opts: { publicUrl?: string } = {}) {
  const { db } = await createTestDb();
  await seedDemo(db, NOW, { lupePhone: "+525512345678" });
  const gw = gateway ? gateway(db) : new FakePey();
  const svc = new CuadraService({
    db, merchantId: M, ownerId: DEMO.ownerId, interpreters: [new RuleInterpreter(), new RuleInterpreter(), new RuleInterpreter()],
    gateway: gw, verify: async () => false, now: () => NOW, publicUrl: opts.publicUrl ?? null, peyWebhookSecret: SECRET, bankSim: false, udi: 8_500_000n, log: () => {},
  });
  const msgs = async (thread = "comercio") =>
    (await db.select().from(schema.messages).where(eq(schema.messages.thread, thread)).orderBy(schema.messages.id)).map((m) => m);
  const lastAction = async () => (await msgs()).filter((m) => m.actions?.length).at(-1)!.actions![0]!.proposal_id!;
  return { db, svc, gw, msgs, lastAction };
}

const webhook = (body: object, id = "msg_1") => {
  const raw = JSON.stringify(body);
  return [raw, signPeyWebhook(SECRET, id, raw, new Date())] as const;
};

describe("fiado y cobro con pey", () => {
  let f: Awaited<ReturnType<typeof setup>>;
  beforeEach(async () => {
    f = await setup();
  });

  it("propone, se confirma con botón y registra el fiado", async () => {
    await f.svc.handleMerchantMessage("Doña Lupe se llevó $185");
    expect(await ledgerBalance(f.db, M, "1200", "c_lupe")).toBe(0n);
    await f.svc.confirm(await f.lastAction());
    expect(await ledgerBalance(f.db, M, "1200", "c_lupe")).toBe(18500n);
    // Un segundo clic no duplica.
    await f.svc.confirm(await f.lastAction());
    expect(await ledgerBalance(f.db, M, "1200", "c_lupe")).toBe(18500n);
  });

  it("cobro CoDi: notificación con monto = saldo, referencia y metadata; el webhook concilia solo", async () => {
    await f.svc.handleMerchantMessage("Doña Lupe se llevó $185");
    await f.svc.confirm(await f.lastAction());
    await f.svc.handleMerchantMessage("Cóbrale a Doña Lupe");
    await f.svc.confirm(await f.lastAction());
    const gw = f.gw as FakePey;
    expect(gw.pushes[0]).toMatchObject({ amount_cents: 18500n, phone10: "5512345678", num_ref: expect.stringMatching(/^[1-9]\d{6}$/) });
    expect(gw.pushes[0]!.metadata).toMatchObject({ cuadra_charge_id: expect.stringMatching(/^ch_/) });

    // Webhook antes de que esté pagada en pey: no se registra nada.
    const [raw0, h0] = webhook({ type: "codi.pn.payment_received", transactionId: "01TX1", amount: 185 }, "msg_0");
    expect(await f.svc.handlePeyWebhook(raw0, h0)).toMatchObject({ status: 200 });
    expect(await ledgerBalance(f.db, M, "1100")).toBe(0n);

    gw.pay("01TX1");
    const [raw, h] = webhook({ type: "codi.pn.payment_received", transactionId: "01TX1", amount: 185 }, "msg_1");
    expect(await f.svc.handlePeyWebhook(raw, h)).toMatchObject({ status: 200 });
    expect(await ledgerBalance(f.db, M, "1200", "c_lupe")).toBe(0n);
    expect(await ledgerBalance(f.db, M, "1100")).toBe(18500n);
    const [ch] = await f.db.select().from(schema.charges).where(eq(schema.charges.customerId, "c_lupe"));
    expect(ch!.status).toBe("paid");
    expect((await f.msgs("c_lupe")).at(-1)!.body).toMatch(/Recibo: pagaste \$185\.00/);

    // Reintento del mismo webhook y otro webhook con la misma transacción: sin duplicar.
    expect(await f.svc.handlePeyWebhook(raw, h)).toMatchObject({ body: { duplicate: true } });
    const [raw2, h2] = webhook({ type: "codi.pn.payment_received", transactionId: "01TX1", amount: 185 }, "msg_2");
    await f.svc.handlePeyWebhook(raw2, h2);
    expect(await ledgerBalance(f.db, M, "1100")).toBe(18500n);
  });

  it("el monto que se abona es el base confirmado por pey, no el del webhook; comisión y propina se guardan", async () => {
    await f.svc.handleMerchantMessage("Doña Lupe se llevó $100");
    await f.svc.confirm(await f.lastAction());
    await f.svc.handleMerchantMessage("Cóbrale a Doña Lupe");
    await f.svc.confirm(await f.lastAction());
    const gw = f.gw as FakePey;
    gw.pay("01TX1", { amount_cents: 10250n, base_cents: 10000n, fee_cents: 250n });
    const [raw, h] = webhook({ type: "codi.pn.payment_received", transactionId: "01TX1", amount: 99999 });
    await f.svc.handlePeyWebhook(raw, h);
    expect(await ledgerBalance(f.db, M, "1100")).toBe(10000n);
    const [d] = await f.db.select().from(schema.deposits);
    expect(d).toMatchObject({ amountCents: 10000n, grossCents: 10250n, feeCents: 250n, matchMethod: "provider_charge", trackingKey: "TK1" });
  });

  it("firma inválida → 400 y nada cambia", async () => {
    const [raw, h] = webhook({ type: "codi.pn.payment_received", transactionId: "01TX1", amount: 1 });
    expect(await f.svc.handlePeyWebhook(raw.replace("1}", "2}"), h)).toMatchObject({ status: 400 });
  });

  it("pago sin cobro conocido → 1300 (por identificar), nunca se adivina", async () => {
    const gw = f.gw as FakePey;
    gw.txs.set("01X", { id: "01X", status: "PAID", amount_cents: 5000n, base_cents: 5000n, tip_cents: 0n, fee_cents: 0n, payment_method: "CODI", payable_type: "API_CODI_QR", payable_id: "QR9", date_paid: NOW, payer_clabe: null, tracking_key: null, external_metadata: {} });
    const [raw, h] = webhook({ type: "codi.qr.payment_received", transactionId: "01X", amount: 50 });
    await f.svc.handlePeyWebhook(raw, h);
    expect(await ledgerBalance(f.db, M, "1300")).toBe(5000n);
  });

  it("política de recordatorios: cliente sin opt-in o fuera de horario", async () => {
    await f.svc.handleMerchantMessage("Chela se llevó $50");
    await f.svc.confirm(await f.lastAction());
    await f.svc.handleMerchantMessage("Cóbrale a Chela");
    // Sin permiso de mensajes ni siquiera se pregunta: se explica por qué no sale el cobro.
    const last = (await f.msgs()).at(-1)!;
    expect(last.body).toMatch(/no ha aceptado recibir mensajes/);
    expect(last.actions?.some((a) => a.kind === "confirm") ?? false).toBe(false);
    expect((f.gw as FakePey).pushes).toHaveLength(0);
  });
});

describe("clientes nuevos y montos con letra", () => {
  it("fiado a un nombre desconocido: un Confirmar da de alta y anota el fiado", async () => {
    const f = await setup();
    await f.svc.handleMerchantMessage("El señor Joel se llevó cinco pesos");
    expect((await f.msgs()).at(-1)!.body).toMatch(/No tengo a “Señor Joel”.*¿Lo doy de alta y le anoto \$5\.00/);
    await f.svc.confirm(await f.lastAction());
    const [joel] = await f.db.select().from(schema.customers).where(eq(schema.customers.name, "Señor Joel"));
    expect(joel).toMatchObject({ phone: null, optIn: false });
    expect(await ledgerBalance(f.db, M, "1200", joel!.id)).toBe(500n);
    expect((await f.msgs()).at(-1)!.body).toMatch(/di de alta a Señor Joel.*Te debe \$5\.00.*QR para Señor Joel/);
    // Un segundo clic no duplica ni al cliente ni el fiado.
    await f.svc.confirm(await f.lastAction());
    expect(await f.db.select().from(schema.customers).where(eq(schema.customers.name, "Señor Joel"))).toHaveLength(1);
    expect(await ledgerBalance(f.db, M, "1200", joel!.id)).toBe(500n);
  });

  it("“Agrega a Rosa, 55…” da de alta con celular; si ya existe, lo dice", async () => {
    const f = await setup();
    await f.svc.handleMerchantMessage("Agrega a Rosa, 55 9876 5432");
    expect((await f.msgs()).at(-1)!.body).toMatch(/Doy de alta a Rosa con celular 55 9876 5432/);
    await f.svc.confirm(await f.lastAction());
    const [rosa] = await f.db.select().from(schema.customers).where(eq(schema.customers.name, "Rosa"));
    expect(rosa!.phone).toBe("+525598765432");
    await f.svc.handleMerchantMessage("Agrega a Doña Lupe");
    expect((await f.msgs()).at(-1)!.body).toMatch(/Ya tengo a Doña Lupe/);
  });

  it("alta: solo el mismo nombre es duplicado; uno parecido se avisa y se puede agregar", async () => {
    const f = await setup();
    await f.svc.handleMerchantMessage("Agrega a Lupe Hernández, 5587650001");
    expect((await f.msgs()).at(-1)!.body).toMatch(/Doy de alta a Lupe Hernández con celular 55 8765 0001\. Ya tienes a «Doña Lupe»: si es la misma persona, toca «No»\. ¿Confirmas\?/);
    await f.svc.confirm(await f.lastAction());
    expect(await f.db.select().from(schema.customers).where(eq(schema.customers.name, "Lupe Hernández"))).toHaveLength(1);
    // El nombre se guarda como se escribió ("La Güera" no se vuelve "Güera") y no se acepta solo un trato.
    await f.svc.handleMerchantMessage("Agrega a La Güera");
    expect((await f.msgs()).at(-1)!.body).toMatch(/Doy de alta a La Güera/);
    await f.svc.handleMerchantMessage("Agrega a La Doña");
    expect((await f.msgs()).at(-1)!.body).toMatch(/Escribe el nombre de tu cliente, no solo «La Doña»/);
  });

  it("al confirmar un alta con fiado nunca se usa un cliente parecido (el fiado no se va a otra persona)", async () => {
    const f = await setup();
    await f.svc.handleMerchantMessage("Nico Zavala se llevó $30");
    const nico = await f.lastAction();
    await f.svc.handleMerchantMessage("Agrega a Paco Zavala");
    await f.svc.confirm(await f.lastAction());
    await f.svc.confirm(nico);
    const [n] = await f.db.select().from(schema.customers).where(eq(schema.customers.name, "Nico Zavala"));
    const [pz] = await f.db.select().from(schema.customers).where(eq(schema.customers.name, "Paco Zavala"));
    expect(n).toBeDefined();
    expect(await ledgerBalance(f.db, M, "1200", n!.id)).toBe(3000n);
    expect(await ledgerBalance(f.db, M, "1200", pz!.id)).toBe(0n);
    // Confirmar otra vez la misma pregunta no hace nada y lo dice.
    await f.svc.confirm(nico);
    expect((await f.msgs()).at(-1)!.body).toMatch(/Eso ya quedó hecho/);
    expect(await ledgerBalance(f.db, M, "1200", n!.id)).toBe(3000n);
    await f.svc.cancel(nico);
    expect((await f.msgs()).at(-1)!.body).toMatch(/Ya no se puede cancelar: eso ya quedó hecho/);
  });

  it("QR o cobro a un desconocido: ofrece darlo de alta con un botón", async () => {
    const f = await setup();
    await f.svc.handleMerchantMessage("QR para Pedro");
    const m = (await f.msgs()).at(-1)!;
    expect(m.body).toMatch(/No tengo a “Pedro”.*Agrega a Pedro/);
    expect(m.actions![0]).toMatchObject({ kind: "say", text: "Agrega a Pedro" });
  });
});

describe("QR en mostrador y un solo cobro abierto", () => {
  it("QR por el saldo; mientras esté abierto no se emite otro cobro; el pago lo cierra", async () => {
    const f = await setup();
    await f.svc.handleMerchantMessage("Doña Lupe se llevó $185");
    await f.svc.confirm(await f.lastAction());
    await f.svc.handleMerchantMessage("QR para Doña Lupe");
    const gw = f.gw as FakePey;
    expect(gw.qrs[0]).toMatchObject({ amount_cents: 18500n, metadata: { cuadra_charge_id: expect.stringMatching(/^ch_/) } });
    const msg = (await f.msgs()).at(-1)!;
    expect(msg.actions?.[0]).toMatchObject({ kind: "qr", url: expect.stringMatching(/^data:image\/png;base64,/) });

    await f.svc.handleMerchantMessage("QR para Doña Lupe");
    expect((await f.msgs()).at(-1)!.body).toMatch(/ya tiene un QR abierto de \$185\.00 \(ref\. \d{7}\) que vence hoy a las 11:32/);
    await f.svc.handleMerchantMessage("Cóbrale a Doña Lupe");
    const last = (await f.msgs()).at(-1)!;
    expect(last.body).toMatch(/ya tiene un QR abierto/);
    expect(last.actions ?? []).toHaveLength(0); // no pide "Confirmar" para algo que no va a salir
    expect(gw.pushes).toHaveLength(0);

    const qrTx = [...gw.txs.keys()][0]!;
    gw.pay(qrTx);
    const [raw, h] = webhook({ type: "codi.qr.payment_received", transactionId: qrTx, amount: 185, codiQrId: "X" });
    await f.svc.handlePeyWebhook(raw, h);
    expect(await ledgerBalance(f.db, M, "1200", "c_lupe")).toBe(0n);
  });

  it("“Cóbrale” otra vez con la solicitud viva no manda otra: se reenvía solo cuando venció (decisión 14-nov)", async () => {
    const f = await setup();
    const gw = f.gw as FakePey;
    await f.svc.handleMerchantMessage("Doña Lupe se llevó $10");
    await f.svc.confirm(await f.lastAction());
    await f.svc.handleMerchantMessage("Cóbrale a Doña Lupe");
    await f.svc.confirm(await f.lastAction());
    await f.svc.handleMerchantMessage("Cóbrale a Doña Lupe");
    const last = (await f.msgs()).at(-1)!;
    expect(last.body).toMatch(/ya tiene una solicitud CoDi abierta de \$10\.00/);
    expect(last.body).toMatch(/cuando venza pídeme “vuélvele a mandar la notificación” y se la reenvío \(reenvío 1 de 3\)/);
    expect(last.actions ?? []).toHaveLength(0);
    expect(gw.pushes).toHaveLength(1);
    const charges = await f.db.select().from(schema.charges).where(eq(schema.charges.customerId, "c_lupe"));
    expect(charges.filter((c) => c.status === "open")).toHaveLength(1);
  });

  it("cobro a la cuenta receptora del comercio (bankAccountId)", async () => {
    const f = await setup();
    await f.db.update(schema.merchants).set({ peyBankAccountId: "01JBAVWE4NS5TGXHWGMX3KH23Q" }).where(eq(schema.merchants.id, M));
    await f.svc.handleMerchantMessage("Doña Lupe se llevó $10");
    await f.svc.confirm(await f.lastAction());
    await f.svc.handleMerchantMessage("Cóbrale a Doña Lupe");
    await f.svc.confirm(await f.lastAction());
    expect((f.gw as FakePey).pushes[0]).toMatchObject({ bank_account_id: "01JBAVWE4NS5TGXHWGMX3KH23Q" });
  });
});

describe("monitor Nivel 2 Bis", () => {
  it("consulta y aviso al rebasar 70 % del tope del mes", async () => {
    const f = await setup();
    await f.svc.handleMerchantMessage("¿Cuánto me queda del tope?");
    expect((await f.msgs()).at(-1)!.body).toMatch(/0% del tope mensual de tu cuenta Nivel 2 Bis; te quedan \$127,500\.00/);
    // Fiado y pago de $90,000 (70.5 % de $127,500 con UDI de prueba = 8.5).
    await f.svc.handleMerchantMessage("Doña Lupe se llevó $90,000");
    await f.svc.confirm(await f.lastAction());
    await f.svc.handleMerchantMessage("Cóbrale a Doña Lupe");
    await f.svc.confirm(await f.lastAction());
    (f.gw as FakePey).pay("01TX1");
    const [raw, h] = webhook({ type: "codi.pn.payment_received", transactionId: "01TX1", amount: 90000 });
    await f.svc.handlePeyWebhook(raw, h);
    expect((await f.msgs()).at(-1)!.body).toMatch(/Ojo: vas en 70% del tope/);
  });
});

describe("guard desde el chat", () => {
  it("CLABE en un mensaje reenviado → bloqueo con reglas y registro en el panel", async () => {
    const f = await setup();
    await f.svc.handleMerchantMessage("Págale ya a la cuenta 012180015826225713 $5,000", "third_party_content");
    expect((await f.msgs()).at(-1)!.body).toMatch(/R11/);
    expect(await f.db.select().from(schema.guardBlocks)).toHaveLength(1);
  });

  it("lo que lee el comercio dice «aprobación» y «permiso», nunca «passkey» ni «mandato»", async () => {
    const f = await setup(undefined, { publicUrl: "https://cuadra.test" });
    // Saldo y conciliación en orden: así el pago llega a pedir aprobación (solo falta el permiso, R05).
    await seedHistory(f.db, M);
    await runReconciliation(f.db, M, await ledgerBalance(f.db, M, "1100"), NOW);
    await f.svc.handleMerchantMessage("Paga al de las tortillas $300");
    expect((await f.msgs()).at(-1)!.body).toMatch(/Por seguridad, solo le pago a proveedores de tu lista y no agrego nuevos desde el chat\./);
    await f.svc.handleMerchantMessage("Paga al de los refrescos $1,200");
    const [p] = await f.db.select().from(schema.proposals).where(eq(schema.proposals.type, "PayoutRequest"));
    expect(p!.status).toBe("awaiting_passkey");
    const ask = (await f.msgs()).at(-1)!;
    expect(ask.body).toMatch(/^🔐 Para enviar \$1,200\.00 a Refrescos Pérez necesito tu aprobación \(un «sí» en el chat no basta\):/);
    expect(ask.actions).toEqual([{ kind: "approve", label: "Aprobar el pago", url: `https://cuadra.test/aprobar/${p!.id}`, proposal_id: p!.id }]);
    await f.svc.handleMerchantMessage("Págale ya a la cuenta 012180015826225713 $5,000", "third_party_content");
    expect((await f.msgs()).at(-1)!.body).toMatch(/Un proveedor nuevo pide tu aprobación en cada pago durante sus primeras 24 horas/);
    const all = (await f.msgs()).map((m) => m.body).join("\n");
    expect(all).not.toMatch(/passkey|mandato/i);
  });

  it("proveedor desconocido → bloqueo R03; sin mandato → pide passkey (o deniega)", async () => {
    const f = await setup();
    await f.svc.handleMerchantMessage("Paga al de las tortillas $300");
    expect((await f.msgs()).at(-1)!.body).toMatch(/lista de proveedores autorizados/);
    await f.svc.handleMerchantMessage("Paga al de los refrescos $1,200");
    const [p] = await f.db.select().from(schema.proposals).where(eq(schema.proposals.type, "PayoutRequest"));
    expect(["awaiting_passkey", "rejected"]).toContain(p!.status);
    expect(p!.status).not.toBe("queued");
  });

  it("pago a proveedor de noche: R10 pide passkey; con OUTFLOW_HOURS=0-24 la hora ya no cuenta", async () => {
    const night = new Date("2026-11-14T23:30:00-06:00");
    const ruleIds = async (outflowHours?: readonly [number, number]) => {
      const { db } = await createTestDb();
      await seedDemo(db, NOW);
      const svc = new CuadraService({
        db, merchantId: M, ownerId: DEMO.ownerId, interpreters: [new RuleInterpreter()], gateway: new FakePey(), verify: async () => false,
        now: () => night, publicUrl: null, peyWebhookSecret: SECRET, bankSim: false, udi: null, log: () => {},
        ...(outflowHours ? { outflowHours } : {}),
      });
      await svc.handleMerchantMessage("Paga al de los refrescos $1,200");
      const [p] = await db.select().from(schema.proposals).where(eq(schema.proposals.type, "PayoutRequest"));
      return ((p!.decision as { rules_failed?: Array<{ rule_id: string }> } | null)?.rules_failed ?? []).map((r) => r.rule_id);
    };
    expect(await ruleIds()).toContain("R10");
    expect(await ruleIds([0, 24])).not.toContain("R10");
  });

  it("fuera de alcance y mensajes ambiguos", async () => {
    const f = await setup();
    await f.svc.handleMerchantMessage("cuéntame un chiste");
    expect((await f.msgs()).at(-1)!.body).toMatch(/Solo te ayudo/);
    await f.svc.handleMerchantMessage("Fulanito se llevó $10");
    expect((await f.msgs()).at(-1)!.body).toMatch(/No tengo a/);
  });
});

describe("modo simulado", () => {
  it("el botón del cliente paga por el mismo camino que pey", async () => {
    const f = await setup((db) => new SimulatedGateway(db));
    await f.svc.handleMerchantMessage("Doña Lupe se llevó $185");
    await f.svc.confirm(await f.lastAction());
    await f.svc.handleMerchantMessage("Cóbrale a Doña Lupe");
    await f.svc.confirm(await f.lastAction());
    const [ch] = await f.db.select().from(schema.charges).where(eq(schema.charges.customerId, "c_lupe"));
    await f.svc.simulatePaid(ch!.providerChargeId!);
    await f.svc.simulatePaid(ch!.providerChargeId!);
    expect(await ledgerBalance(f.db, M, "1100")).toBe(18500n);
  });

  it("sin cuenta conectada, un cliente nuevo (sin permiso de mensajes) también recibe su cobro: no sale nada real", async () => {
    const f = await setup((db) => new SimulatedGateway(db));
    await f.svc.handleMerchantMessage("Agrega a Rosa, 5598765432");
    await f.svc.confirm(await f.lastAction());
    await f.svc.handleMerchantMessage("Rosa se llevó $40");
    await f.svc.confirm(await f.lastAction());
    await f.svc.handleMerchantMessage("Cóbrale a Rosa");
    await f.svc.confirm(await f.lastAction());
    const m = (await f.msgs()).at(-1)!;
    expect(m.body).toMatch(/Preparé el cobro de \$40\.00 para Rosa/);
    expect(m.body).not.toMatch(/simulad/i);
    // A Rosa no se le manda ningún mensaje (no ha aceptado recibirlos).
    const [rosa] = await f.db.select().from(schema.customers).where(eq(schema.customers.name, "Rosa"));
    expect((await f.msgs(rosa!.id)).some((x) => x.actions?.some((a) => a.kind === "pay" && a.label === "Pagar como Rosa"))).toBe(true);
  });
});

describe("celulares ficticios de la demo", () => {
  it("con pey en vivo, nunca se manda cobro a un número que no existe (empieza con 0)", async () => {
    const { db } = await createTestDb();
    await seedDemo(db, NOW); // sin DEMO_CUSTOMER_PHONE: Doña Lupe tiene +520000000101
    const gw = new FakePey();
    const svc = new CuadraService({
      db, merchantId: M, ownerId: DEMO.ownerId, interpreters: [new RuleInterpreter()], gateway: gw,
      verify: async () => false, now: () => NOW, publicUrl: null, peyWebhookSecret: null, bankSim: false, udi: null, log: () => {},
    });
    const lastAct = async () => (await db.select().from(schema.messages).orderBy(schema.messages.id)).filter((m) => m.actions?.length).at(-1)!.actions![0]!.proposal_id!;
    await svc.handleMerchantMessage("Doña Lupe se llevó $10");
    await svc.confirm(await lastAct());
    await svc.handleMerchantMessage("Cóbrale a Doña Lupe");
    await svc.confirm(await lastAct());
    expect(gw.pushes).toHaveLength(0);
    const msgs = await db.select().from(schema.messages).where(eq(schema.messages.thread, "comercio")).orderBy(schema.messages.id);
    expect(msgs.at(-1)!.body).toMatch(/no tiene un celular válido para CoDi/);
  });
});

describe("canales de salida", () => {
  it("cada mensaje se entrega al celular de su conversación; un canal caído no rompe el flujo", async () => {
    const { db } = await createTestDb();
    await seedDemo(db, NOW, { lupePhone: "+525512345678", ownerPhone: "+525587654321" });
    const sent: Array<{ phone10: string; thread: string; body: string; actions: unknown[] }> = [];
    const svc = new CuadraService({
      db, merchantId: M, ownerId: DEMO.ownerId, interpreters: [new RuleInterpreter()], gateway: new FakePey(),
      verify: async () => false, now: () => NOW, publicUrl: null, peyWebhookSecret: null, bankSim: false, udi: null,
      channels: [
        { name: "ok", send: async (m) => { sent.push(m); } },
        { name: "caido", send: async () => { throw new Error("sin red"); } },
      ],
      log: () => {},
    });
    await svc.handleMerchantMessage("Doña Lupe se llevó $185");
    expect(sent.at(-1)).toMatchObject({ phone10: "5587654321", thread: "comercio", actions: [{ kind: "confirm" }, { kind: "cancel" }] });
    const pid = (sent.at(-1)!.actions[0] as { proposal_id: string }).proposal_id;
    await svc.confirm(pid);
    await svc.handleMerchantMessage("Cóbrale a Doña Lupe");
    await svc.confirm((sent.at(-1)!.actions[0] as { proposal_id: string }).proposal_id);
    expect(sent.some((m) => m.thread === "c_lupe" && m.phone10 === "5512345678" && /Te saludamos/.test(m.body))).toBe(true);
  });
});
