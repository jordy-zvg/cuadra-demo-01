# pey · guía de conexión (Jordy)

Objetivo: que la demo cobre por CoDi de verdad. El código ya está hecho y probado
(`packages/adapters/src/pey`, `apps/api/src/gateway.ts`); falta conectar cuentas.
Referencia: https://docs.pey.mx (spec: https://docs.pey.mx/openapi.json).

## 1. Portal
1. Entra a **portal.pey.mx**, crea tu perfil y da de alta una cuenta de cobro. Hoy puedes usar una de las
   CLABEs pre-autorizadas que repartieron en el evento (las nuevas tardan hasta 5 días hábiles con Banxico).
2. Crea una **API key** (Desarrollador). Cópiala; no la pegues en el chat ni en el repo.
3. En la misma API key configura el **webhook**: `https://api-production-3d19d021.up.railway.app/webhooks/pey`
   y guarda el **secreto** (`whsec_...`).

## 2. Probar la llave desde tu computadora (antes de tocar Railway)
```bash
export PEY_API_KEY=...            # solo en tu terminal
pnpm pey:check transacciones      # 200 = la llave sirve
pnpm pey:check cobro 55XXXXXXXX   # te llega una solicitud CoDi de $0.01 a tu banco
pnpm pey:check transaccion <transactionId>   # después de aprobarla: status PAID
```
Si algo falla, el script imprime `status`, `type` y `requestId` (sin la llave): con eso se lo puedes
preguntar a Ramón en el evento.

Opcional, cuenta receptora por cobro (también la usa la tanda):
```bash
pnpm pey:check cuenta-alta 0121800... "Nombre del titular"   # devuelve id y codiStatus
pnpm pey:check cuenta <id>                                     # espera a ACTIVE
```

## 3. Railway (proyecto `cuadra`, servicio `api`, pestaña Variables)
| Variable | Valor |
|---|---|
| `PEY_API_KEY` | la llave |
| `PEY_WEBHOOK_SECRET` | el `whsec_...` |
| `DEMO_CUSTOMER_PHONE` | tu celular con CoDi (hará de Doña Lupe). **Sin él no se manda ningún cobro**: los celulares de demo son ficticios (empiezan con 0) y Cuadra nunca les envía nada |
| `PEY_BANK_ACCOUNT_ID` | opcional: id de la cuenta receptora ACTIVE del comercio |

Al guardar, Railway redespliega. El panel debe cambiar de “CoDi simulado” a **“CoDi en vivo vía pey”**.

## 4. Prueba de punta a punta (montos de $0.01)
1. En la app: `Doña Lupe se llevó $0.01` → Confirmar.
2. `Cóbrale a Doña Lupe` → Confirmar → te llega la solicitud CoDi.
3. Apruébala en tu banco → en segundos: recibo en el teléfono de Doña Lupe, “💰 pagó” en el chat del
   comercio, cobro ✅ en el panel y la balanza cuadrada.
4. `QR para Doña Lupe` (después de otro fiado) → escanéalo con tu banco.

Si el paso 3 no llega: revisa en el portal de pey el historial del webhook (Webhook Logs) y en Railway los
logs del servicio `api` (`pey_webhook`).

## Preguntas abiertas para pey
- ¿`amountBreakdown.fee` y `applicationFee` se descuentan de lo que llega a la CLABE del comercio? Hoy
  abonamos el `base`.
- ¿Una CLABE pre-autorizada registrada por API (`POST /bank-account`) queda `ACTIVE` de inmediato?
- ¿Hay sandbox o el plan es probar en producción con $0.01 (como dice la spec)?
