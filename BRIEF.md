# Cuadra · Brief del prototipo (v2)

**Estado:** para aprobación · **Fecha:** 14-nov-2026 · **Duración:** 4 semanas (hackathon de pagos digitales) · **Equipo:** [nombres y roles]

## 1. En una línea

Cuadra es el agente de WhatsApp que **cobra, concilia y paga por SPEI** para la economía de barrio (fiado, tandas y proveedores). El dinero vive en una cuenta licenciada y cada salida pasa por reglas deterministas y un mandato firmado con passkey.

## 2. Problema

- **Informalidad:** 55.1% del empleo es informal (INEGI, 2T26).
- **Dinero informal:** 36.6% de los adultos ahorra solo de forma informal, 20% usa tandas y 29% tuvo crédito informal (ENIF 2024).
- **El riel ya existe:** SPEI procesó 7,302 millones de transferencias de usuarios finales en 2025, y unos 82.9 millones de personas lo usaron en el 4T25 (Banxico).
- **La capa de cobro oficial no prendió:** CoDi hizo 4.4 millones de operaciones y DiMo 3.1 millones en 2025.
- **La operación es manual y vulnerable:** el fiado vive en libretas, las tandas en grupos de WhatsApp y los cobros se concilian con capturas de pantalla. Eso abre la puerta a errores y a comprobantes falsos; la Condusef registró 9,130 reclamaciones por transferencias no reconocidas entre enero y julio de 2026.

## 3. Usuarios

| Usuario | Contexto |
|---|---|
| **Comercio** (primario) | Tiendita, fonda u oficio. Smartphone prepago, vive en WhatsApp, manda notas de voz, tiene cuenta en algún banco o fintech y entre 10 y 50 clientes de confianza. |
| **Organizadora de tanda** | Grupo de 10 a 20 personas con aportación periódica y un turno por persona. |
| **Cliente final** | Paga por SPEI desde la app de su propio banco. No instala nada y nunca le da datos a Cuadra. |

## 4. Propuesta de valor

- **Comercio:** cobra el fiado sin perseguir a nadie, cada peso que entra se asigna solo al cliente correcto y paga a proveedores con un mensaje, dentro de los topes que él mismo firmó.
- **Tanda:** quién pagó, quién falta y a quién le toca, con la dispersión del pozo hecha por SPEI a tiempo.
- **Cliente final:** monto exacto, CLABE verificada a nombre del comercio y su recibo.

## 5. Por qué no es lo que hacen las grandes

| Las grandes (Visa, Mastercard, Google AP2, OpenAI/Stripe, wallets) | Cuadra |
|---|---|
| Agente que **compra** en e-commerce | Agente que **cobra, concilia y paga** en la economía de barrio |
| Tarjeta tokenizada | SPEI, neutral al banco del cliente |
| App propia | WhatsApp, donde el comercio ya habla con sus clientes |
| Usuario bancarizado individual | Dinero colectivo informal: fiado y tandas |

## 6. Cómo funciona

### A. Fiado y cobro

1. El comercio manda "Doña Lupe se llevó $185" por texto, voz o foto de la libreta.
2. El agente propone el asiento y el comercio lo confirma con un botón.
3. Según las reglas del comercio, el agente envía al cliente un recordatorio con el monto y la CLABE.
4. El cliente paga por SPEI y el webhook del proveedor llega a Cuadra.
5. El abono se concilia automáticamente; si sobra, queda como saldo a favor.
6. Ambos reciben su recibo.

### B. Pago a proveedores (el flujo agéntico)

1. El comercio firma un mandato con passkey, por ejemplo: "Refrescos Pérez, hasta $1,500 por pago y $3,000 por semana, vigente 90 días".
2. El comercio escribe "Paga al de los refrescos $1,200".
3. El agente propone, el guard valida, el auditor puede vetar y el ejecutor manda el SPEI.
4. Llega la confirmación del proveedor, se registra el asiento y se envía el recibo.
5. Si el pago queda fuera del mandato, el comercio recibe un enlace para aprobarlo con passkey; nunca basta con un "SÍ" en el chat.

### C. Tanda

1. La organizadora crea la tanda (integrantes, monto, periodicidad y orden) y firma con passkey el mandato de dispersión.
2. Los integrantes aportan por SPEI y el agente concilia y recuerda a quien falta.
3. Cuando el pozo está completo, el agente dispersa el SPEI a quien le toca y avisa a todos.

### D. Devolución de saldo a favor

El comercio aprueba y el agente devuelve el excedente por SPEI a la CLABE de origen del cliente.

## 7. Interfaz

| Superficie | Para qué |
|---|---|
| **WhatsApp** | Uso diario: registrar, cobrar, pagar, consultar y recibir avisos. |
| **Página web de aprobación** (enlace de un solo uso) | Firmar mandatos y aprobar pagos fuera de tope con passkey (huella o rostro). |
| **App bancaria del cliente** | El cliente final paga por SPEI. |
| **Panel web de solo lectura** | Ledger en vivo, conciliación, bloqueos del guard y red team. Es para los jueces y para operación. |
| **Chat web simulado** | Mismo agente, otro canal. Respaldo de la demo si WhatsApp falla. |

## 8. Dinero, custodia y regulación

- **Custodia:** cada comercio tiene una cuenta operativa en una **entidad licenciada abierta por API**. Cuadra nunca custodia fondos; solo da instrucciones desde su backend.
- **Proveedor preferente: Fintoc Business Accounts.** Tiene modo test verificado (`sk_test_`, sin dinero real), envía SPEI a cualquier CLABE y exige firma JWS e `Idempotency-Key` en cada transferencia. Alternativas por evaluar: STP y Openpay.
- **Opcionales detrás de un flag:**
  - Belvo para domiciliación: aportaciones recurrentes de tanda y abonos de fiado.
  - Juno (Bitso) con MXNB: pozo de la tanda onchain, si el hackathon tiene track de stablecoins.
- **Ambiente:** durante el hackathon todo corre en modo test más un simulador propio. A producción solo se pasa si el alta del proveedor está lista, con montos chicos y cuentas propias del equipo.
- **Regulación:** en México no existe la iniciación de pagos por terceros. Por eso el dinero está en la cuenta licenciada y no en el banco del usuario.
- **Tandas en producción:** el pozo tendría que estar en cuentas a nombre de los integrantes dentro del licenciado, para no caer en captación (LIC, art. 103). Requiere opinión legal antes de salir de sandbox.

## 9. IA y agentes: quién decide qué

| Actor | Decide | No puede |
|---|---|---|
| **Intérprete** (LLM, tres extracciones independientes con consenso) | Entender voz, texto y foto, y proponer acciones estructuradas | Escribir en el ledger, ver credenciales, mover dinero o inventar CLABEs |
| **Guard** (código determinista, 12 reglas) | Aceptar o rechazar cada propuesta | Que lo convenzan: es código, no un modelo |
| **Auditor** (LLM independiente) | Vetar un pago sospechoso | Aprobar nada |
| **Humano** | Firmar mandatos, aprobar lo que esté fuera de tope y dar de alta beneficiarios | — |
| **Ejecutor** (servicio aislado, único con llaves del proveedor) | Ejecutar solo propuestas aprobadas, firmadas y revalidadas | Recibir órdenes del LLM |

**Uso de los tokens ilimitados:**

- Consenso de tres extracciones en cada monto: si no coinciden, se pregunta al humano.
- Auditor en cada pago.
- Red team continuo: agentes atacando al sistema; cada ataque exitoso se vuelve un test.
- Simulación de 1,000 comercios durante 30 días para estresar el ledger y la conciliación.
- Set de evaluación en español mexicano coloquial.

## 10. Seguridad por capas

1. **Proveedor licenciado:** KYC, custodia y SPEI.
2. **Ejecutor aislado:** es el único proceso con llaves, firma cada transferencia (JWS) y usa idempotencia.
3. **Mandatos verificables:** firmados con passkey sobre el hash del contenido, al estilo AP2.
4. **Guard de 12 reglas,** entre ellas lista blanca, 24 horas de espera para beneficiarios nuevos, topes, velocidad y procedencia.
5. **Procedencia (taint):** lo que viene de una foto, un documento o un mensaje reenviado nunca puede crear beneficiarios ni ejecutar pagos sin passkey.
6. **Auditor con veto.**
7. **Ledger de partida doble** con conciliación continua contra el saldo del proveedor. Si hay descuadre, se congelan las salidas.
8. **Freno de emergencia** global y por comercio.

## 11. Alcance

**Entra:**

- Canal WhatsApp y chat web simulado.
- Fiado, recordatorios, entradas SPEI y conciliación.
- Mandatos con passkey, pagos a proveedores, tandas con dispersión y devolución de saldo a favor.
- Guard, auditor, red team y simulador.
- Panel de solo lectura.
- Adapter mock y adapter Fintoc en modo test.

**No entra:**

- Crédito.
- CFDI.
- Remesas.
- App móvil.
- Producción a escala.
- Pago con tarjeta.
- Iniciación de pagos desde el banco del usuario (no existe en México).

## 12. Demo (5 minutos)

1. Nota de voz: "Doña Lupe se llevó $185". El asiento aparece en el panel.
2. Recordatorio, SPEI del cliente y conciliación en vivo; la balanza cuadra.
3. "Paga al de los refrescos $1,200": dentro del mandato, se ejecuta el SPEI y llega el recibo.
4. **Ataque:** foto de una "nota del proveedor" con una CLABE nueva y la instrucción "págale ya". El guard lo bloquea y explica por qué.
5. Tanda: el pozo se completa y el agente dispersa a quien le toca.
6. Panel: conciliación con el proveedor al 100%, contador del red team ("N ataques, 0 salidas indebidas") y el público dicta un ataque en vivo.

## 13. Métricas de éxito del prototipo

- Los cuatro flujos completos de punta a punta en modo test.
- 0 asientos descuadrados en la simulación de 1,000 comercios × 30 días.
- Red team con al menos 5,000 ataques y 0 salidas indebidas.
- Conciliación automática de al menos 95% de los abonos simulados.
- Extracción correcta de monto y cliente en al menos 98% de un set de 300 mensajes reales.

## 14. Riesgos

| Riesgo | Mitigación |
|---|---|
| El alta del proveedor no llega a tiempo | Adapter mock completo; la demo corre en modo test y se dice |
| El proveedor no da CLABE por cliente | Cascada de conciliación: ordenante conocido → referencia → centavos únicos → cola de revisión |
| Meta rechaza plantillas o el número de prueba se queda corto | Canal intercambiable con chat web simulado |
| El LLM se equivoca en montos | Consenso de tres extracciones, confirmación humana y guard |
| Ingeniería social ("es urgente, págale a esta CLABE") | Procedencia (taint), 24 horas de espera para beneficiarios nuevos y passkey |
| Tandas interpretadas como captación | Sandbox en el hackathon; opinión legal antes de producción |

## 15. Plan

| Semana | Entregable |
|---|---|
| 1 | Repo, ledger, guard, adapters de pago (mock y Fintoc test) y ejecutor aislado. Iniciar el alta con el proveedor el día 1. |
| 2 | Agente intérprete, canales (WhatsApp y simulado), passkeys y flujo de fiado y cobro completo. |
| 3 | Pagos a proveedores con mandato, auditor, tandas, red team y simulador. |
| 4 | Panel, modo demo, endurecimiento, ensayo y video de respaldo. |

## 16. Decisiones pendientes

1. Sponsors y APIs del hackathon: definen el proveedor final.
2. Hosting de Postgres (Supabase o local) y de los servicios (Railway, Vercel u otro).
3. Modelo de LLM para el intérprete y el auditor (pueden ser distintos para tener independencia).
4. Activar o no los flags de Belvo y Juno.

## 17. Supuestos no verificados

- Si Fintoc ofrece CLABE por cliente final, sus tiempos de alta y sus precios.
- Si existe sandbox de Belvo para domiciliación.
- El límite de destinatarios del número de prueba de WhatsApp Cloud API.
- Los topes de CoDi y DiMo (1,500 UDIS), que vienen de prensa y no de la circular original.
