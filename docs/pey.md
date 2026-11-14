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

## Conciliación automática
Con pey en vivo, la API compara cada 5 minutos (`PEY_RECONCILE_MS`) las transacciones de pey de los últimos
7 días con lo que Cuadra registró:
- Pagado en pey y no registrado (webhook perdido) → se aplica igual que el webhook y se avisa al comercio.
- Registrado en Cuadra y no pagado en pey, o con otro monto → se congelan las salidas y se avisa.
Corrida manual: `POST /api/reconcile/pey`. El panel muestra la última en la tarjeta “Conciliación”.

## Vencimientos
La solicitud al celular por un fiado vence en 6 min (el mínimo de pey) y el QR en 30 min, más 2 min de margen;
mientras está viva no se manda otra, para que el cliente no pague doble. Después:
- **Reenvío:** “Vuélvele a mandar la notificación” (o “Cóbrale a…”) reenvía solo la solicitud, sin otro mensaje,
  hasta 3 veces por recordatorio. Los recordatorios programados nunca reenvían.
- **QR:** “QR para Doña Lupe” si el cliente está en la tienda.
- La regla de 72 h entre recordatorios sigue; en desarrollo se baja con `REMINDER_COOLDOWN_HOURS=0`.
La solicitud de una tanda dura 1 h (`TANDA_PN_TTL_S`). Si el pago de un cobro vencido llega tarde, se aplica igual.

Para que nunca haya dos solicitudes que el cliente pueda pagar:
- **Antes de reenviar o de generar un QR** se consulta a pey (`GET /transaction/{id}`) cada solicitud al celular
  de la última hora que Cuadra dio por vencida. Si ya estaba pagada (webhook perdido), se registra y no se manda
  otra; si pey no responde, no se manda nada.
- **Si pey no responde al crear la solicitud** (red, 5xx o 20 s sin respuesta), pudo haberse creado: el cobro
  queda abierto hasta que venza y bloquea otra solicitud o un QR. Solo un rechazo explícito (4xx) la cancela.
- Una propuesta se confirma una sola vez, dentro de 10 min y por el monto que se mostró; los cobros a un mismo
  cliente se ejecutan de uno en uno.
