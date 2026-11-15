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

## Código para verificar el celular (plantilla de autenticación)
Al crear su cuenta, Cuadra le manda a la persona un código de 6 números por WhatsApp y ella lo escribe en
el portal (`POST /api/auth/verify/start` y `POST /api/auth/verify/check`, en `apps/api/src/auth.ts`).
- Plantilla `cuadra_codigo`, categoría **AUTHENTICATION**, botón «Copiar código». Meta fija el texto
  («*123456* es tu código de verificación.», no compartirlo y «caduca en 10 minutos»). Se da de alta con el
  mismo `pnpm --filter @cuadra/api templates:create` (va al final de la lista). Meta solo permite mandar
  códigos con plantillas de autenticación.
- El código vence en 10 minutos (igual que la plantilla) y admite 5 intentos. Solo se guarda el hash, y
  **solo después de que WhatsApp aceptó el mensaje**: un código que Meta rechaza (o que sigue en camino)
  nunca sirve. Nunca va a la pantalla ni al log.
- Topes **por celular** (registrarse de nuevo no los reinicia), contando todos los intentos de envío, también
  los rechazados: uno a la vez y el siguiente después de un minuto; a lo más 5 por hora y 10 al día; tras un
  rechazo, 10 minutos directo al respaldo sin llamar a Meta; con 10 códigos equivocados en 24 horas, ese
  celular ya no recibe códigos (solo el respaldo). En todo Cuadra, a lo más 200 intentos al día (costo y
  reputación del número). Cada intento se aparta en `phone_code_sends` antes de llamar a Meta, con un
  candado de Postgres por celular, así que dos pestañas o dos procesos a la vez no mandan dos mensajes.
- **Respaldo:** si WhatsApp no lo entrega (plantilla aún sin aprobar, error 132001; celular fuera de la
  lista del número de prueba, error 131030) o se llegó a un tope, el portal pasa solo al camino anterior:
  muestra un código y la persona lo manda desde su celular. Ese código es otro y solo sirve por WhatsApp;
  el que manda Cuadra solo sirve escrito en el portal.
- Con el número de prueba, el código solo llega a los celulares de la lista de destinatarios de la app de
  Meta; con un número de producción, a cualquiera.

## Variables (Railway, servicio `api`)
Tokens y secretos de Meta van como variables de entorno; nunca en el repo ni en logs.

| Variable | De dónde sale |
|---|---|
| `WHATSAPP_TOKEN` | Token de acceso (usuario del sistema) de la app de Meta |
| `WHATSAPP_PHONE_NUMBER_ID` | WhatsApp → Configuración de la API, ID del número |
| `WHATSAPP_APP_SECRET` | Configuración básica de la app → Clave secreta (firma `X-Hub-Signature-256`) |
| `WHATSAPP_VERIFY_TOKEN` | Texto que inventamos y pegamos igual en Meta al registrar el webhook |
| `WHATSAPP_WABA_ID` | Solo para `pnpm --filter @cuadra/api templates:create` |
| `DEMO_OWNER_PHONE` | Celular real del comercio: el único que da instrucciones por WhatsApp |

Webhook en Meta: `<PUBLIC_URL>/webhooks/whatsapp`, suscrito al campo `messages`. Sin las cuatro primeras
variables la ruta no existe y la app sigue con el chat web.

## Estado (14-nov)
- Hecho: webhook con firma y verificación, deduplicación por id, solo el comercio da instrucciones,
  reenviados como `third_party_content`, botones Confirmar/Cancelar, **QR de cobro como imagen** (se sube
  con `POST /{phone-number-id}/media` y se manda con pie de foto), plantillas (7, ver
  `apps/api/src/whatsapp-templates.ts`) y aviso genérico al comercio si su ventana de 24 h cerró.
- 15-nov: el código de verificación del celular sale por WhatsApp (`cuadra_codigo`, autenticación); falta darla
  de alta y que Meta la apruebe. Mientras tanto se usa el respaldo. La revisión de seguridad del mismo día
  (migración 0017) cerró que un código rechazado sirviera mientras Meta contestaba y que registrarse de nuevo
  reiniciara los topes.
- Falta: probar contra Meta con llaves reales, aprobación de plantillas, notas de voz (#9) y fotos (#10).

## Listo cuando…
- Escribir “Doña Lupe se llevó $185” al número de prueba devuelve la propuesta con botones, y “Confirmar”
  registra el fiado (se ve en el panel).
- “Cóbrale a Doña Lupe” manda el recordatorio al WhatsApp del cliente.
- Un mensaje reenviado con una CLABE se bloquea con la explicación del guard.
- Tests: firma inválida → 400; mensaje duplicado → se procesa una vez; botón → `confirm`.
