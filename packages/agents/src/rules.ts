import type { Intent, Interpreter } from "./intent.js";

/**
 * Intérprete determinista para español mexicano coloquial. Es el respaldo de la demo y la
 * referencia para evaluar al LLM. Solo reconoce frases claras; lo demás es "unclear".
 */
const MONEY = String.raw`\$?\s*(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?\s*(?:pesos|varos|mxn)?`;

function cents(int: string, dec: string | undefined): number {
  return Number(int.replace(/,/g, "")) * 100 + Number((dec ?? "").padEnd(2, "0") || "0");
}

const clean = (s: string) => s.trim().replace(/[.,;:!?¡¿]+$/g, "").trim();

const OUT_OF_SCOPE = /\b(chiste|clima|f[uú]tbol|receta|pol[ií]tica|horóscopo|horoscopo|canci[oó]n|cr[eé]dito bancario|pr[eé]stamo|inversi[oó]n|bitcoin|cripto)\b/i;

const PATTERNS: Array<[RegExp, (m: RegExpExecArray) => Intent]> = [
  // "Doña Lupe se llevó $185", "Beto se llevó 2 refrescos de $40"
  [new RegExp(String.raw`^(.+?)\s+se\s+(?:llev[oó]|fi[oó]|ech[oó] al fiado)\s+(?:.*?\s)?${MONEY}\s*(.*)$`, "i"),
    (m) => ({ kind: "add_credit", customer_name: clean(m[1]!), amount_cents: cents(m[2]!, m[3]), ...(m[4] && clean(m[4]) ? { concept: clean(m[4]) } : {}) })],
  // "Anótale/fíale $185 a Doña Lupe"
  [new RegExp(String.raw`^(?:an[oó]tale|f[ií]ale|apunta(?:le)?)\s+${MONEY}\s+a\s+(.+)$`, "i"),
    (m) => ({ kind: "add_credit", customer_name: clean(m[3]!), amount_cents: cents(m[1]!, m[2]) })],
  // "Doña Lupe me pagó $100 en efectivo" / "Lupe abonó 50"
  [new RegExp(String.raw`^(.+?)\s+(?:me\s+)?(?:pag[oó]|abon[oó]|dio)\s+${MONEY}(?:\s+en\s+efectivo)?\s*$`, "i"),
    (m) => ({ kind: "register_cash_payment", customer_name: clean(m[1]!), amount_cents: cents(m[2]!, m[3]) })],
  // "QR para Doña Lupe", "cóbrale con QR a Beto" (cobro en mostrador)
  [/^(?:(?:hazme\s+(?:un|el)\s+)?qr\s+(?:para|de|a)|c[oó]brale\s+con\s+qr\s+a|cobro\s+con\s+qr\s+(?:a|para))\s+(.+)$/i,
    (m) => ({ kind: "charge_qr", customer_name: clean(m[1]!) })],
  // "Cóbrale a Doña Lupe", "mándale recordatorio a Beto"
  [/^(?:c[oó]brale|cobrar(?:le)?|m[aá]ndale\s+(?:el\s+)?(?:cobro|recordatorio)|recu[eé]rdale)\s+a\s+(.+)$/i,
    (m) => ({ kind: "send_reminder", customer_name: clean(m[1]!) })],
  // "Paga al de los refrescos $1,200", "págale a la panadería 500"
  [new RegExp(String.raw`^p[aá]ga(?:le)?\s+(?:a\s+)?(?:al|a la|a los|a las|a)\s+(.+?)\s+${MONEY}\s*(.*)$`, "i"),
    (m) => ({ kind: "payout", payee_name: clean(m[1]!), amount_cents: cents(m[2]!, m[3]), ...(m[4] && clean(m[4]) ? { concept: clean(m[4]) } : {}) })],
  // "¿Cuánto me debe Doña Lupe?"
  [/^\s*¿?\s*cu[aá]nto\s+(?:me\s+)?debe\s+(.+?)\??$/i, (m) => ({ kind: "query_balance", customer_name: clean(m[1]!) })],
  // "¿Quién me debe?", "saldos"
  [/^\s*¿?\s*(?:qui[eé]n(?:es)?\s+me\s+deben?|saldos|c[oó]mo\s+voy)\s*\??$/i, () => ({ kind: "query_balance" })],
];

export class RuleInterpreter implements Interpreter {
  readonly name = "rules";
  async interpret(text: string): Promise<Intent> {
    const t = text.trim().replace(/\s+/g, " ");
    if (OUT_OF_SCOPE.test(t)) return { kind: "out_of_scope" };
    for (const [re, build] of PATTERNS) {
      const m = re.exec(t);
      if (m) {
        const intent = build(m);
        if ("amount_cents" in intent && !(intent.amount_cents > 0)) continue;
        return intent;
      }
    }
    return { kind: "unclear" };
  }
}
