/**
 * Arma el registro de tiendas con la configuración del proceso. Lo usan el arranque (main.ts), la
 * vista previa local y los tests, para que todos construyan las tiendas igual.
 */
import type { AssertionVerifier, Db } from "@cuadra/db";
import type { Interpreter } from "@cuadra/agents";
import type { UdiMicro } from "@cuadra/core";
import type { OutboundChannel } from "./channel.js";
import { type ChargeGateway, SimulatedGateway } from "./gateway.js";
import { CuadraService } from "./service.js";
import { StoreRegistry } from "./stores.js";

export interface StoresConfig {
  db: Db;
  /** Pasarela de la tienda en vivo (pey con llave); sin llave, la simulada. */
  liveGateway: ChargeGateway;
  interpreters: Interpreter[];
  verify: AssertionVerifier;
  now: () => Date;
  publicUrl: string | null;
  peyWebhookSecret: string | null;
  bankSim: boolean;
  udi: UdiMicro | null;
  log: (r: Record<string, unknown>) => void;
  channels?: OutboundChannel[];
  reminderMinIntervalMs?: number;
  /** Al confirmar un fiado, avisar al cliente y mandar la solicitud CoDi (AUTO_COBRO_FIADO). */
  chargeOnFiado?: boolean;
  /** Horario de cobros [desde, hasta) en CDMX (REMINDER_HOURS, solo demo); sin valor: 9 a 20. */
  reminderHours?: readonly [number, number];
}

export function createStoreRegistry(c: StoresConfig): StoreRegistry {
  const simulated = c.liveGateway.simulated ? c.liveGateway : new SimulatedGateway(c.db);
  return new StoreRegistry({
    db: c.db,
    liveGateway: c.liveGateway,
    simulatedGateway: simulated,
    build: ({ merchantId, ownerId, gateway }) =>
      new CuadraService({
        db: c.db,
        merchantId,
        ownerId,
        interpreters: c.interpreters,
        gateway,
        verify: c.verify,
        now: c.now,
        publicUrl: c.publicUrl,
        peyWebhookSecret: c.peyWebhookSecret,
        bankSim: c.bankSim,
        udi: c.udi,
        log: c.log,
        ...(c.channels ? { channels: c.channels } : {}),
        ...(c.reminderMinIntervalMs !== undefined ? { reminderMinIntervalMs: c.reminderMinIntervalMs } : {}),
        ...(c.chargeOnFiado !== undefined ? { chargeOnFiado: c.chargeOnFiado } : {}),
        ...(c.reminderHours ? { reminderHours: c.reminderHours } : {}),
      }),
  });
}
