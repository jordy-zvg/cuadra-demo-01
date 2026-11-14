import { verifyAuthenticationResponse } from "@simplewebauthn/server";
import type { AuthenticationResponseJSON } from "@simplewebauthn/server";

export interface PasskeyConfig {
  rpID: string;
  origins: string[];
}

/** El challenge WebAuthn de una aprobación ES el hash de la propuesta (principio 8). */
export function challengeForProposalHash(proposalHash: string): string {
  if (!/^[0-9a-f]{64}$/.test(proposalHash)) throw new Error("Hash de propuesta inválido");
  return Buffer.from(proposalHash, "hex").toString("base64url");
}

export interface StoredCredential {
  id: string;
  publicKey: Uint8Array;
  /** Contador de la credencial antes de la aserción que se verifica. */
  counter: number;
}

/**
 * Verifica que la aserción la firmó la credencial registrada, con verificación de usuario,
 * sobre el hash exacto de la propuesta. Nunca lanza: cualquier fallo es false.
 */
export async function verifyProposalAssertion(args: {
  assertion: unknown;
  proposalHash: string;
  credential: StoredCredential;
  config: PasskeyConfig;
}): Promise<boolean> {
  try {
    const response = args.assertion as AuthenticationResponseJSON;
    if (response?.id !== args.credential.id) return false;
    const r = await verifyAuthenticationResponse({
      response,
      expectedChallenge: challengeForProposalHash(args.proposalHash),
      expectedOrigin: args.config.origins,
      expectedRPID: args.config.rpID,
      credential: { id: args.credential.id, publicKey: new Uint8Array(args.credential.publicKey), counter: args.credential.counter },
      requireUserVerification: true,
    });
    return r.verified;
  } catch {
    return false;
  }
}
