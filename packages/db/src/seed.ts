import { clabeCheckDigit } from "@cuadra/core";
import type { Db } from "./client.js";
import { charges, customerOrderingClabes, customers, merchantUsers, merchants, payees, riskState } from "./schema.js";

const clabe = (first17: string) => first17 + clabeCheckDigit(first17);

/** Datos ficticios para demo y tests. Idempotente. */
export const DEMO = {
  merchantId: "m_lupe",
  ownerId: "u_lupe",
  ownerPhone: "+525500000001",
  customers: {
    rosa: { id: "c_rosa", name: "Rosa Martínez", phone: "+525500000101", virtualClabe: clabe("64618000000000001") },
    beto: { id: "c_beto", name: "Beto Ramírez", phone: "+525500000102", orderingClabe: clabe("01218000000000002") },
    chela: { id: "c_chela", name: "Chela Gómez", phone: "+525500000103" },
  },
  payees: {
    refrescos: { id: "p_refrescos", alias: "Distribuidora de refrescos", clabe: clabe("03218000000000003"), holder: "Distribuidora Ejemplo SA de CV" },
    pan: { id: "p_pan", alias: "Panadería", clabe: clabe("07218000000000004"), holder: "Panificadora Ejemplo SA de CV" },
  },
} as const;

export async function seedDemo(db: Db, now = new Date()): Promise<typeof DEMO> {
  const twoDaysAgo = new Date(now.getTime() - 48 * 3600_000);
  await db.transaction(async (tx) => {
    await tx
      .insert(merchants)
      .values({ id: DEMO.merchantId, name: "Abarrotes Doña Lupe", dailyLimitCents: 2_000_000n, maxOutflowsPerHour: 10 })
      .onConflictDoNothing();
    await tx.insert(riskState).values({ merchantId: DEMO.merchantId }).onConflictDoNothing();
    await tx
      .insert(merchantUsers)
      .values({ id: DEMO.ownerId, merchantId: DEMO.merchantId, phone: DEMO.ownerPhone, phoneVerified: true, role: "comercio" })
      .onConflictDoNothing();
    const { rosa, beto, chela } = DEMO.customers;
    await tx
      .insert(customers)
      .values([
        { id: rosa.id, merchantId: DEMO.merchantId, name: rosa.name, phone: rosa.phone, optIn: true, virtualClabe: rosa.virtualClabe },
        { id: beto.id, merchantId: DEMO.merchantId, name: beto.name, phone: beto.phone, optIn: true },
        { id: chela.id, merchantId: DEMO.merchantId, name: chela.name, phone: chela.phone, optIn: false },
      ])
      .onConflictDoNothing();
    await tx
      .insert(customerOrderingClabes)
      .values({ merchantId: DEMO.merchantId, clabe: beto.orderingClabe, customerId: beto.id })
      .onConflictDoNothing();
    await tx
      .insert(payees)
      .values(
        Object.values(DEMO.payees).map((p) => ({
          id: p.id,
          merchantId: DEMO.merchantId,
          alias: p.alias,
          clabe: p.clabe,
          holderName: p.holder,
          holderValidated: true,
          whitelisted: true,
          createdAt: twoDaysAgo,
        })),
      )
      .onConflictDoNothing();
    await tx
      .insert(charges)
      .values({ id: "ch_chela_1", merchantId: DEMO.merchantId, customerId: chela.id, reference: "4815162", uniqueAmountCents: 45017n })
      .onConflictDoNothing();
  });
  return DEMO;
}
