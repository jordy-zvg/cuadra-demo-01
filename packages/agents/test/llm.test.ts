import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { AnthropicInterpreter, FallbackInterpreter, type LlmExtraction, RuleInterpreter, toIntent } from "../src/index.js";

const base: LlmExtraction = { kind: "add_credit", customer_name: "Doña Lupe", payee_name: null, amount_as_written: "$185", concept: null, question: null };

describe("toIntent: el código convierte montos, no el LLM", () => {
  it("monto literal → centavos exactos", () => {
    expect(toIntent(base)).toEqual({ kind: "add_credit", customer_name: "Doña Lupe", amount_cents: 18500 });
    expect(toIntent({ ...base, amount_as_written: "$1,250.50" })).toMatchObject({ amount_cents: 125050 });
    expect(toIntent({ ...base, amount_as_written: "185 pesos" })).toMatchObject({ amount_cents: 18500 });
  });
  it("monto ilegible, cero o sin nombre → pregunta", () => {
    for (const bad of [{ amount_as_written: "ciento ochenta" }, { amount_as_written: "0" }, { amount_as_written: null }, { customer_name: " " }]) {
      expect(toIntent({ ...base, ...bad }).kind).toBe("unclear");
    }
  });
  it("pagos, recordatorios, consultas y fuera de alcance", () => {
    expect(toIntent({ ...base, kind: "payout", customer_name: null, payee_name: "de los refrescos", amount_as_written: "$1,200" })).toEqual({ kind: "payout", payee_name: "de los refrescos", amount_cents: 120000 });
    expect(toIntent({ ...base, kind: "send_reminder" })).toEqual({ kind: "send_reminder", customer_name: "Doña Lupe" });
    expect(toIntent({ ...base, kind: "query_balance", customer_name: null })).toEqual({ kind: "query_balance" });
    expect(toIntent({ ...base, kind: "out_of_scope" })).toEqual({ kind: "out_of_scope" });
    expect(toIntent({ ...base, kind: "unclear", question: "¿Cuánto?" })).toEqual({ kind: "unclear", question: "¿Cuánto?" });
  });
});

describe("AnthropicInterpreter con cliente falso", () => {
  const fake = (resp: unknown, calls: unknown[] = []) =>
    ({ beta: { messages: { parse: async (req: unknown) => (calls.push(req), resp) } } }) as unknown as Anthropic;

  it("manda esquema, esfuerzo bajo y fallback; el texto va como mensaje de usuario", async () => {
    const calls: Array<Record<string, any>> = [];
    const r = await new AnthropicInterpreter({ client: fake({ stop_reason: "end_turn", parsed_output: base }, calls) }).interpret("Doña Lupe se llevó $185");
    expect(r).toMatchObject({ kind: "add_credit", amount_cents: 18500 });
    expect(calls[0]).toMatchObject({ model: "claude-opus-5-5", fallbacks: "default", output_config: { effort: "low" }, messages: [{ role: "user", content: "Doña Lupe se llevó $185" }] });
  });
  it("rechazo o salida vacía → unclear", async () => {
    expect(await new AnthropicInterpreter({ client: fake({ stop_reason: "refusal", parsed_output: null }) }).interpret("x")).toEqual({ kind: "unclear" });
    expect(await new AnthropicInterpreter({ client: fake({ stop_reason: "end_turn", parsed_output: null }) }).interpret("x")).toEqual({ kind: "unclear" });
  });
  it("si la API falla, el respaldo por reglas responde", async () => {
    const broken = { beta: { messages: { parse: async () => { throw new Error("red"); } } } } as unknown as Anthropic;
    const i = new FallbackInterpreter(new AnthropicInterpreter({ client: broken }), new RuleInterpreter());
    expect(await i.interpret("Doña Lupe se llevó $185")).toMatchObject({ kind: "add_credit", amount_cents: 18500 });
  });
});
