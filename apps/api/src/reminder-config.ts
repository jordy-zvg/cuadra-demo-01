/**
 * REMINDER_MIN_INTERVAL_MINUTES: minutos mínimos entre recordatorios al mismo cliente (P03). Solo
 * para desarrollo y demo; sin la variable rige la política (72 h). Se acepta un número no negativo
 * escrito tal cual ("0", "1", "90"); vacío cuenta como no definida y cualquier otra cosa es
 * inválida, para que un valor raro (p. ej. un espacio, que Number() leería como 0) nunca cambie la regla.
 */
export function parseMinIntervalMinutes(raw: string | undefined): { ms: number | undefined; invalid: boolean } {
  const v = raw?.trim() ?? "";
  if (v === "") return { ms: undefined, invalid: false };
  if (!/^\d+(?:\.\d+)?$/.test(v)) return { ms: undefined, invalid: true };
  return { ms: Math.round(Number(v) * 60_000), invalid: false };
}
