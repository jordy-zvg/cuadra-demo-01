/**
 * Proceso executor: ÚNICO con credenciales del proveedor de pagos.
 * Consume la cola "outflows" (solo { proposal_id }) y revalida todo antes de enviar.
 */
import {
  FintocPaymentProvider,
  MockPaymentProvider,
  type PaymentProvider,
  verifyProposalAssertion,
} from "@cuadra/adapters";
import { parseHourRange } from "@cuadra/core";
import { connectPostgres } from "@cuadra/db/node";
import { Worker } from "bullmq";
import { Redis } from "ioredis";
import { executeOutflow } from "./execute.js";

export const OUTFLOW_QUEUE = "outflows";

function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Falta la variable de entorno ${name}`);
  return v;
}

function log(record: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify({ ts: new Date().toISOString(), service: "executor", ...record })}\n`);
}

function buildProvider(): PaymentProvider {
  const kind = env("PAYMENTS_PROVIDER");
  if (kind === "mock") return new MockPaymentProvider(env("MOCK_WEBHOOK_SECRET"));
  if (kind === "fintoc") {
    return new FintocPaymentProvider({
      secretKey: env("FINTOC_SECRET_KEY"),
      jwsPrivateKeyPem: env("FINTOC_JWS_PRIVATE_KEY"),
      accountId: env("FINTOC_ACCOUNT_ID"),
    });
  }
  throw new Error(`Proveedor de pagos no soportado: ${kind}`);
}

async function main(): Promise<void> {
  const { db } = await connectPostgres(env("DATABASE_URL"));
  const provider = buildProvider();
  const config = { rpID: env("WEBAUTHN_RP_ID"), origins: env("WEBAUTHN_ORIGINS").split(",") };
  // Solo demo: OUTFLOW_HOURS="0-24" quita el horario de R10; debe ser la misma que en la API.
  const outflowHours = parseHourRange(process.env.OUTFLOW_HOURS || undefined);
  if (process.env.OUTFLOW_HOURS && !outflowHours) log({ msg: "config_invalid", variable: "OUTFLOW_HOURS" });
  const connection = new Redis(env("REDIS_URL"), { maxRetriesPerRequest: null });

  const worker = new Worker(
    OUTFLOW_QUEUE,
    (job) =>
      executeOutflow(job.data, {
        db,
        provider,
        verify: (a) => verifyProposalAssertion({ ...a, config }),
        now: () => new Date(),
        log,
        ...(outflowHours ? { outflowHours } : {}),
      }),
    { connection, concurrency: 1 },
  );
  worker.on("failed", (job, err) => log({ msg: "job_failed", job_id: job?.id, error: err.message }));
  log({ msg: "executor_started", provider: provider.name, outflow_hours: outflowHours ?? [7, 22] });
}

main().catch((e: unknown) => {
  log({ msg: "fatal", error: e instanceof Error ? e.message : String(e) });
  process.exit(1);
});
