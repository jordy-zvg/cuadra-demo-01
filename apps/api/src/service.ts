import { randomUUID } from "node:crypto";
import {
  type PeyTransaction,
  WebhookSignatureError,
  parsePeyWebhook,
} from "@cuadra/adapters";
import { type Intent, type Interpreter, interpretWithConsensus, normalizeName } from "@cuadra/agents";
import {
  type Centavos,
  Proposal,
  evaluateCreatePayee,
  evaluateOutflow,
  evaluateReminder,
  fiado,
  formatMXN,
  mxPeriodStart,
  n2bisStatus,
  type UdiMicro,
} from "@cuadra/core";
import {
  type AssertionVerifier,
  type Db,
  type MessageAction,
  attachProviderCharge,
  bankSimCredit,
  customerPhone10,
  depositsSince,
  globalKillSwitch,
  insertCharge,
  ledgerBalance,
  loadOutflowContext,
  newChargeReference,
  postEntries,
  recordProviderPayment,
  saveProposal,
  schema,
  setProposalStatus,
} from "@cuadra/db";
import { and, desc, eq } from "drizzle-orm";
import type { ChargeGateway } from "./gateway.js";

export const REMINDER_TEMPLATE = "cobro_amable";

export interface ServiceDeps {
  db: Db;
  merchantId: string;
  ownerId: string;
  interpreters: Interpreter[];
  gateway: ChargeGateway;
  verify: AssertionVerifier;
  now: () => Date;
  /** URL pública HTTPS (para links de pago y aprobación), si existe. */
  publicUrl: string | null;
  peyWebhookSecret: string | null;
  /** Los cobros recibidos también entran a la cuenta operativa simulada (demo). */
  bankSim: boolean;
  /** Valor de la UDI (millonésimas de peso) para el monitor Nivel 2 Bis; null si no se configuró. */
  udi: UdiMicro | null;
  log: (r: Record<string, unknown>) => void;
}

export type Provenance = "user_direct" | "user_voice" | "third_party_content";

const id = (p: string) => `${p}_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
const CLABE_IN_TEXT = /\b\d{18}\b/;

export class CuadraService {
  constructor(private readonly d: ServiceDeps) {}

  // ---------- mensajes ----------

  private async say(thread: string, body: string, actions?: MessageAction[], proposalId?: string): Promise<void> {
    await this.d.db.insert(schema.messages).values({
      merchantId: this.d.merchantId,
      thread,
      direction: "out",
      body,
      actions: actions ?? null,
      proposalId: proposalId ?? null,
      createdAt: this.d.now(),
    });
  }

  private async heard(thread: string, body: string): Promise<void> {
    await this.d.db.insert(schema.messages).values({
      merchantId: this.d.merchantId,
      thread,
      direction: "in",
      body,
      createdAt: this.d.now(),
    });
  }

  // ---------- resolución de nombres (código, no LLM) ----------

  private async resolve<T extends { id: string; label: string }>(
    rows: T[],
    name: string,
  ): Promise<{ ok: true; row: T } | { ok: false; options: T[] }> {
    const q = normalizeName(name);
    if (!q) return { ok: false, options: [] };
    const exact = rows.filter((r) => normalizeName(r.label) === q);
    if (exact.length === 1) return { ok: true, row: exact[0]! };
    const qt = q.split(" ").filter((t) => t.length > 2 && !["los", "las", "una", "uno"].includes(t));
    const scored = rows
      .map((r) => {
        const rt = normalizeName(r.label).split(" ");
        const hits = qt.filter((t) => rt.some((x) => x === t || (t.length > 3 && x.startsWith(t.slice(0, -1))))).length;
        return { r, hits };
      })
      .filter((s) => s.hits > 0)
      .sort((a, b) => b.hits - a.hits);
    if (scored.length === 0) return { ok: false, options: [] };
    if (scored.length === 1 || scored[0]!.hits > scored[1]!.hits) return { ok: true, row: scored[0]!.r };
    return { ok: false, options: scored.filter((s) => s.hits === scored[0]!.hits).map((s) => s.r) };
  }

  private async customers() {
    const rows = await this.d.db.select().from(schema.customers).where(eq(schema.customers.merchantId, this.d.merchantId));
    return rows.map((r) => ({ ...r, label: r.name }));
  }

  private async payees() {
    const rows = await this.d.db.select().from(schema.payees).where(eq(schema.payees.merchantId, this.d.merchantId));
    return rows.map((r) => ({ ...r, label: r.alias }));
  }

  private async newProposal(fields: Record<string, unknown>, provenance: Provenance) {
    const proposal = Proposal.parse({ merchant_id: this.d.merchantId, provenance, ...fields });
    const pid = id("pr");
    const saved = await saveProposal(this.d.db, { id: pid, actorId: this.d.ownerId, proposal });
    return { id: pid, hash: saved.proposalHash, proposal };
  }

  // ---------- entrada del comercio ----------

  async handleMerchantMessage(text: string, provenance: Provenance = "user_direct"): Promise<void> {
    const body = text.trim().slice(0, 1000);
    if (!body) return;
    await this.heard("comercio", provenance === "third_party_content" ? `📎 (reenviado) ${body}` : body);

    // Un número de 18 dígitos en el mensaje es un intento de dar datos bancarios.
    if (CLABE_IN_TEXT.test(body)) {
      await this.blockBankDataFromChat(provenance);
      return;
    }

    const c = await interpretWithConsensus(this.d.interpreters, body);
    if (!c.agreed) {
      const opts = c.candidates.map(describeIntent).filter(Boolean).join(" o ");
      await this.say("comercio", opts ? `No estoy seguro. ¿Quisiste decir ${opts}? Escríbelo de nuevo, por favor.` : "No te entendí. Prueba: “Doña Lupe se llevó $185”.");
      return;
    }
    await this.route(c.intent, provenance);
  }

  private async blockBankDataFromChat(provenance: Provenance): Promise<void> {
    const decision = evaluateCreatePayee({
      provenance,
      actor: { phone_verified: true, role: "comercio" },
      risk: await this.riskFlags(),
      passkey_approved: false,
    });
    const reasons = [
      "Los datos bancarios solo salen del sistema; no uso CLABEs escritas en el chat (R11).",
      ...decision.rules_failed.map((f) => `${f.reason} (${f.rule_id})`),
      "Un beneficiario nuevo se da de alta con passkey y espera 24 h antes de recibir pagos (R04).",
    ];
    await this.recordBlock("CreatePayee", provenance, reasons);
    await this.say("comercio", `🛡️ No pago a esa cuenta.\n• ${[...new Set(reasons)].join("\n• ")}`);
  }

  private async recordBlock(type: string, provenance: Provenance, reasons: string[]): Promise<void> {
    await this.d.db.insert(schema.guardBlocks).values({
      merchantId: this.d.merchantId,
      kind: type,
      provenance,
      reasons,
      createdAt: this.d.now(),
    });
  }

  private async route(intent: Intent, provenance: Provenance): Promise<void> {
    switch (intent.kind) {
      case "out_of_scope":
        await this.say("comercio", "Solo te ayudo con fiado, cobros, tandas y pagos a proveedores.");
        return;
      case "unclear":
        await this.say("comercio", intent.question ?? "No te entendí. Prueba: “Doña Lupe se llevó $185” o “Cóbrale a Doña Lupe”.");
        return;
      case "register_cash_payment":
        await this.say("comercio", "Por ahora solo registro pagos por CoDi/SPEI, que se concilian solos. El efectivo aún no está habilitado.");
        return;
      case "query_balance":
        await this.answerBalance(intent.customer_name);
        return;
      case "query_limit": {
        const s = await this.n2bis();
        await this.say("comercio", s ? s.message : "No tengo configurado el valor de la UDI para calcular tu tope Nivel 2 Bis.");
        return;
      }
      case "charge_qr": {
        const r = await this.resolve(await this.customers(), intent.customer_name);
        if (!r.ok) {
          await this.say("comercio", r.options.length ? `¿Cuál? ${r.options.map((o) => o.name).join(", ")}` : `No tengo a “${intent.customer_name}” en tus clientes.`);
          return;
        }
        await this.chargeWithQr(r.row.id);
        return;
      }
      case "add_credit":
      case "send_reminder": {
        const r = await this.resolve(await this.customers(), intent.customer_name);
        if (!r.ok) {
          await this.say("comercio", r.options.length ? `¿Cuál? ${r.options.map((o) => o.name).join(", ")}` : `No tengo a “${intent.customer_name}” en tus clientes.`);
          return;
        }
        if (intent.kind === "add_credit") {
          const p = await this.newProposal(
            { type: "AddCredit", customer_id: r.row.id, amount_cents: intent.amount_cents, concept: intent.concept ?? "Fiado" },
            provenance,
          );
          await this.say("comercio", `Anoto ${formatMXN(BigInt(intent.amount_cents))} de fiado a ${r.row.name}. ¿Confirmas?`, confirmButtons(p.id), p.id);
        } else {
          const p = await this.newProposal({ type: "SendReminder", customer_id: r.row.id }, provenance);
          const bal = await ledgerBalance(this.d.db, this.d.merchantId, "1200", r.row.id);
          await this.say("comercio", `Le mando a ${r.row.name} su cobro de ${formatMXN(bal)} por CoDi. ¿Confirmas?`, confirmButtons(p.id), p.id);
        }
        return;
      }
      case "payout":
        await this.proposePayout(intent, provenance);
        return;
    }
  }

  private async answerBalance(name?: string): Promise<void> {
    const cs = await this.customers();
    if (name) {
      const r = await this.resolve(cs, name);
      if (!r.ok) {
        await this.say("comercio", `No tengo a “${name}” en tus clientes.`);
        return;
      }
      const b = await ledgerBalance(this.d.db, this.d.merchantId, "1200", r.row.id);
      const fav = await ledgerBalance(this.d.db, this.d.merchantId, "2100", r.row.id);
      await this.say("comercio", `${r.row.name} te debe ${formatMXN(b)}${fav > 0n ? ` y tiene ${formatMXN(fav)} a favor` : ""}.`);
      return;
    }
    const lines: string[] = [];
    for (const c of cs) {
      const b = await ledgerBalance(this.d.db, this.d.merchantId, "1200", c.id);
      if (b > 0n) lines.push(`• ${c.name}: ${formatMXN(b)}`);
    }
    await this.say("comercio", lines.length ? `Te deben:\n${lines.join("\n")}` : "Nadie te debe. 🎉");
  }

  private async proposePayout(intent: Extract<Intent, { kind: "payout" }>, provenance: Provenance): Promise<void> {
    const r = await this.resolve(await this.payees(), intent.payee_name);
    if (!r.ok) {
      await this.recordBlock("PayoutRequest", provenance, [`Beneficiario “${intent.payee_name}” no está en tu lista autorizada (R03).`]);
      await this.say("comercio", `🛡️ “${intent.payee_name}” no está en tu lista de proveedores autorizados. Darlo de alta requiere passkey y 24 h de espera.`);
      return;
    }
    const p = await this.newProposal(
      { type: "PayoutRequest", payee_id: r.row.id, amount_cents: intent.amount_cents, concept: intent.concept ?? `Pago a ${r.row.alias}` },
      provenance,
    );
    const ctx = await loadOutflowContext(this.d.db, p.id, this.d.now(), this.d.verify);
    const decision = evaluateOutflow(ctx.input);
    const amount = formatMXN(BigInt(intent.amount_cents));
    if (decision.decision === "allow") {
      await setProposalStatus(this.d.db, p.id, "queued", decision);
      await this.say("comercio", `✅ Dentro de tu mandato. Enviando ${amount} a ${r.row.alias} por SPEI (cuenta simulada)…`, undefined, p.id);
      return;
    }
    const reasons = decision.rules_failed.map((f) => `${f.reason} (${f.rule_id})`);
    if (decision.decision === "deny") {
      await setProposalStatus(this.d.db, p.id, "rejected", decision);
      await this.recordBlock("PayoutRequest", provenance, reasons);
      await this.say("comercio", `🛡️ No envío ${amount} a ${r.row.alias}.\n• ${reasons.join("\n• ")}`, undefined, p.id);
      return;
    }
    await setProposalStatus(this.d.db, p.id, "awaiting_passkey", decision);
    await this.recordBlock("PayoutRequest", provenance, reasons);
    const actions: MessageAction[] = this.d.publicUrl
      ? [{ kind: "approve", label: "Aprobar con passkey", url: `${this.d.publicUrl}/aprobar/${p.id}`, proposal_id: p.id }]
      : [];
    await this.say(
      "comercio",
      `🔐 Para enviar ${amount} a ${r.row.alias} necesito tu aprobación con passkey (un "sí" en el chat no basta):\n• ${reasons.join("\n• ")}`,
      actions,
      p.id,
    );
  }

  // ---------- botones ----------

  async confirm(proposalId: string): Promise<void> {
    const [p] = await this.d.db
      .select()
      .from(schema.proposals)
      .where(and(eq(schema.proposals.id, proposalId), eq(schema.proposals.merchantId, this.d.merchantId)));
    if (!p || p.status !== "pending") return;
    const parsed = Proposal.parse(p.payload);
    if (parsed.type === "AddCredit") {
      await postEntries(this.d.db, [
        fiado({
          merchant_id: this.d.merchantId,
          idempotency_key: `proposal:${p.id}:fiado`,
          amount: parsed.amount_cents,
          customer_id: parsed.customer_id,
          memo: parsed.concept,
        }),
      ]);
      await setProposalStatus(this.d.db, p.id, "done");
      const [c] = await this.d.db.select().from(schema.customers).where(eq(schema.customers.id, parsed.customer_id));
      const bal = await ledgerBalance(this.d.db, this.d.merchantId, "1200", parsed.customer_id);
      await this.say("comercio", `📒 Listo. ${c?.name} te debe ${formatMXN(bal)}.`);
      return;
    }
    if (parsed.type === "SendReminder") {
      await this.sendReminder(p.id, parsed.customer_id);
      return;
    }
  }

  async cancel(proposalId: string): Promise<void> {
    const [p] = await this.d.db.select().from(schema.proposals).where(eq(schema.proposals.id, proposalId));
    if (!p || p.status !== "pending" || p.merchantId !== this.d.merchantId) return;
    await setProposalStatus(this.d.db, p.id, "rejected", { cancelled_by_user: true });
    await this.say("comercio", "Cancelado. No anoté nada.");
  }

  private async sendReminder(proposalId: string, customerId: string): Promise<void> {
    const now = this.d.now();
    const [c] = await this.d.db.select().from(schema.customers).where(eq(schema.customers.id, customerId));
    if (!c) return;
    const balance = await ledgerBalance(this.d.db, this.d.merchantId, "1200", customerId);
    const [last] = await this.d.db
      .select({ at: schema.charges.createdAt })
      .from(schema.charges)
      .where(eq(schema.charges.customerId, customerId))
      .orderBy(desc(schema.charges.createdAt))
      .limit(1);
    const policy = evaluateReminder({
      now,
      ledger_balance: balance,
      amount: balance,
      last_reminder_at: last?.at ?? null,
      opt_in: c.optIn,
      template_id: REMINDER_TEMPLATE,
      approved_template_ids: [REMINDER_TEMPLATE],
    });
    const open = await this.openCharge(customerId);
    if (policy.allow && open) {
      await setProposalStatus(this.d.db, proposalId, "rejected", { open_charge: open.id });
      await this.say("comercio", `${c.name} ya tiene un cobro abierto (ref. ${open.reference}). No mando otro para que no pague doble.`);
      return;
    }
    if (!policy.allow) {
      await setProposalStatus(this.d.db, proposalId, "rejected", policy);
      await this.say("comercio", `No mando el cobro:\n• ${policy.rules_failed.map((f) => f.reason).join("\n• ")}`);
      return;
    }
    const chargeId = id("ch");
    const reference = await newChargeReference(this.d.db, this.d.merchantId);
    await insertCharge(this.d.db, { id: chargeId, merchantId: this.d.merchantId, customerId, reference, amountCents: balance, now });
    const phone = await customerPhone10(this.d.db, customerId);
    const [merchant] = await this.d.db.select().from(schema.merchants).where(eq(schema.merchants.id, this.d.merchantId));
    const concept = `Fiado ${merchant?.name ?? ""}`.slice(0, 40);

    let pushed = false;
    let failure: string | null = null;
    if (phone) {
      try {
        const pn = await this.d.gateway.requestPayment({
          amount_cents: balance,
          phone10: phone,
          concept,
          num_ref: reference,
          metadata: { cuadra_charge_id: chargeId },
          ...(merchant?.peyBankAccountId ? { bank_account_id: merchant.peyBankAccountId } : {}),
        });
        await attachProviderCharge(this.d.db, chargeId, { provider: this.d.gateway.name, providerChargeId: pn.provider_charge_id, channel: "codi_pn" });
        pushed = true;
      } catch (e) {
        failure = e instanceof Error ? e.message : String(e);
        this.d.log({ msg: "pey_pn_failed", merchant_id: this.d.merchantId, proposal_id: proposalId, error: failure });
      }
    }
    await setProposalStatus(this.d.db, proposalId, "done", { charge_id: chargeId, pushed });
    const amount = formatMXN(balance);
    const actions: MessageAction[] =
      pushed && this.d.gateway.simulated ? [{ kind: "pay", label: `Aprobar pago de ${amount} (banco simulado)`, url: `/api/sim/pay/${chargeId}` }] : [];
    await this.say(
      c.id,
      `Hola ${c.name} 👋 ${merchant?.name} te recuerda tu saldo de ${amount}.\n` +
        (pushed
          ? `Te llegó una solicitud de cobro CoDi a tu celular: ábrela en la app de tu banco y apruébala. Ref. ${reference}.`
          : `Ref. ${reference}.`),
      actions,
    );
    await this.say(
      "comercio",
      pushed
        ? `📨 Cobro de ${amount} enviado a ${c.name} por CoDi${this.d.gateway.simulated ? " (simulado)" : " vía pey"}. Te aviso cuando pague.`
        : `⚠️ No pude mandar la solicitud CoDi a ${c.name}${failure ? `: ${failure}` : " (no tiene celular)"}. Le dejé el recordatorio con la referencia ${reference}.`,
    );
  }

  private async openCharge(customerId: string) {
    const [open] = await this.d.db
      .select()
      .from(schema.charges)
      .where(and(eq(schema.charges.customerId, customerId), eq(schema.charges.status, "open")))
      .limit(1);
    return open ?? null;
  }

  /** Cobro en mostrador: QR CoDi por el saldo exacto, que el cliente escanea con su banco. */
  private async chargeWithQr(customerId: string): Promise<void> {
    const now = this.d.now();
    const [c] = await this.d.db.select().from(schema.customers).where(eq(schema.customers.id, customerId));
    if (!c) return;
    const balance = await ledgerBalance(this.d.db, this.d.merchantId, "1200", customerId);
    if (balance <= 0n) {
      await this.say("comercio", `${c.name} no te debe nada.`);
      return;
    }
    const open = await this.openCharge(customerId);
    if (open) {
      await this.say("comercio", `${c.name} ya tiene un cobro abierto (ref. ${open.reference}). Espera a que se pague para no cobrar doble.`);
      return;
    }
    const [merchant] = await this.d.db.select().from(schema.merchants).where(eq(schema.merchants.id, this.d.merchantId));
    const chargeId = id("ch");
    const reference = await newChargeReference(this.d.db, this.d.merchantId);
    await insertCharge(this.d.db, { id: chargeId, merchantId: this.d.merchantId, customerId, reference, amountCents: balance, now });
    try {
      const qr = await this.d.gateway.createQr({
        amount_cents: balance,
        concept: `Fiado ${merchant?.name ?? ""}`.slice(0, 40),
        num_ref: reference,
        metadata: { cuadra_charge_id: chargeId },
        ...(merchant?.peyBankAccountId ? { bank_account_id: merchant.peyBankAccountId } : {}),
      });
      await attachProviderCharge(this.d.db, chargeId, { provider: this.d.gateway.name, providerChargeId: qr.provider_charge_id, channel: "codi_qr" });
      const amount = formatMXN(balance);
      const actions: MessageAction[] = [
        { kind: "qr", label: "QR CoDi", ...(qr.image_png_base64 ? { url: `data:image/png;base64,${qr.image_png_base64}` } : {}) },
      ];
      if (this.d.gateway.simulated) actions.push({ kind: "pay", label: `${c.name} escanea y paga (simulado)`, url: `/api/sim/pay/${chargeId}` });
      await this.say("comercio", `📱 Que ${c.name} escanee este QR con la app de su banco: ${amount}, ref. ${reference}. Vale 30 min.`, actions);
    } catch (e) {
      await this.d.db.update(schema.charges).set({ status: "cancelled" }).where(eq(schema.charges.id, chargeId));
      await this.say("comercio", `⚠️ No pude generar el QR: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // ---------- pagos recibidos ----------

  /** Webhook de pey: verifica firma, deduplica por webhook-id y confirma cada pago contra la API. */
  async handlePeyWebhook(rawBody: string, headers: Record<string, string | undefined>): Promise<{ status: number; body: unknown }> {
    if (!this.d.peyWebhookSecret) return { status: 503, body: { error: "pey no configurado" } };
    let evt;
    try {
      evt = parsePeyWebhook(rawBody, headers, this.d.peyWebhookSecret);
    } catch (e) {
      if (e instanceof WebhookSignatureError) return { status: 400, body: { error: "firma inválida" } };
      throw e;
    }
    const fresh = await this.d.db
      .insert(schema.webhookEvents)
      .values({ provider: "pey", eventId: evt.event_id, payload: JSON.parse(rawBody) })
      .onConflictDoNothing()
      .returning({ id: schema.webhookEvents.eventId });
    if (fresh.length === 0) return { status: 200, body: { duplicate: true } };
    if (evt.kind === "ignored") return { status: 200, body: { ignored: evt.original_type } };
    try {
      for (const txId of evt.transaction_ids) {
        // "Confirma el pago desde el servidor": no confiamos en el monto del webhook.
        const tx = await this.d.gateway.getTransaction(txId);
        if (tx.status !== "PAID") continue;
        await this.applyPayment(tx);
      }
    } catch (e) {
      // Se borra el registro del evento para que el reintento de pey lo vuelva a procesar.
      await this.d.db
        .delete(schema.webhookEvents)
        .where(and(eq(schema.webhookEvents.provider, "pey"), eq(schema.webhookEvents.eventId, evt.event_id)));
      throw e;
    }
    return { status: 200, body: { ok: true } };
  }

  /** Modo simulado: el cliente aprobó el cobro en su "banco". Pasa por el mismo camino que pey. */
  async simulatePaid(providerChargeId: string): Promise<void> {
    if (!this.d.gateway.simulated) throw new Error("Solo en modo simulado");
    await this.applyPayment(await this.d.gateway.getTransaction(providerChargeId));
  }

  async applyPayment(tx: PeyTransaction): Promise<void> {
    const out = await recordProviderPayment(this.d.db, this.d.merchantId, {
      provider: this.d.gateway.name,
      transaction_id: tx.id,
      payable_id: tx.payable_id,
      base_cents: tx.base_cents,
      gross_cents: tx.amount_cents,
      tip_cents: tx.tip_cents,
      fee_cents: tx.fee_cents,
      payer_clabe: tx.payer_clabe,
      tracking_key: tx.tracking_key,
      charge_id_hint: tx.external_metadata.cuadra_charge_id ?? null,
      concept: null,
    });
    if (out.duplicate) return;
    if (this.d.bankSim) {
      await bankSimCredit(this.d.db, out.merchant_id, `cobro:${this.d.gateway.name}:${tx.id}`, tx.base_cents, "cobro");
    }
    const amount = formatMXN(tx.base_cents);
    if (out.match.matched) {
      const cid = out.match.customer_id;
      const [c] = await this.d.db.select().from(schema.customers).where(eq(schema.customers.id, cid));
      const bal = await ledgerBalance(this.d.db, out.merchant_id, "1200", cid);
      const fav = await ledgerBalance(this.d.db, out.merchant_id, "2100", cid);
      const rest = bal > 0n ? `Te falta ${formatMXN(bal)}.` : fav > 0n ? `Quedas al corriente y con ${formatMXN(fav)} a favor.` : "Quedas al corriente. ¡Gracias!";
      await this.say(cid, `🧾 Recibo: pagaste ${amount}. ${rest}`);
      await this.say("comercio", `💰 ${c?.name} pagó ${amount} por CoDi. Conciliado solo${bal > 0n ? `; aún debe ${formatMXN(bal)}` : "; queda en ceros"}.`);
      const s = await this.n2bis();
      if (s && s.level !== "ok") await this.say("comercio", `📈 ${s.message}`);
    } else {
      await this.say("comercio", `💰 Llegó un pago de ${amount} que no pude asignar. Quedó en “por identificar” (1300) para revisión.`);
    }
  }

  /** Tope mensual Nivel 2 Bis con los abonos digitales del mes (CDMX). */
  async n2bis() {
    if (this.d.udi === null) return null;
    const digital = await depositsSince(this.d.db, this.d.merchantId, mxPeriodStart(this.d.now(), "month"));
    return n2bisStatus({ udi: this.d.udi, digital_cents: digital, non_digital_cents: 0n });
  }

  // ---------- estado ----------

  async riskFlags() {
    const [r] = await this.d.db.select().from(schema.riskState).where(eq(schema.riskState.merchantId, this.d.merchantId));
    return {
      kill_switch: (r?.killSwitch ?? false) || (await globalKillSwitch(this.d.db)),
      account_frozen: r?.accountFrozen ?? false,
      reconciliation_mismatch: r?.reconciliationMismatch ?? false,
      auditor_veto: false,
    };
  }
}

function confirmButtons(proposalId: string): MessageAction[] {
  return [
    { kind: "confirm", label: "Confirmar", proposal_id: proposalId },
    { kind: "cancel", label: "Cancelar", proposal_id: proposalId },
  ];
}

function describeIntent(i: Intent): string {
  const m = (c: number) => formatMXN(BigInt(c) as Centavos);
  switch (i.kind) {
    case "add_credit":
      return `anotar ${m(i.amount_cents)} a ${i.customer_name}`;
    case "send_reminder":
      return `cobrarle a ${i.customer_name}`;
    case "payout":
      return `pagar ${m(i.amount_cents)} a ${i.payee_name}`;
    case "query_balance":
      return "consultar saldos";
    case "register_cash_payment":
      return `registrar pago de ${m(i.amount_cents)} de ${i.customer_name}`;
    default:
      return "";
  }
}
