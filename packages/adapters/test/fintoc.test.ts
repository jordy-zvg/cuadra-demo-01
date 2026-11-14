import { createHmac, createVerify, generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  FintocPaymentProvider,
  ProviderOutcomeUnknownError,
  WebhookSignatureError,
  fintocJwsSignature,
  parseFintocWebhook,
  verifyFintocSignature,
} from "../src/index.js";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PRIVATE_PEM = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const NOW = new Date("2026-11-14T18:00:00Z");
const CLABE_OK = "012969100000000110"; // CLABE de prueba de Fintoc: transferencia exitosa
const req = { idempotency_key: "proposal:pr_1", clabe: CLABE_OK, holder_name: "X", amount_cents: 120000n, concept: "Refrescos Pérez semana 46 entrega completa y extra" };

/** Transfer de ejemplo de la documentación (outbound-transfers, México). */
const docTransfer = (over: Record<string, unknown> = {}) => ({
  object: "transfer", id: "tr_jKaHD105H", amount: 120000, currency: "MXN", direction: "outbound", status: "pending",
  transaction_date: "2020-04-17T05:12:41.462Z", comment: "Refrescos", reference_id: null, tracking_key: "s2123423423324334",
  mode: "test", return_reason: null, settled_amount: 0,
  counterparty: { holder_id: "AAA010101AAA", holder_name: "Test Customer 1", account_number: CLABE_OK, account_type: "clabe", institution: { id: "mx_bbva_mexico", name: "BBVA Mexico", country: "mx" } },
  account_number: { id: "acno_1", account_id: "acc_1", number: "111111111111111111", object: "account_number" },
  metadata: { cuadra_idempotency_key: "proposal:pr_1" },
  ...over,
});

type Call = { url: string; init: RequestInit };
function fakeFetch(responses: Array<(c: Call) => Response | Promise<Response>>) {
  const calls: Call[] = [];
  const fn = (async (url: string | URL, init?: RequestInit) => {
    const c = { url: String(url), init: init ?? {} };
    calls.push(c);
    const r = responses.shift();
    if (!r) throw new Error("llamada inesperada");
    return r(c);
  }) as typeof fetch;
  return { fn, calls };
}
const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const provider = (f: typeof fetch) =>
  new FintocPaymentProvider({ secretKey: "sk_test_fake", jwsPrivateKeyPem: PRIVATE_PEM, accountId: "acc_1", fetch: f, now: () => NOW });

describe("JWS de Fintoc", () => {
  it("header protegido RS256 con nonce, ts y crit; firma verificable sobre el body exacto", () => {
    const body = JSON.stringify({ amount: 1, currency: "MXN" });
    const sig = fintocJwsSignature(body, PRIVATE_PEM, { now: NOW, nonce: "abc" });
    const [h, s] = sig.split(".");
    expect(JSON.parse(Buffer.from(h!, "base64url").toString())).toEqual({ alg: "RS256", nonce: "abc", ts: NOW.getTime() / 1000, crit: ["ts", "nonce"] });
    const ok = createVerify("sha256").update(`${h}.${Buffer.from(body).toString("base64url")}`).verify(publicKey, Buffer.from(s!, "base64url"));
    expect(ok).toBe(true);
    const tampered = createVerify("sha256").update(`${h}.${Buffer.from(body + " ").toString("base64url")}`).verify(publicKey, Buffer.from(s!, "base64url"));
    expect(tampered).toBe(false);
  });
  it("nonce distinto en cada firma", () => {
    expect(fintocJwsSignature("{}", PRIVATE_PEM)).not.toBe(fintocJwsSignature("{}", PRIVATE_PEM));
  });
});

describe("FintocPaymentProvider.createTransfer", () => {
  it("manda POST /v2/transfers con headers y cuerpo de la documentación", async () => {
    const f = fakeFetch([() => json(201, docTransfer())]);
    expect(await provider(f.fn).createTransfer(req)).toEqual({ provider_ref: "tr_jKaHD105H", status: "sent" });
    const c = f.calls[0]!;
    expect(c.url).toBe("https://api.fintoc.com/v2/transfers");
    expect(c.init.method).toBe("POST");
    const h = c.init.headers as Record<string, string>;
    expect(h.Authorization).toBe("sk_test_fake");
    expect(h["Idempotency-Key"]).toBe("proposal:pr_1");
    const body = JSON.parse(c.init.body as string);
    expect(body).toEqual({
      amount: 120000,
      currency: "MXN",
      account_id: "acc_1",
      comment: req.concept.slice(0, 40),
      counterparty: { account_number: CLABE_OK },
      metadata: { cuadra_idempotency_key: "proposal:pr_1" },
    });
    // La firma cubre exactamente el body enviado.
    const [jh, js] = h["Fintoc-JWS-Signature"]!.split(".");
    const verified = createVerify("sha256")
      .update(`${jh}.${Buffer.from(c.init.body as string).toString("base64url")}`)
      .verify(publicKey, Buffer.from(js!, "base64url"));
    expect(verified).toBe(true);
  });

  it("succeeded al crear también es 'sent' (la contabilidad espera el webhook)", async () => {
    const f = fakeFetch([() => json(201, docTransfer({ status: "succeeded" }))]);
    expect(await provider(f.fn).createTransfer(req)).toMatchObject({ status: "sent" });
  });

  it("409 saldo insuficiente → failed definitivo", async () => {
    const f = fakeFetch([() => json(409, { error: { type: "invalid_request_error", code: "insufficient_balance", message: "x" } })]);
    expect(await provider(f.fn).createTransfer(req)).toMatchObject({ status: "failed", failure_reason: "Fintoc 409: insufficient_balance" });
  });

  it("400 → failed; 401 → error de configuración (no reversa en silencio)", async () => {
    const f = fakeFetch([() => json(400, { error: { code: "missing_parameter" } })]);
    expect(await provider(f.fn).createTransfer(req)).toMatchObject({ status: "failed" });
    const g = fakeFetch([() => json(401, { error: { code: "invalid_api_key" } })]);
    await expect(provider(g.fn).createTransfer(req)).rejects.toThrow(/401/);
  });

  it("5xx → busca por metadata y encuentra la transferencia (sin crear otra)", async () => {
    const f = fakeFetch([
      () => json(500, { error: { code: "internal" } }),
      () => json(200, [docTransfer({ id: "tr_otra", metadata: { cuadra_idempotency_key: "otra" } })], { link: '<https://api.fintoc.com/v2/transfers?page=2>; rel="next"' }),
      () => json(200, [docTransfer({ id: "tr_mia" })]),
    ]);
    expect(await provider(f.fn).createTransfer(req)).toEqual({ provider_ref: "tr_mia", status: "sent" });
    const list = new URL(f.calls[1]!.url);
    expect(list.pathname).toBe("/v2/transfers");
    expect(Object.fromEntries(list.searchParams)).toMatchObject({ account_id: "acc_1", direction: "outbound", limit: "300" });
    expect(f.calls[2]!.url).toBe("https://api.fintoc.com/v2/transfers?page=2");
    expect(f.calls.filter((c) => c.init.method === "POST")).toHaveLength(1);
  });

  it("timeout y no aparece → ProviderOutcomeUnknownError (reintentar, nunca llave nueva)", async () => {
    const f = fakeFetch([
      () => {
        throw new Error("ETIMEDOUT");
      },
      () => json(200, []),
    ]);
    await expect(provider(f.fn).createTransfer(req)).rejects.toThrow(ProviderOutcomeUnknownError);
  });

  it("encontrada pero fallida → failed", async () => {
    const f = fakeFetch([() => json(503, {}), () => json(200, [docTransfer({ status: "failed" })])]);
    expect(await provider(f.fn).createTransfer(req)).toMatchObject({ status: "failed" });
  });

  it("saldo: GET /v2/accounts/{id} → available_balance", async () => {
    const f = fakeFetch([() => json(200, { id: "acc_1", object: "account", available_balance: 590013, currency: "MXN" })]);
    expect(await provider(f.fn).getBalance()).toBe(590013n);
    expect(f.calls[0]!.url).toBe("https://api.fintoc.com/v2/accounts/acc_1");
  });

  it("no arranca sin configuración completa", () => {
    expect(() => new FintocPaymentProvider({ secretKey: "", jwsPrivateKeyPem: "x", accountId: "a" })).toThrow();
  });
});

describe("webhooks de Fintoc", () => {
  const SECRET = "whsec_fake";
  const sign = (body: string, t = Math.floor(NOW.getTime() / 1000)) =>
    `t=${t},v1=${createHmac("sha256", SECRET).update(`${t}.${body}`).digest("hex")}`;
  const event = (type: string, data: unknown) => JSON.stringify({ id: "evt_a4xK32BanKWYn", type, object: "event", data });
  const parse = (body: string, header = sign(body)) => parseFintocWebhook(body, { "fintoc-signature": header }, SECRET, NOW);

  it("firma: válida, alterada, otro secreto, vieja (> 5 min) o ausente", () => {
    const body = event("transfer.outbound.succeeded", docTransfer());
    expect(verifyFintocSignature(body, sign(body), SECRET, NOW)).toBe(true);
    expect(verifyFintocSignature(body + " ", sign(body), SECRET, NOW)).toBe(false);
    expect(verifyFintocSignature(body, sign(body), "otro", NOW)).toBe(false);
    expect(verifyFintocSignature(body, sign(body, NOW.getTime() / 1000 - 301), SECRET, NOW)).toBe(false);
    expect(verifyFintocSignature(body, undefined, SECRET, NOW)).toBe(false);
    expect(verifyFintocSignature(body, "t=1,v1=zz", SECRET, NOW)).toBe(false);
    expect(() => parse(body, "t=1,v1=00")).toThrow(WebhookSignatureError);
  });

  it("salientes: succeeded, failed, returned", () => {
    expect(parse(event("transfer.outbound.succeeded", docTransfer({ status: "succeeded" })))).toEqual({ type: "transfer.confirmed", event_id: "evt_a4xK32BanKWYn", provider_ref: "tr_jKaHD105H" });
    expect(parse(event("transfer.outbound.failed", docTransfer({ status: "failed" })))).toMatchObject({ type: "transfer.failed" });
    expect(parse(event("transfer.outbound.returned", docTransfer({ status: "returned", return_reason: "cuenta_inexistente" })))).toMatchObject({ type: "transfer.returned", return_reason: "cuenta_inexistente" });
  });

  it("entrante (ejemplo de la doc) → abono con clave de rastreo, CLABEs y referencia", () => {
    const inbound = docTransfer({
      direction: "inbound", status: "succeeded", amount: 2864, comment: "Electricity bill", reference_id: "130824", tracking_key: "s2123423423324334",
      counterparty: { account_number: "012180000000000006", account_type: "clabe" },
      account_number: { id: "acno_Kasf91034gj1AD", account_id: "acc_Lq7dP901xZgA2B", number: "111111111111111111" },
      metadata: {},
    });
    expect(parse(event("transfer.inbound.succeeded", inbound))).toEqual({
      type: "deposit.received", event_id: "evt_a4xK32BanKWYn", clave_rastreo: "s2123423423324334", amount_cents: 2864n,
      destination_clabe: "111111111111111111", ordering_clabe: "012180000000000006", reference: "130824", concept: "Electricity bill",
      provider_account_id: "acc_Lq7dP901xZgA2B",
    });
  });

  it("entrante sin tracking_key → error (no inventamos la clave)", () => {
    expect(() => parse(event("transfer.inbound.succeeded", docTransfer({ direction: "inbound", tracking_key: null })))).toThrow(/tracking_key/);
  });

  it("otros eventos se ignoran; moneda distinta a MXN es error", () => {
    expect(parse(event("transfer.inbound.returned", docTransfer()))).toEqual({ type: "ignored", event_id: "evt_a4xK32BanKWYn", original_type: "transfer.inbound.returned" });
    expect(() => parse(event("transfer.outbound.succeeded", docTransfer({ currency: "CLP" })))).toThrow(/Moneda/);
  });
});
