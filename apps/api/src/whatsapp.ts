/**
 * Canal WhatsApp: implementa OutboundChannel (salida) y traduce los mensajes de Meta al mismo agente
 * que usa el chat web (entrada). Solo el teléfono del comercio puede darle instrucciones (R02).
 */
import {
  type Transcribe,
  type WhatsAppButton,
  type WhatsAppClient,
  type WhatsAppInbound,
  WHATSAPP_WINDOW_CLOSED,
  WhatsAppApiError,
} from "@cuadra/adapters";
import { type Db, schema, storeOfPhone, storeOwner } from "@cuadra/db";
import { verifyPhoneByWhatsApp } from "./auth.js";
import type { OutboundChannel, OutboundMessage } from "./channel.js";
import type { CuadraService } from "./service.js";
import { TEMPLATE_LANGUAGE } from "./whatsapp-templates.js";

/**
 * Celular (10 dígitos) de quien escribe por WhatsApp. Meta siempre manda el número con código de
 * país: solo se aceptan celulares de México (52 o 521 y 10 dígitos). Nunca "los últimos 10 dígitos":
 * un número de otro país que termine igual que uno de aquí no puede hacerse pasar por él.
 */
export function senderPhone10(from: string): string | null {
  const m = /^52(?:1)?([2-9]\d{9})$/.exec(from.replace(/\D/g, ""));
  return m ? m[1]! : null;
}

export interface WhatsAppChannelDeps {
  db: Db;
  client: Pick<WhatsAppClient, "sendText" | "sendButtons" | "sendTemplate" | "uploadMedia" | "sendImage" | "downloadMedia">;
  log: (r: Record<string, unknown>) => void;
  /** Voz a texto para las notas de voz del comercio. Sin esto, se le pide que escriba. */
  transcribe?: Transcribe;
  /** Reloj (por defecto, la hora real). */
  now?: () => Date;
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
      try {
        await this.d.client.sendTemplate(to, msg.template.name, TEMPLATE_LANGUAGE, msg.template.params);
        return;
      } catch (e) {
        // Plantilla aún sin aprobar (o rechazada): si el cliente escribió en las últimas 24 h, el texto
        // normal sí entra. Si tampoco, el error se registra y el flujo del dinero sigue igual.
        this.d.log({ msg: "whatsapp_template_failed", template: msg.template.name, code: e instanceof WhatsAppApiError ? e.code : null });
        await this.d.client.sendText(to, msg.body);
        return;
      }
    }
    const buttons: WhatsAppButton[] = [];
    const links: string[] = [];
    let qrPng: Uint8Array | null = null;
    for (const a of msg.actions) {
      const qr = a.kind === "qr" && a.url ? QR_DATA_URL.exec(a.url) : null;
      if (qr) qrPng = Buffer.from(qr[1]!, "base64");
      else if ((a.kind === "confirm" || a.kind === "cancel") && a.proposal_id) buttons.push({ id: `${a.kind}:${a.proposal_id}`, title: a.label });
      else if (a.kind === "say" && a.text) buttons.push({ id: `say:${a.text}`, title: a.label });
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

  /**
   * Procesa mensajes entrantes ya verificados por firma. Idempotente por id de mensaje de Meta.
   * Cada mensaje va a la tienda cuyo dueño tiene ese celular (una persona = un celular). `route`
   * da el servicio de esa tienda; si se pasa un servicio, solo se atienden mensajes de su dueño.
   */
  async handleInbound(msgs: WhatsAppInbound[], route: CuadraService | ((merchantId: string) => Promise<CuadraService | null>)): Promise<void> {
    for (const m of msgs) {
      const fresh = await this.d.db
        .insert(schema.webhookEvents)
        .values({ provider: "whatsapp", eventId: m.id, payload: { kind: m.kind } })
        .onConflictDoNothing()
        .returning({ id: schema.webhookEvents.eventId });
      if (fresh.length === 0) continue;

      const from = senderPhone10(m.from);
      // Código de verificación del portal: el mensaje llega desde el celular que se quiere verificar.
      if (from && m.kind === "text") {
        const v = await verifyPhoneByWhatsApp(this.d.db, from, m.text, this.d.now?.() ?? new Date());
        if (v) {
          this.d.log({ msg: "phone_verified_by_whatsapp", phone_last4: from.slice(-4) });
          await this.send({
            merchantId: "",
            thread: "comercio",
            phone10: from,
            body: `✅ Listo, ${v.name.split(/\s+/)[0]}: tu celular quedó verificado. Regresa a Cuadra para seguir.`,
            actions: [],
          }).catch((e: unknown) => this.d.log({ msg: "whatsapp_send_failed", error: e instanceof Error ? e.message : String(e) }));
          continue;
        }
      }
      const store = from ? await storeOfPhone(this.d.db, from) : null;
      // Solo da instrucciones por WhatsApp el dueño que ya verificó su celular (con el código del portal).
      const owner = store ? await storeOwner(this.d.db, store.merchantId) : null;
      const service =
        !store || !owner?.phoneVerified ? null : typeof route === "function" ? await route(store.merchantId) : route.merchantId === store.merchantId ? route : null;
      if (!from || !store || !service) {
        // ponytail: clientes que responden (opt-in "SÍ") van en el componente #14; hoy solo se registra.
        this.d.log({ msg: "whatsapp_ignored_sender", message_id: m.id });
        continue;
      }

      if (m.kind === "text") {
        await service.handleMerchantMessage(m.text, m.forwarded ? "third_party_content" : "user_direct");
      } else if (m.kind === "button") {
        const sep = m.button_id.indexOf(":");
        const action = m.button_id.slice(0, sep);
        const arg = m.button_id.slice(sep + 1);
        if (sep > 0 && arg && action === "confirm") await service.confirm(arg);
        else if (sep > 0 && arg && action === "cancel") await service.cancel(arg);
        // Sugerencia: se procesa como si el comercio la hubiera escrito.
        else if (sep > 0 && arg && action === "say") await service.handleMerchantMessage(arg, "user_direct");
      } else if (m.kind === "audio" && this.d.transcribe) {
        const text = await this.transcribeVoice(m.media_id, m.id);
        // Un audio reenviado es de otra persona: contenido de terceros, igual que un texto reenviado.
        if (text) await service.handleMerchantMessage(text, m.forwarded ? "third_party_content" : "user_voice");
        else
          await this.send({
            merchantId: store.merchantId,
            thread: "comercio",
            phone10: from,
            body: "No alcancé a entender tu nota de voz. ¿Me la mandas otra vez o me lo escribes?",
            actions: [],
          });
      } else {
        await this.send({
          merchantId: store.merchantId,
          thread: "comercio",
          phone10: from,
          body: this.d.transcribe
            ? "Por ahora leo mensajes de texto y notas de voz. Escríbeme o dime, por ejemplo: “Doña Lupe se llevó $185”."
            : "Por ahora solo leo mensajes de texto. Escríbeme, por ejemplo: “Doña Lupe se llevó $185”.",
          actions: [],
        });
      }
    }
  }

  /** Baja la nota de voz y la pasa a texto. Si algo falla, null (el comercio la vuelve a mandar). */
  private async transcribeVoice(mediaId: string, messageId: string): Promise<string | null> {
    try {
      const { bytes, mime } = await this.d.client.downloadMedia(mediaId);
      const text = await this.d.transcribe!(bytes, mime);
      return text || null;
    } catch (e) {
      // Sin el contenido del audio ni la transcripción en el log: pueden traer datos personales.
      this.d.log({ msg: "whatsapp_voice_failed", message_id: messageId, error: e instanceof Error ? e.message : String(e) });
      return null;
    }
  }
}
