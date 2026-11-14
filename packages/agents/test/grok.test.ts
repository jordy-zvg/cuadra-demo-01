import { describe, expect, it } from "vitest";
import { GROK_DEFAULT_MODEL, GrokInterpreter, type Intent, type Interpreter, RuleInterpreter, interpretWithConsensus, mixedInterpreters } from "../src/index.js";

const extraction = { kind: "add_credit", customer_name: "Doña Lupe", payee_name: null, amount_as_written: "$185", concept: null, question: null };
const reply = (content: unknown, status = 200) =>
  new Response(JSON.stringify(status === 200 ? { choices: [{ message: { role: "assistant", content: typeof content === "string" ? content : JSON.stringify(content) } }] } : { error: "x" }), { status });

function fake(res: () => Response) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fn = (async (url: string | URL, init?: RequestInit) => (calls.push({ url: String(url), init: init ?? {} }), res())) as typeof fetch;
  return { fn, calls };
}

describe("GrokInterpreter", () => {
  it("manda esquema estricto y el texto como mensaje de usuario; convierte el monto en código", async () => {
    const f = fake(() => reply(extraction));
    const r = await new GrokInterpreter({ apiKey: "xai-test", fetch: f.fn }).interpret("Doña Lupe se llevó $185");
    expect(r).toEqual({ kind: "add_credit", customer_name: "Doña Lupe", amount_cents: 18500 });
    expect(f.calls[0]!.url).toBe("https://api.x.ai/v1/chat/completions");
    expect((f.calls[0]!.init.headers as Record<string, string>).Authorization).toBe("Bearer xai-test");
    const body = JSON.parse(String(f.calls[0]!.init.body));
    expect(body.model).toBe(GROK_DEFAULT_MODEL);
    expect(body.messages[1]).toEqual({ role: "user", content: "Doña Lupe se llevó $185" });
    expect(body.response_format).toMatchObject({ type: "json_schema", json_schema: { name: "cuadra_extraction", strict: true } });
    expect(body.response_format.json_schema.schema.properties.kind.enum).toContain("payout");
  });

  it("salida fuera de esquema → unclear; error HTTP → lanza (para caer a reglas)", async () => {
    expect(await new GrokInterpreter({ apiKey: "k", fetch: fake(() => reply({ kind: "transfer_all" })).fn }).interpret("x")).toEqual({ kind: "unclear" });
    await expect(new GrokInterpreter({ apiKey: "k", fetch: fake(() => reply(null, 429)).fn }).interpret("x")).rejects.toThrow("xAI 429");
  });
});

describe("consenso mixto Claude + Grok", () => {
  const fixed = (name: string, intent: Intent): Interpreter => ({ name, interpret: async () => intent });
  const lupe: Intent = { kind: "add_credit", customer_name: "Doña Lupe", amount_cents: 18500 };

  it("alterna los modelos en tres extracciones", () => {
    const names = mixedInterpreters([fixed("claude", lupe), fixed("grok", lupe)], new RuleInterpreter()).map((i) => i.name);
    expect(names).toEqual(["claude|rules", "grok|rules", "claude|rules"]);
    expect(mixedInterpreters([], new RuleInterpreter()).map((i) => i.name)).toEqual(["rules"]);
  });

  it("si Claude y Grok no coinciden en el monto, no hay consenso", async () => {
    const c = await interpretWithConsensus(
      mixedInterpreters([fixed("claude", lupe), fixed("grok", { ...lupe, amount_cents: 1850 })], new RuleInterpreter()),
      "Doña Lupe se llevó $185",
    );
    expect(c.agreed).toBe(false);
  });
});
