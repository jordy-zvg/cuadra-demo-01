import { z } from "zod";

/**
 * Lo único que un intérprete (LLM o reglas) puede producir. Sin ids, sin CLABEs:
 * nombres tal como los dijo el comercio y montos en centavos. El código resuelve el resto.
 */
export const Intent = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("add_credit"), customer_name: z.string().min(1).max(80), amount_cents: z.number().int().positive().safe(), concept: z.string().max(140).optional() }),
  z.object({ kind: z.literal("register_cash_payment"), customer_name: z.string().min(1).max(80), amount_cents: z.number().int().positive().safe() }),
  z.object({ kind: z.literal("send_reminder"), customer_name: z.string().min(1).max(80) }),
  z.object({ kind: z.literal("charge_qr"), customer_name: z.string().min(1).max(80) }),
  z.object({ kind: z.literal("payout"), payee_name: z.string().min(1).max(80), amount_cents: z.number().int().positive().safe(), concept: z.string().max(140).optional() }),
  z.object({ kind: z.literal("query_balance"), customer_name: z.string().max(80).optional() }),
  z.object({ kind: z.literal("query_limit") }),
  z.object({ kind: z.literal("start_tanda_round") }),
  z.object({ kind: z.literal("query_tanda") }),
  z.object({ kind: z.literal("tanda_reminder") }),
  z.object({ kind: z.literal("out_of_scope") }),
  z.object({ kind: z.literal("unclear"), question: z.string().max(200).optional() }),
]);
export type Intent = z.infer<typeof Intent>;

export interface Interpreter {
  readonly name: string;
  interpret(text: string): Promise<Intent>;
}

/** Compara intenciones ignorando mayúsculas, acentos y espacios en nombres. */
export function normalizeName(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\b(don|dona|doña|sr|sra|senor|senora|la|el|al|del|de)\b/g, " ")
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function key(i: Intent): string {
  const o: Record<string, unknown> = { kind: i.kind };
  if ("customer_name" in i && i.customer_name) o.n = normalizeName(i.customer_name);
  if ("payee_name" in i) o.p = normalizeName(i.payee_name);
  if ("amount_cents" in i) o.a = i.amount_cents;
  return JSON.stringify(o);
}

export type Consensus = { agreed: true; intent: Intent; votes: number } | { agreed: false; candidates: Intent[] };

/**
 * Consenso de extracciones independientes (BRIEF §9): si no coinciden en tipo, nombre y
 * monto, no se adivina; se pregunta al humano.
 */
export function consensus(results: readonly Intent[]): Consensus {
  if (results.length === 0) return { agreed: false, candidates: [] };
  const groups = new Map<string, Intent[]>();
  for (const r of results) groups.set(key(r), [...(groups.get(key(r)) ?? []), r]);
  if (groups.size === 1) return { agreed: true, intent: results[0]!, votes: results.length };
  return { agreed: false, candidates: [...groups.values()].map((g) => g[0]!) };
}

/** Corre N extracciones independientes en paralelo y aplica consenso. */
export async function interpretWithConsensus(interpreters: readonly Interpreter[], text: string): Promise<Consensus> {
  const results = await Promise.all(interpreters.map((i) => i.interpret(text).catch(() => ({ kind: "unclear" }) as Intent)));
  return consensus(results.map((r) => Intent.parse(r)));
}
