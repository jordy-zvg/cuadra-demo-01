/**
 * Adapter de Fintoc Business Accounts (México), versión de API v2026-02-01.
 * Todo campo, header y endpoint viene de https://docs.fintoc.com (ver comentarios).
 * Solo apps/executor lo instancia con llaves; la API solo usa parseFintocWebhook.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import type { Centavos } from "@cuadra/core";
import { z } from "zod";
import { fintocJwsSignature } from "./jws.js";
import {
  type PaymentProvider,
  ProviderEvent,
  ProviderOutcomeUnknownError,
  type TransferRequest,
  type TransferResponse,
  WebhookSignatureError,
} from "./types.js";

export const FINTOC_BASE_URL = "https://api.fintoc.com";
export const FINTOC_SIGNATURE_HEADER = "fintoc-signature";
/** Tolerancia recomendada para eventos: 5 minutos (webhooks-validating). */
export const FINTOC_WEBHOOK_TOLERANCE_S = 5 * 60;
/** comment: hasta 40 caracteres (transfers-create). */
const COMMENT_MAX = 40;

export interface FintocConfig {
  secretKey: string;
  jwsPrivateKeyPem: string;
  /** Cuenta (acc_...) desde la que salen las transferencias del comercio. */
  accountId: string;
  baseUrl?: string;
  fetch?: typeof fetch;
  now?: () => Date;
}

/** Objeto Transfer (transfer-object). Solo validamos lo que usamos. */
const FintocTransfer = z.object({
  id: z.string(),
  object: z.literal("transfer"),
  amount: z.number().int(),
  currency: z.string(),
  direction: z.enum(["inbound", "outbound"]),
  status: z.string(),
  comment: z.string().nullable().optional(),
  reference_id: z.string().nullable().optional(),
  tracking_key: z.string().nullable().optional(),
  return_reason: z.string().nullable().optional(),
  metadata: z.record(z.unknown()).nullable().optional(),
  counterparty: z
    .object({ account_number: z.string().nullable().optional() })
    .passthrough()
    .nullable()
    .optional(),
  account_number: z
    .object({ id: z.string(), account_id: z.string(), number: z.string() })
    .passthrough()
    .nullable()
    .optional(),
});
type FintocTransfer = z.infer<typeof FintocTransfer>;

const FintocError = z.object({ error: z.object({ type: z.string().optional(), code: z.string().optional(), message: z.string().optional() }) });

/** Estados de una transferencia saliente en México (transfer-data-model). */
const OUTBOUND_FAILED = new Set(["failed", "rejected"]);

export class FintocPaymentProvider implements PaymentProvider {
  readonly name = "fintoc";
  private readonly base: string;
  private readonly http: typeof fetch;
  private readonly now: () => Date;

  constructor(private readonly cfg: FintocConfig) {
    if (!cfg.secretKey || !cfg.jwsPrivateKeyPem || !cfg.accountId) {
      throw new Error("Configuración de Fintoc incompleta");
    }
    this.base = cfg.baseUrl ?? FINTOC_BASE_URL;
    this.http = cfg.fetch ?? fetch;
    this.now = cfg.now ?? (() => new Date());
  }

  /** Solo para logs: nunca expone la llave. */
  get mode(): "test" | "live" {
    return this.cfg.secretKey.startsWith("sk_test_") ? "test" : "live";
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    // Autenticación: header Authorization con la llave secreta tal cual (outbound-transfers).
    return { Authorization: this.cfg.secretKey, accept: "application/json", ...extra };
  }

  async createTransfer(req: TransferRequest): Promise<TransferResponse> {
    const startedAt = this.now();
    // POST /v2/transfers (transfers-create). Monto en centavos; en MX la contraparte solo
    // requiere account_number (CLABE). metadata: valores string, hasta 50 pares.
    const body = {
      amount: Number(req.amount_cents),
      currency: "MXN",
      account_id: this.cfg.accountId,
      comment: req.concept.slice(0, COMMENT_MAX),
      counterparty: { account_number: req.clabe },
      metadata: { cuadra_idempotency_key: req.idempotency_key },
    };
    if (!Number.isSafeInteger(body.amount)) throw new Error("Monto fuera de rango");
    const rawBody = JSON.stringify(body);

    let res: Response;
    try {
      res = await this.http(`${this.base}/v2/transfers`, {
        method: "POST",
        headers: this.headers({
          "content-type": "application/json",
          "Idempotency-Key": req.idempotency_key,
          "Fintoc-JWS-Signature": fintocJwsSignature(rawBody, this.cfg.jwsPrivateKeyPem, { now: this.now() }),
        }),
        body: rawBody,
      });
    } catch {
      return this.resolveUnknown(req.idempotency_key, startedAt);
    }

    if (res.status === 201 || res.status === 200) {
      return this.toResponse(FintocTransfer.parse(await res.json()));
    }
    if (res.status >= 500) {
      // Fintoc guarda y repite el 5xx con la misma llave: hay que buscar la transferencia
      // por metadata (idempotent-requests, "Retry a transfer safely").
      return this.resolveUnknown(req.idempotency_key, startedAt);
    }
    // 4xx: la transferencia no se creó (p. ej. 409 insufficient_balance, 400 invalid_*).
    const err = FintocError.safeParse(await res.json().catch(() => null));
    const code = err.success ? (err.data.error.code ?? err.data.error.type ?? "error") : "error";
    if (res.status === 401) throw new Error("Fintoc rechazó la llave (401); revisar configuración");
    return { provider_ref: `fintoc_rejected_${req.idempotency_key}`, status: "failed", failure_reason: `Fintoc ${res.status}: ${code}` };
  }

  private toResponse(t: FintocTransfer): TransferResponse {
    if (OUTBOUND_FAILED.has(t.status)) {
      return { provider_ref: t.id, status: "failed", failure_reason: `Fintoc: ${t.status}` };
    }
    // pending o succeeded: la confirmación contable llega por webhook.
    return { provider_ref: t.id, status: "sent" };
  }

  /** Busca la transferencia creada con nuestra llave; si no aparece, se reintenta después. */
  private async resolveUnknown(idempotencyKey: string, startedAt: Date): Promise<TransferResponse> {
    const since = new Date(startedAt.getTime() - 5 * 60_000).toISOString();
    // GET /v2/transfers con account_id, direction, since (transfers-list). Lista paginada.
    const url = new URL(`${this.base}/v2/transfers`);
    url.searchParams.set("account_id", this.cfg.accountId);
    url.searchParams.set("direction", "outbound");
    url.searchParams.set("since", since);
    url.searchParams.set("limit", "300");
    let next: string | null = url.toString();
    for (let page = 0; next && page < 10; page++) {
      let res: Response;
      try {
        res = await this.http(next, { method: "GET", headers: this.headers() });
      } catch {
        throw new ProviderOutcomeUnknownError("No se pudo consultar Fintoc para resolver la transferencia");
      }
      if (!res.ok) throw new ProviderOutcomeUnknownError(`Fintoc respondió ${res.status} al listar transferencias`);
      const list = z.array(FintocTransfer).parse(await res.json());
      const found = list.find((t) => t.metadata?.cuadra_idempotency_key === idempotencyKey);
      if (found) return this.toResponse(found);
      next = nextLink(res.headers.get("link"));
    }
    throw new ProviderOutcomeUnknownError(`Transferencia ${idempotencyKey} sin resultado conocido; se reintentará`);
  }

  async getBalance(): Promise<Centavos> {
    // GET /v2/accounts/{id} → available_balance en centavos (account-object).
    const res = await this.http(`${this.base}/v2/accounts/${encodeURIComponent(this.cfg.accountId)}`, {
      method: "GET",
      headers: this.headers(),
    });
    if (!res.ok) throw new Error(`Fintoc respondió ${res.status} al leer el saldo`);
    const acc = z.object({ available_balance: z.number().int(), currency: z.string() }).parse(await res.json());
    if (acc.currency !== "MXN") throw new Error(`Moneda inesperada en la cuenta: ${acc.currency}`);
    return BigInt(acc.available_balance);
  }
}

/** RFC 8288: toma la URL con rel="next". */
function nextLink(header: string | null): string | null {
  if (!header) return null;
  for (const part of header.split(",")) {
    const m = /<([^>]+)>\s*;\s*rel="?next"?/.exec(part.trim());
    if (m) return m[1]!;
  }
  return null;
}

/**
 * Verifica `Fintoc-Signature: t=<unix>,v1=<hex>` con HMAC-SHA256 sobre `${t}.${rawBody}`
 * usando el secreto del webhook endpoint (webhooks-validating).
 */
export function verifyFintocSignature(rawBody: string, header: string | undefined, secret: string, now: Date): boolean {
  if (!header) return false;
  const parts = Object.fromEntries(
    header.split(",").map((kv) => {
      const i = kv.indexOf("=");
      return [kv.slice(0, i).trim(), kv.slice(i + 1).trim()];
    }),
  );
  const t = parts.t;
  const v1 = parts.v1;
  if (!t || !/^\d+$/.test(t) || !v1 || !/^[0-9a-f]{64}$/.test(v1)) return false;
  if (Math.abs(now.getTime() / 1000 - Number(t)) > FINTOC_WEBHOOK_TOLERANCE_S) return false;
  const expected = createHmac("sha256", secret).update(`${t}.${rawBody}`).digest();
  return timingSafeEqual(expected, Buffer.from(v1, "hex"));
}

const FintocEvent = z.object({ id: z.string().min(1), type: z.string().min(1), data: z.unknown() });

/**
 * Convierte un evento de Fintoc en nuestro ProviderEvent. Eventos (outbound-transfers,
 * inbound-transfers): transfer.outbound.{succeeded,failed,returned}, transfer.inbound.succeeded.
 * Otros tipos se registran como "ignored".
 */
export function parseFintocWebhook(
  rawBody: string,
  headers: Readonly<Record<string, string | undefined>>,
  secret: string,
  now: Date = new Date(),
): ProviderEvent {
  if (!verifyFintocSignature(rawBody, headers[FINTOC_SIGNATURE_HEADER], secret, now)) {
    throw new WebhookSignatureError("Firma de Fintoc inválida o fuera de tiempo");
  }
  const evt = FintocEvent.parse(JSON.parse(rawBody));
  const ignored = (): ProviderEvent => ({ type: "ignored", event_id: evt.id, original_type: evt.type });
  const known = [
    "transfer.outbound.succeeded",
    "transfer.outbound.failed",
    "transfer.outbound.returned",
    "transfer.inbound.succeeded",
  ];
  if (!known.includes(evt.type)) return ignored();
  const t = FintocTransfer.parse(evt.data);
  if (t.currency !== "MXN") throw new Error(`Moneda no soportada en webhook: ${t.currency}`);

  switch (evt.type) {
    case "transfer.outbound.succeeded":
      return { type: "transfer.confirmed", event_id: evt.id, provider_ref: t.id };
    case "transfer.outbound.failed":
      return { type: "transfer.failed", event_id: evt.id, provider_ref: t.id, failure_reason: `Fintoc: ${t.status}` };
    case "transfer.outbound.returned":
      return { type: "transfer.returned", event_id: evt.id, provider_ref: t.id, return_reason: t.return_reason ?? "Devuelta" };
    default: {
      // transfer.inbound.succeeded: el abono SPEI.
      if (!t.tracking_key) throw new Error(`Abono ${t.id} sin tracking_key (clave de rastreo)`);
      return ProviderEvent.parse({
        type: "deposit.received",
        event_id: evt.id,
        clave_rastreo: t.tracking_key,
        amount_cents: String(t.amount),
        ...(t.account_number?.number ? { destination_clabe: t.account_number.number } : {}),
        ...(t.counterparty?.account_number ? { ordering_clabe: t.counterparty.account_number } : {}),
        ...(t.reference_id ? { reference: t.reference_id } : {}),
        ...(t.comment ? { concept: t.comment } : {}),
        ...(t.account_number?.account_id ? { provider_account_id: t.account_number.account_id } : {}),
      });
    }
  }
}
