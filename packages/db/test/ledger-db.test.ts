import type { PGlite } from "@electric-sql/pglite";
import { LedgerError, abonoIdentificado, fiado, pagoProveedorCreado, reverso } from "@cuadra/core";
import { beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../src/client.js";
import { getEntry, ledgerBalance, postEntries } from "../src/ledger-repo.js";
import { createTestDb } from "../src/testing.js";

let db: Db;
let pg: PGlite;
const M = "m1";

beforeEach(async () => {
  ({ db, pg } = await createTestDb());
  await pg.exec(`INSERT INTO merchants (id, name, daily_limit_cents, max_outflows_per_hour) VALUES ('m1', 'Tienda', 100000, 5)`);
});

const sqlError = async (q: string) => {
  try {
    await pg.exec(q);
  } catch (e) {
    return (e as Error).message;
  }
  return null;
};

describe("ledger en Postgres", () => {
  it("registra asientos y calcula saldos", async () => {
    await postEntries(db, [
      fiado({ merchant_id: M, idempotency_key: "f1", amount: 8000n, customer_id: "c1" }),
      abonoIdentificado({ merchant_id: M, idempotency_key: "a1", amount: 10000n, customer_id: "c1", customer_balance: 8000n }),
    ]);
    expect(await ledgerBalance(db, M, "1200", "c1")).toBe(0n);
    expect(await ledgerBalance(db, M, "2100", "c1")).toBe(2000n);
    expect(await ledgerBalance(db, M, "1100")).toBe(10000n);
    expect(await ledgerBalance(db, M, "4100")).toBe(8000n);
    expect(await ledgerBalance(db, "otro", "1100")).toBe(0n);
  });

  it("idempotencia: reintento se omite; misma llave con otro contenido falla", async () => {
    const e = fiado({ merchant_id: M, idempotency_key: "f1", amount: 8000n, customer_id: "c1" });
    expect(await postEntries(db, [e])).toEqual({ posted: ["f1"], skipped: [] });
    expect(await postEntries(db, [e])).toEqual({ posted: [], skipped: ["f1"] });
    const evil = fiado({ merchant_id: M, idempotency_key: "f1", amount: 9000n, customer_id: "c1" });
    await expect(postEntries(db, [evil])).rejects.toThrow(LedgerError);
    expect(await ledgerBalance(db, M, "1200", "c1")).toBe(8000n);
  });

  it("todo o nada: un asiento inválido revierte el lote", async () => {
    const ok = fiado({ merchant_id: M, idempotency_key: "f1", amount: 1n, customer_id: "c1" });
    const bad = { ...ok, idempotency_key: "f2", lines: [ok.lines[0]!] };
    await expect(postEntries(db, [ok, bad])).rejects.toThrow();
    expect(await getEntry(db, "f1")).toBeNull();
  });

  it("reverso: una sola vez y deja saldos en cero", async () => {
    const e = pagoProveedorCreado({ merchant_id: M, idempotency_key: "p1", amount: 500n });
    await postEntries(db, [e]);
    const stored = await getEntry(db, "p1");
    expect(stored).toMatchObject({ kind: "pago_proveedor_creado", lines: e.lines });
    await postEntries(db, [reverso(stored!, "p1:rev")]);
    expect(await ledgerBalance(db, M, "2400")).toBe(0n);
    expect((await getEntry(db, "p1:rev"))?.reverses).toBe("p1");
    await expect(postEntries(db, [reverso(stored!, "p1:rev2")])).rejects.toThrow();
  });

  describe("constraints en la DB (aunque alguien salte el código)", () => {
    it("rechaza asiento descuadrado", async () => {
      const msg = await sqlError(`BEGIN;
        INSERT INTO journal_entries (id, merchant_id, idempotency_key, kind, memo, content_hash) VALUES (99, 'm1', 'x', 'fiado', '', 'h');
        INSERT INTO journal_lines (entry_id, account, debit, credit) VALUES (99, '1200', 100, 0), (99, '4100', 0, 99);
        COMMIT;`);
      expect(msg).toMatch(/descuadrado/);
    });
    it("rechaza asiento de una sola línea o sin líneas", async () => {
      expect(await sqlError(`INSERT INTO journal_entries (merchant_id, idempotency_key, kind, memo, content_hash) VALUES ('m1', 'x', 'fiado', '', 'h')`)).toMatch(/descuadrado/);
    });
    it("rechaza líneas con ambos lados, negativos o cuenta desconocida", async () => {
      await postEntries(db, [fiado({ merchant_id: M, idempotency_key: "f1", amount: 1n, customer_id: "c1" })]);
      for (const vals of ["(1, '1200', 1, 1)", "(1, '1200', -1, 0)", "(1, '9999', 1, 0)"]) {
        expect(await sqlError(`INSERT INTO journal_lines (entry_id, account, debit, credit) VALUES ${vals}`)).not.toBeNull();
      }
    });
    it("append-only: no UPDATE, DELETE ni TRUNCATE", async () => {
      await postEntries(db, [fiado({ merchant_id: M, idempotency_key: "f1", amount: 1n, customer_id: "c1" })]);
      for (const q of [
        "UPDATE journal_lines SET debit = 2 WHERE debit = 1",
        "UPDATE journal_entries SET memo = 'x'",
        "DELETE FROM journal_lines",
        "DELETE FROM journal_entries",
        "TRUNCATE journal_lines CASCADE",
      ]) {
        expect(await sqlError(q)).toMatch(/append-only/);
      }
    });
    it("CLABE con dígito verificador inválido no entra a payees", async () => {
      expect(await sqlError(`INSERT INTO payees (id, merchant_id, alias, clabe, holder_name) VALUES ('p', 'm1', 'x', '032180000118359710', 'X')`)).toMatch(/check/i);
      expect(await sqlError(`INSERT INTO payees (id, merchant_id, alias, clabe, holder_name) VALUES ('p', 'm1', 'x', '032180000118359719', 'X')`)).toBeNull();
    });
  });
});
