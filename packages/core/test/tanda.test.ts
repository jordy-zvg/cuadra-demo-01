import { describe, expect, it } from "vitest";
import { CreateTanda, potCents, recipientOf, roundStatus } from "../src/index.js";

const m = (n: number) => ({ name: `M${n}`, phone: `55000000${String(n).padStart(2, "0")}`, clabe: ["012180015826225713", "012180015913466252", "014180606004536217", "012180015355682429"][n - 1]! });
const tanda = { type: "CreateTanda", merchant_id: "m1", provenance: "user_direct", name: "Tanda del mercado", contribution_cents: 50000, period: "week", members: [m(1), m(2), m(3)] };

describe("tanda sin pozo", () => {
  it("esquema: CLABEs válidas, sin repetidos, 2 a 20 integrantes", () => {
    expect(CreateTanda.safeParse(tanda).success).toBe(true);
    expect(CreateTanda.safeParse({ ...tanda, members: [m(1), { ...m(2), clabe: "012180015913466250" }] }).success).toBe(false);
    expect(CreateTanda.safeParse({ ...tanda, members: [m(1), { ...m(2), phone: m(1).phone }] }).success).toBe(false);
    expect(CreateTanda.safeParse({ ...tanda, members: [m(1), { ...m(2), clabe: m(1).clabe }] }).success).toBe(false);
    expect(CreateTanda.safeParse({ ...tanda, members: [m(1)] }).success).toBe(false);
  });
  it("turnos y estado de ronda", () => {
    expect(recipientOf(2, 3)).toBe(2);
    expect(() => recipientOf(4, 3)).toThrow();
    expect(() => recipientOf(0, 3)).toThrow();
    expect(roundStatus(1, 3, [])).toEqual({ round: 1, recipient: 1, payers: [2, 3], paid: [], pending: [2, 3], complete: false });
    expect(roundStatus(1, 3, [3, 2, 2])).toMatchObject({ paid: [2, 3], pending: [], complete: true });
    expect(() => roundStatus(1, 3, [1])).toThrow(/inválida/);
    expect(potCents(50000n, 3)).toBe(100000n);
  });
});
