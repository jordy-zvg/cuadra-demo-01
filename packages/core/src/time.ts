/** Utilidades de hora local. Zona fija: America/Mexico_City. */
export const TIME_ZONE = "America/Mexico_City";

const fmt = new Intl.DateTimeFormat("en-CA", {
  timeZone: TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

function parts(d: Date): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of fmt.formatToParts(d)) out[p.type] = p.value;
  return out;
}

/** Minutos transcurridos desde las 00:00 en CDMX. */
export function mxMinutesOfDay(d: Date): number {
  const p = parts(d);
  return Number(p.hour) * 60 + Number(p.minute);
}

/** Fecha local CDMX en formato YYYY-MM-DD. */
export function mxDateKey(d: Date): string {
  const p = parts(d);
  return `${p.year}-${p.month}-${p.day}`;
}

/** true si la hora local está en [fromHour, toHour). */
export function isWithinMxHours(d: Date, fromHour: number, toHour: number): boolean {
  const m = mxMinutesOfDay(d);
  return m >= fromHour * 60 && m < toHour * 60;
}

export const HOUR_MS = 60 * 60 * 1000;
export const MINUTE_MS = 60 * 1000;
