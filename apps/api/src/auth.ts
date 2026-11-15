import { createHash, randomBytes, randomUUID, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { Db } from "@cuadra/db";
import { schema } from "@cuadra/db";
import { and, eq, lt } from "drizzle-orm";

/**
 * Login del portal: celular (10 dígitos) + NIP de 4 dígitos, pensado para personas con poca
 * práctica con el celular. El NIP se guarda con scrypt; la sesión es una cookie HttpOnly con un
 * token aleatorio cuyo hash vive en la DB. Tras 5 NIP equivocados la cuenta espera 15 minutos.
 */

const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, len: number) => Promise<Buffer>;

export const SESSION_COOKIE = "cuadra_sesion";
export const SESSION_DAYS = 30;
export const MAX_FAILED = 5;
export const LOCK_MINUTES = 15;

export interface AuthOpts {
  db: Db;
  merchantId: string;
  /** Si existe, registrarse pide este código de la tienda (lo da el dueño). */
  shopCode: string | null;
  /** Cookie con Secure (en producción, detrás de HTTPS). */
  secureCookies: boolean;
  /** "demo": Llave CDMX simulada (página propia marcada como prueba). "off": sin botón. */
  llave: "demo" | "off";
  now: () => Date;
}

// ---------- reglas puras (con tests) ----------

/** Celular mexicano a 10 dígitos. Acepta espacios, guiones y lada 52 / +52 / 521. */
export function normalizePhone(raw: string): string | null {
  let d = String(raw).replace(/\D/g, "");
  if (d.length === 13 && d.startsWith("521")) d = d.slice(3);
  else if (d.length === 12 && d.startsWith("52")) d = d.slice(2);
  return /^\d{10}$/.test(d) ? d : null;
}

/** Devuelve el motivo (en español) si el NIP no sirve, o null si está bien. */
export function pinProblem(pin: string): string | null {
  if (!/^\d{4}$/.test(pin)) return "El NIP debe tener 4 números.";
  if (/^(\d)\1{3}$/.test(pin)) return "Ese NIP es muy fácil de adivinar (todos iguales). Elige otro.";
  if ("0123456789".includes(pin) || "9876543210".includes(pin)) return "Ese NIP es muy fácil de adivinar (números seguidos). Elige otro.";
  return null;
}

export function cleanName(raw: string): string | null {
  const n = String(raw).replace(/\s+/g, " ").trim();
  return n.length >= 2 && n.length <= 60 ? n : null;
}

export async function hashPin(pin: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(pin, salt, 32);
  return `scrypt$${salt.toString("base64")}$${key.toString("base64")}`;
}

export async function verifyPin(pin: string, stored: string): Promise<boolean> {
  const [alg, s, k] = stored.split("$");
  if (alg !== "scrypt" || !s || !k) return false;
  const expected = Buffer.from(k, "base64");
  const got = await scrypt(pin, Buffer.from(s, "base64"), expected.length);
  return got.length === expected.length && timingSafeEqual(got, expected);
}

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

function sameSecret(a: string, b: string): boolean {
  const x = createHash("sha256").update(a).digest();
  const y = createHash("sha256").update(b).digest();
  return timingSafeEqual(x, y);
}

/** CURP: 18 caracteres con la estructura oficial (validación de forma, no de existencia). */
export function normalizeCurp(raw: string): string | null {
  const c = String(raw).trim().toUpperCase();
  return /^[A-Z][AEIOUX][A-Z]{2}\d{6}[HMX](AS|BC|BS|CC|CL|CM|CS|CH|DF|DG|GT|GR|HG|JC|MC|MN|MS|NT|NL|OC|PL|QT|QR|SP|SL|SR|TC|TS|TL|VZ|YN|ZS|NE)[B-DF-HJ-NP-TV-Z]{3}[A-Z\d]\d$/.test(c) ? c : null;
}

export function readCookie(header: string | undefined, name: string): string | null {
  for (const part of (header ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) {
      try {
        return decodeURIComponent(part.slice(i + 1).trim());
      } catch {
        return null; // cookie malformada = sin sesión (no un 500)
      }
    }
  }
  return null;
}

// ---------- rutas que no piden sesión ----------

/**
 * Lo que queda abierto sin sesión: la página de entrada y sus archivos, los webhooks (traen su
 * propia firma), el aviso de privacidad y la aprobación con passkey que llega por WhatsApp
 * (ahí la huella es la que autoriza). Registrar una passkey NUEVA sí pide sesión.
 */
export function isPublicPath(path: string, method: string): boolean {
  if (path === "/health" || path === "/privacidad" || path.startsWith("/webhooks/")) return true;
  if (path === "/login" || path === "/portal" || path === "/sw.js" || path === "/manifest.webmanifest") return true;
  if (path === "/logo.svg" || path.startsWith("/icons/")) return true;
  // Diseño compartido (hoja de estilos, tipografías e íconos): no contiene datos. Solo nombres
  // simples, sin ".." ni caracteres codificados, para que no sirva de atajo a otras páginas.
  if (/^\/assets\/[A-Za-z0-9_\-./]+$/.test(path) && !path.includes("..")) return true;
  if (path.startsWith("/api/auth/")) return true;
  if (path === "/llave-cdmx/autorizar") return true; // página simulada de Llave CDMX (demo)
  // Aprobación con passkey (enlace de un solo uso que llega por WhatsApp).
  if (path.startsWith("/aprobar/") || path === "/aprobar.html") return true;
  if (method === "GET" && (path === "/api/passkey/status" || path.startsWith("/api/proposal/"))) return true;
  if (method === "POST" && (path === "/api/approve/options" || path === "/api/approve/verify")) return true;
  return false;
}

// ---------- servicio ----------

export interface PortalAccount {
  id: string;
  name: string;
  phone: string;
}

export class PortalAuth {
  constructor(private readonly o: AuthOpts) {}

  async accountFromRequest(req: FastifyRequest): Promise<PortalAccount | null> {
    const token = readCookie(req.headers.cookie, SESSION_COOKIE);
    if (!token || token.length > 200) return null;
    const [row] = await this.o.db
      .select({ id: schema.portalAccounts.id, name: schema.portalAccounts.name, phone: schema.portalAccounts.phone, expiresAt: schema.portalSessions.expiresAt })
      .from(schema.portalSessions)
      .innerJoin(schema.portalAccounts, eq(schema.portalAccounts.id, schema.portalSessions.accountId))
      .where(and(eq(schema.portalSessions.tokenHash, sha256(token)), eq(schema.portalAccounts.merchantId, this.o.merchantId)));
    if (!row || row.expiresAt <= this.o.now()) return null;
    return { id: row.id, name: row.name, phone: row.phone };
  }

  private async startSession(reply: FastifyReply, accountId: string): Promise<void> {
    const token = randomBytes(32).toString("base64url");
    const now = this.o.now();
    // Limpieza de paso: sesiones vencidas de esta cuenta.
    await this.o.db.delete(schema.portalSessions).where(and(eq(schema.portalSessions.accountId, accountId), lt(schema.portalSessions.expiresAt, now)));
    await this.o.db.insert(schema.portalSessions).values({
      tokenHash: sha256(token),
      accountId,
      expiresAt: new Date(now.getTime() + SESSION_DAYS * 86_400_000),
    });
    reply.header("Set-Cookie", this.cookie(token, SESSION_DAYS * 86_400));
  }

  private cookie(value: string, maxAge: number): string {
    return `${SESSION_COOKIE}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${this.o.secureCookies ? "; Secure" : ""}`;
  }

  register(app: FastifyInstance, json: (raw: unknown) => unknown): void {
    const o = this.o;
    const Register = z.object({ name: z.string().max(200), phone: z.string().max(40), pin: z.string().max(10), shop_code: z.string().max(100).optional() });
    const Login = z.object({ phone: z.string().max(40), pin: z.string().max(10) });

    app.get("/api/auth/me", async (req, reply) => {
      const a = await this.accountFromRequest(req);
      const flags = { needs_shop_code: o.shopCode !== null, llave: o.llave };
      if (!a) return reply.code(401).send({ error: "Sin sesión", ...flags });
      return { account: { name: a.name, phone_last4: a.phone.slice(-4) }, ...flags };
    });

    app.post("/api/auth/register", async (req, reply) => {
      const b = Register.safeParse(json(req.body));
      if (!b.success) return reply.code(400).send({ error: "Faltan datos." });
      const name = cleanName(b.data.name);
      if (!name) return reply.code(400).send({ field: "name", error: "Escribe tu nombre." });
      const phone = normalizePhone(b.data.phone);
      if (!phone) return reply.code(400).send({ field: "phone", error: "El celular debe tener 10 números." });
      if (o.shopCode !== null && !sameSecret((b.data.shop_code ?? "").trim(), o.shopCode)) {
        return reply.code(403).send({ field: "shop_code", error: "Ese código de la tienda no es correcto. Pídeselo al dueño." });
      }
      const bad = pinProblem(b.data.pin);
      if (bad) return reply.code(400).send({ field: "pin", error: bad });
      const [exists] = await o.db
        .select({ id: schema.portalAccounts.id })
        .from(schema.portalAccounts)
        .where(and(eq(schema.portalAccounts.merchantId, o.merchantId), eq(schema.portalAccounts.phone, phone)));
      if (exists) return reply.code(409).send({ field: "phone", error: "Ese celular ya está registrado. Mejor entra con tu NIP." });
      const id = randomUUID();
      await o.db.insert(schema.portalAccounts).values({ id, merchantId: o.merchantId, name, phone, pinHash: await hashPin(b.data.pin) });
      await this.startSession(reply, id);
      return { ok: true, account: { name, phone_last4: phone.slice(-4) } };
    });

    app.post("/api/auth/login", async (req, reply) => {
      const b = Login.safeParse(json(req.body));
      const phone = b.success ? normalizePhone(b.data.phone) : null;
      if (!b.success || !phone) return reply.code(400).send({ field: "phone", error: "El celular debe tener 10 números." });
      const [acc] = await o.db
        .select()
        .from(schema.portalAccounts)
        .where(and(eq(schema.portalAccounts.merchantId, o.merchantId), eq(schema.portalAccounts.phone, phone)));
      if (!acc) return reply.code(404).send({ field: "phone", error: "No encontramos ese celular. ¿Quieres registrarte?" });
      const now = o.now();
      if (acc.lockedUntil && acc.lockedUntil > now) {
        const mins = Math.ceil((acc.lockedUntil.getTime() - now.getTime()) / 60_000);
        return reply.code(429).send({ field: "pin", error: `Por seguridad, espera ${mins} minuto${mins === 1 ? "" : "s"} y vuelve a intentar.` });
      }
      if (!acc.pinHash) {
        return reply.code(409).send({ field: "phone", error: "Esa cuenta entra con Llave CDMX. Usa el botón “Entrar con Llave CDMX”." });
      }
      if (!(await verifyPin(b.data.pin, acc.pinHash))) {
        const failed = acc.failedAttempts + 1;
        const lock = failed >= MAX_FAILED;
        await o.db
          .update(schema.portalAccounts)
          .set({ failedAttempts: lock ? 0 : failed, lockedUntil: lock ? new Date(now.getTime() + LOCK_MINUTES * 60_000) : null })
          .where(eq(schema.portalAccounts.id, acc.id));
        const left = MAX_FAILED - failed;
        return reply.code(401).send({
          field: "pin",
          error: lock
            ? `NIP equivocado. Por seguridad, espera ${LOCK_MINUTES} minutos y vuelve a intentar.`
            : `NIP equivocado. Te quedan ${left} intento${left === 1 ? "" : "s"}.`,
        });
      }
      await o.db.update(schema.portalAccounts).set({ failedAttempts: 0, lockedUntil: null }).where(eq(schema.portalAccounts.id, acc.id));
      await this.startSession(reply, acc.id);
      return { ok: true, account: { name: acc.name, phone_last4: acc.phone.slice(-4) } };
    });

    // ---------- Llave CDMX (demo) ----------
    // Imita el flujo OAuth: start → página de la Llave (aquí simulada) → regreso con `state`.
    // La integración real requiere dar de alta la app con la ADIP (client_id y endpoints oficiales);
    // hasta entonces solo existe este modo demo, que se identifica como tal en todas partes.
    const states = new Map<string, number>();
    const STATE_TTL_MS = 10 * 60_000;
    const LlaveDemo = z.object({
      state: z.string().max(100),
      name: z.string().max(200),
      curp: z.string().max(30),
      phone: z.string().max(40),
      shop_code: z.string().max(100).optional(),
    });

    app.get("/api/auth/llave/start", async (_req, reply) => {
      if (o.llave !== "demo") return reply.code(404).send({ error: "Llave CDMX no está disponible." });
      const now = Date.now();
      for (const [k, at] of states) if (now - at > STATE_TTL_MS) states.delete(k);
      if (states.size > 1000) return reply.code(429).send({ error: "Intenta en un momento." });
      const state = randomBytes(16).toString("base64url");
      states.set(state, now);
      return { url: `/llave-cdmx/autorizar?state=${state}`, demo: true };
    });

    app.get("/llave-cdmx/autorizar", (_req, reply) =>
      o.llave === "demo" ? reply.type("text/html; charset=utf-8").sendFile("llave-demo.html") : reply.code(404).send());

    app.post("/api/auth/llave/demo-callback", async (req, reply) => {
      if (o.llave !== "demo") return reply.code(404).send({ error: "Llave CDMX no está disponible." });
      const b = LlaveDemo.safeParse(json(req.body));
      if (!b.success) return reply.code(400).send({ error: "Faltan datos." });
      const at = states.get(b.data.state);
      if (at === undefined || Date.now() - at > STATE_TTL_MS) {
        return reply.code(400).send({ error: "El enlace venció. Regresa a Cuadra y vuelve a tocar “Entrar con Llave CDMX”." });
      }
      const name = cleanName(b.data.name);
      if (!name) return reply.code(400).send({ field: "name", error: "Escribe tu nombre." });
      const curp = normalizeCurp(b.data.curp);
      if (!curp) return reply.code(400).send({ field: "curp", error: "La CURP no tiene el formato correcto (18 caracteres)." });
      const phone = normalizePhone(b.data.phone);
      if (!phone) return reply.code(400).send({ field: "phone", error: "El celular debe tener 10 números." });
      const sub = `demo:${sha256(curp)}`; // nunca se guarda la CURP

      const [linked] = await o.db
        .select()
        .from(schema.portalAccounts)
        .where(and(eq(schema.portalAccounts.merchantId, o.merchantId), eq(schema.portalAccounts.llaveSub, sub)));
      if (linked) {
        states.delete(b.data.state);
        await this.startSession(reply, linked.id);
        return { ok: true, account: { name: linked.name, phone_last4: linked.phone.slice(-4) } };
      }
      // Cuenta nueva: mismas reglas que el registro con NIP.
      if (o.shopCode !== null && !sameSecret((b.data.shop_code ?? "").trim(), o.shopCode)) {
        return reply.code(403).send({ field: "shop_code", error: "Ese código de la tienda no es correcto. Pídeselo al dueño." });
      }
      const [byPhone] = await o.db
        .select({ id: schema.portalAccounts.id })
        .from(schema.portalAccounts)
        .where(and(eq(schema.portalAccounts.merchantId, o.merchantId), eq(schema.portalAccounts.phone, phone)));
      // No se liga una Llave a una cuenta existente sin su NIP (evita que alguien entre a la cuenta de otro).
      if (byPhone) return reply.code(409).send({ field: "phone", error: "Ese celular ya tiene cuenta en Cuadra. Entra con tu NIP." });
      states.delete(b.data.state);
      const id = randomUUID();
      await o.db.insert(schema.portalAccounts).values({ id, merchantId: o.merchantId, name, phone, pinHash: null, llaveSub: sub });
      await this.startSession(reply, id);
      return { ok: true, account: { name, phone_last4: phone.slice(-4) } };
    });

    app.post("/api/auth/logout", async (req, reply) => {
      const token = readCookie(req.headers.cookie, SESSION_COOKIE);
      if (token) await o.db.delete(schema.portalSessions).where(eq(schema.portalSessions.tokenHash, sha256(token)));
      reply.header("Set-Cookie", this.cookie("", 0));
      return { ok: true };
    });
  }

  /** Hook: sin sesión, las páginas mandan a /login y la API responde 401. */
  async guard(req: FastifyRequest, reply: FastifyReply): Promise<FastifyReply | undefined> {
    const path = req.url.split("?")[0] ?? "";
    if (isPublicPath(path, req.method)) return undefined;
    if (await this.accountFromRequest(req)) return undefined;
    if (req.method === "GET" && !path.startsWith("/api/")) {
      return reply.redirect(`/login?next=${encodeURIComponent(path)}`, 302);
    }
    return reply.code(401).send({ error: "Entra a tu cuenta para continuar." });
  }
}
