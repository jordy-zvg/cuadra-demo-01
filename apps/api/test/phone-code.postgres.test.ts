import { RuleInterpreter } from "@cuadra/agents";
import { DEMO, schema, seedDemo } from "@cuadra/db";
import type { Db } from "@cuadra/db";
import { connectPostgres, migratePostgres } from "@cuadra/db/node";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { createStoreRegistry } from "../src/app.js";
import { SimulatedGateway } from "../src/gateway.js";
import { buildServer } from "../src/server.js";

/**
 * El candado por celular del código por WhatsApp, contra Postgres REAL con dos procesos de la API (dos
 * pools de conexiones). PGlite corre una transacción a la vez, así que ahí estas carreras no se pueden
 * dar. Para forzarlas, se bloquea phone_code_misses (lo primero que leen el envío y la revisión del
 * código): todas las peticiones se forman ahí a la vez y se sueltan juntas. Sin el candado, saldrían
 * dos mensajes por celular y se compararían más códigos de los permitidos.
 *
 * Corre si TEST_DATABASE_URL apunta a un Postgres desechable con permiso de crear bases: crea la suya y
 * la borra al terminar (en CI, el servicio de Postgres del workflow).
 */
const url = process.env.TEST_DATABASE_URL;

async function withDatabase(run: (dbUrl: string) => Promise<void>) {
  const admin = await connectPostgres(url!);
  const name = `cuadra_code_${process.pid}_${Date.now()}`;
  await admin.pool.query(`CREATE DATABASE ${name}`);
  const u = new URL(url!);
  u.pathname = `/${name}`;
  try {
    await run(u.toString());
  } finally {
    // pool.end() termina sin esperar a que Postgres cierre cada conexión; se espera a que se vayan antes
    // de borrar la base (si no, sus clientes reciben el aviso de cierre como error sin atender).
    for (let i = 0; i < 100; i++) {
      const r = await admin.pool.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = $1", [name]);
      if (r.rows[0].n === 0) break;
      await new Promise((ok) => setTimeout(ok, 50));
    }
    await admin.pool.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await admin.pool.end();
  }
}

function serverOn(db: Db, sendCode: (phone10: string, code: string) => Promise<void>) {
  const now = () => new Date();
  const gateway = new SimulatedGateway(db);
  const registry = createStoreRegistry({
    db, liveGateway: gateway, interpreters: [new RuleInterpreter()], verify: async () => false, now, publicUrl: null,
    peyWebhookSecret: null, bankSim: false, udi: null, log: () => {},
  });
  return buildServer({
    db, registry, liveMerchantId: DEMO.merchantId, liveGateway: gateway, peyWebhookSecret: null, bankSim: false,
    demoPassword: null, log: () => {},
    portalAuth: { shopCode: null, secureCookies: false, llave: "off", now, verification: { mode: "whatsapp", waNumber: "15550001111", sendCode } },
    passkey: { rpID: "localhost", origins: ["http://localhost"], now },
  });
}

/** Bloquea phone_code_misses, corre `fire`, espera a que `waiting` transacciones estén formadas y suelta. */
async function queuedTogether<T>(dbUrl: string, waiting: number, fire: () => Promise<T>): Promise<T> {
  const blocker = await connectPostgres(dbUrl);
  const c = await blocker.pool.connect();
  try {
    await c.query("BEGIN");
    await c.query("LOCK TABLE phone_code_misses IN ACCESS EXCLUSIVE MODE");
    const all = fire();
    for (let i = 0; i < 250; i++) {
      const r = await blocker.pool.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND datname = current_database()");
      if (r.rows[0].n >= waiting) break;
      await new Promise((ok) => setTimeout(ok, 20));
    }
    await c.query("COMMIT");
    return await all;
  } finally {
    c.release();
    await blocker.pool.end();
  }
}

describe.skipIf(!url)("código por WhatsApp con Postgres real (dos procesos)", () => {
  it("pedidos a la vez desde dos procesos: un solo mensaje por celular", async () => {
    await withDatabase(async (dbUrl) => {
      const a = await connectPostgres(dbUrl);
      const b = await connectPostgres(dbUrl);
      try {
        await migratePostgres(a.pool);
        await seedDemo(a.db);
        const calls = new Map<string, number>();
        const sendCode = async (phone10: string) => {
          calls.set(phone10, (calls.get(phone10) ?? 0) + 1);
          await new Promise((ok) => setTimeout(ok, 100)); // Meta tardando
        };
        const A = serverOn(a.db, sendCode);
        const B = serverOn(b.db, sendCode);
        const phones = ["5531000001", "5531000002", "5531000003", "5531000004"];
        const cookies: string[] = [];
        for (const phone of phones) {
          const r = await A.inject({ method: "POST", url: "/api/auth/register", payload: { name: "Ana Ruiz", phone, pin: "2580" } });
          cookies.push(String(r.headers["set-cookie"]).split(";")[0]!);
        }
        const start = (s: typeof A, cookie: string) =>
          s.inject({ method: "POST", url: "/api/auth/verify/start", headers: { cookie }, payload: { method: "code_to_phone", resend: true } });
        // Por celular, una transacción en cada proceso (las de la misma sesión en un proceso se juntan).
        const res = await queuedTogether(dbUrl, phones.length * 2, () =>
          Promise.all(cookies.flatMap((cookie) => [start(A, cookie), start(B, cookie), start(A, cookie), start(B, cookie)])));
        expect([...calls.values()]).toEqual([1, 1, 1, 1]);
        expect(res.filter((r) => r.statusCode === 200)).toHaveLength(phones.length * 2);
        expect(res.filter((r) => r.statusCode === 429)).toHaveLength(phones.length * 2);
        expect(await a.db.select().from(schema.phoneCodeSends)).toHaveLength(phones.length);
        await A.close();
        await B.close();
      } finally {
        await a.pool.end();
        await b.pool.end();
      }
    });
  }, 60_000);

  it("si el 10.º equivocado y la respuesta de WhatsApp a otro código llegan juntos, ese código no queda guardado", async () => {
    await withDatabase(async (dbUrl) => {
      const a = await connectPostgres(dbUrl);
      try {
        await migratePostgres(a.pool);
        await seedDemo(a.db);
        const sent = new Map<string, string[]>();
        let hold = false;
        let gate: (() => void) | null = null;
        const S = serverOn(a.db, async (phone10, code) => {
          if (hold) await new Promise<void>((ok) => { gate = ok; });
          sent.set(phone10, [...(sent.get(phone10) ?? []), code]);
        });
        const waiting = async () =>
          (await a.pool.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND datname = current_database()")).rows[0].n;
        let storedAfterLock = 0;
        // Sin el candado en la revisión, esto pasa en cerca de la mitad de las rondas.
        for (let i = 0; i < 10; i++) {
          const phone = `55340000${String(i).padStart(2, "0")}`;
          const r = await S.inject({ method: "POST", url: "/api/auth/register", payload: { name: "Ana Ruiz", phone, pin: "2580" } });
          const cookie = String(r.headers["set-cookie"]).split(";")[0]!;
          hold = false;
          await S.inject({ method: "POST", url: "/api/auth/verify/start", headers: { cookie }, payload: { method: "code_to_phone" } });
          await a.db.insert(schema.phoneCodeMisses).values(Array.from({ length: 9 }, () => ({ phone, missedAt: new Date() })));
          await a.pool.query("UPDATE phone_code_sends SET sent_at = sent_at - interval '2 minutes' WHERE phone = $1", [phone]); // ya pasó el minuto
          hold = true;
          const resend = S.inject({ method: "POST", url: "/api/auth/verify/start", headers: { cookie }, payload: { method: "code_to_phone", resend: true } });
          for (let k = 0; k < 400 && !gate; k++) await new Promise((ok) => setTimeout(ok, 5)); // Meta ya tiene el código nuevo
          const blocker = await a.pool.connect();
          await blocker.query("BEGIN");
          await blocker.query("LOCK TABLE phone_code_misses IN ACCESS EXCLUSIVE MODE");
          const wrong = sent.get(phone)![0] === "123456" ? "654321" : "123456";
          const check = S.inject({ method: "POST", url: "/api/auth/verify/check", headers: { cookie }, payload: { code: wrong } });
          await new Promise((ok) => setTimeout(ok, 30));
          const release = gate!;
          gate = null;
          hold = false;
          release(); // WhatsApp acepta el código nuevo mientras se revisa el 10.º equivocado
          for (let k = 0; k < 200 && (await waiting()) < 2; k++) await new Promise((ok) => setTimeout(ok, 10));
          await blocker.query("COMMIT");
          blocker.release();
          await Promise.all([resend, check]);
          const acc = (await a.pool.query("SELECT otp_hash FROM portal_accounts WHERE phone = $1", [phone])).rows[0];
          const misses = (await a.pool.query("SELECT count(*)::int AS n FROM phone_code_misses WHERE phone = $1", [phone])).rows[0].n;
          expect(misses).toBe(10);
          if (acc.otp_hash) storedAfterLock++;
        }
        expect(storedAfterLock).toBe(0);
        await S.close();
      } finally {
        await a.pool.end();
      }
    });
  }, 120_000);

  it("con 9 equivocados, cinco códigos a la vez: solo se compara uno y el celular queda bloqueado", async () => {
    await withDatabase(async (dbUrl) => {
      const a = await connectPostgres(dbUrl);
      const b = await connectPostgres(dbUrl);
      try {
        await migratePostgres(a.pool);
        await seedDemo(a.db);
        const sent: string[] = [];
        const sendCode = async (_phone10: string, code: string) => { sent.push(code); };
        const A = serverOn(a.db, sendCode);
        const B = serverOn(b.db, sendCode);
        const phone = "5532000001";
        const r = await A.inject({ method: "POST", url: "/api/auth/register", payload: { name: "Ana Ruiz", phone, pin: "2580" } });
        const cookie = String(r.headers["set-cookie"]).split(";")[0]!;
        await A.inject({ method: "POST", url: "/api/auth/verify/start", headers: { cookie }, payload: { method: "code_to_phone" } });
        const wrong = sent[0] === "123456" ? "654321" : "123456";
        await a.db.insert(schema.phoneCodeMisses).values(Array.from({ length: 9 }, () => ({ phone, missedAt: new Date() })));
        const check = (s: typeof A) => s.inject({ method: "POST", url: "/api/auth/verify/check", headers: { cookie }, payload: { code: wrong } });
        const res = await queuedTogether(dbUrl, 5, () => Promise.all([check(A), check(B), check(A), check(B), check(A)]));
        expect(res.filter((x) => x.json().reason === "wrong")).toHaveLength(1);
        expect(res.filter((x) => x.statusCode === 410)).toHaveLength(4);
        expect(await a.db.select().from(schema.phoneCodeMisses).where(eq(schema.phoneCodeMisses.phone, phone))).toHaveLength(10);
        await A.close();
        await B.close();
      } finally {
        await a.pool.end();
        await b.pool.end();
      }
    });
  }, 60_000);
});
