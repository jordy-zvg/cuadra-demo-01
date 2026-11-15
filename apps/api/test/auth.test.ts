import { readFileSync } from "node:fs";
import { RuleInterpreter } from "@cuadra/agents";
import { DEMO, schema, seedDemo } from "@cuadra/db";
import { createTestDb } from "@cuadra/db/testing";
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
      ["/assets/cuadra.css", "GET"], ["/assets/icons.svg", "GET"], ["/assets/fonts/montserrat-latin-wght-normal.woff2", "GET"],
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

async function app(opts: { shopCode?: string | null; secureCookies?: boolean; demoPassword?: string | null; llave?: "demo" | "off"; verification?: "whatsapp" | "off" } = {}) {
  const clock = { t: new Date("2026-11-14T15:00:00Z") };
  const now = () => new Date(clock.t);
  const { db } = await createTestDb();
  await seedDemo(db);
  const gateway = new SimulatedGateway(db);
  const registry = createStoreRegistry({
    db, liveGateway: gateway, interpreters: [new RuleInterpreter()], verify: async () => false, now, publicUrl: null,
    peyWebhookSecret: null, bankSim: false, udi: null, log: () => {},
  });
  const server = buildServer({
    db, registry, liveMerchantId: DEMO.merchantId, liveGateway: gateway, peyWebhookSecret: null, bankSim: false,
    demoPassword: opts.demoPassword ?? null, log: () => {},
    portalAuth: {
      shopCode: opts.shopCode ?? null, secureCookies: opts.secureCookies ?? false, llave: opts.llave ?? "off", now,
      ...(opts.verification ? { verification: { mode: opts.verification, waNumber: "15550001111" } } : {}),
    },
    passkey: { rpID: "localhost", origins: ["http://localhost"], now },
  });
  return { server, db, now, advance: (ms: number) => { clock.t = new Date(clock.t.getTime() + ms); } };
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
