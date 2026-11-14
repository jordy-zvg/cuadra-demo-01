# Activación · Cursor Hackatón México (borrador)

**Nombre del proyecto:** Cuadra

**Descripción (corta):**
Cuadra es el agente de WhatsApp que cobra el fiado de la tiendita. El comercio escribe o dicta “Doña Lupe se
llevó $185”; Cuadra lo anota en un libro contable de partida doble y, con permiso del cliente, le manda una
solicitud de cobro CoDi vía pey directo a la app de su banco. El cliente aprueba sin capturar CLABE ni instalar
nada, el pago se concilia solo contra la deuda correcta y ambos reciben su recibo. Para pagar a proveedores, el
comercio firma con su huella un mandato con topes; fuera de eso, un guard determinista bloquea y explica cada
intento (CLABEs en mensajes reenviados, beneficiarios nuevos, montos fuera de tope). También vigila el tope
mensual de la nueva cuenta Nivel 2 Bis de Banxico. Cuadra nunca custodia dinero.

**Descripción (una línea):**
El agente que cobra el fiado por CoDi, concilia solo y protege cada peso de la tiendita.

**Repositorio:** https://github.com/jordy-zvg/cuadra-demo-01 (debe ser público)

**App en vivo:** https://api-production-3d19d021.up.railway.app

**Stack:** TypeScript, Fastify, Postgres (ledger con invariantes en la base), pey (CoDi: notificación push,
QR y cuenta receptora), WebAuthn (passkeys), Claude (intérprete con consenso de 3 extracciones).

**Integrantes:** [nombres y correos]
