/** CLABE: 18 dígitos; el último es dígito verificador (pesos 3,7,1 módulo 10). */
const WEIGHTS = [3, 7, 1] as const;

export function clabeCheckDigit(first17: string): number {
  if (!/^\d{17}$/.test(first17)) throw new Error("Se requieren 17 dígitos");
  let sum = 0;
  for (let i = 0; i < 17; i++) {
    sum += (Number(first17[i]) * WEIGHTS[i % 3]!) % 10;
  }
  return (10 - (sum % 10)) % 10;
}

export function isValidClabe(clabe: string): boolean {
  if (!/^\d{18}$/.test(clabe)) return false;
  return clabeCheckDigit(clabe.slice(0, 17)) === Number(clabe[17]);
}

/** Para mostrar al usuario: solo los últimos 4 dígitos. */
export function maskClabe(clabe: string): string {
  return `••••${clabe.slice(-4)}`;
}
