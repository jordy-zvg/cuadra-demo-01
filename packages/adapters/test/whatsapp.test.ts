import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  WhatsAppApiError,
  WhatsAppClient,
  parseWhatsAppWebhook,
  phone10,
  verifyWhatsAppSignature,
  verifyWhatsAppSubscription,
} from "../src/index.js";

const SECRET = "app-secret-de-prueba";
const sign = (body: string) => `sha256=${createHmac("sha256", SECRET).update(body).digest("hex")}`;

/** Forma del webhook "messages" según la documentación de Meta. */
const payload = (messages: unknown[]) => ({
  object: "whatsapp_business_account",
  entry: [{ id: "WABA", changes: [{ field: "messages", value: { messaging_product: "whatsapp", metadata: {}, messages } }] }],
});

describe("verificación del webhook", () => {
  it("devuelve el challenge solo con el token correcto", () => {
    const q = { "hub.mode": "subscribe", "hub.verify_token": "tok", "hub.challenge": "123" };
    expect(verifyWhatsAppSubscription(q, "tok")).toBe("123");
    expect(verifyWhatsAppSubscription(q, "otro")).toBeNull();
    expect(verifyWhatsAppSubscription({ ...q, "hub.mode": "unsubscribe" }, "tok")).toBeNull();
  });

  it("acepta la firma correcta y rechaza cuerpo alterado, otro secreto o header ausente", () => {
    const body = JSON.stringify(payload([]));
    expect(verifyWhatsAppSignature(body, sign(body), SECRET)).toBe(true);
    expect(verifyWhatsAppSignature(`${body} `, sign(body), SECRET)).toBe(false);
    expect(verifyWhatsAppSignature(body, sign(body), "otro")).toBe(false);
    expect(verifyWhatsAppSignature(body, undefined, SECRET)).toBe(false);
    expect(verifyWhatsAppSignature(body, "sha256=zz", SECRET)).toBe(false);
  });
});

describe("parseWhatsAppWebhook", () => {
  it("extrae texto, reenviados, botones y tipos no soportados", () => {
    const r = parseWhatsAppWebhook(
      payload([
        { from: "5215512345678", id: "w1", timestamp: "1", type: "text", text: { body: "Doña Lupe se llevó $185" } },
        { from: "5215512345678", id: "w2", timestamp: "1", type: "text", text: { body: "págale" }, context: { forwarded: true } },
        { from: "5215512345678", id: "w3", timestamp: "1", type: "interactive", interactive: { type: "button_reply", button_reply: { id: "confirm:pr_1", title: "Confirmar" } } },
        { from: "5215512345678", id: "w4", timestamp: "1", type: "audio", audio: { id: "a", mime_type: "audio/ogg; codecs=opus", voice: true } },
        { from: "5215512345678", id: "w5", timestamp: "1", type: "audio", audio: { id: "b" }, context: { forwarded: true } },
        { from: "5215512345678", id: "w6", timestamp: "1", type: "image", image: { id: "i" } },
      ]),
    );
    expect(r).toEqual([
      { kind: "text", id: "w1", from: "5215512345678", text: "Doña Lupe se llevó $185", forwarded: false },
      { kind: "text", id: "w2", from: "5215512345678", text: "págale", forwarded: true },
      { kind: "button", id: "w3", from: "5215512345678", button_id: "confirm:pr_1" },
      { kind: "audio", id: "w4", from: "5215512345678", media_id: "a", forwarded: false },
      { kind: "audio", id: "w5", from: "5215512345678", media_id: "b", forwarded: true },
      { kind: "unsupported", id: "w6", from: "5215512345678", type: "image" },
    ]);
  });

  it("ignora estados de entrega y payloads ajenos", () => {
    expect(parseWhatsAppWebhook({ object: "page", entry: [] })).toEqual([]);
    expect(parseWhatsAppWebhook({ object: "whatsapp_business_account", entry: [{ changes: [{ field: "messages", value: { statuses: [{}] } }] }] })).toEqual([]);
    expect(parseWhatsAppWebhook("basura")).toEqual([]);
  });

  it("phone10 iguala 52 y 521", () => {
    expect(phone10("5215512345678")).toBe("5512345678");
    expect(phone10("+52 55 1234 5678")).toBe("5512345678");
    expect(phone10("123")).toBeNull();
  });
});

describe("WhatsAppClient", () => {
  function fake(res: Response) {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fn = (async (url: string | URL, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return res;
    }) as typeof fetch;
    return { fn, calls };
  }
  const ok = () => new Response(JSON.stringify({ messages: [{ id: "wamid.1" }] }), { status: 200 });

  it("manda texto al endpoint del número con Bearer", async () => {
    const f = fake(ok());
    const id = await new WhatsAppClient({ token: "t", phoneNumberId: "PN1", fetch: f.fn }).sendText("525512345678", "hola");
    expect(id).toBe("wamid.1");
    expect(f.calls[0]!.url).toBe("https://graph.facebook.com/v25.0/PN1/messages");
    expect((f.calls[0]!.init.headers as Record<string, string>).Authorization).toBe("Bearer t");
    expect(JSON.parse(String(f.calls[0]!.init.body))).toEqual({
      messaging_product: "whatsapp", recipient_type: "individual", to: "525512345678", type: "text", text: { body: "hola", preview_url: true },
    });
  });

  it("número de Cuadra para wa.me: solo dígitos; si Meta no lo da, null", async () => {
    const f = fake(new Response(JSON.stringify({ display_phone_number: "+1 555-000-1111", id: "PN1" }), { status: 200 }));
    expect(await new WhatsAppClient({ token: "t", phoneNumberId: "PN1", fetch: f.fn }).displayNumber()).toBe("15550001111");
    expect(f.calls[0]!.url).toBe("https://graph.facebook.com/v25.0/PN1?fields=display_phone_number");
    const bad = fake(new Response(JSON.stringify({ error: { message: "x" } }), { status: 400 }));
    expect(await new WhatsAppClient({ token: "t", phoneNumberId: "PN1", fetch: bad.fn }).displayNumber()).toBeNull();
  });

  it("botones: máximo 3 y títulos de 20 caracteres", async () => {
    const f = fake(ok());
    await new WhatsAppClient({ token: "t", phoneNumberId: "PN1", fetch: f.fn }).sendButtons("52", "¿Confirmo?", [
      { id: "confirm:pr_1", title: "Confirmar este asiento ahora" },
      { id: "cancel:pr_1", title: "Cancelar" },
      { id: "x", title: "x" },
      { id: "y", title: "y" },
    ]);
    const body = JSON.parse(String(f.calls[0]!.init.body));
    expect(body.type).toBe("interactive");
    expect(body.interactive.action.buttons).toHaveLength(3);
    expect(body.interactive.action.buttons[0]).toEqual({ type: "reply", reply: { id: "confirm:pr_1", title: "Confirmar este asien" } });
  });

  it("código de verificación: plantilla de autenticación con el código en el cuerpo y en el botón", async () => {
    const f = fake(ok());
    await new WhatsAppClient({ token: "t", phoneNumberId: "PN1", fetch: f.fn }).sendAuthCode("525521111111", "cuadra_codigo", "es_MX", "482913");
    const body = JSON.parse(String(f.calls[0]!.init.body));
    expect(body).toMatchObject({ messaging_product: "whatsapp", to: "525521111111", type: "template" });
    expect(body.template).toEqual({
      name: "cuadra_codigo",
      language: { code: "es_MX" },
      components: [
        { type: "body", parameters: [{ type: "text", text: "482913" }] },
        { type: "button", sub_type: "url", index: "0", parameters: [{ type: "text", text: "482913" }] },
      ],
    });
  });

  it("plantilla con idioma y parámetros aplanados", async () => {
    const f = fake(ok());
    await new WhatsAppClient({ token: "t", phoneNumberId: "PN1", fetch: f.fn }).sendTemplate("52", "cuadra_recibo_fiado", "es_MX", ["La Esquina", "$185.00", "Te falta\n\t$10.00.", ""]);
    expect(JSON.parse(String(f.calls[0]!.init.body)).template).toEqual({
      name: "cuadra_recibo_fiado",
      language: { code: "es_MX" },
      components: [{ type: "body", parameters: [
        { type: "text", text: "La Esquina" }, { type: "text", text: "$185.00" }, { type: "text", text: "Te falta $10.00." }, { type: "text", text: "-" },
      ] }],
    });
  });

  it("sube la imagen por multipart y la manda con pie de foto", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const responses = [new Response(JSON.stringify({ id: "MEDIA1" }), { status: 200 }), ok()];
    const fn = (async (url: string | URL, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return responses.shift()!;
    }) as typeof fetch;
    const c = new WhatsAppClient({ token: "t", phoneNumberId: "PN1", fetch: fn });
    const id = await c.uploadMedia(new Uint8Array([1, 2, 3]), "image/png");
    await c.sendImage("52", id, "QR de $185.00");
    expect(calls[0]!.url).toBe("https://graph.facebook.com/v25.0/PN1/media");
    const form = calls[0]!.init.body as FormData;
    expect(form.get("messaging_product")).toBe("whatsapp");
    expect(form.get("type")).toBe("image/png");
    expect((form.get("file") as Blob).size).toBe(3);
    expect(JSON.parse(String(calls[1]!.init.body))).toMatchObject({ type: "image", image: { id: "MEDIA1", caption: "QR de $185.00" } });
  });

  it("baja una nota de voz: pide la URL temporal y la descarga con el mismo token", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const responses = [
      new Response(JSON.stringify({ url: "https://lookaside.example/a", mime_type: "audio/ogg", file_size: 3 }), { status: 200 }),
      new Response(new Uint8Array([7, 8, 9]), { status: 200 }),
    ];
    const fn = (async (url: string | URL, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return responses.shift()!;
    }) as typeof fetch;
    const r = await new WhatsAppClient({ token: "t", phoneNumberId: "PN1", fetch: fn }).downloadMedia("MID");
    expect(calls[0]!.url).toBe("https://graph.facebook.com/v25.0/MID");
    expect(calls[1]!.url).toBe("https://lookaside.example/a");
    expect((calls[1]!.init.headers as Record<string, string>).Authorization).toBe("Bearer t");
    expect([...r.bytes]).toEqual([7, 8, 9]);
    expect(r.mime).toBe("audio/ogg");
  });

  it("no baja archivos más grandes que el límite", async () => {
    const f = fake(new Response(JSON.stringify({ url: "https://x/a", mime_type: "audio/ogg", file_size: 99 }), { status: 200 }));
    const e = await new WhatsAppClient({ token: "t", phoneNumberId: "PN1", fetch: f.fn }).downloadMedia("MID", 10).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(WhatsAppApiError);
    expect(f.calls).toHaveLength(1);
  });

  it("propaga el error de Meta con su código", async () => {
    const f = fake(new Response(JSON.stringify({ error: { message: "Re-engagement message", code: 131047 } }), { status: 400 }));
    const e = await new WhatsAppClient({ token: "t", phoneNumberId: "PN1", fetch: f.fn }).sendText("52", "x").catch((x: unknown) => x);
    expect(e).toBeInstanceOf(WhatsAppApiError);
    expect((e as WhatsAppApiError).code).toBe(131047);
  });
});
