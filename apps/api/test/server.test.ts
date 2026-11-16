import { RuleInterpreter } from "@cuadra/agents";
import { DEMO, seedDemo } from "@cuadra/db";
import { createTestDb } from "@cuadra/db/testing";
import { describe, expect, it } from "vitest";
import { SimulatedGateway } from "../src/gateway.js";
import { buildServer } from "../src/server.js";
import { createStoreRegistry } from "../src/app.js";

async function app(demoPassword: string | null) {
  const { db } = await createTestDb();
  await seedDemo(db);
  const gateway = new SimulatedGateway(db);
  const registry = createStoreRegistry({
    db, liveGateway: gateway, interpreters: [new RuleInterpreter()], verify: async () => false, now: () => new Date(), publicUrl: null,
    peyWebhookSecret: null, bankSim: false, udi: null, log: () => {},
  });
  return buildServer({
    db, registry, liveMerchantId: DEMO.merchantId, liveGateway: gateway, peyWebhookSecret: null, bankSim: false, demoPassword, log: () => {},
    portalAuth: { shopCode: null, secureCookies: false },
    passkey: { rpID: "localhost", origins: ["http://localhost"], now: () => new Date() },
  });
}
const registrar = async (a: Awaited<ReturnType<typeof app>>, headers: Record<string, string> = {}) => {
  const r = await a.inject({ method: "POST", url: "/api/auth/register", headers, payload: { name: "Lupe", phone: "5512345678", pin: "2580" } });
  expect(r.statusCode).toBe(200);
  return String(r.headers["set-cookie"]).split(";")[0]!;
};
const basic = (p: string) => `Basic ${Buffer.from(`cuadra:${p}`).toString("base64")}`;

describe("login mínimo de la demo", () => {
  it("con DEMO_PASSWORD: pide contraseña salvo /health y webhooks", async () => {
    const a = await app("s3creta");
    expect((await a.inject({ url: "/api/state" })).statusCode).toBe(401);
    expect((await a.inject({ url: "/api/state", headers: { authorization: basic("mala") } })).statusCode).toBe(401);
    // Con la contraseña correcta pasa la capa básica; todavía falta la sesión del portal.
    expect((await a.inject({ url: "/api/state", headers: { authorization: basic("s3creta") } })).statusCode).toBe(401);
    const cookie = await registrar(a, { authorization: basic("s3creta") });
    expect((await a.inject({ url: "/api/state", headers: { authorization: basic("s3creta"), cookie } })).statusCode).toBe(200);
    // La sesión sola no basta: la contraseña básica sigue aplicando.
    expect((await a.inject({ url: "/api/state", headers: { cookie } })).statusCode).toBe(401);
    expect((await a.inject({ method: "POST", url: "/api/chat", payload: { text: "hola" } })).statusCode).toBe(401);
    expect((await a.inject({ url: "/health" })).statusCode).toBe(200);
    // El aviso de privacidad es público (Meta lo revisa para publicar la app).
    const priv = await a.inject({ url: "/privacidad" });
    expect(priv.statusCode).toBe(200);
    expect(priv.body).toMatch(/Aviso de privacidad de Cuadra/);
    // El webhook no pide contraseña (trae su propia firma): sin secreto configurado responde 503.
    expect((await a.inject({ method: "POST", url: "/webhooks/pey", payload: "{}", headers: { "content-type": "application/json" } })).statusCode).toBe(503);
  });
  it("sin DEMO_PASSWORD el estado exige sesión del portal", async () => {
    const a = await app(null);
    expect((await a.inject({ url: "/api/state" })).statusCode).toBe(401);
    // El ícono de la pestaña no pide sesión: /favicon.ico lleva al logo.
    const fav = await a.inject({ url: "/favicon.ico" });
    expect(fav.statusCode).toBe(302);
    expect(fav.headers.location).toBe("/logo.svg");
    expect((await a.inject({ url: "/logo.svg?v=1024a6e" })).statusCode).toBe(200);
    const cookie = await registrar(a);
    expect((await a.inject({ url: "/api/state", headers: { cookie } })).statusCode).toBe(200);
  });
  it("el portal y el logo se sirven; el portal exige contraseña si hay DEMO_PASSWORD", async () => {
    const open = await app(null);
    const portal = await open.inject({ url: "/portal" });
    expect(portal.statusCode).toBe(200);
    expect(portal.headers["content-type"]).toMatch(/text\/html/);
    expect(portal.body).toContain("<title>Cuadra</title>");
    expect((await open.inject({ url: "/login" })).body).toContain("<title>Cuadra</title>");
    expect((await open.inject({ url: "/logo.svg" })).statusCode).toBe(200);
    // PWA: manifiesto, service worker e íconos.
    const man = await open.inject({ url: "/manifest.webmanifest" });
    expect(man.statusCode).toBe(200);
    expect(JSON.parse(man.body).start_url).toBe("/login");
    const sw = await open.inject({ url: "/sw.js" });
    expect(sw.headers["content-type"]).toMatch(/javascript/);
    expect(sw.body).not.toMatch(/caches?\.(open|match)\([^)]*\/api/);
    expect((await open.inject({ url: "/icons/icon-512.png" })).statusCode).toBe(200);
    const locked = await app("s3creta");
    expect((await locked.inject({ url: "/portal" })).statusCode).toBe(401);
    expect((await locked.inject({ url: "/login" })).statusCode).toBe(401);
  });
});
