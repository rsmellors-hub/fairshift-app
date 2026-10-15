import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  date,
  index,
  integer,
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

export const workers = pgTable(
  "workers",
  {
    id: uuid("id").primaryKey(),
    organisationId: uuid("organisation_id")
      .notNull()
      .references(() => organisations.id, { onDelete: "restrict" }),
    displayName: text("display_name").notNull(),
    firstName: text("first_name"),
    surname: text("surname"),
    telephone: text("telephone"),
    email: text("email"),
    locationId: uuid("location_id").references(() => outlets.id),
    attributionCode: text("attribution_code").notNull().default(sql`'FS-' || upper(replace(gen_random_uuid()::text, '-', ''))`),
    paypalPayoutEmail: text("paypal_payout_email"),
    workerType: text("worker_type").notNull(),
    status: text("status").notNull().default("ACTIVE"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("workers_attribution_code_unique").on(table.attributionCode),
    index("workers_organisation_idx").on(table.organisationId),
    check("workers_type_check", sql`${table.workerType} in ('REGULAR', 'CASUAL')`),
    check("workers_status_check", sql`${table.status} in ('ACTIVE', 'INACTIVE')`),
  ],
);

export const departments = pgTable("departments", {
  id: uuid("id").primaryKey(),
  outletId: uuid("outlet_id").notNull().references(() => outlets.id),
  name: text("name").notNull(),
}, (t) => [uniqueIndex("departments_location_name_unique").on(t.outletId, t.name)]);

export const workPolicies = pgTable("work_policies", {
  id: uuid("id").primaryKey(),
  outletId: uuid("outlet_id").notNull().references(() => outlets.id),
  name: text("name").notNull(),
  earningsModel: text("earnings_model").notNull(),
  rateMinor: bigint("rate_minor", { mode: "number" }),
  commissionBps: integer("commission_bps"),
  commissionBasis: text("commission_basis"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [check("work_policy_terms_check", sql`(
  ${t.earningsModel} in ('HOURLY', 'DAILY') and ${t.rateMinor} is not null and ${t.rateMinor} >= 0 and ${t.rateMinor} <= 9007199254740991 and ${t.commissionBps} is null and ${t.commissionBasis} is null
) or (
  ${t.earningsModel} = 'COMMISSION' and ${t.rateMinor} is null and ${t.commissionBps} is not null and ${t.commissionBasis} is not null and ${t.commissionBps} between 0 and 10000 and ${t.commissionBasis} = 'VERIFIED_ATTRIBUTED_SALES'
)`)]);

export const teamInvitations = pgTable("team_invitations", {
  id: uuid("id").primaryKey(),
  workerId: uuid("worker_id").notNull().references(() => workers.id),
  state: text("state").notNull().default("CREATED_NOT_SENT"),
  token: text("token").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [uniqueIndex("team_invitation_token_unique").on(t.token),
  check("team_invitation_state_check", sql`${t.state} = 'CREATED_NOT_SENT'`)]);

export const shifts = pgTable(
  "shifts",
  {
    id: uuid("id").primaryKey(),
    outletId: uuid("outlet_id")
      .notNull()
      .references(() => outlets.id, { onDelete: "restrict" }),
    departmentId: uuid("department_id").references(() => departments.id),
    requiredHeadcount: integer("required_headcount").notNull().default(1),
    termsVersion: integer("terms_version").notNull().default(1),
    policyId: uuid("policy_id").references(() => workPolicies.id),
    earningsModel: text("earnings_model").notNull().default("DAILY"),
    rateMinor: bigint("rate_minor", { mode: "number" }),
    commissionBps: integer("commission_bps"),
    commissionBasis: text("commission_basis"),
    expectedEarningsMinor: bigint("expected_earnings_minor", { mode: "number" }),
    shiftDate: date("shift_date", { mode: "string" }).notNull(),
    startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
    endsAt: timestamp("ends_at", { withTimezone: true }).notNull(),
    roleName: text("role_name").notNull(),
    status: text("status").notNull().default("DRAFT"),
    currencyCode: text("currency_code").notNull(),
    guaranteedBasePayMinor: bigint("guaranteed_base_pay_minor", { mode: "number" }).notNull(),
    gratuityPolicy: text("gratuity_policy").notNull(),
    incentivePolicy: text("incentive_policy").notNull(),
    incentiveTargetMinor: bigint("incentive_target_minor", { mode: "number" }).notNull().default(0),
    incentiveAmountMinor: bigint("incentive_amount_minor", { mode: "number" }).notNull().default(0),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check("shifts_headcount_check", sql`${table.requiredHeadcount} > 0 and ${table.termsVersion} > 0`),
    index("shifts_outlet_date_idx").on(table.outletId, table.shiftDate),
    check("shifts_status_check", sql`${table.status} in ('DRAFT', 'PUBLISHED', 'CANCELLED', 'COMPLETED')`),
    check("shifts_currency_code_check", sql`char_length(${table.currencyCode}) = 3`),
    check("shifts_base_pay_nonnegative", sql`${table.guaranteedBasePayMinor} >= 0`),
    check("shifts_incentive_target_nonnegative", sql`${table.incentiveTargetMinor} >= 0`),
    check("shifts_incentive_amount_nonnegative", sql`${table.incentiveAmountMinor} >= 0`),
    check("shifts_time_order_check", sql`${table.endsAt} > ${table.startsAt}`),
  ],
);

export const shiftOffers = pgTable(
  "shift_offers",
  {
    id: uuid("id").primaryKey(),
    shiftId: uuid("shift_id")
      .notNull()
      .references(() => shifts.id, { onDelete: "restrict" }),
    workerId: uuid("worker_id")
      .notNull()
      .references(() => workers.id, { onDelete: "restrict" }),
    status: text("status").notNull().default("OFFERED"),
    offeredAt: timestamp("offered_at", { withTimezone: true }).notNull().defaultNow(),
    respondedAt: timestamp("responded_at", { withTimezone: true }),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("shift_offers_shift_worker_unique").on(table.shiftId, table.workerId),
    index("shift_offers_worker_status_idx").on(table.workerId, table.status),
    check("shift_offers_status_check", sql`${table.status} in ('OFFERED', 'ACCEPTED', 'DECLINED', 'CANCELLED')`),
    check(
      "shift_offers_acceptance_check",
      sql`(${table.status} = 'ACCEPTED' and ${table.acceptedAt} is not null and ${table.respondedAt} is not null)
          or (${table.status} != 'ACCEPTED' and ${table.acceptedAt} is null)`,
    ),
  ],
);

export const workAcceptances = pgTable("work_acceptances", {
  id: uuid("id").primaryKey(),
  offerId: uuid("offer_id").notNull().references(() => shiftOffers.id),
  workerId: uuid("worker_id").notNull().references(() => workers.id),
  termsVersion: integer("terms_version").notNull(),
  snapshot: jsonb("snapshot").notNull(),
  acceptedAt: timestamp("accepted_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [uniqueIndex("work_acceptances_offer_version_unique").on(t.offerId, t.termsVersion)]);

export const workAllocations = pgTable("work_allocations", {
  confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
  id: uuid("id").primaryKey(),
  offerId: uuid("offer_id").notNull().references(() => shiftOffers.id),
  acceptanceId: uuid("acceptance_id").notNull().references(() => workAcceptances.id),
  state: text("state").notNull().default("ALLOCATED"),
}, (t) => [uniqueIndex("work_allocations_offer_unique").on(t.offerId),
  check("work_allocation_state_check", sql`${t.state} in ('ALLOCATED', 'REACCEPTANCE_REQUIRED')`)]);

// A separate boundary from location sales. No ingestion or demo attribution is supplied.
export const attributedSales = pgTable("attributed_sales", {
  id: uuid("id").primaryKey(),
  provider: text("provider").notNull(),
  providerTransactionId: text("provider_transaction_id").notNull(),
  attributionCode: text("attribution_code").notNull(),
  workerId: uuid("worker_id").references(() => workers.id),
  outletId: uuid("outlet_id").notNull().references(() => outlets.id),
  amountMinor: bigint("amount_minor", { mode: "number" }).notNull(),
  currencyCode: text("currency_code").notNull(),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
  source: text("source").notNull(),
  verificationState: text("verification_state").notNull().default("UNVERIFIED"),
}, (t) => [uniqueIndex("attributed_sales_provider_transaction_unique").on(t.provider, t.providerTransactionId),
  check("attributed_sales_verification_check", sql`${t.verificationState} in ('UNVERIFIED', 'VERIFIED', 'FAILED')`),
  check("attributed_sales_amount_check", sql`${t.amountMinor} >= 0 and ${t.amountMinor} <= 9007199254740991`)]);

export const shiftIncentives = pgTable(
  "shift_incentives",
  {
    id: uuid("id").primaryKey(),
    shiftId: uuid("shift_id").notNull().references(() => shifts.id, { onDelete: "restrict" }),
    workerId: uuid("worker_id").notNull().references(() => workers.id, { onDelete: "restrict" }),
    performanceSalesMinor: bigint("performance_sales_minor", { mode: "number" }).notNull(),
    targetSalesMinor: bigint("target_sales_minor", { mode: "number" }).notNull(),
    earnedAmountMinor: bigint("earned_amount_minor", { mode: "number" }).notNull(),
    status: text("status").notNull(),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    approvedBy: text("approved_by"),
    payoutRecipient: text("payout_recipient"),
    paypalSenderBatchId: text("paypal_sender_batch_id").notNull(),
    paypalSenderItemId: text("paypal_sender_item_id").notNull(),
    paypalBatchId: text("paypal_batch_id"),
    paypalItemId: text("paypal_item_id"),
    paypalStatus: text("paypal_status"),
    failureCode: text("failure_code"),
    submittedAt: timestamp("submitted_at", { withTimezone: true }),
    paidAt: timestamp("paid_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("shift_incentives_shift_worker_unique").on(table.shiftId, table.workerId),
    uniqueIndex("shift_incentives_sender_batch_unique").on(table.paypalSenderBatchId),
    uniqueIndex("shift_incentives_sender_item_unique").on(table.paypalSenderItemId),
    uniqueIndex("shift_incentives_paypal_batch_unique").on(table.paypalBatchId),
    index("shift_incentives_worker_status_idx").on(table.workerId, table.status),
    check("shift_incentives_amounts_nonnegative", sql`${table.performanceSalesMinor} >= 0 and ${table.targetSalesMinor} >= 0 and ${table.earnedAmountMinor} >= 0`),
    check("shift_incentives_status_check", sql`${table.status} in ('NOT_EARNED', 'EARNED', 'APPROVED', 'SUBMITTING', 'SUBMITTED', 'PROCESSING', 'PAID', 'FAILED')`),
    check("shift_incentives_approval_check", sql`(${table.status} in ('APPROVED', 'SUBMITTING', 'SUBMITTED', 'PROCESSING', 'PAID', 'FAILED') and ${table.approvedAt} is not null and ${table.approvedBy} is not null) or (${table.status} in ('NOT_EARNED', 'EARNED') and ${table.approvedAt} is null and ${table.approvedBy} is null)`),
    check("shift_incentives_payout_eligibility_check", sql`${table.status} not in ('SUBMITTING', 'SUBMITTED', 'PROCESSING', 'PAID') or (${table.earnedAmountMinor} > 0 and ${table.payoutRecipient} is not null and ${table.approvedAt} is not null)`),
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
  workers,
  departments, workPolicies, teamInvitations, workAcceptances, workAllocations, attributedSales,
  shifts,
  shiftOffers,
  shiftIncentives,
  auditEvents,
};
