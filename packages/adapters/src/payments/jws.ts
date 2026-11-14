import { createSign, randomBytes } from "node:crypto";

/**
 * Firma JWS de Fintoc para peticiones que mueven dinero.
 * Fuente: https://docs.fintoc.com/guides/business-accounts/setup/setting-up-jws-keys
 * - Encabezado protegido: { alg: "RS256", nonce, ts (segundos), crit: ["ts", "nonce"] }.
 * - Entrada de firma: base64url(header) + "." + base64url(rawBody), sin padding.
 * - RSA PKCS#1 v1.5 con SHA-256.
 * - Header HTTP `Fintoc-JWS-Signature`: base64url(header) + "." + base64url(firma).
 * - El rawBody firmado debe ser exactamente el que se envía.
 */
export function fintocJwsSignature(
  rawBody: string,
  privateKeyPem: string,
  opts: { now?: Date; nonce?: string } = {},
): string {
  const header = {
    alg: "RS256",
    nonce: opts.nonce ?? randomBytes(16).toString("hex"),
    ts: Math.floor((opts.now ?? new Date()).getTime() / 1000),
    crit: ["ts", "nonce"],
  };
  const protectedB64 = Buffer.from(JSON.stringify(header)).toString("base64url");
  const payloadB64 = Buffer.from(rawBody).toString("base64url");
  const signature = createSign("sha256").update(`${protectedB64}.${payloadB64}`).sign(privateKeyPem);
  return `${protectedB64}.${signature.toString("base64url")}`;
}
