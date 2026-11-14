/**
 * Tanda sin pozo: en la ronda r (1..n) recibe el integrante en la posición r, y cada uno de
 * los demás le aporta directo a su cuenta. Funciones puras para el estado de una ronda.
 */
export interface RoundStatus {
  round: number;
  recipient: number;
  payers: number[];
  paid: number[];
  pending: number[];
  complete: boolean;
}

export function recipientOf(round: number, members: number): number {
  if (!Number.isInteger(round) || round < 1 || round > members) throw new Error(`Ronda ${round} fuera de rango`);
  return round;
}

export function roundStatus(round: number, members: number, paidPositions: readonly number[]): RoundStatus {
  const recipient = recipientOf(round, members);
  const payers = Array.from({ length: members }, (_, i) => i + 1).filter((p) => p !== recipient);
  const paidSet = new Set(paidPositions);
  for (const p of paidSet) {
    if (!payers.includes(p)) throw new Error(`Aportación inválida de la posición ${p} en la ronda ${round}`);
  }
  const paid = payers.filter((p) => paidSet.has(p));
  const pending = payers.filter((p) => !paidSet.has(p));
  return { round, recipient, payers, paid, pending, complete: pending.length === 0 };
}

/** Lo que recibe quien tiene el turno: aportación × (integrantes − 1). */
export function potCents(contribution: bigint, members: number): bigint {
  return contribution * BigInt(members - 1);
}
