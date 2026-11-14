import { type AccountCode, ACCOUNTS, checkBalance, potCents } from "@cuadra/core";
import { type Db, bankSimBalance, inFlightCents, ledgerBalance, schema, tandaMembersOf, tandaRoundStatus } from "@cuadra/db";
import { and, desc, eq, sql } from "drizzle-orm";

const s = (v: bigint) => v.toString();

export async function panelState(db: Db, merchantId: string, opts: { gateway: string; simulated: boolean; bankSim: boolean }) {
  const [merchant] = await db.select().from(schema.merchants).where(eq(schema.merchants.id, merchantId));
  const accounts: Record<string, string> = {};
  for (const code of Object.keys(ACCOUNTS) as AccountCode[]) accounts[code] = s(await ledgerBalance(db, merchantId, code));

  const totals = await db.execute(sql`
    SELECT
      coalesce(sum(l.debit), 0)::text AS debit,
      coalesce(sum(l.credit), 0)::text AS credit,
      (SELECT count(*) FROM (
         SELECT e2.id FROM journal_entries e2 JOIN journal_lines l2 ON l2.entry_id = e2.id
         WHERE e2.merchant_id = ${merchantId}
         GROUP BY e2.id HAVING sum(l2.debit) <> sum(l2.credit)) x)::int AS unbalanced,
      (SELECT count(*) FROM journal_entries WHERE merchant_id = ${merchantId})::int AS entries
    FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
    WHERE e.merchant_id = ${merchantId}`);

  const customers = await db.select().from(schema.customers).where(eq(schema.customers.merchantId, merchantId));
  const customerRows = [];
  for (const c of customers) {
    customerRows.push({
      id: c.id,
      name: c.name,
      owes: s(await ledgerBalance(db, merchantId, "1200", c.id)),
      credit: s(await ledgerBalance(db, merchantId, "2100", c.id)),
      opt_in: c.optIn,
    });
  }

  const entries = await db
    .select()
    .from(schema.journalEntries)
    .where(eq(schema.journalEntries.merchantId, merchantId))
    .orderBy(desc(schema.journalEntries.id))
    .limit(25);
  const entryRows = [];
  for (const e of entries) {
    const lines = await db.select().from(schema.journalLines).where(eq(schema.journalLines.entryId, e.id)).orderBy(schema.journalLines.id);
    entryRows.push({
      id: s(e.id),
      kind: e.kind,
      memo: e.memo,
      at: e.createdAt.toISOString(),
      lines: lines.map((l) => ({ account: l.account, sub: l.subaccount, debit: s(l.debit), credit: s(l.credit) })),
    });
  }

  const charges = await db.select().from(schema.charges).where(eq(schema.charges.merchantId, merchantId)).orderBy(desc(schema.charges.createdAt)).limit(15);
  const deposits = await db.select().from(schema.deposits).where(eq(schema.deposits.merchantId, merchantId)).orderBy(desc(schema.deposits.id)).limit(15);
  const blocks = await db.select().from(schema.guardBlocks).where(eq(schema.guardBlocks.merchantId, merchantId)).orderBy(desc(schema.guardBlocks.id)).limit(15);
  const [blockCount] = await db.select({ n: sql<number>`count(*)::int` }).from(schema.guardBlocks).where(eq(schema.guardBlocks.merchantId, merchantId));
  const transfers = await db.select().from(schema.transfers).where(eq(schema.transfers.merchantId, merchantId)).orderBy(desc(schema.transfers.createdAt)).limit(10);
  const msgs = await db.select().from(schema.messages).where(eq(schema.messages.merchantId, merchantId)).orderBy(desc(schema.messages.id)).limit(200);
  const [risk] = await db.select().from(schema.riskState).where(eq(schema.riskState.merchantId, merchantId));

  let recon = null;
  if (opts.bankSim) {
    const ledger = await ledgerBalance(db, merchantId, "1100");
    const bank = await bankSimBalance(db, merchantId);
    const inflight = await inFlightCents(db, merchantId);
    const c = checkBalance(ledger, bank, inflight);
    recon = { ledger_1100: s(ledger), bank: s(bank), in_flight: s(inflight), ok: c.ok, difference: s(c.difference) };
  }

  // Impacto: fiado de libreta que ya se cobró en digital, clientes al corriente.
  const impact = (await db.execute(sql`
    SELECT
      coalesce((SELECT sum(l.debit) FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
                WHERE e.merchant_id = ${merchantId} AND e.kind = 'fiado' AND l.account = '1200'), 0)::text AS fiado_total,
      coalesce((SELECT sum(amount_cents) FROM deposits WHERE merchant_id = ${merchantId} AND customer_id IS NOT NULL), 0)::text AS cobrado_digital,
      (SELECT count(*) FROM deposits WHERE merchant_id = ${merchantId})::int AS pagos_digitales,
      (SELECT count(*) FROM charges WHERE merchant_id = ${merchantId} AND status = 'paid')::int AS cobros_pagados
  `)) as unknown as { rows: Array<Record<string, unknown>> };
  const im = impact.rows[0] ?? {};

  const t = (totals as unknown as { rows: Array<Record<string, unknown>> }).rows[0] ?? {};
  return {
    merchant: { id: merchantId, name: merchant?.name },
    gateway: opts.gateway,
    simulated: opts.simulated,
    risk: { kill_switch: risk?.killSwitch ?? false, frozen: risk?.reconciliationMismatch ?? false },
    accounts,
    ledger: { debit: String(t.debit ?? "0"), credit: String(t.credit ?? "0"), unbalanced: Number(t.unbalanced ?? 0), entries: Number(t.entries ?? 0) },
    reconciliation: recon,
    impact: {
      fiado_total: String(im.fiado_total ?? "0"),
      cobrado_digital: String(im.cobrado_digital ?? "0"),
      pagos_digitales: Number(im.pagos_digitales ?? 0),
      cobros_pagados: Number(im.cobros_pagados ?? 0),
      clientes_al_corriente: customerRows.filter((c) => c.owes === "0").length,
      clientes: customerRows.length,
    },
    customers: customerRows,
    entries: entryRows,
    charges: charges.map((c) => ({ id: c.id, customer_id: c.customerId, reference: c.reference, amount: c.amountCents === null ? null : s(c.amountCents), status: c.status, provider: c.provider, channel: c.channel, at: c.createdAt.toISOString() })),
    deposits: deposits.map((d) => ({ id: s(d.id), clave: d.claveRastreo, amount: s(d.amountCents), customer_id: d.customerId, method: d.matchMethod, fee: d.feeCents === null ? null : s(d.feeCents), at: d.receivedAt.toISOString() })),
    transfers: transfers.map((x) => ({ id: x.id, amount: s(x.amountCents), status: x.status, payee_id: x.payeeId, concept: x.concept })),
    blocks: { count: blockCount?.n ?? 0, recent: blocks.map((b) => ({ kind: b.kind, provenance: b.provenance, reasons: b.reasons, source: b.source, at: b.createdAt.toISOString() })) },
    messages: msgs.reverse().map((m) => ({ id: m.id, thread: m.thread, direction: m.direction, body: m.body, actions: m.actions, at: m.createdAt.toISOString() })),
  };
}

/** Estado de la tanda activa (o la última) para el panel y los teléfonos de los integrantes. */
export async function tandaState(db: Db, service: { tanda: { activeTanda(): Promise<{ id: string } | null> } }) {
  const active = await service.tanda.activeTanda();
  const [t] = active
    ? await db.select().from(schema.tandas).where(eq(schema.tandas.id, active.id))
    : await db.select().from(schema.tandas).orderBy(desc(schema.tandas.createdAt)).limit(1);
  if (!t) return null;
  const members = await tandaMembersOf(db, t.id);
  const st = await tandaRoundStatus(db, t);
  return {
    id: t.id,
    name: t.name,
    status: t.status,
    round: t.currentRound,
    members_count: t.membersCount,
    contribution: t.contributionCents.toString(),
    pot: potCents(t.contributionCents, t.membersCount).toString(),
    recipient: st?.recipient ?? null,
    members: members.map((m) => ({
      position: m.position,
      name: m.name,
      thread: `tanda:${t.id}:${m.position}`,
      clabe_last4: m.clabe.slice(-4),
      account: m.bankAccountStatus,
      state: !st ? "esperando" : m.position === st.recipient ? "recibe" : st.paid.includes(m.position) ? "pagó" : "falta",
    })),
  };
}

/** Última conciliación contra el proveedor de cobro. */
export async function providerReconState(db: Db, merchantId: string, provider: string) {
  const [r] = await db
    .select()
    .from(schema.providerReconciliationRuns)
    .where(and(eq(schema.providerReconciliationRuns.merchantId, merchantId), eq(schema.providerReconciliationRuns.provider, provider)))
    .orderBy(desc(schema.providerReconciliationRuns.runAt))
    .limit(1);
  return r ? { at: r.runAt.toISOString(), ok: r.ok, checked: r.checked, recovered: r.recovered, discrepancies: r.discrepancies.length } : null;
}
