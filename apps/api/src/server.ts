import { createHash, timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { z } from "zod";
import type { Db } from "@cuadra/db";
import { schema } from "@cuadra/db";
import { and, eq } from "drizzle-orm";
import { debtsOfPhone } from "@cuadra/db";
import { PortalAuth } from "./auth.js";
import type { ChargeGateway } from "./gateway.js";
import { registerPasskeyRoutes } from "./passkey.js";
import { type Store, type StoreRegistry, handlePeyWebhookForStores } from "./stores.js";
import { panelState, providerReconState, tandaState } from "./state.js";
import type { WhatsAppChannel } from "./whatsapp.js";
import { parseWhatsAppWebhook, verifyWhatsAppSignature, verifyWhatsAppSubscription } from "@cuadra/adapters";

export interface ServerOpts {
  db: Db;
  /** Una tienda por persona: cada petición trabaja con la tienda de quien inició sesión. */
  registry: StoreRegistry;
  /** Tienda dueña de la cuenta receptora en vivo (la demo): recibe los pagos de pey sin cobro ligado. */
  liveMerchantId: string;
  /** Pasarela en vivo (pey), para confirmar los pagos que avisa su webhook. */
  liveGateway: ChargeGateway;
  peyWebhookSecret: string | null;
  bankSim: boolean;
  passkey: { rpID: string; origins: string[]; now: () => Date };
  /** Si existe, toda la app (salvo /health y /webhooks/*) pide esta contraseña (HTTP Basic). */
  demoPassword?: string | null;
  log: (r: Record<string, unknown>) => void;
  whatsapp?: { channel: WhatsAppChannel; appSecret: string; verifyToken: string };
  /** Carpeta de las páginas. Por defecto, apps/api/public; la vista previa local puede servir otra. */
  publicDir?: string;
  /** Login del portal (celular + NIP). Sin sesión solo quedan abiertas /login, webhooks y la aprobación con passkey. */
  portalAuth: {
    shopCode: string | null;
    secureCookies: boolean;
    llave?: "demo" | "off";
    now?: () => Date;
    /** Verificación del celular por WhatsApp (ver auth.ts). Sin esto, apagada. */
    verification?: { mode: "whatsapp" | "off"; waNumber: string | null };
  };
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
    shopCode: o.portalAuth.shopCode,
    secureCookies: o.portalAuth.secureCookies,
    llave: o.portalAuth.llave ?? "off",
    ...(o.portalAuth.verification ? { verification: o.portalAuth.verification } : {}),
    now: o.portalAuth.now ?? (() => new Date()),
  });
  app.addHook("onRequest", (req, reply) => auth.guard(req, reply));
  auth.register(app, json);

  // index:false — "/" es la landing pública; el panel de la demo vive en /panel (con sesión).
  app.register(fastifyStatic, { root: o.publicDir ?? fileURLToPath(new URL("../public/", import.meta.url)), index: false });
  app.get("/", async (_req, reply) => reply.type("text/html; charset=utf-8").sendFile("landing.html"));
  app.get("/panel", async (_req, reply) => reply.type("text/html; charset=utf-8").sendFile("index.html"));
  app.get("/privacidad", async (_req, reply) => reply.type("text/html; charset=utf-8").sendFile("privacidad.html"));
  // Portal sencillo para el comercio (letra grande, un paso por pantalla). Usa la misma API que el chat.
  for (const path of ["/login", "/portal"]) {
    app.get(path, async (_req, reply) => reply.type("text/html; charset=utf-8").sendFile("portal.html"));
  }

  // commit: lo inyecta Railway en cada despliegue; sirve para saber qué versión está en vivo.
  app.get("/health", async () => ({ ok: true, commit: process.env.RAILWAY_GIT_COMMIT_SHA?.slice(0, 7) ?? null }));
  /**
   * Tienda de quien hace la petición (por su sesión). Las rutas privadas ya pasaron por el guard;
   * aun así, sin sesión o sin tienda se responde 401 y nunca se cae a otra tienda.
   */
  const storeOf = async (req: FastifyRequest): Promise<Store | null> => {
    const account = await auth.accountFromRequest(req);
    // Sin verificar el celular no hay tienda (ni siquiera en rutas públicas que la consultan).
    return account?.verified ? o.registry.get(account.merchantId) : null;
  };
  const noStore = (reply: FastifyReply) => reply.code(401).send({ error: "Entra a tu cuenta para continuar." });

  registerPasskeyRoutes(app, { db: o.db, registry: o.registry, storeOf, log: o.log, ...o.passkey });

  app.post("/api/chat", async (req, reply) => {
    const b = ChatBody.safeParse(json(req.body));
    if (!b.success) return reply.code(400).send({ error: "mensaje inválido" });
    const st = await storeOf(req);
    if (!st) return noStore(reply);
    await st.service.handleMerchantMessage(b.data.text, b.data.provenance);
    return { ok: true };
  });

  app.post("/api/confirm", async (req, reply) => {
    const b = ActionBody.safeParse(json(req.body));
    if (!b.success) return reply.code(400).send({ error: "inválido" });
    const st = await storeOf(req);
    if (!st) return noStore(reply);
    // confirm() solo actúa sobre propuestas de esta tienda.
    await st.service.confirm(b.data.proposal_id);
    return { ok: true };
  });

  app.post("/api/cancel", async (req, reply) => {
    const b = ActionBody.safeParse(json(req.body));
    if (!b.success) return reply.code(400).send({ error: "inválido" });
    const st = await storeOf(req);
    if (!st) return noStore(reply);
    await st.service.cancel(b.data.proposal_id);
    return { ok: true };
  });

  app.get("/api/state", async (req, reply) => {
    const st = await storeOf(req);
    if (!st) return noStore(reply);
    return {
      ...(await panelState(o.db, st.merchantId, { gateway: st.gateway.name, simulated: st.gateway.simulated, bankSim: o.bankSim })),
      tanda: await tandaState(o.db, st.merchantId, st.service),
      provider_reconciliation: await providerReconState(o.db, st.merchantId, st.gateway.name),
      n2bis: await st.service.n2bis().then((s) => s && { pct: s.pct, level: s.level, limit: s.limit_cents.toString(), received: s.received_cents.toString(), remaining: s.remaining_cents.toString(), message: s.message }),
    };
  });

  // "Lo que debo": las tiendas que tienen a esta persona como cliente (por su celular). Solo su
  // propia deuda con cada una; nunca otros clientes ni datos internos de la tienda.
  app.get("/api/me/debts", async (req, reply) => {
    const account = await auth.accountFromRequest(req);
    if (!account?.verified) return noStore(reply);
    const debts = await debtsOfPhone(o.db, account.phone, account.merchantId);
    return {
      debts: debts.map((d) => ({
        store: d.merchant_name,
        owes: d.owes_cents.toString(),
        credit: d.credit_cents.toString(),
        open_charge: d.open_charge && {
          reference: d.open_charge.reference,
          amount: d.open_charge.amount_cents?.toString() ?? null,
          channel: d.open_charge.channel,
          expires_at: d.open_charge.expires_at?.toISOString() ?? null,
        },
      })),
    };
  });

  app.post("/webhooks/pey", async (req, reply) => {
    const headers = Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k, Array.isArray(v) ? v[0] : v]));
    try {
      const r = await handlePeyWebhookForStores(
        { db: o.db, registry: o.registry, secret: o.peyWebhookSecret, gateway: o.liveGateway, liveMerchantId: o.liveMerchantId },
        typeof req.body === "string" ? req.body : "",
        headers,
      );
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
      // Cada mensaje va a la tienda del celular que lo manda (si tiene una).
      void wa.channel.handleInbound(msgs, async (merchantId) => (await o.registry.get(merchantId))?.service ?? null).catch((e: unknown) => {
        o.log({ msg: "whatsapp_inbound_error", error: e instanceof Error ? e.message : String(e) });
      });
      return reply.code(200).send();
    });
  }

  // Solo en modo simulado: el cliente "aprueba" el cobro CoDi en su banco. Solo cobros de tu tienda.
  app.post("/api/sim/pay/:chargeId", async (req, reply) => {
    const st = await storeOf(req);
    if (!st) return noStore(reply);
    if (!st.gateway.simulated) return reply.code(404).send({ error: "no disponible" });
    const { chargeId } = req.params as { chargeId: string };
    const [c] = await o.db
      .select()
      .from(schema.charges)
      .where(and(eq(schema.charges.id, chargeId), eq(schema.charges.merchantId, st.merchantId)));
    if (!c?.providerChargeId || c.status !== "open") return reply.code(409).send({ error: "cobro no disponible" });
    await st.service.simulatePaid(c.providerChargeId);
    return { ok: true };
  });

  // Conciliación manual contra pey (también corre sola cada pocos minutos). Solo la tienda en vivo.
  app.post("/api/reconcile/pey", async (req, reply) => {
    const st = await storeOf(req);
    if (!st) return noStore(reply);
    const r = await st.service.reconcileProvider();
    return { ...r };
  });

  // Solo en modo simulado: un integrante aprueba su aportación (o todos los que faltan). Solo tandas de tu tienda.
  app.post("/api/sim/tanda/pay/:chargeId", async (req, reply) => {
    const st = await storeOf(req);
    if (!st) return noStore(reply);
    if (!st.gateway.simulated) return reply.code(404).send({ error: "no disponible" });
    const { chargeId } = req.params as { chargeId: string };
    const [c] = await o.db
      .select({ charge: schema.tandaCharges })
      .from(schema.tandaCharges)
      .innerJoin(schema.tandas, eq(schema.tandas.id, schema.tandaCharges.tandaId))
      .where(and(eq(schema.tandaCharges.id, chargeId), eq(schema.tandas.merchantId, st.merchantId)));
    if (!c?.charge.providerChargeId || c.charge.status !== "open") return reply.code(409).send({ error: "aportación no disponible" });
    await st.service.simulatePaid(c.charge.providerChargeId);
    return { ok: true };
  });
  app.post("/api/sim/tanda/pay-all", async (req, reply) => {
    const st = await storeOf(req);
    if (!st) return noStore(reply);
    if (!st.gateway.simulated) return reply.code(404).send({ error: "no disponible" });
    const t = await st.service.tanda.activeTanda();
    if (!t) return reply.code(409).send({ error: "sin tanda activa" });
    const open = await o.db
      .select()
      .from(schema.tandaCharges)
      .where(and(eq(schema.tandaCharges.tandaId, t.id), eq(schema.tandaCharges.round, t.currentRound), eq(schema.tandaCharges.status, "open")));
    for (const c of open) if (c.providerChargeId) await st.service.simulatePaid(c.providerChargeId);
    return { ok: true, paid: open.length };
  });

  return app;
}
