/**
 * Autenticador WebAuthn por software para tests y el simulador. Nunca en producción.
 */
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { isoCBOR } from "@simplewebauthn/server/helpers";
import { challengeForProposalHash } from "./passkey/verify.js";

export class SoftAuthenticator {
  readonly credentialId: string;
  readonly publicKeyCose: Uint8Array;
  private readonly privateKey;
  private counter: number;

  constructor(
    private readonly rpID: string,
    private readonly origin: string,
    opts: { id?: string; useCounter?: boolean } = {},
  ) {
    const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    this.privateKey = privateKey;
    const jwk = publicKey.export({ format: "jwk" });
    const cose = new Map<number, number | Uint8Array>([
      [1, 2], // kty: EC2
      [3, -7], // alg: ES256
      [-1, 1], // crv: P-256
      [-2, Buffer.from(jwk.x!, "base64url")],
      [-3, Buffer.from(jwk.y!, "base64url")],
    ]);
    this.publicKeyCose = isoCBOR.encode(cose);
    this.credentialId = opts.id ?? Buffer.from(createHash("sha256").update(jwk.x!).digest()).subarray(0, 16).toString("base64url");
    this.counter = opts.useCounter ? 0 : -1;
  }

  /** Firma una aserción cuyo challenge es el hash de la propuesta. */
  approve(proposalHash: string, opts: { userVerified?: boolean; challenge?: string; origin?: string } = {}) {
    const clientDataJSON = Buffer.from(
      JSON.stringify({
        type: "webauthn.get",
        challenge: opts.challenge ?? challengeForProposalHash(proposalHash),
        origin: opts.origin ?? this.origin,
        crossOrigin: false,
      }),
    );
    const flags = 0x01 | (opts.userVerified === false ? 0 : 0x04);
    const counter = Buffer.alloc(4);
    if (this.counter >= 0) counter.writeUInt32BE(++this.counter);
    const authData = Buffer.concat([
      createHash("sha256").update(this.rpID).digest(),
      Buffer.from([flags]),
      counter,
    ]);
    const signature = sign("sha256", Buffer.concat([authData, createHash("sha256").update(clientDataJSON).digest()]), this.privateKey);
    return {
      id: this.credentialId,
      rawId: this.credentialId,
      type: "public-key" as const,
      clientExtensionResults: {},
      response: {
        clientDataJSON: clientDataJSON.toString("base64url"),
        authenticatorData: authData.toString("base64url"),
        signature: signature.toString("base64url"),
      },
    };
  }
}
