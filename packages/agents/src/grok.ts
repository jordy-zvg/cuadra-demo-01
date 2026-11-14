/**
 * Intérprete con Grok (xAI). Mismo contrato que el de Claude: mismo prompt, mismo esquema de
 * extracción y misma conversión a centavos en código (toIntent). Un modelo de otro proveedor hace
 * que el consenso de tres extracciones sea independiente de verdad (BRIEF §9).
 * API: https://api.x.ai/v1/chat/completions con response_format json_schema estricto
 * (https://docs.x.ai/docs/guides/structured-outputs).
 */
import * as z from "zod/v4";
import { type Intent, type Interpreter } from "./intent.js";
import { FallbackInterpreter, LlmExtraction, SYSTEM_PROMPT, toIntent } from "./llm.js";

export const XAI_BASE_URL = "https://api.x.ai/v1";
/** Sin razonamiento: la extracción es corta y conviene la latencia baja. Se cambia con XAI_MODEL. */
export const GROK_DEFAULT_MODEL = "grok-4.20-0309-non-reasoning";

const EXTRACTION_SCHEMA = z.toJSONSchema(LlmExtraction);

const Completion = z.object({
  choices: z.array(z.object({ message: z.object({ content: z.string().nullable(), refusal: z.string().nullable().optional() }) })).min(1),
});

export interface GrokInterpreterOpts {
  apiKey: string;
  model?: string;
  baseUrl?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export class GrokInterpreter implements Interpreter {
  readonly name = "grok";
  private readonly http: typeof fetch;

  constructor(private readonly opts: GrokInterpreterOpts) {
    if (!opts.apiKey) throw new Error("Falta la API key de xAI");
    this.http = opts.fetch ?? fetch;
  }

  async interpret(text: string): Promise<Intent> {
    const res = await this.http(`${this.opts.baseUrl ?? XAI_BASE_URL}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.opts.apiKey}`, "content-type": "application/json" },
      signal: AbortSignal.timeout(this.opts.timeoutMs ?? 15_000),
      body: JSON.stringify({
        model: this.opts.model ?? GROK_DEFAULT_MODEL,
        temperature: 0,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: text },
        ],
        response_format: { type: "json_schema", json_schema: { name: "cuadra_extraction", schema: EXTRACTION_SCHEMA, strict: true } },
      }),
    });
    // Errores de red o de la API suben: FallbackInterpreter los convierte en reglas deterministas.
    if (!res.ok) throw new Error(`xAI ${res.status}`);
    const msg = Completion.parse(await res.json()).choices[0]!.message;
    if (msg.refusal || !msg.content) return { kind: "unclear" };
    const parsed = LlmExtraction.safeParse(JSON.parse(msg.content));
    return parsed.success ? toIntent(parsed.data) : { kind: "unclear" };
  }
}

/**
 * Reparte N extracciones entre los modelos disponibles (Claude, Grok, Claude...). Cada una cae a
 * las reglas si su proveedor falla. Sin modelos, solo reglas.
 */
export function mixedInterpreters(models: readonly Interpreter[], rules: Interpreter, n = 3): Interpreter[] {
  if (models.length === 0) return [rules];
  return Array.from({ length: n }, (_, i) => new FallbackInterpreter(models[i % models.length]!, rules));
}
