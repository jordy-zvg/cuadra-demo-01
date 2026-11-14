# Cuadra · Componentes a implementar

Estado al 14-nov-2026. **Responsables:** Jordy (pey), Joi (WhatsApp); el resto por asignar. Prioridad: **P0** activación y demo ·
**P1** las 4 semanas del hackathon · **P2** después.

## Canales

| # | Componente | Estado | Qué falta | Pri. | Esf. | Requiere | Responsable |
|---|---|---|---|---|---|---|---|
| 1 | **WhatsApp (Cloud API de Meta)** | Chat web simulado listo; mismo agente | Webhook de Meta (verificación + firma), recibir texto/audio/foto, enviar respuestas y botones interactivos (Confirmar/Cancelar), enlaces de passkey. Plantillas aprobadas para mensajes que inicia el negocio (recordatorios y recibos fuera de la ventana de 24 h). Mapear número del comercio y de clientes | P1 | M-L | Cuenta Meta Business, número de prueba, aprobación de plantillas | **Joi** (guía: `docs/whatsapp.md`) |
| 2 | **SMS** | — | Respaldo para clientes sin WhatsApp: recordatorio y recibo por SMS, OTP para verificar el teléfono del comercio. Elegir proveedor (Twilio, Infobip, etc.), remitente, opt-in/opt-out (“BAJA”) | P1 | S-M | Cuenta del proveedor y alta del remitente | |
| 3 | Chat web simulado | ✅ Listo | — | — | — | — | |

## Pagos

| # | Componente | Estado | Qué falta | Pri. | Esf. | Requiere | Responsable |
|---|---|---|---|---|---|---|---|
| 4 | **pey (cobros CoDi)** | ✅ Código y tests: push al celular, QR, cuenta receptora, webhooks, tanda | Llave real, secreto de webhook, URL del webhook en el portal, alta de CLABEs, prueba con $0.01. Agregar **link de pago** como alternativa (tarjeta o banco sin CoDi) | **P0** | S | Acceso a portal.pey.mx | **Jordy** (guía: `docs/pey.md`) |
| 5 | **Conciliación contra pey** | ✅ Cada 5 min y en `POST /api/reconcile/pey`: recupera webhooks perdidos y congela salidas ante diferencias | Tarea periódica que compare las transacciones `PAID` de pey (`/transaction/api-key`) con los abonos registrados: recupera webhooks perdidos y marca diferencias | P1 | S | #4 | |
| 6 | **Pagos salientes** (proveedores, devoluciones) | Executor, guard, mandatos y adapter de Fintoc listos; hoy sale de una cuenta simulada | Elegir proveedor (Fintoc, STP u Openpay), llaves de prueba y llave JWS, probar contra el sandbox | P1 | M | Alta con el proveedor | |
| 7 | Devolución de saldo a favor (flujo D) | Asientos y guard listos | Intención en el chat + aprobación + salida a la CLABE de origen del cliente | P2 | S | #6 | |

## IA

| # | Componente | Estado | Qué falta | Pri. | Esf. | Requiere | Responsable |
|---|---|---|---|---|---|---|---|
| 8 | Intérprete con Claude (3 extracciones + consenso) | ✅ Código y tests | `ANTHROPIC_API_KEY` en Railway; **set de evaluación de 300 mensajes reales** en español coloquial (meta del brief: 98 %) | P1 | M | Llave; recolectar mensajes | |
| 9 | **Notas de voz (STT)** | Dictado en el navegador (solo chat web) | Transcribir audios de WhatsApp (ogg) en el servidor; elegir proveedor | P1 | M | #1 | |
| 10 | **Foto de la libreta (OCR)** | — | Leer la foto, proponer varios fiados para confirmar uno por uno; marcarlo como contenido de terceros | P2 | M | #1 | |
| 11 | **Auditor** (LLM con veto) | El guard ya respeta `auditor_veto` | Modelo independiente que revise cada pago y solo pueda vetar | P1 | S-M | — | |
| 12 | **Red team en vivo** | ✅ 6,000 ataques por corrida en tests, 0 salidas indebidas | Agentes atacantes con LLM, contador en el panel y modo “el público dicta un ataque” | P1 | M | #8 | |

## Producto

| # | Componente | Estado | Qué falta | Pri. | Esf. | Requiere | Responsable |
|---|---|---|---|---|---|---|---|
| 13 | **Autenticación y multi-comercio** | Un solo comercio de demo; **la web no tiene login** (las salidas sí exigen passkey) | Alta de comercio con OTP (#1/#2), sesión, aislar datos por comercio, registro de su CLABE en pey y de su passkey | **P0** (mínimo: proteger la demo) / P1 | L | #1 o #2 | |
| 14 | Clientes y opt-in | Clientes sembrados | “Agrega a Doña Lupe, 55…”, y que el cliente acepte mensajes respondiendo “SÍ” | P1 | S-M | #1 | |
| 15 | Recordatorios programados | Manuales desde el chat | Tarea programada según reglas del comercio (p. ej. viernes), respetando la política | P1 | S | #1 | |
| 16 | Panel de operación | Panel en vivo de solo lectura | Cola de revisión de abonos 1300, freno de emergencia, historial | P1 | S-M | #13 | |
| 17 | Nivel 2 Bis | ✅ Monitor con UDI configurada a mano | UDI automática (API SIE de Banxico, token); parte no digital (backlog de efectivo) | P2 | S | Token SIE | |
| 18 | Pagos en efectivo | Backlog acordado | Cuenta de caja en el catálogo y su asiento | P2 | S | Decisión contable | |
| 19 | Simulador 1,000 comercios × 30 días | — | Estrés del ledger y la conciliación (meta: 0 descuadres) | P2 | M | — | |

## Entrega, operación y legal

| # | Componente | Estado | Qué falta | Pri. | Esf. | Requiere | Responsable |
|---|---|---|---|---|---|---|---|
| 20 | Activación del hackathon | Borrador en `docs/entrega.md`; app en vivo en Railway | **Hacer público el repo**, integrantes y correos, enviar el formulario | **P0** | S | — | |
| 21 | CI y operación | Tests locales | GitHub Actions con los tests en cada push, respaldos de Postgres, alertas de errores | P1 | S | — | |
| 22 | Pitch y demo | Guion en el README | Video de respaldo, slides con el ángulo social y de Banxico, ensayo | P1 | M | — | |
| 23 | Legal y privacidad | — | Aviso de privacidad (LFPDPPP), términos, opinión legal sobre la tanda sin pozo, política de WhatsApp | P1 | M | Asesoría | |

**Esfuerzo:** S ≈ medio día · M ≈ 1–3 días · L ≈ 1 semana.
