import { proposalHash, Proposal } from "@cuadra/core";
import { describe, expect, it } from "vitest";
import {
  MOCK_SIGNATURE_HEADER,
  MockPaymentProvider,
  WebhookSignatureError,
  verifyProposalAssertion,
} from "../src/index.js";
import { SoftAuthenticator } from "../src/testing.js";

const CLABE = "032180000118359719";
const req = { idempotency_key: "k1", clabe: CLABE, holder_name: "Don Pepe", amount_cents: 1000n, concept: "Refrescos" };

describe("MockPaymentProvider", () => {
  it("envía, debita y es idempotente por llave", async () => {
    const p = new MockPaymentProvider("s", { initialBalance: 5000n });
    const a = await p.createTransfer(req);
    const b = await p.createTransfer(req);
    expect(a).toEqual(b);
    expect(a.status).toBe("sent");
    expect(await p.getBalance()).toBe(4000n);
  });

  it("falla por saldo, CLABE inválida o falla inyectada", async () => {
    const p = new MockPaymentProvider("s", { initialBalance: 500n });
    expect(await p.createTransfer(req)).toMatchObject({ status: "failed", failure_reason: "Saldo insuficiente" });
    p.adjustBalance(10000n);
    expect(await p.createTransfer({ ...req, idempotency_key: "k2", clabe: "032180000118359710" })).toMatchObject({ failure_reason: "CLABE inválida" });
    p.failNextTransfer("Banco caído");
    expect(await p.createTransfer({ ...req, idempotency_key: "k3" })).toMatchObject({ failure_reason: "Banco caído" });
    expect(await p.createTransfer({ ...req, idempotency_key: "k3" })).toMatchObject({ failure_reason: "Banco caído" });
    expect(await p.getBalance()).toBe(10500n);
  });

  it("caída del proveedor lanza (para que la cola reintente)", async () => {
    const p = new MockPaymentProvider("s", { initialBalance: 5000n });
    p.setOutage(true);
    await expect(p.createTransfer(req)).rejects.toThrow();
  });

  it("webhooks firmados: confirmación, fallo con devolución y SPEI entrante", async () => {
    const p = new MockPaymentProvider("secreto", { initialBalance: 5000n });
    const sent = await p.createTransfer(req);
    const ok = p.settle(sent.provider_ref, "confirmed");
    expect(p.parseWebhook(ok.body, ok.headers)).toMatchObject({ type: "transfer.confirmed", provider_ref: sent.provider_ref });
    expect(() => p.settle(sent.provider_ref, "failed")).toThrow();

    const t2 = await p.createTransfer({ ...req, idempotency_key: "k2" });
    const bad = p.settle(t2.provider_ref, "failed");
    expect(p.parseWebhook(bad.body, bad.headers)).toMatchObject({ type: "transfer.failed" });
    expect(await p.getBalance()).toBe(4000n);

    const dep = p.incomingSpei({ clave_rastreo: "CR1", amount_cents: 8017n, reference: "1234567" });
    expect(p.parseWebhook(dep.body, dep.headers)).toMatchObject({ type: "deposit.received", amount_cents: 8017n });
    expect(await p.getBalance()).toBe(12017n);
  });

  it("rechaza firmas inválidas o ausentes", () => {
    const p = new MockPaymentProvider("secreto");
    const w = p.incomingSpei({ clave_rastreo: "CR1", amount_cents: 1n });
    const other = new MockPaymentProvider("otro");
    expect(() => other.parseWebhook(w.body, w.headers)).toThrow(WebhookSignatureError);
    expect(() => p.parseWebhook(w.body.replace('"1"', '"100"'), w.headers)).toThrow(WebhookSignatureError);
    expect(() => p.parseWebhook(w.body, {})).toThrow(WebhookSignatureError);
    expect(() => p.parseWebhook(w.body, { [MOCK_SIGNATURE_HEADER]: "zz" })).toThrow(WebhookSignatureError);
  });
});

describe("passkey ligada al hash de la propuesta", () => {
  const config = { rpID: "cuadra.test", origins: ["https://cuadra.test"] };
  const hash = proposalHash(Proposal.parse({ type: "PayoutRequest", merchant_id: "m1", provenance: "user_direct", payee_id: "p1", amount_cents: 1000, concept: "x" }));
  const other = proposalHash(Proposal.parse({ type: "PayoutRequest", merchant_id: "m1", provenance: "user_direct", payee_id: "p1", amount_cents: 1001, concept: "x" }));
  const auth = new SoftAuthenticator(config.rpID, config.origins[0]!);
  const credential = { id: auth.credentialId, publicKey: auth.publicKeyCose, counter: 0 };
  const verify = (assertion: unknown, h = hash, c = credential) =>
    verifyProposalAssertion({ assertion, proposalHash: h, credential: c, config });

  it("válida para el hash exacto", async () => {
    expect(await verify(auth.approve(hash))).toBe(true);
  });
  it("inválida para otro hash, otro origen, sin UV, otra credencial o basura", async () => {
    expect(await verify(auth.approve(hash), other)).toBe(false);
    expect(await verify(auth.approve(hash, { origin: "https://evil.test" }))).toBe(false);
    expect(await verify(auth.approve(hash, { userVerified: false }))).toBe(false);
    const intruder = new SoftAuthenticator(config.rpID, config.origins[0]!, { id: auth.credentialId });
    expect(await verify(intruder.approve(hash))).toBe(false);
    expect(await verify({ ...auth.approve(hash), id: "otro" })).toBe(false);
    expect(await verify(null)).toBe(false);
    expect(await verify({ id: auth.credentialId })).toBe(false);
  });
  it("con contador: una aserción vieja no pasa si el contador ya avanzó", async () => {
    const hw = new SoftAuthenticator(config.rpID, config.origins[0]!, { useCounter: true });
    const cred = { id: hw.credentialId, publicKey: hw.publicKeyCose, counter: 0 };
    const first = hw.approve(hash);
    expect(await verify(first, hash, cred)).toBe(true);
    expect(await verify(first, hash, { ...cred, counter: 1 })).toBe(false);
  });
});
