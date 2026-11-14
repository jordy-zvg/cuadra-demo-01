/**
 * Recordatorios programados: los días y la hora que eligió el comercio (hora de CDMX).
 * Revisa cada minuto; un renglón en webhook_events por comercio y día hace de candado, así que aunque
 * haya varias réplicas o reinicios, la corrida del día sale una sola vez y sin Redis.
 */
import { mxDateKey, mxMinutesOfDay } from "@cuadra/core";
import { type Db, schema } from "@cuadra/db";

export interface ReminderSchedule {
  /** Días de la semana: 0 = domingo ... 6 = sábado. */
  days: number[];
  /** Hora local de arranque (9 a 19; la política solo permite enviar de 9:00 a 20:00). */
  hour: number;
}

/** "5" o "1,5" y "10" → horario; null si falta o es inválido (la tarea queda apagada). */
export function parseReminderSchedule(days?: string, hour?: string): ReminderSchedule | null {
  if (!days || !hour) return null;
  const d = days.split(",").map((x) => Number(x.trim()));
  const h = Number(hour);
  if (d.length === 0 || d.some((x) => !Number.isInteger(x) || x < 0 || x > 6)) return null;
  if (!Number.isInteger(h) || h < 9 || h > 19) return null;
  return { days: [...new Set(d)], hour: h };
}

/** Día de la semana en CDMX (0 = domingo). */
export function mxWeekday(d: Date): number {
  return new Date(`${mxDateKey(d)}T12:00:00Z`).getUTCDay();
}

export interface SchedulerDeps {
  db: Db;
  merchantId: string;
  schedule: ReminderSchedule;
  run: () => Promise<{ sent: number; skipped: number }>;
  now: () => Date;
  log: (r: Record<string, unknown>) => void;
}

/** Una revisión. Devuelve true si le tocó correr (y tomó el candado del día). */
export async function reminderTick(d: SchedulerDeps): Promise<boolean> {
  const now = d.now();
  if (!d.schedule.days.includes(mxWeekday(now)) || mxMinutesOfDay(now) < d.schedule.hour * 60) return false;
  const key = `reminders:${d.merchantId}:${mxDateKey(now)}`;
  const lock = await d.db
    .insert(schema.webhookEvents)
    .values({ provider: "cron", eventId: key, payload: { at: now.toISOString() } })
    .onConflictDoNothing()
    .returning({ id: schema.webhookEvents.eventId });
  if (lock.length === 0) return false;
  const r = await d.run();
  d.log({ msg: "scheduled_reminders", merchant_id: d.merchantId, ...r });
  return true;
}

export function startReminderScheduler(d: SchedulerDeps, everyMs = 60_000): () => void {
  const t = setInterval(() => {
    reminderTick(d).catch((e: unknown) => d.log({ msg: "scheduled_reminders_error", error: e instanceof Error ? e.message : String(e) }));
  }, everyMs);
  t.unref();
  return () => clearInterval(t);
}
