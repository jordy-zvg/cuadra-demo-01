import { createHash } from "node:crypto";
import { z } from "zod";
import { isValidClabe } from "./clabe.js";

export const Provenance = z.enum(["user_direct", "user_voice", "third_party_content"]);
export type Provenance = z.infer<typeof Provenance>;

/**
 * Centavos: entero positivo. Acepta bigint, number entero seguro o cadena de dígitos
 * (el JSON del LLM no tiene bigint). Los floats se rechazan.
 */
export const CentavosSchema = z
  .union([
    z.bigint(),
    z.number().int().safe(),
    z.string().regex(/^\d{1,15}$/),
  ])
  .transform((v) => BigInt(v))
  .refine((v) => v > 0n, { message: "El monto debe ser mayor a cero" });

const id = z.string().min(1).max(64);
const text = z.string().min(1).max(140);

const base = { merchant_id: id, provenance: Provenance };

export const OutflowPurpose = z.enum(["proveedor", "tanda", "devolucion"]);
export type OutflowPurpose = z.infer<typeof OutflowPurpose>;

/** charge_now: cobro por servicio; al confirmar se anota y se manda la solicitud CoDi enseguida. */
export const AddCredit = z.object({ ...base, type: z.literal("AddCredit"), customer_id: id, amount_cents: CentavosSchema, concept: text, charge_now: z.literal(true).optional() });
export const RegisterCashPayment = z.object({ ...base, type: z.literal("RegisterCashPayment"), customer_id: id, amount_cents: CentavosSchema });
export const SendReminder = z.object({ ...base, type: z.literal("SendReminder"), customer_id: id });
/**
 * Alta de cliente. El celular es opcional (sin él solo se le cobra con QR en mostrador). Si el alta
 * viene de un fiado a un nombre desconocido, credit_cents lleva ese fiado y se anota al confirmar.
 */
export const CreateCustomer = z.object({
  ...base,
  type: z.literal("CreateCustomer"),
  name: text,
  phone: z.string().regex(/^\+?\d{10,15}$/).optional(),
  credit_cents: CentavosSchema.optional(),
  credit_concept: text.optional(),
});
/** La CLABE no viaja en la propuesta: se captura por código y se guarda como borrador en DB. */
export const CreatePayee = z.object({ ...base, type: z.literal("CreatePayee"), payee_draft_id: id, alias: text });
export const PayoutRequest = z.object({ ...base, type: z.literal("PayoutRequest"), payee_id: id, amount_cents: CentavosSchema, concept: text });
export const CreateMandate = z.object({
  ...base,
  type: z.literal("CreateMandate"),
  payee_id: id,
  purpose: OutflowPurpose,
  per_op_cap_cents: CentavosSchema,
  period_cap_cents: CentavosSchema,
  period: z.enum(["day", "week", "month"]),
  valid_days: z.number().int().min(1).max(365),
});
export const RevokeMandate = z.object({ ...base, type: z.literal("RevokeMandate"), mandate_id: id });
/**
 * Integrante de tanda: la organizadora captura su CLABE en la página de alta (no el LLM) y la
 * firma con passkey junto con el orden de turnos. A esa CLABE llegan las aportaciones de su turno.
 */
export const TandaMember = z.object({
  name: text,
  phone: z.string().regex(/^\d{10}$/, "Celular de 10 dígitos"),
  clabe: z.string().refine(isValidClabe, "CLABE con dígito verificador inválido"),
});
export const CreateTandaObject = z.object({
  ...base,
  type: z.literal("CreateTanda"),
  name: text,
  contribution_cents: CentavosSchema,
  period: z.enum(["week", "biweek", "month"]),
  /** En orden de turno: el integrante i recibe en la ronda i. */
  members: z.array(TandaMember).min(2).max(20),
});
/** Validación completa al crear (sin celulares ni CLABEs repetidos). */
export const CreateTanda = CreateTandaObject
  .refine((t) => new Set(t.members.map((m) => m.phone)).size === t.members.length, "Celulares repetidos")
  .refine((t) => new Set(t.members.map((m) => m.clabe)).size === t.members.length, "CLABEs repetidas");
export const TandaContribution = z.object({ ...base, type: z.literal("TandaContribution"), tanda_id: id, customer_id: id, amount_cents: CentavosSchema });
export const TandaPayout = z.object({ ...base, type: z.literal("TandaPayout"), tanda_id: id, payee_id: id, amount_cents: CentavosSchema, concept: text });
export const RefundCredit = z.object({ ...base, type: z.literal("RefundCredit"), customer_id: id, payee_id: id, amount_cents: CentavosSchema, concept: text });
export const Query = z.object({
  ...base,
  type: z.literal("Query"),
  topic: z.enum(["saldo_cliente", "saldos", "movimientos", "tanda", "cuenta"]),
  subject_id: id.optional(),
});

export const Proposal = z.discriminatedUnion("type", [
  AddCredit,
  RegisterCashPayment,
  SendReminder,
  CreateCustomer,
  CreatePayee,
  PayoutRequest,
  CreateMandate,
  RevokeMandate,
  CreateTandaObject,
  TandaContribution,
  TandaPayout,
  RefundCredit,
  Query,
]);
export type Proposal = z.infer<typeof Proposal>;

/** Propuestas que mueven dinero hacia afuera: pasan por el guard de salidas. */
export const OutflowProposal = z.discriminatedUnion("type", [PayoutRequest, TandaPayout, RefundCredit]);
export type OutflowProposal = z.infer<typeof OutflowProposal>;

const PURPOSE_BY_TYPE: Record<OutflowProposal["type"], OutflowPurpose> = {
  PayoutRequest: "proveedor",
  TandaPayout: "tanda",
  RefundCredit: "devolucion",
};

export function outflowPurpose(p: OutflowProposal): OutflowPurpose {
  return PURPOSE_BY_TYPE[p.type];
}

/** JSON canónico: llaves ordenadas, bigint como cadena. */
export function canonicalJson(value: unknown): string {
  if (typeof value === "bigint") return JSON.stringify(value.toString());
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/** Hash exacto de la propuesta: a esto se liga la aprobación con passkey. */
export function proposalHash(proposal: Proposal): string {
  return createHash("sha256").update(canonicalJson(proposal)).digest("hex");
}
