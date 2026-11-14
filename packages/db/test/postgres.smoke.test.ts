import { fiado } from "@cuadra/core";
import { describe, expect, it } from "vitest";
import { recordDeposit } from "../src/deposits.js";
import { ledgerBalance, postEntries } from "../src/ledger-repo.js";
import { connectPostgres, migratePostgres } from "../src/node.js";
import { DEMO, seedDemo } from "../src/seed.js";

const url = process.env.TEST_DATABASE_URL;

/** Corre contra un Postgres real si TEST_DATABASE_URL apunta a una base vacía y desechable. */
describe.skipIf(!url)("Postgres real (node-postgres)", () => {
  it("migra, siembra, registra y rechaza descuadres", async () => {
    const { db, pool } = await connectPostgres(url!);
    try {
      await migratePostgres(pool);
      expect(await migratePostgres(pool)).toEqual([]);
      await seedDemo(db);
      const M = DEMO.merchantId;
      await postEntries(db, [fiado({ merchant_id: M, idempotency_key: `smoke-${Date.now()}`, amount: 100n, customer_id: DEMO.customers.rosa.id })]);
      const before = await ledgerBalance(db, M, "1100");
      await recordDeposit(db, M, { clave_rastreo: `SMK${Date.now()}`, amount: 100n, destination_clabe: DEMO.customers.rosa.virtualClabe });
      expect(await ledgerBalance(db, M, "1100")).toBe(before + 100n);
      await expect(
        pool.query(`DO $$ BEGIN
          INSERT INTO journal_entries (id, merchant_id, idempotency_key, kind, memo, content_hash) VALUES (-1, '${M}', 'bad-${Date.now()}', 'fiado', '', 'h');
          INSERT INTO journal_lines (entry_id, account, debit, credit) VALUES (-1, '1200', 1, 0), (-1, '4100', 0, 2);
        END $$;`),
      ).rejects.toThrow(/descuadrado/);
    } finally {
      await pool.end();
    }
  });
});
