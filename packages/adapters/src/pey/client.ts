/**
 * Cliente de la API pública de pey (CoDi). Fuente: https://docs.pey.mx/openapi.json
 * (versión 2026-10-20). Autenticación: Authorization: Bearer <API key>.
 * pey solo cobra (QR, notificación push, link de pago); no envía dinero.
 */
import type { Centavos } from "@cuadra/core";
import { z } from "zod";
import { centsToPesos, pesosToCents } from "./money.js";

export const PEY_BASE_URL = "https://api.pey.mx";

export interface PeyConfig {
  apiKey: string;
  baseUrl?: string;
  fetch?: typeof fetch;
  /** Tiempo máximo por llamada (ms). Sin esto, una conexión colgada podía bloquear minutos. */
  timeoutMs?: number;
}

/** Default por llamada a pey. Un POST que vence así tiene resultado desconocido: quien llama decide. */
export const PEY_TIMEOUT_MS = 20_000;

export class PeyApiError extends Error {
  constructor(
    readonly status: number,
    readonly type: string,
    message: string,
    readonly requestId: string | null,
  ) {
    super(message);
  }
  /** 5xx/503: reintentable. 4xx: no. */
  get retryable(): boolean {
    return this.status >= 500;
  }
}

type Metadata = Record<string, string>;

const ErrorBody = z.object({
  error: z.object({ message: z.string().optional(), type: z.string().optional(), requestId: z.string().nullable().optional() }),
});

const Breakdown = z.object({ base: z.number().optional(), tip: z.number().optional(), fee: z.number().optional() }).partial();

export const PeyTransactionSchema = z.object({
  id: z.string(),
  status: z.enum(["PENDING", "PAID"]),
  amount: z.number(),
  amountBreakdown: Breakdown.optional(),
  currency: z.string().optional(),
  paymentMethod: z.enum(["CARD", "CODI"]).optional(),
  payableType: z.enum(["PAYMENT_LINK", "API_CODI_QR", "API_CODI_PN"]).optional(),
  payableId: z.string().optional(),
  description: z.string().optional(),
  applicationFee: z.number().optional(),
  dateCreated: z.number().optional(),
  datePaid: z.number().optional(),
  metadata: z.record(z.unknown()).optional(),
});

/** Transacción ya en centavos. */
export interface PeyTransaction {
  id: string;
  status: "PENDING" | "PAID";
  amount_cents: Centavos;
  /** Monto base (lo que debía el cliente); si pey no lo desglosa, igual al total. */
  base_cents: Centavos;
  tip_cents: Centavos;
  fee_cents: Centavos;
  payment_method: "CARD" | "CODI" | null;
  payable_type: string | null;
  payable_id: string | null;
  date_paid: Date | null;
  /** Cuándo se creó en pey (para saber qué ventana cubre una consulta). */
  date_created?: Date | null;
  payer_clabe: string | null;
  tracking_key: string | null;
  external_metadata: Metadata;
}

export function normalizeTransaction(raw: z.infer<typeof PeyTransactionSchema>): PeyTransaction {
  const md = raw.metadata ?? {};
  const ext = md.externalMetadata;
  return {
    id: raw.id,
    status: raw.status,
    amount_cents: pesosToCents(raw.amount),
    base_cents: pesosToCents(raw.amountBreakdown?.base ?? raw.amount),
    tip_cents: pesosToCents(raw.amountBreakdown?.tip ?? 0),
    fee_cents: pesosToCents(raw.amountBreakdown?.fee ?? 0),
    payment_method: raw.paymentMethod ?? null,
    payable_type: raw.payableType ?? null,
    payable_id: raw.payableId ?? null,
    date_paid: raw.datePaid ? new Date(raw.datePaid * 1000) : null,
    date_created: raw.dateCreated ? new Date(raw.dateCreated * 1000) : null,
    payer_clabe: typeof md.clabe === "string" && /^\d{18}$/.test(md.clabe) ? md.clabe : null,
    tracking_key: typeof md.trackingKey === "string" ? md.trackingKey : null,
    external_metadata:
      ext && typeof ext === "object" && !Array.isArray(ext)
        ? Object.fromEntries(Object.entries(ext as Record<string, unknown>).map(([k, v]) => [k, String(v)]))
        : {},
  };
}

const BankAccountRef = z.object({
  id: z.string(),
  codiStatus: z.enum(["PENDING", "PROCESSING", "ACTIVE", "ERROR"]),
  clabe: z.string().optional(),
  alias: z.string().optional(),
  errorMessage: z.string().nullable().optional(),
});

export interface ChargeRequest {
  /** Cuenta receptora registrada en pey (ACTIVE). Sin ella, va a la cuenta de la API key. */
  bank_account_id?: string;
  amount_cents: Centavos;
  concept: string;
  /** Referencia numérica, hasta 7 dígitos. */
  num_ref?: string;
  metadata?: Metadata;
}

export class PeyClient {
  private readonly base: string;
  private readonly http: typeof fetch;

  constructor(private readonly cfg: PeyConfig) {
    if (!cfg.apiKey) throw new Error("Falta la API key de pey");
    this.base = cfg.baseUrl ?? PEY_BASE_URL;
    this.http = cfg.fetch ?? fetch;
  }

  private async call<T>(method: "GET" | "POST", path: string, schema: z.ZodType<T, z.ZodTypeDef, unknown>, body?: unknown): Promise<T> {
    const res = await this.http(`${this.base}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.cfg.apiKey}`,
        accept: "application/json",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(this.cfg.timeoutMs ?? PEY_TIMEOUT_MS),
    });
    const json: unknown = await res.json().catch(() => null);
    if (!res.ok) {
      const e = ErrorBody.safeParse(json);
      throw new PeyApiError(
        res.status,
        e.success ? (e.data.error.type ?? "UNKNOWN") : "UNKNOWN",
        e.success ? (e.data.error.message ?? `pey ${res.status}`) : `pey ${res.status}`,
        e.success ? (e.data.error.requestId ?? null) : null,
      );
    }
    return schema.parse(json);
  }

  private static checkRef(numRef?: string): void {
    if (numRef !== undefined && !/^[0-9]{1,7}$/.test(numRef)) throw new Error("numRef debe tener de 1 a 7 dígitos");
  }

  /**
   * POST /bank-account: registra una CLABE para recibir cobros CoDi. Queda PENDING y pasa a
   * ACTIVE (hasta 5 días hábiles); luego se usa como bankAccountId.
   */
  async registerBankAccount(r: { alias: string; name: string; clabe: string; entity: "BUSINESS" | "PERSON" }) {
    if (!/^[0-9]{18}$/.test(r.clabe)) throw new Error("CLABE inválida");
    return this.call("POST", "/bank-account", BankAccountRef, r);
  }

  /** GET /bank-account/{id}: estado del alta CoDi de la cuenta. */
  async getBankAccount(id: string) {
    return this.call("GET", `/bank-account/${encodeURIComponent(id)}`, BankAccountRef);
  }

  /** POST /codi/pn: notificación push CoDi al celular (10 dígitos). Expira en ≥ 360 s. */
  async createPushNotification(
    r: ChargeRequest & { phone10: string; expiration_s?: number },
  ): Promise<{ transactionId: string; codiId: string | null }> {
    if (!/^[0-9]{10}$/.test(r.phone10)) throw new Error("El celular debe tener 10 dígitos");
    if (r.amount_cents <= 0n || r.amount_cents > 100_000_000n) throw new Error("Monto fuera de rango para CoDi");
    PeyClient.checkRef(r.num_ref);
    return this.call(
      "POST",
      "/codi/pn",
      z.object({ transactionId: z.string(), codiId: z.string().nullable().optional() }).transform((v) => ({ transactionId: v.transactionId, codiId: v.codiId ?? null })),
      {
        amount: centsToPesos(r.amount_cents),
        phoneNumber: r.phone10,
        concept: r.concept,
        expiration: Math.max(360, r.expiration_s ?? 360),
        ...(r.num_ref ? { numRef: r.num_ref } : {}),
        ...(r.bank_account_id ? { bankAccountId: r.bank_account_id } : {}),
        ...(r.metadata ? { metadata: r.metadata } : {}),
      },
    );
  }

  /** POST /codi/qr: QR CoDi. expiration 0 = sin expiración; si se pone, mínimo 360 s. */
  async createQr(r: ChargeRequest & { expiration_s?: number; generate_image?: boolean }) {
    PeyClient.checkRef(r.num_ref);
    const exp = r.expiration_s ?? 0;
    if (exp !== 0 && exp < 360) throw new Error("La expiración del QR debe ser 0 o ≥ 360 s");
    return this.call(
      "POST",
      "/codi/qr",
      z.object({ id: z.string(), qrString: z.string(), qrImage: z.string().nullable().optional() }),
      {
        amount: centsToPesos(r.amount_cents),
        concept: r.concept,
        expiration: exp,
        ...(r.num_ref ? { numRef: r.num_ref } : {}),
        ...(r.generate_image ? { generateImage: true } : {}),
        ...(r.bank_account_id ? { bankAccountId: r.bank_account_id } : {}),
        ...(r.metadata ? { metadata: r.metadata } : {}),
      },
    );
  }

  /** POST /payment-link/create: link de pago (CoDi o tarjeta). URLs HTTPS. */
  async createPaymentLink(
    r: { amount_cents: Centavos; success_url: string; back_url: string; client_reference_id?: string; metadata?: Metadata },
  ): Promise<{ id: string; url: string }> {
    if (!r.success_url.startsWith("https://") || !r.back_url.startsWith("https://")) {
      throw new Error("pey exige URLs HTTPS en el link de pago");
    }
    return this.call("POST", "/payment-link/create", z.object({ id: z.string(), url: z.string().url() }), {
      amount: centsToPesos(r.amount_cents),
      successUrl: r.success_url,
      backUrl: r.back_url,
      ...(r.client_reference_id ? { clientReferenceId: r.client_reference_id } : {}),
      ...(r.metadata ? { metadata: r.metadata } : {}),
    });
  }

  /** GET /transaction/{id}: fuente de verdad para confirmar un pago desde el servidor. */
  async getTransaction(id: string): Promise<PeyTransaction> {
    const raw = await this.call("GET", `/transaction/${encodeURIComponent(id)}`, PeyTransactionSchema);
    return normalizeTransaction(raw);
  }

  /** GET /transaction/api-key: 80 por página, más recientes primero. */
  async listTransactions(nextToken?: string): Promise<{ items: PeyTransaction[]; nextToken: string | null }> {
    const q = nextToken ? `?nextToken=${encodeURIComponent(nextToken)}` : "";
    const r = await this.call(
      "GET",
      `/transaction/api-key${q}`,
      z.object({ items: z.array(PeyTransactionSchema), nextToken: z.string().nullable().optional() }),
    );
    return { items: r.items.map(normalizeTransaction), nextToken: r.nextToken ?? null };
  }
}
