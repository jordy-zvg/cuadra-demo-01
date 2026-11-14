/**
 * Canal WhatsApp: traduce mensajes de Meta al mismo agente que usa el chat web y entrega sus
 * respuestas. Solo el teléfono verificado del comercio puede darle instrucciones (R02).
 */
import {
  type WhatsAppButton,
  type WhatsAppClient,
  type WhatsAppInbound,
  WHATSAPP_WINDOW_CLOSED,
  WhatsAppApiError,
  phone10,
} from "@cuadra/adapters";
import { type Db, type MessageAction, schema } from "@cuadra/db";
import { and, eq } from "drizzle-orm";
import type { CuadraService } from "./service.js";
import { TEMPLATE_LANGUAGE, type TemplateRef } from "./whatsapp-templates.js";

export interface WhatsAppChannelDeps {
  db: Db;
  merchantId: string;
  ownerId: string;
  client: Pick<WhatsAppClient, "sendText" | "sendButtons" | "sendTemplate">;
  log: (r: Record<string, unknown>) => void;
}

export class WhatsAppChannel {
  /** wa_id con el que escribió el comercio por última vez (México puede llegar como 521...). */
  private ownerWaId: string | null = null;

  constructor(private readonly d: WhatsAppChannelDeps) {}

  private async ownerPhone10(): Promise<string | null> {
    const [u] = await this.d.db
      .select({ phone: schema.merchantUsers.phone })
      .from(schema.merchantUsers)
      .where(and(eq(schema.merchantUsers.id, this.d.ownerId), eq(schema.merchantUsers.phoneVerified, true)));
    return u ? phone10(u.phone) : null;
  }

  private async recipient(thread: string): Promise<string | null> {
    if (thread === "comercio") {
      if (this.ownerWaId) return this.ownerWaId;
      const p = await this.ownerPhone10();
      return p && `52${p}`;
    }
    // Integrante de tanda: tanda:<id>:<posición>. Dio su celular al firmar la tanda.
    const tanda = /^tanda:(.+):(\d+)$/.exec(thread);
    if (tanda) {
      const [m] = await this.d.db
        .select({ phone: schema.tandaMembers.phone })
        .from(schema.tandaMembers)
        .where(and(eq(schema.tandaMembers.tandaId, tanda[1]!), eq(schema.tandaMembers.position, Number(tanda[2]))));
      const p = m ? phone10(m.phone) : null;
      return p && `52${p}`;
    }
    const [c] = await this.d.db
      .select({ phone: schema.customers.phone, optIn: schema.customers.optIn })
      .from(schema.customers)
      .where(and(eq(schema.customers.id, thread), eq(schema.customers.merchantId, this.d.merchantId)));
    const p = c?.optIn && c.phone ? phone10(c.phone) : null;
    return p && `52${p}`;
  }

  /**
   * Entrega una respuesta del agente. Nunca lanza: si WhatsApp falla, el mensaje ya quedó en la base.
   * A clientes e integrantes (mensajes que inicia el negocio) se les manda la plantilla aprobada.
   * Al comercio se le responde con texto y botones; si su ventana de 24 h ya cerró, va el aviso genérico.
   */
  async deliver(thread: string, body: string, actions?: MessageAction[], template?: TemplateRef): Promise<void> {
    try {
      const to = await this.recipient(thread);
      if (!to) return;
      if (template && thread !== "comercio") {
        await this.d.client.sendTemplate(to, template.name, TEMPLATE_LANGUAGE, template.params);
        return;
      }
      const buttons: WhatsAppButton[] = [];
      const links: string[] = [];
      for (const a of actions ?? []) {
        if ((a.kind === "confirm" || a.kind === "cancel") && a.proposal_id) buttons.push({ id: `${a.kind}:${a.proposal_id}`, title: a.label });
        else if (a.url) links.push(`${a.label}: ${a.url}`);
      }
      const text = [body, ...links].join("\n\n");
      try {
        await (buttons.length ? this.d.client.sendButtons(to, text, buttons) : this.d.client.sendText(to, text));
      } catch (e) {
        if (!(thread === "comercio" && e instanceof WhatsAppApiError && e.code === WHATSAPP_WINDOW_CLOSED)) throw e;
        await this.d.client.sendTemplate(to, "cuadra_aviso_comercio", TEMPLATE_LANGUAGE, [body]);
      }
    } catch (e) {
      this.d.log({
        msg: "whatsapp_send_error",
        thread,
        template: template?.name ?? null,
        code: e instanceof WhatsAppApiError ? e.code : null,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  /** Procesa mensajes entrantes ya verificados por firma. Idempotente por id de mensaje de Meta. */
  async handleInbound(msgs: WhatsAppInbound[], service: CuadraService): Promise<void> {
    const owner = await this.ownerPhone10();
    for (const m of msgs) {
      const fresh = await this.d.db
        .insert(schema.webhookEvents)
        .values({ provider: "whatsapp", eventId: m.id, payload: { kind: m.kind } })
        .onConflictDoNothing()
        .returning({ id: schema.webhookEvents.eventId });
      if (fresh.length === 0) continue;

      if (!owner || phone10(m.from) !== owner) {
        // ponytail: clientes que responden (opt-in "SÍ") van en el componente #14; hoy solo se registra.
        this.d.log({ msg: "whatsapp_ignored_sender", message_id: m.id });
        continue;
      }
      this.ownerWaId = m.from;

      if (m.kind === "text") {
        await service.handleMerchantMessage(m.text, m.forwarded ? "third_party_content" : "user_direct");
      } else if (m.kind === "button") {
        const [action, proposalId] = m.button_id.split(":");
        if (proposalId && action === "confirm") await service.confirm(proposalId);
        else if (proposalId && action === "cancel") await service.cancel(proposalId);
      } else {
        await this.deliver("comercio", "Por ahora solo leo mensajes de texto. Escríbeme, por ejemplo: “Doña Lupe se llevó $185”.");
      }
    }
  }
}
