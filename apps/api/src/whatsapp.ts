/**
 * Canal WhatsApp: implementa OutboundChannel (salida) y traduce los mensajes de Meta al mismo agente
 * que usa el chat web (entrada). Solo el teléfono del comercio puede darle instrucciones (R02).
 */
import {
  type WhatsAppButton,
  type WhatsAppClient,
  type WhatsAppInbound,
  WHATSAPP_WINDOW_CLOSED,
  WhatsAppApiError,
  phone10,
} from "@cuadra/adapters";
import { type Db, schema } from "@cuadra/db";
import { type OutboundChannel, type OutboundMessage, resolveThreadPhone } from "./channel.js";
import type { CuadraService } from "./service.js";
import { TEMPLATE_LANGUAGE } from "./whatsapp-templates.js";

export interface WhatsAppChannelDeps {
  db: Db;
  merchantId: string;
  ownerId: string;
  client: Pick<WhatsAppClient, "sendText" | "sendButtons" | "sendTemplate" | "uploadMedia" | "sendImage">;
  log: (r: Record<string, unknown>) => void;
}

const QR_DATA_URL = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/;

export class WhatsAppChannel implements OutboundChannel {
  readonly name = "whatsapp";
  constructor(private readonly d: WhatsAppChannelDeps) {}

  /**
   * Clientes e integrantes (mensajes que inicia el negocio) reciben la plantilla aprobada.
   * Al comercio: QR como imagen, propuestas con botones y lo demás como texto; si su ventana de
   * 24 h ya cerró, el aviso genérico. Si algo falla, el servicio lo registra y el flujo sigue.
   */
  async send(msg: OutboundMessage): Promise<void> {
    const comercio = msg.thread === "comercio";
    // Siempre 52 + 10 dígitos. El webhook trae los celulares de México como 521..., pero ese formato
    // no coincide con la lista de destinatarios del número de prueba (error 131030); Meta convierte
    // 52... a 521... por su cuenta (probado el 14-nov-2026).
    const to = `52${msg.phone10}`;
    if (msg.template && !comercio) {
      await this.d.client.sendTemplate(to, msg.template.name, TEMPLATE_LANGUAGE, msg.template.params);
      return;
    }
    const buttons: WhatsAppButton[] = [];
    const links: string[] = [];
    let qrPng: Uint8Array | null = null;
    for (const a of msg.actions) {
      const qr = a.kind === "qr" && a.url ? QR_DATA_URL.exec(a.url) : null;
      if (qr) qrPng = Buffer.from(qr[1]!, "base64");
      else if ((a.kind === "confirm" || a.kind === "cancel") && a.proposal_id) buttons.push({ id: `${a.kind}:${a.proposal_id}`, title: a.label });
      else if (a.url?.startsWith("http")) links.push(`${a.label}: ${a.url}`);
    }
    const text = [msg.body, ...links].join("\n\n");
    try {
      if (qrPng) await this.d.client.sendImage(to, await this.d.client.uploadMedia(qrPng, "image/png"), text);
      else if (buttons.length) await this.d.client.sendButtons(to, text, buttons);
      else await this.d.client.sendText(to, text);
    } catch (e) {
      if (!(comercio && e instanceof WhatsAppApiError && e.code === WHATSAPP_WINDOW_CLOSED)) throw e;
      await this.d.client.sendTemplate(to, "cuadra_aviso_comercio", TEMPLATE_LANGUAGE, [msg.body]);
    }
  }

  /** Procesa mensajes entrantes ya verificados por firma. Idempotente por id de mensaje de Meta. */
  async handleInbound(msgs: WhatsAppInbound[], service: CuadraService): Promise<void> {
    const owner = await resolveThreadPhone(this.d.db, this.d.merchantId, this.d.ownerId, "comercio");
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

      if (m.kind === "text") {
        await service.handleMerchantMessage(m.text, m.forwarded ? "third_party_content" : "user_direct");
      } else if (m.kind === "button") {
        const [action, proposalId] = m.button_id.split(":");
        if (proposalId && action === "confirm") await service.confirm(proposalId);
        else if (proposalId && action === "cancel") await service.cancel(proposalId);
      } else {
        await this.send({
          merchantId: this.d.merchantId,
          thread: "comercio",
          phone10: owner,
          body: "Por ahora solo leo mensajes de texto. Escríbeme, por ejemplo: “Doña Lupe se llevó $185”.",
          actions: [],
        });
      }
    }
  }
}
