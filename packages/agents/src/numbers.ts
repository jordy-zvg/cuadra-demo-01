/**
 * Montos escritos con letra ("cinco pesos", "ciento ochenta y cinco", "dos mil quinientos").
 * Solo enteros de pesos, de 1 a 999,999. Es código determinista: el LLM nunca convierte montos.
 */
const UNITS: Record<string, number> = {
  cero: 0, un: 1, uno: 1, una: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6, siete: 7, ocho: 8, nueve: 9,
  diez: 10, once: 11, doce: 12, trece: 13, catorce: 14, quince: 15, dieciseis: 16, diecisiete: 17, dieciocho: 18,
  diecinueve: 19, veinte: 20, veintiun: 21, veintiuno: 21, veintiuna: 21, veintidos: 22, veintitres: 23,
  veinticuatro: 24, veinticinco: 25, veintiseis: 26, veintisiete: 27, veintiocho: 28, veintinueve: 29,
};
const TENS: Record<string, number> = { treinta: 30, cuarenta: 40, cincuenta: 50, sesenta: 60, setenta: 70, ochenta: 80, noventa: 90 };
const HUNDREDS: Record<string, number> = {
  cien: 100, ciento: 100, doscientos: 200, doscientas: 200, trescientos: 300, trescientas: 300, cuatrocientos: 400,
  cuatrocientas: 400, quinientos: 500, quinientas: 500, seiscientos: 600, seiscientas: 600, setecientos: 700,
  setecientas: 700, ochocientos: 800, ochocientas: 800, novecientos: 900, novecientas: 900,
};

const plain = (w: string) => w.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
const isNumberWord = (w: string) => {
  const p = plain(w);
  return p in UNITS || p in TENS || p in HUNDREDS || p === "mil";
};

/** "ciento ochenta y cinco" → 185; null si la secuencia no es un número válido. */
export function wordsToNumber(words: string[]): number | null {
  let total = 0;
  let group = 0;
  let last: "unit" | "ten" | "hundred" | "y" | "mil" | null = null;
  for (const raw of words) {
    const w = plain(raw);
    if (w === "y") {
      if (last !== "ten") return null;
      last = "y";
    } else if (w in HUNDREDS) {
      if (group !== 0) return null;
      group = HUNDREDS[w]!;
      last = "hundred";
    } else if (w in TENS) {
      if (group % 100 !== 0) return null;
      group += TENS[w]!;
      last = "ten";
    } else if (w in UNITS) {
      if (last === "unit" || (group % 100 !== 0 && last !== "y")) return null;
      group += UNITS[w]!;
      last = "unit";
    } else if (w === "mil") {
      if (total !== 0) return null;
      total = (group || 1) * 1000;
      group = 0;
      last = "mil";
    } else {
      return null;
    }
  }
  if (last === "y") return null;
  const n = total + group;
  return n > 0 && n < 1_000_000 ? n : null;
}

const CURRENCY = /^(pesos?|varos?|mxn)$/i;

/**
 * Cambia los montos escritos con letra por "$N" para que el resto del intérprete los lea igual
 * que "$185". "un/una/uno" sueltos solo cuentan si dicen "peso(s)" ("una coca" no es $1).
 */
export function normalizeAmountWords(text: string): string {
  const tokens = text.split(/(\s+)/);
  const out: string[] = [];
  let i = 0;
  while (i < tokens.length) {
    const t = tokens[i]!;
    if (!/\s/.test(t) && isNumberWord(t.replace(/[.,;:!?]+$/, ""))) {
      const words: string[] = [];
      let j = i;
      let end = i;
      while (j < tokens.length) {
        const w = tokens[j]!;
        if (/\s/.test(w)) { j++; continue; }
        const bare = w.replace(/[.,;:!?]+$/, "");
        if (isNumberWord(bare) || (plain(bare) === "y" && words.length > 0)) {
          words.push(bare);
          end = j;
          if (bare !== w) break; // la puntuación cierra el monto
          j++;
        } else break;
      }
      while (words.length && plain(words[words.length - 1]!) === "y") { words.pop(); end -= 2; }
      const n = wordsToNumber(words);
      // ¿Sigue "pesos"? (se salta el espacio)
      const next = tokens[end + 2];
      const saysCurrency = next !== undefined && CURRENCY.test(next.replace(/[.,;:!?]+$/, ""));
      const lone = words.length === 1 && ["un", "uno", "una"].includes(plain(words[0]!));
      if (n !== null && (!lone || saysCurrency)) {
        out.push(`$${n}`);
        i = end + 1;
        if (saysCurrency) i = end + 3; // también consume "pesos"
        continue;
      }
    }
    out.push(t);
    i++;
  }
  return out.join("");
}
