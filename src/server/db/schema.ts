import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

export const organisations = pgTable("organisations", {
  id: uuid("id").primaryKey(),
  name: text("name").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const outlets = pgTable(
  "outlets",
  {
    id: uuid("id").primaryKey(),
    organisationId: uuid("organisation_id")
      .notNull()
      .references(() => organisations.id, { onDelete: "restrict" }),
    name: text("name").notNull(),
    timezone: text("timezone").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("outlets_organisation_idx").on(table.organisationId)],
);

export const paypalConnections = pgTable(
  "paypal_connections",
  {
    id: uuid("id").primaryKey(),
    outletId: uuid("outlet_id")
      .notNull()
      .references(() => outlets.id, { onDelete: "restrict" }),
    environment: text("environment").notNull(),
    status: text("status").notNull().default("NOT_CONFIGURED"),
    merchantId: text("merchant_id"),
    lastCheckedAt: timestamp("last_checked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("paypal_connections_outlet_unique").on(table.outletId),
    check("paypal_connections_sandbox_only", sql`${table.environment} = 'sandbox'`),
    check(
      "paypal_connections_status_check",
      sql`${table.status} in ('NOT_CONFIGURED', 'CONNECTED', 'ERROR')`,
    ),
  ],
);

export const saleTransactions = pgTable(
  "sale_transactions",
  {
    id: uuid("id").primaryKey(),
    internalReference: text("internal_reference").notNull(),
    outletId: uuid("outlet_id")
      .notNull()
      .references(() => outlets.id, { onDelete: "restrict" }),
    paypalOrderId: text("paypal_order_id"),
    paypalCaptureId: text("paypal_capture_id"),
    paypalCustomId: text("paypal_custom_id"),
    source: text("source").notNull().default("PAYPAL_SANDBOX"),
    currencyCode: text("currency_code").notNull(),
    grossAmountMinor: bigint("gross_amount_minor", { mode: "number" }).notNull(),
    providerStatus: text("provider_status").notNull().default("CREATED"),
    reconciliationState: text("reconciliation_state").notNull().default("NOT_RECONCILED"),
    verificationState: text("verification_state").notNull().default("PENDING"),
    providerCreatedAt: timestamp("provider_created_at", { withTimezone: true }),
    providerUpdatedAt: timestamp("provider_updated_at", { withTimezone: true }),
    reconciledAt: timestamp("reconciled_at", { withTimezone: true }),
    failureCode: text("failure_code"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("sale_transactions_internal_reference_unique").on(table.internalReference),
    uniqueIndex("sale_transactions_paypal_order_unique").on(table.paypalOrderId),
    uniqueIndex("sale_transactions_paypal_capture_unique").on(table.paypalCaptureId),
    index("sale_transactions_outlet_created_idx").on(table.outletId, table.createdAt),
    check("sale_transactions_source_check", sql`${table.source} in ('PAYPAL_SANDBOX', 'DEMO_SEEDED')`),
    check("sale_transactions_paypal_reference_check", sql`${table.source} != 'PAYPAL_SANDBOX' or ${table.paypalCustomId} is not null`),
    check("sale_transactions_demo_provenance_check", sql`${table.source} != 'DEMO_SEEDED' or (
      ${table.paypalOrderId} is null and ${table.paypalCaptureId} is null and
      ${table.paypalCustomId} is null and ${table.providerCreatedAt} is null and
      ${table.providerUpdatedAt} is null and ${table.reconciledAt} is null and
      ${table.verificationState} = 'PENDING' and ${table.reconciliationState} = 'NOT_RECONCILED' and
      ${table.providerStatus} = 'DEMO_SEEDED'
    )`),
    check("sale_transactions_currency_code_check", sql`char_length(${table.currencyCode}) = 3`),
    check("sale_transactions_amount_nonnegative", sql`${table.grossAmountMinor} >= 0`),
    check(
      "sale_transactions_reconciliation_state_check",
      sql`${table.reconciliationState} in ('NOT_RECONCILED', 'PENDING', 'RECONCILED', 'ERROR')`,
    ),
    check(
      "sale_transactions_verification_state_check",
      sql`${table.verificationState} in ('PENDING', 'VERIFIED', 'FAILED')`,
    ),
  ],
);

export const providerEvents = pgTable(
  "provider_events",
  {
    id: uuid("id").primaryKey(),
    providerEventId: text("provider_event_id").notNull(),
    eventType: text("event_type").notNull(),
    payloadSha256: text("payload_sha256").notNull(),
    paypalOrderId: text("paypal_order_id"),
    paypalCaptureId: text("paypal_capture_id"),
    currencyCode: text("currency_code"),
    grossAmountMinor: bigint("gross_amount_minor", { mode: "number" }),
    providerStatus: text("provider_status"),
    verificationStatus: text("verification_status").notNull(),
    processingState: text("processing_state").notNull().default("RECEIVED"),
    saleTransactionId: uuid("sale_transaction_id").references(() => saleTransactions.id, {
      onDelete: "set null",
    }),
    providerCreatedAt: timestamp("provider_created_at", { withTimezone: true }),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
    processedAt: timestamp("processed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("provider_events_provider_event_unique").on(table.providerEventId),
    index("provider_events_capture_idx").on(table.paypalCaptureId),
    check("provider_events_verification_check", sql`${table.verificationStatus} = 'VERIFIED'`),
    check(
      "provider_events_processing_check",
      sql`${table.processingState} in ('RECEIVED', 'PROCESSED', 'IGNORED', 'UNMATCHED', 'ERROR')`,
    ),
  ],
);

export const auditEvents = pgTable(
  "audit_events",
  {
    id: uuid("id").primaryKey(),
    organisationId: uuid("organisation_id").references(() => organisations.id, {
      onDelete: "restrict",
    }),
    outletId: uuid("outlet_id").references(() => outlets.id, { onDelete: "restrict" }),
    action: text("action").notNull(),
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id"),
    correlationId: text("correlation_id").notNull(),
    metadata: jsonb("metadata").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("audit_events_scope_created_idx").on(table.organisationId, table.outletId, table.createdAt),
  ],
);

export const schema = {
  organisations,
  outlets,
  paypalConnections,
  saleTransactions,
  providerEvents,
  auditEvents,
};
