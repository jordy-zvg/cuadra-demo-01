# Cuadra frente a lo que ya existe

Investigación del 16-nov-2026, hecha con búsqueda web y leyendo el código de los repos públicos. Algunas páginas
(treinta.co, App Store) no se pudieron abrir completas; ahí se trabajó con fragmentos de búsqueda. Marcas:
**[F]** hecho con fuente · **[I]** inferencia nuestra · **[NV]** no verificado.

## El diferencial, en una frase

> **Las libretas te recuerdan quién te debe; las terminales cobran sin saber qué. Cuadra le cobra a tu cliente
> exactamente esa deuda por CoDi, la cierra sola cuando paga, y no deja salir un peso sin tu permiso.**

Versión larga, para el pitch: el comercio dicta el fiado como siempre («Doña Lupe se llevó $185»). Cuadra le manda
a la clienta una solicitud de cobro que llega a la app de su banco, sin instalar nada y sin comisión. Cuando paga,
el abono se concilia solo contra esa deuda en un libro contable de partida doble. Si paga en efectivo, también queda
anotado. Nadie custodia el dinero.

## Mapa de competidores

| Producto | Fiado | Cobro digital de la deuda | Tandas | ¿El cliente instala algo? | ¿Concilia el pago contra la deuda? | Precio |
|---|---|---|---|---|---|---|
| **Treinta** (Colombia, activo en México) | Sí [F] | Recordatorios; no encontramos cobro CoDi [F/NV] | No [I] | No | Sin evidencia [NV] | Pro 399 MXN/mes [F] |
| **Kyte** (Brasil) | Solo en plan PRO [F] | Estado de cuenta por WhatsApp o correo [F] | No | No | No [I] | 19.99–29.99 USD/mes [F] |
| **Libretas de fiado** (Mis Fiados, Fiado, Mis Deudas) | Sí [F] | Solo aviso; «Fiado» cobra por WhatsApp a mano [F] | No | No | No [I] | Gratis/freemium [NV] |
| **Mercado Pago** (QR/Point) | No | QR y link, sin ligarlos a una deuda | No | Para pagar con saldo, cuenta MP [I] | No | ≈0.6% QR con saldo [NV] |
| **Clip** | No | Link de pago [F] | No | No | No | 3.6% + IVA tarjeta [F] |
| **Spin / OXXO Pay** | No | Referencia para pagar en OXXO | No | Spin es app del cliente [F] | No | ≈3.9% + IVA [F] |
| **CoDi/DiMo en la app del banco** (BBVA, Banorte, HSBC…) | No | QR o push al celular [F] | No | No [F] | No: el comercio concilia a mano [I] | CoDi sin costo [F] |
| **BEES** (Grupo Modelo) | Es crédito del proveedor al tendero, no al revés [F] | — | — | — | — | — |
| **Apps de tanda** (Tandapp y similares) | — | No procesan pagos (Tandapp) [F] | Solo registro [F] | Sí, cada integrante [I] | No | Gratis/freemium [NV] |
| **Cóbrale / Libreta** ([repo](https://github.com/ddzendreros/cobrale-mcp), otro equipo de hackathon) | Sí, por voz o foto de la libreta [F] | QR, push CoDi y link por pey [F] | No [F] | No | Sí, pero al final empareja solo por monto [F] | Sin precio; licencia propietaria [F] |
| *India: OkCredit / Khatabook* | Sí | Recordatorio con link UPI; el pago se asienta solo [F] | No | No | Sí [F] | Gratis; ingresos por anuncios o préstamos [F] |

## Huecos que hoy nadie cubre en México y Cuadra sí

1. **Fiado → cobro → conciliación en un solo flujo, sin que el cliente instale nada.** Las libretas solo
   recuerdan, y los rieles de pago solo cobran, sin saber de qué deuda viene el dinero. En India esto ya existe
   (OkCredit, Khatabook) [F]. En México solo encontramos a Cóbrale, sin libro contable.
2. **Conciliación que nunca adivina, sobre un libro de partida doble.**
   - Cuadra concilia en cascada: CLABE virtual, CLABE ordenante, referencia, centavos únicos. Lo que no cuadra va
     a «por identificar».
   - Cóbrale guarda montos en pesos con decimales en un archivo JSON y, si nada más coincide, empareja solo por
     monto [F-código].
3. **Efectivo y CoDi en la misma cuenta del cliente.**
   - El abono en efectivo se anota en su propia cuenta (1050) y nunca se mezcla con la cuenta operativa.
   - No se anota si hay una solicitud CoDi viva, para que nadie pague doble.
4. **Tanda sin pozo.** Cada aportación se cobra por CoDi directo a la cuenta de quien le toca. Las apps de tanda
   solo registran [F]. Las tandas importan: alrededor del 20% de quienes ahorran lo hace así (ENIF 2024) [F].
5. **Pagos a proveedores con candados.**
   - Un guard determinista de 12 reglas.
   - Permiso firmado (mandato) o aprobación en el dispositivo (passkey).
   - Ningún competidor dirigido a la tiendita hace pagos salientes con controles [I].
6. **Cobranza respetuosa por WhatsApp.**
   - Solo a quien aceptó recibir mensajes, uno cada 72 h, de 9 a 20 h.
   - La política de WhatsApp y la ley de datos piden ese consentimiento [F]. Los demás mandan mensajes a mano y
     sin límites [I].
7. **Tope de la cuenta Nivel 2 Bis.** Ningún competidor lo menciona [NV].

## Dónde nos ganan (y qué hacemos al respecto)

| Nos ganan en… | Qué hacemos |
|---|---|
| **Distribución:** Mercado Pago y Clip ya están en el mostrador; BBVA tiene convenio con ANPEC | No competir por el mostrador: Cuadra cobra **lo que se fió**, que hoy no cobra nadie. Un piloto en una colonia antes de hablar de escala |
| **Medios de pago:** tarjeta, meses sin intereses, OXXO | CoDi sin comisión más el efectivo anotado. El 14-dic-2026 los bancos deben simplificar CoDi y DiMo: el lado del que paga mejora justo después de la final |
| **Amplitud:** Treinta y Kyte traen punto de venta, inventario y catálogo | No es nuestro problema. Cuadra empieza donde el punto de venta termina: el día que el cliente se lleva sin pagar |
| **Escala probada en India** (OkCredit, Khatabook), con monetización débil (anuncios, préstamos) [F] | El modelo de negocio no puede depender solo de anuncios: historial verificable para crédito con socio regulado y tandas (modelo de negocio por escribir) |
| **Cóbrale** ya cobró $0.01 real, lee fotos de la libreta y es un servidor MCP que puede usar cualquier agente | Documentar nuestro cobro real con su número de transacción. Que la demo muestre lo que Cóbrale no tiene: conciliación sin adivinar, efectivo, tanda y el bloqueo de un pago malicioso |

## Cóbrale en detalle (el más parecido)

Lo revisamos leyendo el código; no se ejecutó.

**Qué es:**
- Un servidor Node/Express con un servidor MCP. Herramientas: `cobrar_con_qr`, `cobrar_a_celular`,
  `crear_link_de_pago`, `esperar_pago`, `pagos_recibidos` y `cancelar_cobro`.
- Encima, «Libreta»: el tendero dicta («Apúntale 85 a Doña Mary») o sube una foto de su libreta de papel.
- Usa pey y CoDi, igual que nosotros.

**Diferencias con Cuadra:**

| | Cóbrale | Cuadra |
|---|---|---|
| Montos | Pesos con decimales (float) en `data/db.json` | Centavos (`bigint`) en un ledger de partida doble append-only, con reversos y saldo a favor |
| Pago de más | El excedente se pierde (`min(monto, saldo)`) | Va a saldo a favor del cliente (2100) |
| Conciliación | `chargeId` → referencia y monto → **solo monto** | Cascada sin adivinar; lo dudoso va a la cuenta 1300 y a revisión |
| WhatsApp | Texto con IA y enlace `wa.me` que abre el tendero; sin consentimiento ni límites | Canal real con consentimiento, tope de 72 h, horario y reenvío controlado |
| Salidas de dinero | No hace | Guard, mandato y passkey |
| Tandas, efectivo, Nivel 2 Bis | No | Sí |

**Lo que tiene y nosotros no:** foto de la libreta de papel, MCP para empresas, video promocional. Madurez:
alrededor de 33 commits, todos del 8-nov-2026, y 13 pruebas.

## Fuentes

- Treinta: https://treinta.co/mx/funcionalidades/ · https://treinta.co/planes-y-precios/
- Kyte: https://www.kyteapp.com/engage/pay-later-system
- Libretas de fiado: https://apps.apple.com/mx/app/mis-fiados/id6739773148 · https://www.producthunt.com/products/fiado/launches
- Mercado Pago: https://www.mercadopago.com.mx/blog/comisiones-point-mercado-pago-mexico
- Clip: https://payclip.com/press-releases-list/clip-unveils-its-new-tap-to-pay-solution
- Spin/OXXO: https://expansion.mx/empresas/2026/11/04/oxxo-clientes-usuarios-tajeta-spin-desafiar-nu
- CoDi/DiMo: https://expansion.mx/finanzas-personales/2026/04/09/cobrar-con-tarjeta-sin-comisiones-codi-banxico ·
  https://www.hsbc.com.mx/content/dam/hsbc/mx/documents/digital/codi/cobro_CoDi_con_notificaciones.pdf
- BBVA/ANPEC: https://www.bbva.com/es/mx/empresas/bbva-mexico-y-la-anpec-firman-convenio-para-digitalizar-y-fortalecer-al-pequeno-comercio/
- BEES: https://www.milenio.com/negocios/grupo-modelo-digitaliza-90-de-ingresos-netos-a-traves-de-bees
- Tandas: https://apps.apple.com/mx/app/tanda-app/id6670189773 · https://financera.mx/finanzas-personales/que-es-una-tanda-de-dinero/
- WhatsApp y cobranza: https://expansion.mx/finanzas-personales/2023/09/18/es-legal-la-cobranza-por-whatsapp
- OkCredit: https://okcredit.in/payment-reminder-app · https://inc42.com/buzz/tiger-global-backed-okcredit-narrows-fy25-loss-by-34-to-inr-23-cr/
- Khatabook: https://yourstory.com/2024/11/ms-dhoni-backed-khatabook-clocks-rs-1027-cr-revenue-cuts-losses-7-in-fy24 ·
  https://themorningcontext.com/internet/khatabook-cant-lend-enough-to-justify-its-valuation
- Cóbrale: https://github.com/ddzendreros/cobrale-mcp
