/**
 * Da de alta en Meta las plantillas de Cuadra (POST /{WABA_ID}/message_templates).
 * Uso: pnpm --filter @cuadra/api templates:create
 * Requiere WHATSAPP_TOKEN y WHATSAPP_WABA_ID. Meta revisa cada una (minutos a horas); el estado se ve
 * en el Administrador de WhatsApp. Si una ya existe, Meta responde error y se informa sin detener el resto.
 */
import { fileURLToPath } from "node:url";
import { WHATSAPP_GRAPH_URL, WHATSAPP_GRAPH_VERSION } from "@cuadra/adapters";
import { AUTH_TEMPLATE, TEMPLATES, type TemplateName, authTemplateCreateBody, templateCreateBody } from "./whatsapp-templates.js";

// Lee el .env de la raíz del repo si existe (en local); en Railway las variables ya vienen del entorno.
try {
  process.loadEnvFile(fileURLToPath(new URL("../../../.env", import.meta.url)));
} catch {
  // sin .env: se usan las variables del entorno
}

const token = process.env.WHATSAPP_TOKEN;
const waba = process.env.WHATSAPP_WABA_ID;
if (!token || !waba) {
  process.stderr.write("Faltan WHATSAPP_TOKEN y WHATSAPP_WABA_ID en el entorno.\n");
  process.exit(1);
}
const version = process.env.WHATSAPP_GRAPH_VERSION || WHATSAPP_GRAPH_VERSION;

// Las de utilidad y, al final, la de autenticación (código para verificar el celular).
const bodies: Array<[string, unknown]> = [
  ...(Object.keys(TEMPLATES) as TemplateName[]).map((n): [string, unknown] => [n, templateCreateBody(n)]),
  [AUTH_TEMPLATE.name, authTemplateCreateBody()],
];
for (const [name, body] of bodies) {
  const res = await fetch(`${WHATSAPP_GRAPH_URL}/${version}/${encodeURIComponent(waba)}/message_templates`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = (await res.json().catch(() => null)) as { id?: string; status?: string; error?: { message?: string } } | null;
  process.stdout.write(
    res.ok ? `OK     ${name}: ${json?.status ?? "enviada"} (${json?.id ?? "sin id"})\n` : `ERROR  ${name}: ${json?.error?.message ?? res.status}\n`,
  );
}
