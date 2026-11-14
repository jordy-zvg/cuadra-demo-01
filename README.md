# Cuadra

Agente de WhatsApp que cobra, concilia y paga por SPEI para la economía de barrio.
Reglas del proyecto en [CLAUDE.md](./CLAUDE.md).

## Desarrollo

```bash
pnpm install
pnpm test        # tests de todos los paquetes
pnpm coverage    # el guard exige 100% de cobertura
pnpm typecheck
docker compose up -d   # postgres + redis
cp .env.example .env   # y llena los valores locales
pnpm --filter @cuadra/db db:migrate
pnpm --filter @cuadra/db db:seed
pnpm --filter @cuadra/executor start
```

Los tests de DB corren contra PGlite (Postgres real en proceso); no necesitan Docker.
Para probar contra un Postgres de verdad: `TEST_DATABASE_URL=postgres://... pnpm --filter @cuadra/db test`
(usa una base vacía y desechable).

## Estado

- [x] `packages/core`: money, clabe, ledger, proposals, guard (12 reglas), mandates, reminder-policy, reconciliation
- [x] `packages/db`: esquema con invariantes en SQL (Σdebe = Σhaber diferido, append-only, CLABE válida,
      idempotencia), ledger, propuestas/aprobaciones/mandatos, transferencias, abonos, conciliación, webhooks, seed
- [x] `packages/adapters`: proveedor mock con webhooks firmados; **Fintoc** (MX, API v2026-02-01: JWS RS256,
      Idempotency-Key, webhooks `Fintoc-Signature`) probado contra la documentación, aún no contra el sandbox;
      verificación de passkey ligada al hash
- [x] `apps/executor`: guard revalidado con el comercio bloqueado, reserva + asiento en la misma transacción, envío idempotente
- [ ] `packages/agents`, `apps/api`, `apps/worker`, `apps/web`
