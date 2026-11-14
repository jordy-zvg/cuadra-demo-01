import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  PeyApiError,
  PeyClient,
  WebhookSignatureError,
  centsToPesos,
  parsePeyWebhook,
  pesosToCents,
  signPeyWebhook,
} from "../src/index.js";

type Call = { url: string; init: RequestInit };
function fake(responses: Array<() => Response>) {
  const calls: Call[] = [];
  const fn = (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const r = responses.shift();
    if (!r) throw new Error("llamada inesperada");
    return r();
  }) as typeof fetch;
  return { fn, calls };
}
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const client = (f: typeof fetch) => new PeyClient({ apiKey: "pey_fake", fetch: f });

/** Ejemplo de GET /transaction/{id} de la spec. */
const docTx = {
  id: "01HXYZTXN1234567890ABCDE00", status: "PAID", amount: 102.5, amountBreakdown: { base: 100, tip: 0, fee: 2.5 },
  currency: "MXN", paymentMethod: "CODI", payableType: "API_CODI_PN", payableId: "01HXYZ1234567890ABCDEFGH00",
  applicationFee: 7.5, dateCreated: 1704067200, datePaid: 1704067260,
  metadata: { clabe: "000000000000000000", bankCode: 40012, accountType: 40, description: "Pago en Tacos Pey", trackingKey: "0192191042", externalMetadata: { orderId: "12345", cuadra_charge_id: "ch_1" } },
};

describe("montos pesos ↔ centavos", () => {
  it("convierte exacto", () => {
    expect(centsToPesos(18500n)).toBe(185);
    expect(centsToPesos(1n)).toBe(0.01);
    expect(centsToPesos(10250n)).toBe(102.5);
    expect(pesosToCents(102.5)).toBe(10250n);
    expect(pesosToCents(0.01)).toBe(1n);
    expect(pesosToCents(0)).toBe(0n);
  });
  it("rechaza más de 2 decimales, negativos y no finitos", () => {
    for (const bad of [0.001, -1, Number.NaN, Number.POSITIVE_INFINITY, 1e-7]) expect(() => pesosToCents(bad)).toThrow();
  });
  it("propiedad: ida y vuelta exacta hasta $1,000,000", () => {
    fc.assert(fc.property(fc.bigInt({ min: 0n, max: 100_000_000n }), (c) => pesosToCents(centsToPesos(c)) === c));
  });
});

describe("PeyClient", () => {
  it("POST /codi/pn con Bearer, monto en pesos, celular y referencia", async () => {
    const f = fake([() => json(200, { transactionId: "01J5KXYZ1234567890ABCD", codiId: "12345678901234567890" })]);
    const r = await client(f.fn).createPushNotification({ amount_cents: 18500n, phone10: "5512345678", concept: "Fiado Doña Lupe", num_ref: "4815162", metadata: { cuadra_charge_id: "ch_1" } });
    expect(r).toEqual({ transactionId: "01J5KXYZ1234567890ABCD", codiId: "12345678901234567890" });
    const c = f.calls[0]!;
    expect(c.url).toBe("https://api.pey.mx/codi/pn");
    expect((c.init.headers as Record<string, string>).Authorization).toBe("Bearer pey_fake");
    expect(JSON.parse(c.init.body as string)).toEqual({ amount: 185, phoneNumber: "5512345678", concept: "Fiado Doña Lupe", expiration: 360, numRef: "4815162", metadata: { cuadra_charge_id: "ch_1" } });
  });

  it("valida celular, referencia y rango antes de llamar", async () => {
    const f = fake([]);
    const c = client(f.fn);
    await expect(c.createPushNotification({ amount_cents: 1n, phone10: "55123", concept: "x" })).rejects.toThrow(/10 dígitos/);
    await expect(c.createPushNotification({ amount_cents: 1n, phone10: "5512345678", concept: "x", num_ref: "12345678" })).rejects.toThrow(/numRef/);
    await expect(c.createPushNotification({ amount_cents: 0n, phone10: "5512345678", concept: "x" })).rejects.toThrow();
    await expect(c.createQr({ amount_cents: 1n, concept: "x", expiration_s: 100 })).rejects.toThrow();
    await expect(c.createPaymentLink({ amount_cents: 1n, success_url: "http://x", back_url: "https://x" })).rejects.toThrow(/HTTPS/);
    expect(f.calls).toHaveLength(0);
  });

  it("POST /codi/qr y /payment-link/create", async () => {
    const f = fake([
      () => json(201, { id: "AB12CD34EF", qrString: '{"TYP":1}', qrImage: null }),
      () => json(201, { id: "01HXYZ1234567890ABCDEFGH", url: "https://app.mipey.mx/payment-link/01HXYZ1234567890ABCDEFGH" }),
    ]);
    const c = client(f.fn);
    expect(await c.createQr({ amount_cents: 15000n, concept: "Order", num_ref: "1234567" })).toMatchObject({ id: "AB12CD34EF" });
    expect(JSON.parse(f.calls[0]!.init.body as string)).toEqual({ amount: 150, concept: "Order", expiration: 0, numRef: "1234567" });
    expect(await c.createPaymentLink({ amount_cents: 10000n, success_url: "https://c.mx/ok", back_url: "https://c.mx/back", client_reference_id: "ch_1" })).toMatchObject({ url: expect.stringContaining("mipey") });
    expect(f.calls[1]!.url).toBe("https://api.pey.mx/payment-link/create");
  });

  it("GET /transaction/{id} normaliza a centavos, CLABE del pagador y clave de rastreo", async () => {
    const f = fake([() => json(200, docTx)]);
    expect(await client(f.fn).getTransaction("01HXYZTXN1234567890ABCDE00")).toEqual({
      id: "01HXYZTXN1234567890ABCDE00", status: "PAID", amount_cents: 10250n, base_cents: 10000n, tip_cents: 0n, fee_cents: 250n,
      payment_method: "CODI", payable_type: "API_CODI_PN", payable_id: "01HXYZ1234567890ABCDEFGH00",
      date_paid: new Date(1704067260 * 1000), payer_clabe: "000000000000000000", tracking_key: "0192191042",
      external_metadata: { orderId: "12345", cuadra_charge_id: "ch_1" },
    });
  });

  it("errores: 4xx no reintentable, 5xx sí", async () => {
    const f = fake([
      () => json(400, { error: { message: "API key does not have CoDi enabled", type: "INVALID_STATE", requestId: "r1" } }),
      () => json(503, { error: { message: "maintenance", type: "SERVICE_UNAVAILABLE", requestId: "r2" } }),
    ]);
    const c = client(f.fn);
    const e1 = await c.getTransaction("x").catch((e: unknown) => e);
    expect(e1).toBeInstanceOf(PeyApiError);
    expect(e1).toMatchObject({ status: 400, type: "INVALID_STATE", retryable: false, requestId: "r1" });
    const e2 = await c.getTransaction("x").catch((e: unknown) => e);
    expect(e2).toMatchObject({ status: 503, retryable: true });
  });

  it("lista transacciones con paginación por nextToken", async () => {
    const f = fake([() => json(200, { items: [docTx], nextToken: "abc" })]);
    const r = await client(f.fn).listTransactions("tok 1");
    expect(r.nextToken).toBe("abc");
    expect(f.calls[0]!.url).toBe("https://api.pey.mx/transaction/api-key?nextToken=tok%201");
  });
});

describe("webhooks de pey (Standard Webhooks)", () => {
  const SECRET = `whsec_${Buffer.from("secreto-de-prueba-32-bytes-xxxxx").toString("base64")}`;
  const pn = JSON.stringify({ amount: 100, apiKeyId: "01M3", concept: "(dev) Order 45", datePaid: 1790724758, metadata: {}, numRef: "4567", transactionId: "01M3QR5E7XHXMNZDEPFH3JAWS0", type: "codi.pn.payment_received" });

  it("firma válida → transacción a confirmar; webhook-id es la llave", () => {
    expect(parsePeyWebhook(pn, signPeyWebhook(SECRET, "msg_1", pn), SECRET)).toEqual({
      kind: "payment", event_id: "msg_1", transaction_ids: ["01M3QR5E7XHXMNZDEPFH3JAWS0"], source: "codi.pn.payment_received",
    });
  });
  it("cuerpo alterado, otro secreto, timestamp viejo o sin headers → rechazo", () => {
    const h = signPeyWebhook(SECRET, "msg_1", pn);
    expect(() => parsePeyWebhook(pn.replace("100", "1000"), h, SECRET)).toThrow(WebhookSignatureError);
    const other = `whsec_${Buffer.from("otro-secreto-de-prueba-32-bytes!").toString("base64")}`;
    expect(() => parsePeyWebhook(pn, h, other)).toThrow(WebhookSignatureError);
    const old = signPeyWebhook(SECRET, "msg_1", pn, new Date(Date.now() - 10 * 60_000));
    expect(() => parsePeyWebhook(pn, old, SECRET)).toThrow(WebhookSignatureError);
    expect(() => parsePeyWebhook(pn, {}, SECRET)).toThrow(WebhookSignatureError);
  });
  it("QR pagado, link pagado (varias transacciones), link pendiente ignorado", () => {
    const qr = JSON.stringify({ type: "codi.qr.payment_received", transactionId: "T1", amount: 5, codiQrId: "AB" });
    expect(parsePeyWebhook(qr, signPeyWebhook(SECRET, "m2", qr), SECRET)).toMatchObject({ kind: "payment", transaction_ids: ["T1"] });
    const paid = JSON.stringify({ type: "payment_link.status_updated", paymentLinkId: "L", status: "paid", transactions: [{ transactionId: "T2" }, { transactionId: "T3" }] });
    expect(parsePeyWebhook(paid, signPeyWebhook(SECRET, "m3", paid), SECRET)).toMatchObject({ transaction_ids: ["T2", "T3"] });
    const pend = JSON.stringify({ type: "payment_link.status_updated", paymentLinkId: "L", status: "processing", transactions: [] });
    expect(parsePeyWebhook(pend, signPeyWebhook(SECRET, "m4", pend), SECRET)).toMatchObject({ kind: "ignored", original_type: "payment_link.processing" });
    const other = JSON.stringify({ type: "otra.cosa" });
    expect(parsePeyWebhook(other, signPeyWebhook(SECRET, "m5", other), SECRET)).toMatchObject({ kind: "ignored", original_type: "otra.cosa" });
  });
});
