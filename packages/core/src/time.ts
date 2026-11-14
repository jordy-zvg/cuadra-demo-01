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

/**
 * Inicio del periodo (día, semana que empieza en lunes, o mes) en hora de CDMX.
 * America/Mexico_City no tiene horario de verano desde 2022: UTC−6 fijo.
 */
export function mxPeriodStart(now: Date, period: "day" | "week" | "month"): Date {
  const key = mxDateKey(now);
  const [y, m, d] = key.split("-").map(Number) as [number, number, number];
  let start = new Date(Date.UTC(y, m - 1, period === "month" ? 1 : d));
  if (period === "week") {
    const dow = (start.getUTCDay() + 6) % 7; // lunes = 0
    start = new Date(start.getTime() - dow * 24 * HOUR_MS);
  }
  return new Date(start.getTime() + 6 * HOUR_MS);
}

const hm = new Intl.DateTimeFormat("es-MX", { timeZone: TIME_ZONE, hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const dayFmt = new Intl.DateTimeFormat("es-MX", { timeZone: TIME_ZONE, weekday: "long", day: "numeric", month: "long" });

/** "16:11" en hora de CDMX. */
export function formatMxTime(d: Date): string {
  return hm.format(d);
}

/** "hoy a las 16:11", "mañana a las 9:00" o "el lunes 17 de noviembre a las 15:09" (hora de CDMX). */
export function formatMxWhen(d: Date, now: Date): string {
  const days = Math.round((Date.parse(mxDateKey(d)) - Date.parse(mxDateKey(now))) / (24 * HOUR_MS));
  const p: Record<string, string> = {};
  for (const x of dayFmt.formatToParts(d)) p[x.type] = x.value;
  const day = days === 0 ? "hoy" : days === 1 ? "mañana" : `el ${p.weekday} ${p.day} de ${p.month}`;
  return `${day} a las ${formatMxTime(d)}`;
}
