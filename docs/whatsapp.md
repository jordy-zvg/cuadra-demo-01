# WhatsApp · guía de integración (Joi)

Objetivo: que el comercio y sus clientes usen Cuadra desde WhatsApp. El agente ya funciona en el chat web;
WhatsApp es **otro canal del mismo agente**: no se toca la lógica de dinero (guard, ledger, pey).

Usa solo la documentación oficial de Meta (WhatsApp Cloud API) para nombres de campos, headers y
endpoints. Si algo no se comporta como dice la doc, anota request/response (sin tokens) y avísanos: no
inventamos campos (CLAUDE.md, principio 12).

## Dónde se conecta

**Entrada (mensajes que llegan a Cuadra).** Nueva ruta `POST /webhooks/whatsapp` en `apps/api/src/server.ts`
(y el `GET` de verificación que pide Meta):

| Llega de… | Llamar a… |
|---|---|
| El número del comercio, texto | `service.handleMerchantMessage(texto, "user_direct")` |
| El comercio, mensaje **reenviado** o imagen | `service.handleMerchantMessage(texto, "third_party_content")` |
| El comercio, nota de voz | transcribir (componente #9) y `handleMerchantMessage(texto, "user_voice")` |
| Botón “Confirmar” / “Cancelar” | `service.confirm(proposal_id)` / `service.cancel(proposal_id)` (el `proposal_id` viaja en el payload del botón) |
| Un cliente (opt-in “SÍ”, preguntas) | por ahora, solo registrar; componente #14 |

Reglas: verificar la firma del webhook de Meta antes de leer el cuerpo; deduplicar por id de mensaje
(reusar la tabla `webhook_events` con `provider = "whatsapp"`); responder 200 rápido.

**Salida (mensajes que manda Cuadra).** Implementa `OutboundChannel` de `apps/api/src/channel.ts`:

```ts
export interface OutboundChannel {
  readonly name: string;
  send(msg: { merchantId; thread; phone10; body; actions }): Promise<void>;
}
```

El servicio ya llama a `send` por cada mensaje que guarda y resuelve el celular desde la base
(`resolveThreadPhone`: comercio, cliente o integrante de tanda). Tú solo traduces:

| `actions[].kind` | En WhatsApp |
|---|---|
| `confirm` / `cancel` | botones de respuesta con el `proposal_id` |
| `approve`, `link`, `pay` | botón o texto con la URL (aprobación con passkey) |
| `qr` | imagen (viene como `data:image/png;base64,...`) |

Regístralo en `apps/api/src/main.ts` en `channels: [new WhatsAppChannel(...)]`. Si tu canal falla, el
servicio lo registra en logs y sigue: el dinero nunca depende de WhatsApp.

## Plantillas (mensajes que inicia el negocio)
Fuera de la ventana de 24 h, Meta exige plantillas aprobadas. Necesitamos al menos:
1. **Recordatorio de saldo** (cliente): nombre, comercio, monto, referencia.
2. **Recibo** (cliente).
3. **Turno de tanda** (integrante): ronda, a quién le toca, monto.
Usa el tono del chat web (“Si hoy no se puede, no pasa nada…”). La política de recordatorios (opt-in,
72 h, 9:00–20:00) ya la aplica el servicio.

## Variables (Railway, servicio `api`)
Tokens y secretos de Meta van como variables de entorno; nunca en el repo ni en logs.

## Listo cuando…
- Escribir “Doña Lupe se llevó $185” al número de prueba devuelve la propuesta con botones, y “Confirmar”
  registra el fiado (se ve en el panel).
- “Cóbrale a Doña Lupe” manda el recordatorio al WhatsApp del cliente.
- Un mensaje reenviado con una CLABE se bloquea con la explicación del guard.
- Tests: firma inválida → 400; mensaje duplicado → se procesa una vez; botón → `confirm`.
