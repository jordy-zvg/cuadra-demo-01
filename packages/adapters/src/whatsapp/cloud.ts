/**
 * WhatsApp Cloud API (Meta). Fuentes:
 * - Envío y botones: https://developers.facebook.com/docs/whatsapp/cloud-api/messages/interactive-reply-buttons-messages
 * - Verificación y firma del webhook: https://developers.facebook.com/docs/graph-api/webhooks/getting-started
 * Solo transporta mensajes: no decide nada ni toca dinero.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";

export const WHATSAPP_GRAPH_URL = "https://graph.facebook.com";
/** Versión que usa el panel de Meta en sus ejemplos (14-nov-2026). */
export const WHATSAPP_GRAPH_VERSION = "v25.0";

/** Límites de Meta para botones de respuesta. */
const MAX_BUTTONS = 3;
const MAX_TITLE = 20;
const MAX_BODY = 1024;

/** Últimos 10 dígitos: así se compara un número de México sin importar si llega como 52 o 521. */
export function phone10(raw: string): string | null {
  const d = raw.replace(/\D/g, "");
  return d.length >= 10 ? d.slice(-10) : null;
}

/** GET de verificación: devuelve el challenge si el token coincide; si no, null. */
export function verifyWhatsAppSubscription(q: Record<string, unknown>, verifyToken: string): string | null {
  const mode = q["hub.mode"];
  const token = q["hub.verify_token"];
  const challenge = q["hub.challenge"];
  if (mode !== "subscribe" || typeof token !== "string" || typeof challenge !== "string") return null;
  const a = Buffer.from(token);
  const b = Buffer.from(verifyToken);
  return a.length === b.length && timingSafeEqual(a, b) ? challenge : null;
}

/** X-Hub-Signature-256: "sha256=" + HMAC-SHA256 (hex) del cuerpo crudo con el App Secret. */
export function verifyWhatsAppSignature(rawBody: string, header: string | undefined, appSecret: string): boolean {
  if (!header?.startsWith("sha256=")) return false;
  const got = Buffer.from(header.slice(7), "hex");
  const want = createHmac("sha256", appSecret).update(rawBody, "utf8").digest();
  return got.length === want.length && timingSafeEqual(got, want);
}

const Message = z
  .object({
    from: z.string(),
    id: z.string(),
    type: z.string(),
    text: z.object({ body: z.string() }).optional(),
    audio: z.object({ id: z.string(), mime_type: z.string().optional() }).passthrough().optional(),
    image: z.object({ id: z.string(), mime_type: z.string().optional(), caption: z.string().optional() }).passthrough().optional(),
    interactive: z
      .object({ type: z.string(), button_reply: z.object({ id: z.string(), title: z.string() }).optional() })
      .optional(),
    context: z.object({ forwarded: z.boolean().optional(), frequently_forwarded: z.boolean().optional() }).passthrough().optional(),
  })
  .passthrough();

const Payload = z.object({
  object: z.string(),
  entry: z.array(
    z.object({
      changes: z.array(
        z.object({
          field: z.string(),
          value: z.object({ messages: z.array(Message).optional() }).passthrough(),
        }),
      ),
    }),
  ),
});

export type WhatsAppInbound =
  | { kind: "text"; id: string; from: string; text: string; forwarded: boolean }
  | { kind: "button"; id: string; from: string; button_id: string }
  | { kind: "audio"; id: string; from: string; media_id: string; forwarded: boolean }
  | { kind: "image"; id: string; from: string; media_id: string; forwarded: boolean }
  | { kind: "unsupported"; id: string; from: string; type: string };

/** Mensajes entrantes del webhook (ignora estados de entrega y otros campos). */
export function parseWhatsAppWebhook(body: unknown): WhatsAppInbound[] {
  const p = Payload.safeParse(body);
  if (!p.success || p.data.object !== "whatsapp_business_account") return [];
  const out: WhatsAppInbound[] = [];
  for (const e of p.data.entry)
    for (const c of e.changes) {
      if (c.field !== "messages") continue;
      for (const m of c.value.messages ?? []) {
        const forwarded = Boolean(m.context?.forwarded || m.context?.frequently_forwarded);
        if (m.type === "text" && m.text) {
          out.push({ kind: "text", id: m.id, from: m.from, text: m.text.body, forwarded });
        } else if (m.type === "audio" && m.audio) {
          out.push({ kind: "audio", id: m.id, from: m.from, media_id: m.audio.id, forwarded });
        } else if (m.type === "image" && m.image) {
          out.push({ kind: "image", id: m.id, from: m.from, media_id: m.image.id, forwarded });
        } else if (m.type === "interactive" && m.interactive?.button_reply) {
          out.push({ kind: "button", id: m.id, from: m.from, button_id: m.interactive.button_reply.id });
        } else {
          out.push({ kind: "unsupported", id: m.id, from: m.from, type: m.type });
        }
      }
    }
  return out;
}

/** Error de Meta cuando la ventana de 24 h está cerrada y solo se puede mandar plantilla. */
export const WHATSAPP_WINDOW_CLOSED = 131047;

/** Parámetro de plantilla en una sola línea y sin espacios repetidos. */
export function flattenParam(p: string): string {
  const s = p.replace(/\s+/g, " ").trim();
  return s || "-";
}

export class WhatsAppApiError extends Error {
  constructor(readonly status: number, readonly code: number | null, message: string) {
    super(message);
  }
}

export interface WhatsAppConfig {
  token: string;
  phoneNumberId: string;
  version?: string;
  baseUrl?: string;
  fetch?: typeof fetch;
  /** Tiempo máximo por llamada (ms); default WHATSAPP_TIMEOUT_MS. */
  timeoutMs?: number;
}

export const WHATSAPP_TIMEOUT_MS = 15_000;
/** Límite de WhatsApp para audios (16 MB); también protege la memoria del servidor. */
export const WHATSAPP_MAX_MEDIA_BYTES = 16 * 1024 * 1024;

export interface WhatsAppButton {
  id: string;
  title: string;
}

export class WhatsAppClient {
  private readonly http: typeof fetch;
  constructor(private readonly cfg: WhatsAppConfig) {
    if (!cfg.token || !cfg.phoneNumberId) throw new Error("Falta la configuración de WhatsApp");
    this.http = cfg.fetch ?? fetch;
  }

  private async send(to: string, payload: Record<string, unknown>): Promise<string | null> {
    const url = `${this.cfg.baseUrl ?? WHATSAPP_GRAPH_URL}/${this.cfg.version ?? WHATSAPP_GRAPH_VERSION}/${encodeURIComponent(this.cfg.phoneNumberId)}/messages`;
    const res = await this.http(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.cfg.token}`, "content-type": "application/json" },
      body: JSON.stringify({ messaging_product: "whatsapp", recipient_type: "individual", to, ...payload }),
      signal: AbortSignal.timeout(this.cfg.timeoutMs ?? WHATSAPP_TIMEOUT_MS),
    });
    const json = (await res.json().catch(() => null)) as
      | { messages?: Array<{ id?: string }>; error?: { message?: string; code?: number } }
      | null;
    if (!res.ok) throw new WhatsAppApiError(res.status, json?.error?.code ?? null, json?.error?.message ?? `WhatsApp ${res.status}`);
    return json?.messages?.[0]?.id ?? null;
  }

  sendText(to: string, body: string): Promise<string | null> {
    return this.send(to, { type: "text", text: { body: body.slice(0, 4096), preview_url: true } });
  }

  /**
   * Plantilla aprobada con parámetros posicionales en el cuerpo ({{1}}, {{2}}...). Es la única forma
   * de escribirle a alguien fuera de la ventana de 24 h. Meta no acepta saltos de línea ni
   * tabuladores en los parámetros, así que se aplanan.
   */
  sendTemplate(to: string, name: string, language: string, params: string[]): Promise<string | null> {
    return this.send(to, {
      type: "template",
      template: {
        name,
        language: { code: language },
        ...(params.length
          ? { components: [{ type: "body", parameters: params.map((p) => ({ type: "text", text: flattenParam(p) })) }] }
          : {}),
      },
    });
  }

  /**
   * Código de verificación con la plantilla de autenticación (botón «Copiar código»). Como dice la
   * doc de Meta, el código va dos veces: en el cuerpo y en el botón (sub_type "url", index "0").
   * https://developers.facebook.com/documentation/business-messaging/whatsapp/templates/authentication-templates/copy-code-button-authentication-templates
   */
  sendAuthCode(to: string, name: string, language: string, code: string): Promise<string | null> {
    return this.send(to, {
      type: "template",
      template: {
        name,
        language: { code: language },
        components: [
          { type: "body", parameters: [{ type: "text", text: code }] },
          { type: "button", sub_type: "url", index: "0", parameters: [{ type: "text", text: code }] },
        ],
      },
    });
  }

  /** POST /{phone-number-id}/media (multipart): sube una imagen y devuelve su id (vigente 30 días). */
  /** Número de Cuadra en WhatsApp (solo dígitos, con lada de país), para enlaces wa.me. */
  async displayNumber(): Promise<string | null> {
    const url = `${this.cfg.baseUrl ?? WHATSAPP_GRAPH_URL}/${this.cfg.version ?? WHATSAPP_GRAPH_VERSION}/${encodeURIComponent(this.cfg.phoneNumberId)}?fields=display_phone_number`;
    const res = await this.http(url, { headers: { Authorization: `Bearer ${this.cfg.token}` }, signal: AbortSignal.timeout(this.cfg.timeoutMs ?? WHATSAPP_TIMEOUT_MS) });
    const json = (await res.json().catch(() => null)) as { display_phone_number?: string } | null;
    const digits = json?.display_phone_number?.replace(/\D/g, "") ?? "";
    return res.ok && digits.length >= 10 ? digits : null;
  }

  /**
   * Baja un archivo que mandaron por WhatsApp (nota de voz, foto): GET /{media-id} da una URL
   * temporal y esa URL se descarga con el mismo token. Rechaza archivos de más de maxBytes.
   */
  async downloadMedia(mediaId: string, maxBytes = WHATSAPP_MAX_MEDIA_BYTES): Promise<{ bytes: Uint8Array; mime: string }> {
    const auth = { Authorization: `Bearer ${this.cfg.token}` };
    const timeout = () => AbortSignal.timeout(this.cfg.timeoutMs ?? WHATSAPP_TIMEOUT_MS);
    const metaUrl = `${this.cfg.baseUrl ?? WHATSAPP_GRAPH_URL}/${this.cfg.version ?? WHATSAPP_GRAPH_VERSION}/${encodeURIComponent(mediaId)}`;
    const res = await this.http(metaUrl, { headers: auth, signal: timeout() });
    const meta = (await res.json().catch(() => null)) as { url?: string; mime_type?: string; file_size?: number; error?: { message?: string; code?: number } } | null;
    if (!res.ok || !meta?.url) throw new WhatsAppApiError(res.status, meta?.error?.code ?? null, meta?.error?.message ?? `WhatsApp media ${res.status}`);
    if ((meta.file_size ?? 0) > maxBytes) throw new WhatsAppApiError(413, null, "Archivo demasiado grande");
    const file = await this.http(meta.url, { headers: auth, signal: timeout() });
    if (!file.ok) throw new WhatsAppApiError(file.status, null, `WhatsApp descarga ${file.status}`);
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (bytes.byteLength > maxBytes) throw new WhatsAppApiError(413, null, "Archivo demasiado grande");
    return { bytes, mime: meta.mime_type ?? file.headers.get("content-type") ?? "application/octet-stream" };
  }

  async uploadMedia(bytes: Uint8Array, mime: "image/png" | "image/jpeg"): Promise<string> {
    const form = new FormData();
    form.append("messaging_product", "whatsapp");
    form.append("type", mime);
    form.append("file", new Blob([bytes], { type: mime }), mime === "image/png" ? "qr.png" : "imagen.jpg");
    const url = `${this.cfg.baseUrl ?? WHATSAPP_GRAPH_URL}/${this.cfg.version ?? WHATSAPP_GRAPH_VERSION}/${encodeURIComponent(this.cfg.phoneNumberId)}/media`;
    const res = await this.http(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.cfg.token}` },
      body: form,
      signal: AbortSignal.timeout(this.cfg.timeoutMs ?? WHATSAPP_TIMEOUT_MS),
    });
    const json = (await res.json().catch(() => null)) as { id?: string; error?: { message?: string; code?: number } } | null;
    if (!res.ok || !json?.id) throw new WhatsAppApiError(res.status, json?.error?.code ?? null, json?.error?.message ?? `WhatsApp media ${res.status}`);
    return json.id;
  }

  /** Imagen ya subida, con pie de foto (máx. 1024). */
  sendImage(to: string, mediaId: string, caption?: string): Promise<string | null> {
    return this.send(to, { type: "image", image: { id: mediaId, ...(caption ? { caption: caption.slice(0, MAX_BODY) } : {}) } });
  }

  /** Hasta 3 botones de respuesta; títulos recortados a 20 caracteres. */
  sendButtons(to: string, body: string, buttons: WhatsAppButton[]): Promise<string | null> {
    if (buttons.length === 0) return this.sendText(to, body);
    return this.send(to, {
      type: "interactive",
      interactive: {
        type: "button",
        body: { text: body.slice(0, MAX_BODY) },
        action: {
          buttons: buttons.slice(0, MAX_BUTTONS).map((b) => ({ type: "reply", reply: { id: b.id.slice(0, 256), title: b.title.slice(0, MAX_TITLE) } })),
        },
      },
    });
  }
}
