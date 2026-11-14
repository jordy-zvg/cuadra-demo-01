import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { clabeCheckDigit, formatMXN, isValidClabe, maskClabe, minCentavos, parsePesos } from "../src/index.js";

describe("money", () => {
  it("convierte pesos a centavos", () => {
    expect(parsePesos("80")).toBe(8000n);
    expect(parsePesos("$1,234.50")).toBe(123450n);
    expect(parsePesos("80.5")).toBe(8050n);
    expect(parsePesos(" 0.07 ")).toBe(7n);
  });
  it("rechaza montos mal formados", () => {
    for (const bad of ["", "abc", "1.234", "-5", "1,23", "1e3", "12.3.4"]) {
      expect(() => parsePesos(bad)).toThrow();
    }
  });
  it("formatea", () => {
    expect(formatMXN(123450n)).toBe("$1,234.50");
    expect(formatMXN(-5n)).toBe("-$0.05");
    expect(formatMXN(100000000n)).toBe("$1,000,000.00");
    expect(minCentavos(1n, 2n)).toBe(1n);
    expect(minCentavos(3n, 2n)).toBe(2n);
  });
  it("propiedad: parse(format(x)) = x", () => {
    fc.assert(fc.property(fc.bigInt({ min: 0n, max: 10n ** 14n }), (x) => parsePesos(formatMXN(x)) === x));
  });
});

describe("clabe", () => {
  it("valida CLABEs conocidas", () => {
    expect(isValidClabe("032180000118359719")).toBe(true);
    expect(isValidClabe("002010077777777771")).toBe(true);
    expect(isValidClabe("032180000118359710")).toBe(false);
    expect(isValidClabe("12345")).toBe(false);
    expect(isValidClabe("03218000011835971a")).toBe(false);
  });
  it("enmascara", () => {
    expect(maskClabe("032180000118359719")).toBe("••••9719");
  });
  it("exige 17 dígitos para calcular", () => {
    expect(() => clabeCheckDigit("123")).toThrow();
  });
  it("propiedad: un solo dígito alterado invalida la CLABE", () => {
    const d17 = fc.stringMatching(/^\d{17}$/);
    fc.assert(
      fc.property(d17, fc.integer({ min: 0, max: 17 }), fc.integer({ min: 1, max: 9 }), (base, pos, delta) => {
        const clabe = base + clabeCheckDigit(base);
        expect(isValidClabe(clabe)).toBe(true);
        const changed = (Number(clabe[pos]) + delta) % 10;
        const tampered = clabe.slice(0, pos) + changed + clabe.slice(pos + 1);
        expect(isValidClabe(tampered)).toBe(false);
      }),
    );
  });
});
