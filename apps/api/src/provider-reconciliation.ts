/**
 * Conciliación por transacción contra el proveedor de cobro (pey no expone saldo).
 *
 * - Cobrado en el proveedor y no registrado en Cuadra (webhook perdido): se aplica por el mismo
 *   camino idempotente que el webhook ("recuperado").
 * - Registrado en Cuadra y no pagado en el proveedor, o con monto distinto: discrepancia →
 *   se congelan las salidas (principio 9) y se avisa al comercio. Nunca se corrige solo.
 */
import type { PeyTransaction } from "@cuadra/adapters";
import { formatMXN } from "@cuadra/core";
import { type Db, schema } from "@cuadra/db";
import { and, eq, gte, inArray, isNotNull } from "drizzle-orm";
import type { ChargeGateway } from "./gateway.js";

export interface Discrepancy {
  kind: "monto_distinto" | "no_pagado_en_proveedor" | "no_existe_en_proveedor" | "no_registrado";
  transaction_id: string;
  detail: string;
}

export interface ReconResult {
  skipped: boolean;
  checked: number;
  recovered: string[];
  discrepancies: Discrepancy[];
  ok: boolean;
}

export interface ReconDeps {
  db: Db;
  merchantId: string;
  gateway: ChargeGateway;
  /** Mismo camino que el webhook: idempotente por transacción. */
  applyPayment: (tx: PeyTransaction) => Promise<void>;
  now: () => Date;
  say: (body: string) => Promise<void>;
  log: (r: Record<string, unknown>) => void;
  /** Días hacia atrás que se revisan (default 7). */
  windowDays?: number;
  /** Un registro de Cuadra más reciente que esto aún no se exige en el proveedor (default 2 min). */
  settleMs?: number;
}

const DAY = 24 * 3600_000;

/** Lo que Cuadra tiene registrado como pagado por este proveedor: tx → monto y fecha. */
async function cuadraRecords(db: Db, merchantId: string, provider: string, since: Date) {
  const recs = new Map<string, { cents: bigint; at: Date; where: "abono" | "tanda" }>();
  const prefix = `${provider}:`;
  const deps = await db
    .select()
    .from(schema.deposits)
    .where(and(eq(schema.deposits.merchantId, merchantId), eq(schema.deposits.provider, provider), gte(schema.deposits.receivedAt, since)));
  for (const d of deps) {
    if (d.claveRastreo.startsWith(prefix)) recs.set(d.claveRastreo.slice(prefix.length), { cents: d.amountCents, at: d.receivedAt, where: "abono" });
  }
  const tandaIds = (await db.select({ id: schema.tandas.id }).from(schema.tandas).where(eq(schema.tandas.merchantId, merchantId))).map((t) => t.id);
  if (tandaIds.length) {
    const tcs = await db
      .select()
      .from(schema.tandaCharges)
      .where(and(inArray(schema.tandaCharges.tandaId, tandaIds), eq(schema.tandaCharges.provider, provider), isNotNull(schema.tandaCharges.transactionId)));
    for (const t of tcs) {
      if (t.paidAt && t.paidAt.getTime() >= since.getTime()) {
        recs.set(t.transactionId!, { cents: t.paidCents ?? 0n, at: t.paidAt, where: "tanda" });
      }
    }
  }
  return recs;
}

export async function reconcileWithProvider(d: ReconDeps): Promise<ReconResult> {
  const { db, merchantId, gateway } = d;
  if (gateway.simulated || !gateway.listRecentTransactions) {
    return { skipped: true, checked: 0, recovered: [], discrepancies: [], ok: true };
  }
  const now = d.now();
  const windowMs = (d.windowDays ?? 7) * DAY;
  const settleMs = d.settleMs ?? 2 * 60_000;
  // Se lee un día más de lo que se exige, porque el registro en Cuadra puede ser posterior a la creación en pey.
  const { items, coveredSince } = await gateway.listRecentTransactions(new Date(now.getTime() - windowMs - DAY));
  const byId = new Map(items.map((t) => [t.id, t]));
  const paid = items.filter((t) => t.status === "PAID");

  const discrepancies: Discrepancy[] = [];
  const recovered: string[] = [];
  let recs = await cuadraRecords(db, merchantId, gateway.name, new Date(now.getTime() - windowMs - DAY));

  // 1) Cobrado en el proveedor: debe estar registrado, con el mismo monto.
  for (const tx of paid) {
    const rec = recs.get(tx.id);
    if (!rec) {
      await d.applyPayment(tx);
      recs = await cuadraRecords(db, merchantId, gateway.name, new Date(now.getTime() - windowMs - DAY));
      if (recs.has(tx.id)) recovered.push(tx.id);
      else discrepancies.push({ kind: "no_registrado", transaction_id: tx.id, detail: `pey cobró ${formatMXN(tx.base_cents)} y Cuadra no pudo registrarlo.` });
      continue;
    }
    if (rec.cents !== tx.base_cents && rec.where === "abono") {
      discrepancies.push({ kind: "monto_distinto", transaction_id: tx.id, detail: `Cuadra registró ${formatMXN(rec.cents)} y pey reporta ${formatMXN(tx.base_cents)}.` });
    }
  }

  // 2) Registrado en Cuadra: debe existir y estar pagado en el proveedor (dentro de lo que se leyó).
  const checkFrom = Math.max(now.getTime() - windowMs, coveredSince ? coveredSince.getTime() + DAY : 0);
  for (const [txId, rec] of recs) {
    if (rec.at.getTime() < checkFrom || now.getTime() - rec.at.getTime() < settleMs) continue;
    const tx = byId.get(txId);
    if (!tx) discrepancies.push({ kind: "no_existe_en_proveedor", transaction_id: txId, detail: `Cuadra tiene un pago de ${formatMXN(rec.cents)} que pey no reporta.` });
    else if (tx.status !== "PAID") discrepancies.push({ kind: "no_pagado_en_proveedor", transaction_id: txId, detail: `pey reporta la transacción como ${tx.status}.` });
  }

  const ok = discrepancies.length === 0;
  await db.insert(schema.providerReconciliationRuns).values({
    merchantId,
    provider: gateway.name,
    runAt: now,
    checked: paid.length,
    recovered: recovered.length,
    discrepancies,
    ok,
  });
  if (!ok) {
    await db
      .insert(schema.riskState)
      .values({ merchantId, reconciliationMismatch: true })
      .onConflictDoUpdate({ target: schema.riskState.merchantId, set: { reconciliationMismatch: true, updatedAt: now } });
    await d.say(`🚨 La conciliación con pey encontró ${discrepancies.length} diferencia(s); congelé las salidas hasta revisarlo.\n• ${discrepancies.map((x) => x.detail).join("\n• ")}`);
  }
  if (recovered.length) {
    await d.say(`🔄 Conciliación con pey: recuperé ${recovered.length} pago(s) que pey cobró y no habían llegado por webhook.`);
  }
  d.log({ msg: "provider_reconciliation", merchant_id: merchantId, provider: gateway.name, checked: paid.length, recovered: recovered.length, discrepancies: discrepancies.length });
  return { skipped: false, checked: paid.length, recovered, discrepancies, ok };
}
