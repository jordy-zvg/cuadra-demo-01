import { PeyClient, WhatsAppClient, verifyProposalAssertion } from "@cuadra/adapters";
import { parseUdiValue } from "@cuadra/core";
import { AnthropicInterpreter, FallbackInterpreter, type Interpreter, RuleInterpreter } from "@cuadra/agents";
import { connectPostgres, migratePostgres } from "@cuadra/db/node";
import { assignAccountStores, schema, seedDemo } from "@cuadra/db";
import { eq } from "drizzle-orm";
import { type ChargeGateway, PeyGateway, SimulatedGateway } from "./gateway.js";
import { seedHistory } from "./seed-history.js";
import { buildServer } from "./server.js";
import { createStoreRegistry } from "./app.js";
import { WhatsAppChannel } from "./whatsapp.js";
import { parsePortalReset, resetPortalAccounts } from "./portal-reset.js";
import { parseMinIntervalMinutes } from "./reminder-config.js";
import { parseReminderSchedule, startReminderScheduler } from "./scheduler.js";

const env = (k: string) => process.env[k] || undefined;
const req = (k: string) => {
  const v = env(k);
  if (!v) throw new Error(`Falta la variable de entorno ${k}`);
  return v;
};
function log(r: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify({ ts: new Date().toISOString(), service: "api", ...r })}\n`);
}

async function main(): Promise<void> {
  const { db, pool } = await connectPostgres(req("DATABASE_URL"));
  const applied = await migratePostgres(pool);
  const demo = await seedDemo(db, new Date(), {
    ...(env("DEMO_CUSTOMER_PHONE") ? { lupePhone: env("DEMO_CUSTOMER_PHONE")! } : {}),
    ...(env("DEMO_OWNER_PHONE") ? { ownerPhone: env("DEMO_OWNER_PHONE")! } : {}),
  });
  // Borrado de cuentas del portal pedido por el dueño (NIP olvidado). Ver portal-reset.ts.
  const reset = parsePortalReset(process.env.PORTAL_RESET);
  if (reset.invalid.length) log({ msg: "config_invalid", variable: "PORTAL_RESET", entries: reset.invalid });
  if (reset.entries.length) {
    for (const r of await resetPortalAccounts(db, reset.entries)) log({ msg: "portal_account_reset", ...r });
  }
  const bankSim = env("BANK_SIM") !== "off";
  // Cuenta receptora del comercio registrada en pey (POST /bank-account, estado ACTIVE).
  if (env("PEY_BANK_ACCOUNT_ID")) {
    await db.update(schema.merchants).set({ peyBankAccountId: env("PEY_BANK_ACCOUNT_ID")! }).where(eq(schema.merchants.id, demo.merchantId));
  }
  if (bankSim) await seedHistory(db, demo.merchantId);

  const peyKey = env("PEY_API_KEY");
  const gateway: ChargeGateway = peyKey ? new PeyGateway(new PeyClient({ apiKey: peyKey })) : new SimulatedGateway(db);
  const publicUrl = env("PUBLIC_URL")?.replace(/\/$/, "") ?? null;
  const rpID = env("WEBAUTHN_RP_ID") ?? (publicUrl ? new URL(publicUrl).hostname : "localhost");
  const origins = (env("WEBAUTHN_ORIGINS") ?? publicUrl ?? "http://localhost:3000").split(",");

  // BRIEF §9: tres extracciones independientes con consenso. Sin llave de Anthropic, reglas.
  const rules = new RuleInterpreter();
  const interpreters: Interpreter[] = env("ANTHROPIC_API_KEY")
    ? [1, 2, 3].map(() => new FallbackInterpreter(new AnthropicInterpreter(), rules))
    : [rules];

  // WhatsApp Cloud API: se activa solo con las cuatro variables; si no, queda el chat web.
  const waToken = env("WHATSAPP_TOKEN");
  const waPhoneId = env("WHATSAPP_PHONE_NUMBER_ID");
  const waSecret = env("WHATSAPP_APP_SECRET");
  const waVerify = env("WHATSAPP_VERIFY_TOKEN");
  const whatsapp =
    waToken && waPhoneId && waSecret && waVerify
      ? {
          channel: new WhatsAppChannel({
            db,
            client: new WhatsAppClient({ token: waToken, phoneNumberId: waPhoneId, ...(env("WHATSAPP_GRAPH_VERSION") ? { version: env("WHATSAPP_GRAPH_VERSION")! } : {}) }),
            log,
          }),
          appSecret: waSecret,
          verifyToken: waVerify,
        }
      : undefined;

  // Política de recordatorios: 72 h entre cobros al mismo cliente. Solo en desarrollo se baja
  // (REMINDER_MIN_INTERVAL_MINUTES=0) para probar seguido; un valor inválido deja la política normal.
  const interval = parseMinIntervalMinutes(process.env.REMINDER_MIN_INTERVAL_MINUTES);
  const reminderMinIntervalMs = interval.ms;
  if (interval.invalid) log({ msg: "config_invalid", variable: "REMINDER_MIN_INTERVAL_MINUTES" });
  if (reminderMinIntervalMs !== undefined && !gateway.simulated) {
    log({ msg: "reminder_interval_override", minutes: reminderMinIntervalMs / 60_000, warning: "solo para desarrollo; en producción debe quedar sin definir" });
  }

  // Una tienda por persona. Solo la demo (dueña de la cuenta receptora en pey) cobra en vivo; las
  // tiendas nuevas cobran y pagan en simulado hasta que registren su propia cuenta.
  await db.update(schema.merchants).set({ livePayments: !gateway.simulated }).where(eq(schema.merchants.id, demo.merchantId));
  const moved = await assignAccountStores(db, new Date());
  if (moved) log({ msg: "portal_accounts_moved_to_own_store", accounts: moved });
  const registry = createStoreRegistry({
    db,
    liveGateway: gateway,
    interpreters,
    verify: (a) => verifyProposalAssertion({ ...a, config: { rpID, origins } }),
    now: () => new Date(),
    publicUrl,
    peyWebhookSecret: env("PEY_WEBHOOK_SECRET") ?? null,
    bankSim,
    udi: env("UDI_VALOR") ? parseUdiValue(env("UDI_VALOR")!) : null,
    // Solo desarrollo/demo: REMINDER_MIN_INTERVAL_MINUTES=0 o 1 permite repetir el recordatorio (normal: 72 h).
    ...(reminderMinIntervalMs !== undefined ? { reminderMinIntervalMs } : {}),
    log,
    ...(whatsapp ? { channels: [whatsapp.channel] } : {}),
  });
  const demoStore = await registry.get(demo.merchantId);
  if (!demoStore) throw new Error("La tienda de demo no tiene dueño");
  const service = demoStore.service;
  const app = buildServer({
    db,
    registry,
    liveMerchantId: demo.merchantId,
    liveGateway: gateway,
    peyWebhookSecret: env("PEY_WEBHOOK_SECRET") ?? null,
    bankSim,
    demoPassword: env("DEMO_PASSWORD") ?? null,
    // Registro en el portal: si PORTAL_SHOP_CODE existe, pedirlo (lo da el dueño); si no, registro abierto.
    portalAuth: { shopCode: env("PORTAL_SHOP_CODE") ?? null, secureCookies: publicUrl?.startsWith("https://") ?? false,
      // Llave CDMX: solo modo demo (simulado) mientras no haya alta con la ADIP. LLAVE_CDMX=off lo quita.
      llave: env("LLAVE_CDMX") === "off" ? "off" : "demo" },
    passkey: { rpID, origins, now: () => new Date() },
    log,
    ...(whatsapp ? { whatsapp } : {}),
  });
  // Recordatorios programados: REMINDER_DAYS="5" (viernes) o "1,5", REMINDER_HOUR="10". Sin ellas, apagado.
  const schedule = parseReminderSchedule(env("REMINDER_DAYS"), env("REMINDER_HOUR"));
  if (schedule) {
    startReminderScheduler({ db, merchantId: demo.merchantId, schedule, run: () => service.runScheduledReminders(), now: () => new Date(), log });
  }
  // Conciliación por transacción contra pey: al arrancar y cada PEY_RECONCILE_MS (5 min).
  if (!gateway.simulated) {
    const run = () =>
      service.reconcileProvider().catch((e: unknown) => log({ msg: "provider_reconciliation_error", error: e instanceof Error ? e.message : String(e) }));
    setTimeout(run, 15_000);
    setInterval(run, Number(env("PEY_RECONCILE_MS") ?? 5 * 60_000));
  }
  const port = Number(env("PORT") ?? 3000);
  await app.listen({ port, host: "0.0.0.0" });
  log({ msg: "api_started", port, migrations: applied, gateway: gateway.name, simulated: gateway.simulated, interpreter: interpreters[0]!.name, whatsapp: Boolean(whatsapp), reminders: schedule, reminder_interval_minutes: reminderMinIntervalMs === undefined ? 72 * 60 : reminderMinIntervalMs / 60_000 });
}

main().catch((e: unknown) => {
  log({ msg: "fatal", error: e instanceof Error ? e.message : String(e) });
  process.exit(1);
});
