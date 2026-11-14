import { RuleInterpreter } from "@cuadra/agents";
import { DEMO, seedDemo } from "@cuadra/db";
import { createTestDb } from "@cuadra/db/testing";
import { describe, expect, it } from "vitest";
import { SimulatedGateway } from "../src/gateway.js";
import { buildServer } from "../src/server.js";
import { CuadraService } from "../src/service.js";

async function app(demoPassword: string | null) {
  const { db } = await createTestDb();
  await seedDemo(db);
  const gateway = new SimulatedGateway(db);
  const service = new CuadraService({
    db, merchantId: DEMO.merchantId, ownerId: DEMO.ownerId, interpreters: [new RuleInterpreter()], gateway,
    verify: async () => false, now: () => new Date(), publicUrl: null, peyWebhookSecret: null, bankSim: false, udi: null, log: () => {},
  });
  return buildServer({
    db, service, merchantId: DEMO.merchantId, gateway, bankSim: false, demoPassword, log: () => {},
    passkey: { gateway, db, merchantId: DEMO.merchantId, ownerId: DEMO.ownerId, rpID: "localhost", origins: ["http://localhost"], now: () => new Date() },
  });
}
const basic = (p: string) => `Basic ${Buffer.from(`cuadra:${p}`).toString("base64")}`;

describe("login mínimo de la demo", () => {
  it("con DEMO_PASSWORD: pide contraseña salvo /health y webhooks", async () => {
    const a = await app("s3creta");
    expect((await a.inject({ url: "/api/state" })).statusCode).toBe(401);
    expect((await a.inject({ url: "/api/state", headers: { authorization: basic("mala") } })).statusCode).toBe(401);
    expect((await a.inject({ url: "/api/state", headers: { authorization: basic("s3creta") } })).statusCode).toBe(200);
    expect((await a.inject({ method: "POST", url: "/api/chat", payload: { text: "hola" } })).statusCode).toBe(401);
    expect((await a.inject({ url: "/health" })).statusCode).toBe(200);
    // El aviso de privacidad es público (Meta lo revisa para publicar la app).
    const priv = await a.inject({ url: "/privacidad" });
    expect(priv.statusCode).toBe(200);
    expect(priv.body).toMatch(/Aviso de privacidad de Cuadra/);
    // El webhook no pide contraseña (trae su propia firma): sin secreto configurado responde 503.
    expect((await a.inject({ method: "POST", url: "/webhooks/pey", payload: "{}", headers: { "content-type": "application/json" } })).statusCode).toBe(503);
  });
  it("sin DEMO_PASSWORD queda abierta", async () => {
    const a = await app(null);
    expect((await a.inject({ url: "/api/state" })).statusCode).toBe(200);
  });
});
