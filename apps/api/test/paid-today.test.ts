import { fiado } from "@cuadra/core";
import { DEMO, postEntries, recordCashPayment, schema, seedDemo } from "@cuadra/db";
import { createTestDb } from "@cuadra/db/testing";
import { describe, expect, it } from "vitest";
import { panelState } from "../src/state.js";

const M = DEMO.merchantId;
const HOUR = 60 * 60 * 1000;

describe("paid_today: lo que entró hoy en el Inicio del portal", () => {
  it("suma CoDi/SPEI y efectivo desde las 00:00 de CDMX; lo de ayer no cuenta", async () => {
    const { db } = await createTestDb();
    const now = new Date();
    await seedDemo(db, new Date(now.getTime() - 48 * HOUR));
    const opts = { gateway: "mock", simulated: true, bankSim: false, now };

    const before = await panelState(db, M, opts);
    expect(before.paid_today).toEqual({ digital: "0", cash: "0", total: "0" });

    // Un depósito de hoy, identificado o no, cuenta; uno de hace dos días no.
    await db.insert(schema.deposits).values([
      { merchantId: M, claveRastreo: "HOY-1", amountCents: 18_500n, receivedAt: now },
      { merchantId: M, claveRastreo: "ANTIER-1", amountCents: 99_900n, receivedAt: new Date(now.getTime() - 48 * HOUR) },
    ]);

    // Efectivo de hoy (D 1050), hasta el saldo del cliente.
    const lupe = DEMO.customers.lupe.id;
    await postEntries(db, [fiado({ merchant_id: M, idempotency_key: "fiado-lupe", amount: 20_000n, customer_id: lupe })]);
    const cash = 5_000n;
    expect((await recordCashPayment(db, M, { customer_id: lupe, amount: cash, idempotency_key: "efectivo-hoy" })).status).toBe("posted");

    const after = await panelState(db, M, opts);
    expect(after.paid_today).toEqual({ digital: "18500", cash: cash.toString(), total: (18_500n + cash).toString() });

    // Al día siguiente vuelve a cero.
    const tomorrow = await panelState(db, M, { ...opts, now: new Date(now.getTime() + 24 * HOUR) });
    expect(tomorrow.paid_today.total).toBe("0");
  });
});
