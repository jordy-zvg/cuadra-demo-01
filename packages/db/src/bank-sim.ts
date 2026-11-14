import { randomUUID } from "node:crypto";
import { type Centavos, isValidClabe } from "@cuadra/core";
import { and, eq, lt, ne, sql } from "drizzle-orm";
import { bigint, bigserial, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import type { Db } from "./client.js";

export const bankSimMovements = pgTable("bank_sim_movements", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  merchantId: text("merchant_id").notNull(),
  idempotencyKey: text("idempotency_key").notNull().unique(),
  amountCents: bigint("amount_cents", { mode: "bigint" }).notNull(),
  kind: text("kind").$type<"fondeo" | "cobro" | "transferencia" | "devolucion">().notNull(),
  ref: text("ref").notNull().unique(),
  status: text("status").$type<"sent" | "settled" | "failed">().notNull().default("settled"),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
});

/** Saldo del banco simulado (sin contar salidas fallidas). */
export async function bankSimBalance(db: Db, merchantId: string): Promise<Centavos> {
  const [r] = await db
    .select({ s: sql<string>`coalesce(sum(${bankSimMovements.amountCents}), 0)::text` })
    .from(bankSimMovements)
    .where(and(eq(bankSimMovements.merchantId, merchantId), ne(bankSimMovements.status, "failed")));
  return BigInt(r?.s ?? "0");
}

/** Abono al banco simulado (fondeo o cobro recibido). Idempotente. */
export async function bankSimCredit(
  db: Db,
  merchantId: string,
  key: string,
  amount: Centavos,
  kind: "fondeo" | "cobro",
): Promise<string> {
  const ref = `sim_${randomUUID()}`;
  const [r] = await db
    .insert(bankSimMovements)
    .values({ merchantId, idempotencyKey: key, amountCents: amount, kind, ref })
    .onConflictDoNothing({ target: bankSimMovements.idempotencyKey })
    .returning({ ref: bankSimMovements.ref });
  if (r) return r.ref;
  const [e] = await db.select().from(bankSimMovements).where(eq(bankSimMovements.idempotencyKey, key));
  return e!.ref;
}

/**
 * PaymentProvider simulado respaldado por Postgres (compartido entre api y executor).
 * Lo usa el executor en la demo; el nombre "mock" se mantiene para los webhooks.
 */
export class DbBankSimProvider {
  readonly name = "mock";
  constructor(
    private readonly db: Db,
    private readonly merchantId: string,
  ) {}

  async createTransfer(req: { idempotency_key: string; clabe: string; amount_cents: Centavos }) {
    const [prev] = await this.db.select().from(bankSimMovements).where(eq(bankSimMovements.idempotencyKey, req.idempotency_key));
    if (prev) {
      return prev.status === "failed"
        ? { provider_ref: prev.ref, status: "failed" as const, failure_reason: "Rechazada (simulado)" }
        : { provider_ref: prev.ref, status: "sent" as const };
    }
    if (!isValidClabe(req.clabe)) return { provider_ref: `sim_rej_${req.idempotency_key}`, status: "failed" as const, failure_reason: "CLABE inválida" };
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${this.merchantId}))`);
      const balance = await bankSimBalance(tx, this.merchantId);
      const ref = `sim_${randomUUID()}`;
      if (req.amount_cents > balance) {
        return { provider_ref: `sim_rej_${req.idempotency_key}`, status: "failed" as const, failure_reason: "Saldo insuficiente (simulado)" };
      }
      await tx.insert(bankSimMovements).values({
        merchantId: this.merchantId,
        idempotencyKey: req.idempotency_key,
        amountCents: -req.amount_cents,
        kind: "transferencia",
        ref,
        status: "sent",
      });
      return { provider_ref: ref, status: "sent" as const };
    });
  }

  async getBalance(): Promise<Centavos> {
    return bankSimBalance(this.db, this.merchantId);
  }

  /** Transferencias enviadas hace más de `ageMs`: el banco simulado las liquida. */
  async settleDue(now: Date, ageMs: number): Promise<string[]> {
    const due = await this.db
      .update(bankSimMovements)
      .set({ status: "settled" })
      .where(and(eq(bankSimMovements.merchantId, this.merchantId), eq(bankSimMovements.status, "sent"), lt(bankSimMovements.createdAt, new Date(now.getTime() - ageMs))))
      .returning({ ref: bankSimMovements.ref });
    return due.map((d) => d.ref);
  }
}
