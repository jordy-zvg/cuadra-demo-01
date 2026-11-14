import { describe, expect, it } from "vitest";
import { realPhone10 } from "../src/charges.js";

describe("realPhone10: solo celulares mexicanos reales, sin recortar", () => {
  it("acepta 10 dígitos, +52 y +52 1", () => {
    expect(realPhone10("8331550510")).toBe("8331550510");
    expect(realPhone10("+52 833 155 0510")).toBe("8331550510");
    expect(realPhone10("+5218331550510")).toBe("8331550510");
  });

  it("rechaza longitudes que obligarían a recortar (mandaría el cobro a otra persona)", () => {
    expect(realPhone10("833155051099")).toBeNull(); // dos dígitos de más
    expect(realPhone10("18331550510")).toBeNull();
    expect(realPhone10("+1 833 155 0510 2")).toBeNull();
    expect(realPhone10("833155051")).toBeNull();
  });

  it("rechaza los ficticios de la demo (empiezan con 0) y vacíos", () => {
    expect(realPhone10("+520000000101")).toBeNull();
    expect(realPhone10("0522222222")).toBeNull();
    expect(realPhone10("")).toBeNull();
    expect(realPhone10(null)).toBeNull();
  });
});
