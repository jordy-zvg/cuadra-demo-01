import { createHash } from "node:crypto";
import {
  ACCOUNTS,
  type AccountCode,
  type Centavos,
  type JournalEntry,
  LedgerError,
  canonicalJson,
  validateEntry,
} from "@cuadra/core";
import { and, eq, sql } from "drizzle-orm";
import type { Db } from "./client.js";
import { journalEntries, journalLines } from "./schema.js";

export function entryContentHash(e: JournalEntry): string {
  return createHash("sha256")
    .update(canonicalJson({ merchant_id: e.merchant_id, kind: e.kind, lines: e.lines, reverses: e.reverses ?? null }))
    .digest("hex");
}

export interface PostResult {
  posted: string[];
  /** Llaves que ya existían con el mismo contenido (reintento idempotente). */
  skipped: string[];
}

/**
 * Registra asientos en una sola transacción (savepoint si ya hay una abierta).
 * Una llave existente con el mismo contenido se omite; con contenido distinto es error.
 */
export async function postEntries(db: Db, entries: readonly JournalEntry[]): Promise<PostResult> {
  return db.transaction(async (tx) => {
    const result: PostResult = { posted: [], skipped: [] };
    for (const e of entries) {
      validateEntry(e);
      const contentHash = entryContentHash(e);
      const inserted = await tx
        .insert(journalEntries)
        .values({
          merchantId: e.merchant_id,
          idempotencyKey: e.idempotency_key,
          kind: e.kind,
          memo: e.memo,
          contentHash,
          reverses: e.reverses ?? null,
        })
        .onConflictDoNothing({ target: journalEntries.idempotencyKey })
        .returning({ id: journalEntries.id });

      const row = inserted[0];
      if (row === undefined) {
        const [existing] = await tx
          .select({ contentHash: journalEntries.contentHash })
          .from(journalEntries)
          .where(eq(journalEntries.idempotencyKey, e.idempotency_key));
        if (existing?.contentHash !== contentHash) {
          throw new LedgerError(`idempotency_key "${e.idempotency_key}" ya se usó con otro contenido`);
        }
        result.skipped.push(e.idempotency_key);
        continue;
      }
      await tx.insert(journalLines).values(
        e.lines.map((l) => ({
          entryId: row.id,
          account: l.account,
          subaccount: l.subaccount ?? null,
          debit: l.debit,
          credit: l.credit,
        })),
      );
      result.posted.push(e.idempotency_key);
    }
    return result;
  });
}

/** Lee un asiento como JournalEntry (para reversarlo). */
export async function getEntry(db: Db, idempotencyKey: string): Promise<JournalEntry | null> {
  const [e] = await db.select().from(journalEntries).where(eq(journalEntries.idempotencyKey, idempotencyKey));
  if (!e) return null;
  const lines = await db.select().from(journalLines).where(eq(journalLines.entryId, e.id)).orderBy(journalLines.id);
  const entry: JournalEntry = {
    merchant_id: e.merchantId,
    idempotency_key: e.idempotencyKey,
    kind: e.kind as JournalEntry["kind"],
    memo: e.memo,
    lines: lines.map((l) => ({
      account: l.account as AccountCode,
      ...(l.subaccount === null ? {} : { subaccount: l.subaccount }),
      debit: l.debit,
      credit: l.credit,
    })),
  };
  if (e.reverses !== null) entry.reverses = e.reverses;
  return entry;
}

// Naturaleza de cada cuenta: sale del catálogo (core), así una cuenta nueva nunca queda con el signo al revés.
const NORMAL_DEBIT: ReadonlySet<string> = new Set(
  (Object.keys(ACCOUNTS) as AccountCode[]).filter((code) => ACCOUNTS[code].normal === "debit"),
);

/** Saldo de una cuenta (o subcuenta) según su naturaleza. */
export async function ledgerBalance(
  db: Db,
  merchantId: string,
  account: AccountCode,
  subaccount?: string,
): Promise<Centavos> {
  const [row] = await db
    .select({
      d: sql<string>`coalesce(sum(${journalLines.debit}), 0)::text`,
      c: sql<string>`coalesce(sum(${journalLines.credit}), 0)::text`,
    })
    .from(journalLines)
    .innerJoin(journalEntries, eq(journalEntries.id, journalLines.entryId))
    .where(
      and(
        eq(journalEntries.merchantId, merchantId),
        eq(journalLines.account, account),
        subaccount === undefined ? undefined : eq(journalLines.subaccount, subaccount),
      ),
    );
  const d = BigInt(row?.d ?? "0");
  const c = BigInt(row?.c ?? "0");
  return NORMAL_DEBIT.has(account) ? d - c : c - d;
}
