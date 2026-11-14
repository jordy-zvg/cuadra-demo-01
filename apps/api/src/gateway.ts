import { type PeyClient, type PeyTransaction } from "@cuadra/adapters";
import type { Centavos } from "@cuadra/core";
import { type Db, schema } from "@cuadra/db";
import { eq } from "drizzle-orm";

/** Vigencia de una solicitud CoDi al celular y de un QR de mostrador (segundos). */
export const PN_TTL_S = 3600;
export const QR_TTL_S = 1800;

/** Cobro al cliente final. pey en vivo; simulado cuando no hay llave (se dice en la UI). */
export interface ChargeGateway {
  readonly name: string;
  readonly simulated: boolean;
  requestPayment(r: {
    amount_cents: Centavos;
    phone10: string;
    concept: string;
    num_ref: string;
    metadata: Record<string, string>;
    bank_account_id?: string;
  }): Promise<{ provider_charge_id: string }>;
  /** QR CoDi para cobrar en mostrador. image: PNG base64 si el proveedor lo da. */
  createQr(r: {
    amount_cents: Centavos;
    concept: string;
    num_ref: string;
    metadata: Record<string, string>;
    bank_account_id?: string;
  }): Promise<{ provider_charge_id: string; image_png_base64: string | null }>;
  getTransaction(id: string): Promise<PeyTransaction>;
  /**
   * Transacciones recientes del proveedor (más nuevas primero) hasta `since`. coveredSince es
   * null si se leyó toda la ventana; si se cortó antes, la fecha más vieja que sí se leyó.
   */
  listRecentTransactions?(since: Date): Promise<{ items: PeyTransaction[]; coveredSince: Date | null }>;
  /** Alta de una CLABE como cuenta receptora (pey: POST /bank-account). */
  registerAccount(r: { clabe: string; name: string; alias: string }): Promise<{ id: string; status: string }>;
  accountStatus(id: string): Promise<string>;
}

export class PeyGateway implements ChargeGateway {
  readonly name = "pey";
  readonly simulated = false;
  constructor(private readonly pey: PeyClient) {}
  async requestPayment(r: Parameters<ChargeGateway["requestPayment"]>[0]) {
    const pn = await this.pey.createPushNotification({ ...r, expiration_s: PN_TTL_S });
    return { provider_charge_id: pn.transactionId };
  }
  async createQr(r: Parameters<ChargeGateway["createQr"]>[0]) {
    // 30 min de vigencia (mínimo de pey: 360 s).
    const qr = await this.pey.createQr({ ...r, expiration_s: QR_TTL_S, generate_image: true });
    return { provider_charge_id: qr.id, image_png_base64: qr.qrImage ?? null };
  }
  getTransaction(id: string) {
    return this.pey.getTransaction(id);
  }
  async listRecentTransactions(since: Date, maxPages = 25) {
    const items: PeyTransaction[] = [];
    let token: string | undefined;
    for (let page = 0; page < maxPages; page++) {
      const r = await this.pey.listTransactions(token);
      items.push(...r.items);
      const oldest = r.items.at(-1)?.date_created ?? null;
      if (!r.nextToken || (oldest && oldest.getTime() < since.getTime())) return { items, coveredSince: null };
      token = r.nextToken;
    }
    return { items, coveredSince: items.at(-1)?.date_created ?? since };
  }
  async registerAccount(r: { clabe: string; name: string; alias: string }) {
    const a = await this.pey.registerBankAccount({ alias: r.alias.slice(0, 255), name: r.name.slice(0, 255), clabe: r.clabe, entity: "PERSON" });
    return { id: a.id, status: a.codiStatus };
  }
  async accountStatus(id: string) {
    return (await this.pey.getBankAccount(id)).codiStatus;
  }
}

/**
 * Cobro CoDi simulado: no hay dinero ni banco real. El "pago" lo dispara el botón del
 * chat del cliente. Sin estado propio: todo sale de la tabla de cobros.
 */
export class SimulatedGateway implements ChargeGateway {
  readonly name = "pey_sim";
  readonly simulated = true;
  constructor(private readonly db: Db) {}
  async requestPayment(r: Parameters<ChargeGateway["requestPayment"]>[0]) {
    return { provider_charge_id: `simtx_${r.metadata.cuadra_charge_id ?? r.metadata.cuadra_tanda_charge_id}` };
  }
  async createQr(r: Parameters<ChargeGateway["createQr"]>[0]) {
    return { provider_charge_id: `simqr_${r.metadata.cuadra_charge_id}`, image_png_base64: null };
  }
  async registerAccount(r: { clabe: string }) {
    return { id: `simba_${r.clabe.slice(-8)}`, status: "ACTIVE" };
  }
  async accountStatus() {
    return "ACTIVE";
  }
  async getTransaction(id: string): Promise<PeyTransaction> {
    const [tc] = await this.db.select().from(schema.tandaCharges).where(eq(schema.tandaCharges.providerChargeId, id));
    if (tc) {
      return {
        id, status: "PAID", amount_cents: tc.amountCents, base_cents: tc.amountCents, tip_cents: 0n, fee_cents: 0n,
        payment_method: "CODI", payable_type: "API_CODI_PN", payable_id: id, date_paid: new Date(),
        payer_clabe: null, tracking_key: null, external_metadata: { cuadra_tanda_charge_id: tc.id },
      };
    }
    const [c] = await this.db.select().from(schema.charges).where(eq(schema.charges.providerChargeId, id));
    if (!c?.amountCents) throw new Error(`Transacción simulada ${id} no existe`);
    return {
      id,
      status: "PAID",
      amount_cents: c.amountCents,
      base_cents: c.amountCents,
      tip_cents: 0n,
      fee_cents: 0n,
      payment_method: "CODI",
      payable_type: "API_CODI_PN",
      payable_id: id,
      date_paid: new Date(),
      payer_clabe: null,
      tracking_key: null,
      external_metadata: { cuadra_charge_id: c.id },
    };
  }
}
