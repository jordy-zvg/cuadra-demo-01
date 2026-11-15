import { DEMO, schema, seedDemo } from "@cuadra/db";
import { createTestDb } from "@cuadra/db/testing";
import { describe, expect, it } from "vitest";
import { parsePortalReset, resetPortalAccounts } from "../src/portal-reset.js";

describe("PORTAL_RESET", () => {
  it("lee celular@fecha; lo que no cuadra se reporta enmascarado", () => {
    const r = parsePortalReset(" 8331550510@2026-11-15T01:40:00Z , 5512345678@2026-11-15T01:40Z,mal, 123@2026-11-15T01:40:00Z, 5512345678@ayer");
    expect(r.entries).toEqual([
      { phone10: "8331550510", before: new Date("2026-11-15T01:40:00Z") },
      { phone10: "5512345678", before: new Date("2026-11-15T01:40:00Z") },
    ]);
    expect(r.invalid).toEqual(["mal", "123@2026-11-15T01:40:00Z", "••••••5678@ayer"]);
    expect(parsePortalReset(undefined)).toEqual({ entries: [], invalid: [] });
  });

  it("borra solo las cuentas de ese celular creadas antes de la fecha; una nueva no se toca", async () => {
    const { db } = await createTestDb();
    await seedDemo(db);
    const acct = (id: string, phone: string, at: string) =>
      ({ id, merchantId: DEMO.merchantId, name: id, phone, pinHash: "scrypt$x$y", createdAt: new Date(at) });
    await db.insert(schema.portalAccounts).values([acct("vieja", "8331550510", "2026-11-14T20:00:00Z"), acct("otra", "5512345678", "2026-11-14T20:00:00Z")]);
    await db.insert(schema.portalSessions).values({ tokenHash: "h", accountId: "vieja", expiresAt: new Date("2026-12-01T00:00:00Z") });
    const reset = [{ phone10: "8331550510", before: new Date("2026-11-15T01:40:00Z") }];
    expect(await resetPortalAccounts(db, DEMO.merchantId, reset)).toEqual([{ phone_last4: "0510", deleted: 1 }]);
    expect((await db.select().from(schema.portalAccounts)).map((a) => a.id)).toEqual(["otra"]);
    expect(await db.select().from(schema.portalSessions)).toHaveLength(0); // la sesión se fue en cascada
    // Se vuelve a registrar con el mismo celular; si la variable se queda puesta, el siguiente arranque no la borra.
    await db.insert(schema.portalAccounts).values(acct("nueva", "8331550510", "2026-11-15T02:00:00Z"));
    expect(await resetPortalAccounts(db, DEMO.merchantId, reset)).toEqual([{ phone_last4: "0510", deleted: 0 }]);
    expect((await db.select().from(schema.portalAccounts)).map((a) => a.id).sort()).toEqual(["nueva", "otra"]);
  });
});
