import { describe, expect, it } from "vitest";
import { type Intent, RuleInterpreter, consensus, interpretWithConsensus, normalizeName } from "../src/index.js";

const r = new RuleInterpreter();
const cases: Array<[string, Intent]> = [
  ["Doña Lupe se llevó $185", { kind: "add_credit", customer_name: "Doña Lupe", amount_cents: 18500 }],
  ["doña lupe se llevo 185 pesos", { kind: "add_credit", customer_name: "doña lupe", amount_cents: 18500 }],
  ["Beto se fió $1,250.50 de cerveza", { kind: "add_credit", customer_name: "Beto", amount_cents: 125050, concept: "de cerveza" }],
  ["Anótale $80 a Chela", { kind: "add_credit", customer_name: "Chela", amount_cents: 8000 }],
  ["Doña Lupe me pagó $100 en efectivo", { kind: "register_cash_payment", customer_name: "Doña Lupe", amount_cents: 10000 }],
  ["Cóbrale a Doña Lupe", { kind: "send_reminder", customer_name: "Doña Lupe" }],
  ["mándale recordatorio a Beto.", { kind: "send_reminder", customer_name: "Beto" }],
  ["vuelvele a mandar la notificacion", { kind: "resend_reminder" }],
  ["Vuélvele a mandar la notificación a Doña Lupe", { kind: "resend_reminder", customer_name: "Doña Lupe" }],
  ["reenvíale el cobro a Beto", { kind: "resend_reminder", customer_name: "Beto" }],
  ["Reenvía la solicitud de pago", { kind: "resend_reminder" }],
  ["mándale otra vez el cobro a Lupe", { kind: "resend_reminder", customer_name: "Lupe" }],
  ["mándale el cobro otra vez a Lupe", { kind: "resend_reminder", customer_name: "Lupe" }],
  ["envíale de nuevo la petición de pago a Chela", { kind: "resend_reminder", customer_name: "Chela" }],
  ["Reenvía el cobro de Doña Lupe", { kind: "resend_reminder", customer_name: "Doña Lupe" }],
  ["Reenviar el cobro a Lupe", { kind: "resend_reminder", customer_name: "Lupe" }],
  ["reenviarle la notificación", { kind: "resend_reminder" }],
  ["Reenvía cobro a Lupe", { kind: "resend_reminder", customer_name: "Lupe" }],
  ["Reenvíasela a Lupe", { kind: "resend_reminder", customer_name: "Lupe" }],
  ["Vuelve a cobrarle a Doña Lupe", { kind: "resend_reminder", customer_name: "Doña Lupe" }],
  ["Reenvía la solicitud de Beto", { kind: "resend_reminder", customer_name: "Beto" }],
  // No son reenvíos de un cobro al cliente
  ["Reenvía el recordatorio a la tanda", { kind: "tanda_reminder" }],
  ["Mándale otra vez el recordatorio a los de la tanda", { kind: "tanda_reminder" }],
  ["Reenvíale a Lupe su recibo", { kind: "unclear" }],
  ["reenvía el pago a Refrescos Pérez", { kind: "unclear" }],
  ["Paga al de los refrescos $1,200", { kind: "payout", payee_name: "de los refrescos", amount_cents: 120000 }],
  ["págale a la panadería 500", { kind: "payout", payee_name: "panadería", amount_cents: 50000 }],
  ["¿Cuánto me debe Doña Lupe?", { kind: "query_balance", customer_name: "Doña Lupe" }],
  ["¿Quién me debe?", { kind: "query_balance" }],
  ["Cobra la tanda", { kind: "start_tanda_round" }],
  ["arranca la siguiente ronda", { kind: "start_tanda_round" }],
  ["¿Cómo va la tanda?", { kind: "query_tanda" }],
  ["recuérdales la tanda a los que faltan", { kind: "tanda_reminder" }],
  ["cuéntame un chiste", { kind: "out_of_scope" }],
  ["hola", { kind: "unclear" }],
];

describe("intérprete por reglas", () => {
  it.each(cases)("%s", async (text, expected) => {
    expect(await r.interpret(text)).toEqual(expected);
  });
});

describe("consenso", () => {
  const a: Intent = { kind: "add_credit", customer_name: "Doña Lupe", amount_cents: 18500 };
  it("coinciden (ignorando 'doña', acentos y mayúsculas)", () => {
    expect(consensus([a, { ...a, customer_name: "lupe" }, { ...a, customer_name: "LUPE" }])).toMatchObject({ agreed: true, votes: 3 });
  });
  it("montos distintos → se pregunta", () => {
    const c = consensus([a, a, { ...a, amount_cents: 1850 }]);
    expect(c.agreed).toBe(false);
    if (!c.agreed) expect(c.candidates).toHaveLength(2);
  });
  it("si un intérprete falla cuenta como 'unclear' y rompe el consenso", async () => {
    const boom = { name: "x", interpret: async (): Promise<Intent> => { throw new Error("x"); } };
    expect((await interpretWithConsensus([r, r, boom], "Doña Lupe se llevó $185")).agreed).toBe(false);
    expect((await interpretWithConsensus([r, r, r], "Doña Lupe se llevó $185")).agreed).toBe(true);
  });
  it("normaliza nombres", () => {
    expect(normalizeName("Doña Lupé ")).toBe("lupe");
    expect(normalizeName("al de los refrescos")).toBe("los refrescos");
  });
});

describe("consenso entre cobrar y reenviar", () => {
  it("con nombre, send_reminder y resend_reminder cuentan como la misma intención", () => {
    const c = consensus([
      { kind: "send_reminder", customer_name: "Doña Lupe" },
      { kind: "resend_reminder", customer_name: "doña lupe" },
      { kind: "send_reminder", customer_name: "Doña Lupe" },
    ]);
    expect(c.agreed).toBe(true);
    expect(consensus([{ kind: "resend_reminder" }, { kind: "send_reminder", customer_name: "Lupe" }]).agreed).toBe(false);
  });
});
