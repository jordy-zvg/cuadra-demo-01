import { randomUUID } from "node:crypto";
import {
  PeyApiError,
  type PeyTransaction,
  WebhookSignatureError,
  parsePeyWebhook,
} from "@cuadra/adapters";
import { type Intent, type Interpreter, interpretWithConsensus, normalizeName } from "@cuadra/agents";
import {
  type Centavos,
  HOUR_MS,
  Proposal,
  REMINDER_MAX_RESENDS,
  REMINDER_MIN_INTERVAL_HOURS,
  type PolicyFailure,
  type ReminderDecision,
  evaluateCreatePayee,
  evaluateOutflow,
  evaluateReminder,
  evaluateResend,
  fiado,
  formatMXN,
  formatMxWhen,
  mxPeriodStart,
  n2bisStatus,
  type UdiMicro,
} from "@cuadra/core";
import {
  type AssertionVerifier,
  CHARGE_EXPIRY_GRACE_MS,
  type Db,
  type MessageAction,
  attachProviderCharge,
  bankSimCredit,
  customerPhone10,
  depositsSince,
  globalKillSwitch,
  insertCharge,
  openChargeFor,
  ledgerBalance,
  loadOutflowContext,
  newChargeReference,
  postEntries,
  recordProviderPayment,
  saveProposal,
  schema,
  setProposalStatus,
} from "@cuadra/db";
import { and, count, desc, eq, gte, isNotNull, isNull, ne, or } from "drizzle-orm";
import { type ChargeGateway, PN_TTL_S, QR_TTL_S } from "./gateway.js";
import { type OutboundChannel, resolveThreadPhone } from "./channel.js";
import { type ReconResult, reconcileWithProvider } from "./provider-reconciliation.js";
import { TandaFlow } from "./tanda-flow.js";
import type { TemplateRef } from "./whatsapp-templates.js";

/** Debe coincidir con la plantilla aprobada en Meta (whatsapp-templates.ts). */
export const REMINDER_TEMPLATE = "cuadra_cobro_fiado";

/** Una propuesta de cobro se confirma dentro de este plazo; después se vuelve a pedir. */
const PROPOSAL_TTL_MS = 10 * 60_000;
/** Solicitudes al celular que se revisan con pey antes de mandar otra (cubre vigencia + conciliación). */
const RECENT_PROVIDER_CHECK_MS = 60 * 60_000;

type ReminderOutcome = "sent" | "skipped" | "unknown" | "failed";

/** Lo que se sabe de una ejecución en curso, para decir la verdad si falla a medio camino. */
interface ExecState {
  chargeId: string | null;
  pushAttempted: boolean;
  expiresAt: Date | null;
  name: string;
}

/** Una ejecución "executing" sin terminar después de esto se dio por perdida (p. ej. reinicio). */
const STUCK_EXECUTION_MS = 2 * 60_000;

/** Lo que se le propuso al comercio; al confirmar debe seguir igual. */
interface PlannedReminder {
  mode: "new" | "resend";
  amount: string;
  at: string;
}

/** Hacia arriba al minuto: si se muestra "16:11", a las 16:11 ya se puede. */
function ceilToMinute(d: Date): Date {
  return new Date(Math.ceil(d.getTime() / 60_000) * 60_000);
}

/** Resultado de planReminder: qué se puede mandar hoy al cliente, o por qué no. */
type ReminderPlan =
  | { ok: true; name: string; mode: "new" | "resend"; amount: Centavos; phone: string | null; resendOf: string | null; resendNumber: number }
  | { ok: false; name: string; message: string; decision: Record<string, unknown> };

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
  /** Canales que además entregan los mensajes (WhatsApp, SMS). El chat web lee de la base. */
  channels?: OutboundChannel[];
  /**
   * Horas mínimas entre recordatorios al mismo cliente (P03). Default 72 (política); solo en
   * desarrollo se baja con REMINDER_COOLDOWN_HOURS para probar seguido.
   */
  reminderCooldownHours?: number;
  log: (r: Record<string, unknown>) => void;
}

export type Provenance = "user_direct" | "user_voice" | "third_party_content";

const id = (p: string) => `${p}_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
const CLABE_IN_TEXT = /\b\d{18}\b/;

export class CuadraService {
  readonly tanda: TandaFlow;
  /** Cobros al mismo cliente (solicitudes CoDi y QR): de uno en uno. */
  private readonly chargeLocks = new Map<string, Promise<void>>();
  constructor(private readonly d: ServiceDeps) {
    this.tanda = new TandaFlow({
      db: d.db,
      merchantId: d.merchantId,
      gateway: d.gateway,
      verify: d.verify,
      now: d.now,
      say: (thread, body, actions, template) => this.say(thread, body, actions, undefined, template),
      log: d.log,
    });
  }

  // ---------- mensajes ----------

  private async say(thread: string, body: string, actions?: MessageAction[], proposalId?: string, template?: TemplateRef): Promise<void> {
    await this.d.db.insert(schema.messages).values({
      merchantId: this.d.merchantId,
      thread,
      direction: "out",
      body,
      actions: actions ?? null,
      proposalId: proposalId ?? null,
      createdAt: this.d.now(),
    });
    await this.deliver(thread, body, actions ?? [], template);
  }

  /** Entrega a los canales configurados; un canal caído no rompe el flujo del dinero. */
  private async deliver(thread: string, body: string, actions: MessageAction[], template?: TemplateRef): Promise<void> {
    const channels = this.d.channels ?? [];
    if (channels.length === 0) return;
    const phone10 = await resolveThreadPhone(this.d.db, this.d.merchantId, this.d.ownerId, thread);
    if (!phone10) return;
    for (const ch of channels) {
      try {
        await ch.send({ merchantId: this.d.merchantId, thread, phone10, body, actions, ...(template ? { template } : {}) });
      } catch (e) {
        this.d.log({ msg: "channel_send_failed", channel: ch.name, merchant_id: this.d.merchantId, error: e instanceof Error ? e.message : String(e) });
      }
    }
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
        await this.say(
          "comercio",
          intent.question ?? "No te entendí. Prueba: “Doña Lupe se llevó $185”, “Cóbrale a Doña Lupe” o “Vuélvele a mandar la notificación”.",
        );
        return;
      case "register_cash_payment":
        await this.say("comercio", "Por ahora solo registro pagos por CoDi/SPEI, que se concilian solos. El efectivo aún no está habilitado.");
        return;
      case "query_balance":
        await this.answerBalance(intent.customer_name);
        return;
      case "start_tanda_round":
        await this.tanda.startRound();
        return;
      case "tanda_reminder":
        await this.tanda.remindPending();
        return;
      case "query_tanda":
        await this.say("comercio", await this.tanda.describe());
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
        await this.serialized(r.row.id, () => this.chargeWithQr(r.row.id));
        return;
      }
      case "add_credit":
      case "send_reminder":
      case "resend_reminder": {
        if (!intent.customer_name) {
          // "Vuélvele a mandar la notificación": el cliente de la última solicitud CoDi.
          const last = await this.lastPushedCustomer();
          if (!last) {
            await this.say("comercio", "¿A quién le reenvío el cobro? Por ejemplo: “Reenvíale el cobro a Doña Lupe”.");
            return;
          }
          await this.proposeReminder(last, provenance);
          return;
        }
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
          await this.proposeReminder(r.row, provenance);
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
    if (!p) return;
    if (p.status === "executing") {
      if (Date.now() - p.updatedAt.getTime() < STUCK_EXECUTION_MS) {
        await this.say("comercio", "Ese cobro se está procesando; en un momento te digo cómo quedó.");
        return;
      }
      // Quedó a medias (p. ej. se reinició el servidor): se cierra y se dice qué pudo pasar.
      const [closed] = await this.d.db
        .update(schema.proposals)
        .set({ status: "rejected", decision: { interrupted: true }, updatedAt: new Date() })
        .where(and(eq(schema.proposals.id, p.id), eq(schema.proposals.status, "executing")))
        .returning({ id: schema.proposals.id });
      if (closed) {
        await this.say(
          "comercio",
          "Ese cobro quedó a medias (se interrumpió mientras lo enviaba). Si era una solicitud al celular, puede que le haya llegado: revisa el panel y pídemelo de nuevo si hace falta.",
        );
      }
      return;
    }
    if (p.status !== "pending") return;
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
    // Solo se cancela lo que sigue pendiente (compare-and-set): si ya se está ejecutando, se dice.
    const [done] = await this.d.db
      .update(schema.proposals)
      .set({ status: "rejected", decision: { cancelled_by_user: true }, updatedAt: new Date() })
      .where(and(eq(schema.proposals.id, proposalId), eq(schema.proposals.merchantId, this.d.merchantId), eq(schema.proposals.status, "pending")))
      .returning({ id: schema.proposals.id });
    if (done) {
      await this.say("comercio", "Cancelado. No anoté nada.");
      return;
    }
    const [p] = await this.d.db.select({ status: schema.proposals.status }).from(schema.proposals).where(eq(schema.proposals.id, proposalId));
    if (p?.status === "executing") await this.say("comercio", "Ya no se puede cancelar: ese cobro se está enviando.");
  }

  /**
   * Recordatorios programados (reglas del comercio, p. ej. viernes 10:00): un SendReminder por cada
   * cliente con saldo y opt-in. La política (72 h, horario, opt-in, un cobro abierto) se aplica igual
   * que en el chat; los que no pasan se omiten en silencio y al final va un solo resumen al comercio.
   */
  async runScheduledReminders(): Promise<{ sent: number; skipped: number; unknown?: number; failed?: number }> {
    const rows = await this.d.db
      .select({ id: schema.customers.id })
      .from(schema.customers)
      .where(and(eq(schema.customers.merchantId, this.d.merchantId), eq(schema.customers.optIn, true)));
    let sent = 0;
    let skipped = 0;
    let unknown = 0;
    let failed = 0;
    for (const r of rows) {
      if ((await ledgerBalance(this.d.db, this.d.merchantId, "1200", r.id)) <= 0n) continue;
      const p = await this.newProposal({ type: "SendReminder", customer_id: r.id }, "user_direct");
      const o = await this.sendReminder(p.id, r.id, { scheduled: true });
      if (o === "sent") sent++;
      else if (o === "unknown") unknown++;
      else if (o === "failed") failed++;
      else skipped++;
    }
    if (sent + skipped + unknown + failed > 0) {
      const parts = [`mandé ${sent} cobro${sent === 1 ? "" : "s"}`];
      if (skipped) {
        parts.push(`${skipped} no salieron (cobro abierto, recordatorio en las últimas ${this.d.reminderCooldownHours ?? REMINDER_MIN_INTERVAL_HOURS} h o fuera de horario)`);
      }
      if (unknown) parts.push(`con ${unknown} pey no respondió y puede que sí les haya llegado (te avisé arriba)`);
      if (failed) parts.push(`${failed} fallaron por un error; inténtalo desde el chat`);
      await this.say("comercio", `🔔 Recordatorios programados: ${parts.join("; ")}.`);
    }
    return { sent, skipped, ...(unknown ? { unknown } : {}), ...(failed ? { failed } : {}) };
  }

  /**
   * Decide si hoy se le puede cobrar al cliente por su celular, y cómo (código, no LLM). Se evalúa
   * al proponer (para no pedir "Confirmar" en vano) y otra vez al ejecutar.
   * - "new": recordatorio normal (mensaje + solicitud CoDi), si pasa la política de recordatorios.
   * - "resend": solo la solicitud CoDi, si lo único que lo impide es P03 y la anterior venció sin
   *   pago (evaluateResend). Nunca hay dos solicitudes vivas: así no puede pagar doble.
   */
  private async planReminder(customerId: string, opts: { scheduled?: boolean } = {}, at?: Date): Promise<ReminderPlan> {
    // Una sola hora por ejecución: lo que estaba vivo al consultar a pey sigue vivo al decidir.
    const now = at ?? this.d.now();
    const [c] = await this.d.db.select().from(schema.customers).where(eq(schema.customers.id, customerId));
    if (!c) return { ok: false, name: "", message: "No encontré a ese cliente.", decision: { reason: "customer_not_found" } };
    const balance = await ledgerBalance(this.d.db, this.d.merchantId, "1200", customerId);
    if (balance <= 0n) {
      return {
        ok: false,
        name: c.name,
        message: `${c.name} no te debe nada, así que no hay cobro que mandar. Si se llevó algo, dime “${c.name} se llevó $…”.`,
        decision: { rules_failed: [{ rule_id: "P01", reason: "El cliente no tiene saldo pendiente." }] },
      };
    }
    // Marca como vencidos los cobros que ya vencieron; uno vivo impide otra solicitud (pagaría doble).
    const open = await this.openCharge(customerId, now);
    // Recordatorios previos = cobros que sí le llegaron al cliente por este canal: no cuentan los QR
    // de mostrador, los cancelados (la solicitud no salió) ni los simulados cuando el cobro es real.
    const delivered = and(
      eq(schema.charges.customerId, customerId),
      ne(schema.charges.status, "cancelled"),
      or(isNull(schema.charges.channel), ne(schema.charges.channel, "codi_qr")),
      or(isNull(schema.charges.provider), eq(schema.charges.provider, this.d.gateway.name)),
    );
    const [lastReminder] = await this.d.db
      .select()
      .from(schema.charges)
      .where(and(delivered, isNull(schema.charges.resendOf)))
      .orderBy(desc(schema.charges.createdAt))
      .limit(1);
    const cooldown = this.d.reminderCooldownHours ?? REMINDER_MIN_INTERVAL_HOURS;
    const policy = evaluateReminder({
      now,
      ledger_balance: balance,
      amount: balance,
      last_reminder_at: lastReminder?.createdAt ?? null,
      min_interval_hours: cooldown,
      opt_in: c.optIn,
      template_id: REMINDER_TEMPLATE,
      approved_template_ids: [REMINDER_TEMPLATE],
    });
    const phone = await customerPhone10(this.d.db, customerId);
    if (policy.allow && !open) return { ok: true, name: c.name, mode: "new", amount: balance, phone, resendOf: null, resendNumber: 0 };

    const resendsOf = async (reminderId: string): Promise<number> => {
      const [{ n } = { n: 0 }] = await this.d.db
        .select({ n: count() })
        .from(schema.charges)
        .where(and(eq(schema.charges.resendOf, reminderId), ne(schema.charges.status, "cancelled")));
      return n;
    };
    const onlyP03 = policy.rules_failed.length === 1 && policy.rules_failed[0]!.rule_id === "P03";
    const nextReminder = lastReminder ? ceilToMinute(new Date(lastReminder.createdAt.getTime() + cooldown * HOUR_MS)) : null;
    const describe = (failed: PolicyFailure[]) =>
      failed.map((f) => (f.rule_id === "P03" && nextReminder ? `${f.reason} El siguiente se puede ${formatMxWhen(nextReminder, now)}.` : f.reason));

    if (open) {
      // Con un cobro vivo no sale otro (ni QR): primero se paga o vence. Se dice qué sigue después.
      const openMsg = this.openChargeMessage(c.name, open, now);
      const decision = { ...policy, open_charge: open.id };
      if (open.channel === "codi_pn" && phone && !opts.scheduled) {
        if (policy.allow) return { ok: false, name: c.name, message: `${openMsg} Si no la paga, cuando venza puedes volver a cobrarle.`, decision };
        if (onlyP03 && lastReminder) {
          const n = await resendsOf(lastReminder.id);
          if (n < REMINDER_MAX_RESENDS) {
            return {
              ok: false,
              name: c.name,
              message: `${openMsg} Si no la paga, cuando venza pídeme “vuélvele a mandar la notificación” y se la reenvío (reenvío ${n + 1} de ${REMINDER_MAX_RESENDS}).`,
              decision,
            };
          }
        }
      }
      const reasons = describe(policy.rules_failed);
      return { ok: false, name: c.name, message: reasons.length ? `${openMsg}\nAdemás:\n• ${reasons.join("\n• ")}` : openMsg, decision };
    }

    let failed = policy.rules_failed;
    let resend: ReminderDecision | null = null;
    if (!opts.scheduled && lastReminder && failed.some((f) => f.rule_id === "P03")) {
      const [lastCharge] = await this.d.db.select().from(schema.charges).where(delivered).orderBy(desc(schema.charges.createdAt)).limit(1);
      const n = await resendsOf(lastReminder.id);
      resend = evaluateResend(policy, {
        last_charge: lastCharge ? { status: lastCharge.status, channel: lastCharge.channel } : null,
        resends_in_cycle: n,
      });
      if (resend.allow && phone) {
        return { ok: true, name: c.name, mode: "resend", amount: balance, phone, resendOf: lastReminder.id, resendNumber: n + 1 };
      }
      // Se explica por qué no se puede reenviar, sin repetir las reglas que ya fallaron.
      const extra = resend.rules_failed.filter((f) => f.rule_id === "P07" || f.rule_id === "P08");
      if (resend.allow && !phone) extra.push({ rule_id: "P07", reason: "No tiene un celular válido para CoDi." });
      failed = [...failed, ...extra];
    }
    return {
      ok: false,
      name: c.name,
      message: `No mando el cobro a ${c.name}:\n• ${describe(failed).join("\n• ")}\nSi está en la tienda, cóbrale con “QR para ${c.name}”.`,
      decision: { ...policy, ...(resend ? { resend } : {}) },
    };
  }

  /** "Doña Lupe ya tiene una solicitud abierta… vence a las 16:11". */
  private openChargeMessage(name: string, open: typeof schema.charges.$inferSelect, now: Date): string {
    const what = open.channel === "codi_pn" ? "una solicitud CoDi abierta" : open.channel === "codi_qr" ? "un QR abierto" : "un cobro abierto";
    const amount = open.amountCents !== null ? ` de ${formatMXN(open.amountCents)}` : "";
    const until = open.expiresAt ? ` que vence ${formatMxWhen(ceilToMinute(new Date(open.expiresAt.getTime() + CHARGE_EXPIRY_GRACE_MS)), now)}` : "";
    return `${name} ya tiene ${what}${amount} (ref. ${open.reference})${until}. Espera a que la pague o a que venza para no cobrarle doble.`;
  }

  /** Propone el cobro al celular: si la política no lo permite, lo dice de una vez, sin pedir "Confirmar". */
  private async proposeReminder(customer: { id: string; name: string }, provenance: Provenance): Promise<void> {
    const plan = await this.planReminder(customer.id);
    const p = await this.newProposal({ type: "SendReminder", customer_id: customer.id }, provenance);
    if (!plan.ok) {
      await setProposalStatus(this.d.db, p.id, "rejected", plan.decision);
      await this.say("comercio", plan.message);
      return;
    }
    // Lo que se le muestra al comercio es lo que se ejecuta: si al confirmar cambió, se vuelve a pedir.
    const planned: PlannedReminder = { mode: plan.mode, amount: plan.amount.toString(), at: this.d.now().toISOString() };
    await setProposalStatus(this.d.db, p.id, "pending", { planned });
    const amount = formatMXN(plan.amount);
    await this.say(
      "comercio",
      plan.mode === "resend"
        ? `La solicitud anterior a ${customer.name} venció sin pago. Le reenvío la solicitud CoDi de ${amount} a su celular, sin otro mensaje (reenvío ${plan.resendNumber} de ${REMINDER_MAX_RESENDS}). ¿Confirmas?`
        : plan.phone
          ? `Le mando a ${customer.name} su cobro de ${amount} por CoDi. ¿Confirmas?`
          : `${customer.name} no tiene un celular válido para CoDi. Le dejo el recordatorio de ${amount} con una referencia para que te pague por transferencia. ¿Confirmas?`,
      confirmButtons(p.id),
      p.id,
    );
  }

  /** Cliente de la última solicitud CoDi al celular ("vuélvele a mandar la notificación"). */
  private async lastPushedCustomer(): Promise<{ id: string; name: string } | null> {
    const [row] = await this.d.db
      .select({ id: schema.customers.id, name: schema.customers.name })
      .from(schema.charges)
      .innerJoin(schema.customers, eq(schema.customers.id, schema.charges.customerId))
      .where(
        and(
          eq(schema.charges.merchantId, this.d.merchantId),
          eq(schema.charges.channel, "codi_pn"),
          ne(schema.charges.status, "cancelled"),
          eq(schema.charges.provider, this.d.gateway.name),
        ),
      )
      .orderBy(desc(schema.charges.createdAt))
      .limit(1);
    return row ?? null;
  }

  /**
   * Los cobros a un mismo cliente (solicitudes CoDi y QR) se ejecutan de uno en uno (un solo proceso
   * de API): dos confirmaciones simultáneas no pueden dejar dos solicitudes vivas. Clientes distintos
   * no se esperan entre sí.
   */
  private serialized<T>(customerId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.chargeLocks.get(customerId) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    this.chargeLocks.set(customerId, tail);
    void tail.then(() => {
      if (this.chargeLocks.get(customerId) === tail) this.chargeLocks.delete(customerId);
    });
    return run;
  }

  /**
   * Antes de otra solicitud o un QR: pregunta a pey por las solicitudes al celular recientes que
   * Cuadra dio por vencidas con su reloj. Si alguna ya se pagó (webhook perdido o tardío), se
   * registra ahí mismo. Si pey no responde, no se manda nada: podría estar pagada (fail closed).
   */
  private async settleRecentWithProvider(customerId: string, at: Date): Promise<{ ok: true } | { ok: false; error: string }> {
    if (this.d.gateway.simulated) return { ok: true };
    await this.openCharge(customerId, at); // marca como vencidas las que ya pasaron su vigencia
    const since = new Date(at.getTime() - RECENT_PROVIDER_CHECK_MS);
    const rows = await this.d.db
      .select()
      .from(schema.charges)
      .where(
        and(
          eq(schema.charges.customerId, customerId),
          eq(schema.charges.status, "expired"),
          eq(schema.charges.channel, "codi_pn"),
          eq(schema.charges.provider, this.d.gateway.name),
          isNotNull(schema.charges.providerChargeId),
          gte(schema.charges.createdAt, since),
        ),
      );
    for (const r of rows) {
      let tx: PeyTransaction;
      try {
        tx = await this.d.gateway.getTransaction(r.providerChargeId!);
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
      if (tx.status === "PAID") await this.applyPayment(tx);
    }
    return { ok: true };
  }

  /**
   * "sent": salió. "skipped": la política o el estado no lo permitieron (con scheduled no se avisa uno
   * por uno). "unknown": pudo haber salido (pey no respondió). "failed": no salió por un error.
   */
  private sendReminder(proposalId: string, customerId: string, opts: { scheduled?: boolean } = {}): Promise<ReminderOutcome> {
    return this.serialized(customerId, () => this.sendReminderNow(proposalId, customerId, opts));
  }

  private async sendReminderNow(proposalId: string, customerId: string, opts: { scheduled?: boolean }): Promise<ReminderOutcome> {
    // Una propuesta se ejecuta una sola vez aunque llegue "Confirmar" dos veces.
    const [claimed] = await this.d.db
      .update(schema.proposals)
      .set({ status: "executing", updatedAt: new Date() })
      .where(and(eq(schema.proposals.id, proposalId), eq(schema.proposals.status, "pending")))
      .returning({ id: schema.proposals.id, decision: schema.proposals.decision });
    if (!claimed) return "skipped";

    // Estado del cobro para limpiar si algo falla a medio camino.
    const st: ExecState = { chargeId: null, pushAttempted: false, expiresAt: null, name: "" };
    try {
      return await this.executeReminder(proposalId, customerId, opts, claimed.decision as { planned?: PlannedReminder } | null, st);
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      this.d.log({ msg: "reminder_failed", merchant_id: this.d.merchantId, proposal_id: proposalId, error, push_attempted: st.pushAttempted });
      if (st.chargeId && !st.pushAttempted) {
        // La solicitud nunca se pidió: el cobro no existe para el cliente y se cancela.
        await this.d.db.update(schema.charges).set({ status: "cancelled" }).where(eq(schema.charges.id, st.chargeId)).catch(() => undefined);
        await setProposalStatus(this.d.db, proposalId, "rejected", { error }).catch(() => undefined);
        if (!opts.scheduled) await this.say("comercio", `⚠️ No pude completar el cobro: ${error}. Intenta de nuevo.`).catch(() => undefined);
        return "failed";
      }
      if (st.chargeId) {
        // Ya se le pidió a pey: pudo haber salido. El cobro ya está marcado como solicitud y bloquea
        // otra hasta que venza; se dice la verdad, aun en los recordatorios programados.
        await setProposalStatus(this.d.db, proposalId, "done", { charge_id: st.chargeId, push: "unknown", error }).catch(() => undefined);
        const until = st.expiresAt ? ` hasta que venza (${formatMxWhen(ceilToMinute(new Date(st.expiresAt.getTime() + CHARGE_EXPIRY_GRACE_MS)), this.d.now())})` : "";
        await this.say(
          "comercio",
          `⚠️ Algo falló después de pedirle la solicitud a pey (${error}). Puede que le haya llegado a ${st.name}: para no cobrarle doble, no mando otra${until}.`,
        ).catch(() => undefined);
        return "unknown";
      }
      await setProposalStatus(this.d.db, proposalId, "rejected", { error }).catch(() => undefined);
      if (!opts.scheduled) await this.say("comercio", `⚠️ No pude completar el cobro: ${error}. Intenta de nuevo.`).catch(() => undefined);
      return "failed";
    }
  }

  private async executeReminder(
    proposalId: string,
    customerId: string,
    opts: { scheduled?: boolean },
    decision: { planned?: PlannedReminder } | null,
    st: ExecState,
  ): Promise<ReminderOutcome> {
    const reject = async (message: string, why: Record<string, unknown>): Promise<ReminderOutcome> => {
      await setProposalStatus(this.d.db, proposalId, "rejected", why);
      if (!opts.scheduled) await this.say("comercio", message);
      return "skipped";
    };
    const at = this.d.now();
    const planned = decision?.planned ?? null;
    // Lo que el comercio confirma desde el chat siempre trae lo que se le propuso; sin eso (p. ej. un
    // botón de antes de esta versión) no se sabe qué aprobó, así que se vuelve a pedir.
    if (!opts.scheduled && !planned) {
      return reject("Esa propuesta ya no aplica. Pídemelo de nuevo y te digo cómo queda.", { stale_proposal: true });
    }
    if (planned && at.getTime() - Date.parse(planned.at) > PROPOSAL_TTL_MS) {
      return reject("Esa propuesta ya venció (dura 10 min). Pídemelo de nuevo y te digo cómo queda.", { expired_proposal: true, planned });
    }
    // Un pago que pey ya tenía y Cuadra no (webhook perdido) se registra antes de decidir.
    const settled = await this.settleRecentWithProvider(customerId, at);
    if (!settled.ok) {
      const [c] = await this.d.db.select({ name: schema.customers.name }).from(schema.customers).where(eq(schema.customers.id, customerId));
      return reject(
        `⚠️ No pude confirmar con pey si ${c?.name ?? "el cliente"} ya pagó la solicitud anterior (${settled.error}). Para no cobrarle doble, no mando otra: intenta en unos minutos.`,
        { provider_check_failed: settled.error },
      );
    }
    const plan = await this.planReminder(customerId, opts, at);
    if (!plan.ok) return reject(plan.message, plan.decision);
    if (planned && (planned.mode !== plan.mode || planned.amount !== plan.amount.toString())) {
      const now = plan.mode === "resend" ? `reenviarle la solicitud de ${formatMXN(plan.amount)}` : `mandarle un cobro de ${formatMXN(plan.amount)}`;
      return reject(`Algo cambió desde que te lo propuse: ahora tocaría ${now} a ${plan.name}. Pídemelo de nuevo para confirmarlo.`, {
        plan_changed: true,
        planned,
        now: { mode: plan.mode, amount: plan.amount.toString() },
      });
    }

    const now = this.d.now();
    const { phone, amount: balance, name } = plan;
    st.name = name;
    const chargeId = id("ch");
    const reference = await newChargeReference(this.d.db, this.d.merchantId);
    const expiresAt = new Date(now.getTime() + PN_TTL_S * 1000);
    // Con celular, el cobro nace marcado como solicitud CoDi (proveedor, canal, 6 min): si algo falla
    // después de llamar a pey, igual bloquea otra solicitud o un QR hasta que venza.
    await insertCharge(this.d.db, {
      id: chargeId,
      merchantId: this.d.merchantId,
      customerId,
      reference,
      amountCents: balance,
      now,
      resendOf: plan.resendOf,
      ...(phone ? { via: { provider: this.d.gateway.name, channel: "codi_pn" as const, expiresAt } } : {}),
    });
    st.chargeId = chargeId;
    if (phone) st.expiresAt = expiresAt;
    const [merchant] = await this.d.db.select().from(schema.merchants).where(eq(schema.merchants.id, this.d.merchantId));
    const concept = `Fiado ${merchant?.name ?? ""}`.slice(0, 40);
    const amount = formatMXN(balance);

    // Resultado de la solicitud: "sent" (pey la aceptó), "rejected" (pey la rechazó, 4xx: no existe),
    // "unknown" (red, 5xx o tiempo agotado: pudo haberse creado y el cliente pagarla).
    let outcome: "none" | "sent" | "rejected" | "unknown" = "none";
    let codiId: string | null = null;
    let failure: string | null = null;
    if (phone) {
      st.pushAttempted = true;
      let providerChargeId: string | null = null;
      try {
        const pn = await this.d.gateway.requestPayment({
          amount_cents: balance,
          phone10: phone,
          concept,
          num_ref: reference,
          metadata: { cuadra_charge_id: chargeId },
          ttl_s: PN_TTL_S,
          ...(merchant?.peyBankAccountId ? { bank_account_id: merchant.peyBankAccountId } : {}),
        });
        outcome = "sent";
        providerChargeId = pn.provider_charge_id;
        codiId = pn.codi_id ?? null;
      } catch (e) {
        failure = e instanceof Error ? e.message : String(e);
        outcome = e instanceof PeyApiError && e.status < 500 ? "rejected" : "unknown";
        // Principio 12: se reporta lo que respondió pey (sin secretos) para poder escalarlo.
        this.d.log({
          msg: "pey_pn_failed",
          merchant_id: this.d.merchantId,
          proposal_id: proposalId,
          charge_id: chargeId,
          outcome,
          error: failure,
          ...(e instanceof PeyApiError ? { status: e.status, type: e.type, request_id: e.requestId } : {}),
        });
      }
      if (outcome === "sent") {
        this.d.log({
          msg: "pey_pn_sent",
          merchant_id: this.d.merchantId,
          proposal_id: proposalId,
          charge_id: chargeId,
          transaction_id: providerChargeId,
          codi_id: codiId,
          ...(plan.resendOf ? { resend_of: plan.resendOf, resend_number: plan.resendNumber } : {}),
        });
      }
      if (outcome === "sent" && providerChargeId) {
        // El cobro ya está marcado como solicitud; aquí solo se guarda el id de pey (con un reintento).
        // Si aun así falla, el cobro sigue abierto hasta que venza y el pago se reconoce por la metadata.
        const id = providerChargeId;
        const attach = async (): Promise<void> => {
          await attachProviderCharge(this.d.db, chargeId, { provider: this.d.gateway.name, providerChargeId: id, channel: "codi_pn", expiresAt });
        };
        await attach().catch(async (e: unknown) => {
          this.d.log({ msg: "attach_charge_failed", charge_id: chargeId, error: e instanceof Error ? e.message : String(e) });
          await attach();
        });
      }
    }

    if (outcome === "rejected") {
      // pey rechazó la solicitud (p. ej. el celular no está registrado en CoDi): no existe, así que
      // el cobro se cancela, no cuenta como recordatorio y al cliente no se le manda nada.
      await this.d.db.update(schema.charges).set({ status: "cancelled" }).where(eq(schema.charges.id, chargeId));
      await reject(
        `⚠️ No salió la solicitud CoDi de ${amount} a ${name}${failure ? `: ${failure}` : ""}. No le mandé nada. ` +
          `Revisa que su celular esté registrado en CoDi en la app de su banco, o cóbrale con “QR para ${name}”.`,
        { charge_id: chargeId, push_failed: failure },
      );
      return "failed";
    }
    if (outcome === "unknown") {
      await setProposalStatus(this.d.db, proposalId, "done", { charge_id: chargeId, push: "unknown", error: failure });
      // Se avisa aunque sea un recordatorio programado: puede haber una solicitud viva en su celular.
      const lastResend = plan.mode === "resend" && plan.resendNumber >= REMINDER_MAX_RESENDS;
      await this.say(
        "comercio",
        `⚠️ pey no respondió bien${failure ? ` (${failure})` : ""}. Puede que la solicitud de ${amount} sí le haya llegado a ${name}: ` +
          `para no cobrarle doble, no mando otra hasta que venza (${formatMxWhen(ceilToMinute(new Date(expiresAt.getTime() + CHARGE_EXPIRY_GRACE_MS)), now)}). ` +
          (lastResend
            ? `Ya fue el último reenvío: después cóbrale con “QR para ${name}”.`
            : `Después pídeme “vuélvele a mandar la notificación” o cóbrale con “QR para ${name}”.`),
      );
      return "unknown";
    }

    const pushed = outcome === "sent";
    await setProposalStatus(this.d.db, proposalId, "done", {
      charge_id: chargeId,
      pushed,
      ...(codiId ? { codi_id: codiId } : {}),
      ...(plan.resendOf ? { resend_of: plan.resendOf, resend_number: plan.resendNumber } : {}),
    });
    const sim = this.d.gateway.simulated;
    const simPay: MessageAction[] = pushed && sim ? [{ kind: "pay", label: `Aprobar pago de ${amount} (banco simulado)`, url: `/api/sim/pay/${chargeId}` }] : [];
    const validity = `vigente ${PN_TTL_S / 60} min`;

    if (plan.mode === "resend") {
      // Reenvío: solo la solicitud CoDi; al cliente no le llega otro mensaje.
      await this.say(
        "comercio",
        `🔁 Le reenvié a ${name} la solicitud CoDi de ${amount}${sim ? " (simulado)" : ""} (${validity}, reenvío ${plan.resendNumber} de ${REMINDER_MAX_RESENDS}). ` +
          `Le llega como notificación de la app de su banco. Te aviso cuando pague.`,
        simPay,
      );
      return "sent";
    }
    await this.say(
      customerId,
      `Hola ${name} 👋 Te saludamos de ${merchant?.name}. Tu cuenta va en ${amount}.\n` +
        (pushed
          ? `Te mandamos la solicitud de cobro a tu celular: la abres en la app de tu banco y la apruebas, sin capturar CLABE ni pagar comisión. Ref. ${reference}.\n`
          : `Ref. ${reference}.\n`) +
        "Si hoy no se puede, no pasa nada: dinos cuándo te queda bien. ¡Gracias por tu confianza!",
      simPay,
      undefined,
      { name: "cuadra_cobro_fiado", params: [name, merchant?.name ?? "tu tienda", amount, reference] },
    );
    await this.say(
      "comercio",
      pushed
        ? sim
          ? `📨 Cobro de ${amount} enviado a ${name} por CoDi (simulado). Te aviso cuando pague.`
          : `📨 pey aceptó la solicitud CoDi de ${amount} para ${name} (${validity}). ` +
            `Le llega como notificación de la app de su banco si su celular está registrado en CoDi. Te aviso cuando pague.`
        : `⚠️ ${name} no tiene un celular válido para CoDi. Le dejé el recordatorio con la referencia ${reference}; si está en la tienda, cóbrale con “QR para ${name}”.`,
    );
    return "sent";
  }

  /** Cobro vigente del cliente; los vencidos en el proveedor ya no bloquean uno nuevo. */
  private async openCharge(customerId: string, at?: Date, opts: { payableOnly?: boolean } = {}) {
    return openChargeFor(this.d.db, customerId, at ?? this.d.now(), opts);
  }

  /** Cobro en mostrador: QR CoDi por el saldo exacto, que el cliente escanea con su banco. */
  private async chargeWithQr(customerId: string): Promise<void> {
    const now = this.d.now();
    const [c] = await this.d.db.select().from(schema.customers).where(eq(schema.customers.id, customerId));
    if (!c) return;
    const settled = await this.settleRecentWithProvider(customerId, now);
    if (!settled.ok) {
      await this.say(
        "comercio",
        `⚠️ No pude confirmar con pey si ${c.name} ya pagó la solicitud anterior (${settled.error}). Para no cobrarle doble, no genero el QR: intenta en unos minutos.`,
      );
      return;
    }
    const balance = await ledgerBalance(this.d.db, this.d.merchantId, "1200", customerId);
    if (balance <= 0n) {
      await this.say("comercio", `${c.name} no te debe nada.`);
      return;
    }
    // Un recordatorio solo con referencia no es una solicitud que se apruebe en el banco: no impide el
    // QR y se conserva (sigue contando para la política y para identificar una transferencia).
    const open = await this.openCharge(customerId, now, { payableOnly: true });
    if (open) {
      await this.say("comercio", this.openChargeMessage(c.name, open, now));
      return;
    }
    const [merchant] = await this.d.db.select().from(schema.merchants).where(eq(schema.merchants.id, this.d.merchantId));
    const chargeId = id("ch");
    const reference = await newChargeReference(this.d.db, this.d.merchantId);
    await insertCharge(this.d.db, {
      id: chargeId,
      merchantId: this.d.merchantId,
      customerId,
      reference,
      amountCents: balance,
      now,
      via: { provider: this.d.gateway.name, channel: "codi_qr", expiresAt: new Date(now.getTime() + QR_TTL_S * 1000) },
    });
    try {
      const qr = await this.d.gateway.createQr({
        amount_cents: balance,
        concept: `Fiado ${merchant?.name ?? ""}`.slice(0, 40),
        num_ref: reference,
        metadata: { cuadra_charge_id: chargeId },
        ...(merchant?.peyBankAccountId ? { bank_account_id: merchant.peyBankAccountId } : {}),
      });
      await attachProviderCharge(this.d.db, chargeId, {
        provider: this.d.gateway.name,
        providerChargeId: qr.provider_charge_id,
        channel: "codi_qr",
        expiresAt: new Date(now.getTime() + QR_TTL_S * 1000),
      });
      const amount = formatMXN(balance);
      const actions: MessageAction[] = [
        { kind: "qr", label: "QR CoDi", ...(qr.image_png_base64 ? { url: `data:image/png;base64,${qr.image_png_base64}` } : {}) },
      ];
      if (this.d.gateway.simulated) actions.push({ kind: "pay", label: `${c.name} escanea y paga (simulado)`, url: `/api/sim/pay/${chargeId}` });
      await this.say("comercio", `📱 Que ${c.name} escanee este QR con la app de su banco: ${amount}, ref. ${reference}. Vale ${QR_TTL_S / 60} min.`, actions);
    } catch (e) {
      // Un QR que no se le mostró a nadie no se puede pagar: se cancela.
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
    // Aportaciones de tanda: van directo a la cuenta del integrante en turno, no al comercio.
    if (await this.tanda.applyPayment(tx)) return;
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
      const [store] = await this.d.db.select({ name: schema.merchants.name }).from(schema.merchants).where(eq(schema.merchants.id, this.d.merchantId));
      await this.say(cid, `🧾 Recibo: pagaste ${amount}. ${rest}`, undefined, undefined, {
        name: "cuadra_recibo_fiado",
        params: [store?.name ?? "tu tienda", amount, rest],
      });
      await this.say("comercio", `💰 ${c?.name} pagó ${amount} por CoDi. Conciliado solo${bal > 0n ? `; aún debe ${formatMXN(bal)}` : "; queda en ceros"}.`);
      const s = await this.n2bis();
      if (s && s.level !== "ok") await this.say("comercio", `📈 ${s.message}`);
    } else {
      await this.say("comercio", `💰 Llegó un pago de ${amount} que no pude asignar. Quedó en “por identificar” (1300) para revisión.`);
    }
  }

  private reconciling: Promise<ReconResult> | null = null;

  /** Conciliación contra el proveedor de cobro. Una sola corrida a la vez. */
  async reconcileProvider(): Promise<ReconResult> {
    this.reconciling ??= reconcileWithProvider({
      db: this.d.db,
      merchantId: this.d.merchantId,
      gateway: this.d.gateway,
      applyPayment: (tx) => this.applyPayment(tx),
      now: this.d.now,
      say: (body) => this.say("comercio", body),
      log: this.d.log,
    }).finally(() => {
      this.reconciling = null;
    });
    return this.reconciling;
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
    case "resend_reminder":
      return i.customer_name ? `reenviarle el cobro a ${i.customer_name}` : "reenviar el último cobro";
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
