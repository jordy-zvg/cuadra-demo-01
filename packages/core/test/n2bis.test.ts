import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { n2bisStatus, parseUdiValue, udisToCents } from "../src/index.js";

const UDI = parseUdiValue("8.500000"); // valor de ejemplo para los tests

describe("Nivel 2 Bis", () => {
  it("parsea el valor de la UDI exacto, sin floats", () => {
    expect(parseUdiValue("8.651234")).toBe(8_651_234n);
    expect(parseUdiValue("8.5")).toBe(8_500_000n);
    for (const bad of ["", "abc", "8.1234567", "-1", "0"]) expect(() => parseUdiValue(bad)).toThrow();
  });
  it("tope = 15,000 UDIs; no digital ≤ 3,000 UDIs", () => {
    const s = n2bisStatus({ udi: UDI, digital_cents: 0n, non_digital_cents: 0n });
    expect(s.limit_cents).toBe(12_750_000n); // 15,000 × 8.5 = $127,500.00
    expect(s.non_digital_limit_cents).toBe(2_550_000n); // 3,000 × 8.5
    expect(s).toMatchObject({ pct: 0, level: "ok", remaining_cents: 12_750_000n });
  });
  it("niveles: aviso 70 %, cerca 90 %, excedido > 100 %", () => {
    const at = (c: bigint) => n2bisStatus({ udi: UDI, digital_cents: c, non_digital_cents: 0n });
    expect(at(8_924_999n).level).toBe("ok");
    expect(at(8_925_000n).level).toBe("aviso");
    expect(at(11_475_000n).level).toBe("cerca");
    expect(at(12_750_000n)).toMatchObject({ level: "cerca", pct: 100, remaining_cents: 0n });
    expect(at(12_750_001n)).toMatchObject({ level: "excedido", remaining_cents: 0n });
    expect(at(12_750_001n).message).toMatch(/Nivel 3/);
  });
  it("marca cuando lo no digital pasa de 3,000 UDIs", () => {
    expect(n2bisStatus({ udi: UDI, digital_cents: 0n, non_digital_cents: 2_550_001n }).non_digital_over).toBe(true);
    expect(n2bisStatus({ udi: UDI, digital_cents: 0n, non_digital_cents: 2_550_000n }).non_digital_over).toBe(false);
    expect(() => n2bisStatus({ udi: UDI, digital_cents: -1n, non_digital_cents: 0n })).toThrow();
  });
  it("propiedad: restante + recibido = tope mientras no se exceda", () => {
    fc.assert(fc.property(fc.bigInt({ min: 0n, max: 12_750_000n }), (c) => {
      const s = n2bisStatus({ udi: UDI, digital_cents: c, non_digital_cents: 0n });
      return s.remaining_cents + s.received_cents === s.limit_cents;
    }));
    expect(udisToCents(1n, parseUdiValue("8.123456"))).toBe(812n);
  });
});
