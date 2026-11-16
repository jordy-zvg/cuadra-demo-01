import { createHash, randomBytes, randomInt, randomUUID, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { Db } from "@cuadra/db";
import { realPhone10, schema, storeForPerson } from "@cuadra/db";
import { and, desc, eq, gt, isNotNull, isNull, lt, lte, notInArray, or, sql } from "drizzle-orm";

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
    /** Intentos de envío al día en todo Cuadra (por omisión PHONE_CODE_DAILY_BUDGET). */
    dailyBudget?: number;
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
  if (path === "/logo.svg" || path === "/favicon.ico" || path.startsWith("/icons/")) return true;
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
  /** Hash del token de la sesión de esta petición (nunca el token). */
  session: string;
}

/** Respaldo (la persona manda el código desde su celular): vigencia y espera mínima para pedir otro. */
export const VERIFY_CODE_TTL_MS = 15 * 60_000;
const VERIFY_RESEND_MS = 20_000;

/**
 * Código que manda Cuadra por WhatsApp: vence en 10 minutos (lo mismo que dice la plantilla
 * cuadra_codigo) y admite 5 intentos. Solo se puede escribir después de que WhatsApp lo aceptó.
 * Los topes van por celular, no por cuenta (registrarse de nuevo no los reinicia), y cuentan todos los
 * intentos de envío, también los que Meta rechaza:
 * - un envío a la vez y el siguiente hasta después de un minuto;
 * - a lo más 5 por hora y 10 al día;
 * - si Meta rechazó el último (plantilla sin aprobar, número fuera de la lista de prueba), 10 minutos
 *   directo al respaldo, sin volver a llamar a Meta en cada recarga;
 * - con 10 códigos equivocados en 24 horas, ese celular ya no recibe códigos: queda el respaldo, que
 *   exige escribir desde su WhatsApp.
 * Además, en todo Cuadra a lo más PHONE_CODE_DAILY_BUDGET intentos al día (costo de Meta y reputación
 * del número de WhatsApp, que también manda cobros y recordatorios); después, también el respaldo.
 */
export const PHONE_CODE_TTL_MS = 10 * 60_000;
export const PHONE_CODE_MAX_ATTEMPTS = 5;
export const PHONE_CODE_RESEND_MS = 60_000;
export const PHONE_CODE_MAX_PER_HOUR = 5;
export const PHONE_CODE_MAX_PER_DAY = 10;
export const PHONE_CODE_FAIL_BACKOFF_MS = 10 * 60_000;
export const PHONE_CODE_MAX_MISSES_PER_DAY = 10;
export const PHONE_CODE_DAILY_BUDGET = 200;
/** Un intento que sigue en "pending" después de esto se da por perdido (p. ej. se reinició el proceso
 * mientras Meta contestaba; WhatsApp corta la llamada a los 15 s). */
const PHONE_CODE_PENDING_STALE_MS = 2 * 60_000;
const DAY_MS = 86_400_000;

/** Por qué se usa el respaldo en lugar de mandar el código: no salió, ya van muchos o muchos equivocados. */
type FallbackReason = "not_sent" | "limit" | "locked";
type SendState = { kind: "go" } | { kind: "wait"; retryAfterS: number } | { kind: "fallback"; reason: FallbackReason; log?: string };
type ToPhone = { kind: "ok"; expiresAt: Date; resendInS: number } | { kind: "wait"; retryAfterS: number } | { kind: "fallback"; reason: FallbackReason };
/** Respuesta de /api/auth/verify/start (la misma para dos peticiones de la misma cuenta a la vez). */
type StartRes = { status: number; body: Record<string, unknown> };

/** Texto que la persona manda por WhatsApp (el enlace wa.me ya lo trae escrito). */
export const verifyMessage = (code: string) => `Mi código de Cuadra es ${code}`;

/**
 * Un mensaje de WhatsApp que llega del celular `phone10` con el código vigente de una sesión de su cuenta
 * la verifica: el celular es de quien tiene esa sesión. Las demás sesiones de la cuenta se cierran (ver
 * markPhoneVerified). También verifica al dueño de su tienda (mismo celular), para que Cuadra le conteste
 * por WhatsApp. Devuelve el nombre si verificó.
 */
export async function verifyPhoneByWhatsApp(db: Db, phone10: string, text: string, now: Date): Promise<{ name: string } | null> {
  const m = /(?:^|\D)(\d{6})(?:\D|$)/.exec(text);
  if (!m) return null;
  const [acc] = await db.select().from(schema.portalAccounts).where(eq(schema.portalAccounts.phone, phone10));
  if (!acc || acc.phoneVerifiedAt) return null;
  const S = schema.portalSessions;
  const pending = await db
    .select({ tokenHash: S.tokenHash, hash: S.verifyCodeHash })
    .from(S)
    .where(and(eq(S.accountId, acc.id), isNotNull(S.verifyCodeHash), gt(S.verifyExpiresAt, now), gt(S.expiresAt, now)));
  const got = sha256(m[1]!);
  const [first, ...rest] = pending.filter((p) => p.hash !== null && sameSecret(got, p.hash)).map((p) => p.tokenHash);
  if (!first) return null;
  await markPhoneVerified(db, acc, now, [first, ...rest]);
  return { name: acc.name };
}

/** Códigos equivocados de este celular en las últimas 24 horas. */
async function missesToday(db: Db, phone: string, now: Date): Promise<number> {
  const M = schema.phoneCodeMisses;
  const [r] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(M)
    .where(and(eq(M.phone, phone), gt(M.missedAt, new Date(now.getTime() - DAY_MS))));
  return r?.n ?? 0;
}

/** Candado por celular (7001: espacio de candados del código; no choca con los de otras partes). */
const lockPhone = (tx: Db, phone: string) => tx.execute(sql`SELECT pg_advisory_xact_lock(7001, hashtext(${phone}))`);

/**
 * Deja la cuenta verificada, borra sus códigos y cierra las demás sesiones: solo siguen abiertas las que
 * comprobaron el celular (`keep`). Así, una sesión abierta por otra persona (p. ej. con la Llave CDMX de
 * demo, que no comprueba identidad) no queda verificada cuando la dueña comprueba su celular.
 * También verifica al dueño de su tienda si es el mismo celular, para que Cuadra le conteste por WhatsApp.
 */
async function markPhoneVerified(db: Db, acc: { id: string; merchantId: string; phone: string }, now: Date, keep: [string, ...string[]]): Promise<void> {
  await db
    .update(schema.portalAccounts)
    .set({ phoneVerifiedAt: now, otpHash: null, otpExpiresAt: null, otpAttempts: 0 })
    .where(eq(schema.portalAccounts.id, acc.id));
  const S = schema.portalSessions;
  await db.delete(S).where(and(eq(S.accountId, acc.id), notInArray(S.tokenHash, keep)));
  await db.update(S).set({ verifyCodeHash: null, verifyExpiresAt: null }).where(eq(S.accountId, acc.id));
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
    const account = {
      id: row.id, name: row.name, phone: row.phone, merchantId: row.merchantId, verified: this.isVerified(row.phoneVerifiedAt), session: sha256(token),
    };
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
   * Peticiones de «mándame el código» en curso por SESIÓN (en este proceso). Si llega otra de la misma
   * sesión mientras Meta contesta (otra pestaña del mismo navegador, una recarga), espera y recibe la
   * misma respuesta: no se manda otro mensaje, no se dice «te lo mandamos» antes de saberlo y, si toca el
   * respaldo, las dos pantallas muestran el mismo código. Por sesión y no por cuenta: el código del
   * respaldo es de la sesión que lo pidió y nunca se le entrega a otra. Entre sesiones y procesos, el
   * candado de claimSend.
   */
  private readonly starting = new Map<string, Promise<StartRes>>();

  private async once(session: string, run: () => Promise<StartRes>): Promise<StartRes> {
    const busy = this.starting.get(session);
    if (busy) return busy;
    const job = run(); // entre get y set no hay await: dos peticiones de este proceso nunca empiezan juntas
    this.starting.set(session, job);
    try {
      return await job;
    } finally {
      if (this.starting.get(session) === job) this.starting.delete(session);
    }
  }

  private async startToPhone(a: PortalAccount, now: Date, resend: boolean): Promise<StartRes> {
    const sent = await this.codeToPhone(a, now, resend);
    const toPhone = { verified: false, method: "code_to_phone" as const, phone_last4: a.phone.slice(-4) };
    if (sent.kind === "ok") return { status: 200, body: { ...toPhone, expires_at: sent.expiresAt.toISOString(), resend_in_s: sent.resendInS } };
    if (sent.kind === "wait") {
      return { status: 429, body: { ...toPhone, error: "Espera un momento para pedir otro código.", retry_after_s: sent.retryAfterS } };
    }
    // Sin forma de mandarlo, ya van muchos envíos o muchos códigos equivocados: el respaldo, con el motivo.
    return this.codeFromPhone(a, now, sent.reason);
  }

  /**
   * Manda el código por WhatsApp o deja vigente el que ya tiene. "ok": hay un código que WhatsApp
   * aceptó. "wait": todavía no se puede mandar otro. "fallback": se usa el respaldo, con el motivo.
   */
  private async codeToPhone(a: PortalAccount, now: Date, resend: boolean): Promise<ToPhone> {
    const send = this.o.verification?.sendCode;
    const phone10 = realPhone10(a.phone);
    if (!send || !phone10) return { kind: "fallback", reason: "not_sent" };
    const A = schema.portalAccounts;
    const [row] = await this.o.db.select({ hash: A.otpHash, expiresAt: A.otpExpiresAt, attempts: A.otpAttempts }).from(A).where(eq(A.id, a.id));
    // Ya tiene uno vigente y no pidió otro (volvió a la pantalla): se usa ese, sin mandar otro mensaje.
    if (!resend && row?.hash && row.expiresAt && row.expiresAt > now && row.attempts < PHONE_CODE_MAX_ATTEMPTS) {
      return { kind: "ok", expiresAt: row.expiresAt, resendInS: await this.resendWaitS(a.phone, now) };
    }
    const claim = await this.claimSend(a.phone, now);
    if (claim.kind === "claimed") return this.deliver(a, phone10, claim.id, send);
    if (claim.kind === "fallback") {
      if (claim.log) this.o.log?.({ msg: claim.log, merchant_id: a.merchantId, account_id: a.id });
      return { kind: "fallback", reason: claim.reason };
    }
    return claim;
  }

  /**
   * ¿Se puede intentar mandar un código a este celular ahora? Solo lee. Todo va por celular y con la
   * hora de cada intento (también los rechazados), así que registrarse de nuevo no cambia nada.
   */
  private async sendState(db: Db, phone: string, now: Date): Promise<SendState> {
    const S = schema.phoneCodeSends;
    const dayAgo = new Date(now.getTime() - DAY_MS);
    if ((await missesToday(db, phone, now)) >= PHONE_CODE_MAX_MISSES_PER_DAY) return { kind: "fallback", reason: "locked" };
    const tries = await db
      .select({ at: S.sentAt, status: S.status })
      .from(S)
      .where(and(eq(S.phone, phone), gt(S.sentAt, dayAgo)))
      .orderBy(desc(S.sentAt), desc(S.id));
    const last = tries[0];
    const age = last ? now.getTime() - last.at.getTime() : Number.POSITIVE_INFINITY;
    if (last?.status === "failed" && age < PHONE_CODE_FAIL_BACKOFF_MS) return { kind: "fallback", reason: "not_sent" };
    // Un minuto entre intentos (Meta contesta en menos de 15 s). Si pasado el minuto el último sigue «en
    // camino» (se reinició el proceso a medio envío), se espera hasta darlo por perdido.
    const waitMs =
      age < PHONE_CODE_RESEND_MS ? PHONE_CODE_RESEND_MS - age : last?.status === "pending" ? PHONE_CODE_PENDING_STALE_MS - age : 0;
    if (waitMs > 0) return { kind: "wait", retryAfterS: Math.ceil(waitMs / 1000) };
    const hourAgo = now.getTime() - 3_600_000;
    if (tries.filter((t) => t.at.getTime() > hourAgo).length >= PHONE_CODE_MAX_PER_HOUR || tries.length >= PHONE_CODE_MAX_PER_DAY) {
      return { kind: "fallback", reason: last?.status === "failed" ? "not_sent" : "limit", log: "phone_code_limit" };
    }
    // Presupuesto de todo Cuadra (sin candado global: con muchas peticiones a la vez se puede pasar por
    // unas cuantas; sirve para el costo y la reputación del número, no para la seguridad de una cuenta).
    const [all] = await db.select({ n: sql<number>`count(*)::int` }).from(S).where(gt(S.sentAt, dayAgo));
    if ((all?.n ?? 0) >= (this.o.verification?.dailyBudget ?? PHONE_CODE_DAILY_BUDGET)) {
      return { kind: "fallback", reason: "not_sent", log: "phone_code_budget" };
    }
    return { kind: "go" };
  }

  /**
   * Aparta un intento de envío ANTES de llamar a Meta. El candado por celular hace que dos peticiones
   * a la vez (dos pestañas, dos procesos, un script) no pasen juntas las revisiones de espera y topes.
   */
  private claimSend(phone: string, now: Date): Promise<{ kind: "claimed"; id: number } | Exclude<SendState, { kind: "go" }>> {
    return this.o.db.transaction(async (tx) => {
      await lockPhone(tx, phone);
      const st = await this.sendState(tx, phone, now);
      if (st.kind !== "go") return st;
      const [row] = await tx
        .insert(schema.phoneCodeSends)
        .values({ phone, sentAt: now, status: "pending" })
        .returning({ id: schema.phoneCodeSends.id });
      return { kind: "claimed" as const, id: row!.id };
    });
  }

  /** Llama a Meta. Solo si WhatsApp acepta el mensaje, el código queda guardado (y se puede escribir). */
  private async deliver(a: PortalAccount, phone10: string, sendId: number, send: (phone10: string, code: string) => Promise<void>): Promise<ToPhone> {
    const S = schema.phoneCodeSends;
    const A = schema.portalAccounts;
    const code = String(randomInt(100_000, 1_000_000));
    try {
      await send(phone10, code);
    } catch (e) {
      // No salió (o no contestó a tiempo): ese código nunca se guardó, así que no sirve. Si había uno
      // vigente, ese sigue igual. El portal pasa al respaldo.
      await this.o.db.update(S).set({ status: "failed" }).where(eq(S.id, sendId));
      const meta = (e as { code?: unknown } | null)?.code;
      this.o.log?.({ msg: "phone_code_not_sent", merchant_id: a.merchantId, account_id: a.id, code: typeof meta === "number" ? meta : null });
      return { kind: "fallback", reason: "not_sent" };
    }
    // WhatsApp lo aceptó: desde ahora se puede escribir, y el anterior ya no sirve. Con el candado del
    // celular: si mientras Meta contestaba se llegó a los 10 equivocados, este código ya no se guarda.
    const now = this.o.now();
    const expiresAt = new Date(now.getTime() + PHONE_CODE_TTL_MS);
    const stored = await this.o.db.transaction(async (tx) => {
      await lockPhone(tx, a.phone);
      await tx.update(S).set({ status: "sent" }).where(eq(S.id, sendId));
      if ((await missesToday(tx, a.phone, now)) >= PHONE_CODE_MAX_MISSES_PER_DAY) return false;
      await tx.update(A).set({ otpHash: sha256(code), otpExpiresAt: expiresAt, otpAttempts: 0 }).where(and(eq(A.id, a.id), isNull(A.phoneVerifiedAt)));
      return true;
    });
    this.o.log?.({ msg: "phone_code_sent", merchant_id: a.merchantId, account_id: a.id, ...(stored ? {} : { stored: false }) });
    if (!stored) return { kind: "fallback", reason: "locked" };
    return { kind: "ok", expiresAt, resendInS: Math.round(PHONE_CODE_RESEND_MS / 1000) };
  }

  /** Segundos que faltan para poder pedir otro código a este celular. */
  private async resendWaitS(phone: string, now: Date): Promise<number> {
    const S = schema.phoneCodeSends;
    const [last] = await this.o.db.select({ at: S.sentAt }).from(S).where(eq(S.phone, phone)).orderBy(desc(S.sentAt), desc(S.id)).limit(1);
    return last ? Math.max(0, Math.ceil((last.at.getTime() + PHONE_CODE_RESEND_MS - now.getTime()) / 1000)) : 0;
  }

  /**
   * Respaldo pedido a propósito («¿No te llega?», «Pedir otro código»): si ahora tampoco se le podría
   * mandar el código, el motivo. Así el portal no ofrece «Mejor mándenme el código a mí» cuando no va a
   * funcionar, y el motivo no se pierde al pedir otro código del respaldo.
   */
  private async toPhoneBlocked(a: PortalAccount, now: Date): Promise<FallbackReason | null> {
    if (!this.o.verification?.sendCode || !realPhone10(a.phone)) return "not_sent";
    const st = await this.sendState(this.o.db, a.phone, now);
    return st.kind === "fallback" ? st.reason : null;
  }

  /**
   * Respaldo: un código que la persona manda desde su celular por WhatsApp (enlace wa.me ya escrito). Es
   * de esta sesión: solo esta sesión queda verificada cuando llega (y otra no lo puede reemplazar).
   */
  private async codeFromPhone(a: PortalAccount, now: Date, reason: FallbackReason | null): Promise<StartRes> {
    const S = schema.portalSessions;
    const [row] = await this.o.db.select({ expiresAt: S.verifyExpiresAt }).from(S).where(eq(S.tokenHash, a.session));
    if (row?.expiresAt && row.expiresAt.getTime() - VERIFY_CODE_TTL_MS + VERIFY_RESEND_MS > now.getTime()) {
      return { status: 429, body: { error: "Espera unos segundos para pedir otro código." } };
    }
    const code = String(randomInt(100_000, 1_000_000));
    const expiresAt = new Date(now.getTime() + VERIFY_CODE_TTL_MS);
    await this.o.db.update(S).set({ verifyCodeHash: sha256(code), verifyExpiresAt: expiresAt }).where(eq(S.tokenHash, a.session));
    const number = this.o.verification?.waNumber ?? null;
    return {
      status: 200,
      body: {
        verified: false,
        method: "code_from_phone" as const,
        ...(reason ? { reason } : {}),
        code,
        message: verifyMessage(code),
        number,
        link: number ? `https://wa.me/${number}?text=${encodeURIComponent(verifyMessage(code))}` : null,
        expires_at: expiresAt.toISOString(),
      },
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
      // Sin `method`: una pestaña con el portal de antes (solo conoce el respaldo y truena con la otra
      // respuesta). Se le da el respaldo de siempre; el portal nuevo siempre dice qué camino quiere.
      const res =
        body.method === undefined ? await this.codeFromPhone(a, now, null)
        : body.method === "code_from_phone" ? await this.codeFromPhone(a, now, await this.toPhoneBlocked(a, now))
        : await this.once(a.session, () => this.startToPhone(a, now, body.resend === true));
      return reply.code(res.status).send(res.body);
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
      // Todo con el candado del celular (el mismo de los envíos): aunque lleguen muchos códigos a la vez,
      // nunca se comparan más de PHONE_CODE_MAX_ATTEMPTS por código ni más de
      // PHONE_CODE_MAX_MISSES_PER_DAY equivocados por celular en 24 horas.
      const A = schema.portalAccounts;
      const res = await o.db.transaction(async (tx): Promise<{ status: number; body: Record<string, unknown> }> => {
        await lockPhone(tx, a.phone);
        const missed = await missesToday(tx, a.phone, now);
        if (missed >= PHONE_CODE_MAX_MISSES_PER_DAY) {
          await tx.update(A).set({ otpHash: null, otpExpiresAt: null }).where(eq(A.id, a.id));
          return { status: 410, body: { error: "Pide un código nuevo.", reason: "none" } };
        }
        // Primero se gasta un intento y luego se compara.
        const [row] = await tx
          .update(A)
          .set({ otpAttempts: sql`${A.otpAttempts} + 1` })
          .where(and(eq(A.id, a.id), isNotNull(A.otpHash), gt(A.otpExpiresAt, now), lt(A.otpAttempts, PHONE_CODE_MAX_ATTEMPTS)))
          .returning({ hash: A.otpHash, attempts: A.otpAttempts });
        if (!row?.hash) {
          const [cur] = await tx.select({ hash: A.otpHash, expiresAt: A.otpExpiresAt }).from(A).where(eq(A.id, a.id));
          const reason = !cur?.hash ? "none" : cur.expiresAt && cur.expiresAt <= now ? "expired" : "locked";
          const error =
            reason === "locked" ? "Ya usaste los 5 intentos. Pide un código nuevo." : reason === "expired" ? "Ese código ya venció. Pide uno nuevo." : "Pide un código nuevo.";
          return { status: 410, body: { error, reason } };
        }
        if (!sameSecret(sha256(code), row.hash)) {
          // Cada código equivocado se anota por celular. Con muchos en 24 horas se anula el código y ese
          // celular ya no recibe más (solo el respaldo, que exige escribir desde su WhatsApp).
          await tx.insert(schema.phoneCodeMisses).values({ phone: a.phone, missedAt: now });
          const leftToday = PHONE_CODE_MAX_MISSES_PER_DAY - (missed + 1);
          if (leftToday <= 0) {
            await tx.update(A).set({ otpHash: null, otpExpiresAt: null }).where(eq(A.id, a.id));
            o.log?.({ msg: "phone_code_locked", merchant_id: a.merchantId, account_id: a.id });
            return { status: 400, body: { error: "Ese código no es y ya no quedan intentos. Pide un código nuevo.", reason: "wrong", attempts_left: 0 } };
          }
          // Lo que queda de este código, sin pasar de lo que le queda al celular hoy.
          const left = Math.max(0, Math.min(PHONE_CODE_MAX_ATTEMPTS - row.attempts, leftToday));
          const error =
            left === 0
              ? "Ese código no es y ya usaste los 5 intentos. Pide un código nuevo."
              : `Ese código no es. Te ${left === 1 ? "queda 1 intento" : `quedan ${left} intentos`}.`;
          return { status: 400, body: { error, reason: "wrong", attempts_left: left } };
        }
        // Correcto: queda verificada esta sesión y se cierran las demás de la cuenta.
        await markPhoneVerified(tx, a, now, [a.session]);
        return { status: 200, body: { verified: true } };
      });
      if (res.status === 200) o.log?.({ msg: "phone_verified", merchant_id: a.merchantId, account_id: a.id, method: "code_to_phone" });
      return reply.code(res.status).send(res.body);
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
