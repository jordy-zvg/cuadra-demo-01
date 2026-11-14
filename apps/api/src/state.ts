import { type AccountCode, ACCOUNTS, checkBalance } from "@cuadra/core";
import { type Db, bankSimBalance, inFlightCents, ledgerBalance, schema } from "@cuadra/db";
import { desc, eq, sql } from "drizzle-orm";

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

  const t = (totals as unknown as { rows: Array<Record<string, unknown>> }).rows[0] ?? {};
  return {
    merchant: { id: merchantId, name: merchant?.name },
    gateway: opts.gateway,
    simulated: opts.simulated,
    risk: { kill_switch: risk?.killSwitch ?? false, frozen: risk?.reconciliationMismatch ?? false },
    accounts,
    ledger: { debit: String(t.debit ?? "0"), credit: String(t.credit ?? "0"), unbalanced: Number(t.unbalanced ?? 0), entries: Number(t.entries ?? 0) },
    reconciliation: recon,
    customers: customerRows,
    entries: entryRows,
    charges: charges.map((c) => ({ id: c.id, customer_id: c.customerId, reference: c.reference, amount: c.amountCents === null ? null : s(c.amountCents), status: c.status, provider: c.provider, channel: c.channel, at: c.createdAt.toISOString() })),
    deposits: deposits.map((d) => ({ id: s(d.id), clave: d.claveRastreo, amount: s(d.amountCents), customer_id: d.customerId, method: d.matchMethod, fee: d.feeCents === null ? null : s(d.feeCents), at: d.receivedAt.toISOString() })),
    transfers: transfers.map((x) => ({ id: x.id, amount: s(x.amountCents), status: x.status, payee_id: x.payeeId, concept: x.concept })),
    blocks: { count: blockCount?.n ?? 0, recent: blocks.map((b) => ({ kind: b.kind, provenance: b.provenance, reasons: b.reasons, source: b.source, at: b.createdAt.toISOString() })) },
    messages: msgs.reverse().map((m) => ({ id: m.id, thread: m.thread, direction: m.direction, body: m.body, actions: m.actions, at: m.createdAt.toISOString() })),
  };
}
