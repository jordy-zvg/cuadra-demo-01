import { PeyClient, verifyProposalAssertion } from "@cuadra/adapters";
import { RuleInterpreter } from "@cuadra/agents";
import { connectPostgres, migratePostgres } from "@cuadra/db/node";
import { seedDemo } from "@cuadra/db";
import { type ChargeGateway, PeyGateway, SimulatedGateway } from "./gateway.js";
import { seedHistory } from "./seed-history.js";
import { buildServer } from "./server.js";
import { CuadraService } from "./service.js";

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
  const demo = await seedDemo(db, new Date(), { ...(env("DEMO_CUSTOMER_PHONE") ? { lupePhone: env("DEMO_CUSTOMER_PHONE")! } : {}) });
  const bankSim = env("BANK_SIM") !== "off";
  if (bankSim) await seedHistory(db, demo.merchantId);

  const peyKey = env("PEY_API_KEY");
  const gateway: ChargeGateway = peyKey ? new PeyGateway(new PeyClient({ apiKey: peyKey })) : new SimulatedGateway(db);
  const publicUrl = env("PUBLIC_URL")?.replace(/\/$/, "") ?? null;
  const rpID = env("WEBAUTHN_RP_ID") ?? (publicUrl ? new URL(publicUrl).hostname : "localhost");
  const origins = (env("WEBAUTHN_ORIGINS") ?? publicUrl ?? "http://localhost:3000").split(",");

  const service = new CuadraService({
    db,
    merchantId: demo.merchantId,
    ownerId: demo.ownerId,
    interpreters: [new RuleInterpreter()],
    gateway,
    verify: (a) => verifyProposalAssertion({ ...a, config: { rpID, origins } }),
    now: () => new Date(),
    publicUrl,
    peyWebhookSecret: env("PEY_WEBHOOK_SECRET") ?? null,
    bankSim,
    log,
  });
  const app = buildServer({
    db,
    service,
    merchantId: demo.merchantId,
    gateway,
    bankSim,
    passkey: { db, merchantId: demo.merchantId, ownerId: demo.ownerId, rpID, origins, now: () => new Date() },
    log,
  });
  const port = Number(env("PORT") ?? 3000);
  await app.listen({ port, host: "0.0.0.0" });
  log({ msg: "api_started", port, migrations: applied, gateway: gateway.name, simulated: gateway.simulated });
}

main().catch((e: unknown) => {
  log({ msg: "fatal", error: e instanceof Error ? e.message : String(e) });
  process.exit(1);
});
