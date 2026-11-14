import { PeyClient, WhatsAppClient, verifyProposalAssertion } from "@cuadra/adapters";
import { parseUdiValue } from "@cuadra/core";
import { AnthropicInterpreter, FallbackInterpreter, type Interpreter, RuleInterpreter } from "@cuadra/agents";
import { connectPostgres, migratePostgres } from "@cuadra/db/node";
import { type MessageAction, schema, seedDemo } from "@cuadra/db";
import { eq } from "drizzle-orm";
import { type ChargeGateway, PeyGateway, SimulatedGateway } from "./gateway.js";
import { seedHistory } from "./seed-history.js";
import { buildServer } from "./server.js";
import { CuadraService } from "./service.js";
import { WhatsAppChannel } from "./whatsapp.js";
import { parseReminderSchedule, startReminderScheduler } from "./scheduler.js";
import type { TemplateRef } from "./whatsapp-templates.js";

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
    ...(env("DEMO_MERCHANT_PHONE") ? { ownerPhone: env("DEMO_MERCHANT_PHONE")! } : {}),
  });
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
            merchantId: demo.merchantId,
            ownerId: demo.ownerId,
            client: new WhatsAppClient({ token: waToken, phoneNumberId: waPhoneId, ...(env("WHATSAPP_GRAPH_VERSION") ? { version: env("WHATSAPP_GRAPH_VERSION")! } : {}) }),
            log,
          }),
          appSecret: waSecret,
          verifyToken: waVerify,
        }
      : undefined;

  const service = new CuadraService({
    db,
    merchantId: demo.merchantId,
    ownerId: demo.ownerId,
    interpreters,
    gateway,
    verify: (a) => verifyProposalAssertion({ ...a, config: { rpID, origins } }),
    now: () => new Date(),
    publicUrl,
    peyWebhookSecret: env("PEY_WEBHOOK_SECRET") ?? null,
    bankSim,
    udi: env("UDI_VALOR") ? parseUdiValue(env("UDI_VALOR")!) : null,
    log,
    ...(whatsapp ? { deliver: (t: string, b: string, a?: MessageAction[], tpl?: TemplateRef) => whatsapp.channel.deliver(t, b, a, tpl) } : {}),
  });
  const app = buildServer({
    db,
    service,
    merchantId: demo.merchantId,
    gateway,
    bankSim,
    passkey: { gateway, db, merchantId: demo.merchantId, ownerId: demo.ownerId, rpID, origins, now: () => new Date() },
    log,
    ...(whatsapp ? { whatsapp } : {}),
  });
  // Recordatorios programados: REMINDER_DAYS="5" (viernes) o "1,5", REMINDER_HOUR="10". Sin ellas, apagado.
  const schedule = parseReminderSchedule(env("REMINDER_DAYS"), env("REMINDER_HOUR"));
  if (schedule) {
    startReminderScheduler({ db, merchantId: demo.merchantId, schedule, run: () => service.runScheduledReminders(), now: () => new Date(), log });
  }
  const port = Number(env("PORT") ?? 3000);
  await app.listen({ port, host: "0.0.0.0" });
  log({ msg: "api_started", port, migrations: applied, gateway: gateway.name, simulated: gateway.simulated, interpreter: interpreters[0]!.name, whatsapp: Boolean(whatsapp), reminders: schedule });
}

main().catch((e: unknown) => {
  log({ msg: "fatal", error: e instanceof Error ? e.message : String(e) });
  process.exit(1);
});
