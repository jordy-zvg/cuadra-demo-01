/**
 * Plantillas de WhatsApp de Cuadra (categoría UTILITY, español de México). Son la única forma de
 * escribirle a un cliente, a un integrante de tanda o al comercio cuando la ventana de 24 h está
 * cerrada. Se dan de alta en Meta con `pnpm --filter @cuadra/api templates:create` y Meta las revisa.
 *
 * Reglas que cumplen todas: sin variable al inicio ni al final, variables con texto entre ellas,
 * sin emojis ni enlaces, y el texto dice para qué es el mensaje (utilidad, no publicidad).
 */
export const TEMPLATE_LANGUAGE = "es_MX";

export const TEMPLATES = {
  cuadra_cobro_fiado: {
    body:
      "Hola {{1}}, te saludamos de {{2}}. Tu cuenta va en {{3}} (referencia {{4}}). " +
      "Si te llega una solicitud de cobro CoDi, ábrela en la app de tu banco y apruébala, sin capturar CLABE. " +
      "Si hoy no se puede, respóndenos cuándo te queda bien.",
    example: ["Doña Lupe", "Abarrotes La Esquina", "$185.00", "4815162"],
  },
  cuadra_recibo_fiado: {
    body: "Recibo de {{1}}: pagaste {{2}}. {{3}} Gracias por tu pago.",
    example: ["Abarrotes La Esquina", "$185.00", "Quedas al corriente."],
  },
  cuadra_tanda_aportacion: {
    body:
      "Hola {{1}}, ronda {{2}} de la tanda {{3}}: le toca a {{4}}. Te llegó una solicitud CoDi de {{5}} a tu celular; " +
      "al aprobarla, el dinero va directo a su cuenta.",
    example: ["Rosa", "3", "Tanda del mercado", "Juan", "$500.00"],
  },
  cuadra_tanda_turno: {
    body: "Hola {{1}}, esta ronda de la tanda {{2}} te toca a ti: {{3}} llegarán directo a tu cuenta {{4}} conforme paguen los demás.",
    example: ["Juan", "Tanda del mercado", "$4,500.00", "****5713"],
  },
  cuadra_tanda_recibo: {
    body: "Recibo: aportaste {{1}} a la ronda {{2}} de la tanda {{3}}, directo a {{4}}. Gracias.",
    example: ["$500.00", "3", "Tanda del mercado", "Juan"],
  },
  cuadra_tanda_aviso: {
    body: "Aviso de la tanda {{1}}: {{2}} Gracias por participar.",
    example: ["Tanda del mercado", "La ronda 3 se completó y Juan ya recibió su pozo."],
  },
  cuadra_aviso_comercio: {
    body: "Tienes un aviso de Cuadra: {{1}} Responde a este mensaje para seguir.",
    example: ["Doña Lupe pagó $185.00 por CoDi y quedó en ceros."],
  },
} as const satisfies Record<string, { body: string; example: readonly string[] }>;

export type TemplateName = keyof typeof TEMPLATES;

/** Plantilla a usar si el mensaje sale fuera de la ventana de 24 h. */
export interface TemplateRef {
  name: TemplateName;
  params: string[];
}

/** Cuántas variables tiene una plantilla ({{1}}..{{n}}). */
export function templateArity(name: TemplateName): number {
  return new Set(TEMPLATES[name].body.match(/\{\{\d+\}\}/g) ?? []).size;
}

/**
 * Plantilla de autenticación (categoría AUTHENTICATION) para el código que verifica el celular.
 * Meta fija el texto («*{{1}}* es tu código de verificación.», la recomendación de no compartirlo y
 * el aviso de vencimiento); aquí solo van el nombre, el idioma, los minutos y el botón. Los minutos
 * deben coincidir con la vigencia del código en el servidor (PHONE_CODE_TTL_MS en auth.ts).
 * https://developers.facebook.com/documentation/business-messaging/whatsapp/templates/authentication-templates/copy-code-button-authentication-templates
 */
export const AUTH_TEMPLATE = { name: "cuadra_codigo", codeExpirationMinutes: 10, buttonText: "Copiar código" } as const;

/** Cuerpo para POST /{WABA_ID}/message_templates de la plantilla de autenticación. */
export function authTemplateCreateBody() {
  return {
    name: AUTH_TEMPLATE.name,
    language: TEMPLATE_LANGUAGE,
    category: "AUTHENTICATION",
    components: [
      { type: "body", add_security_recommendation: true },
      { type: "footer", code_expiration_minutes: AUTH_TEMPLATE.codeExpirationMinutes },
      { type: "buttons", buttons: [{ type: "otp", otp_type: "copy_code", text: AUTH_TEMPLATE.buttonText }] },
    ],
  };
}

/** Cuerpo para POST /{WABA_ID}/message_templates. */
export function templateCreateBody(name: TemplateName) {
  const t = TEMPLATES[name];
  return {
    name,
    language: TEMPLATE_LANGUAGE,
    category: "UTILITY",
    parameter_format: "positional",
    components: [{ type: "body", text: t.body, example: { body_text: [[...t.example]] } }],
  };
}
