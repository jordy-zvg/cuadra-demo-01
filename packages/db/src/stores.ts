/**
 * Personas y tiendas (decisión 14-nov-2026). Cada persona se identifica por su celular y es dueña
 * de su propia tienda (libreta): solo ve sus clientes, sus deudas y sus cobros. Si otra tienda la
 * tiene como cliente (mismo celular), ve lo que le debe a esa tienda y nada más.
 */
import { randomUUID } from "node:crypto";
import { and, eq, like, ne } from "drizzle-orm";
import { realPhone10 } from "./charges.js";
import type { Db } from "./client.js";
import { ledgerBalance } from "./ledger-repo.js";
import { charges, customers, merchants, merchantUsers, portalAccounts, riskState } from "./schema.js";

export interface StoreRef {
  merchantId: string;
  ownerId: string;
}

/** Topes de una tienda nueva (los mismos que la demo). */
const NEW_STORE_DAILY_LIMIT_CENTS = 2_000_000n;
const NEW_STORE_MAX_OUTFLOWS_PER_HOUR = 10;

/** Dueño (rol comercio) de una tienda. */
export async function storeOwner(db: Db, merchantId: string): Promise<{ id: string; phone: string; phoneVerified: boolean } | null> {
  const [u] = await db
    .select({ id: merchantUsers.id, phone: merchantUsers.phone, phoneVerified: merchantUsers.phoneVerified })
    .from(merchantUsers)
    .where(and(eq(merchantUsers.merchantId, merchantId), eq(merchantUsers.role, "comercio")))
    .orderBy(merchantUsers.createdAt)
    .limit(1);
  return u ?? null;
}

/** Tienda cuyo dueño tiene este celular (10 dígitos), si existe. */
export async function storeOfPhone(db: Db, phone10: string): Promise<StoreRef | null> {
  if (!/^\d{10}$/.test(phone10)) return null;
  const rows = await db
    .select({ id: merchantUsers.id, merchantId: merchantUsers.merchantId, phone: merchantUsers.phone, createdAt: merchantUsers.createdAt })
    .from(merchantUsers)
    .where(and(eq(merchantUsers.role, "comercio"), like(merchantUsers.phone, `%${phone10}`)))
    .orderBy(merchantUsers.createdAt);
  const u = rows.find((r) => realPhone10(r.phone) === phone10);
  return u ? { merchantId: u.merchantId, ownerId: u.id } : null;
}

/** Crea una tienda vacía con su dueño. El celular aún no está verificado (no hay WhatsApp de por medio). */
export async function createStore(db: Db, s: { ownerName: string; phone10: string; now: Date }): Promise<StoreRef> {
  const merchantId = `m_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
  const ownerId = `u_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
  const first = s.ownerName.trim().split(/\s+/)[0] || "ti";
  await db.transaction(async (tx) => {
    await tx.insert(merchants).values({
      id: merchantId,
      name: `La tienda de ${first}`.slice(0, 80),
      dailyLimitCents: NEW_STORE_DAILY_LIMIT_CENTS,
      maxOutflowsPerHour: NEW_STORE_MAX_OUTFLOWS_PER_HOUR,
      livePayments: false,
      createdAt: s.now,
    });
    await tx.insert(riskState).values({ merchantId });
    await tx.insert(merchantUsers).values({ id: ownerId, merchantId, phone: `+52${s.phone10}`, phoneVerified: false, role: "comercio", createdAt: s.now });
  });
  return { merchantId, ownerId };
}

/** La tienda de esta persona: la que ya tiene (p. ej. el dueño de la demo) o una nueva. */
export async function storeForPerson(db: Db, s: { ownerName: string; phone10: string; now: Date }): Promise<StoreRef> {
  return (await storeOfPhone(db, s.phone10)) ?? createStore(db, s);
}

/** Los 10 dígitos guardados (con o sin +52), sin exigir que sea un celular real: solo para comparar registros propios. */
function stored10(phone: string): string | null {
  return /^(?:52)?(\d{10})$/.exec(phone.replace(/\D/g, ""))?.[1] ?? null;
}

/**
 * Cuentas de antes (todas colgaban de la tienda de demo): cada una pasa a su propia tienda, salvo
 * la del dueño. Incluye las de números ficticios (empiezan con 0): nunca se quedan en una tienda
 * ajena. Idempotente; se corre al arrancar. Devuelve cuántas cuentas cambiaron de tienda.
 */
export async function assignAccountStores(db: Db, now: Date): Promise<number> {
  const accounts = await db.select().from(portalAccounts);
  let moved = 0;
  for (const a of accounts) {
    const phone10 = stored10(a.phone);
    if (!phone10) continue;
    const owner = await storeOwner(db, a.merchantId);
    if (owner && stored10(owner.phone) === phone10) continue;
    const store = await storeForPerson(db, { ownerName: a.name, phone10, now });
    if (store.merchantId === a.merchantId) continue;
    await db.update(portalAccounts).set({ merchantId: store.merchantId }).where(eq(portalAccounts.id, a.id));
    moved++;
  }
  return moved;
}

export interface DebtView {
  merchant_name: string;
  owes_cents: bigint;
  credit_cents: bigint;
  open_charge: { reference: string; amount_cents: bigint | null; channel: string | null; expires_at: Date | null } | null;
}

/**
 * Lo que esta persona le debe a otras tiendas: solo las relaciones donde la tienda la registró como
 * cliente con este celular. Nunca devuelve otros clientes ni datos de la tienda más allá del nombre.
 */
export async function debtsOfPhone(db: Db, phone10: string, ownMerchantId: string | null): Promise<DebtView[]> {
  if (!/^\d{10}$/.test(phone10)) return [];
  const rows = await db
    .select({ id: customers.id, merchantId: customers.merchantId, phone: customers.phone, merchantName: merchants.name })
    .from(customers)
    .innerJoin(merchants, eq(merchants.id, customers.merchantId))
    .where(and(like(customers.phone, `%${phone10}`), ownMerchantId ? ne(customers.merchantId, ownMerchantId) : undefined));
  const out: DebtView[] = [];
  for (const r of rows) {
    if (realPhone10(r.phone) !== phone10) continue;
    const owes = await ledgerBalance(db, r.merchantId, "1200", r.id);
    const credit = await ledgerBalance(db, r.merchantId, "2100", r.id);
    const [open] = await db
      .select({ reference: charges.reference, amountCents: charges.amountCents, channel: charges.channel, expiresAt: charges.expiresAt })
      .from(charges)
      .where(and(eq(charges.customerId, r.id), eq(charges.merchantId, r.merchantId), eq(charges.status, "open")))
      .orderBy(charges.createdAt)
      .limit(1);
    out.push({
      merchant_name: r.merchantName,
      owes_cents: owes,
      credit_cents: credit,
      open_charge: open ? { reference: open.reference, amount_cents: open.amountCents, channel: open.channel, expires_at: open.expiresAt } : null,
    });
  }
  return out.sort((a, b) => (b.owes_cents > a.owes_cents ? 1 : b.owes_cents < a.owes_cents ? -1 : a.merchant_name.localeCompare(b.merchant_name)));
}
