import { randomInt, randomUUID } from "node:crypto";
import type { TemplateRef } from "./whatsapp-templates.js";
import type { PeyTransaction } from "@cuadra/adapters";
import { formatMXN, maskClabe, potCents, recipientOf } from "@cuadra/core";
import {
  CHARGE_EXPIRY_GRACE_MS,
  type AssertionVerifier,
  type Db,
  type MessageAction,
  type TandaRow,
  attachTandaProviderCharge,
  findTandaCharge,
  insertTandaCharge,
  openNextRound,
  realPhone10,
  recordTandaPayment,
  schema,
  tandaMembersOf,
  tandaRoundStatus,
  verifyTandaIntegrity,
} from "@cuadra/db";
import { and, desc, eq, lt } from "drizzle-orm";
import type { ChargeGateway } from "./gateway.js";

/** Vigencia de la solicitud CoDi de una aportación; después se puede volver a mandar. */
export const TANDA_PN_TTL_S = 3600;

export const memberThread = (tandaId: string, position: number) => `tanda:${tandaId}:${position}`;

export interface TandaDeps {
  db: Db;
  merchantId: string;
  gateway: ChargeGateway;
  verify: AssertionVerifier;
  now: () => Date;
  say: (thread: string, body: string, actions?: MessageAction[], template?: TemplateRef) => Promise<void>;
  log: (r: Record<string, unknown>) => void;
}

const newId = (p: string) => `${p}_${randomUUID().replace(/-/g, "").slice(0, 16)}`;

/**
 * Tanda sin pozo: cada aportación es una solicitud CoDi dirigida a la cuenta del integrante
 * en turno (bankAccountId). Cuadra coordina y concilia; nunca recibe ni dispersa el dinero.
 */
export class TandaFlow {
  constructor(private readonly d: TandaDeps) {}

  async activeTanda(): Promise<TandaRow | null> {
    const [t] = await this.d.db
      .select()
      .from(schema.tandas)
      .where(and(eq(schema.tandas.merchantId, this.d.merchantId), eq(schema.tandas.status, "active")))
      .orderBy(desc(schema.tandas.createdAt))
      .limit(1);
    return t ?? null;
  }

  /** Revalida contra lo firmado; si no cuadra, congela la tanda y no cobra. */
  private async checkIntegrity(t: TandaRow): Promise<boolean> {
    if (await verifyTandaIntegrity(this.d.db, t.id, this.d.verify)) return true;
    await this.d.db.update(schema.tandas).set({ status: "frozen" }).where(eq(schema.tandas.id, t.id));
    await this.d.say(
      "comercio",
      `🛡️ La tanda “${t.name}” no coincide con lo que firmaste con tu passkey (integrantes, CLABEs u orden). La congelé y no cobré nada.`,
    );
    this.d.log({ msg: "tanda_integrity_failed", merchant_id: this.d.merchantId, tanda_id: t.id });
    return false;
  }

  async startRound(): Promise<void> {
    const t = await this.activeTanda();
    if (!t) {
      await this.d.say("comercio", "No tienes una tanda activa. Créala en “Crear tanda” y fírmala con tu passkey.");
      return;
    }
    if (!(await this.checkIntegrity(t))) return;
    const members = await tandaMembersOf(this.d.db, t.id);
    const next = t.currentRound + 1;
    if (next <= t.membersCount) {
      const recipient = members[recipientOf(next, t.membersCount) - 1]!;
      if (recipient.bankAccountStatus !== "ACTIVE" || !recipient.bankAccountId) {
        // pey tarda hasta 5 días hábiles en activar una CLABE nueva para CoDi.
        if (recipient.bankAccountId) {
          const status = await this.d.gateway.accountStatus(recipient.bankAccountId).catch(() => recipient.bankAccountStatus);
          await this.d.db
            .update(schema.tandaMembers)
            .set({ bankAccountStatus: status })
            .where(and(eq(schema.tandaMembers.tandaId, t.id), eq(schema.tandaMembers.position, recipient.position)));
          if (status !== "ACTIVE") {
            await this.d.say("comercio", `La cuenta de ${recipient.name} (CLABE ${maskClabe(recipient.clabe)}) aún no está activa para CoDi (estado: ${status}). En cuanto Banxico la active arranco su ronda.`);
            return;
          }
          recipient.bankAccountStatus = "ACTIVE";
        } else {
          await this.d.say("comercio", `La cuenta de ${recipient.name} no está registrada para recibir CoDi.`);
          return;
        }
      }
    }
    const opened = await openNextRound(this.d.db, t.id);
    if (!opened.ok) {
      await this.d.say("comercio", opened.reason);
      return;
    }
    const round = opened.round;
    const recipient = members[recipientOf(round, t.membersCount) - 1]!;
    const pot = potCents(t.contributionCents, t.membersCount);
    let sent = 0;
    for (const m of members) {
      if (m.position === recipient.position) {
        await this.d.say(
          memberThread(t.id, m.position),
          `🎉 ${m.name}, esta ronda de “${t.name}” te toca a ti: ${formatMXN(pot)} llegarán directo a tu cuenta ${maskClabe(m.clabe)} conforme paguen los demás.`,
          undefined,
          { name: "cuadra_tanda_turno", params: [m.name, t.name, formatMXN(pot), maskClabe(m.clabe)] },
        );
        continue;
      }
      if (await this.requestContribution(t, round, m, recipient)) sent++;
    }
    await this.d.say(
      "comercio",
      `🔁 Ronda ${round} de ${t.membersCount} de “${t.name}”: le toca a ${recipient.name}. Mandé ${sent} solicitudes CoDi de ${formatMXN(t.contributionCents)} directo a su cuenta ${maskClabe(recipient.clabe)}. El dinero no pasa por ti ni por Cuadra.`,
    );
  }

  private async requestContribution(t: TandaRow, round: number, payer: typeof schema.tandaMembers.$inferSelect, recipient: typeof schema.tandaMembers.$inferSelect): Promise<boolean> {
    const chargeId = newId("tch");
    const now = this.d.now();
    await insertTandaCharge(this.d.db, { id: chargeId, tandaId: t.id, round, payer: payer.position, recipient: recipient.position, amount: t.contributionCents, now });
    // Nunca se manda a un número que no es un celular mexicano real (p. ej. los ficticios de la demo).
    const phone10 = realPhone10(payer.phone);
    if (!phone10) {
      await this.d.db.update(schema.tandaCharges).set({ status: "expired" }).where(eq(schema.tandaCharges.id, chargeId));
      await this.d.say("comercio", `⚠️ No le mandé la solicitud a ${payer.name}: su celular no es válido para CoDi.`);
      return false;
    }
    try {
      const r = await this.d.gateway.requestPayment({
        amount_cents: t.contributionCents,
        phone10,
        concept: `Tanda ${t.name} R${round}`.slice(0, 40),
        num_ref: String(randomInt(1_000_000, 10_000_000)),
        metadata: { cuadra_tanda_charge_id: chargeId },
        bank_account_id: recipient.bankAccountId!,
        ttl_s: TANDA_PN_TTL_S,
      });
      await attachTandaProviderCharge(this.d.db, chargeId, this.d.gateway.name, r.provider_charge_id);
    } catch (e) {
      await this.d.db.update(schema.tandaCharges).set({ status: "expired" }).where(eq(schema.tandaCharges.id, chargeId));
      this.d.log({ msg: "tanda_pn_failed", tanda_id: t.id, error: e instanceof Error ? e.message : String(e) });
      await this.d.say("comercio", `⚠️ No pude mandarle la solicitud a ${payer.name}: ${e instanceof Error ? e.message : String(e)}`);
      return false;
    }
    const actions: MessageAction[] = this.d.gateway.simulated
      ? [{ kind: "pay", label: `Aprobar ${formatMXN(t.contributionCents)} (banco simulado)`, url: `/api/sim/tanda/pay/${chargeId}` }]
      : [];
    await this.d.say(
      memberThread(t.id, payer.position),
      `Hola ${payer.name} 👋 Ronda ${round} de “${t.name}”: le toca a ${recipient.name}. Te llegó una solicitud CoDi de ${formatMXN(t.contributionCents)} a tu celular; al aprobarla, el dinero va directo a la cuenta de ${recipient.name}.`,
      actions,
      { name: "cuadra_tanda_aportacion", params: [payer.name, String(round), t.name, recipient.name, formatMXN(t.contributionCents)] },
    );
    return true;
  }

  /** Reenvía la solicitud a quienes faltan, solo si la anterior ya venció (sin cobros dobles). */
  async remindPending(): Promise<void> {
    const t = await this.activeTanda();
    const st = t && (await tandaRoundStatus(this.d.db, t));
    if (!t || !st) {
      await this.d.say("comercio", "No hay una ronda de tanda en curso.");
      return;
    }
    if (!(await this.checkIntegrity(t))) return;
    if (st.complete) {
      await this.d.say("comercio", "Ya aportaron todos en esta ronda. 🎉");
      return;
    }
    const members = await tandaMembersOf(this.d.db, t.id);
    const recipient = members[st.recipient - 1]!;
    // Vencida en pey más el margen de reloj: antes de eso, reenviar podría cobrar doble.
    const cutoff = new Date(this.d.now().getTime() - TANDA_PN_TTL_S * 1000 - CHARGE_EXPIRY_GRACE_MS);
    let sent = 0;
    let waiting = 0;
    for (const pos of st.pending) {
      const [last] = await this.d.db
        .select()
        .from(schema.tandaCharges)
        .where(and(eq(schema.tandaCharges.tandaId, t.id), eq(schema.tandaCharges.round, st.round), eq(schema.tandaCharges.payerPosition, pos), eq(schema.tandaCharges.status, "open")))
        .orderBy(desc(schema.tandaCharges.createdAt))
        .limit(1);
      if (last && last.createdAt.getTime() > cutoff.getTime()) {
        waiting++;
        continue;
      }
      await this.d.db
        .update(schema.tandaCharges)
        .set({ status: "expired" })
        .where(and(eq(schema.tandaCharges.tandaId, t.id), eq(schema.tandaCharges.round, st.round), eq(schema.tandaCharges.payerPosition, pos), eq(schema.tandaCharges.status, "open"), lt(schema.tandaCharges.createdAt, cutoff)));
      if (await this.requestContribution(t, st.round, members[pos - 1]!, recipient)) sent++;
    }
    await this.d.say(
      "comercio",
      sent
        ? `📨 Reenvié ${sent} solicitud(es) de la ronda ${st.round}.${waiting ? ` ${waiting} aún tienen una vigente.` : ""}`
        : `Las ${waiting} solicitudes pendientes siguen vigentes (duran ${TANDA_PN_TTL_S / 60} min); reenviarlas ahora podría cobrar doble.`,
    );
  }

  async describe(): Promise<string> {
    const t = await this.activeTanda();
    if (!t) return "No tienes una tanda activa.";
    const members = await tandaMembersOf(this.d.db, t.id);
    const st = await tandaRoundStatus(this.d.db, t);
    if (!st) return `“${t.name}”: ${t.membersCount} integrantes, ${formatMXN(t.contributionCents)} cada quien. Aún no arranca; escribe “cobra la tanda”.`;
    const name = (p: number) => members[p - 1]?.name ?? `#${p}`;
    return (
      `“${t.name}”, ronda ${st.round} de ${t.membersCount}: recibe ${name(st.recipient)}.\n` +
      (st.paid.length ? `✅ Ya pagaron: ${st.paid.map(name).join(", ")}\n` : "") +
      (st.pending.length ? `⏳ Faltan: ${st.pending.map(name).join(", ")}` : "🎉 Ronda completa.")
    );
  }

  /** Si la transacción es una aportación de tanda, la registra y avisa. Devuelve false si no lo es. */
  async applyPayment(tx: PeyTransaction): Promise<boolean> {
    const charge = await findTandaCharge(this.d.db, this.d.gateway.name, [tx.id, tx.payable_id].filter((x): x is string => !!x), tx.external_metadata.cuadra_tanda_charge_id ?? null);
    if (!charge) return false;
    const out = await recordTandaPayment(this.d.db, charge.id, { transactionId: tx.id, baseCents: tx.base_cents, now: this.d.now() });
    if (out.kind === "duplicate") return true;
    const [t] = await this.d.db.select().from(schema.tandas).where(eq(schema.tandas.id, charge.tandaId));
    const members = await tandaMembersOf(this.d.db, charge.tandaId);
    const payer = members[charge.payerPosition - 1]!;
    const recipient = members[charge.recipientPosition - 1]!;
    if (out.kind === "mismatch") {
      await this.d.say(
        "comercio",
        out.doublePayment
          ? `⚠️ ${payer.name} pagó dos veces la ronda ${charge.round} (${formatMXN(out.paid)} de más a ${recipient.name}). Hay que devolvérselo.`
          : `⚠️ ${payer.name} pagó ${formatMXN(out.paid)} y la aportación es ${formatMXN(charge.amountCents)}. No la marqué como completa; revísalo con ${recipient.name}.`,
      );
      return true;
    }
    await this.d.say(
      memberThread(charge.tandaId, payer.position),
      `🧾 Recibo: aportaste ${formatMXN(charge.amountCents)} a la ronda ${charge.round} de “${t?.name}”, directo a ${recipient.name}. ¡Gracias!`,
      undefined,
      { name: "cuadra_tanda_recibo", params: [formatMXN(charge.amountCents), String(charge.round), t?.name ?? "tu tanda", recipient.name] },
    );
    const name = (p: number) => members[p - 1]?.name ?? `#${p}`;
    if (out.status.complete) {
      const pot = potCents(charge.amountCents, members.length);
      await this.d.say("comercio", `🎉 ¡Pozo completo! ${formatMXN(pot)} llegaron directo a la cuenta de ${recipient.name} (${maskClabe(recipient.clabe)}). Ronda ${charge.round} cerrada.`);
      for (const m of members) {
        const mine = m.position === recipient.position;
        const aviso = mine
          ? `${m.name}, ya te llegaron los ${formatMXN(pot)} de tu ronda.`
          : `La ronda ${charge.round} se completó y ${recipient.name} ya recibió su pozo.`;
        await this.d.say(
          memberThread(charge.tandaId, m.position),
          mine
            ? `🎉 ${m.name}, ya te llegaron los ${formatMXN(pot)} de tu ronda. ¡Felicidades!`
            : `✅ La ronda ${charge.round} de “${t?.name}” se completó: ${recipient.name} ya recibió su pozo.`,
          undefined,
          { name: "cuadra_tanda_aviso", params: [t?.name ?? "tu tanda", aviso] },
        );
      }
      if (charge.round >= members.length) {
        await this.d.db.update(schema.tandas).set({ status: "done" }).where(eq(schema.tandas.id, charge.tandaId));
        await this.d.say("comercio", `🏁 La tanda “${t?.name}” terminó: los ${members.length} integrantes recibieron su turno.`);
      }
    } else {
      await this.d.say("comercio", `💸 ${payer.name} aportó a la ronda ${charge.round}. Faltan: ${out.status.pending.map(name).join(", ")}.`);
    }
    return true;
  }
}
