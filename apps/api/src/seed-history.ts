import { abonoIdentificado, fiado } from "@cuadra/core";
import { type Db, bankSimCredit, postEntries, schema } from "@cuadra/db";
import { eq } from "drizzle-orm";

/**
 * Historial de demo (marcado como tal en los asientos): fiados ya cobrados que dejan
 * fondos en la cuenta operativa simulada para los pagos a proveedores. Idempotente.
 */
export async function seedHistory(db: Db, merchantId: string): Promise<void> {
  const [already] = await db.select().from(schema.journalEntries).where(eq(schema.journalEntries.idempotencyKey, "demo:hist:abono:1"));
  if (already) return;
  const hist: Array<[string, bigint]> = [
    ["c_beto", 250_000n],
    ["c_chela", 180_000n],
    ["c_beto", 120_000n],
  ];
  let i = 0;
  for (const [customer, amount] of hist) {
    i++;
    await postEntries(db, [
      fiado({ merchant_id: merchantId, idempotency_key: `demo:hist:fiado:${i}`, amount, customer_id: customer, memo: "Historial de demo" }),
      abonoIdentificado({
        merchant_id: merchantId,
        idempotency_key: `demo:hist:abono:${i}`,
        amount,
        customer_id: customer,
        customer_balance: amount,
        memo: "Historial de demo (cobro simulado)",
      }),
    ]);
    await bankSimCredit(db, merchantId, `demo:hist:abono:${i}`, amount, "cobro");
  }
}
