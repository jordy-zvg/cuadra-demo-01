import { createHash, randomBytes, randomInt, randomUUID, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { Db } from "@cuadra/db";
import { realPhone10, schema, storeForPerson } from "@cuadra/db";
import { and, eq, gt, gte, isNotNull, isNull, lt, lte, or, sql } from "drizzle-orm";

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
  /** Si existe, registrarse pide este código de la tienda (lo da el dueño). */
  shopCode: string | null;
  /** Cookie con Secure (en producción, detrás de HTTPS). */
  secureCookies: boolean;
  /** "demo": Llave CDMX simulada (página propia marcada como prueba). "off": sin botón. */
  llave: "demo" | "off";
  /**
   * Verificación del celular antes de entrar a la libreta. "whatsapp": Cuadra manda un código por
   * WhatsApp (`sendCode`) y la persona lo escribe en el portal; si no se puede mandar, ella manda
   * desde su celular el código que le muestra el portal (respaldo). "off" (sin WhatsApp: pruebas y
   * desarrollo) da la cuenta por verificada. `waNumber`: número de Cuadra en WhatsApp (solo dígitos,
   * con lada de país) para el enlace wa.me del respaldo.
   */
  verification?: {
    mode: "whatsapp" | "off";
    waNumber: string | null;
    /** Manda el código al celular (10 dígitos). Si no existe o lanza error, se usa el respaldo. */
    sendCode?: (phone10: string, code: string) => Promise<void>;
  };
  /** Log JSON del servidor (sin secretos, sin el código y sin el celular completo). */
  log?: (r: Record<string, unknown>) => void;
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
  if (path === "/" || path === "/health" || path === "/privacidad" || path.startsWith("/webhooks/")) return true; // "/" = landing
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
  /** La tienda (libreta) de esta persona. Cada cuenta ve solo la suya. */
  merchantId: string;
  /** Ya probó por WhatsApp que el celular es suyo (o la verificación está apagada). */
  verified: boolean;
}

/** Respaldo (la persona manda el código desde su celular): vigencia y espera mínima para pedir otro. */
export const VERIFY_CODE_TTL_MS = 15 * 60_000;
const VERIFY_RESEND_MS = 20_000;

/**
 * Código que manda Cuadra por WhatsApp: vence en 10 minutos (lo mismo que dice la plantilla
 * cuadra_codigo), admite 5 intentos, se puede reenviar cada minuto y a lo más 5 veces por hora al
 * mismo celular.
 */
export const PHONE_CODE_TTL_MS = 10 * 60_000;
export const PHONE_CODE_MAX_ATTEMPTS = 5;
export const PHONE_CODE_RESEND_MS = 60_000;
export const PHONE_CODE_MAX_PER_HOUR = 5;
/** Si WhatsApp rechazó el envío (plantilla sin aprobar, número fuera de la lista de prueba), durante
 * este tiempo la cuenta usa directo el respaldo, sin volver a llamar a Meta en cada recarga. */
export const PHONE_CODE_FAIL_BACKOFF_MS = 10 * 60_000;

/** Texto que la persona manda por WhatsApp (el enlace wa.me ya lo trae escrito). */
export const verifyMessage = (code: string) => `Mi código de Cuadra es ${code}`;

/**
 * Un mensaje de WhatsApp que llega del celular `phone10` con el código vigente de su cuenta la
 * verifica: el celular es de quien tiene la cuenta. También verifica al dueño de su tienda (mismo
 * celular), para que Cuadra le conteste por WhatsApp. Devuelve el nombre si verificó.
 */
export async function verifyPhoneByWhatsApp(db: Db, phone10: string, text: string, now: Date): Promise<{ name: string } | null> {
  const m = /(?:^|\D)(\d{6})(?:\D|$)/.exec(text);
  if (!m) return null;
  const [acc] = await db.select().from(schema.portalAccounts).where(eq(schema.portalAccounts.phone, phone10));
  if (!acc || acc.phoneVerifiedAt || !acc.verifyCodeHash || !acc.verifyExpiresAt || acc.verifyExpiresAt <= now) return null;
  if (!sameSecret(sha256(m[1]!), acc.verifyCodeHash)) return null;
  await markPhoneVerified(db, acc, now);
  return { name: acc.name };
}

/**
 * Deja la cuenta verificada y borra sus códigos (los de los dos caminos). También verifica al dueño
 * de su tienda si es el mismo celular, para que Cuadra le conteste por WhatsApp.
 */
async function markPhoneVerified(db: Db, acc: { id: string; merchantId: string; phone: string }, now: Date): Promise<void> {
  await db
    .update(schema.portalAccounts)
    .set({ phoneVerifiedAt: now, verifyCodeHash: null, verifyExpiresAt: null, otpHash: null, otpExpiresAt: null, otpAttempts: 0 })
    .where(eq(schema.portalAccounts.id, acc.id));
  const owners = await db
    .select({ id: schema.merchantUsers.id, phone: schema.merchantUsers.phone })
    .from(schema.merchantUsers)
    .where(and(eq(schema.merchantUsers.merchantId, acc.merchantId), eq(schema.merchantUsers.role, "comercio")));
  for (const o of owners) {
    if (realPhone10(o.phone) === acc.phone) await db.update(schema.merchantUsers).set({ phoneVerified: true }).where(eq(schema.merchantUsers.id, o.id));
  }
}

export class PortalAuth {
  /** Cuenta ya verificada por el guard en esta petición (evita leer la sesión dos veces). */
  private readonly seen = new WeakMap<FastifyRequest, PortalAccount>();
  private readonly mode: "whatsapp" | "off";
  constructor(private readonly o: AuthOpts) {
    this.mode = o.verification?.mode ?? "off";
  }

  /** Con la verificación apagada, toda cuenta cuenta como verificada. */
  private isVerified(phoneVerifiedAt: Date | null): boolean {
    return this.mode === "off" || phoneVerifiedAt !== null;
  }

  async accountFromRequest(req: FastifyRequest): Promise<PortalAccount | null> {
    const cached = this.seen.get(req);
    if (cached) return cached;
    const token = readCookie(req.headers.cookie, SESSION_COOKIE);
    if (!token || token.length > 200) return null;
    const [row] = await this.o.db
      .select({
        id: schema.portalAccounts.id,
        name: schema.portalAccounts.name,
        phone: schema.portalAccounts.phone,
        merchantId: schema.portalAccounts.merchantId,
        phoneVerifiedAt: schema.portalAccounts.phoneVerifiedAt,
        expiresAt: schema.portalSessions.expiresAt,
      })
      .from(schema.portalSessions)
      .innerJoin(schema.portalAccounts, eq(schema.portalAccounts.id, schema.portalSessions.accountId))
      .where(eq(schema.portalSessions.tokenHash, sha256(token)));
    if (!row || row.expiresAt <= this.o.now()) return null;
    const account = { id: row.id, name: row.name, phone: row.phone, merchantId: row.merchantId, verified: this.isVerified(row.phoneVerifiedAt) };
    this.seen.set(req, account);
    return account;
  }

  /**
   * ¿Se puede registrar este celular? Si ya hay una cuenta verificada, no. Si hay una sin verificar
   * (alguien se registró con ese número y nunca lo probó), se borra: gana quien demuestre tenerlo.
   */
  private async phoneAvailable(phone: string): Promise<boolean> {
    const [acc] = await this.o.db.select().from(schema.portalAccounts).where(eq(schema.portalAccounts.phone, phone));
    if (!acc) return true;
    if (this.isVerified(acc.phoneVerifiedAt)) return false;
    await this.o.db.delete(schema.portalAccounts).where(and(eq(schema.portalAccounts.id, acc.id), isNull(schema.portalAccounts.phoneVerifiedAt)));
    return true;
  }

  /** Tienda de la persona: la que ya tiene por su celular (p. ej. el dueño de la demo) o una nueva. */
  private storeFor(name: string, phone: string): Promise<{ merchantId: string }> {
    return storeForPerson(this.o.db, { ownerName: name, phone10: phone, now: this.o.now() });
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

  /**
   * Manda (o deja vigente) el código por WhatsApp. "ok": hay un código en camino. "wait": pidió
   * reenviar antes de tiempo. "limit": ya van PHONE_CODE_MAX_PER_HOUR envíos a ese celular en la última
   * hora. "not_sent": no hay cómo mandarlo (sin WhatsApp, número no válido o Meta lo rechazó).
   */
  private async codeToPhone(
    a: PortalAccount,
    now: Date,
    resend: boolean,
  ): Promise<{ kind: "ok"; expiresAt: Date; resendInS: number } | { kind: "wait"; retryAfterS: number } | { kind: "limit" | "not_sent" }> {
    const send = this.o.verification?.sendCode;
    const phone = realPhone10(a.phone);
    if (!send || !phone) return { kind: "not_sent" };
    const A = schema.portalAccounts;
    const [row] = await this.o.db
      .select({ hash: A.otpHash, expiresAt: A.otpExpiresAt, attempts: A.otpAttempts, sentAt: A.otpSentAt, failedAt: A.otpFailedAt })
      .from(A)
      .where(eq(A.id, a.id));
    if (row?.failedAt && now.getTime() - row.failedAt.getTime() < PHONE_CODE_FAIL_BACKOFF_MS) return { kind: "not_sent" };
    const waitS = row?.sentAt ? Math.max(0, Math.ceil((row.sentAt.getTime() + PHONE_CODE_RESEND_MS - now.getTime()) / 1000)) : 0;
    const live = Boolean(row?.hash && row.expiresAt && row.expiresAt > now && row.attempts < PHONE_CODE_MAX_ATTEMPTS);
    // Ya va uno en camino y no pidió otro: se usa ese (no se manda otro mensaje).
    if (live && !resend) return { kind: "ok", expiresAt: row!.expiresAt!, resendInS: waitS };
    if (waitS > 0) return { kind: "wait", retryAfterS: waitS };
    const S = schema.phoneCodeSends;
    const [count] = await this.o.db
      .select({ n: sql<number>`count(*)::int` })
      .from(S)
      .where(and(eq(S.phone, a.phone), gte(S.sentAt, new Date(now.getTime() - 3_600_000))));
    if ((count?.n ?? 0) >= PHONE_CODE_MAX_PER_HOUR) {
      this.o.log?.({ msg: "phone_code_limit", merchant_id: a.merchantId, account_id: a.id });
      return { kind: "limit" };
    }
    const code = String(randomInt(100_000, 1_000_000));
    const expiresAt = new Date(now.getTime() + PHONE_CODE_TTL_MS);
    // Se guarda antes de mandarlo (sirve en cuanto llegue) y deja sin valor al anterior.
    await this.o.db.update(A).set({ otpHash: sha256(code), otpExpiresAt: expiresAt, otpAttempts: 0 }).where(eq(A.id, a.id));
    try {
      await send(phone, code);
    } catch (e) {
      // No salió: ese código no sirve y el portal pasa al respaldo. No cuenta para el tope por hora.
      await this.o.db.update(A).set({ otpHash: null, otpExpiresAt: null, otpFailedAt: now }).where(eq(A.id, a.id));
      const meta = (e as { code?: unknown } | null)?.code;
      this.o.log?.({ msg: "phone_code_not_sent", merchant_id: a.merchantId, account_id: a.id, code: typeof meta === "number" ? meta : null });
      return { kind: "not_sent" };
    }
    // Salió: cuenta para el tope por hora y para la espera de reenvío.
    await this.o.db.update(A).set({ otpSentAt: now, otpFailedAt: null }).where(eq(A.id, a.id));
    await this.o.db.insert(S).values({ phone: a.phone, sentAt: now });
    this.o.log?.({ msg: "phone_code_sent", merchant_id: a.merchantId, account_id: a.id });
    return { kind: "ok", expiresAt, resendInS: Math.round(PHONE_CODE_RESEND_MS / 1000) };
  }

  /** Respaldo: un código que la persona manda desde su celular por WhatsApp (enlace wa.me ya escrito). */
  private async codeFromPhone(a: PortalAccount, now: Date, reply: FastifyReply, reason: "limit" | "not_sent" | null) {
    const [row] = await this.o.db
      .select({ expiresAt: schema.portalAccounts.verifyExpiresAt })
      .from(schema.portalAccounts)
      .where(eq(schema.portalAccounts.id, a.id));
    if (row?.expiresAt && row.expiresAt.getTime() - VERIFY_CODE_TTL_MS + VERIFY_RESEND_MS > now.getTime()) {
      return reply.code(429).send({ error: "Espera unos segundos para pedir otro código." });
    }
    const code = String(randomInt(100_000, 1_000_000));
    const expiresAt = new Date(now.getTime() + VERIFY_CODE_TTL_MS);
    await this.o.db.update(schema.portalAccounts).set({ verifyCodeHash: sha256(code), verifyExpiresAt: expiresAt }).where(eq(schema.portalAccounts.id, a.id));
    const number = this.o.verification?.waNumber ?? null;
    return {
      verified: false,
      method: "code_from_phone" as const,
      ...(reason ? { reason } : {}),
      code,
      message: verifyMessage(code),
      number,
      link: number ? `https://wa.me/${number}?text=${encodeURIComponent(verifyMessage(code))}` : null,
      expires_at: expiresAt.toISOString(),
    };
  }

  register(app: FastifyInstance, json: (raw: unknown) => unknown): void {
    const o = this.o;
    const Register = z.object({ name: z.string().max(200), phone: z.string().max(40), pin: z.string().max(10), shop_code: z.string().max(100).optional() });
    const Login = z.object({ phone: z.string().max(40), pin: z.string().max(10) });

    app.get("/api/auth/me", async (req, reply) => {
      const a = await this.accountFromRequest(req);
      const flags = { needs_shop_code: o.shopCode !== null, llave: o.llave, verification: this.mode };
      if (!a) return reply.code(401).send({ error: "Sin sesión", ...flags });
      return { account: { name: a.name, phone_last4: a.phone.slice(-4), verified: a.verified }, ...flags };
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
      // El celular identifica a la persona en todo Cuadra: una sola cuenta por celular.
      if (!(await this.phoneAvailable(phone))) return reply.code(409).send({ field: "phone", error: "Ese celular ya está registrado. Mejor entra con tu NIP." });
      const id = randomUUID();
      const store = await this.storeFor(name, phone);
      await o.db.insert(schema.portalAccounts).values({
        id, merchantId: store.merchantId, name, phone, pinHash: await hashPin(b.data.pin), ...(this.mode === "off" ? { phoneVerifiedAt: o.now() } : {}),
      });
      await this.startSession(reply, id);
      return { ok: true, account: { name, phone_last4: phone.slice(-4), verified: this.mode === "off" } };
    });

    app.post("/api/auth/login", async (req, reply) => {
      const b = Login.safeParse(json(req.body));
      const phone = b.success ? normalizePhone(b.data.phone) : null;
      if (!b.success || !phone) return reply.code(400).send({ field: "phone", error: "El celular debe tener 10 números." });
      const [acc] = await o.db.select().from(schema.portalAccounts).where(eq(schema.portalAccounts.phone, phone));
      if (!acc) return reply.code(404).send({ field: "phone", error: "No encontramos ese celular. ¿Quieres registrarte?" });
      if (!acc.pinHash) {
        return reply.code(409).send({ field: "phone", error: "Esa cuenta entra con Llave CDMX. Usa el botón “Entrar con Llave CDMX”." });
      }
      const now = o.now();
      const lockMsg = (until: Date) => {
        const mins = Math.max(1, Math.ceil((until.getTime() - now.getTime()) / 60_000));
        return `Por seguridad, espera ${mins} minuto${mins === 1 ? "" : "s"} y vuelve a intentar.`;
      };
      // El intento se cuenta ANTES de revisar el NIP y en una sola sentencia: aunque lleguen muchos
      // intentos a la vez, nunca se revisan más de MAX_FAILED antes del bloqueo. El intento que llega
      // al tope bloquea de una vez; si ese NIP resulta correcto, se desbloquea abajo.
      const t = schema.portalAccounts;
      const lockAt = new Date(now.getTime() + LOCK_MINUTES * 60_000);
      const reaches = sql`${t.failedAttempts} + 1 >= ${MAX_FAILED}`;
      const [slot] = await o.db
        .update(t)
        .set({
          failedAttempts: sql`CASE WHEN ${reaches} THEN 0 ELSE ${t.failedAttempts} + 1 END`,
          lockedUntil: sql`CASE WHEN ${reaches} THEN ${lockAt.toISOString()}::timestamptz ELSE ${t.lockedUntil} END`,
        })
        .where(and(eq(t.id, acc.id), or(isNull(t.lockedUntil), lte(t.lockedUntil, now))))
        .returning({ failed: t.failedAttempts, lockedUntil: t.lockedUntil });
      if (!slot) {
        const [cur] = await o.db.select({ lockedUntil: t.lockedUntil }).from(t).where(eq(t.id, acc.id));
        return reply.code(429).send({ field: "pin", error: lockMsg(cur?.lockedUntil ?? lockAt) });
      }
      const locked = !!slot.lockedUntil && slot.lockedUntil > now;
      if (!(await verifyPin(b.data.pin, acc.pinHash))) {
        const left = MAX_FAILED - slot.failed;
        return reply.code(401).send({
          field: "pin",
          error: locked
            ? `NIP equivocado. Por seguridad, espera ${LOCK_MINUTES} minutos y vuelve a intentar.`
            : `NIP equivocado. Te quedan ${left} intento${left === 1 ? "" : "s"}.`,
        });
      }
      await o.db.update(t).set({ failedAttempts: 0, lockedUntil: null }).where(eq(t.id, acc.id));
      await this.startSession(reply, acc.id);
      return { ok: true, account: { name: acc.name, phone_last4: acc.phone.slice(-4), verified: this.isVerified(acc.phoneVerifiedAt) } };
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

      const [linked] = await o.db.select().from(schema.portalAccounts).where(eq(schema.portalAccounts.llaveSub, sub));
      if (linked) {
        // La Llave de demo no comprueba la identidad (una CURP no es secreta): el celular debe ser el
        // de la cuenta y, con verificación por WhatsApp, la persona vuelve a mandar el código desde
        // ese celular antes de ver su libreta.
        if (linked.phone !== phone) {
          return reply.code(403).send({ field: "phone", error: "Ese celular no es el de tu cuenta. Escribe el celular con el que te registraste." });
        }
        states.delete(b.data.state);
        let verifiedAt = linked.phoneVerifiedAt;
        if (this.mode === "whatsapp" && verifiedAt) {
          await o.db.update(schema.portalAccounts).set({ phoneVerifiedAt: null }).where(eq(schema.portalAccounts.id, linked.id));
          verifiedAt = null;
        }
        await this.startSession(reply, linked.id);
        return { ok: true, account: { name: linked.name, phone_last4: linked.phone.slice(-4), verified: this.isVerified(verifiedAt) } };
      }
      // Cuenta nueva: mismas reglas que el registro con NIP.
      if (o.shopCode !== null && !sameSecret((b.data.shop_code ?? "").trim(), o.shopCode)) {
        return reply.code(403).send({ field: "shop_code", error: "Ese código de la tienda no es correcto. Pídeselo al dueño." });
      }
      // No se liga una Llave a una cuenta existente sin su NIP (evita que alguien entre a la cuenta de otro).
      if (!(await this.phoneAvailable(phone))) return reply.code(409).send({ field: "phone", error: "Ese celular ya tiene cuenta en Cuadra. Entra con tu NIP." });
      states.delete(b.data.state);
      const id = randomUUID();
      const store = await this.storeFor(name, phone);
      await o.db.insert(schema.portalAccounts).values({
        id, merchantId: store.merchantId, name, phone, pinHash: null, llaveSub: sub, ...(this.mode === "off" ? { phoneVerifiedAt: o.now() } : {}),
      });
      await this.startSession(reply, id);
      return { ok: true, account: { name, phone_last4: phone.slice(-4), verified: this.mode === "off" } };
    });

    // ---------- verificación del celular ----------
    // Normal: Cuadra manda un código por WhatsApp (plantilla de autenticación) y la persona lo escribe
    // en el portal (/api/auth/verify/check). Respaldo, si WhatsApp no lo pudo entregar o ella lo pide:
    // el portal muestra un código y un enlace wa.me; ella lo manda desde su celular y el webhook de
    // WhatsApp verifica la cuenta (verifyPhoneByWhatsApp). Cada camino tiene su propio código.
    const StartBody = z.object({ method: z.enum(["code_to_phone", "code_from_phone"]).optional(), resend: z.boolean().optional() });
    app.post("/api/auth/verify/start", async (req, reply) => {
      const a = await this.accountFromRequest(req);
      if (!a) return reply.code(401).send({ error: "Entra a tu cuenta para continuar." });
      if (a.verified) return { verified: true };
      const parsed = StartBody.safeParse(json(req.body));
      const body = parsed.success ? parsed.data : {};
      const now = o.now();
      if (body.method !== "code_from_phone") {
        const sent = await this.codeToPhone(a, now, body.resend === true);
        const toPhone = { verified: false, method: "code_to_phone" as const, phone_last4: a.phone.slice(-4) };
        if (sent.kind === "ok") return { ...toPhone, expires_at: sent.expiresAt.toISOString(), resend_in_s: sent.resendInS };
        if (sent.kind === "wait") {
          return reply.code(429).send({ ...toPhone, error: "Espera un momento para pedir otro código.", retry_after_s: sent.retryAfterS });
        }
        // Sin forma de mandarlo (o ya van muchos envíos en la hora): sigue el respaldo, con el motivo.
        return this.codeFromPhone(a, now, reply, sent.kind);
      }
      return this.codeFromPhone(a, now, reply, null);
    });

    const CheckBody = z.object({ code: z.string().max(40) });
    app.post("/api/auth/verify/check", async (req, reply) => {
      const a = await this.accountFromRequest(req);
      if (!a) return reply.code(401).send({ error: "Entra a tu cuenta para continuar." });
      if (a.verified) return { verified: true };
      const parsed = CheckBody.safeParse(json(req.body));
      const code = parsed.success ? parsed.data.code.replace(/\D/g, "") : "";
      if (code.length !== 6) return reply.code(400).send({ error: "Escribe los 6 números del código.", reason: "format" });
      const now = o.now();
      // Primero se gasta un intento y luego se compara. El UPDATE es atómico: aunque lleguen varias
      // peticiones a la vez, nunca se comparan más de PHONE_CODE_MAX_ATTEMPTS por código.
      const A = schema.portalAccounts;
      const [row] = await o.db
        .update(A)
        .set({ otpAttempts: sql`${A.otpAttempts} + 1` })
        .where(and(eq(A.id, a.id), isNotNull(A.otpHash), gt(A.otpExpiresAt, now), lt(A.otpAttempts, PHONE_CODE_MAX_ATTEMPTS)))
        .returning({ hash: A.otpHash, attempts: A.otpAttempts });
      if (!row?.hash) {
        const [cur] = await o.db.select({ hash: A.otpHash, expiresAt: A.otpExpiresAt }).from(A).where(eq(A.id, a.id));
        const reason = !cur?.hash ? "none" : cur.expiresAt && cur.expiresAt <= now ? "expired" : "locked";
        const error =
          reason === "locked" ? "Ya usaste los 5 intentos. Pide un código nuevo." : reason === "expired" ? "Ese código ya venció. Pide uno nuevo." : "Pide un código nuevo.";
        return reply.code(410).send({ error, reason });
      }
      if (!sameSecret(sha256(code), row.hash)) {
        const left = Math.max(0, PHONE_CODE_MAX_ATTEMPTS - row.attempts);
        const error =
          left === 0
            ? "Ese código no es y ya usaste los 5 intentos. Pide un código nuevo."
            : `Ese código no es. Te ${left === 1 ? "queda 1 intento" : `quedan ${left} intentos`}.`;
        return reply.code(400).send({ error, reason: "wrong", attempts_left: left });
      }
      await markPhoneVerified(o.db, a, now);
      o.log?.({ msg: "phone_verified", merchant_id: a.merchantId, account_id: a.id, method: "code_to_phone" });
      return { verified: true };
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
    const account = await this.accountFromRequest(req);
    if (account?.verified) return undefined;
    if (req.method === "GET" && !path.startsWith("/api/")) {
      return reply.redirect(`/login?next=${encodeURIComponent(path)}`, 302);
    }
    // Con sesión pero sin verificar el celular: nada de la libreta, ni "Lo que debo", hasta probarlo.
    if (account) return reply.code(403).send({ error: "Verifica tu celular por WhatsApp para continuar.", needs_verification: true });
    return reply.code(401).send({ error: "Entra a tu cuenta para continuar." });
  }
}
