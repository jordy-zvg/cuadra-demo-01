import { type BalanceCheck, type Centavos, checkBalance, mxDateKey } from "@cuadra/core";
import { eq } from "drizzle-orm";
import type { Db } from "./client.js";
import { ledgerBalance } from "./ledger-repo.js";
import { reconciliationRuns, riskState } from "./schema.js";
import { inFlightCents, lockMerchant } from "./transfers.js";

/**
 * Compara 1100 (menos lo enviado sin confirmar) con el saldo del proveedor.
 * Si no cuadra, congela salidas. Descongelar es manual (clearReconciliationFreeze).
 */
export async function runReconciliation(
  db: Db,
  merchantId: string,
  providerBalance: Centavos,
  now: Date,
): Promise<BalanceCheck> {
  return db.transaction(async (tx) => {
    await lockMerchant(tx, merchantId);
    const ledger = await ledgerBalance(tx, merchantId, "1100");
    const inFlight = await inFlightCents(tx, merchantId);
    const check = checkBalance(ledger, providerBalance, inFlight);
    await tx.insert(reconciliationRuns).values({
      merchantId,
      runAt: now,
      localDate: mxDateKey(now),
      ledger1100Cents: ledger,
      inFlightCents: inFlight,
      providerBalanceCents: providerBalance,
      ok: check.ok,
    });
    if (check.freeze_outflows) {
      await tx
        .insert(riskState)
        .values({ merchantId, reconciliationMismatch: true })
        .onConflictDoUpdate({ target: riskState.merchantId, set: { reconciliationMismatch: true, updatedAt: now } });
    }
    return check;
  });
}

/** Descongelamiento manual tras revisar la diferencia. */
export async function clearReconciliationFreeze(db: Db, merchantId: string): Promise<void> {
  await db
    .update(riskState)
    .set({ reconciliationMismatch: false, updatedAt: new Date() })
    .where(eq(riskState.merchantId, merchantId));
}
