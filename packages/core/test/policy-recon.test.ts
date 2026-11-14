import { describe, expect, it } from "vitest";
import {
  type Mandate,
  type MatchContext,
  Proposal,
  REMINDER_MAX_RESENDS,
  type ResendInput,
  canonicalJson,
  checkBalance,
  evaluateReminder,
  evaluateResend,
  formatMxTime,
  formatMxWhen,
  isMandateActive,
  isWithinMxHours,
  mandateCovers,
  matchDeposit,
  mxDateKey,
  proposalHash,
} from "../src/index.js";

// CDMX = UTC-6 todo el año.
const at = (hhmm: string, day = "2026-11-14") => new Date(`${day}T${hhmm}:00-06:00`);

describe("time", () => {
  it("usa hora de CDMX", () => {
    expect(isWithinMxHours(at("07:00"), 7, 22)).toBe(true);
    expect(isWithinMxHours(at("21:59"), 7, 22)).toBe(true);
    expect(isWithinMxHours(at("22:00"), 7, 22)).toBe(false);
    expect(isWithinMxHours(at("06:59"), 7, 22)).toBe(false);
    expect(mxDateKey(new Date("2026-11-15T03:00:00Z"))).toBe("2026-11-14");
  });
  it("formatea horas y días en hora de CDMX", () => {
    expect(formatMxTime(at("16:11"))).toBe("16:11");
    expect(formatMxWhen(at("16:11"), at("15:09"))).toBe("hoy a las 16:11");
    expect(formatMxWhen(at("09:05", "2026-11-15"), at("15:09"))).toBe("mañana a las 09:05");
    expect(formatMxWhen(at("15:09", "2026-11-17"), at("15:09"))).toMatch(/^el martes 17 de noviembre a las 15:09$/);
    // 23:30 en CDMX ya es el día siguiente en UTC: sigue siendo "hoy".
    expect(formatMxWhen(at("23:30"), at("10:00"))).toBe("hoy a las 23:30");
  });
});

describe("recordatorios", () => {
  const ok = {
    now: at("10:00"),
    ledger_balance: 8000n,
    amount: 8000n,
    last_reminder_at: null,
    opt_in: true,
    template_id: "cobro_amable",
    approved_template_ids: ["cobro_amable"],
  };
  const ids = (i: Partial<Omit<typeof ok, "last_reminder_at">> & { last_reminder_at?: Date | null }) =>
    evaluateReminder({ ...ok, ...i }).rules_failed.map((f) => f.rule_id);

  it("permite cuando todo se cumple", () => expect(evaluateReminder(ok).allow).toBe(true));
  it("P01 sin saldo", () => expect(ids({ ledger_balance: 0n, amount: 0n })).toEqual(["P01"]));
  it("P02 monto ≠ saldo", () => expect(ids({ amount: 7999n })).toEqual(["P02"]));
  it("P03 máx. 1 cada 72 h", () => {
    expect(ids({ last_reminder_at: at("10:01", "2026-11-11") })).toEqual(["P03"]);
    expect(ids({ last_reminder_at: at("10:00", "2026-11-11") })).toEqual([]);
    expect(evaluateReminder({ ...ok, last_reminder_at: at("10:01", "2026-11-11") }).rules_failed[0]!.reason).toMatch(/72 horas/);
  });
  it("P03 con espera configurable (modo demo)", () => {
    const now = ok.now.getTime();
    const minuto = { min_interval_ms: 60_000 };
    expect(ids({ ...minuto, last_reminder_at: new Date(now - 30_000) })).toEqual(["P03"]);
    expect(ids({ ...minuto, last_reminder_at: new Date(now - 60_000) })).toEqual([]);
    expect(evaluateReminder({ ...ok, ...minuto, last_reminder_at: new Date(now - 30_000) }).rules_failed[0]!.reason).toMatch(/último 1 minuto|1 minuto/);
    expect(evaluateReminder({ ...ok, min_interval_ms: 90 * 60_000, last_reminder_at: new Date(now - 1000) }).rules_failed[0]!.reason).toMatch(/90 minutos/);
    expect(evaluateReminder({ ...ok, min_interval_ms: 3_600_000, last_reminder_at: new Date(now - 1000) }).rules_failed[0]!.reason).toMatch(/1 hora\./);
  });
  it("P04 horario 9–20", () => {
    expect(ids({ now: at("08:59") })).toEqual(["P04"]);
    expect(ids({ now: at("20:00") })).toEqual(["P04"]);
  });
  it("P05 opt-in", () => expect(ids({ opt_in: false })).toEqual(["P05"]));
  it("P06 plantilla", () => expect(ids({ template_id: "amenaza" })).toEqual(["P06"]));
  it("P03 configurable solo para desarrollo: 0 no limita", () => {
    expect(evaluateReminder({ ...ok, last_reminder_at: at("09:59"), min_interval_ms: 0 }).allow).toBe(true);
  });
});

describe("reenvío de una solicitud CoDi vencida", () => {
  const base = {
    now: at("10:00"), ledger_balance: 8000n, amount: 8000n, opt_in: true,
    template_id: "cobro_amable", approved_template_ids: ["cobro_amable"],
  };
  const blocked = evaluateReminder({ ...base, last_reminder_at: at("09:00") }); // solo P03
  const expired = { status: "expired" as const, channel: "codi_pn" as const };
  const rs = (d: ReturnType<typeof evaluateReminder>, i: Partial<ResendInput>) =>
    evaluateResend(d, { last_charge: expired, resends_in_cycle: 0, ...i }).rules_failed.map((f) => f.rule_id);

  it("se permite si solo falla P03 y la solicitud anterior venció sin pago", () => {
    expect(blocked.rules_failed.map((f) => f.rule_id)).toEqual(["P03"]);
    expect(evaluateResend(blocked, { last_charge: expired, resends_in_cycle: 0 }).allow).toBe(true);
    expect(evaluateResend(blocked, { last_charge: expired, resends_in_cycle: REMINDER_MAX_RESENDS - 1 }).allow).toBe(true);
  });
  it("P07: nunca con una solicitud viva, pagada, cancelada o por QR", () => {
    expect(rs(blocked, { last_charge: { status: "open", channel: "codi_pn" } })).toEqual(["P07"]);
    expect(rs(blocked, { last_charge: { status: "paid", channel: "codi_pn" } })).toEqual(["P07"]);
    expect(rs(blocked, { last_charge: { status: "cancelled", channel: "codi_pn" } })).toEqual(["P07"]);
    expect(rs(blocked, { last_charge: { status: "expired", channel: "codi_qr" } })).toEqual(["P07"]);
    expect(rs(blocked, { last_charge: { status: "expired", channel: null } })).toEqual(["P07"]);
    expect(rs(blocked, { last_charge: null })).toEqual(["P07"]);
  });
  it("P08: máximo de reenvíos por recordatorio", () => {
    expect(rs(blocked, { resends_in_cycle: REMINDER_MAX_RESENDS })).toEqual(["P08"]);
  });
  it("las demás reglas siguen aplicando (horario, opt-in, saldo)", () => {
    const night = evaluateReminder({ ...base, now: at("20:30"), last_reminder_at: at("19:00") });
    expect(rs(night, {})).toEqual(["P04"]);
    const noOptIn = evaluateReminder({ ...base, opt_in: false, last_reminder_at: at("09:00") });
    expect(rs(noOptIn, {})).toEqual(["P05"]);
    const paidOff = evaluateReminder({ ...base, ledger_balance: 0n, amount: 0n, last_reminder_at: at("09:00") });
    expect(rs(paidOff, {})).toEqual(["P01"]);
  });
  it("sin P03 no hay reenvío: procede un recordatorio normal", () => {
    expect(rs(evaluateReminder({ ...base, last_reminder_at: null }), {})).toEqual(["P07"]);
  });
});

describe("mandatos", () => {
  const m: Mandate = {
    id: "md1", merchant_id: "m1", payee_id: "p1", purpose: "proveedor",
    per_op_cap_cents: 100000n, period_cap_cents: 500000n, period: "week",
    valid_from: at("00:00", "2026-11-01"), valid_until: at("00:00", "2026-12-01"),
    revoked_at: null, signature_valid: true,
  };
  it("vigencia", () => {
    expect(isMandateActive(m, at("10:00"))).toBe(true);
    expect(isMandateActive(m, at("10:00", "2026-10-31"))).toBe(false);
    expect(isMandateActive(m, at("00:00", "2026-12-01"))).toBe(false);
    expect(isMandateActive({ ...m, signature_valid: false }, at("10:00"))).toBe(false);
    expect(isMandateActive({ ...m, revoked_at: at("09:00") }, at("10:00"))).toBe(false);
    expect(isMandateActive({ ...m, revoked_at: at("11:00") }, at("10:00"))).toBe(true);
  });
  it("cobertura", () => {
    const o = { merchant_id: "m1", payee_id: "p1", purpose: "proveedor" as const };
    expect(mandateCovers(m, o)).toBe(true);
    expect(mandateCovers(m, { ...o, payee_id: "p2" })).toBe(false);
    expect(mandateCovers(m, { ...o, purpose: "tanda" })).toBe(false);
    expect(mandateCovers(m, { ...o, merchant_id: "m2" })).toBe(false);
  });
});

describe("conciliación de abonos", () => {
  const ctx: MatchContext = {
    virtual_clabes: new Map([["V1", "c1"]]),
    linked_ordering_clabes: new Map([["O2", "c2"]]),
    open_charges: [
      { customer_id: "c3", reference: "1234567", unique_amount: 8017n },
      { customer_id: "c4", reference: "7654321", unique_amount: 8023n },
      { customer_id: "c5", reference: "5550001", unique_amount: 8023n },
      { customer_id: "c6", reference: "5550001" },
    ],
  };
  const dep = { clave_rastreo: "CR1", amount: 100n };

  it("1. CLABE virtual gana sobre todo", () => {
    expect(matchDeposit({ ...dep, destination_clabe: "V1", ordering_clabe: "O2" }, ctx)).toEqual({
      matched: true, customer_id: "c1", method: "virtual_clabe",
    });
  });
  it("2. CLABE ordenante ligada", () => {
    expect(matchDeposit({ ...dep, destination_clabe: "X", ordering_clabe: "O2" }, ctx)).toMatchObject({
      customer_id: "c2", method: "ordering_clabe",
    });
  });
  it("3. referencia o concepto", () => {
    expect(matchDeposit({ ...dep, reference: "1234567" }, ctx)).toMatchObject({ customer_id: "c3", method: "reference" });
    expect(matchDeposit({ ...dep, concept: "pago fiado 7654321 gracias" }, ctx)).toMatchObject({ customer_id: "c4" });
  });
  it("4. monto con centavos únicos", () => {
    expect(matchDeposit({ ...dep, amount: 8017n }, ctx)).toMatchObject({ customer_id: "c3", method: "unique_amount" });
  });
  it("5. ambiguo o sin coincidencia → 1300, nunca adivina", () => {
    expect(matchDeposit({ ...dep, reference: "5550001" }, ctx)).toMatchObject({ matched: false, account: "1300" });
    expect(matchDeposit({ ...dep, amount: 8023n }, ctx)).toMatchObject({ matched: false });
    expect(matchDeposit(dep, ctx)).toMatchObject({ matched: false });
  });
  it("saldo ledger vs proveedor", () => {
    expect(checkBalance(100n, 100n)).toEqual({ ok: true, difference: 0n, freeze_outflows: false });
    expect(checkBalance(100n, 90n)).toEqual({ ok: false, difference: 10n, freeze_outflows: true });
  });
});

describe("proposals", () => {
  const payout = { type: "PayoutRequest", merchant_id: "m1", provenance: "user_direct", payee_id: "p1", amount_cents: 150000, concept: "Refrescos" };
  it("valida y convierte montos a bigint", () => {
    const p = Proposal.parse(payout);
    expect(p.type === "PayoutRequest" && p.amount_cents).toBe(150000n);
    expect(Proposal.parse({ ...payout, amount_cents: "150000" })).toEqual(p);
  });
  it("rechaza floats, negativos, tipos desconocidos y procedencia inválida", () => {
    for (const bad of [
      { ...payout, amount_cents: 1500.5 },
      { ...payout, amount_cents: -1 },
      { ...payout, amount_cents: 0 },
      { ...payout, amount_cents: "15e3" },
      { ...payout, type: "Transfer" },
      { ...payout, provenance: "llm" },
    ]) {
      expect(Proposal.safeParse(bad).success).toBe(false);
    }
  });
  it("hash estable ante orden de llaves y sensible al contenido", () => {
    const a = Proposal.parse(payout);
    const b = Proposal.parse(Object.fromEntries(Object.entries(payout).reverse()));
    expect(proposalHash(a)).toBe(proposalHash(b));
    expect(proposalHash(Proposal.parse({ ...payout, amount_cents: 150001 }))).not.toBe(proposalHash(a));
    expect(canonicalJson({ b: [1n, null], a: undefined, c: "x" })).toBe('{"b":["1",null],"c":"x"}');
  });
});

describe("adiciones: periodos, en vuelo y salidaCreada", async () => {
  const { mxPeriodStart, salidaCreada, LedgerError } = await import("../src/index.js");
  it("inicio de periodo en CDMX", () => {
    // sábado 14 nov 2026, 23:30 CDMX = domingo 05:30 UTC
    const now = new Date("2026-11-15T05:30:00Z");
    expect(mxPeriodStart(now, "day").toISOString()).toBe("2026-11-14T06:00:00.000Z");
    expect(mxPeriodStart(now, "week").toISOString()).toBe("2026-11-09T06:00:00.000Z");
    expect(mxPeriodStart(now, "month").toISOString()).toBe("2026-11-01T06:00:00.000Z");
    expect(mxPeriodStart(at("10:00", "2026-11-09"), "week").toISOString()).toBe("2026-11-09T06:00:00.000Z");
    expect(mxPeriodStart(at("10:00", "2026-11-15"), "week").toISOString()).toBe("2026-11-09T06:00:00.000Z");
  });
  it("checkBalance descuenta lo enviado y no confirmado", () => {
    expect(checkBalance(1000n, 700n, 300n).ok).toBe(true);
    expect(checkBalance(1000n, 700n, 0n)).toMatchObject({ ok: false, difference: 300n });
  });
  it("salidaCreada según propósito", () => {
    const b = { merchant_id: "m", idempotency_key: "k", amount: 10n };
    expect(salidaCreada({ ...b, purpose: "proveedor" }).kind).toBe("pago_proveedor_creado");
    expect(salidaCreada({ ...b, purpose: "tanda", tanda_id: "t" }).kind).toBe("tanda_dispersion");
    expect(salidaCreada({ ...b, purpose: "devolucion", customer_id: "c" }).kind).toBe("devolucion_saldo_a_favor");
    expect(() => salidaCreada({ ...b, purpose: "tanda" })).toThrow(LedgerError);
    expect(() => salidaCreada({ ...b, purpose: "devolucion" })).toThrow(LedgerError);
  });
});
