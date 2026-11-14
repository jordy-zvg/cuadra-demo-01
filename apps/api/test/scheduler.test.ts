import { RuleInterpreter } from "@cuadra/agents";
import { DEMO, schema, seedDemo } from "@cuadra/db";
import { createTestDb } from "@cuadra/db/testing";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { SimulatedGateway } from "../src/gateway.js";
import { parseMinIntervalMinutes } from "../src/reminder-config.js";
import { mxWeekday, parseReminderSchedule, reminderTick } from "../src/scheduler.js";
import { CuadraService } from "../src/service.js";

const M = DEMO.merchantId;
// Viernes 13-nov-2026 en CDMX (UTC−6).
const FRI_0930 = new Date("2026-11-13T09:30:00-06:00");
const FRI_1030 = new Date("2026-11-13T10:30:00-06:00");

async function setup(start: Date) {
  const { db } = await createTestDb();
  await seedDemo(db, start, { lupePhone: "+525512345678" });
  let now = start;
  const svc = new CuadraService({
    db, merchantId: M, ownerId: DEMO.ownerId, interpreters: [new RuleInterpreter()],
    gateway: new SimulatedGateway(db), verify: async () => false, now: () => now, publicUrl: null,
    peyWebhookSecret: null, bankSim: false, udi: null, log: () => {},
  });
  const fiado = async (text: string) => {
    await svc.handleMerchantMessage(text);
    const all = await db.select().from(schema.messages).orderBy(schema.messages.id);
    await svc.confirm(all.filter((x) => x.actions?.length).at(-1)!.actions![0]!.proposal_id!);
  };
  return { db, svc, fiado, at: (d: Date) => { now = d; } };
}

describe("horario de recordatorios", () => {
  it("parsea días y hora; rechaza horas fuera de la política", () => {
    expect(parseReminderSchedule("5", "10")).toEqual({ days: [5], hour: 10 });
    expect(parseReminderSchedule("1, 5,5", "9")).toEqual({ days: [1, 5], hour: 9 });
    expect(parseReminderSchedule("5", "20")).toBeNull();
    expect(parseReminderSchedule("7", "10")).toBeNull();
    expect(parseReminderSchedule(undefined, "10")).toBeNull();
  });

  it("el día de la semana es el de CDMX, no el de UTC", () => {
    expect(mxWeekday(new Date("2026-11-13T23:30:00-06:00"))).toBe(5); // en UTC ya es sábado
  });
});

describe("reminderTick", () => {
  it("corre una sola vez el día y hora configurados, con resumen al comercio", async () => {
    const f = await setup(FRI_0930);
    await f.fiado("Doña Lupe se llevó $185");
    let runs = 0;
    const deps = {
      db: f.db, merchantId: M, schedule: { days: [5], hour: 10 }, now: () => FRI_0930, log: () => {},
      run: async () => { runs++; return f.svc.runScheduledReminders(); },
    };
    expect(await reminderTick(deps)).toBe(false); // antes de la hora

    f.at(FRI_1030);
    deps.now = () => FRI_1030;
    expect(await reminderTick(deps)).toBe(true);
    expect(await reminderTick(deps)).toBe(false); // candado del día (otra réplica o el siguiente minuto)
    expect(runs).toBe(1);

    const charges = await f.db.select().from(schema.charges).where(eq(schema.charges.customerId, "c_lupe"));
    expect(charges).toHaveLength(1);
    const summary = (await f.db.select().from(schema.messages).where(eq(schema.messages.thread, "comercio"))).at(-1)!;
    expect(summary.body).toMatch(/Recordatorios programados: mandé 1 cobro/);
  });

  it("respeta la política: sin opt-in no se cobra y un cobro abierto no se duplica", async () => {
    const f = await setup(FRI_1030);
    await f.fiado("Doña Lupe se llevó $185");
    await f.fiado("Chela Gómez se llevó $50"); // Chela no tiene opt-in
    expect(await f.svc.runScheduledReminders()).toEqual({ sent: 1, skipped: 0 });
    // Segunda corrida: Lupe ya tiene cobro abierto; se omite en silencio.
    expect(await f.svc.runScheduledReminders()).toEqual({ sent: 0, skipped: 1 });
    const chela = await f.db.select().from(schema.charges).where(eq(schema.charges.customerId, "c_chela"));
    expect(chela.every((c) => c.id === "ch_chela_1")).toBe(true); // solo el del seed
  });

  it("otro día de la semana no corre", async () => {
    const f = await setup(FRI_1030);
    const thu = new Date("2026-11-12T10:30:00-06:00");
    const ran = await reminderTick({ db: f.db, merchantId: M, schedule: { days: [5], hour: 10 }, now: () => thu, log: () => {}, run: async () => ({ sent: 0, skipped: 0 }) });
    expect(ran).toBe(false);
  });
});

describe("REMINDER_MIN_INTERVAL_MINUTES", () => {
  it("solo números no negativos escritos tal cual; vacío = sin definir; lo demás es inválido", () => {
    expect(parseMinIntervalMinutes(undefined)).toEqual({ ms: undefined, invalid: false });
    expect(parseMinIntervalMinutes("")).toEqual({ ms: undefined, invalid: false });
    expect(parseMinIntervalMinutes("  ")).toEqual({ ms: undefined, invalid: false }); // un espacio no cambia la regla
    expect(parseMinIntervalMinutes("0")).toEqual({ ms: 0, invalid: false });
    expect(parseMinIntervalMinutes(" 1 ")).toEqual({ ms: 60_000, invalid: false });
    expect(parseMinIntervalMinutes("1.5")).toEqual({ ms: 90_000, invalid: false });
    for (const bad of ["abc", "-1", "0x10", "1e3", "Infinity", "NaN", "\t0\t0"]) {
      expect(parseMinIntervalMinutes(bad)).toEqual({ ms: undefined, invalid: true });
    }
  });
});
