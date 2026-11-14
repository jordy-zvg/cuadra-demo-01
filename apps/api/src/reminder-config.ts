/**
 * REMINDER_COOLDOWN_HOURS: horas mínimas entre recordatorios al mismo cliente (P03). Solo para
 * desarrollo; sin la variable rige la política (72 h). Se acepta un número no negativo escrito tal
 * cual ("0", "24", "1.5"); vacío cuenta como no definida y cualquier otra cosa es inválida, para
 * que un valor raro (p. ej. un espacio, que Number() leería como 0) nunca apague la regla.
 */
export function parseCooldownHours(raw: string | undefined): { hours: number | undefined; invalid: boolean } {
  const v = raw?.trim() ?? "";
  if (v === "") return { hours: undefined, invalid: false };
  if (!/^\d+(?:\.\d+)?$/.test(v)) return { hours: undefined, invalid: true };
  return { hours: Number(v), invalid: false };
}
