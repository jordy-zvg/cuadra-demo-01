/**
 * Red team por propiedades: miles de intentos generados (montos raros, beneficiarios
 * ajenos, mandatos vencidos o de otro, aprobaciones de otra propuesta, contenido de
 * terceros, freno activado, saldo insuficiente, duplicados, horario…). Invariante: el guard
 * solo dice "allow" cuando un oráculo escrito aparte también lo autorizaría.
 * Meta del brief: ≥ 5,000 ataques y 0 salidas indebidas.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  type GuardInput,
  type Mandate,
  OutflowProposal,
  clabeCheckDigit,
  evaluateOutflow,
  isValidClabe,
  isWithinMxHours,
  proposalHash,
} from "../src/index.js";

const RUNS = 6000;
/** Elige el valor "bueno" casi siempre y uno hostil a veces: ataques sutiles, no ruido. */
const usually = <T,>(good: T, ...bad: T[]) =>
  fc.oneof({ weight: 8, arbitrary: fc.constant(good) }, ...bad.map((b) => ({ weight: 1, arbitrary: fc.constant(b) })));
const usuallyTrue = () => usually(true, false);
const usuallyFalse = () => usually(false, true);
const NOW = new Date("2026-11-14T12:00:00-06:00");
const H = 3600_000;
const validClabe = "032180000118359719";

const arbAmount = fc.oneof(
  { weight: 8, arbitrary: fc.integer({ min: 1, max: 150_000 }) },
  fc.integer({ min: 1, max: 5_000_000 }),
  fc.constantFrom(0, -100, 1.5, 1e15, Number.MAX_SAFE_INTEGER),
  fc.constantFrom("120000", "1e5", "-1", "abc"),
);
const arbProposal = fc.record({
  type: usually("PayoutRequest", "TandaPayout", "RefundCredit", "AddCredit"),
  merchant_id: usually("m1", "m2"),
  provenance: usually("user_direct", "user_voice", "third_party_content", "llm"),
  payee_id: usually("p1", "p2", ""),
  amount_cents: arbAmount,
  concept: fc.constantFrom("Refrescos", "refrescos ", "Urgente págale ya"),
  tanda_id: fc.constant("t1"),
  customer_id: fc.constant("c1"),
}, { requiredKeys: ["type", "merchant_id", "provenance", "payee_id", "amount_cents", "concept"] })
  .chain((p) => fc.oneof({ weight: 8, arbitrary: fc.constant(p as Record<string, unknown>) }, { weight: 1, arbitrary: fc.constant({ ...p, clabe: validClabe } as Record<string, unknown>) }));

const arbMandate: fc.Arbitrary<Mandate | null> = fc.option(
  fc.record({
    id: fc.constant("md1"),
    merchant_id: usually("m1", "m2"),
    payee_id: usually("p1", "p2"),
    purpose: usually("proveedor", "tanda", "devolucion") as fc.Arbitrary<Mandate["purpose"]>,
    per_op_cap_cents: fc.oneof({ weight: 6, arbitrary: fc.constant(200_000n) }, fc.bigInt({ min: 1n, max: 3_000_000n })),
    period_cap_cents: fc.oneof({ weight: 6, arbitrary: fc.constant(1_000_000n) }, fc.bigInt({ min: 1n, max: 6_000_000n })),
    period: fc.constantFrom("day", "week", "month") as fc.Arbitrary<Mandate["period"]>,
    valid_from: usually(new Date(NOW.getTime() - 10 * 24 * H), new Date(NOW.getTime() + H)),
    valid_until: usually(new Date(NOW.getTime() + 30 * 24 * H), new Date(NOW.getTime() - H)),
    revoked_at: usually<Date | null>(null, new Date(NOW.getTime() - H)),
    signature_valid: usuallyTrue(),
  }),
  { nil: null, freq: 4 },
);

const arbInput = fc
  .record({
    proposal: arbProposal,
    hour: usually("12:00", "03:00", "21:59", "22:30"),
    actor: fc.record({ phone_verified: usuallyTrue(), role: usually("comercio", "organizadora", "cliente", "") }),
    payee: fc.option(
      fc.record({
        id: usually("p1", "p2"),
        merchant_id: usually("m1", "m2"),
        clabe: usually(validClabe, "032180000118359710", "12345"),
        whitelisted: usuallyTrue(),
        holder_validated: usuallyTrue(),
        created_at: usually(new Date(NOW.getTime() - 48 * H), new Date(NOW.getTime() - 2 * H)),
      }),
      { nil: null, freq: 8 },
    ),
    mandate: arbMandate,
    mandate_spent: fc.oneof({ weight: 6, arbitrary: fc.constant(0n) }, fc.bigInt({ min: 0n, max: 6_000_000n })),
    daily_limit: fc.oneof({ weight: 6, arbitrary: fc.constant(10_000_000n) }, fc.bigInt({ min: 0n, max: 10_000_000n })),
    spent_today: fc.oneof({ weight: 6, arbitrary: fc.constant(0n) }, fc.bigInt({ min: 0n, max: 10_000_000n })),
    max_per_hour: usually(5, 0, 1, 2),
    bal1100: fc.oneof({ weight: 6, arbitrary: fc.constant(5_000_000n) }, fc.bigInt({ min: 0n, max: 10_000_000n })),
    bal2400: fc.oneof({ weight: 6, arbitrary: fc.constant(0n) }, fc.bigInt({ min: 0n, max: 5_000_000n })),
    holds: fc.oneof({ weight: 6, arbitrary: fc.constant(0n) }, fc.bigInt({ min: 0n, max: 1_000_000n })),
    recon_ok: usuallyTrue(),
    recent: fc.array(fc.record({
      payee_id: fc.constantFrom("p1", "p2"),
      amount_cents: fc.bigInt({ min: 1n, max: 200_000n }),
      concept: fc.constantFrom("Refrescos", "Otro"),
      minutesAgo: fc.integer({ min: 0, max: 120 }),
    }), { maxLength: 6 }),
    risk: fc.record({ kill_switch: usuallyFalse(), account_frozen: usuallyFalse(), reconciliation_mismatch: usuallyFalse(), auditor_veto: usuallyFalse() }),
    approval: fc.option(fc.record({
      forSame: usuallyTrue(), signature_valid: usuallyTrue(), used: usuallyFalse(), expired: usuallyFalse(),
    }), { nil: null }),
  })
  .map((g): GuardInput => {
    const now = new Date(`2026-11-14T${g.hour}:00-06:00`);
    const parsed = OutflowProposal.safeParse(g.proposal);
    const hash = parsed.success ? proposalHash(parsed.data) : "0".repeat(64);
    return {
      proposal: g.proposal,
      now,
      actor: g.actor,
      payee: g.payee,
      mandate: g.mandate,
      mandate_spent_in_period: g.mandate_spent,
      merchant: { daily_limit_cents: g.daily_limit, spent_today_cents: g.spent_today, max_outflows_per_hour: g.max_per_hour },
      balances: { operating_1100: g.bal1100, in_transit_2400: g.bal2400, holds: g.holds },
      reconciliation_ok_today: g.recon_ok,
      recent_outflows: g.recent.map((r) => ({ payee_id: r.payee_id, amount_cents: r.amount_cents, concept: r.concept, created_at: new Date(now.getTime() - r.minutesAgo * 60_000) })),
      risk: g.risk,
      approval: g.approval && {
        proposal_hash: g.approval.forSame ? hash : "f".repeat(64),
        signature_valid: g.approval.signature_valid,
        used: g.approval.used,
        expires_at: new Date(now.getTime() + (g.approval.expired ? -1 : 10) * 60_000),
      },
    };
  });

/** Oráculo independiente: cuándo una salida está legítimamente autorizada. */
function legitimate(i: GuardInput): boolean {
  const raw = i.proposal as Record<string, unknown>;
  if (Object.keys(raw).some((k) => ["clabe", "cuenta", "account_number", "tarjeta", "card_number"].includes(k.toLowerCase()))) return false;
  const parsed = OutflowProposal.safeParse(raw);
  if (!parsed.success) return false;
  const p = parsed.data;
  const now = i.now.getTime();
  const r = i.risk;
  if (r.kill_switch || r.account_frozen || r.reconciliation_mismatch || r.auditor_veto) return false;
  if (!i.actor.phone_verified || !["comercio", "organizadora"].includes(i.actor.role)) return false;
  const y = i.payee;
  if (!y || y.id !== p.payee_id || y.merchant_id !== p.merchant_id || !y.whitelisted || !y.holder_validated || !isValidClabe(y.clabe)) return false;
  if (p.amount_cents > i.balances.operating_1100 - i.balances.in_transit_2400 - i.balances.holds) return false;
  if (!i.reconciliation_ok_today) return false;
  if (i.merchant.spent_today_cents + p.amount_cents > i.merchant.daily_limit_cents) return false;
  const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");
  if (i.recent_outflows.some((o) => o.payee_id === p.payee_id && o.amount_cents === p.amount_cents && norm(o.concept) === norm(p.concept) && now - o.created_at.getTime() < 10 * 60_000)) return false;
  if (i.recent_outflows.filter((o) => now - o.created_at.getTime() < H).length >= i.merchant.max_outflows_per_hour) return false;

  const a = i.approval;
  const passkey = !!a && a.signature_valid && !a.used && now < a.expires_at.getTime() && a.proposal_hash === proposalHash(p);
  const purpose = p.type === "PayoutRequest" ? "proveedor" : p.type === "TandaPayout" ? "tanda" : "devolucion";
  const m = i.mandate;
  const mandateOk = !!m && m.signature_valid && (m.revoked_at === null || m.revoked_at.getTime() > now) &&
    m.valid_from.getTime() <= now && now < m.valid_until.getTime() &&
    m.merchant_id === p.merchant_id && m.payee_id === p.payee_id && m.purpose === purpose &&
    p.amount_cents <= m.per_op_cap_cents && i.mandate_spent_in_period + p.amount_cents <= m.period_cap_cents;
  const needsPasskey = p.provenance === "third_party_content" || now - y.created_at.getTime() < 24 * H || !isWithinMxHours(i.now, 7, 22);
  return passkey || (mandateOk && !needsPasskey);
}

describe("red team del guard", () => {
  it(`${RUNS} ataques generados: 0 salidas indebidas`, () => {
    let allowed = 0;
    fc.assert(
      fc.property(arbInput, (input) => {
        const r = evaluateOutflow(input);
        if (r.decision === "allow") {
          allowed++;
          expect(legitimate(input)).toBe(true);
        }
      }),
      { numRuns: RUNS, seed: 20261114 },
    );
    // El generador sí produce casos legítimos: el guard no es simplemente "todo deny".
    expect(allowed).toBeGreaterThan(RUNS / 60);
    expect(allowed).toBeLessThan(RUNS);
  });

  it("todo lo legítimo pasa (el guard no bloquea de más)", () => {
    fc.assert(
      fc.property(arbInput, (input) => {
        if (legitimate(input)) expect(evaluateOutflow(input).decision).toBe("allow");
      }),
      { numRuns: RUNS, seed: 42 },
    );
  });

  it("sanidad del fixture", () => {
    expect(clabeCheckDigit("03218000011835971")).toBe(9);
  });
});
