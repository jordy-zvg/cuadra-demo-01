import { readFileSync } from "node:fs";
import { RuleInterpreter } from "@cuadra/agents";
import { DEMO, schema, seedDemo } from "@cuadra/db";
import { createTestDb } from "@cuadra/db/testing";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { cleanName, hashPin, isPublicPath, normalizeCurp, normalizePhone, pinProblem, readCookie, verifyPhoneByWhatsApp, verifyPin } from "../src/auth.js";
import { SimulatedGateway } from "../src/gateway.js";
import { buildServer } from "../src/server.js";
import { createStoreRegistry } from "../src/app.js";

describe("normalizePhone", () => {
  it("acepta 10 dígitos, con espacios o guiones", () => {
    expect(normalizePhone("5512345678")).toBe("5512345678");
    expect(normalizePhone("55 1234 5678")).toBe("5512345678");
    expect(normalizePhone("55-1234-5678")).toBe("5512345678");
  });
  it("quita la lada +52, 52 y 521", () => {
    expect(normalizePhone("+52 55 1234 5678")).toBe("5512345678");
    expect(normalizePhone("525512345678")).toBe("5512345678");
    expect(normalizePhone("5215512345678")).toBe("5512345678");
  });
  it("rechaza longitudes inválidas", () => {
    expect(normalizePhone("")).toBeNull();
    expect(normalizePhone("551234567")).toBeNull();
    expect(normalizePhone("55123456789")).toBeNull();
    expect(normalizePhone("hola")).toBeNull();
  });
});

describe("pinProblem", () => {
  it("rechaza lo que no son 4 dígitos", () => {
    for (const p of ["", "123", "12345", "abcd", "12a4", "12 4"]) expect(pinProblem(p)).toMatch(/4 números/);
  });
  it("rechaza todos iguales", () => {
    expect(pinProblem("0000")).toMatch(/iguales/);
    expect(pinProblem("1111")).toMatch(/iguales/);
  });
  it("rechaza secuencias", () => {
    for (const p of ["1234", "4321", "6789", "0123", "9876"]) expect(pinProblem(p)).toMatch(/seguidos/);
  });
  it("acepta un NIP razonable", () => {
    expect(pinProblem("2580")).toBeNull();
    expect(pinProblem("1357")).toBeNull();
  });
});

describe("cleanName", () => {
  it("limpia espacios y valida el largo", () => {
    expect(cleanName("  Doña   Lupe ")).toBe("Doña Lupe");
    expect(cleanName("A")).toBeNull();
    expect(cleanName("   ")).toBeNull();
    expect(cleanName("x".repeat(61))).toBeNull();
    expect(cleanName("x".repeat(60))).toBe("x".repeat(60));
  });
});

describe("hashPin / verifyPin", () => {
  it("verifica el NIP correcto y rechaza el equivocado", async () => {
    const h = await hashPin("2580");
    expect(h.startsWith("scrypt$")).toBe(true);
    expect(h).not.toContain("2580");
    expect(await verifyPin("2580", h)).toBe(true);
    expect(await verifyPin("2581", h)).toBe(false);
  });
  it("usa sal distinta cada vez", async () => {
    expect(await hashPin("2580")).not.toBe(await hashPin("2580"));
  });
  it("rechaza hashes mal formados", async () => {
    expect(await verifyPin("2580", "basura")).toBe(false);
    expect(await verifyPin("2580", "bcrypt$a$b")).toBe(false);
  });
});

describe("readCookie", () => {
  it("una cookie malformada cuenta como sin sesión (no truena)", () => {
    expect(readCookie("cuadra_sesion=%E0%A4%A", "cuadra_sesion")).toBeNull();
  });
  it("lee la cookie por nombre", () => {
    expect(readCookie("a=1; cuadra_sesion=abc; b=2", "cuadra_sesion")).toBe("abc");
    expect(readCookie("cuadra_sesion=a%20b", "cuadra_sesion")).toBe("a b");
  });
  it("devuelve null si no está", () => {
    expect(readCookie(undefined, "x")).toBeNull();
    expect(readCookie("a=1", "x")).toBeNull();
    expect(readCookie("xx=1", "x")).toBeNull();
  });
});

describe("isPublicPath", () => {
  it("lo privado exige sesión", () => {
    for (const [p, m] of [
      ["/api/state", "GET"], ["/api/chat", "POST"], ["/panel", "GET"], ["/index.html", "GET"], ["/tanda", "GET"], ["/mandato", "GET"], ["/permiso", "GET"],
      ["/api/passkey/register/options", "POST"], ["/api/payees", "GET"],
    ] as const) expect(isPublicPath(p, m), `${m} ${p}`).toBe(false);
  });
  it("lo público queda abierto", () => {
    for (const [p, m] of [
      ["/", "GET"], ["/login", "GET"], ["/webhooks/pey", "POST"], ["/aprobar/x", "GET"], ["/api/proposal/x", "GET"],
      ["/api/approve/verify", "POST"], ["/api/auth/login", "POST"], ["/health", "GET"],
      // Diseño compartido: la página de entrada y la de aprobación lo necesitan sin sesión.
      ["/assets/cuadra.css", "GET"], ["/assets/icons.svg", "GET"], ["/assets/fonts/bricolage-grotesque-latin-wght-normal.woff2", "GET"],
    ] as const) expect(isPublicPath(p, m), `${m} ${p}`).toBe(true);
  });
  it("lo que solo se parece a /assets/ no es público", () => {
    expect(isPublicPath("/assetsx/a", "GET")).toBe(false);
    expect(isPublicPath("/api/assets/x", "GET")).toBe(false);
    // No sirve de atajo para llegar a otras páginas.
    expect(isPublicPath("/assets/../index.html", "GET")).toBe(false);
    expect(isPublicPath("/assets/%2e%2e/index.html", "GET")).toBe(false);
    expect(isPublicPath("/assets/", "GET")).toBe(false);
  });
  it("POST a /api/proposal/x no es público", () => {
    expect(isPublicPath("/api/proposal/x", "POST")).toBe(false);
  });
});

// ---------- flujo con servidor ----------

type AppOpts = {
  shopCode?: string | null; secureCookies?: boolean; demoPassword?: string | null; llave?: "demo" | "off"; verification?: "whatsapp" | "off";
  sendCode?: (phone10: string, code: string) => Promise<void>; dailyBudget?: number;
};

/** Un servidor sobre la DB dada (dos servidores con la misma DB = dos procesos de la API). */
function serverOn(db: Awaited<ReturnType<typeof createTestDb>>["db"], now: () => Date, opts: AppOpts, logs: Array<Record<string, unknown>>) {
  const gateway = new SimulatedGateway(db);
  const registry = createStoreRegistry({
    db, liveGateway: gateway, interpreters: [new RuleInterpreter()], verify: async () => false, now, publicUrl: null,
    peyWebhookSecret: null, bankSim: false, udi: null, log: () => {},
  });
  return buildServer({
    db, registry, liveMerchantId: DEMO.merchantId, liveGateway: gateway, peyWebhookSecret: null, bankSim: false,
    demoPassword: opts.demoPassword ?? null, log: (r) => logs.push(r),
    portalAuth: {
      shopCode: opts.shopCode ?? null, secureCookies: opts.secureCookies ?? false, llave: opts.llave ?? "off", now,
      ...(opts.verification
        ? {
            verification: {
              mode: opts.verification, waNumber: "15550001111",
              ...(opts.sendCode ? { sendCode: opts.sendCode } : {}), ...(opts.dailyBudget !== undefined ? { dailyBudget: opts.dailyBudget } : {}),
            },
          }
        : {}),
    },
    passkey: { rpID: "localhost", origins: ["http://localhost"], now },
  });
}

async function app(opts: AppOpts = {}) {
  const clock = { t: new Date("2026-11-14T15:00:00Z") };
  const now = () => new Date(clock.t);
  const { db } = await createTestDb();
  await seedDemo(db);
  const logs: Array<Record<string, unknown>> = [];
  const server = serverOn(db, now, opts, logs);
  return {
    server, db, now, logs, advance: (ms: number) => { clock.t = new Date(clock.t.getTime() + ms); },
    /** Otro proceso de la API sobre la misma DB y el mismo reloj. */
    twin: () => serverOn(db, now, opts, logs),
  };
}

type Server = Awaited<ReturnType<typeof app>>["server"];
const MIN = 60_000;
const DAY = 86_400_000;
const reg = (s: Server, over: Record<string, unknown> = {}) =>
  s.inject({ method: "POST", url: "/api/auth/register", payload: { name: "Lupe", phone: "5512345678", pin: "2580", ...over } });
const login = (s: Server, pin: string, phone = "5512345678") =>
  s.inject({ method: "POST", url: "/api/auth/login", payload: { phone, pin } });
const cookieOf = (res: { headers: Record<string, unknown> }) => String(res.headers["set-cookie"]).split(";")[0]!;

describe("login del portal (servidor)", () => {
  it("registro: 200, cookie HttpOnly SameSite=Lax y sesión válida", async () => {
    const { server } = await app();
    const r = await reg(server);
    expect(r.statusCode).toBe(200);
    const sc = String(r.headers["set-cookie"]);
    expect(sc).toMatch(/^cuadra_sesion=/);
    expect(sc).toContain("HttpOnly");
    expect(sc).toContain("SameSite=Lax");
    expect(sc).not.toContain("Secure");
    const cookie = cookieOf(r);
    expect((await server.inject({ url: "/api/state", headers: { cookie } })).statusCode).toBe(200);
    const me = await server.inject({ url: "/api/auth/me", headers: { cookie } });
    expect(me.statusCode).toBe(200);
    expect(me.json().account).toEqual({ name: "Lupe", phone_last4: "5678", verified: true });
  });

  it("sin cookie: la API da 401 y las páginas redirigen a /login", async () => {
    const { server } = await app();
    expect((await server.inject({ url: "/api/state" })).statusCode).toBe(401);
    expect((await server.inject({ url: "/api/auth/me" })).statusCode).toBe(401);
    const panel = await server.inject({ url: "/panel" });
    expect(panel.statusCode).toBe(302);
    expect(panel.headers.location).toBe("/login?next=%2Fpanel");
    expect((await server.inject({ url: "/index.html" })).statusCode).toBe(302);
    // "/" es la landing pública: Entrar abre el celular y Crear mi cuenta el registro (enlaces directos a /login).
    const landing = await server.inject({ url: "/" });
    expect(landing.statusCode).toBe(200);
    expect(landing.body).toContain('href="/login?entrar"');
    expect(landing.body).toContain('href="/login?registro"');
    expect(landing.body).not.toMatch(/demo|demostración|datos de prueba/i);
    const login = await server.inject({ url: "/login" });
    expect(login.statusCode).toBe(200);
    // En la entrada, arriba a la izquierda va una casita que regresa a la página principal.
    expect(login.body).toContain('<a class="home-link" href="/" aria-label="Página principal de Cuadra"');
    expect((await server.inject({ url: "/login?registro" })).statusCode).toBe(200);
  });

  it("celular repetido da 409 (aunque venga con lada)", async () => {
    const { server } = await app();
    expect((await reg(server)).statusCode).toBe(200);
    expect((await reg(server)).statusCode).toBe(409);
    expect((await reg(server, { phone: "+52 55 1234 5678" })).statusCode).toBe(409);
  });

  it("datos inválidos dan 400", async () => {
    const { server } = await app();
    expect((await reg(server, { pin: "1234" })).statusCode).toBe(400);
    expect((await reg(server, { pin: "12" })).statusCode).toBe(400);
    expect((await reg(server, { phone: "123" })).statusCode).toBe(400);
    expect((await reg(server, { name: " " })).statusCode).toBe(400);
  });

  it("código de la tienda: falta o es incorrecto => 403; correcto => 200", async () => {
    const { server } = await app({ shopCode: "TIENDA42" });
    expect((await reg(server)).statusCode).toBe(403);
    expect((await reg(server, { shop_code: "otro" })).statusCode).toBe(403);
    expect((await server.inject({ url: "/api/auth/me" })).json().needs_shop_code).toBe(true);
    expect((await reg(server, { shop_code: " TIENDA42 " })).statusCode).toBe(200);
  });

  it("5 NIP equivocados bloquean 15 min; luego el correcto entra", async () => {
    const { server, advance } = await app();
    await reg(server);
    for (let i = 1; i <= 4; i++) {
      const r = await login(server, "9999");
      expect(r.statusCode).toBe(401);
      expect(r.json().error).toMatch(/Te quedan/);
    }
    const fifth = await login(server, "9999");
    expect(fifth.statusCode).toBe(401);
    expect(fifth.json().error).toMatch(/espera 15 minutos/);
    const locked = await login(server, "2580");
    expect(locked.statusCode).toBe(429);
    expect(locked.json().error).toMatch(/espera/);
    advance(14 * MIN);
    expect((await login(server, "2580")).statusCode).toBe(429);
    advance(2 * MIN);
    const ok = await login(server, "2580");
    expect(ok.statusCode).toBe(200);
    expect((await server.inject({ url: "/api/state", headers: { cookie: cookieOf(ok) } })).statusCode).toBe(200);
  });

  it("muchos NIP a la vez: nunca se revisan más de 5 antes del bloqueo", async () => {
    const { server } = await app();
    await reg(server);
    const rs = await Promise.all(Array.from({ length: 12 }, () => login(server, "9999")));
    expect(rs.filter((r) => r.statusCode === 401)).toHaveLength(5);
    expect(rs.filter((r) => r.statusCode === 429)).toHaveLength(7);
    // Ya bloqueada: ni el NIP correcto entra.
    expect((await login(server, "2580")).statusCode).toBe(429);
  });

  it("un NIP correcto reinicia el contador de fallos", async () => {
    const { server } = await app();
    await reg(server);
    for (let i = 0; i < 4; i++) await login(server, "9999");
    expect((await login(server, "2580")).statusCode).toBe(200);
    const r = await login(server, "9999");
    expect(r.json().error).toMatch(/Te quedan 4/);
  });

  it("celular no registrado da 404", async () => {
    const { server } = await app();
    expect((await login(server, "2580", "5500000000")).statusCode).toBe(404);
  });

  it("logout invalida la cookie", async () => {
    const { server } = await app();
    const cookie = cookieOf(await reg(server));
    expect((await server.inject({ url: "/api/state", headers: { cookie } })).statusCode).toBe(200);
    const out = await server.inject({ method: "POST", url: "/api/auth/logout", headers: { cookie } });
    expect(out.statusCode).toBe(200);
    expect(String(out.headers["set-cookie"])).toContain("Max-Age=0");
    expect((await server.inject({ url: "/api/state", headers: { cookie } })).statusCode).toBe(401);
  });

  it("la sesión vence a los 30 días", async () => {
    const { server, advance } = await app();
    const cookie = cookieOf(await reg(server));
    advance(29 * DAY);
    expect((await server.inject({ url: "/api/state", headers: { cookie } })).statusCode).toBe(200);
    advance(2 * DAY);
    expect((await server.inject({ url: "/api/state", headers: { cookie } })).statusCode).toBe(401);
  });

  it("secureCookies agrega Secure", async () => {
    const { server } = await app({ secureCookies: true });
    expect(String((await reg(server)).headers["set-cookie"])).toContain("; Secure");
  });

  it("la DB nunca guarda el NIP en claro", async () => {
    const { server, db } = await app();
    await reg(server, { pin: "2580" });
    const rows = await db.select().from(schema.portalAccounts);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.pinHash?.startsWith("scrypt$")).toBe(true);
    expect(rows[0]!.pinHash).not.toContain("2580");
    expect(rows[0]!.phone).toBe("5512345678");
  });

  it("una cookie inventada no sirve", async () => {
    const { server } = await app();
    expect((await server.inject({ url: "/api/state", headers: { cookie: "cuadra_sesion=inventada" } })).statusCode).toBe(401);
  });

  it("passkey: la aprobación sigue abierta; registrar una nueva pide sesión", async () => {
    const { server } = await app();
    expect((await server.inject({ url: "/aprobar/abc" })).statusCode).not.toBe(401);
    expect((await server.inject({ method: "POST", url: "/api/approve/options", payload: { proposal_id: "x" } })).statusCode).not.toBe(401);
    expect((await server.inject({ method: "POST", url: "/api/passkey/register/options", payload: {} })).statusCode).toBe(401);
  });

  it("la pantalla de aprobación habla de «aprobación» y «permiso»; el código va en el detalle técnico", async () => {
    const { server } = await app();
    const page = (await server.inject({ url: "/aprobar/abc" })).body;
    // Solo las rutas de la API y el estado interno conservan el nombre técnico; nada que lea el comercio dice passkey o mandato.
    expect(page.replaceAll("/api/passkey/", "").replaceAll("awaiting_passkey", "")).not.toMatch(/passkey|mandato/i);
    expect(page).toContain("Primero activa la aprobación en este dispositivo.");
    expect(page).toContain("Revisar permiso");
    expect(page).toMatch(/<details class="tech">\s*<summary>Detalle técnico<\/summary>/);
    expect(page).not.toContain("hash:");
  });

  it("el panel ya no dice «simulado» y firma permisos en /permiso", async () => {
    const panel = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
    expect(panel).not.toMatch(/simulad|simular|mandato/i);
    expect(panel).toContain('href="/permiso"');
  });
});

describe("Llave CDMX (demo)", () => {
  const CURP = "PELM550101MDFRPR09";
  const start = async (s: Server) => {
    const r = await s.inject({ url: "/api/auth/llave/start" });
    expect(r.statusCode).toBe(200);
    return new URL(r.json().url, "http://x").searchParams.get("state")!;
  };
  const cb = (s: Server, state: string, over: Record<string, unknown> = {}) =>
    s.inject({ method: "POST", url: "/api/auth/llave/demo-callback", payload: { state, name: "María Pérez", curp: CURP, phone: "5587654321", ...over } });

  it("normalizeCurp valida la forma de la CURP", () => {
    expect(normalizeCurp(" pelm550101mdfrpr09 ")).toBe(CURP);
    expect(normalizeCurp("PELM550101MDFRPR0")).toBeNull();
    expect(normalizeCurp("PELM550101MXXRPR09")).toBeNull();
  });

  it("apagada: sin botón ni rutas", async () => {
    const { server } = await app({ llave: "off" });
    expect((await server.inject({ url: "/api/auth/llave/start" })).statusCode).toBe(404);
    expect((await server.inject({ url: "/api/auth/me" })).json().llave).toBe("off");
  });

  it("crea la cuenta, abre sesión y no guarda la CURP; la segunda vez entra a la misma cuenta", async () => {
    const { server, db } = await app({ llave: "demo" });
    // La pantalla dice con claridad que es de Cuadra y no del gobierno (y que nunca pide la contraseña de la Llave).
    expect((await server.inject({ url: "/llave-cdmx/autorizar?state=x" })).body).toMatch(/es de Cuadra, no del Gobierno de la Ciudad de México/);
    const r = await cb(server, await start(server));
    expect(r.statusCode).toBe(200);
    expect((await server.inject({ url: "/api/state", headers: { cookie: cookieOf(r) } })).statusCode).toBe(200);
    const rows = await db.select().from(schema.portalAccounts);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.pinHash).toBeNull();
    expect(JSON.stringify(rows[0])).not.toContain(CURP);
    const again = await cb(server, await start(server));
    expect(again.statusCode).toBe(200);
    expect(await db.select().from(schema.portalAccounts)).toHaveLength(1);
    // Esa cuenta no tiene NIP: entrar con NIP no funciona.
    expect((await login(server, "2580", "5587654321")).statusCode).toBe(409);
  });

  it("el state es de un solo uso y vence", async () => {
    const { server } = await app({ llave: "demo" });
    expect((await cb(server, "inventado")).statusCode).toBe(400);
    const st = await start(server);
    expect((await cb(server, st)).statusCode).toBe(200);
    expect((await cb(server, st)).statusCode).toBe(400);
  });

  it("no se mete a una cuenta existente con NIP (mismo celular)", async () => {
    const { server } = await app({ llave: "demo" });
    await reg(server, { phone: "5587654321" });
    const r = await cb(server, await start(server));
    expect(r.statusCode).toBe(409);
    expect(r.headers["set-cookie"]).toBeUndefined();
  });

  it("una CURP ligada solo entra con el celular de la cuenta; con WhatsApp, vuelve a verificarlo", async () => {
    const { server, db } = await app({ llave: "demo", verification: "whatsapp" });
    expect((await cb(server, await start(server))).statusCode).toBe(200);
    await db.update(schema.portalAccounts).set({ phoneVerifiedAt: new Date("2026-11-14T15:00:00Z") });
    // Alguien que conoce la CURP pero no tiene el celular: no entra.
    const otro = await cb(server, await start(server), { phone: "5599990000" });
    expect(otro.statusCode).toBe(403);
    expect(otro.headers["set-cookie"]).toBeUndefined();
    // Con el celular correcto entra, pero debe mandar el código desde ese celular antes de ver su libreta.
    const again = await cb(server, await start(server));
    expect(again.statusCode).toBe(200);
    expect(again.json().account.verified).toBe(false);
    expect((await server.inject({ url: "/api/state", headers: { cookie: cookieOf(again) } })).statusCode).toBe(403);
  });

  it("si alguien entra con la CURP y el celular de otra persona, cuando ella comprueba su celular se cierra la sesión del otro", async () => {
    const sent: string[] = [];
    const a = await app({ llave: "demo", verification: "whatsapp", sendCode: async (_p, code) => { sent.push(code); } });
    const startFor = (cookie: string) =>
      a.server.inject({ method: "POST", url: "/api/auth/verify/start", headers: { cookie }, payload: { method: "code_to_phone" } });
    const checkFor = (cookie: string, code: string) =>
      a.server.inject({ method: "POST", url: "/api/auth/verify/check", headers: { cookie }, payload: { code } });
    const state = async (cookie: string) => (await a.server.inject({ url: "/api/state", headers: { cookie } })).statusCode;
    const mine = cookieOf(await cb(a.server, await start(a.server)));
    await startFor(mine);
    expect((await checkFor(mine, sent[0]!)).json()).toEqual({ verified: true });
    // Alguien con su CURP y su celular abre otra sesión: la cuenta vuelve a pedir el celular.
    const intruso = cookieOf(await cb(a.server, await start(a.server)));
    expect(await state(mine)).toBe(403);
    expect(await state(intruso)).toBe(403);
    // Ella escribe el código que le llega: queda solo su sesión.
    a.advance(61_000);
    await startFor(mine);
    expect((await checkFor(mine, sent[1]!)).json()).toEqual({ verified: true });
    expect(await state(mine)).toBe(200);
    expect(await state(intruso)).toBe(401);
  });

  it("lo mismo con el respaldo: el código es de la sesión que lo pidió y otra no lo puede reemplazar", async () => {
    const a = await app({ llave: "demo", verification: "whatsapp" }); // sin envío por WhatsApp: solo el respaldo
    const fallback = async (cookie: string) =>
      (await a.server.inject({ method: "POST", url: "/api/auth/verify/start", headers: { cookie }, payload: { method: "code_from_phone" } })).json() as {
        code: string; message: string;
      };
    const state = async (cookie: string) => (await a.server.inject({ url: "/api/state", headers: { cookie } })).statusCode;
    const mine = cookieOf(await cb(a.server, await start(a.server)));
    expect(await verifyPhoneByWhatsApp(a.db, "5587654321", (await fallback(mine)).message, a.now())).toEqual({ name: "María Pérez" });
    const intruso = cookieOf(await cb(a.server, await start(a.server)));
    a.advance(21_000);
    const suyo = await fallback(mine);
    const delOtro = await fallback(intruso); // no reemplaza el de ella
    expect(delOtro.code).toMatch(/^\d{6}$/);
    expect(await verifyPhoneByWhatsApp(a.db, "5587654321", suyo.message, a.now())).toEqual({ name: "María Pérez" });
    expect(await state(mine)).toBe(200);
    expect(await state(intruso)).toBe(401);
    // Y el código que pidió el otro ya no sirve.
    expect(await verifyPhoneByWhatsApp(a.db, "5587654321", delOtro.message, a.now())).toBeNull();
  });

  it("respeta el código de la tienda para cuentas nuevas", async () => {
    const { server } = await app({ llave: "demo", shopCode: "4321" });
    expect((await cb(server, await start(server))).statusCode).toBe(403);
    expect((await cb(server, await start(server), { shop_code: "4321" })).statusCode).toBe(200);
  });
});

describe("verificación del celular por WhatsApp", () => {
  const reg = async (a: Awaited<ReturnType<typeof app>>, phone: string, name = "Ana Ruiz") => {
    const r = await a.server.inject({ method: "POST", url: "/api/auth/register", payload: { name, phone, pin: "2580" } });
    return { r, cookie: String(r.headers["set-cookie"] ?? "").split(";")[0]! };
  };
  const startCode = async (a: Awaited<ReturnType<typeof app>>, cookie: string) =>
    (await a.server.inject({ method: "POST", url: "/api/auth/verify/start", headers: { cookie }, payload: {} })).json() as {
      code: string; link: string; message: string; verified: boolean;
    };

  it("sin verificar no entra a su libreta ni a “Lo que debo”; con el código por WhatsApp, sí", async () => {
    const a = await app({ verification: "whatsapp" });
    const { r, cookie } = await reg(a, "5521111111");
    expect(r.json()).toMatchObject({ ok: true, account: { verified: false } });
    for (const url of ["/api/state", "/api/me/debts", "/api/payees"]) {
      const x = await a.server.inject({ url, headers: { cookie } });
      expect(x.statusCode, url).toBe(403);
      expect(x.json()).toMatchObject({ needs_verification: true });
    }
    expect((await a.server.inject({ url: "/panel", headers: { cookie } })).statusCode).toBe(302);
    const v = await startCode(a, cookie);
    expect(v.code).toMatch(/^\d{6}$/);
    expect(v.link).toBe(`https://wa.me/15550001111?text=${encodeURIComponent(`Mi código de Cuadra es ${v.code}`)}`);
    // Desde otro celular, con un código equivocado o ya vencido, no verifica.
    expect(await verifyPhoneByWhatsApp(a.db, "5599999999", v.message, a.now())).toBeNull();
    expect(await verifyPhoneByWhatsApp(a.db, "5521111111", "Mi código de Cuadra es 000000", a.now())).toBeNull();
    expect(await verifyPhoneByWhatsApp(a.db, "5521111111", v.message, new Date(a.now().getTime() + 16 * 60_000))).toBeNull();
    expect(await verifyPhoneByWhatsApp(a.db, "5521111111", v.message, a.now())).toEqual({ name: "Ana Ruiz" });
    expect((await a.server.inject({ url: "/api/state", headers: { cookie } })).statusCode).toBe(200);
    expect(((await a.server.inject({ url: "/api/auth/me", headers: { cookie } })).json() as { account: { verified: boolean } }).account.verified).toBe(true);
    // El código ya no sirve una segunda vez.
    expect(await verifyPhoneByWhatsApp(a.db, "5521111111", v.message, a.now())).toBeNull();
  });

  it("no se puede pedir un código tras otro; después de unos segundos, sí", async () => {
    const a = await app({ verification: "whatsapp" });
    const { cookie } = await reg(a, "5521111111");
    await startCode(a, cookie);
    expect((await a.server.inject({ method: "POST", url: "/api/auth/verify/start", headers: { cookie }, payload: {} })).statusCode).toBe(429);
    a.advance(21_000);
    expect((await startCode(a, cookie)).code).toMatch(/^\d{6}$/);
  });

  it("quien se registró con un celular ajeno y no lo verificó no lo bloquea: el dueño real se registra encima", async () => {
    const a = await app({ verification: "whatsapp" });
    const intruso = await reg(a, "5521111111", "Intruso");
    const real = await reg(a, "5521111111", "Ana Ruiz");
    expect(real.r.statusCode).toBe(200);
    // La sesión del intruso ya no sirve.
    expect((await a.server.inject({ url: "/api/auth/me", headers: { cookie: intruso.cookie } })).statusCode).toBe(401);
    const v = await startCode(a, real.cookie);
    expect(await verifyPhoneByWhatsApp(a.db, "5521111111", v.message, a.now())).toEqual({ name: "Ana Ruiz" });
    // Ya verificado, nadie más se registra con ese celular.
    expect((await reg(a, "5521111111", "Otro")).r.statusCode).toBe(409);
  });

  it("con la verificación apagada (desarrollo), la cuenta nace verificada", async () => {
    const a = await app();
    const { r, cookie } = await reg(a, "5521111111");
    expect(r.json()).toMatchObject({ account: { verified: true } });
    expect((await a.server.inject({ url: "/api/state", headers: { cookie } })).statusCode).toBe(200);
  });
});

describe("código por WhatsApp: Cuadra lo manda y se escribe en el portal", () => {
  const MIN_1 = 61_000;
  /**
   * fail: código de error de Meta con el que falla cada envío (se puede cambiar con f.ctl.fail).
   * gate: si existe, cada envío espera a que se resuelva (Meta tardando en contestar).
   */
  async function setup(o: { fail?: number; gate?: () => Promise<void>; dailyBudget?: number } = {}) {
    const sent: Array<{ phone10: string; code: string }> = [];
    const tried: string[] = [];
    const ctl = { fail: o.fail ?? null as number | null };
    const a = await app({
      verification: "whatsapp",
      ...(o.dailyBudget !== undefined ? { dailyBudget: o.dailyBudget } : {}),
      sendCode: async (phone10, code) => {
        tried.push(code);
        if (o.gate) await o.gate();
        if (ctl.fail !== null) throw Object.assign(new Error("Meta"), { code: ctl.fail });
        sent.push({ phone10, code });
      },
    });
    const register = async (phone = "5521111111") => {
      const r = await a.server.inject({ method: "POST", url: "/api/auth/register", payload: { name: "Ana Ruiz", phone, pin: "2580" } });
      return String(r.headers["set-cookie"] ?? "").split(";")[0]!;
    };
    let cookie = await register();
    // El portal nuevo siempre dice qué camino quiere (sin `method` es el respaldo de las pestañas viejas).
    const start = (body: Record<string, unknown> = {}, server = a.server) =>
      server.inject({ method: "POST", url: "/api/auth/verify/start", headers: { cookie }, payload: { method: "code_to_phone", ...body } });
    const check = (code: string) => a.server.inject({ method: "POST", url: "/api/auth/verify/check", headers: { cookie }, payload: { code } });
    const state = async () => (await a.server.inject({ url: "/api/state", headers: { cookie } })).statusCode;
    const other = (code: string) => (code === "123456" ? "654321" : "123456");
    const sends = async () => (await a.db.select().from(schema.phoneCodeSends)).map((r) => r.status);
    return {
      ...a, sent, tried, ctl, calls: () => tried.length, start, check, state, other, sends, register,
      reRegister: async () => { cookie = await register(); },
    };
  }
  /** Espera (sin reloj falso) a que algo pase: p. ej. que Meta ya tenga el código en la mano. */
  const until = async (ok: () => boolean) => {
    for (let i = 0; i < 500 && !ok(); i++) await new Promise((r) => setTimeout(r, 2));
    expect(ok()).toBe(true);
  };
  /** Meta tardando: cada envío espera a que la prueba lo suelte. */
  const slowMeta = () => {
    const waiting: Array<() => void> = [];
    return { gate: () => new Promise<void>((r) => { waiting.push(r); }), release: () => { for (const r of waiting.splice(0)) r(); }, waiting };
  };

  it("manda el código al celular (nunca a la pantalla); con el código correcto queda verificada", async () => {
    const f = await setup();
    const s = await f.start();
    expect(s.statusCode).toBe(200);
    expect(s.json()).toMatchObject({ verified: false, method: "code_to_phone", phone_last4: "1111", resend_in_s: 60 });
    expect(s.json().code).toBeUndefined();
    expect(s.json().link).toBeUndefined();
    expect(f.sent).toEqual([{ phone10: "5521111111", code: expect.stringMatching(/^\d{6}$/) }]);
    expect(await f.state()).toBe(403);
    const code = f.sent[0]!.code;
    const wrong = await f.check(f.other(code));
    expect(wrong.statusCode).toBe(400);
    expect(wrong.json()).toEqual({ error: "Ese código no es. Te quedan 4 intentos.", reason: "wrong", attempts_left: 4 });
    expect((await f.check("12345")).json()).toMatchObject({ reason: "format" }); // incompleto: no gasta intento
    // Con espacios o pegado de un mensaje: cuentan solo los números.
    expect((await f.check(` ${code.slice(0, 3)} ${code.slice(3)} `)).json()).toEqual({ verified: true });
    expect(await f.state()).toBe(200);
    expect(f.logs).toContainEqual(expect.objectContaining({ msg: "phone_code_sent" }));
    expect(f.logs).toContainEqual(expect.objectContaining({ msg: "phone_verified", method: "code_to_phone" }));
    expect(JSON.stringify(f.logs)).not.toContain(code); // el código nunca va al log
    // El dueño de su tienda (mismo celular) también queda verificado, para que Cuadra le conteste por WhatsApp.
    const [acc] = await f.db.select().from(schema.portalAccounts);
    const owners = await f.db.select().from(schema.merchantUsers).where(eq(schema.merchantUsers.merchantId, acc!.merchantId));
    expect(owners.some((o) => o.phoneVerified)).toBe(true);
    expect(acc).toMatchObject({ otpHash: null, otpExpiresAt: null });
  });

  it("cada camino tiene su propio código: el que manda Cuadra no sirve de regreso y el del respaldo no sirve escrito", async () => {
    const f = await setup();
    await f.start();
    const sentCode = f.sent[0]!.code;
    expect(await verifyPhoneByWhatsApp(f.db, "5521111111", `Mi código de Cuadra es ${sentCode}`, f.now())).toBeNull();
    const back = (await f.start({ method: "code_from_phone" })).json() as { method: string; code: string; reason?: string };
    expect(back).toMatchObject({ method: "code_from_phone", code: expect.stringMatching(/^\d{6}$/) });
    expect(back.reason).toBeUndefined();
    if (back.code !== sentCode) expect((await f.check(back.code)).json()).toMatchObject({ reason: "wrong" });
    expect(await verifyPhoneByWhatsApp(f.db, "5521111111", `Mi código de Cuadra es ${back.code}`, f.now())).toEqual({ name: "Ana Ruiz" });
    expect(await f.state()).toBe(200);
  });

  it("5 intentos: después ni el código correcto sirve y hay que pedir otro", async () => {
    const f = await setup();
    await f.start();
    const code = f.sent[0]!.code;
    for (let i = 4; i >= 1; i--) expect((await f.check(f.other(code))).json()).toMatchObject({ attempts_left: i });
    expect((await f.check(f.other(code))).json()).toEqual({
      error: "Ese código no es y ya usaste los 5 intentos. Pide un código nuevo.", reason: "wrong", attempts_left: 0,
    });
    const locked = await f.check(code);
    expect(locked.statusCode).toBe(410);
    expect(locked.json()).toEqual({ error: "Ya usaste los 5 intentos. Pide un código nuevo.", reason: "locked" });
    // Pedir otro antes del minuto: espera. Después, llega uno nuevo y ese sí sirve.
    const early = await f.start();
    expect(early.statusCode).toBe(429);
    expect(early.json()).toMatchObject({ method: "code_to_phone", retry_after_s: expect.any(Number) });
    f.advance(MIN_1);
    expect((await f.start()).json()).toMatchObject({ method: "code_to_phone" });
    expect(f.sent).toHaveLength(2);
    expect((await f.check(f.sent[1]!.code)).json()).toEqual({ verified: true });
  });

  it("varios intentos al mismo tiempo no pasan de 5", async () => {
    const f = await setup();
    await f.start();
    const code = f.sent[0]!.code;
    const res = await Promise.all(Array.from({ length: 12 }, () => f.check(f.other(code))));
    expect(res.filter((r) => r.statusCode === 400)).toHaveLength(5);
    expect(res.filter((r) => r.statusCode === 410)).toHaveLength(7);
    expect((await f.check(code)).statusCode).toBe(410);
  });

  it("vence a los 10 minutos", async () => {
    const f = await setup();
    await f.start();
    f.advance(10 * 60_000 + 1_000);
    expect((await f.check(f.sent[0]!.code)).json()).toEqual({ error: "Ese código ya venció. Pide uno nuevo.", reason: "expired" });
    expect(await f.state()).toBe(403);
  });

  it("volver a la pantalla no manda otro; reenviar espera un minuto y deja sin valor al anterior", async () => {
    const f = await setup();
    await f.start();
    const again = await f.start();
    expect(again.json()).toMatchObject({ method: "code_to_phone", resend_in_s: 60 });
    expect(f.sent).toHaveLength(1);
    const early = await f.start({ resend: true });
    expect(early.statusCode).toBe(429);
    expect(early.json()).toMatchObject({ error: "Espera un momento para pedir otro código.", retry_after_s: 60 });
    f.advance(MIN_1);
    expect((await f.start({ resend: true })).json()).toMatchObject({ method: "code_to_phone", resend_in_s: 60 });
    expect(f.sent).toHaveLength(2);
    const [first, second] = [f.sent[0]!.code, f.sent[1]!.code];
    if (first !== second) expect((await f.check(first)).json()).toMatchObject({ reason: "wrong" });
    expect((await f.check(second)).json()).toEqual({ verified: true });
  });

  it("a lo más 5 envíos por hora al mismo celular, aunque se registre de nuevo; después, el respaldo", async () => {
    const f = await setup();
    await f.start();
    for (let i = 0; i < 4; i++) { f.advance(MIN_1); await f.start({ resend: true }); }
    expect(f.sent).toHaveLength(5);
    f.advance(MIN_1);
    const limited = await f.start({ resend: true });
    expect(limited.statusCode).toBe(200);
    expect(limited.json()).toMatchObject({ method: "code_from_phone", reason: "limit", code: expect.stringMatching(/^\d{6}$/) });
    expect(f.sent).toHaveLength(5);
    // Registrarse de nuevo con el mismo celular (cuenta sin verificar) no reinicia el tope.
    await f.reRegister();
    expect((await f.start()).json()).toMatchObject({ method: "code_from_phone", reason: "limit" });
    expect(f.sent).toHaveLength(5);
    f.advance(60 * 60_000);
    expect((await f.start()).json()).toMatchObject({ method: "code_to_phone" });
    expect(f.sent).toHaveLength(6);
  });

  it("si WhatsApp no lo entrega (número de prueba o plantilla sin aprobar), pasa al respaldo y queda en el log", async () => {
    const f = await setup({ fail: 131030 });
    const s = await f.start();
    expect(s.statusCode).toBe(200);
    expect(s.json()).toMatchObject({
      method: "code_from_phone", reason: "not_sent", code: expect.stringMatching(/^\d{6}$/), link: expect.stringContaining("https://wa.me/15550001111"),
    });
    expect(f.logs).toContainEqual(expect.objectContaining({ msg: "phone_code_not_sent", code: 131030 }));
    const [acc] = await f.db.select().from(schema.portalAccounts);
    expect(acc!.otpHash).toBeNull();
    // Ni el código que Meta rechazó ni otro sirven escritos.
    expect((await f.check(f.tried[0]!)).json()).toMatchObject({ reason: "none" });
    // Recargar la pantalla no vuelve a llamar a Meta durante 10 minutos, ni dice «ya te mandamos varios».
    f.advance(MIN_1);
    expect((await f.start()).json()).toMatchObject({ method: "code_from_phone", reason: "not_sent" });
    expect(f.calls()).toBe(1);
    expect(await f.sends()).toEqual(["failed"]); // el intento rechazado sí cuenta
    f.advance(10 * 60_000);
    await f.start();
    expect(f.calls()).toBe(2);
  });

  it("un código que Meta rechaza nunca sirve, ni mientras Meta contesta; otra pestaña espera la misma respuesta", async () => {
    const meta = slowMeta();
    const f = await setup({ fail: 132001, gate: meta.gate });
    const first = f.start();
    const second = f.start(); // otra pestaña o una recarga mientras Meta contesta
    await until(() => meta.waiting.length === 1); // Meta ya tiene el código en la mano y no ha contestado
    const code = f.tried[0]!;
    expect((await f.check(code)).json()).toMatchObject({ reason: "none" }); // todavía no sirve
    meta.release();
    const [r1, r2] = [await first, await second];
    expect(r1.json()).toMatchObject({ method: "code_from_phone", reason: "not_sent", code: expect.stringMatching(/^\d{6}$/) });
    expect(r2.json()).toEqual(r1.json()); // la misma respuesta y el mismo código del respaldo, sin otro intento
    expect(f.calls()).toBe(1);
    expect((await f.check(code)).json()).toMatchObject({ reason: "none" }); // y después, tampoco
    expect(await f.state()).toBe(403);
    expect(await f.sends()).toEqual(["failed"]);
  });

  it("dos pestañas a la vez: un solo mensaje, y las dos esperan a que WhatsApp lo acepte", async () => {
    const meta = slowMeta();
    const f = await setup({ gate: meta.gate });
    const both = [f.start(), f.start({ resend: true })];
    await until(() => meta.waiting.length === 1);
    expect(await f.sends()).toEqual(["pending"]);
    meta.release();
    const [r1, r2] = await Promise.all(both);
    expect(r1!.json()).toMatchObject({ method: "code_to_phone", resend_in_s: 60 });
    expect(r2!.json()).toEqual(r1!.json());
    expect(f.calls()).toBe(1);
    expect(await f.sends()).toEqual(["sent"]);
    expect((await f.check(f.sent[0]!.code)).json()).toEqual({ verified: true });
  });

  it("muchos «reenviar» a la vez, en dos procesos: un solo mensaje; el otro proceso espera su turno", async () => {
    const meta = slowMeta();
    const f = await setup({ gate: meta.gate });
    const twin = f.twin();
    const here = Array.from({ length: 4 }, () => f.start({ resend: true }));
    await until(() => meta.waiting.length === 1);
    const there = await Promise.all(Array.from({ length: 4 }, () => f.start({ resend: true }, twin)));
    expect(there.map((r) => r.statusCode)).toEqual([429, 429, 429, 429]);
    expect(there[0]!.json()).toMatchObject({ method: "code_to_phone", error: "Espera un momento para pedir otro código.", retry_after_s: 60 });
    meta.release();
    expect((await Promise.all(here)).map((r) => r.statusCode)).toEqual([200, 200, 200, 200]);
    expect(f.calls()).toBe(1);
    expect(await f.sends()).toEqual(["sent"]);
  });

  it("si un reenvío no sale, el código que ya había llegado sigue sirviendo", async () => {
    const f = await setup();
    await f.start();
    f.ctl.fail = 131026;
    f.advance(MIN_1);
    expect((await f.start({ resend: true })).json()).toMatchObject({ method: "code_from_phone", reason: "not_sent" });
    expect((await f.check(f.sent[0]!.code)).json()).toEqual({ verified: true });
  });

  it("registrarse de nuevo no reinicia la espera tras un rechazo, y los rechazos cuentan para el tope por hora", async () => {
    const f = await setup({ fail: 131030 });
    await f.start();
    await f.reRegister();
    expect((await f.start()).json()).toMatchObject({ method: "code_from_phone", reason: "not_sent" });
    expect(f.calls()).toBe(1);
    // Pedir el respaldo a propósito conserva el motivo: el portal no ofrece «Mejor mándenme el código a mí».
    f.advance(21_000);
    expect((await f.start({ method: "code_from_phone" })).json()).toMatchObject({ method: "code_from_phone", reason: "not_sent" });
    for (let i = 0; i < 4; i++) { f.advance(10 * 60_000 + 1_000); await f.start(); }
    expect(f.calls()).toBe(5);
    f.advance(10 * 60_000 + 1_000);
    expect((await f.start()).json()).toMatchObject({ method: "code_from_phone", reason: "not_sent" });
    expect(f.calls()).toBe(5); // 5 intentos en la hora: ya no se llama a Meta
    expect(f.logs).toContainEqual(expect.objectContaining({ msg: "phone_code_limit" }));
  });

  it("10 códigos equivocados en 24 horas: ese celular ya no recibe códigos (solo el respaldo), aunque se registre de nuevo", async () => {
    const f = await setup();
    await f.start();
    for (let i = 0; i < 5; i++) await f.check(f.other(f.sent[0]!.code));
    f.advance(MIN_1);
    await f.start({ resend: true });
    const code = f.sent[1]!.code;
    for (let i = 0; i < 4; i++) expect((await f.check(f.other(code))).json()).toMatchObject({ reason: "wrong" });
    const tenth = await f.check(f.other(code));
    expect(tenth.statusCode).toBe(400);
    expect(tenth.json()).toEqual({ error: "Ese código no es y ya no quedan intentos. Pide un código nuevo.", reason: "wrong", attempts_left: 0 });
    expect(f.logs).toContainEqual(expect.objectContaining({ msg: "phone_code_locked" }));
    expect((await f.check(code)).json()).toMatchObject({ reason: "none" }); // ni el correcto
    f.advance(MIN_1);
    expect((await f.start({ resend: true })).json()).toMatchObject({ method: "code_from_phone", reason: "locked" });
    await f.reRegister();
    expect((await f.start()).json()).toMatchObject({ method: "code_from_phone", reason: "locked" });
    expect(f.calls()).toBe(2);
    f.advance(DAY);
    expect((await f.start()).json()).toMatchObject({ method: "code_to_phone" });
    expect(f.calls()).toBe(3);
  });

  it("tope diario de todo Cuadra: después, el respaldo sin llamar a Meta", async () => {
    const f = await setup({ dailyBudget: 2 });
    await f.start();
    const otro = await f.register("5522222222");
    const startAs = (cookie: string) =>
      f.server.inject({ method: "POST", url: "/api/auth/verify/start", headers: { cookie }, payload: { method: "code_to_phone" } });
    expect((await startAs(otro)).json()).toMatchObject({ method: "code_to_phone" });
    const tercero = await f.register("5523333333");
    expect((await startAs(tercero)).json()).toMatchObject({ method: "code_from_phone", reason: "not_sent" });
    expect(f.calls()).toBe(2);
    expect(f.logs).toContainEqual(expect.objectContaining({ msg: "phone_code_budget" }));
  });

  it("si se llega a los 10 equivocados mientras otro código va en camino, ese código ya no se guarda", async () => {
    const meta = slowMeta();
    let hold = false;
    const f = await setup({ gate: () => (hold ? meta.gate() : Promise.resolve()) });
    await f.start();
    for (let i = 0; i < 5; i++) await f.check(f.other(f.sent[0]!.code));
    f.advance(MIN_1);
    await f.start({ resend: true });
    for (let i = 0; i < 4; i++) await f.check(f.other(f.sent[1]!.code)); // 9 equivocados
    f.advance(MIN_1);
    hold = true;
    const inFlight = f.start({ resend: true }); // se apartó con 9: todavía se podía
    await until(() => meta.waiting.length === 1);
    expect((await f.check(f.other(f.sent[1]!.code))).json()).toMatchObject({ reason: "wrong", attempts_left: 0 }); // el décimo
    meta.release();
    expect((await inFlight).json()).toMatchObject({ method: "code_from_phone", reason: "locked" });
    expect((await f.check(f.tried[2]!)).json()).toMatchObject({ reason: "none" }); // llegó, pero no sirve
    expect(await f.db.select().from(schema.phoneCodeMisses)).toHaveLength(10);
  });

  it("los intentos que quedan nunca pasan de lo que le queda al celular hoy", async () => {
    const f = await setup();
    await f.start();
    for (let i = 0; i < 3; i++) await f.check(f.other(f.sent[0]!.code));
    f.advance(MIN_1);
    await f.start({ resend: true });
    for (let i = 0; i < 5; i++) await f.check(f.other(f.sent[1]!.code)); // 8 equivocados
    f.advance(MIN_1);
    await f.start({ resend: true });
    expect((await f.check(f.other(f.sent[2]!.code))).json()).toEqual({ error: "Ese código no es. Te queda 1 intento.", reason: "wrong", attempts_left: 1 });
    expect((await f.check(f.other(f.sent[2]!.code))).json()).toMatchObject({ reason: "wrong", attempts_left: 0 });
    expect((await f.check(f.sent[2]!.code)).json()).toMatchObject({ reason: "none" });
  });

  it("a lo más 10 intentos de envío al día por celular, aunque haya pasado la hora", async () => {
    const f = await setup();
    await f.start();
    for (let i = 0; i < 4; i++) { f.advance(MIN_1); await f.start({ resend: true }); }
    f.advance(60 * 60_000);
    for (let i = 0; i < 5; i++) { await f.start({ resend: true }); f.advance(MIN_1); }
    expect(f.calls()).toBe(10);
    f.advance(60 * 60_000);
    expect((await f.start({ resend: true })).json()).toMatchObject({ method: "code_from_phone", reason: "limit" });
    expect(f.calls()).toBe(10);
    f.advance(DAY);
    expect((await f.start({ resend: true })).json()).toMatchObject({ method: "code_to_phone" });
    expect(f.calls()).toBe(11);
  });

  it("un intento que se quedó «en camino» (p. ej. se reinició el proceso) detiene otros envíos solo 2 minutos", async () => {
    const f = await setup();
    await f.db.insert(schema.phoneCodeSends).values({ phone: "5521111111", sentAt: new Date(f.now().getTime() - 90_000), status: "pending" });
    const early = await f.start();
    expect(early.statusCode).toBe(429);
    expect(early.json()).toMatchObject({ retry_after_s: 30 });
    f.advance(31_000);
    expect((await f.start()).json()).toMatchObject({ method: "code_to_phone" });
    expect(f.calls()).toBe(1);
  });

  it("dos sesiones de la misma cuenta a la vez: el código del respaldo de una nunca le llega a la otra", async () => {
    const meta = slowMeta();
    const f = await setup({ fail: 131030, gate: meta.gate });
    const otra = cookieOf(await login(f.server, "2580", "5521111111")); // p. ej. alguien más con la cuenta abierta
    const mine = f.start();
    const theirs = f.server.inject({ method: "POST", url: "/api/auth/verify/start", headers: { cookie: otra }, payload: { method: "code_to_phone" } });
    await until(() => meta.waiting.length === 1);
    meta.release();
    const [m, t] = [(await mine).json(), (await theirs).json()];
    expect(m).toMatchObject({ method: "code_from_phone", reason: "not_sent", code: expect.stringMatching(/^\d{6}$/) });
    expect(t.code).not.toBe(m.code);
    // Ese código verifica solo la sesión que lo pidió.
    expect(await verifyPhoneByWhatsApp(f.db, "5521111111", m.message, f.now())).toEqual({ name: "Ana Ruiz" });
    expect(await f.state()).toBe(200);
    expect((await f.server.inject({ url: "/api/state", headers: { cookie: otra } })).statusCode).toBe(401);
  });

  it("una pestaña con el portal de antes (sin `method`) recibe el respaldo de siempre y no se manda nada", async () => {
    const f = await setup();
    const r = await f.start({ method: undefined }); // el cuerpo viaja como {}
    expect(r.json()).toMatchObject({ method: "code_from_phone", code: expect.stringMatching(/^\d{6}$/), link: expect.any(String) });
    expect(r.json().reason).toBeUndefined();
    expect(f.calls()).toBe(0);
  });
});

describe("perfil: cambios básicos de la cuenta", () => {
  it("sin sesión o sin verificar el celular, 401", async () => {
    const { server } = await app();
    expect((await server.inject({ url: "/api/auth/profile" })).statusCode).toBe(401);
    expect((await server.inject({ method: "POST", url: "/api/auth/pin", payload: { current: "2580", next: "1357" } })).statusCode).toBe(401);
    const w = await app({ verification: "whatsapp" });
    const cookie = cookieOf(await reg(w.server));
    expect((await w.server.inject({ url: "/api/auth/profile", headers: { cookie } })).statusCode).toBe(401);
    expect((await w.server.inject({ method: "POST", url: "/api/auth/profile", headers: { cookie }, payload: { name: "Otra" } })).statusCode).toBe(401);
  });

  it("lee y cambia el nombre y el de su tienda", async () => {
    const { server } = await app();
    const cookie = cookieOf(await reg(server));
    const p = (await server.inject({ url: "/api/auth/profile", headers: { cookie } })).json().profile;
    expect(p).toMatchObject({ name: "Lupe", phone_last4: "5678", can_rename_store: true, has_pin: true, llave: false });
    const r = await server.inject({ method: "POST", url: "/api/auth/profile", headers: { cookie }, payload: { name: "  Guadalupe   Ruiz ", store_name: "Abarrotes Lupita" } });
    expect(r.statusCode).toBe(200);
    expect(r.json().profile).toMatchObject({ name: "Guadalupe Ruiz", store_name: "Abarrotes Lupita" });
    expect((await server.inject({ url: "/api/auth/me", headers: { cookie } })).json().account.name).toBe("Guadalupe Ruiz");
    expect((await server.inject({ url: "/api/state", headers: { cookie } })).json().merchant.name).toBe("Abarrotes Lupita");
  });

  it("rechaza nombres vacíos o muy largos sin cambiar nada", async () => {
    const { server } = await app();
    const cookie = cookieOf(await reg(server));
    const bad = await server.inject({ method: "POST", url: "/api/auth/profile", headers: { cookie }, payload: { name: " " } });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().field).toBe("name");
    expect((await server.inject({ method: "POST", url: "/api/auth/profile", headers: { cookie }, payload: { store_name: "x".repeat(61) } })).json().field).toBe("store_name");
    expect((await server.inject({ method: "POST", url: "/api/auth/profile", headers: { cookie }, payload: {} })).statusCode).toBe(400);
    expect((await server.inject({ url: "/api/auth/profile", headers: { cookie } })).json().profile.name).toBe("Lupe");
  });

  it("solo el dueño de la tienda le cambia el nombre", async () => {
    const { server, db } = await app();
    const cookie = cookieOf(await reg(server));
    // Esta cuenta queda en la tienda de la demo, que es de otro celular.
    await db.update(schema.portalAccounts).set({ merchantId: DEMO.merchantId }).where(eq(schema.portalAccounts.phone, "5512345678"));
    expect((await server.inject({ url: "/api/auth/profile", headers: { cookie } })).json().profile.can_rename_store).toBe(false);
    const r = await server.inject({ method: "POST", url: "/api/auth/profile", headers: { cookie }, payload: { store_name: "Mía" } });
    expect(r.statusCode).toBe(403);
    const [m] = await db.select().from(schema.merchants).where(eq(schema.merchants.id, DEMO.merchantId));
    expect(m!.name).not.toBe("Mía");
  });

  it("cambiar el NIP pide el actual, cuenta intentos y cierra las otras sesiones", async () => {
    const { server } = await app();
    const cookie = cookieOf(await reg(server));
    const other = cookieOf(await login(server, "2580"));
    const pin = (current: string, next: string) => server.inject({ method: "POST", url: "/api/auth/pin", headers: { cookie }, payload: { current, next } });
    const wrong = await pin("1357", "2468");
    expect(wrong.statusCode).toBe(403);
    expect(wrong.json().error).toMatch(/quedan 4 intentos/);
    expect((await pin("2580", "1111")).json().field).toBe("next");
    expect((await pin("2580", "2580")).json().field).toBe("next");
    expect((await pin("2580", "1357")).statusCode).toBe(200);
    expect((await login(server, "2580")).statusCode).toBe(401);
    expect((await login(server, "1357")).statusCode).toBe(200);
    expect((await server.inject({ url: "/api/state", headers: { cookie } })).statusCode).toBe(200);
    expect((await server.inject({ url: "/api/state", headers: { cookie: other } })).statusCode).toBe(401);
  });

  it("con 5 NIP actuales equivocados la cuenta se bloquea", async () => {
    const { server } = await app();
    const cookie = cookieOf(await reg(server));
    const pin = (current: string) => server.inject({ method: "POST", url: "/api/auth/pin", headers: { cookie }, payload: { current, next: "1357" } });
    for (let i = 0; i < 4; i++) expect((await pin("9753")).statusCode).toBe(403);
    expect((await pin("9753")).json().error).toMatch(/espera 15 minutos/);
    expect((await pin("2580")).statusCode).toBe(429);
  });
});
