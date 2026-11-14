import { fiado } from "@cuadra/core";
import { beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../src/client.js";
import { identifyDeposit, recordDeposit, unidentifiedDeposits } from "../src/deposits.js";
import { ledgerBalance, postEntries } from "../src/ledger-repo.js";
import { clearReconciliationFreeze, runReconciliation } from "../src/reconciliation.js";
import { DEMO, seedDemo } from "../src/seed.js";
import { schema } from "../src/index.js";
import { createTestDb } from "../src/testing.js";
import { applyProviderEvent, UnknownTransferError } from "../src/webhooks.js";
import { eq } from "drizzle-orm";

let db: Db;
const M = DEMO.merchantId;
const { rosa, beto, chela } = DEMO.customers;
const NOW = new Date("2026-11-14T12:00:00-06:00");

beforeEach(async () => {
  ({ db } = await createTestDb());
  await seedDemo(db, NOW);
  await postEntries(db, [
    fiado({ merchant_id: M, idempotency_key: "f-rosa", amount: 8000n, customer_id: rosa.id }),
    fiado({ merchant_id: M, idempotency_key: "f-beto", amount: 3000n, customer_id: beto.id }),
    fiado({ merchant_id: M, idempotency_key: "f-chela", amount: 45000n, customer_id: chela.id }),
  ]);
});

describe("abonos SPEI", () => {
  it("1. CLABE virtual → abono a Rosa, excedente a saldo a favor", async () => {
    const r = await recordDeposit(db, M, { clave_rastreo: "CR1", amount: 10000n, destination_clabe: rosa.virtualClabe });
    expect(r).toMatchObject({ duplicate: false, match: { matched: true, customer_id: rosa.id, method: "virtual_clabe" } });
    expect(await ledgerBalance(db, M, "1200", rosa.id)).toBe(0n);
    expect(await ledgerBalance(db, M, "2100", rosa.id)).toBe(2000n);
  });

  it("2. CLABE ordenante ligada → Beto", async () => {
    const r = await recordDeposit(db, M, { clave_rastreo: "CR2", amount: 1000n, ordering_clabe: beto.orderingClabe });
    expect(r.match).toMatchObject({ customer_id: beto.id, method: "ordering_clabe" });
    expect(await ledgerBalance(db, M, "1200", beto.id)).toBe(2000n);
  });

  it("3/4. referencia o centavos únicos → Chela; el cobro se cierra al saldar", async () => {
    const a = await recordDeposit(db, M, { clave_rastreo: "CR3", amount: 20000n, concept: "abono 4815162" });
    expect(a.match).toMatchObject({ customer_id: chela.id, method: "reference" });
    const [open] = await db.select().from(schema.charges).where(eq(schema.charges.id, "ch_chela_1"));
    expect(open!.status).toBe("open");
    const b = await recordDeposit(db, M, { clave_rastreo: "CR4", amount: 45017n });
    expect(b.match).toMatchObject({ customer_id: chela.id, method: "unique_amount" });
    const [paid] = await db.select().from(schema.charges).where(eq(schema.charges.id, "ch_chela_1"));
    expect(paid!.status).toBe("paid");
  });

  it("5. sin coincidencia → 1300 y cola de revisión; identificar lo mueve a CxC", async () => {
    const r = await recordDeposit(db, M, { clave_rastreo: "CR5", amount: 500n, concept: "pago" });
    expect(r.match).toMatchObject({ matched: false, account: "1300" });
    expect(await ledgerBalance(db, M, "1300")).toBe(500n);
    expect((await unidentifiedDeposits(db, M)).map((d) => d.claveRastreo)).toEqual(["CR5"]);

    await identifyDeposit(db, M, "CR5", rosa.id);
    expect(await ledgerBalance(db, M, "1300")).toBe(0n);
    expect(await ledgerBalance(db, M, "1200", rosa.id)).toBe(7500n);
    expect(await unidentifiedDeposits(db, M)).toEqual([]);
    await expect(identifyDeposit(db, M, "CR5", rosa.id)).rejects.toThrow(/ya está identificado/);
    await expect(identifyDeposit(db, M, "NOEXISTE", rosa.id)).rejects.toThrow();
    await recordDeposit(db, M, { clave_rastreo: "CR6", amount: 1n });
    await expect(identifyDeposit(db, M, "CR6", "c_otro")).rejects.toThrow(/Cliente/);
  });

  it("idempotente por clave_rastreo; misma clave con otro monto es error", async () => {
    await recordDeposit(db, M, { clave_rastreo: "CR1", amount: 1000n, destination_clabe: rosa.virtualClabe });
    const again = await recordDeposit(db, M, { clave_rastreo: "CR1", amount: 1000n, destination_clabe: rosa.virtualClabe });
    expect(again).toMatchObject({ duplicate: true, match: { customer_id: rosa.id } });
    expect(await ledgerBalance(db, M, "1100")).toBe(1000n);
    await expect(recordDeposit(db, M, { clave_rastreo: "CR1", amount: 9999n })).rejects.toThrow(/repetida/);
    await recordDeposit(db, M, { clave_rastreo: "CRX", amount: 5n });
    expect(await recordDeposit(db, M, { clave_rastreo: "CRX", amount: 5n })).toMatchObject({ duplicate: true, match: { matched: false } });
  });

  it("webhook de depósito: una sola vez por event_id; transferencia desconocida revierte todo", async () => {
    const ev = { type: "deposit.received" as const, event_id: "e1", clave_rastreo: "CR9", amount_cents: 700n };
    expect(await applyProviderEvent(db, "mock", M, ev)).toMatchObject({ status: "deposit" });
    expect(await applyProviderEvent(db, "mock", M, ev)).toEqual({ status: "duplicate" });
    const unknown = { type: "transfer.confirmed" as const, event_id: "e2", provider_ref: "nope" };
    await expect(applyProviderEvent(db, "mock", M, unknown)).rejects.toThrow(UnknownTransferError);
    // El evento no quedó registrado: el reintento del proveedor vuelve a intentarlo.
    await expect(applyProviderEvent(db, "mock", M, unknown)).rejects.toThrow(UnknownTransferError);
  });
});

describe("conciliación", () => {
  it("cuadra, descuadra (congela) y solo se descongela a mano", async () => {
    await recordDeposit(db, M, { clave_rastreo: "CR1", amount: 1000n });
    expect((await runReconciliation(db, M, 1000n, NOW)).ok).toBe(true);
    const bad = await runReconciliation(db, M, 999n, NOW);
    expect(bad).toMatchObject({ ok: false, difference: 1n, freeze_outflows: true });
    const risk = async () => (await db.select().from(schema.riskState).where(eq(schema.riskState.merchantId, M)))[0]!;
    expect((await risk()).reconciliationMismatch).toBe(true);
    await runReconciliation(db, M, 1000n, NOW);
    expect((await risk()).reconciliationMismatch).toBe(true);
    await clearReconciliationFreeze(db, M);
    expect((await risk()).reconciliationMismatch).toBe(false);
  });
});
