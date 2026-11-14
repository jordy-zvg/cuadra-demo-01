import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  type JournalEntry,
  LedgerError,
  abonoIdentificado,
  abonoSinIdentificar,
  accountBalance,
  appendEntries,
  devolucionSaldoAFavor,
  fiado,
  identificarAbono,
  pagoConfirmado,
  pagoProveedorCreado,
  reverso,
  tandaAportacion,
  tandaDispersion,
  validateEntry,
} from "../src/index.js";

const M = "m1";
let n = 0;
const key = () => `k${++n}`;
const b = (amount: bigint) => ({ merchant_id: M, idempotency_key: key(), amount });
const sums = (e: JournalEntry) => [
  e.lines.reduce((s, l) => s + l.debit, 0n),
  e.lines.reduce((s, l) => s + l.credit, 0n),
];
const line = (e: JournalEntry, account: string) => e.lines.filter((l) => l.account === account);

describe("asientos", () => {
  it("fiado: D 1200 / H 4100", () => {
    const e = fiado({ ...b(8000n), customer_id: "c1" });
    expect(e.lines).toEqual([
      { account: "1200", subaccount: "c1", debit: 8000n, credit: 0n },
      { account: "4100", debit: 0n, credit: 8000n },
    ]);
  });

  it("abono identificado hasta el saldo, excedente a 2100", () => {
    const exact = abonoIdentificado({ ...b(5000n), customer_id: "c1", customer_balance: 8000n });
    expect(line(exact, "1200")[0]!.credit).toBe(5000n);
    expect(line(exact, "2100")).toHaveLength(0);

    const over = abonoIdentificado({ ...b(10000n), customer_id: "c1", customer_balance: 8000n });
    expect(line(over, "1100")[0]!.debit).toBe(10000n);
    expect(line(over, "1200")[0]!.credit).toBe(8000n);
    expect(line(over, "2100")[0]).toMatchObject({ credit: 2000n, subaccount: "c1" });

    const noDebt = abonoIdentificado({ ...b(300n), customer_id: "c1", customer_balance: -50n });
    expect(line(noDebt, "1200")).toHaveLength(0);
    expect(line(noDebt, "2100")[0]!.credit).toBe(300n);
  });

  it("abono sin identificar y su identificación posterior", () => {
    const a = abonoSinIdentificar(b(700n));
    expect(a.lines.map((l) => l.account)).toEqual(["1100", "1300"]);
    const i = identificarAbono({ ...b(700n), customer_id: "c1", customer_balance: 500n });
    expect(line(i, "1300")[0]!.debit).toBe(700n);
    expect(line(i, "1200")[0]!.credit).toBe(500n);
    expect(line(i, "2100")[0]!.credit).toBe(200n);
  });

  it("pago a proveedor: creado → confirmado, o fallido con reverso", () => {
    const creado = pagoProveedorCreado(b(1000n));
    expect(creado.lines.map((l) => [l.account, l.debit, l.credit])).toEqual([
      ["5100", 1000n, 0n],
      ["2400", 0n, 1000n],
    ]);
    const conf = pagoConfirmado(b(1000n));
    expect(conf.lines.map((l) => [l.account, l.debit, l.credit])).toEqual([
      ["2400", 1000n, 0n],
      ["1100", 0n, 1000n],
    ]);
    const rev = reverso(creado, "rev1");
    expect(rev.reverses).toBe(creado.idempotency_key);
    const book = appendEntries([], [creado, rev]);
    expect(accountBalance(book, "5100")).toBe(0n);
    expect(accountBalance(book, "2400")).toBe(0n);
  });

  it("tanda: aportación, dispersión y devolución", () => {
    const ap = tandaAportacion({ ...b(500n), tanda_id: "t1" });
    expect(ap.lines[1]).toMatchObject({ account: "2200", subaccount: "t1", credit: 500n });
    const di = tandaDispersion({ ...b(500n), tanda_id: "t1" });
    expect(di.lines.map((l) => l.account)).toEqual(["2200", "2400"]);
    const dev = devolucionSaldoAFavor({ ...b(200n), customer_id: "c1" });
    expect(dev.lines.map((l) => l.account)).toEqual(["2100", "2400"]);
  });

  it("rechaza montos ≤ 0", () => {
    expect(() => fiado({ ...b(0n), customer_id: "c1" })).toThrow(LedgerError);
    expect(() => pagoConfirmado(b(-1n))).toThrow(LedgerError);
  });
});

describe("validateEntry", () => {
  const ok: JournalEntry = {
    merchant_id: M,
    idempotency_key: "x",
    kind: "fiado",
    memo: "",
    lines: [
      { account: "1200", debit: 1n, credit: 0n },
      { account: "4100", debit: 0n, credit: 1n },
    ],
  };
  it("acepta un asiento cuadrado", () => expect(() => validateEntry(ok)).not.toThrow());
  it.each([
    ["sin llave", { ...ok, idempotency_key: "" }],
    ["sin comercio", { ...ok, merchant_id: "" }],
    ["una sola línea", { ...ok, lines: [ok.lines[0]!] }],
    ["descuadrado", { ...ok, lines: [ok.lines[0]!, { account: "4100", debit: 0n, credit: 2n }] }],
    ["negativo", { ...ok, lines: [{ account: "1200", debit: -1n, credit: 0n }, ok.lines[1]!] }],
    ["ambos lados", { ...ok, lines: [{ account: "1200", debit: 1n, credit: 1n }, ok.lines[1]!] }],
    ["línea en cero", { ...ok, lines: [...ok.lines, { account: "1100", debit: 0n, credit: 0n }] }],
    ["cuenta desconocida", { ...ok, lines: [{ account: "9999", debit: 1n, credit: 0n }, ok.lines[1]!] }],
  ])("rechaza: %s", (_name, entry) => {
    expect(() => validateEntry(entry as JournalEntry)).toThrow(LedgerError);
  });
});

describe("propiedades del ledger", () => {
  const amount = fc.bigInt({ min: 1n, max: 10n ** 12n });
  const balance = fc.bigInt({ min: -(10n ** 6n), max: 10n ** 12n });
  const anyEntry = fc.tuple(amount, balance, fc.integer({ min: 0, max: 8 })).map(([a, bal, k]) => {
    const base = b(a);
    switch (k) {
      case 0: return fiado({ ...base, customer_id: "c1" });
      case 1: return abonoIdentificado({ ...base, customer_id: "c1", customer_balance: bal });
      case 2: return abonoSinIdentificar(base);
      case 3: return identificarAbono({ ...base, customer_id: "c1", customer_balance: bal });
      case 4: return pagoProveedorCreado(base);
      case 5: return pagoConfirmado(base);
      case 6: return tandaAportacion({ ...base, tanda_id: "t1" });
      case 7: return tandaDispersion({ ...base, tanda_id: "t1" });
      default: return devolucionSaldoAFavor({ ...base, customer_id: "c1" });
    }
  });

  it("Σdebe = Σhaber en todo asiento generado y en su reverso", () => {
    fc.assert(
      fc.property(anyEntry, (e) => {
        const [d, h] = sums(e);
        expect(d).toBe(h);
        const [rd, rh] = sums(reverso(e, `r-${e.idempotency_key}`));
        expect(rd).toBe(rh);
      }),
    );
  });

  it("el libro completo siempre cuadra y un reverso deja todo en cero", () => {
    fc.assert(
      fc.property(fc.array(anyEntry, { maxLength: 30 }), (entries) => {
        const book = appendEntries([], entries);
        const all = book.flatMap((e) => e.lines);
        expect(all.reduce((s, l) => s + l.debit, 0n)).toBe(all.reduce((s, l) => s + l.credit, 0n));
        const undone = appendEntries(book, book.map((e) => reverso(e, `r-${e.idempotency_key}`)));
        for (const acc of ["1100", "1200", "1300", "2100", "2200", "2400", "4100", "5100"] as const) {
          expect(accountBalance(undone, acc)).toBe(0n);
        }
      }),
    );
  });

  it("idempotencia: reaplicar los mismos asientos no cambia el libro", () => {
    fc.assert(
      fc.property(fc.array(anyEntry, { maxLength: 20 }), (entries) => {
        const once = appendEntries([], entries);
        const twice = appendEntries(once, entries);
        expect(twice).toEqual(once);
      }),
    );
  });

  it("no muta el libro original (append-only)", () => {
    const book = appendEntries([], [fiado({ ...b(100n), customer_id: "c1" })]);
    const frozen = Object.freeze([...book]);
    const next = appendEntries(frozen, [fiado({ ...b(50n), customer_id: "c1" })]);
    expect(frozen).toHaveLength(1);
    expect(next).toHaveLength(2);
    expect(accountBalance(next, "1200", "c1")).toBe(150n);
    expect(accountBalance(next, "1200", "otro")).toBe(0n);
  });
});
