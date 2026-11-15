import type { Intent, Interpreter } from "./intent.js";
import { normalizeAmountWords } from "./numbers.js";

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

// Reenvío de la solicitud de cobro. Las frases de tanda, recibos, comprobantes o pagos son otra
// intención ("solicitud de pago" sí es reenvío).
const RESEND_NOT = String.raw`(?!.*\b(?:tandas?|recibos?|comprobantes?|tickets?|transferencias?|dep[oó]sitos?)\b)(?!.*(?<!de\s)\bpagos?\b)`;
const RESEND_VERB = String.raw`(?:vu[eé]lve(?:le)?\s+a\s+(?:mandar|enviar|cobrar)(?:le|selo|sela)?|reenv[ií](?:a|ar)(?:le|selo|sela)?|(?:m[aá]nda|env[ií]a)(?:le|selo|sela)?\s+(?:otra\s+vez|de\s+nuevo))`;
const RESEND_WHAT = String.raw`(?:\s+(?:(?:la|el)\s+)?(?:notificaci[oó]n|cobro|solicitud|recordatorio|petici[oó]n)(?:\s+de\s+(?:pago|cobro))?)`;
const AGAIN = String.raw`(?:\s+(?:otra\s+vez|de\s+nuevo))?`;
// El nombre puede llevar después lo que se reenvía ("a Lupe la notificación"); nada más.
const RESEND_WHO = String.raw`(?:\s+(?:a|de)\s+(.+?)(?:\s+(?:la|el|su)\s+(?:notificaci[oó]n|cobro|solicitud|recordatorio|petici[oó]n)(?:\s+de\s+(?:pago|cobro))?)?(?:\s+(?:otra\s+vez|de\s+nuevo))?)?`;
const resend = (m: RegExpExecArray): Intent => {
  const name = m[1] ? clean(m[1]) : "";
  if (!name) return { kind: "resend_reminder" };
  // "Reenvíale a Lupe su/sus …" con otra cosa que un cobro: no se adivina.
  if (/\bsus?\b/i.test(name)) return { kind: "unclear" };
  return { kind: "resend_reminder", customer_name: name };
};

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
  // "Vuélvele a mandar la notificación", "reenvíale el cobro a Beto", "reenvía el cobro de Lupe",
  // "mándale otra vez el cobro a Lupe", "vuelve a cobrarle a Doña Lupe"
  [new RegExp(String.raw`^${RESEND_NOT}${RESEND_VERB}${AGAIN}${RESEND_WHAT}?${AGAIN}${RESEND_WHO}$`, "i"), resend],
  // "Mándale el cobro otra vez a Lupe"
  [new RegExp(String.raw`^${RESEND_NOT}(?:m[aá]nda|env[ií]a)(?:le|selo|sela)?${RESEND_WHAT}\s+(?:otra\s+vez|de\s+nuevo)${RESEND_WHO}$`, "i"), resend],
  // Cobro por servicio: "Cóbrale a Rosa $350 por la reparación", "cobrarle a Beto 120 de la consulta"
  [new RegExp(String.raw`^(?:c[oó]brale|cobrar(?:le)?|c[oó]brate)\s+a\s+(.+?)\s+${MONEY}\s*(?:(?:por|de|del|de la)\s+)?(.*)$`, "i"),
    (m) => ({
      kind: "add_credit",
      customer_name: clean(m[1]!),
      amount_cents: cents(m[2]!, m[3]),
      charge_now: true,
      ...(m[4] && clean(m[4]) ? { concept: clean(m[4]) } : {}),
    })],
  // "Cóbrale a Doña Lupe", "mándale recordatorio a Beto"
  [/^(?:c[oó]brale|cobrar(?:le)?|m[aá]ndale\s+(?:el\s+)?(?:cobro|recordatorio)|recu[eé]rdale)\s+a\s+(.+)$/i,
    (m) => ({ kind: "send_reminder", customer_name: clean(m[1]!) })],
  // "Paga al de los refrescos $1,200", "págale a la panadería 500"
  [new RegExp(String.raw`^p[aá]ga(?:le)?\s+(?:a\s+)?(?:al|a la|a los|a las|a)\s+(.+?)\s+${MONEY}\s*(.*)$`, "i"),
    (m) => ({ kind: "payout", payee_name: clean(m[1]!), amount_cents: cents(m[2]!, m[3]), ...(m[4] && clean(m[4]) ? { concept: clean(m[4]) } : {}) })],
  // "¿Cuánto me debe Doña Lupe?"
  [/^\s*¿?\s*cu[aá]nto\s+(?:me\s+)?debe\s+(.+?)\??$/i, (m) => ({ kind: "query_balance", customer_name: clean(m[1]!) })],
  // Tanda: "cobra la tanda", "arranca la ronda", "¿cómo va la tanda?", "recuérdales la tanda"
  [/^\s*(?:c[oó]bra|arranca|empieza|inicia|abre)\s+(?:la\s+)?(?:tanda|ronda|siguiente\s+ronda)\b/i, () => ({ kind: "start_tanda_round" })],
  [/\b(?:recu[eé]rdales|recordatorio)\b.*\btanda\b/i, () => ({ kind: "tanda_reminder" })],
  [/\b(?:c[oó]mo\s+va|qui[eé]n\s+(?:falta|ha\s+pagado)|estado\s+de)\b.*\btanda\b|\btanda\b.*\bqui[eé]n\s+falta\b/i, () => ({ kind: "query_tanda" })],
  // "¿Cuánto me queda del tope?", "¿cómo voy con mi cuenta?"
  [/\b(tope|l[ií]mite|nivel\s*2\s*bis)\b/i, () => ({ kind: "query_limit" })],
  // "Agrega a Joel, 55 1234 5678", "da de alta a Joel", "nuevo cliente Joel cel 5512345678"
  [/^\s*(?:agrega(?:r)?|registra(?:r)?|da(?:r)?\s+de\s+alta|alta\s+(?:de|a)|nuevo\s+cliente)\s+(?:a(?:l)?\s+)?(?:cliente\s+)?(.+?)(?:[,\s]+(?:cel(?:ular)?|tel(?:[eé]fono)?|n[uú]mero)?[:\s]*(\+?\d[\d\s-]{8,}\d))?\s*$/i,
    (m) => {
      const d = (m[2] ?? "").replace(/\D/g, "");
      const phone = d.length >= 10 ? d.slice(-10) : undefined;
      return { kind: "create_customer", customer_name: clean(m[1]!), ...(phone ? { phone } : {}) };
    }],
  // "¿Quién me debe?", "saldos"
  [/^\s*¿?\s*(?:qui[eé]n(?:es)?\s+me\s+deben?|saldos|c[oó]mo\s+voy)\s*\??$/i, () => ({ kind: "query_balance" })],
];

export class RuleInterpreter implements Interpreter {
  readonly name = "rules";
  async interpret(text: string): Promise<Intent> {
    // "cinco pesos" → "$5": los montos con letra se leen igual que los escritos con número.
    const t = normalizeAmountWords(text.trim().replace(/\s+/g, " "));
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
