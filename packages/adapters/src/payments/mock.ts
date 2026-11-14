import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { type Centavos, isValidClabe } from "@cuadra/core";
import {
  type PaymentProvider,
  ProviderEvent,
  type TransferRequest,
  type TransferResponse,
  type WebhookParser,
  WebhookSignatureError,
} from "./types.js";

export const MOCK_SIGNATURE_HEADER = "x-mock-signature";

function sign(secret: string, body: string): string {
  return createHmac("sha256", secret).update(body).digest("hex");
}

export function verifyMockSignature(secret: string, body: string, signature: string | undefined): boolean {
  if (!signature || !/^[0-9a-f]{64}$/.test(signature)) return false;
  return timingSafeEqual(Buffer.from(sign(secret, body), "hex"), Buffer.from(signature, "hex"));
}

export interface SignedWebhook {
  body: string;
  headers: Record<string, string>;
}

interface MockTransfer {
  req: TransferRequest;
  provider_ref: string;
  status: "sent" | "confirmed" | "failed";
}

/**
 * Proveedor SPEI simulado: una cuenta operativa en memoria. Determinista salvo por los ids.
 * Debita al enviar (como SPEI real) y devuelve el monto si la transferencia falla.
 */
export class MockPaymentProvider implements PaymentProvider, WebhookParser {
  readonly name = "mock";
  private balance: Centavos;
  private readonly byKey = new Map<string, MockTransfer>();
  private readonly byRef = new Map<string, MockTransfer>();
  private nextFailure: string | null = null;
  private outage = false;
  /** Llamadas recibidas (para pruebas de idempotencia). */
  readonly calls: TransferRequest[] = [];

  constructor(
    private readonly webhookSecret: string,
    opts: { initialBalance?: Centavos } = {},
  ) {
    this.balance = opts.initialBalance ?? 0n;
  }

  async createTransfer(req: TransferRequest): Promise<TransferResponse> {
    this.calls.push(req);
    if (this.outage) throw new Error("Proveedor no disponible (simulado)");
    const existing = this.byKey.get(req.idempotency_key);
    if (existing) return this.response(existing);

    const t: MockTransfer = { req, provider_ref: `mock_${randomUUID()}`, status: "sent" };
    let failure: string | null = null;
    if (this.nextFailure !== null) {
      failure = this.nextFailure;
      this.nextFailure = null;
    } else if (!isValidClabe(req.clabe)) failure = "CLABE inválida";
    else if (req.amount_cents <= 0n) failure = "Monto inválido";
    else if (req.amount_cents > this.balance) failure = "Saldo insuficiente";

    if (failure !== null) {
      t.status = "failed";
      this.failures.set(t.provider_ref, failure);
    } else {
      this.balance -= req.amount_cents;
    }
    this.byKey.set(req.idempotency_key, t);
    this.byRef.set(t.provider_ref, t);
    return this.response(t);
  }

  private readonly failures = new Map<string, string>();

  private response(t: MockTransfer): TransferResponse {
    return t.status === "failed"
      ? { provider_ref: t.provider_ref, status: "failed", failure_reason: this.failures.get(t.provider_ref) ?? "" }
      : { provider_ref: t.provider_ref, status: "sent" };
  }

  async getBalance(): Promise<Centavos> {
    return this.balance;
  }

  // ---------- Controles del simulador ----------

  failNextTransfer(reason: string): void {
    this.nextFailure = reason;
  }

  setOutage(on: boolean): void {
    this.outage = on;
  }

  /** Descuadre deliberado para probar el congelamiento de salidas. */
  adjustBalance(delta: Centavos): void {
    this.balance += delta;
  }

  /** Liquida una transferencia enviada y devuelve el webhook firmado. */
  settle(providerRef: string, outcome: "confirmed" | "failed", reason = "Rechazada por el banco receptor"): SignedWebhook {
    const t = this.byRef.get(providerRef);
    if (!t || t.status !== "sent") throw new Error(`Transferencia ${providerRef} no está en tránsito`);
    t.status = outcome;
    if (outcome === "failed") {
      this.balance += t.req.amount_cents;
      return this.webhook({ type: "transfer.failed", provider_ref: providerRef, failure_reason: reason });
    }
    return this.webhook({ type: "transfer.confirmed", provider_ref: providerRef });
  }

  /** Simula un SPEI entrante a la cuenta operativa. */
  incomingSpei(d: {
    clave_rastreo: string;
    amount_cents: Centavos;
    destination_clabe?: string;
    ordering_clabe?: string;
    reference?: string;
    concept?: string;
  }): SignedWebhook {
    this.balance += d.amount_cents;
    return this.webhook({ type: "deposit.received", ...d, amount_cents: d.amount_cents.toString() });
  }

  private webhook(payload: Record<string, unknown>): SignedWebhook {
    const body = JSON.stringify({ event_id: `evt_${randomUUID()}`, ...payload });
    return { body, headers: { [MOCK_SIGNATURE_HEADER]: sign(this.webhookSecret, body) } };
  }

  parseWebhook(rawBody: string, headers: Readonly<Record<string, string | undefined>>): ProviderEvent {
    if (!verifyMockSignature(this.webhookSecret, rawBody, headers[MOCK_SIGNATURE_HEADER])) {
      throw new WebhookSignatureError("Firma de webhook inválida");
    }
    return ProviderEvent.parse(JSON.parse(rawBody));
  }
}
