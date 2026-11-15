/**
 * Executor en modo demo: sondea Postgres (sin Redis) y usa la cuenta operativa SIMULADA de cada
 * tienda. Sigue siendo el único proceso que ejecuta salidas: revalida todo con executeOutflow.
 * Atiende a todas las tiendas (una por persona); cada salida usa la cuenta de su propia tienda.
 */
import { type AssertionVerifier, DbBankSimProvider, applyProviderEvent, bankSimBalance, runReconciliation, schema } from "@cuadra/db";
import { connectPostgres } from "@cuadra/db/node";
import { formatMXN } from "@cuadra/core";
import { and, asc, eq } from "drizzle-orm";
import { verifyProposalAssertion } from "@cuadra/adapters";
import { executeOutflow } from "./execute.js";

const env = (k: string) => process.env[k] || undefined;
function log(r: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify({ ts: new Date().toISOString(), service: "executor", ...r })}\n`);
}

async function main(): Promise<void> {
  const url = env("DATABASE_URL");
  if (!url) throw new Error("Falta DATABASE_URL");
  const { db } = await connectPostgres(url);
  const providers = new Map<string, DbBankSimProvider>();
  const providerOf = (merchantId: string) => {
    let p = providers.get(merchantId);
    if (!p) providers.set(merchantId, (p = new DbBankSimProvider(db, merchantId)));
    return p;
  };
  const publicUrl = env("PUBLIC_URL")?.replace(/\/$/, "");
  const rpID = env("WEBAUTHN_RP_ID") ?? (publicUrl ? new URL(publicUrl).hostname : "localhost");
  const origins = (env("WEBAUTHN_ORIGINS") ?? publicUrl ?? "http://localhost:3000").split(",");
  const settleMs = Number(env("SIM_SETTLE_MS") ?? 4000);
  const deps = (merchantId: string) => ({
    db,
    provider: providerOf(merchantId),
    verify: ((a) => verifyProposalAssertion({ ...a, config: { rpID, origins } })) satisfies AssertionVerifier,
    now: () => new Date(),
    log,
  });
  const say = (merchantId: string, body: string) =>
    db.insert(schema.messages).values({ merchantId, thread: "comercio", direction: "out", body });

  let lastRecon = 0;
  log({ msg: "executor_poll_started", provider: "bank_sim", scope: "todas las tiendas" });
  for (;;) {
    try {
      const merchantIds = (await db.select({ id: schema.merchants.id }).from(schema.merchants)).map((m) => m.id);
      if (Date.now() - lastRecon > 30_000) {
        for (const merchantId of merchantIds) {
          const r = await runReconciliation(db, merchantId, await bankSimBalance(db, merchantId), new Date());
          if (!r.ok) log({ msg: "reconciliation_mismatch", merchant_id: merchantId, difference: r.difference.toString() });
        }
        lastRecon = Date.now();
      }
      const queued = await db
        .select({ id: schema.proposals.id, merchantId: schema.proposals.merchantId })
        .from(schema.proposals)
        .where(eq(schema.proposals.status, "queued"))
        .orderBy(asc(schema.proposals.createdAt))
        .limit(5);
      for (const q of queued) {
        const merchantId = q.merchantId;
        const say1 = (body: string) => say(merchantId, body);
        const r = await executeOutflow({ proposal_id: q.id }, deps(merchantId));
        if (r.status === "sent") await say1("🏦 SPEI enviado (cuenta simulada). Esperando confirmación del banco…");
        else if (r.status === "failed") await say1(`⚠️ El pago no salió: ${r.reason}. Se reversó el asiento.`);
        else if (r.status === "rejected" || r.status === "awaiting_passkey") {
          const reasons = "rules_failed" in r.decision ? r.decision.rules_failed.map((f) => `${f.reason} (${f.rule_id})`) : [String(r.decision.integrity_error)];
          await say1(`🛡️ El ejecutor revalidó y detuvo el pago:\n• ${reasons.join("\n• ")}`);
        }
      }
      for (const merchantId of merchantIds) {
        for (const ref of await providerOf(merchantId).settleDue(new Date(), settleMs)) {
          const out = await applyProviderEvent(db, "mock", merchantId, { type: "transfer.confirmed", event_id: `sim:${ref}`, provider_ref: ref });
          if (out.status === "transfer_confirmed") {
            const [t] = await db.select().from(schema.transfers).where(eq(schema.transfers.id, out.transfer_id));
            const [p] = t ? await db.select().from(schema.payees).where(eq(schema.payees.id, t.payeeId)) : [];
            if (t) await say(merchantId, `🧾 Recibo: ${formatMXN(t.amountCents)} pagados a ${p?.alias ?? "proveedor"} (SPEI simulado, ref. ${ref.slice(-8)}).`);
          }
        }
      }
    } catch (e) {
      log({ msg: "loop_error", error: e instanceof Error ? e.message : String(e) });
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
}

main().catch((e: unknown) => {
  log({ msg: "fatal", error: e instanceof Error ? e.message : String(e) });
  process.exit(1);
});
