import { createHash, timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance } from "fastify";
import { z } from "zod";
import type { Db } from "@cuadra/db";
import { schema } from "@cuadra/db";
import { and, eq } from "drizzle-orm";
import type { CuadraService } from "./service.js";
import { PortalAuth } from "./auth.js";
import { type PasskeyOpts, registerPasskeyRoutes } from "./passkey.js";
import { panelState, providerReconState, tandaState } from "./state.js";
import type { WhatsAppChannel } from "./whatsapp.js";
import { parseWhatsAppWebhook, verifyWhatsAppSignature, verifyWhatsAppSubscription } from "@cuadra/adapters";

export interface ServerOpts {
  db: Db;
  service: CuadraService;
  merchantId: string;
  gateway: { name: string; simulated: boolean };
  bankSim: boolean;
  passkey: PasskeyOpts;
  /** Si existe, toda la app (salvo /health y /webhooks/*) pide esta contraseña (HTTP Basic). */
  demoPassword?: string | null;
  log: (r: Record<string, unknown>) => void;
  whatsapp?: { channel: WhatsAppChannel; appSecret: string; verifyToken: string };
  /** Login del portal (celular + NIP). Sin sesión solo quedan abiertas /login, webhooks y la aprobación con passkey. */
  portalAuth: { shopCode: string | null; secureCookies: boolean; now?: () => Date };
}

const ChatBody = z.object({
  text: z.string().min(1).max(1000),
  provenance: z.enum(["user_direct", "user_voice", "third_party_content"]).default("user_direct"),
});
const ActionBody = z.object({ proposal_id: z.string().min(1).max(64) });

export function buildServer(o: ServerOpts): FastifyInstance {
  const app = Fastify({ logger: false, bodyLimit: 256 * 1024 });

  // Los webhooks se verifican sobre el cuerpo crudo.
  app.addContentTypeParser("application/json", { parseAs: "string" }, (_req, body, done) => done(null, body));
  const json = (raw: unknown) => JSON.parse(typeof raw === "string" && raw ? raw : "{}") as unknown;

  if (o.demoPassword) {
    const expected = createHash("sha256").update(o.demoPassword).digest();
    app.addHook("onRequest", async (req, reply) => {
      const path = req.url.split("?")[0] ?? "";
      // El aviso de privacidad es público: Meta lo exige para publicar la app de WhatsApp.
      if (path === "/health" || path === "/privacidad" || path.startsWith("/webhooks/")) return;
      const auth = req.headers.authorization ?? "";
      const m = /^Basic\s+(.+)$/i.exec(auth);
      const pass = m ? Buffer.from(m[1]!, "base64").toString("utf8").split(":").slice(1).join(":") : "";
      const given = createHash("sha256").update(pass).digest();
      if (!m || !timingSafeEqual(given, expected)) {
        return reply.code(401).header("WWW-Authenticate", 'Basic realm="Cuadra", charset="UTF-8"').send({ error: "Acceso restringido" });
      }
    });
  }

  const auth = new PortalAuth({
    db: o.db,
    merchantId: o.merchantId,
    shopCode: o.portalAuth.shopCode,
    secureCookies: o.portalAuth.secureCookies,
    now: o.portalAuth.now ?? (() => new Date()),
  });
  app.addHook("onRequest", (req, reply) => auth.guard(req, reply));
  auth.register(app, json);

  app.register(fastifyStatic, { root: fileURLToPath(new URL("../public/", import.meta.url)) });
  app.get("/privacidad", async (_req, reply) => reply.type("text/html; charset=utf-8").sendFile("privacidad.html"));
  // Portal sencillo para el comercio (letra grande, un paso por pantalla). Usa la misma API que el chat.
  for (const path of ["/login", "/portal"]) {
    app.get(path, async (_req, reply) => reply.type("text/html; charset=utf-8").sendFile("portal.html"));
  }

  // commit: lo inyecta Railway en cada despliegue; sirve para saber qué versión está en vivo.
  app.get("/health", async () => ({ ok: true, commit: process.env.RAILWAY_GIT_COMMIT_SHA?.slice(0, 7) ?? null }));
  registerPasskeyRoutes(app, o.passkey);

  app.post("/api/chat", async (req, reply) => {
    const b = ChatBody.safeParse(json(req.body));
    if (!b.success) return reply.code(400).send({ error: "mensaje inválido" });
    await o.service.handleMerchantMessage(b.data.text, b.data.provenance);
    return { ok: true };
  });

  app.post("/api/confirm", async (req, reply) => {
    const b = ActionBody.safeParse(json(req.body));
    if (!b.success) return reply.code(400).send({ error: "inválido" });
    await o.service.confirm(b.data.proposal_id);
    return { ok: true };
  });

  app.post("/api/cancel", async (req, reply) => {
    const b = ActionBody.safeParse(json(req.body));
    if (!b.success) return reply.code(400).send({ error: "inválido" });
    await o.service.cancel(b.data.proposal_id);
    return { ok: true };
  });

  app.get("/api/state", async () => ({
    ...(await panelState(o.db, o.merchantId, { gateway: o.gateway.name, simulated: o.gateway.simulated, bankSim: o.bankSim })),
    tanda: await tandaState(o.db, o.service),
    provider_reconciliation: await providerReconState(o.db, o.merchantId, o.gateway.name),
    n2bis: await o.service.n2bis().then((s) => s && { pct: s.pct, level: s.level, limit: s.limit_cents.toString(), received: s.received_cents.toString(), remaining: s.remaining_cents.toString(), message: s.message }),
  }));

  app.post("/webhooks/pey", async (req, reply) => {
    const headers = Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k, Array.isArray(v) ? v[0] : v]));
    try {
      const r = await o.service.handlePeyWebhook(typeof req.body === "string" ? req.body : "", headers);
      o.log({ msg: "pey_webhook", status: r.status, webhook_id: headers["webhook-id"] });
      return reply.code(r.status).send(r.body);
    } catch (e) {
      o.log({ msg: "pey_webhook_error", webhook_id: headers["webhook-id"], error: e instanceof Error ? e.message : String(e) });
      return reply.code(500).send({ error: "reintentar" });
    }
  });

  const wa = o.whatsapp;
  if (wa) {
    // Meta verifica la URL con un GET antes de mandar eventos.
    app.get("/webhooks/whatsapp", async (req, reply) => {
      const challenge = verifyWhatsAppSubscription(req.query as Record<string, unknown>, wa.verifyToken);
      return challenge === null ? reply.code(403).send() : reply.type("text/plain").send(challenge);
    });
    app.post("/webhooks/whatsapp", async (req, reply) => {
      const raw = typeof req.body === "string" ? req.body : "";
      const sig = req.headers["x-hub-signature-256"];
      if (!verifyWhatsAppSignature(raw, Array.isArray(sig) ? sig[0] : sig, wa.appSecret)) return reply.code(401).send();
      const msgs = parseWhatsAppWebhook(json(raw));
      // Se responde 200 de inmediato; el intérprete puede tardar y Meta reintenta (el id evita duplicados).
      void wa.channel.handleInbound(msgs, o.service).catch((e: unknown) => {
        o.log({ msg: "whatsapp_inbound_error", error: e instanceof Error ? e.message : String(e) });
      });
      return reply.code(200).send();
    });
  }

  // Solo en modo simulado: el cliente "aprueba" el cobro CoDi en su banco.
  app.post("/api/sim/pay/:chargeId", async (req, reply) => {
    if (!o.gateway.simulated) return reply.code(404).send({ error: "no disponible" });
    const { chargeId } = req.params as { chargeId: string };
    const [c] = await o.db
      .select()
      .from(schema.charges)
      .where(and(eq(schema.charges.id, chargeId), eq(schema.charges.merchantId, o.merchantId)));
    if (!c?.providerChargeId || c.status !== "open") return reply.code(409).send({ error: "cobro no disponible" });
    await o.service.simulatePaid(c.providerChargeId);
    return { ok: true };
  });

  // Conciliación manual contra pey (también corre sola cada pocos minutos).
  app.post("/api/reconcile/pey", async () => {
    const r = await o.service.reconcileProvider();
    return { ...r };
  });

  // Solo en modo simulado: un integrante aprueba su aportación (o todos los que faltan).
  app.post("/api/sim/tanda/pay/:chargeId", async (req, reply) => {
    if (!o.gateway.simulated) return reply.code(404).send({ error: "no disponible" });
    const { chargeId } = req.params as { chargeId: string };
    const [c] = await o.db.select().from(schema.tandaCharges).where(eq(schema.tandaCharges.id, chargeId));
    if (!c?.providerChargeId || c.status !== "open") return reply.code(409).send({ error: "aportación no disponible" });
    await o.service.simulatePaid(c.providerChargeId);
    return { ok: true };
  });
  app.post("/api/sim/tanda/pay-all", async (_req, reply) => {
    if (!o.gateway.simulated) return reply.code(404).send({ error: "no disponible" });
    const t = await o.service.tanda.activeTanda();
    if (!t) return reply.code(409).send({ error: "sin tanda activa" });
    const open = await o.db
      .select()
      .from(schema.tandaCharges)
      .where(and(eq(schema.tandaCharges.tandaId, t.id), eq(schema.tandaCharges.round, t.currentRound), eq(schema.tandaCharges.status, "open")));
    for (const c of open) if (c.providerChargeId) await o.service.simulatePaid(c.providerChargeId);
    return { ok: true, paid: open.length };
  });

  return app;
}
