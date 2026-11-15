import { describe, expect, it } from "vitest";
import {
  type GuardInput,
  type Mandate,
  OutflowProposal,
  evaluateCreatePayee,
  evaluateOutflow,
  proposalHash,
} from "../src/index.js";

const at = (hhmm: string, day = "2026-11-14") => new Date(`${day}T${hhmm}:00-06:00`);
const NOW = at("12:00");
const CLABE = "032180000118359719";

const proposal = {
  type: "PayoutRequest",
  merchant_id: "m1",
  provenance: "user_direct",
  payee_id: "p1",
  amount_cents: 150000,
  concept: "Refrescos",
};

const mandate: Mandate = {
  id: "md1", merchant_id: "m1", payee_id: "p1", purpose: "proveedor",
  per_op_cap_cents: 200000n, period_cap_cents: 500000n, period: "week",
  valid_from: at("00:00", "2026-11-01"), valid_until: at("00:00", "2026-12-01"),
  revoked_at: null, signature_valid: true,
};

const noRisk = { kill_switch: false, account_frozen: false, reconciliation_mismatch: false, auditor_veto: false };

function input(over: Partial<GuardInput> = {}): GuardInput {
  return {
    proposal,
    now: NOW,
    actor: { phone_verified: true, role: "comercio" },
    payee: { id: "p1", merchant_id: "m1", clabe: CLABE, whitelisted: true, holder_validated: true, created_at: at("12:00", "2026-11-01") },
    mandate,
    mandate_spent_in_period: 0n,
    merchant: { daily_limit_cents: 1000000n, spent_today_cents: 0n, max_outflows_per_hour: 5 },
    balances: { operating_1100: 500000n, in_transit_2400: 0n, holds: 0n },
    reconciliation_ok_today: true,
    recent_outflows: [],
    risk: noRisk,
    approval: null,
    ...over,
  };
}

const approvalFor = (p: unknown, over = {}) => ({
  proposal_hash: proposalHash(OutflowProposal.parse(p)),
  signature_valid: true,
  expires_at: new Date(NOW.getTime() + 10 * 60_000),
  used: false,
  ...over,
});

const run = (over: Partial<GuardInput> = {}) => evaluateOutflow(input(over));
const ids = (over: Partial<GuardInput> = {}) => run(over).rules_failed.map((f) => f.rule_id);

describe("guard de salidas", () => {
  it("permite con mandato vigente que cubre todo", () => {
    expect(run()).toEqual({ decision: "allow", rules_failed: [], approved_by_passkey: false });
  });

  it("todo rechazo trae rule_id y motivo en español", () => {
    const r = run({ risk: { ...noRisk, kill_switch: true }, mandate: null });
    for (const f of r.rules_failed) {
      expect(f.rule_id).toMatch(/^R\d\d$/);
      expect(f.reason.length).toBeGreaterThan(10);
    }
  });

  describe("R01 schema", () => {
    it.each([
      ["float", { ...proposal, amount_cents: 1500.5 }],
      ["cero", { ...proposal, amount_cents: 0 }],
      ["negativo", { ...proposal, amount_cents: -100 }],
      ["tipo no saliente", { ...proposal, type: "AddCredit" }],
      ["null", null],
      ["texto", "paga 100"],
    ])("deny: %s", (_n, p) => {
      const r = run({ proposal: p });
      expect(r.decision).toBe("deny");
      expect(r.rules_failed.map((f) => f.rule_id)).toEqual(["R01"]);
    });
    it("propuesta inválida también reporta estado de riesgo", () => {
      expect(ids({ proposal: null, risk: { ...noRisk, kill_switch: true } })).toEqual(["R01", "R12"]);
    });
  });

  it("R02 teléfono no verificado o rol incorrecto → deny", () => {
    expect(run({ actor: { phone_verified: false, role: "comercio" } })).toMatchObject({ decision: "deny", rules_failed: [{ rule_id: "R02" }] });
    expect(run({ actor: { phone_verified: true, role: "cliente" } })).toMatchObject({ decision: "deny", rules_failed: [{ rule_id: "R02" }] });
    expect(run({ actor: { phone_verified: true, role: "organizadora" } }).decision).toBe("allow");
  });

  describe("R03 beneficiario", () => {
    const payee = input().payee!;
    it.each([
      ["inexistente", null],
      ["otro id", { ...payee, id: "p2" }],
      ["otro comercio", { ...payee, merchant_id: "m2" }],
      ["fuera de lista blanca", { ...payee, whitelisted: false }],
      ["CLABE inválida", { ...payee, clabe: "032180000118359710" }],
      ["titular sin validar", { ...payee, holder_validated: false }],
    ])("deny: %s", (_n, p) => {
      const r = run({ payee: p });
      expect(r.decision).toBe("deny");
      expect(r.rules_failed.map((f) => f.rule_id)).toEqual(["R03"]);
    });
  });

  it("R04 beneficiario con < 24 h → passkey", () => {
    const payee = { ...input().payee!, created_at: new Date(NOW.getTime() - 23 * 3600_000) };
    expect(run({ payee })).toMatchObject({ decision: "require_passkey", rules_failed: [{ rule_id: "R04" }] });
    const old = { ...payee, created_at: new Date(NOW.getTime() - 24 * 3600_000) };
    expect(run({ payee: old }).decision).toBe("allow");
  });

  describe("R05 mandato", () => {
    it.each([
      ["sin mandato", null],
      ["vencido", { ...mandate, valid_until: at("00:00", "2026-11-10") }],
      ["revocado", { ...mandate, revoked_at: at("09:00") }],
      ["firma inválida", { ...mandate, signature_valid: false }],
      ["otro beneficiario", { ...mandate, payee_id: "p2" }],
      ["otro propósito", { ...mandate, purpose: "tanda" as const }],
    ])("passkey: %s", (_n, m) => {
      expect(run({ mandate: m })).toMatchObject({ decision: "require_passkey", rules_failed: [{ rule_id: "R05" }] });
    });
    it("el propósito sale del tipo de propuesta", () => {
      const tanda = { ...proposal, type: "TandaPayout", tanda_id: "t1" };
      expect(ids({ proposal: tanda })).toEqual(["R05"]);
      expect(ids({ proposal: tanda, mandate: { ...mandate, purpose: "tanda" } })).toEqual([]);
      const refund = { ...proposal, type: "RefundCredit", customer_id: "c1" };
      expect(ids({ proposal: refund, mandate: { ...mandate, purpose: "devolucion" } })).toEqual([]);
    });
  });

  it("R06 tope por operación → passkey", () => {
    expect(run({ mandate: { ...mandate, per_op_cap_cents: 149999n } })).toMatchObject({
      decision: "require_passkey", rules_failed: [{ rule_id: "R06" }],
    });
    expect(run({ mandate: { ...mandate, per_op_cap_cents: 150000n } }).decision).toBe("allow");
  });

  it("R07 tope de periodo del mandato → passkey; tope diario global → deny", () => {
    expect(run({ mandate_spent_in_period: 350001n })).toMatchObject({
      decision: "require_passkey", rules_failed: [{ rule_id: "R07", effect: "require_passkey" }],
    });
    expect(run({ mandate_spent_in_period: 350000n }).decision).toBe("allow");
    const m = { daily_limit_cents: 1000000n, spent_today_cents: 850001n, max_outflows_per_hour: 5 };
    expect(run({ merchant: m })).toMatchObject({ decision: "deny", rules_failed: [{ rule_id: "R07", effect: "deny" }] });
  });

  it("R08 saldo disponible = 1100 − 2400 − retenciones; conciliación del día", () => {
    expect(run({ balances: { operating_1100: 150000n, in_transit_2400: 0n, holds: 0n } }).decision).toBe("allow");
    expect(ids({ balances: { operating_1100: 200000n, in_transit_2400: 50001n, holds: 0n } })).toEqual(["R08"]);
    expect(ids({ balances: { operating_1100: 200000n, in_transit_2400: 0n, holds: 50001n } })).toEqual(["R08"]);
    expect(run({ reconciliation_ok_today: false })).toMatchObject({ decision: "deny", rules_failed: [{ rule_id: "R08" }] });
  });

  it("R09 duplicado en 10 min → deny", () => {
    const dup = { payee_id: "p1", amount_cents: 150000n, concept: "  refrescos ", created_at: new Date(NOW.getTime() - 9 * 60_000) };
    expect(run({ recent_outflows: [dup] })).toMatchObject({ decision: "deny", rules_failed: [{ rule_id: "R09" }] });
    for (const notDup of [
      { ...dup, created_at: new Date(NOW.getTime() - 10 * 60_000) },
      { ...dup, amount_cents: 150001n },
      { ...dup, payee_id: "p2" },
      { ...dup, concept: "Botanas" },
    ]) {
      expect(run({ recent_outflows: [notDup] }).decision).toBe("allow");
    }
  });

  it("R10 velocidad → deny; fuera de 07:00–22:00 → passkey", () => {
    const recent = (min: number, i: number) => ({ payee_id: `x${i}`, amount_cents: 1n, concept: "x", created_at: new Date(NOW.getTime() - min * 60_000) });
    const five = [1, 2, 3, 4, 5].map((i) => recent(30, i));
    expect(run({ recent_outflows: five })).toMatchObject({ decision: "deny", rules_failed: [{ rule_id: "R10" }] });
    expect(run({ recent_outflows: [...five.slice(1), recent(61, 9)] }).decision).toBe("allow");
    expect(run({ now: at("22:30") })).toMatchObject({ decision: "require_passkey", rules_failed: [{ rule_id: "R10" }] });
    expect(run({ now: at("06:59") }).decision).toBe("require_passkey");
  });

  it("R10 con horario configurable (OUTFLOW_HOURS): 0-24 quita la hora, no el tope por hora", () => {
    expect(run({ now: at("22:30"), outflow_hours: [0, 24] }).decision).toBe("allow");
    expect(run({ now: at("03:00"), outflow_hours: [0, 24] }).decision).toBe("allow");
    expect(run({ now: at("06:59"), outflow_hours: [0, 24] }).decision).toBe("allow");
    const narrow = run({ now: at("21:30"), outflow_hours: [8, 21] });
    expect(narrow).toMatchObject({ decision: "require_passkey", rules_failed: [{ rule_id: "R10" }] });
    expect(narrow.rules_failed[0]!.reason).toBe("Fuera del horario de 8:00 a 21:00.");
    expect(run({ now: at("22:30") }).rules_failed[0]!.reason).toBe("Fuera del horario de 7:00 a 22:00.");
    // Un horario inválido nunca abre nada: rige el normal de 7 a 22.
    for (const h of [[22, 7], [-1, 30], [5, 5], [7.5, 22], [0, 25]] as const) {
      expect(run({ now: at("22:30"), outflow_hours: h }).decision).toBe("require_passkey");
    }
    // El tope de salidas por hora sigue aplicando sin horario.
    const five = [1, 2, 3, 4, 5].map((i) => ({ payee_id: `x${i}`, amount_cents: 1n, concept: "x", created_at: new Date(at("03:00").getTime() - 30 * 60_000) }));
    expect(run({ now: at("03:00"), outflow_hours: [0, 24], recent_outflows: five })).toMatchObject({ decision: "deny", rules_failed: [{ rule_id: "R10" }] });
  });

  it("R11 contenido de terceros → passkey; datos bancarios en la propuesta → deny", () => {
    expect(run({ proposal: { ...proposal, provenance: "third_party_content" } })).toMatchObject({
      decision: "require_passkey", rules_failed: [{ rule_id: "R11" }],
    });
    expect(run({ proposal: { ...proposal, provenance: "user_voice" } }).decision).toBe("allow");
    expect(run({ proposal: { ...proposal, CLABE: CLABE } })).toMatchObject({
      decision: "deny", rules_failed: [{ rule_id: "R11", effect: "deny" }],
    });
    expect(ids({ proposal: { clabe: CLABE } })).toEqual(["R11", "R01"]);
  });

  it.each(["kill_switch", "account_frozen", "reconciliation_mismatch", "auditor_veto"] as const)(
    "R12 %s → deny",
    (flag) => {
      expect(run({ risk: { ...noRisk, [flag]: true } })).toMatchObject({ decision: "deny", rules_failed: [{ rule_id: "R12" }] });
    },
  );

  describe("aprobación con passkey (principio 8)", () => {
    const noMandate = { mandate: null };
    it("ligada al hash exacto → allow", () => {
      const r = run({ ...noMandate, approval: approvalFor(proposal) });
      expect(r).toMatchObject({ decision: "allow", approved_by_passkey: true, rules_failed: [{ rule_id: "R05" }] });
    });
    it.each([
      ["otro monto", approvalFor({ ...proposal, amount_cents: 150001 })],
      ["firma inválida", approvalFor(proposal, { signature_valid: false })],
      ["ya usada", approvalFor(proposal, { used: true })],
      ["expirada", approvalFor(proposal, { expires_at: NOW })],
    ])("no vale: %s", (_n, approval) => {
      expect(run({ ...noMandate, approval }).decision).toBe("require_passkey");
    });
    it("nunca levanta un deny", () => {
      const r = run({ ...noMandate, approval: approvalFor(proposal), risk: { ...noRisk, kill_switch: true } });
      expect(r).toMatchObject({ decision: "deny", approved_by_passkey: false });
    });
    it("no marca passkey si no hizo falta", () => {
      expect(run({ approval: approvalFor(proposal) }).approved_by_passkey).toBe(false);
    });
  });
});

describe("alta de beneficiario", () => {
  const base = { provenance: "user_direct" as const, actor: { phone_verified: true, role: "comercio" }, risk: noRisk, passkey_approved: false };
  it("usuario directo → allow", () => expect(evaluateCreatePayee(base).decision).toBe("allow"));
  it("contenido de terceros → passkey, y con passkey → allow", () => {
    const t = { ...base, provenance: "third_party_content" as const };
    expect(evaluateCreatePayee(t)).toMatchObject({ decision: "require_passkey", rules_failed: [{ rule_id: "R11" }] });
    expect(evaluateCreatePayee({ ...t, passkey_approved: true })).toMatchObject({ decision: "allow", approved_by_passkey: true });
  });
  it("actor no autorizado o riesgo → deny", () => {
    expect(evaluateCreatePayee({ ...base, actor: { phone_verified: false, role: "cliente" } }).rules_failed.map((f) => f.rule_id)).toEqual(["R02", "R02"]);
    expect(evaluateCreatePayee({ ...base, risk: { ...noRisk, account_frozen: true } }).decision).toBe("deny");
  });
});
