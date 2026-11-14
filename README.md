# Cuadra

Agente de WhatsApp que cobra, concilia y paga por SPEI para la economía de barrio.
Reglas del proyecto en [CLAUDE.md](./CLAUDE.md).

## Desarrollo

```bash
pnpm install
pnpm test        # tests de todos los paquetes
pnpm coverage    # el guard exige 100% de cobertura
pnpm typecheck
docker compose up -d   # postgres + redis (para apps, aún no creadas)
```

## Estado

- [x] `packages/core`: money, clabe, ledger, proposals, guard (12 reglas), mandates, reminder-policy, reconciliation
- [ ] `packages/db`, `packages/adapters`, `packages/agents`
- [ ] `apps/api`, `apps/executor`, `apps/worker`, `apps/web`
