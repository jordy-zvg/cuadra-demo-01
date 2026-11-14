import { describe, expect, it } from "vitest";
import { normalizeAmountWords, wordsToNumber } from "../src/numbers.js";
import { RuleInterpreter } from "../src/rules.js";

const w = (s: string) => wordsToNumber(s.split(" "));

describe("montos con letra", () => {
  it("convierte números comunes", () => {
    expect(w("cinco")).toBe(5);
    expect(w("quince")).toBe(15);
    expect(w("veintidós")).toBe(22);
    expect(w("cuarenta y cinco")).toBe(45);
    expect(w("cien")).toBe(100);
    expect(w("ciento ochenta y cinco")).toBe(185);
    expect(w("quinientos")).toBe(500);
    expect(w("mil")).toBe(1000);
    expect(w("dos mil quinientos")).toBe(2500);
    expect(w("mil doscientos cincuenta")).toBe(1250);
  });

  it("rechaza secuencias que no son un número", () => {
    expect(w("cinco cinco")).toBeNull();
    expect(w("cuarenta y")).toBeNull();
    expect(w("cien cien")).toBeNull();
    expect(w("cinco y")).toBeNull();
    expect(w("mil mil")).toBeNull();
    expect(w("cero")).toBeNull();
    expect(w("hola")).toBeNull();
  });

  it("reescribe el texto con $N", () => {
    expect(normalizeAmountWords("El señor Joel se llevó cinco pesos")).toBe("El señor Joel se llevó $5");
    expect(normalizeAmountWords("Doña Lupe se llevó ciento ochenta y cinco")).toBe("Doña Lupe se llevó $185");
    expect(normalizeAmountWords("Beto se llevó un peso")).toBe("Beto se llevó $1");
    expect(normalizeAmountWords("Beto se llevó una coca de veinte pesos")).toBe("Beto se llevó una coca de $20");
    expect(normalizeAmountWords("Cóbrale a Doña Lupe")).toBe("Cóbrale a Doña Lupe");
  });

  it("el intérprete de reglas entiende montos con letra", async () => {
    const r = new RuleInterpreter();
    expect(await r.interpret("El señor Joel se llevó cinco pesos")).toEqual({ kind: "add_credit", customer_name: "El señor Joel", amount_cents: 500 });
    expect(await r.interpret("Doña Lupe se llevó doscientos cincuenta pesos")).toMatchObject({ amount_cents: 25000 });
  });

  it("alta de cliente por reglas", async () => {
    const r = new RuleInterpreter();
    expect(await r.interpret("Agrega a Joel, 55 1234 5678")).toEqual({ kind: "create_customer", customer_name: "Joel", phone: "5512345678" });
    expect(await r.interpret("Da de alta a Joel Hernández")).toEqual({ kind: "create_customer", customer_name: "Joel Hernández" });
    expect(await r.interpret("nuevo cliente Rosa cel +52 1 55 9876 5432")).toEqual({ kind: "create_customer", customer_name: "Rosa", phone: "5598765432" });
  });
});
