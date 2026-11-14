/**
 * Verificación manual de pey contra la API real. No imprime la llave.
 *
 *   PEY_API_KEY=... pnpm pey:check transacciones
 *   PEY_API_KEY=... pnpm pey:check cuenta-alta <CLABE> "<Titular>"
 *   PEY_API_KEY=... pnpm pey:check cuenta <bankAccountId>
 *   PEY_API_KEY=... pnpm pey:check cobro <celular10> [pesos=0.01] [bankAccountId]
 *   PEY_API_KEY=... pnpm pey:check qr [pesos=0.01] [bankAccountId]
 *   PEY_API_KEY=... pnpm pey:check transaccion <transactionId>
 */
import { PeyApiError, PeyClient, pesosToCents } from "@cuadra/adapters";

const [cmd, ...args] = process.argv.slice(2);
const key = process.env.PEY_API_KEY;
if (!key) {
  process.stderr.write("Falta PEY_API_KEY en el entorno.\n");
  process.exit(2);
}
const pey = new PeyClient({ apiKey: key });
const out = (x: unknown) =>
  process.stdout.write(`${JSON.stringify(x, (_k, v) => (typeof v === "bigint" ? `${v} (centavos)` : v), 2)}\n`);
const cents = (s: string | undefined) => pesosToCents(Number(s ?? "0.01"));

try {
  switch (cmd) {
    case "transacciones": {
      const r = await pey.listTransactions();
      out({ total_en_pagina: r.items.length, siguiente: r.nextToken, ultimas: r.items.slice(0, 5) });
      break;
    }
    case "cuenta-alta":
      out(await pey.registerBankAccount({ clabe: args[0] ?? "", name: args[1] ?? "", alias: `Cuadra · ${args[1] ?? ""}`, entity: "PERSON" }));
      break;
    case "cuenta":
      out(await pey.getBankAccount(args[0] ?? ""));
      break;
    case "cobro":
      out(
        await pey.createPushNotification({
          phone10: args[0] ?? "",
          amount_cents: cents(args[1]),
          concept: "Prueba Cuadra",
          expiration_s: 600,
          ...(args[2] ? { bank_account_id: args[2] } : {}),
          metadata: { cuadra_prueba: "si" },
        }),
      );
      break;
    case "qr": {
      const r = await pey.createQr({ amount_cents: cents(args[0]), concept: "Prueba Cuadra", expiration_s: 600, ...(args[1] ? { bank_account_id: args[1] } : {}) });
      out({ id: r.id, qrString: r.qrString });
      break;
    }
    case "transaccion":
      out(await pey.getTransaction(args[0] ?? ""));
      break;
    default:
      process.stderr.write("Comandos: transacciones | cuenta-alta <CLABE> <titular> | cuenta <id> | cobro <celular> [pesos] [cuenta] | qr [pesos] [cuenta] | transaccion <id>\n");
      process.exit(2);
  }
} catch (e) {
  if (e instanceof PeyApiError) out({ error: e.message, status: e.status, type: e.type, requestId: e.requestId });
  else out({ error: e instanceof Error ? e.message : String(e) });
  process.exit(1);
}
