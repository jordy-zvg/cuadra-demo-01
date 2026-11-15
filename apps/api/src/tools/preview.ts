/**
 * Vista previa local de las pantallas, sin Postgres ni llaves: base en memoria (PGlite), cobros
 * simulados, datos de demo y una conversación de ejemplo. Sirve para diseñar y revisar la interfaz.
 *
 *   pnpm --filter @cuadra/api preview                      → http://localhost:4100
 *   PREVIEW_VARIANTS="4101=/ruta/a/public" pnpm ... preview → otra carpeta de páginas en otro puerto
 *
 * Imprime la cookie de una cuenta de prueba (celular 5512345678, NIP 2580) para entrar sin teclear.
 * Nunca toca dinero real ni manda mensajes: todo es simulado.
 */
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { RuleInterpreter } from "@cuadra/agents";
import { parseUdiValue } from "@cuadra/core";
import { DEMO, schema, seedDemo } from "@cuadra/db";
import { createTestDb } from "@cuadra/db/testing";
import { SimulatedGateway } from "../gateway.js";
import { seedHistory } from "../seed-history.js";
import { buildServer } from "../server.js";
import { CuadraService } from "../service.js";

async function main(): Promise<void> {
  const { db } = await createTestDb();
  const now = () => new Date();
  await seedDemo(db, now(), { lupePhone: "5512345678" });
  await seedHistory(db, DEMO.merchantId);
  const gateway = new SimulatedGateway(db);
  const service = new CuadraService({
    db, merchantId: DEMO.merchantId, ownerId: DEMO.ownerId, interpreters: [new RuleInterpreter()], gateway,
    verify: async () => false, now, publicUrl: null, peyWebhookSecret: null, bankSim: true, udi: parseUdiValue("8.927827"), log: () => {},
    reminderMinIntervalMs: 0,
  });
  const build = (publicDir?: string) =>
    buildServer({
      db, service, merchantId: DEMO.merchantId, gateway, bankSim: true, log: () => {},
      portalAuth: { shopCode: null, secureCookies: false, llave: "demo" },
      passkey: { gateway, db, merchantId: DEMO.merchantId, ownerId: DEMO.ownerId, rpID: "localhost", origins: ["http://localhost"], now },
      ...(publicDir ? { publicDir } : {}),
    });

  // Conversación de ejemplo: fiado, cobro pagado, QR abierto, bloqueo del guard y una propuesta pendiente.
  const lastConfirm = async () => {
    const msgs = await db.select().from(schema.messages).orderBy(schema.messages.id);
    return msgs.filter((m) => m.actions?.some((a) => a.kind === "confirm")).at(-1)?.actions?.[0]?.proposal_id;
  };
  const say = (t: string) => service.handleMerchantMessage(t);
  const confirm = async () => { const p = await lastConfirm(); if (p) await service.confirm(p); };
  const steps: Array<() => Promise<void>> = [
    () => say("Doña Lupe se llevó $185"), confirm,
    () => say("Cóbrale a Doña Lupe"), confirm,
    () => say("Beto se llevó $80"), confirm,
    () => say("QR para Beto"),
    () => say("Págale ya a la cuenta 012180015826225713 $5,000"),
    () => say("¿Quién me debe?"),
    () => say("Chela se llevó $50"),
  ];
  for (const step of steps) await step().catch((e: unknown) => console.error("paso de ejemplo:", e instanceof Error ? e.message : e));

  const main = build();
  const port = Number(process.env.PORT ?? 4100);
  await main.listen({ port, host: "127.0.0.1" });
  const reg = await main.inject({ method: "POST", url: "/api/auth/register", payload: { name: "Mari López", phone: "5512345678", pin: "2580" } });
  const cookie = String(reg.headers["set-cookie"] ?? "").split(";")[0] ?? "";

  const variants = (process.env.PREVIEW_VARIANTS ?? "").split(",").map((v) => v.trim()).filter(Boolean);
  const ports: Record<string, string> = { [String(port)]: "apps/api/public" };
  for (const v of variants) {
    const [p, dir] = v.split("=");
    if (!p || !dir) continue;
    await build(resolve(dir)).listen({ port: Number(p), host: "127.0.0.1" });
    ports[p] = resolve(dir);
  }
  const info = { cookie, ports, account: { phone: "5512345678", pin: "2580" } };
  if (process.env.PREVIEW_INFO) writeFileSync(process.env.PREVIEW_INFO, JSON.stringify(info, null, 2));
  console.log(JSON.stringify({ msg: "preview_ready", ...info }));
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
