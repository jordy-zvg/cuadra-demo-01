import { SoftAuthenticator } from "@cuadra/adapters/testing";
import { DEMO, ledgerBalance, runReconciliation, schema, setKillSwitch } from "@cuadra/db";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { decideAndReserve, executeOutflow, submit } from "../src/execute.js";
import { NOW, RP, setup } from "./fixture.js";

const proposalStatus = async (db: Awaited<ReturnType<typeof setup>>["db"], id: string) =>
  (await db.select().from(schema.proposals).where(eq(schema.proposals.id, id)))[0]!.status;

describe("executor: camino feliz con mandato", () => {
  it("envía, deja 2400 en tránsito y la confirmación cierra contra 1100", async () => {
    const f = await setup();
    await f.mandate();
    const p = await f.payout(150_000);
    const r = await executeOutflow({ proposal_id: p.id }, f.deps);
    expect(r.status).toBe("sent");
    expect(f.provider.calls).toHaveLength(1);
    expect(f.provider.calls[0]).toMatchObject({ clabe: DEMO.payees.refrescos.clabe, amount_cents: 150_000n, idempotency_key: `proposal:${p.id}` });
    expect(await ledgerBalance(f.db, f.M, "5100")).toBe(150_000n);
    expect(await ledgerBalance(f.db, f.M, "2400")).toBe(150_000n);
    expect(await ledgerBalance(f.db, f.M, "1100")).toBe(1_000_000n);

    // Mientras está en vuelo, la conciliación cuadra descontando lo enviado.
    expect((await runReconciliation(f.db, f.M, await f.provider.getBalance(), NOW)).ok).toBe(true);

    const ref = r.status === "sent" ? r.provider_ref : "";
    const w = f.provider.settle(ref, "confirmed");
    expect(await f.webhook(w)).toMatchObject({ status: "transfer_confirmed" });
    expect(await f.webhook(w)).toEqual({ status: "duplicate" });
    expect(await ledgerBalance(f.db, f.M, "2400")).toBe(0n);
    expect(await ledgerBalance(f.db, f.M, "1100")).toBe(850_000n);
    expect(await proposalStatus(f.db, p.id)).toBe("done");
    expect((await runReconciliation(f.db, f.M, await f.provider.getBalance(), NOW)).ok).toBe(true);
    expect(f.logs[0]).toMatchObject({ proposal_id: p.id, merchant_id: f.M, idempotency_key: `proposal:${p.id}`, status: "sent" });
  });

  it("reprocesar el mismo trabajo no paga dos veces", async () => {
    const f = await setup();
    await f.mandate();
    const p = await f.payout(10_000);
    await executeOutflow({ proposal_id: p.id }, f.deps);
    expect(await executeOutflow({ proposal_id: p.id }, f.deps)).toMatchObject({ status: "noop" });
    expect(f.provider.calls).toHaveLength(1);
    expect(await ledgerBalance(f.db, f.M, "2400")).toBe(10_000n);
  });

  it("rechaza trabajos con campos extra (la cola solo lleva proposal_id)", async () => {
    const f = await setup();
    await expect(executeOutflow({ proposal_id: "x", amount_cents: 1 }, f.deps)).rejects.toThrow();
  });
});

describe("executor: aprobación con passkey", () => {
  it("sin mandato ni aprobación → awaiting_passkey y el proveedor no se toca", async () => {
    const f = await setup();
    const p = await f.payout(10_000);
    const r = await executeOutflow({ proposal_id: p.id }, f.deps);
    expect(r).toMatchObject({ status: "awaiting_passkey", decision: { rules_failed: [{ rule_id: "R05" }] } });
    expect(await proposalStatus(f.db, p.id)).toBe("awaiting_passkey");
    expect(f.provider.calls).toHaveLength(0);
  });

  it("aprobación ligada al hash exacto → envía y se consume", async () => {
    const f = await setup();
    const p = await f.payout(10_000);
    const approvalId = await f.approve(p.id, p.proposalHash);
    expect(await executeOutflow({ proposal_id: p.id }, f.deps)).toMatchObject({ status: "sent" });
    const [a] = await f.db.select().from(schema.approvals).where(eq(schema.approvals.id, approvalId));
    expect(a!.usedAt).not.toBeNull();
    const [t] = await f.db.select().from(schema.transfers);
    expect(t).toMatchObject({ approvalId, mandateId: null });
  });

  it("aprobación firmada sobre otra propuesta no sirve", async () => {
    const f = await setup();
    const p = await f.payout(10_000);
    const other = await f.payout(99_999);
    await f.approve(p.id, other.proposalHash);
    expect(await executeOutflow({ proposal_id: p.id }, f.deps)).toMatchObject({ status: "awaiting_passkey" });
  });

  it("aprobación de una credencial ajena o vencida no sirve", async () => {
    const f = await setup();
    const p = await f.payout(10_000);
    const impostor = new SoftAuthenticator(RP.rpID, RP.origins[0]!, { id: f.auth.credentialId });
    await f.approve(p.id, p.proposalHash, impostor);
    expect(await executeOutflow({ proposal_id: p.id }, f.deps)).toMatchObject({ status: "awaiting_passkey" });

    const q = await f.payout(20_000);
    await f.approve(q.id, q.proposalHash);
    f.setNow(new Date(NOW.getTime() + 11 * 60_000));
    expect(await executeOutflow({ proposal_id: q.id }, f.deps)).toMatchObject({ status: "awaiting_passkey" });
    expect(f.provider.calls).toHaveLength(0);
  });

  it("contenido de terceros requiere passkey aunque haya mandato", async () => {
    const f = await setup();
    await f.mandate();
    const p = await f.payout(10_000, { provenance: "third_party_content" });
    expect(await executeOutflow({ proposal_id: p.id }, f.deps)).toMatchObject({
      status: "awaiting_passkey",
      decision: { rules_failed: [{ rule_id: "R11" }] },
    });
  });
});

describe("executor: manipulación de la DB", () => {
  it("payload alterado después de guardar → rechazo por integridad", async () => {
    const f = await setup();
    await f.mandate();
    const p = await f.payout(10_000);
    await f.pg.exec(`UPDATE proposals SET payload = jsonb_set(payload, '{amount_cents}', '"999999"') WHERE id = '${p.id}'`);
    expect(await executeOutflow({ proposal_id: p.id }, f.deps)).toMatchObject({ status: "rejected", decision: { integrity_error: expect.any(String) } });
    expect(f.provider.calls).toHaveLength(0);
  });

  it("topes del mandato alterados en la DB → el mandato deja de valer", async () => {
    const f = await setup();
    const mandateId = await f.mandate({ per_op_cap_cents: 5_000 });
    await f.pg.exec(`UPDATE mandates SET per_op_cap_cents = 900000 WHERE id = '${mandateId}'`);
    const p = await f.payout(10_000);
    expect(await executeOutflow({ proposal_id: p.id }, f.deps)).toMatchObject({
      status: "awaiting_passkey",
      decision: { rules_failed: [{ rule_id: "R05" }] },
    });
  });

  it("mismo pago repetido en 10 min → deny (R09); después de 10 min pasa", async () => {
    const f = await setup();
    await f.mandate();
    const a = await f.payout(10_000);
    expect(await executeOutflow({ proposal_id: a.id }, f.deps)).toMatchObject({ status: "sent" });
    f.setNow(new Date(NOW.getTime() + 5 * 60_000));
    const b = await f.payout(10_000, { concept: " refrescos " });
    expect(await executeOutflow({ proposal_id: b.id }, f.deps)).toMatchObject({
      status: "rejected",
      decision: { rules_failed: [{ rule_id: "R09" }] },
    });
    f.setNow(new Date(NOW.getTime() + 11 * 60_000));
    const c = await f.payout(10_000);
    expect(await executeOutflow({ proposal_id: c.id }, f.deps)).toMatchObject({ status: "sent" });
  });

  it("mandato excedido en el periodo pide passkey", async () => {
    const f = await setup();
    await f.mandate({ period_cap_cents: 15_000 });
    const a = await f.payout(10_000);
    expect(await executeOutflow({ proposal_id: a.id }, f.deps)).toMatchObject({ status: "sent" });
    const b = await f.payout(10_000, { concept: "Otra entrega" });
    expect(await executeOutflow({ proposal_id: b.id }, f.deps)).toMatchObject({
      status: "awaiting_passkey",
      decision: { rules_failed: [{ rule_id: "R07" }] },
    });
  });
});

describe("executor: riesgo, saldo y fallas", () => {
  it("kill switch → rechazo sin llamar al proveedor", async () => {
    const f = await setup();
    await f.mandate();
    await f.db.update(schema.riskState).set({ killSwitch: true }).where(eq(schema.riskState.merchantId, f.M));
    const p = await f.payout(10_000);
    expect(await executeOutflow({ proposal_id: p.id }, f.deps)).toMatchObject({
      status: "rejected",
      decision: { rules_failed: [{ rule_id: "R12" }] },
    });
    expect(f.provider.calls).toHaveLength(0);
  });

  it("freno global → rechazo en todos los comercios; al quitarlo vuelve a pagar", async () => {
    const f = await setup();
    await f.mandate();
    await setKillSwitch(f.db, { global: true }, true);
    const p = await f.payout(10_000);
    expect(await executeOutflow({ proposal_id: p.id }, f.deps)).toMatchObject({
      status: "rejected",
      decision: { rules_failed: [{ rule_id: "R12" }] },
    });
    await setKillSwitch(f.db, { global: true }, false);
    const q = await f.payout(10_000, { concept: "Otra" });
    expect(await executeOutflow({ proposal_id: q.id }, f.deps)).toMatchObject({ status: "sent" });
  });

  it("freno global entre la reserva y el envío → falla sin llamar al proveedor", async () => {
    const f = await setup();
    await f.mandate();
    const p = await f.payout(10_000);
    const phase1 = await decideAndReserve({ proposal_id: p.id }, f.deps);
    if (phase1.kind !== "submit") throw new Error("se esperaba reserva");
    await setKillSwitch(f.db, { global: true }, true);
    expect((await submit(phase1.transfer, f.deps)).status).toBe("failed");
    expect(f.provider.calls).toHaveLength(0);
  });

  it("kill switch entre la reserva y el envío → falla y se reversa", async () => {
    const f = await setup();
    await f.mandate();
    const p = await f.payout(10_000);
    const phase1 = await decideAndReserve({ proposal_id: p.id }, f.deps);
    if (phase1.kind !== "submit") throw new Error("se esperaba reserva");
    await f.db.update(schema.riskState).set({ killSwitch: true }).where(eq(schema.riskState.merchantId, f.M));
    const r = await submit(phase1.transfer, f.deps);
    expect(r.status).toBe("failed");
    expect(f.provider.calls).toHaveLength(0);
    expect(await ledgerBalance(f.db, f.M, "2400")).toBe(0n);
    expect(await ledgerBalance(f.db, f.M, "5100")).toBe(0n);
  });

  it("saldo comprometido: la segunda salida no cabe (R08)", async () => {
    const f = await setup({ funded: 100_000n });
    await runReconciliation(f.db, f.M, await f.provider.getBalance(), NOW);
    await f.mandate();
    const a = await f.payout(70_000);
    expect(await executeOutflow({ proposal_id: a.id }, f.deps)).toMatchObject({ status: "sent" });
    const b = await f.payout(70_000, { concept: "Otra" });
    expect(await executeOutflow({ proposal_id: b.id }, f.deps)).toMatchObject({
      status: "rejected",
      decision: { rules_failed: [{ rule_id: "R08" }] },
    });
  });

  it("el proveedor rechaza → transferencia fallida y asiento reversado", async () => {
    const f = await setup();
    await f.mandate();
    f.provider.failNextTransfer("Cuenta destino cancelada");
    const p = await f.payout(10_000);
    expect(await executeOutflow({ proposal_id: p.id }, f.deps)).toMatchObject({ status: "failed", reason: "Cuenta destino cancelada" });
    expect(await ledgerBalance(f.db, f.M, "2400")).toBe(0n);
    expect(await proposalStatus(f.db, p.id)).toBe("rejected");
  });

  it("caída del proveedor: el trabajo lanza, y al reintentar se envía una sola vez", async () => {
    const f = await setup();
    await f.mandate();
    const p = await f.payout(10_000);
    f.provider.setOutage(true);
    await expect(executeOutflow({ proposal_id: p.id }, f.deps)).rejects.toThrow();
    // Ya se intentó: aunque se active el kill switch, no se cancela (pudo haber salido).
    await f.db.update(schema.riskState).set({ killSwitch: true }).where(eq(schema.riskState.merchantId, f.M));
    f.provider.setOutage(false);
    expect(await executeOutflow({ proposal_id: p.id }, f.deps)).toMatchObject({ status: "sent" });
    expect(await executeOutflow({ proposal_id: p.id }, f.deps)).toMatchObject({ status: "noop" });
    expect(f.provider.calls.filter((c) => c.idempotency_key === `proposal:${p.id}`)).toHaveLength(2);
    expect(await f.provider.getBalance()).toBe(990_000n);
  });

  it("webhook de fallo después del envío → reverso; el saldo vuelve", async () => {
    const f = await setup();
    await f.mandate();
    const p = await f.payout(10_000);
    const r = await executeOutflow({ proposal_id: p.id }, f.deps);
    const ref = r.status === "sent" ? r.provider_ref : "";
    expect(await f.webhook(f.provider.settle(ref, "failed"))).toMatchObject({ status: "transfer_failed" });
    expect(await ledgerBalance(f.db, f.M, "2400")).toBe(0n);
    expect(await ledgerBalance(f.db, f.M, "1100")).toBe(1_000_000n);
    expect((await runReconciliation(f.db, f.M, await f.provider.getBalance(), NOW)).ok).toBe(true);
  });

  it("descuadre con el proveedor congela salidas", async () => {
    const f = await setup();
    await f.mandate();
    f.provider.adjustBalance(-1n);
    expect((await runReconciliation(f.db, f.M, await f.provider.getBalance(), NOW)).freeze_outflows).toBe(true);
    const p = await f.payout(10_000);
    expect(await executeOutflow({ proposal_id: p.id }, f.deps)).toMatchObject({
      status: "rejected",
      decision: { rules_failed: expect.arrayContaining([expect.objectContaining({ rule_id: "R12" })]) },
    });
  });
});
