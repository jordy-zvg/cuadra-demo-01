/**
 * Espejo tipado de migrations/*.sql. Las migraciones SQL son la fuente de verdad
 * (triggers y constraints del ledger no se expresan en Drizzle).
 */
import {
  bigint,
  bigserial,
  boolean,
  customType,
  date,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

const cents = (name: string) => bigint(name, { mode: "bigint" });
const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });
const bytea = customType<{ data: Uint8Array; driverData: Uint8Array }>({ dataType: () => "bytea" });

export const merchants = pgTable("merchants", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  dailyLimitCents: cents("daily_limit_cents").notNull(),
  maxOutflowsPerHour: integer("max_outflows_per_hour").notNull(),
  providerAccountId: text("provider_account_id").unique(),
  peyBankAccountId: text("pey_bank_account_id"),
  createdAt: ts("created_at").notNull().defaultNow(),
});

export const merchantUsers = pgTable("merchant_users", {
  id: text("id").primaryKey(),
  merchantId: text("merchant_id").notNull(),
  phone: text("phone").notNull(),
  phoneVerified: boolean("phone_verified").notNull().default(false),
  role: text("role").$type<"comercio" | "organizadora" | "cliente">().notNull(),
  createdAt: ts("created_at").notNull().defaultNow(),
});

/** Cuentas del portal web: celular + NIP (hash scrypt). */
export const portalAccounts = pgTable("portal_accounts", {
  id: text("id").primaryKey(),
  merchantId: text("merchant_id").notNull(),
  name: text("name").notNull(),
  phone: text("phone").notNull(),
  pinHash: text("pin_hash"),
  /** Identificador de Llave CDMX (en demo: hash de la CURP). */
  llaveSub: text("llave_sub"),
  failedAttempts: integer("failed_attempts").notNull().default(0),
  lockedUntil: ts("locked_until"),
  createdAt: ts("created_at").notNull().defaultNow(),
});

export const portalSessions = pgTable("portal_sessions", {
  tokenHash: text("token_hash").primaryKey(),
  accountId: text("account_id").notNull(),
  expiresAt: ts("expires_at").notNull(),
  createdAt: ts("created_at").notNull().defaultNow(),
});

export const passkeyCredentials = pgTable("passkey_credentials", {
  id: text("id").primaryKey(),
  merchantUserId: text("merchant_user_id").notNull(),
  publicKey: bytea("public_key").notNull(),
  counter: bigint("counter", { mode: "number" }).notNull().default(0),
  transports: text("transports").array().notNull().default([]),
  createdAt: ts("created_at").notNull().defaultNow(),
});

export const riskState = pgTable("risk_state", {
  merchantId: text("merchant_id").primaryKey(),
  killSwitch: boolean("kill_switch").notNull().default(false),
  accountFrozen: boolean("account_frozen").notNull().default(false),
  reconciliationMismatch: boolean("reconciliation_mismatch").notNull().default(false),
  holdsCents: cents("holds_cents").notNull().default(0n),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});

export const systemState = pgTable("system_state", {
  id: boolean("id").primaryKey().default(true),
  killSwitch: boolean("kill_switch").notNull().default(false),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});

export const customers = pgTable("customers", {
  id: text("id").primaryKey(),
  merchantId: text("merchant_id").notNull(),
  name: text("name").notNull(),
  phone: text("phone"),
  optIn: boolean("opt_in").notNull().default(false),
  virtualClabe: text("virtual_clabe"),
  createdAt: ts("created_at").notNull().defaultNow(),
});

export const customerOrderingClabes = pgTable(
  "customer_ordering_clabes",
  {
    merchantId: text("merchant_id").notNull(),
    clabe: text("clabe").notNull(),
    customerId: text("customer_id").notNull(),
  },
  (t) => [primaryKey({ columns: [t.merchantId, t.clabe] })],
);

export const payees = pgTable("payees", {
  id: text("id").primaryKey(),
  merchantId: text("merchant_id").notNull(),
  alias: text("alias").notNull(),
  clabe: text("clabe").notNull(),
  holderName: text("holder_name").notNull(),
  holderValidated: boolean("holder_validated").notNull().default(false),
  whitelisted: boolean("whitelisted").notNull().default(false),
  createdAt: ts("created_at").notNull().defaultNow(),
});

export type ProposalStatus = "pending" | "awaiting_passkey" | "queued" | "executing" | "done" | "rejected";

export const proposals = pgTable("proposals", {
  id: text("id").primaryKey(),
  merchantId: text("merchant_id").notNull(),
  actorId: text("actor_id").notNull(),
  type: text("type").notNull(),
  provenance: text("provenance").$type<"user_direct" | "user_voice" | "third_party_content">().notNull(),
  payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
  proposalHash: text("proposal_hash").notNull(),
  auditorVeto: boolean("auditor_veto").notNull().default(false),
  status: text("status").$type<ProposalStatus>().notNull().default("pending"),
  decision: jsonb("decision"),
  createdAt: ts("created_at").notNull().defaultNow(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});

export const approvals = pgTable("approvals", {
  id: text("id").primaryKey(),
  merchantId: text("merchant_id").notNull(),
  proposalId: text("proposal_id").notNull(),
  proposalHash: text("proposal_hash").notNull(),
  credentialId: text("credential_id").notNull(),
  assertion: jsonb("assertion").$type<Record<string, unknown>>().notNull(),
  priorCounter: bigint("prior_counter", { mode: "number" }).notNull().default(0),
  createdAt: ts("created_at").notNull().defaultNow(),
  expiresAt: ts("expires_at").notNull(),
  usedAt: ts("used_at"),
});

export const mandates = pgTable("mandates", {
  id: text("id").primaryKey(),
  merchantId: text("merchant_id").notNull(),
  payeeId: text("payee_id").notNull(),
  purpose: text("purpose").$type<"proveedor" | "tanda" | "devolucion">().notNull(),
  perOpCapCents: cents("per_op_cap_cents").notNull(),
  periodCapCents: cents("period_cap_cents").notNull(),
  period: text("period").$type<"day" | "week" | "month">().notNull(),
  validFrom: ts("valid_from").notNull(),
  validUntil: ts("valid_until").notNull(),
  revokedAt: ts("revoked_at"),
  proposalId: text("proposal_id").notNull(),
  approvalId: text("approval_id").notNull(),
  createdAt: ts("created_at").notNull().defaultNow(),
});

export const journalEntries = pgTable("journal_entries", {
  id: bigserial("id", { mode: "bigint" }).primaryKey(),
  merchantId: text("merchant_id").notNull(),
  idempotencyKey: text("idempotency_key").notNull().unique(),
  kind: text("kind").notNull(),
  memo: text("memo").notNull(),
  contentHash: text("content_hash").notNull(),
  reverses: text("reverses"),
  createdAt: ts("created_at").notNull().defaultNow(),
});

export const journalLines = pgTable("journal_lines", {
  id: bigserial("id", { mode: "bigint" }).primaryKey(),
  entryId: bigint("entry_id", { mode: "bigint" }).notNull(),
  account: text("account").notNull(),
  subaccount: text("subaccount"),
  debit: cents("debit").notNull(),
  credit: cents("credit").notNull(),
});

export type TransferStatus = "pending" | "sent" | "confirmed" | "failed" | "returned";

export const transfers = pgTable("transfers", {
  id: text("id").primaryKey(),
  merchantId: text("merchant_id").notNull(),
  idempotencyKey: text("idempotency_key").notNull().unique(),
  proposalId: text("proposal_id").notNull().unique(),
  proposalHash: text("proposal_hash").notNull(),
  purpose: text("purpose").$type<"proveedor" | "tanda" | "devolucion">().notNull(),
  payeeId: text("payee_id").notNull(),
  mandateId: text("mandate_id"),
  approvalId: text("approval_id"),
  amountCents: cents("amount_cents").notNull(),
  concept: text("concept").notNull(),
  status: text("status").$type<TransferStatus>().notNull().default("pending"),
  providerRef: text("provider_ref").unique(),
  submittedAt: ts("submitted_at"),
  failureReason: text("failure_reason"),
  createdAt: ts("created_at").notNull().defaultNow(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});

export const deposits = pgTable("deposits", {
  id: bigserial("id", { mode: "bigint" }).primaryKey(),
  merchantId: text("merchant_id").notNull(),
  claveRastreo: text("clave_rastreo").notNull().unique(),
  amountCents: cents("amount_cents").notNull(),
  destinationClabe: text("destination_clabe"),
  orderingClabe: text("ordering_clabe"),
  reference: text("reference"),
  concept: text("concept"),
  customerId: text("customer_id"),
  matchMethod: text("match_method"),
  provider: text("provider"),
  grossCents: cents("gross_cents"),
  tipCents: cents("tip_cents"),
  feeCents: cents("fee_cents"),
  trackingKey: text("tracking_key"),
  chargeId: text("charge_id"),
  receivedAt: ts("received_at").notNull().defaultNow(),
});

export const charges = pgTable("charges", {
  id: text("id").primaryKey(),
  merchantId: text("merchant_id").notNull(),
  customerId: text("customer_id").notNull(),
  reference: text("reference").notNull(),
  uniqueAmountCents: cents("unique_amount_cents"),
  status: text("status").$type<"open" | "paid" | "cancelled" | "expired">().notNull().default("open"),
  amountCents: cents("amount_cents"),
  provider: text("provider"),
  providerChargeId: text("provider_charge_id"),
  paymentUrl: text("payment_url"),
  channel: text("channel").$type<"codi_pn" | "codi_qr" | "payment_link">(),
  expiresAt: ts("expires_at"),
  createdAt: ts("created_at").notNull().defaultNow(),
});

export const webhookEvents = pgTable(
  "webhook_events",
  {
    provider: text("provider").notNull(),
    eventId: text("event_id").notNull(),
    payload: jsonb("payload").notNull(),
    receivedAt: ts("received_at").notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.provider, t.eventId] })],
);

export const reconciliationRuns = pgTable("reconciliation_runs", {
  id: bigserial("id", { mode: "bigint" }).primaryKey(),
  merchantId: text("merchant_id").notNull(),
  runAt: ts("run_at").notNull().defaultNow(),
  localDate: date("local_date").notNull(),
  ledger1100Cents: cents("ledger_1100_cents").notNull(),
  inFlightCents: cents("in_flight_cents").notNull(),
  providerBalanceCents: cents("provider_balance_cents").notNull(),
  ok: boolean("ok").notNull(),
});

export interface MessageAction {
  /** say: sugerencia; al tocarla se envía `text` como si el comercio la hubiera escrito. */
  kind: "confirm" | "cancel" | "pay" | "approve" | "link" | "qr" | "say";
  label: string;
  proposal_id?: string;
  url?: string;
  text?: string;
}

export const messages = pgTable("messages", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  merchantId: text("merchant_id").notNull(),
  channel: text("channel").notNull().default("websim"),
  thread: text("thread").notNull(),
  direction: text("direction").$type<"in" | "out">().notNull(),
  body: text("body").notNull(),
  actions: jsonb("actions").$type<MessageAction[]>(),
  proposalId: text("proposal_id"),
  createdAt: ts("created_at").notNull().defaultNow(),
});

export const guardBlocks = pgTable("guard_blocks", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  merchantId: text("merchant_id").notNull(),
  kind: text("kind").notNull(),
  provenance: text("provenance").notNull(),
  reasons: jsonb("reasons").$type<string[]>().notNull(),
  source: text("source").notNull().default("chat"),
  createdAt: ts("created_at").notNull().defaultNow(),
});

export const tandas = pgTable("tandas", {
  id: text("id").primaryKey(),
  merchantId: text("merchant_id").notNull(),
  name: text("name").notNull(),
  contributionCents: cents("contribution_cents").notNull(),
  period: text("period").$type<"week" | "biweek" | "month">().notNull(),
  membersCount: integer("members_count").notNull(),
  proposalId: text("proposal_id").notNull(),
  approvalId: text("approval_id").notNull(),
  currentRound: integer("current_round").notNull().default(0),
  status: text("status").$type<"active" | "done" | "frozen">().notNull().default("active"),
  createdAt: ts("created_at").notNull().defaultNow(),
});

export const tandaMembers = pgTable(
  "tanda_members",
  {
    tandaId: text("tanda_id").notNull(),
    position: integer("position").notNull(),
    name: text("name").notNull(),
    phone: text("phone").notNull(),
    clabe: text("clabe").notNull(),
    bankAccountId: text("bank_account_id"),
    bankAccountStatus: text("bank_account_status").notNull().default("PENDING"),
  },
  (t) => [primaryKey({ columns: [t.tandaId, t.position] })],
);

export const tandaCharges = pgTable("tanda_charges", {
  id: text("id").primaryKey(),
  tandaId: text("tanda_id").notNull(),
  round: integer("round").notNull(),
  payerPosition: integer("payer_position").notNull(),
  recipientPosition: integer("recipient_position").notNull(),
  amountCents: cents("amount_cents").notNull(),
  provider: text("provider"),
  providerChargeId: text("provider_charge_id"),
  status: text("status").$type<"open" | "paid" | "expired" | "mismatch">().notNull().default("open"),
  transactionId: text("transaction_id").unique(),
  paidCents: cents("paid_cents"),
  createdAt: ts("created_at").notNull().defaultNow(),
  paidAt: ts("paid_at"),
});

export const providerReconciliationRuns = pgTable("provider_reconciliation_runs", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  merchantId: text("merchant_id").notNull(),
  provider: text("provider").notNull(),
  runAt: ts("run_at").notNull().defaultNow(),
  checked: integer("checked").notNull(),
  recovered: integer("recovered").notNull(),
  discrepancies: jsonb("discrepancies").$type<Array<{ kind: string; transaction_id: string; detail: string }>>().notNull(),
  ok: boolean("ok").notNull(),
});
