import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  date,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";

export const users = pgTable("auth_users", {
  id: uuid("id").primaryKey(), email: text("email").notNull(), name: text("name").notNull(),
  title: text("title"), firstName: text("first_name"), surname: text("surname"),
  position: text("position"), telephone: text("telephone"),
  passwordHash: text("password_hash").notNull(), emailVerifiedAt: timestamp("email_verified_at", {withTimezone:true}),
  createdAt: timestamp("created_at", {withTimezone:true}).notNull().defaultNow(),
}, t => [uniqueIndex("auth_users_email_unique").on(t.email), check("auth_users_email_normalized", sql`${t.email} = lower(trim(${t.email}))`), check("auth_users_title_check", sql`${t.title} in ('Mr','Mrs','Ms','Dr','Other')`)]);
export const sessions = pgTable("auth_sessions", {
  id: uuid("id").primaryKey(), userId: uuid("user_id").notNull().references(() => users.id),
  tokenHash: text("token_hash").notNull(), expiresAt: timestamp("expires_at", {withTimezone:true}).notNull(),
  membershipId: uuid("membership_id"), createdAt: timestamp("created_at", {withTimezone:true}).notNull().defaultNow(),
  // Set only by public demo entry. A session with a persona stays a demo session for its whole life.
  demoPersona: text("demo_persona"), demoGroup: uuid("demo_group"),
}, t => [uniqueIndex("auth_sessions_token_unique").on(t.tokenHash), index("auth_sessions_user_idx").on(t.userId),
  check("auth_sessions_demo_persona_check", sql`${t.demoPersona} is null or ${t.demoPersona} in ('OWNER','MANAGER','WORKER')`),
  check("auth_sessions_demo_group_check", sql`(${t.demoPersona} is null) = (${t.demoGroup} is null)`)]);
export const identityTokens = pgTable("identity_tokens", {
  id: uuid("id").primaryKey(), userId: uuid("user_id").notNull().references(() => users.id), tokenHash: text("token_hash").notNull(),
  purpose: text("purpose").notNull(), expiresAt: timestamp("expires_at", {withTimezone:true}).notNull(), usedAt: timestamp("used_at", {withTimezone:true}),
}, t => [uniqueIndex("identity_tokens_hash_unique").on(t.tokenHash), check("identity_token_purpose", sql`${t.purpose} in ('VERIFY_EMAIL','RESET_PASSWORD')`)]);
export const authLimits = pgTable("auth_limits", {
  key: text("key").primaryKey(), count: integer("count").notNull(), resetsAt: timestamp("resets_at", {withTimezone:true}).notNull(),
});

export const organisations = pgTable("organisations", {
  id: uuid("id").primaryKey(),
  name: text("name").notNull(),
  setupCompletedAt: timestamp("setup_completed_at", {withTimezone:true}),
  businessAddress: text("business_address"), city: text("city"), province: text("province"),
  postalCode: text("postal_code"), country: text("country"),
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
    address: text("address"), city: text("city"), province: text("province"),
    postalCode: text("postal_code"), country: text("country"),
    // Context for reasoning about local signals, never a coefficient. Null means unknown. The
    // source says whether an Owner stated these or they are reference-company configuration.
    venueProfile: text("venue_profile"), latitude: doublePrecision("latitude"), longitude: doublePrecision("longitude"),
    venueContextSource: text("venue_context_source"),
    // The Owner's own words about the location (area, venue type, typical customers), the only
    // description local intelligence gives the model. DEMO_SEED marks the fictional demo's profiles.
    locationProfile: jsonb("location_profile"), locationProfileSource: text("location_profile_source"),
    active: boolean("active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("outlets_organisation_idx").on(table.organisationId),
    check("outlets_venue_profile_check", sql`${table.venueProfile} is null or ${table.venueProfile} in ('STADIUM_DISTRICT', 'WATERFRONT_OUTDOOR', 'BUSINESS_DISTRICT', 'STATION_COMMUTER', 'SHOPPING_CENTRE')`),
    check("outlets_coordinates_check", sql`(${table.latitude} is null and ${table.longitude} is null) or (${table.latitude} between -90 and 90 and ${table.longitude} between -180 and 180)`),
    check("outlets_venue_context_source_check", sql`${table.venueContextSource} is null or ${table.venueContextSource} in ('REFERENCE', 'CONFIGURED')`),
    check("outlets_location_profile_check", sql`(${table.locationProfile} is null and ${table.locationProfileSource} is null) or (${table.locationProfile} is not null and ${table.locationProfileSource} in ('OWNER', 'DEMO_SEED'))`),
  ],
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
    // Commercial sale time. Required for REFERENCE history, whose rows are loaded
    // long after the sales they describe; other sources fall back to provider/created time.
    occurredAt: timestamp("occurred_at", { withTimezone: true }),
    // Identity in the system the observation came from, for canonically ingested rows.
    sourceSystem: text("source_system"),
    sourceTransactionId: text("source_transaction_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("sale_transactions_internal_reference_unique").on(table.internalReference),
    uniqueIndex("sale_transactions_source_identity_unique").on(table.outletId, table.source, table.sourceSystem, table.sourceTransactionId).where(sql`${table.sourceTransactionId} is not null`),
    uniqueIndex("sale_transactions_paypal_order_unique").on(table.paypalOrderId),
    uniqueIndex("sale_transactions_paypal_capture_unique").on(table.paypalCaptureId),
    index("sale_transactions_outlet_created_idx").on(table.outletId, table.createdAt),
    index("sale_transactions_outlet_occurred_idx").on(table.outletId, table.occurredAt),
    check("sale_transactions_source_check", sql`${table.source} in ('PAYPAL_SANDBOX', 'DEMO_SEEDED', 'REFERENCE', 'IMPORTED', 'ZETTLE', 'SQUARE')`),
    check("sale_transactions_paypal_reference_check", sql`${table.source} != 'PAYPAL_SANDBOX' or ${table.paypalCustomId} is not null`),
    check("sale_transactions_demo_provenance_check", sql`${table.source} != 'DEMO_SEEDED' or (
      ${table.paypalOrderId} is null and ${table.paypalCaptureId} is null and
      ${table.paypalCustomId} is null and ${table.providerCreatedAt} is null and
      ${table.providerUpdatedAt} is null and ${table.reconciledAt} is null and
      ${table.verificationState} = 'PENDING' and ${table.reconciliationState} = 'NOT_RECONCILED' and
      ${table.providerStatus} = 'DEMO_SEEDED'
    )`),
    // Labelled synthetic reference history: never provider-backed, verified or reconciled.
    check("sale_transactions_reference_provenance_check", sql`${table.source} != 'REFERENCE' or (
      ${table.paypalOrderId} is null and ${table.paypalCaptureId} is null and
      ${table.paypalCustomId} is null and ${table.providerCreatedAt} is null and
      ${table.providerUpdatedAt} is null and ${table.reconciledAt} is null and
      ${table.verificationState} = 'PENDING' and ${table.reconciliationState} = 'NOT_RECONCILED' and
      ${table.providerStatus} = 'REFERENCE' and ${table.occurredAt} is not null
    )`),
    // Genuine imported history: a commercial time and source identity, no provider
    // identifiers and no verification claim.
    check("sale_transactions_imported_provenance_check", sql`${table.source} != 'IMPORTED' or (
      ${table.paypalOrderId} is null and ${table.paypalCaptureId} is null and
      ${table.paypalCustomId} is null and ${table.providerCreatedAt} is null and
      ${table.providerUpdatedAt} is null and ${table.reconciledAt} is null and
      ${table.verificationState} = 'PENDING' and ${table.reconciliationState} = 'NOT_RECONCILED' and
      ${table.providerStatus} = 'IMPORTED' and ${table.occurredAt} is not null and
      ${table.sourceSystem} is not null and ${table.sourceTransactionId} is not null
    )`),
    // Retrieved from a connected Zettle merchant account: a commercial time and the
    // provider's purchase identity, no PayPal identifiers and no reconciliation claim.
    check("sale_transactions_zettle_provenance_check", sql`${table.source} != 'ZETTLE' or (
      ${table.paypalOrderId} is null and ${table.paypalCaptureId} is null and
      ${table.paypalCustomId} is null and ${table.providerCreatedAt} is null and
      ${table.providerUpdatedAt} is null and ${table.reconciledAt} is null and
      ${table.verificationState} = 'PENDING' and ${table.reconciliationState} = 'NOT_RECONCILED' and
      ${table.providerStatus} = 'ZETTLE' and ${table.occurredAt} is not null and
      ${table.sourceSystem} is not null and ${table.sourceTransactionId} is not null
    )`),
    check("sale_transactions_square_provenance_check", sql`${table.source} != 'SQUARE' or (
      ${table.paypalOrderId} is null and ${table.paypalCaptureId} is null and
      ${table.paypalCustomId} is null and ${table.providerCreatedAt} is null and
      ${table.providerUpdatedAt} is null and ${table.reconciledAt} is null and
      ${table.verificationState} = 'PENDING' and ${table.reconciliationState} = 'NOT_RECONCILED' and
      ${table.providerStatus} = 'SQUARE' and ${table.occurredAt} is not null and
      ${table.sourceSystem} is not null and ${table.sourceTransactionId} is not null
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

// One merchant account connected to one location. Credentials are sealed at rest and
// never selected for display; disconnecting erases them and keeps the retrieved history.
export const commerceConnections = pgTable("commerce_connections", {
  id: uuid("id").primaryKey(),
  organisationId: uuid("organisation_id").notNull().references(() => organisations.id, { onDelete: "restrict" }),
  outletId: uuid("outlet_id").notNull().references(() => outlets.id, { onDelete: "restrict" }),
  provider: text("provider").notNull(),
  status: text("status").notNull(),
  providerMerchantId: text("provider_merchant_id").notNull(),
  // The provider's own location and environment, where the provider has them. A Square
  // connection binds exactly one Square location to this FairShift location.
  providerLocationId: text("provider_location_id"),
  providerEnvironment: text("provider_environment"),
  sealedCredentials: text("sealed_credentials"),
  connectedBy: uuid("connected_by").references(() => users.id),
  connectedAt: timestamp("connected_at", { withTimezone: true }).notNull(),
  disconnectedAt: timestamp("disconnected_at", { withTimezone: true }),
}, (t) => [
  // A location has one live connection, and a merchant account feeds one location.
  uniqueIndex("commerce_connections_live_outlet_unique").on(t.outletId).where(sql`${t.status} != 'DISCONNECTED'`),
  uniqueIndex("commerce_connections_live_merchant_unique").on(t.provider, t.providerMerchantId).where(sql`${t.status} != 'DISCONNECTED'`),
  check("commerce_connections_provider_check", sql`${t.provider} in ('ZETTLE', 'SQUARE')`),
  check("commerce_connections_square_binding_check", sql`${t.provider} != 'SQUARE' or (${t.providerLocationId} is not null and ${t.providerEnvironment} = 'SANDBOX')`),
  check("commerce_connections_status_check", sql`${t.status} in ('CONNECTED', 'AUTH_FAILED', 'DISCONNECTED')`),
  check("commerce_connections_credentials_check", sql`(${t.status} = 'DISCONNECTED') = (${t.sealedCredentials} is null)`),
]);

// Each retrieval attempt. A failed run changes no history and is never read as zero sales.
export const commerceSyncRuns = pgTable("commerce_sync_runs", {
  id: uuid("id").primaryKey(),
  connectionId: uuid("connection_id").notNull().references(() => commerceConnections.id, { onDelete: "restrict" }),
  status: text("status").notNull(),
  windowStart: timestamp("window_start", { withTimezone: true }).notNull(),
  retrieved: integer("retrieved"),
  inserted: integer("inserted"),
  duplicates: integer("duplicates"),
  refundsExcluded: integer("refunds_excluded"),
  failureCode: text("failure_code"),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
}, (t) => [
  uniqueIndex("commerce_sync_runs_one_running_unique").on(t.connectionId).where(sql`${t.status} = 'RUNNING'`),
  index("commerce_sync_runs_connection_started_idx").on(t.connectionId, t.startedAt),
  check("commerce_sync_runs_status_check", sql`${t.status} in ('RUNNING', 'SUCCEEDED', 'FAILED')`),
  check("commerce_sync_runs_outcome_check", sql`(${t.status} = 'FAILED') = (${t.failureCode} is not null)`),
]);

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
    userId: uuid("user_id").references(() => users.id),
    firstName: text("first_name"),
    surname: text("surname"),
    telephone: text("telephone"),
    email: text("email"),
    locationId: uuid("location_id").references(() => outlets.id),
    attributionCode: text("attribution_code").notNull().default(sql`'FS-' || upper(replace(gen_random_uuid()::text, '-', ''))`),
    paypalPayoutEmail: text("paypal_payout_email"),
    // FS-OFFER-ORDER-DEC-001: a preference the worker sets; no reason is collected.
    wantsMoreHours: boolean("wants_more_hours").notNull().default(false),
    workerType: text("worker_type").notNull(),
    status: text("status").notNull().default("ACTIVE"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("workers_org_user_unique").on(table.organisationId, table.userId),
    uniqueIndex("workers_attribution_code_unique").on(table.attributionCode),
    index("workers_organisation_idx").on(table.organisationId),
    check("workers_type_check", sql`${table.workerType} in ('REGULAR', 'CASUAL')`),
    check("workers_status_check", sql`${table.status} in ('ACTIVE', 'INACTIVE')`),
  ],
);

// What a provider says about a canonical sale beyond the facts forecasting uses. It extends
// the sale rather than duplicating it, so forecasting never depends on a provider's shape.
// The team member identity is the provider's record of who the payment was associated with.
// It is not proof of who was logged in to a till.
export const commercePaymentEvidence = pgTable("commerce_payment_evidence", {
  id: uuid("id").primaryKey(),
  organisationId: uuid("organisation_id").notNull().references(() => organisations.id, { onDelete: "restrict" }),
  outletId: uuid("outlet_id").notNull().references(() => outlets.id, { onDelete: "restrict" }),
  connectionId: uuid("connection_id").notNull().references(() => commerceConnections.id, { onDelete: "restrict" }),
  saleTransactionId: uuid("sale_transaction_id").notNull().references(() => saleTransactions.id, { onDelete: "restrict" }),
  provider: text("provider").notNull(),
  providerPaymentId: text("provider_payment_id").notNull(),
  providerLocationId: text("provider_location_id").notNull(),
  providerStatus: text("provider_status").notNull(),
  providerTeamMemberId: text("provider_team_member_id"),
  // Square's tip_money on this payment, in the sale's currency. Never part of the sale's value.
  // null: not captured (every row stored before tips were read) or not established by the read.
  // 0: Square reported no tip. It is evidence, not an entitlement: nothing here allocates it.
  tipAmountMinor: bigint("tip_amount_minor", { mode: "number" }),
}, (t) => [
  uniqueIndex("commerce_payment_evidence_payment_unique").on(t.outletId, t.provider, t.providerPaymentId),
  uniqueIndex("commerce_payment_evidence_sale_unique").on(t.saleTransactionId),
  check("commerce_payment_evidence_provider_check", sql`${t.provider} in ('SQUARE')`),
  check("commerce_payment_evidence_status_check", sql`${t.providerStatus} = 'COMPLETED'`),
  check("commerce_payment_evidence_tip_check", sql`${t.tipAmountMinor} is null or (${t.tipAmountMinor} >= 0 and ${t.tipAmountMinor} <= 9007199254740991)`),
]);

// A refund as evidence: linked to its payment and never netted off a sale or an incentive.
// The identity a provider holds on a refund is deliberately not stored. Nothing establishes
// who performed a refund, so nothing here can be read as worker responsibility.
export const commerceRefundEvidence = pgTable("commerce_refund_evidence", {
  id: uuid("id").primaryKey(),
  organisationId: uuid("organisation_id").notNull().references(() => organisations.id, { onDelete: "restrict" }),
  outletId: uuid("outlet_id").notNull().references(() => outlets.id, { onDelete: "restrict" }),
  connectionId: uuid("connection_id").notNull().references(() => commerceConnections.id, { onDelete: "restrict" }),
  provider: text("provider").notNull(),
  providerRefundId: text("provider_refund_id").notNull(),
  providerPaymentId: text("provider_payment_id").notNull(),
  providerStatus: text("provider_status").notNull(),
  amountMinor: bigint("amount_minor", { mode: "number" }).notNull(),
  currencyCode: text("currency_code").notNull(),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
}, (t) => [
  uniqueIndex("commerce_refund_evidence_refund_unique").on(t.outletId, t.provider, t.providerRefundId),
  index("commerce_refund_evidence_payment_idx").on(t.outletId, t.providerPaymentId),
  check("commerce_refund_evidence_provider_check", sql`${t.provider} in ('SQUARE')`),
  check("commerce_refund_evidence_amount_check", sql`${t.amountMinor} >= 0 and ${t.amountMinor} <= 9007199254740991`),
]);

// A manager's statement that a provider's team member identity means this FairShift worker.
// Scoped to one provider account, one location and one worker. Removing a mapping keeps the record.
export const commerceWorkerIdentities = pgTable("commerce_worker_identities", {
  id: uuid("id").primaryKey(),
  organisationId: uuid("organisation_id").notNull().references(() => organisations.id, { onDelete: "restrict" }),
  outletId: uuid("outlet_id").notNull().references(() => outlets.id, { onDelete: "restrict" }),
  workerId: uuid("worker_id").notNull().references(() => workers.id, { onDelete: "restrict" }),
  provider: text("provider").notNull(),
  providerMerchantId: text("provider_merchant_id").notNull(),
  providerTeamMemberId: text("provider_team_member_id").notNull(),
  status: text("status").notNull(),
  createdBy: uuid("created_by").references(() => users.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  removedBy: uuid("removed_by").references(() => users.id),
  removedAt: timestamp("removed_at", { withTimezone: true }),
}, (t) => [
  // Across tenants: one provider identity means one worker, and one worker has one identity here.
  uniqueIndex("commerce_worker_identities_live_identity_unique").on(t.provider, t.providerMerchantId, t.providerTeamMemberId).where(sql`${t.status} = 'ACTIVE'`),
  uniqueIndex("commerce_worker_identities_live_worker_unique").on(t.outletId, t.provider, t.workerId).where(sql`${t.status} = 'ACTIVE'`),
  check("commerce_worker_identities_provider_check", sql`${t.provider} in ('SQUARE')`),
  check("commerce_worker_identities_status_check", sql`${t.status} in ('ACTIVE', 'REMOVED')`),
  check("commerce_worker_identities_removal_check", sql`(${t.status} = 'REMOVED') = (${t.removedAt} is not null)`),
]);

// A casual worker's own weekly availability, one row per local weekday they have
// stated. No row means not provided, which is not the same as available or unavailable.
// No reason is ever recorded.
export const workerAvailability = pgTable("worker_availability", {
  id: uuid("id").primaryKey(),
  workerId: uuid("worker_id").notNull().references(() => workers.id, { onDelete: "restrict" }),
  isoWeekday: integer("iso_weekday").notNull(), // 1 = Monday … 7 = Sunday
  state: text("state").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("worker_availability_worker_weekday_unique").on(t.workerId, t.isoWeekday),
  check("worker_availability_weekday_check", sql`${t.isoWeekday} between 1 and 7`),
  check("worker_availability_state_check", sql`${t.state} in ('AVAILABLE', 'UNAVAILABLE')`),
]);

// RETIRED from the active staffing path, which now uses regularCoverageWindows; kept so
// earlier records stay readable. Nothing writes or reads it any more.
// Planned regular-staff labour per location and local weekday: a standing weekly
// rota applied to each planning date. Lightweight staffing input, not user
// accounts, shifts, timesheets or payroll. A weekday with no row is not set; a row
// with zero minutes is a configured zero. Source says who supplied it.
export const regularStaffCoverage = pgTable("regular_staff_coverage", {
  id: uuid("id").primaryKey(),
  organisationId: uuid("organisation_id").notNull().references(() => organisations.id, { onDelete: "restrict" }),
  outletId: uuid("outlet_id").notNull().references(() => outlets.id, { onDelete: "restrict" }),
  isoWeekday: integer("iso_weekday").notNull(), // 1 = Monday … 7 = Sunday
  plannedMinutes: integer("planned_minutes").notNull(),
  source: text("source").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("regular_staff_coverage_outlet_weekday_unique").on(t.outletId, t.isoWeekday),
  index("regular_staff_coverage_organisation_idx").on(t.organisationId),
  check("regular_staff_coverage_weekday_check", sql`${t.isoWeekday} between 1 and 7`),
  check("regular_staff_coverage_minutes_check", sql`${t.plannedMinutes} between 0 and 1440000`),
  check("regular_staff_coverage_source_check", sql`${t.source} in ('REFERENCE', 'CONFIGURED')`),
]);

// RETIRED from the active staffing path, which now uses workloadPolicies; kept so earlier
// records stay readable. Nothing writes or reads it any more.
// A business's labour-productivity assumption: forecast sales per labour hour, in
// integer minor units of one currency. Organisation default (no outlet) with optional
// location overrides. Versions are append-only; at most one is active per scope, and
// a superseded version remains so staffing evidence can be explained later.
export const labourPolicies = pgTable("labour_policies", {
  id: uuid("id").primaryKey(),
  organisationId: uuid("organisation_id").notNull().references(() => organisations.id, { onDelete: "restrict" }),
  outletId: uuid("outlet_id").references(() => outlets.id, { onDelete: "restrict" }),
  version: integer("version").notNull(),
  currencyCode: text("currency_code").notNull(),
  salesMinorPerLabourHour: bigint("sales_minor_per_labour_hour", { mode: "number" }).notNull(),
  source: text("source").notNull(),
  status: text("status").notNull().default("ACTIVE"),
  createdBy: uuid("created_by").references(() => users.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  supersededAt: timestamp("superseded_at", { withTimezone: true }),
}, (t) => [
  uniqueIndex("labour_policies_active_organisation_unique").on(t.organisationId).where(sql`${t.status} = 'ACTIVE' and ${t.outletId} is null`),
  uniqueIndex("labour_policies_active_location_unique").on(t.outletId).where(sql`${t.status} = 'ACTIVE' and ${t.outletId} is not null`),
  index("labour_policies_organisation_idx").on(t.organisationId, t.createdAt),
  check("labour_policies_rate_check", sql`${t.salesMinorPerLabourHour} between 1 and 10000000`),
  check("labour_policies_currency_check", sql`${t.currencyCode} ~ '^[A-Z]{3}$'`),
  check("labour_policies_version_check", sql`${t.version} > 0`),
  check("labour_policies_source_check", sql`${t.source} in ('CONFIGURED', 'REFERENCE')`),
  check("labour_policies_status_check", sql`(${t.status} = 'ACTIVE' and ${t.supersededAt} is null) or (${t.status} = 'SUPERSEDED' and ${t.supersededAt} is not null)`),
]);

// A business's own service-capacity policy, never defaulted by FairShift: how many
// completed transactions one staff member supports in an hour, and the minimum staff
// while open. Organisation default (no outlet) with optional location overrides. The two
// values form one version: a business has a complete policy or none. Versions are
// append-only; a superseded version remains so earlier evidence can be explained.
export const workloadPolicies = pgTable("workload_policies", {
  id: uuid("id").primaryKey(),
  organisationId: uuid("organisation_id").notNull().references(() => organisations.id, { onDelete: "restrict" }),
  outletId: uuid("outlet_id").references(() => outlets.id, { onDelete: "restrict" }),
  version: integer("version").notNull(),
  transactionsPerStaffHour: integer("transactions_per_staff_hour").notNull(),
  minimumStaffWhileOpen: integer("minimum_staff_while_open").notNull(),
  source: text("source").notNull(),
  status: text("status").notNull().default("ACTIVE"),
  createdBy: uuid("created_by").references(() => users.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  supersededAt: timestamp("superseded_at", { withTimezone: true }),
}, (t) => [
  uniqueIndex("workload_policies_active_organisation_unique").on(t.organisationId).where(sql`${t.status} = 'ACTIVE' and ${t.outletId} is null`),
  uniqueIndex("workload_policies_active_location_unique").on(t.outletId).where(sql`${t.status} = 'ACTIVE' and ${t.outletId} is not null`),
  index("workload_policies_organisation_idx").on(t.organisationId, t.createdAt),
  check("workload_policies_capacity_check", sql`${t.transactionsPerStaffHour} between 1 and 1000`),
  check("workload_policies_minimum_check", sql`${t.minimumStaffWhileOpen} between 0 and 100`),
  check("workload_policies_version_check", sql`${t.version} > 0`),
  check("workload_policies_source_check", sql`${t.source} in ('CONFIGURED', 'REFERENCE')`),
  check("workload_policies_status_check", sql`(${t.status} = 'ACTIVE' and ${t.supersededAt} is null) or (${t.status} = 'SUPERSEDED' and ${t.supersededAt} is not null)`),
]);

// When one location trades on one local weekday: [{ start, end }] in minutes after local
// midnight. An empty list is a day stated as closed; no row means not set, which is not
// the same as closed.
export const outletTradingHours = pgTable("outlet_trading_hours", {
  id: uuid("id").primaryKey(),
  organisationId: uuid("organisation_id").notNull().references(() => organisations.id, { onDelete: "restrict" }),
  outletId: uuid("outlet_id").notNull().references(() => outlets.id, { onDelete: "restrict" }),
  isoWeekday: integer("iso_weekday").notNull(), // 1 = Monday … 7 = Sunday
  windows: jsonb("windows").notNull(),
  source: text("source").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("outlet_trading_hours_outlet_weekday_unique").on(t.outletId, t.isoWeekday),
  index("outlet_trading_hours_organisation_idx").on(t.organisationId),
  check("outlet_trading_hours_weekday_check", sql`${t.isoWeekday} between 1 and 7`),
  check("outlet_trading_hours_windows_check", sql`jsonb_typeof(${t.windows}) = 'array'`),
  check("outlet_trading_hours_source_check", sql`${t.source} in ('REFERENCE', 'CONFIGURED')`),
]);

// Regular staff capacity by time of day on one local weekday: [{ start, end, headcount }].
// Capacity input only, not rostering. An empty list is a stated zero; no row means not set.
export const regularCoverageWindows = pgTable("regular_coverage_windows", {
  id: uuid("id").primaryKey(),
  organisationId: uuid("organisation_id").notNull().references(() => organisations.id, { onDelete: "restrict" }),
  outletId: uuid("outlet_id").notNull().references(() => outlets.id, { onDelete: "restrict" }),
  isoWeekday: integer("iso_weekday").notNull(), // 1 = Monday … 7 = Sunday
  windows: jsonb("windows").notNull(),
  source: text("source").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("regular_coverage_windows_outlet_weekday_unique").on(t.outletId, t.isoWeekday),
  index("regular_coverage_windows_organisation_idx").on(t.organisationId),
  check("regular_coverage_windows_weekday_check", sql`${t.isoWeekday} between 1 and 7`),
  check("regular_coverage_windows_windows_check", sql`jsonb_typeof(${t.windows}) = 'array'`),
  check("regular_coverage_windows_source_check", sql`${t.source} in ('REFERENCE', 'CONFIGURED')`),
]);

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
  // The location's currency when the policy was created; rates are in its minor units.
  currencyCode: text("currency_code").notNull(),
  // Optional Owner-set incentive: this fixed bonus if the worker's own attributed sales
  // for the shift reach this target. Copied to shifts; a later change here alters nothing accepted.
  incentiveTargetMinor: bigint("incentive_target_minor", { mode: "number" }),
  incentiveBonusMinor: bigint("incentive_bonus_minor", { mode: "number" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  // Day 6 (10 Nov 2026): editing pay terms writes a new dated version; the old one is kept, marked
  // superseded, and no longer offered. Shifts copy their terms, so accepted work never changes.
  effectiveFrom: timestamp("effective_from", { withTimezone: true }).notNull().defaultNow(),
  supersededAt: timestamp("superseded_at", { withTimezone: true }),
  replacesPolicyId: uuid("replaces_policy_id"),
}, (t) => [check("work_policy_currency_check", sql`${t.currencyCode} ~ '^[A-Z]{3}$'`), check("work_policy_incentive_check", sql`(${t.incentiveTargetMinor} is null and ${t.incentiveBonusMinor} is null) or (
  ${t.incentiveTargetMinor} is not null and ${t.incentiveBonusMinor} is not null and ${t.incentiveTargetMinor} between 1 and 9007199254740991 and ${t.incentiveBonusMinor} between 1 and 9007199254740991 and ${t.earningsModel} in ('HOURLY', 'DAILY')
)`), check("work_policy_terms_check", sql`(
  ${t.earningsModel} in ('HOURLY', 'DAILY') and ${t.rateMinor} is not null and ${t.rateMinor} >= 0 and ${t.rateMinor} <= 9007199254740991 and ${t.commissionBps} is null and ${t.commissionBasis} is null
) or (
  ${t.earningsModel} = 'COMMISSION' and ${t.rateMinor} is null and ${t.commissionBps} is not null and ${t.commissionBasis} is not null and ${t.commissionBps} between 0 and 10000 and ${t.commissionBasis} = 'VERIFIED_ATTRIBUTED_SALES'
)`)]);

// Extended from the original prepared Team invitation; token now stores only SHA-256.
export const teamInvitations = pgTable("team_invitations", {
  id: uuid("id").primaryKey(), workerId: uuid("worker_id").references(() => workers.id),
  organisationId: uuid("organisation_id").references(() => organisations.id), outletId: uuid("outlet_id").references(() => outlets.id),
  email: text("email"), role: text("role").notNull().default("TEAM_MEMBER"),
  state: text("state").notNull().default("CREATED_NOT_SENT"), token: text("token").notNull(),
  expiresAt: timestamp("expires_at", {withTimezone:true}).notNull().default(sql`now() + interval '7 days'`),
  redeemedBy: uuid("redeemed_by").references(() => users.id), redeemedAt: timestamp("redeemed_at", {withTimezone:true}),
  createdBy: uuid("created_by").references(() => users.id),
  createdAt: timestamp("created_at", {withTimezone:true}).notNull().defaultNow(),
  // Day 6 (FS-PEOPLE 10 Nov 2026): who was invited, as the inviter typed it (no home address is ever
  // asked for), and the batch when one Manager is invited to several locations at once.
  firstName: text("first_name"), surname: text("surname"), telephone: text("telephone"),
  batchId: uuid("batch_id"),
}, t => [uniqueIndex("team_invitation_token_unique").on(t.token),
  check("invitation_hashed_token_check",sql`${t.token} ~ '^[0-9a-f]{64}$'`),
  check("team_invitation_role_check", sql`${t.role} in ('MANAGER','TEAM_MEMBER')`),
  check("team_invitation_state_check", sql`${t.state} in ('CREATED_NOT_SENT','SENT','DELIVERY_FAILED','REDEEMED','EXPIRED','REVOKED')`)]);
export const memberships = pgTable("organisation_memberships", {
  id: uuid("id").primaryKey(), userId: uuid("user_id").notNull().references(() => users.id),
  organisationId: uuid("organisation_id").notNull().references(() => organisations.id),
  outletId: uuid("outlet_id").references(() => outlets.id), workerId: uuid("worker_id").references(() => workers.id),
  role: text("role").notNull(), invitationId: uuid("invitation_id").references(() => teamInvitations.id),
  state: text("state").notNull().default("ACTIVE"), createdAt: timestamp("created_at", {withTimezone:true}).notNull().defaultNow(),
}, t => [uniqueIndex("membership_invitation_unique").on(t.invitationId), uniqueIndex("membership_worker_unique").on(t.workerId),
  index("membership_user_org_idx").on(t.userId,t.organisationId),
  check("membership_role_check",sql`${t.role} in ('OWNER','MANAGER','TEAM_MEMBER')`),
  check("membership_state_check",sql`${t.state} in ('ACTIVE','REVOKED')`),
  check("membership_scope_check", sql`(${t.role} = 'OWNER' and ${t.outletId} is null and ${t.workerId} is null and ${t.invitationId} is null) or (${t.role} = 'MANAGER' and ${t.outletId} is not null and ${t.workerId} is null and ${t.invitationId} is not null) or (${t.role} = 'TEAM_MEMBER' and ${t.outletId} is not null and ${t.workerId} is not null and ${t.invitationId} is not null)`)]);
export const subscriptions = pgTable("organisation_subscriptions", {
  id: uuid("id").primaryKey(), organisationId: uuid("organisation_id").notNull().references(() => organisations.id),
  tier: text("tier"), billingPeriod: text("billing_period"), locationLimit: integer("location_limit"),
  providerId: text("provider_id"), planId: text("plan_id"), status: text("status").notNull().default("UNCONFIGURED"),
  requestId: uuid("request_id").notNull(), approvalUrl: text("approval_url"), verifiedAt: timestamp("verified_at",{withTimezone:true}),
  updatedAt: timestamp("updated_at",{withTimezone:true}).notNull().defaultNow(),
}, t => [uniqueIndex("subscription_org_unique").on(t.organisationId),uniqueIndex("subscription_provider_unique").on(t.providerId), uniqueIndex("subscription_request_unique").on(t.requestId),
  check("subscription_tier_check",sql`${t.tier} in ('SINGLE_OUTLET','MULTI_OUTLET','ENTERPRISE')`),
  check("subscription_period_check",sql`${t.billingPeriod} in ('MONTHLY','ANNUAL')`),
  check("subscription_location_limit_check",sql`case when ${t.tier} is null then ${t.locationLimit} is null and ${t.billingPeriod} is null when ${t.tier} = 'SINGLE_OUTLET' then coalesce(${t.locationLimit} = 1 and ${t.billingPeriod} is not null, false) when ${t.tier} = 'MULTI_OUTLET' then coalesce(${t.locationLimit} = 5 and ${t.billingPeriod} is not null, false) when ${t.tier} = 'ENTERPRISE' then coalesce(${t.locationLimit} > 0, false) else false end`),
  check("subscription_status_check",sql`${t.status} in ('UNCONFIGURED','PENDING','APPROVAL_PENDING','APPROVED','ACTIVE','SUSPENDED','CANCELLED','EXPIRED')`)]);
export const subscriptionEvents = pgTable("subscription_events", {
  id: text("id").primaryKey(), payloadHash: text("payload_hash").notNull(), providerId: text("provider_id").notNull(),
  eventType: text("event_type").notNull(), processedAt: timestamp("processed_at",{withTimezone:true}).notNull().defaultNow(),
});
export const notifications = pgTable("notifications", {
  id: uuid("id").primaryKey(), organisationId: uuid("organisation_id").references(() => organisations.id),
  userId: uuid("user_id").references(() => users.id), workerId: uuid("worker_id").references(() => workers.id),
  recipientEmail: text("recipient_email").notNull(), eventKey: text("event_key").notNull(), kind: text("kind").notNull(),
  entityId: text("entity_id").notNull(), title: text("title").notNull(), body: text("body").notNull(), href: text("href").notNull(),
  readAt: timestamp("read_at",{withTimezone:true}), createdAt: timestamp("created_at",{withTimezone:true}).notNull().defaultNow(),
}, t => [uniqueIndex("notification_event_unique").on(t.eventKey),index("notification_recipient_idx").on(t.userId,t.createdAt)]);
export const notificationDeliveries = pgTable("notification_deliveries", {
  id: uuid("id").primaryKey(), notificationId: uuid("notification_id").notNull().references(() => notifications.id),
  channel: text("channel").notNull().default("EMAIL"), destination: text("destination").notNull(), provider: text("provider").notNull().default("RESEND"),
  providerMessageId: text("provider_message_id"), status: text("status").notNull().default("PENDING"),
  attemptedAt: timestamp("attempted_at",{withTimezone:true}), acceptedAt: timestamp("accepted_at",{withTimezone:true}), deliveredAt: timestamp("delivered_at",{withTimezone:true}), failureCode: text("failure_code"),
}, t => [uniqueIndex("notification_delivery_channel_unique").on(t.notificationId,t.channel),
 check("delivery_status_check",sql`${t.status} in ('PENDING','UNCONFIGURED','SENDING','ACCEPTED','FAILED','UNKNOWN','DELIVERED')`)]);

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
    // Set only for the individual target-and-bonus incentive; the seeded demo's team incentive leaves it null.
    incentiveBasis: text("incentive_basis"),
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
    check("shifts_incentive_basis_check", sql`${table.incentiveBasis} is null or (${table.incentiveBasis} = 'INDIVIDUAL_ATTRIBUTED_SALES' and ${table.incentiveTargetMinor} > 0 and ${table.incentiveAmountMinor} > 0)`),
    check("shifts_time_order_check", sql`${table.endsAt} > ${table.startsAt}`),
  ],
);

// Why a shift was created: a frozen copy of the opportunity it came from, taken when the
// manager created it. Never changes when the forecast or policy moves, and pay never reads it.
export const shiftOpportunityEvidence = pgTable("shift_opportunity_evidence", {
  shiftId: uuid("shift_id").primaryKey().references(() => shifts.id, { onDelete: "restrict" }),
  organisationId: uuid("organisation_id").notNull().references(() => organisations.id, { onDelete: "restrict" }),
  outletId: uuid("outlet_id").notNull().references(() => outlets.id, { onDelete: "restrict" }),
  localDate: date("local_date", { mode: "string" }).notNull(),
  windowStartsAt: timestamp("window_starts_at", { withTimezone: true }).notNull(),
  windowEndsAt: timestamp("window_ends_at", { withTimezone: true }).notNull(),
  evidence: jsonb("evidence").notNull(),
  createdBy: uuid("created_by").references(() => users.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("shift_opportunity_evidence_outlet_idx").on(t.outletId, t.localDate),
  check("shift_opportunity_evidence_window_check", sql`${t.windowEndsAt} > ${t.windowStartsAt}`),
]);

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

// The primary key is declared first: Drizzle reads a left-joined row as absent when its
// first selected column is null, so a nullable first column hid unconfirmed allocations.
export const workAllocations = pgTable("work_allocations", {
  id: uuid("id").primaryKey(),
  offerId: uuid("offer_id").notNull().references(() => shiftOffers.id),
  acceptanceId: uuid("acceptance_id").notNull().references(() => workAcceptances.id),
  state: text("state").notNull().default("ALLOCATED"),
  confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
}, (t) => [uniqueIndex("work_allocations_offer_unique").on(t.offerId),
  check("work_allocation_state_check", sql`${t.state} in ('ALLOCATED', 'REACCEPTANCE_REQUIRED')`)]);

// The base payable for one confirmed work unit (one allocation), derived from the
// immutable accepted terms it was allocated under (confirm-as-scheduled). A distinct
// record from expected earnings, incentives and payouts: it is not an approval and
// nothing here has been paid. Financial facts are immutable once written, and a
// database trigger checks every reference against the same organisation, location,
// shift, worker, offer, allocation and acceptance (drizzle/0013_work_payables.sql).
export const workPayables = pgTable("work_payables", {
  id: uuid("id").primaryKey(),
  organisationId: uuid("organisation_id").notNull().references(() => organisations.id, { onDelete: "restrict" }),
  outletId: uuid("outlet_id").notNull().references(() => outlets.id, { onDelete: "restrict" }),
  shiftId: uuid("shift_id").notNull().references(() => shifts.id, { onDelete: "restrict" }),
  workerId: uuid("worker_id").notNull().references(() => workers.id, { onDelete: "restrict" }),
  offerId: uuid("offer_id").notNull().references(() => shiftOffers.id, { onDelete: "restrict" }),
  allocationId: uuid("allocation_id").notNull().references(() => workAllocations.id, { onDelete: "restrict" }),
  acceptanceId: uuid("acceptance_id").notNull().references(() => workAcceptances.id, { onDelete: "restrict" }),
  termsVersion: integer("terms_version").notNull(),
  calculationMethod: text("calculation_method").notNull(),
  earningsModel: text("earnings_model").notNull(),
  currencyCode: text("currency_code").notNull(),
  rateMinor: bigint("rate_minor", { mode: "number" }).notNull(),
  scheduledStartsAt: timestamp("scheduled_starts_at", { withTimezone: true }).notNull(),
  scheduledEndsAt: timestamp("scheduled_ends_at", { withTimezone: true }).notNull(),
  baseAmountMinor: bigint("base_amount_minor", { mode: "number" }).notNull(),
  // PENDING_REVIEW until a manager approves it (APPROVED). Payment state is held by
  // the payable's work_payouts row, never here.
  status: text("status").notNull().default("PENDING_REVIEW"),
  confirmedAt: timestamp("confirmed_at", { withTimezone: true }).notNull(),
  confirmedBy: uuid("confirmed_by").references(() => users.id),
  // Manager approval of the final payable amount, which the manager cannot edit.
  approvedAt: timestamp("approved_at", { withTimezone: true }),
  approvedBy: uuid("approved_by").references(() => users.id),
  approvedAmountMinor: bigint("approved_amount_minor", { mode: "number" }),
  approvedCurrencyCode: text("approved_currency_code"),
  // Whether the accepted terms carry an incentive, and the amount from the confirmed
  // performance result. Null while unknown: unknown is not zero, and blocks approval.
  // Final payable = base amount + incentive amount.
  incentiveRequired: boolean("incentive_required").notNull().default(false),
  incentiveAmountMinor: bigint("incentive_amount_minor", { mode: "number" }),
  performanceResultId: uuid("performance_result_id").references((): AnyPgColumn => workPerformanceResults.id, { onDelete: "restrict" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("work_payables_allocation_unique").on(t.allocationId),
  uniqueIndex("work_payables_shift_worker_unique").on(t.shiftId, t.workerId),
  index("work_payables_scope_idx").on(t.organisationId, t.outletId, t.confirmedAt),
  index("work_payables_worker_idx").on(t.workerId),
  check("work_payables_method_check", sql`${t.calculationMethod} = 'confirm-as-scheduled-v1'`),
  check("work_payables_model_check", sql`${t.earningsModel} in ('HOURLY', 'DAILY')`),
  check("work_payables_currency_check", sql`${t.currencyCode} ~ '^[A-Z]{3}$'`),
  check("work_payables_amounts_check", sql`${t.rateMinor} between 0 and 9007199254740991 and ${t.baseAmountMinor} between 0 and 9007199254740991 and ${t.termsVersion} > 0`),
  check("work_payables_schedule_check", sql`${t.scheduledEndsAt} > ${t.scheduledStartsAt}`),
  // The amount is exactly the accepted rate applied to the accepted schedule.
  check("work_payables_formula_check", sql`(${t.earningsModel} = 'DAILY' and ${t.baseAmountMinor} = ${t.rateMinor}) or (${t.earningsModel} = 'HOURLY' and ${t.baseAmountMinor}::numeric * 3600 = ${t.rateMinor}::numeric * extract(epoch from ${t.scheduledEndsAt} - ${t.scheduledStartsAt}))`),
  check("work_payables_status_check", sql`${t.status} in ('PENDING_REVIEW', 'APPROVED')`),
  check("work_payables_incentive_check", sql`(${t.incentiveAmountMinor} is null and ${t.performanceResultId} is null) or (${t.incentiveRequired} and ${t.incentiveAmountMinor} is not null and ${t.incentiveAmountMinor} between 0 and 9007199254740991 and ${t.performanceResultId} is not null)`),
  check("work_payables_approval_check", sql`(${t.status} = 'PENDING_REVIEW' and ${t.approvedAt} is null and ${t.approvedBy} is null and ${t.approvedAmountMinor} is null and ${t.approvedCurrencyCode} is null)
    or (${t.status} = 'APPROVED' and ${t.approvedAt} is not null and ${t.approvedBy} is not null and ${t.approvedAmountMinor} is not null and ${t.approvedAmountMinor} = ${t.baseAmountMinor} + coalesce(${t.incentiveAmountMinor}, 0) and ${t.approvedCurrencyCode} = ${t.currencyCode} and (not ${t.incentiveRequired} or ${t.incentiveAmountMinor} is not null))`),
]);

// The single PayPal payout of one approved work payable. The unique payable reference
// is the reservation: at most one payout can ever exist for a payable, and its
// sender batch/item IDs are derived from the payable, so a retry reuses them and
// PayPal pays a sender_batch_id at most once. The amount, currency and recipient are
// fixed when the payout is reserved; a database trigger checks the amount and currency
// against the approved payable (drizzle/0014_work_payouts.sql).
export const workPayouts = pgTable("work_payouts", {
  id: uuid("id").primaryKey(),
  // Exactly one obligation: an approved work payable, or one tip allocation line
  // (FS-TIP-AGENT-DEC-001), both settled through this same engine.
  payableId: uuid("payable_id").references(() => workPayables.id, { onDelete: "restrict" }),
  tipLineId: uuid("tip_line_id").references((): AnyPgColumn => tipAllocationLines.id, { onDelete: "restrict" }),
  organisationId: uuid("organisation_id").notNull().references(() => organisations.id, { onDelete: "restrict" }),
  outletId: uuid("outlet_id").notNull().references(() => outlets.id, { onDelete: "restrict" }),
  workerId: uuid("worker_id").notNull().references(() => workers.id, { onDelete: "restrict" }),
  amountMinor: bigint("amount_minor", { mode: "number" }).notNull(),
  currencyCode: text("currency_code").notNull(),
  // amountMinor/currencyCode are the worker's approved entitlement, copied from the payable
  // and checked against it by a trigger. When PayPal cannot pay that currency the payout is
  // sent in a provider currency instead: providerAmountMinor/providerCurrency are what is
  // actually sent to PayPal, and the frozen conversion rate (operating-currency micro-units
  // per one provider unit) and its source are recorded so a reservation is never re-converted
  // (DEC-SA-012). With no conversion the provider fields equal the entitlement and the rate is
  // null; see payments/work-payouts.ts and domain/provider-currency.ts.
  providerCurrency: text("provider_currency").notNull(),
  providerAmountMinor: bigint("provider_amount_minor", { mode: "number" }).notNull(),
  fxRateMicros: bigint("fx_rate_micros", { mode: "number" }),
  fxRateSource: text("fx_rate_source"),
  recipient: text("recipient").notNull(),
  senderBatchId: text("sender_batch_id").notNull(),
  senderItemId: text("sender_item_id").notNull(),
  // SUBMITTING: reserved and being sent; NOT_SENT: PayPal certainly made no payout;
  // PROCESSING: PayPal accepted it; PAID: PayPal item SUCCESS; FAILED: PayPal refused
  // or failed it; RECONCILIATION_REQUIRED: the outcome of the request is unknown.
  status: text("status").notNull(),
  paypalBatchId: text("paypal_batch_id"),
  paypalItemId: text("paypal_item_id"),
  paypalTransactionId: text("paypal_transaction_id"),
  paypalBatchStatus: text("paypal_batch_status"),
  paypalStatus: text("paypal_status"),
  // Structured, non-sensitive provider error: code, HTTP status and debug ID only.
  lastError: jsonb("last_error"),
  attempts: integer("attempts").notNull().default(1),
  requestedBy: uuid("requested_by").references(() => users.id),
  reservedAt: timestamp("reserved_at", { withTimezone: true }).notNull(),
  submittedAt: timestamp("submitted_at", { withTimezone: true }),
  statusCheckedAt: timestamp("status_checked_at", { withTimezone: true }),
  paidAt: timestamp("paid_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("work_payouts_payable_unique").on(t.payableId),
  uniqueIndex("work_payouts_tip_line_unique").on(t.tipLineId),
  uniqueIndex("work_payouts_sender_batch_unique").on(t.senderBatchId),
  uniqueIndex("work_payouts_sender_item_unique").on(t.senderItemId),
  uniqueIndex("work_payouts_paypal_batch_unique").on(t.paypalBatchId),
  index("work_payouts_scope_idx").on(t.organisationId, t.outletId),
  index("work_payouts_worker_idx").on(t.workerId),
  check("work_payouts_status_check", sql`${t.status} in ('SUBMITTING', 'NOT_SENT', 'PROCESSING', 'PAID', 'FAILED', 'RECONCILIATION_REQUIRED')`),
  check("work_payouts_amount_check", sql`${t.amountMinor} > 0 and ${t.amountMinor} <= 9007199254740991 and ${t.currencyCode} ~ '^[A-Z]{3}$' and ${t.attempts} > 0`),
  check("work_payouts_provider_amount_check", sql`${t.providerAmountMinor} > 0 and ${t.providerAmountMinor} <= 9007199254740991 and ${t.providerCurrency} ~ '^[A-Z]{3}$'`),
  // The provider leg is either an identity (same currency, no rate) or a recorded conversion:
  // a positive rate and a source, a different provider currency, and a provider amount that is
  // exactly the entitlement converted down to the cent (truncated integer division, which for
  // these positive values is floor). This freezes the conversion in the row, so no rate change
  // can alter a reservation and recovery never re-converts.
  check("work_payouts_provider_conversion_check", sql`(${t.fxRateMicros} is null and ${t.fxRateSource} is null and ${t.providerCurrency} = ${t.currencyCode} and ${t.providerAmountMinor} = ${t.amountMinor}) or (${t.fxRateMicros} is not null and ${t.fxRateMicros} > 0 and ${t.fxRateSource} is not null and ${t.providerCurrency} <> ${t.currencyCode} and ${t.providerAmountMinor} = div(${t.amountMinor}::numeric * 1000000, ${t.fxRateMicros}::numeric))`),
  // Processing and paid payouts have a PayPal batch; a reservation or unsent payout cannot.
  check("work_payouts_provider_check", sql`(${t.status} not in ('PROCESSING', 'PAID') or ${t.paypalBatchId} is not null) and (${t.status} not in ('SUBMITTING', 'NOT_SENT') or ${t.paypalBatchId} is null)`),
  check("work_payouts_paid_check", sql`(${t.status} = 'PAID') = (${t.paidAt} is not null and coalesce(${t.paypalStatus}, '') = 'SUCCESS')`),
]);

// Worker-attributed sales: a separate boundary from location sales. Rows arrive only
// through the location-scoped import, and stay UNVERIFIED: no provider has confirmed them.
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
}, (t) => [uniqueIndex("attributed_sales_location_transaction_unique").on(t.outletId, t.provider, t.providerTransactionId),
  index("attributed_sales_worker_time_idx").on(t.workerId, t.occurredAt),
  check("attributed_sales_verification_check", sql`${t.verificationState} in ('UNVERIFIED', 'VERIFIED', 'FAILED')`),
  check("attributed_sales_amount_check", sql`${t.amountMinor} >= 0 and ${t.amountMinor} <= 9007199254740991`)]);

// The sales result a manager confirmed as complete for one allocation, and the incentive
// it produced under the accepted terms. Its existence is what separates a genuine zero
// from missing evidence. Immutable, and checked against the acceptance by a trigger
// (drizzle/0018). Confirming for payment does not make imported evidence provider-verified.
export const workPerformanceResults = pgTable("work_performance_results", {
  id: uuid("id").primaryKey(),
  organisationId: uuid("organisation_id").notNull().references(() => organisations.id, { onDelete: "restrict" }),
  outletId: uuid("outlet_id").notNull().references(() => outlets.id, { onDelete: "restrict" }),
  shiftId: uuid("shift_id").notNull().references(() => shifts.id, { onDelete: "restrict" }),
  workerId: uuid("worker_id").notNull().references(() => workers.id, { onDelete: "restrict" }),
  allocationId: uuid("allocation_id").notNull().references(() => workAllocations.id, { onDelete: "restrict" }),
  acceptanceId: uuid("acceptance_id").notNull().references(() => workAcceptances.id, { onDelete: "restrict" }),
  salesCount: integer("sales_count").notNull(),
  salesMinor: bigint("sales_minor", { mode: "number" }).notNull(),
  currencyCode: text("currency_code").notNull(),
  targetMinor: bigint("target_minor", { mode: "number" }).notNull(),
  bonusMinor: bigint("bonus_minor", { mode: "number" }).notNull(),
  earnedMinor: bigint("earned_minor", { mode: "number" }).notNull(),
  evidenceProvenance: text("evidence_provenance").notNull(),
  confirmedAt: timestamp("confirmed_at", { withTimezone: true }).notNull(),
  confirmedBy: uuid("confirmed_by").references(() => users.id),
}, (t) => [uniqueIndex("work_performance_results_allocation_unique").on(t.allocationId),
  index("work_performance_results_worker_idx").on(t.workerId),
  check("work_performance_results_amounts_check", sql`${t.salesCount} >= 0 and ${t.salesMinor} between 0 and 9007199254740991 and ${t.targetMinor} > 0 and ${t.bonusMinor} > 0 and (${t.salesCount} > 0 or ${t.salesMinor} = 0)`),
  check("work_performance_results_formula_check", sql`${t.earnedMinor} = case when ${t.salesMinor} >= ${t.targetMinor} then ${t.bonusMinor} else 0 end`),
  check("work_performance_results_provenance_check", sql`${t.evidenceProvenance} in ('IMPORTED_NOT_PROVIDER_VERIFIED', 'SQUARE_TEAM_MEMBER')`),
  check("work_performance_results_currency_check", sql`${t.currencyCode} ~ '^[A-Z]{3}$'`)]);

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

// One AI-assisted interpretation of a deterministic staffing week, or a failed
// attempt at one. `input` is exactly what the model was given (aggregate planning
// evidence with opaque location keys) and `input_fingerprint` its SHA-256, so an
// assessment is current only while the deterministic evidence is unchanged.
// `location_keys` maps those keys back to outlets; it is never sent to the model.
// Scope is the organisation (Owner) or one location (Manager).
export const aiStaffingAssessments = pgTable("ai_staffing_assessments", {
  id: uuid("id").primaryKey(),
  organisationId: uuid("organisation_id").notNull().references(() => organisations.id, { onDelete: "restrict" }),
  outletId: uuid("outlet_id").references(() => outlets.id, { onDelete: "restrict" }),
  scopeKey: text("scope_key").notNull(),
  inputVersion: text("input_version").notNull(),
  outputSchemaVersion: text("output_schema_version").notNull(),
  inputFingerprint: text("input_fingerprint").notNull(),
  input: jsonb("input").notNull(),
  locationKeys: jsonb("location_keys").notNull(),
  planningStart: date("planning_start", { mode: "string" }),
  planningEnd: date("planning_end", { mode: "string" }),
  evidenceThrough: date("evidence_through", { mode: "string" }),
  provider: text("provider").notNull(),
  model: text("model").notNull(),
  responseModel: text("response_model"),
  providerResponseId: text("provider_response_id"),
  status: text("status").notNull(),
  failureCode: text("failure_code"),
  assessment: jsonb("assessment"),
  requestedBy: uuid("requested_by").references(() => users.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("ai_staffing_assessments_scope_idx").on(t.organisationId, t.scopeKey, t.createdAt),
  uniqueIndex("ai_staffing_assessments_current_unique").on(t.organisationId, t.scopeKey, t.inputFingerprint).where(sql`${t.status} = 'AVAILABLE'`),
  check("ai_staffing_assessments_status_check", sql`(${t.status} = 'AVAILABLE' and ${t.assessment} is not null and ${t.failureCode} is null and ${t.responseModel} is not null)
    or (${t.status} = 'FAILED' and ${t.assessment} is null and ${t.failureCode} is not null)`),
  check("ai_staffing_assessments_scope_check", sql`(${t.scopeKey} = 'ORGANISATION' and ${t.outletId} is null) or (${t.outletId} is not null and ${t.scopeKey} = 'LOCATION:' || ${t.outletId}::text)`),
  check("ai_staffing_assessments_fingerprint_check", sql`${t.inputFingerprint} ~ '^[0-9a-f]{64}$'`),
]);

// A contextual signal known about one location and period. Sales history is never touched by
// one. Manager-entered text is provenance-labelled and never treated as externally verified.
export const demandContextSignals = pgTable("demand_context_signals", {
  id: text("id").primaryKey(),
  organisationId: uuid("organisation_id").notNull().references(() => organisations.id, { onDelete: "restrict" }),
  outletId: uuid("outlet_id").notNull().references(() => outlets.id, { onDelete: "restrict" }),
  signalType: text("signal_type").notNull(),
  validFrom: date("valid_from", { mode: "string" }).notNull(),
  validTo: date("valid_to", { mode: "string" }).notNull(),
  // Minutes after local midnight, when the signal concerns part of a day.
  periodStart: integer("period_start"),
  periodEnd: integer("period_end"),
  direction: text("direction").notNull(),
  provenance: text("provenance").notNull(),
  sourceLabel: text("source_label").notNull(),
  sourceRef: text("source_ref"),
  summary: text("summary").notNull(),
  metadata: jsonb("metadata").notNull().default({}),
  enteredBy: uuid("entered_by").references(() => users.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  withdrawnAt: timestamp("withdrawn_at", { withTimezone: true }),
  withdrawnBy: uuid("withdrawn_by").references(() => users.id),
}, (t) => [
  index("demand_context_signals_scope_idx").on(t.organisationId, t.outletId, t.validTo),
  check("demand_context_signals_type_check", sql`${t.signalType} in ('MOMENTUM', 'MANAGER_ENTERED', 'BANK_HOLIDAY', 'WEATHER_FORECAST', 'BOOKINGS', 'LOCAL_EVENT', 'PROMOTION')`),
  check("demand_context_signals_direction_check", sql`${t.direction} in ('UP', 'DOWN', 'FLAT', 'UNSPECIFIED')`),
  check("demand_context_signals_provenance_check", sql`(${t.signalType} = 'MOMENTUM' and ${t.provenance} = 'DETERMINISTIC_CALCULATION')
    or (${t.signalType} in ('MANAGER_ENTERED', 'BOOKINGS', 'LOCAL_EVENT', 'PROMOTION') and ${t.provenance} = 'MANAGER_ENTERED' and ${t.enteredBy} is not null)
    or (${t.signalType} = 'LOCAL_EVENT' and ${t.provenance} = 'PROVIDER_EVENT')
    or (${t.signalType} = 'BANK_HOLIDAY' and ${t.provenance} in ('OFFICIAL_SNAPSHOT', 'HOLIDAY_FEED', 'HOLIDAY_FALLBACK'))
    or (${t.signalType} = 'WEATHER_FORECAST' and ${t.provenance} = 'PROVIDER_FORECAST')`),
  check("demand_context_signals_period_check", sql`${t.validTo} >= ${t.validFrom}`),
  check("demand_context_signals_time_check", sql`(${t.periodStart} is null and ${t.periodEnd} is null) or (${t.periodStart} >= 0 and ${t.periodEnd} <= 1440 and ${t.periodStart} < ${t.periodEnd})`),
]);

// The latest state of an automatic feed at one location. A failed fetch updates only the attempt
// and failure fields, so the last good signals stay current and are shown with their age.
export const demandContextFeeds = pgTable("demand_context_feeds", {
  organisationId: uuid("organisation_id").notNull().references(() => organisations.id, { onDelete: "restrict" }),
  outletId: uuid("outlet_id").notNull().references(() => outlets.id, { onDelete: "restrict" }),
  feed: text("feed").notNull(),
  lastAttemptAt: timestamp("last_attempt_at", { withTimezone: true }).notNull(),
  lastSuccessAt: timestamp("last_success_at", { withTimezone: true }),
  lastFailureCode: text("last_failure_code"),
  currentSignalIds: jsonb("current_signal_ids").notNull().default([]),
}, (t) => [
  primaryKey({ columns: [t.outletId, t.feed] }),
  check("demand_context_feeds_feed_check", sql`${t.feed} in ('WEATHER', 'EVENTS')`),
]);

// A bounded AI scenario for one location and date. A proposal changes nothing by itself. The
// model's scenario, citations and reason are stored only after validation.
export const demandContextProposals = pgTable("demand_context_proposals", {
  id: uuid("id").primaryKey(),
  organisationId: uuid("organisation_id").notNull().references(() => organisations.id, { onDelete: "restrict" }),
  outletId: uuid("outlet_id").notNull().references(() => outlets.id, { onDelete: "restrict" }),
  targetDate: date("target_date", { mode: "string" }).notNull(),
  policyVersion: text("policy_version").notNull(),
  inputVersion: text("input_version").notNull(),
  outputSchemaVersion: text("output_schema_version").notNull(),
  inputFingerprint: text("input_fingerprint").notNull(),
  input: jsonb("input").notNull(),
  provider: text("provider").notNull(),
  model: text("model").notNull(),
  responseModel: text("response_model"),
  providerResponseId: text("provider_response_id"),
  status: text("status").notNull(),
  failureCode: text("failure_code"),
  scenario: text("scenario"),
  // The part of the trading day the scenario applies to, on planning-block boundaries. Null is the whole day.
  periodStart: integer("period_start"),
  periodEnd: integer("period_end"),
  citedSignalIds: jsonb("cited_signal_ids"),
  reason: text("reason"),
  requestedBy: uuid("requested_by").references(() => users.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("demand_context_proposals_scope_idx").on(t.organisationId, t.outletId, t.targetDate, t.createdAt),
  uniqueIndex("demand_context_proposals_current_unique").on(t.outletId, t.targetDate, t.inputFingerprint).where(sql`${t.status} = 'AVAILABLE'`),
  check("demand_context_proposals_status_check", sql`(${t.status} = 'AVAILABLE' and ${t.scenario} in ('NONE', 'MINOR_UP', 'MODERATE_UP', 'MINOR_DOWN', 'MODERATE_DOWN') and ${t.citedSignalIds} is not null and ${t.reason} is not null and ${t.failureCode} is null and ${t.responseModel} is not null)
    or (${t.status} = 'FAILED' and ${t.scenario} is null and ${t.citedSignalIds} is null and ${t.reason} is null and ${t.failureCode} is not null)`),
  check("demand_context_proposals_fingerprint_check", sql`${t.inputFingerprint} ~ '^[0-9a-f]{64}$'`),
  check("demand_context_proposals_period_check", sql`(${t.periodStart} is null and ${t.periodEnd} is null) or (${t.status} = 'AVAILABLE' and ${t.periodStart} >= 0 and ${t.periodEnd} <= 1440 and ${t.periodStart} < ${t.periodEnd})`),
]);

// A person's decision on a proposal, append-only. The latest for a location and date stands,
// and it applies only while the evidence it was made on is still the current evidence.
export const demandContextDecisions = pgTable("demand_context_decisions", {
  id: uuid("id").primaryKey(),
  organisationId: uuid("organisation_id").notNull().references(() => organisations.id, { onDelete: "restrict" }),
  outletId: uuid("outlet_id").notNull().references(() => outlets.id, { onDelete: "restrict" }),
  targetDate: date("target_date", { mode: "string" }).notNull(),
  sequence: integer("sequence").notNull(),
  proposalId: uuid("proposal_id").notNull().references(() => demandContextProposals.id, { onDelete: "restrict" }),
  action: text("action").notNull(),
  scenario: text("scenario").notNull(),
  adjustmentBps: integer("adjustment_bps").notNull(),
  periodStart: integer("period_start"),
  periodEnd: integer("period_end"),
  policyVersion: text("policy_version").notNull(),
  inputFingerprint: text("input_fingerprint").notNull(),
  outputFingerprint: text("output_fingerprint").notNull(),
  signalIds: jsonb("signal_ids").notNull(),
  decidedBy: uuid("decided_by").notNull().references(() => users.id),
  decidedByRole: text("decided_by_role").notNull(),
  decidedAt: timestamp("decided_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("demand_context_decisions_sequence_unique").on(t.outletId, t.targetDate, t.sequence),
  index("demand_context_decisions_scope_idx").on(t.organisationId, t.outletId, t.targetDate),
  check("demand_context_decisions_action_check", sql`${t.action} in ('ACCEPTED', 'DISMISSED', 'WITHDRAWN')`),
  check("demand_context_decisions_scenario_check", sql`(${t.scenario} = 'NONE' and ${t.adjustmentBps} = 0) or (${t.scenario} = 'MINOR_UP' and ${t.adjustmentBps} = 500)
    or (${t.scenario} = 'MODERATE_UP' and ${t.adjustmentBps} = 1000) or (${t.scenario} = 'MINOR_DOWN' and ${t.adjustmentBps} = -500) or (${t.scenario} = 'MODERATE_DOWN' and ${t.adjustmentBps} = -1000)`),
  check("demand_context_decisions_role_check", sql`${t.decidedByRole} in ('OWNER', 'MANAGER')`),
]);

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

// The durable FairShift Pay Agent event for one work payable at one evidence version
// (DEC-SA-011), together with its processing journal. It is written in the same transaction
// as the manager's work confirmation (or a later performance confirmation), so confirmed work
// never loses its orchestration intent, and is processed only after that commit. One row per
// payable and evidence version. `status` follows an explicit state machine, and identity
// columns, decisions and manager resolutions are final; a database trigger enforces both
// (drizzle/0027_pay_agent_events.sql). Claims are atomic conditional updates fenced by
// `claim_token`. Nothing here holds an amount, currency, recipient or funding identity: those
// stay on the payable and its payout, resolved by the shared settlement engine.
export const payAgentEvents = pgTable("pay_agent_events", {
  id: uuid("id").primaryKey(),
  organisationId: uuid("organisation_id").notNull().references(() => organisations.id, { onDelete: "restrict" }),
  outletId: uuid("outlet_id").notNull().references(() => outlets.id, { onDelete: "restrict" }),
  payableId: uuid("payable_id").notNull().references(() => workPayables.id, { onDelete: "restrict" }),
  // SHA-256 of the persisted evidence fields listed in server/pay-agent/evidence.ts.
  evidenceVersion: text("evidence_version").notNull(),
  trigger: text("trigger").notNull(),
  createdBy: uuid("created_by").references(() => users.id),
  status: text("status").notNull(),
  // Authoritative reason for the current state (a block, skip, failure or settlement result).
  outcomeCode: text("outcome_code"),
  // Classified model/transport failure, never a raw provider message.
  errorClass: text("error_class"),
  attemptCount: integer("attempt_count").notNull().default(0),
  modelCallCount: integer("model_call_count").notNull().default(0),
  claimToken: uuid("claim_token"),
  claimedAt: timestamp("claimed_at", { withTimezone: true }),
  leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
  nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }),
  configuredModel: text("configured_model"),
  responseModel: text("response_model"),
  responseId: text("response_id"),
  // The validated model recommendation: SETTLE, or HOLD with a reason and short summary.
  decision: text("decision"),
  reasonCode: text("reason_code"),
  summary: text("summary"),
  // The model's verdict on each check (Day 6, Step 1g): {hours, overlap, timing, records}: OK | CONCERN.
  checks: jsonb("checks"),
  decidedAt: timestamp("decided_at", { withTimezone: true }),
  dryRun: boolean("dry_run"),
  payoutId: uuid("payout_id").references(() => workPayouts.id, { onDelete: "restrict" }),
  // A manager's release or rejection of a HOLD, by an existing Owner/Manager.
  resolution: text("resolution"),
  resolvedBy: uuid("resolved_by").references(() => users.id),
  resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  resolutionNote: text("resolution_note"),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("pay_agent_events_payable_version_unique").on(t.payableId, t.evidenceVersion),
  index("pay_agent_events_scope_idx").on(t.organisationId, t.outletId, t.payableId, t.createdAt),
  index("pay_agent_events_recovery_idx").on(t.status, t.nextAttemptAt),
  check("pay_agent_events_status_check", sql`${t.status} in ('PENDING', 'CLAIMED', 'SKIPPED', 'BLOCKED', 'REJECTED_OUTPUT', 'FAILED_RETRYABLE', 'FAILED_TERMINAL', 'DECIDED_SETTLE', 'DECIDED_HOLD', 'HOLD_RELEASED', 'HOLD_REJECTED', 'SETTLING', 'DRY_RUN_ELIGIBLE', 'SETTLEMENT_BLOCKED', 'SETTLEMENT_SUBMITTED')`),
  check("pay_agent_events_trigger_check", sql`${t.trigger} in ('WORK_CONFIRMED', 'PERFORMANCE_CONFIRMED', 'EVIDENCE_REFRESHED')`),
  check("pay_agent_events_version_check", sql`${t.evidenceVersion} ~ '^[0-9a-f]{64}$'`),
  check("pay_agent_events_counts_check", sql`${t.attemptCount} >= 0 and ${t.modelCallCount} >= 0 and ${t.modelCallCount} <= ${t.attemptCount}`),
  check("pay_agent_events_claim_check", sql`(${t.status} in ('CLAIMED', 'SETTLING')) = (${t.claimToken} is not null and ${t.leaseExpiresAt} is not null and ${t.claimedAt} is not null)`),
  check("pay_agent_events_outcome_check", sql`${t.status} in ('PENDING', 'CLAIMED', 'DECIDED_SETTLE', 'DECIDED_HOLD', 'HOLD_RELEASED', 'SETTLING') or ${t.outcomeCode} is not null`),
  check("pay_agent_events_error_check", sql`${t.status} not in ('REJECTED_OUTPUT', 'FAILED_RETRYABLE', 'FAILED_TERMINAL') or ${t.errorClass} is not null`),
  check("pay_agent_events_codes_check", sql`coalesce(char_length(${t.outcomeCode}), 0) <= 64 and coalesce(char_length(${t.errorClass}), 0) <= 64 and coalesce(char_length(${t.responseId}), 0) <= 200 and coalesce(char_length(${t.configuredModel}), 0) <= 100 and coalesce(char_length(${t.responseModel}), 0) <= 100`),
  check("pay_agent_events_decision_check", sql`(${t.decision} is null and ${t.reasonCode} is null and ${t.summary} is null and ${t.decidedAt} is null)
    or (${t.decision} = 'SETTLE' and ${t.reasonCode} is null and ${t.summary} is null and ${t.decidedAt} is not null)
    or (${t.decision} = 'HOLD' and ${t.reasonCode} in ('HOURS_MISMATCH', 'INCOMPLETE_EVIDENCE', 'CONFIRMATION_DELAY', 'CONFLICTING_RECORDS', 'OVERLAPPING_WORK') and char_length(${t.summary}) between 1 and 200 and ${t.decidedAt} is not null)`),
  check("pay_agent_events_decided_status_check", sql`(${t.status} not in ('DECIDED_HOLD', 'HOLD_RELEASED', 'HOLD_REJECTED') or ${t.decision} = 'HOLD') and (${t.status} <> 'DECIDED_SETTLE' or ${t.decision} = 'SETTLE')`),
  check("pay_agent_events_resolution_check", sql`(${t.resolution} is null and ${t.resolvedBy} is null and ${t.resolvedAt} is null and ${t.resolutionNote} is null)
    or (${t.resolution} = 'RELEASED' and ${t.decision} = 'HOLD' and ${t.resolvedBy} is not null and ${t.resolvedAt} is not null and coalesce(char_length(${t.resolutionNote}), 0) <= 500)
    or (${t.resolution} = 'REJECTED' and ${t.decision} = 'HOLD' and ${t.resolvedBy} is not null and ${t.resolvedAt} is not null and char_length(${t.resolutionNote}) between 1 and 500)`),
  check("pay_agent_events_resolved_status_check", sql`(${t.status} <> 'HOLD_RELEASED' or ${t.resolution} = 'RELEASED') and (${t.status} <> 'HOLD_REJECTED' or ${t.resolution} = 'REJECTED') and (${t.status} <> 'DECIDED_HOLD' or ${t.resolution} is null)`),
  check("pay_agent_events_payout_check", sql`(${t.status} = 'SETTLEMENT_SUBMITTED') = (${t.payoutId} is not null)`),
]);

// ECB euro foreign exchange reference rates for the ZAR->USD payout leg (DEC-SA-012, 7 Nov 2026).
// One row per ECB reference date, holding the two published quotes exactly as published and the
// derived ZAR-per-USD rate in micro-units (EUR/ZAR ÷ EUR/USD, rounded up to six decimals so the
// converted USD never exceeds the exact cross rate). A payout reservation copies the newest row's
// derived rate and freezes it; rows are never edited or deleted (drizzle/0028_fx_reference_rates.sql).
export const fxReferenceRates = pgTable("fx_reference_rates", {
  id: uuid("id").primaryKey(),
  rateDate: date("rate_date", { mode: "string" }).notNull(),
  eurZar: text("eur_zar").notNull(),
  eurUsd: text("eur_usd").notNull(),
  usdZarMicros: bigint("usd_zar_micros", { mode: "number" }).notNull(),
  // ECB_EUROFXREF_DAILY: fetched from the ECB daily reference-rate file.
  // OWNER_MANUAL: typed by the Sandbox demo organisation's Owner from the ECB publication.
  source: text("source").notNull(),
  recordedBy: uuid("recorded_by").references(() => users.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("fx_reference_rates_date_unique").on(t.rateDate),
  check("fx_reference_rates_quote_check", sql`${t.eurZar} ~ '^[0-9]{1,6}(\\.[0-9]{1,6})?$' and ${t.eurUsd} ~ '^[0-9]{1,6}(\\.[0-9]{1,6})?$' and ${t.eurZar}::numeric > 0 and ${t.eurUsd}::numeric > 0`),
  check("fx_reference_rates_micros_check", sql`${t.usdZarMicros} > 0 and ${t.usdZarMicros} = ceil(${t.eurZar}::numeric * 1000000 / ${t.eurUsd}::numeric)`),
  check("fx_reference_rates_source_check", sql`(${t.source} = 'ECB_EUROFXREF_DAILY') or (${t.source} = 'OWNER_MANUAL' and ${t.recordedBy} is not null)`),
]);

// ---------------------------------------------------------------------------------------------
// Permanent-staff tips (FS-TIP-DEC-002, FS-TIP-AGENT-DEC-001, Owner decisions 7 November 2026).
// Permanent staff are `workers` rows with worker_type REGULAR and no login. These tables hold the
// Owner's standing tip settings, the imported POS tip evidence, the deterministic allocations and
// their lines, the Pay Agent's tip journal, the append-only hold record and the staff statement
// links. Database triggers keep evidence, allocations, holds and decisions immutable
// (drizzle/0029_tip_release.sql).

// One standing policy per location, set by the Owner before a period's tips are imported.
export const tipLocationSettings = pgTable("tip_location_settings", {
  outletId: uuid("outlet_id").primaryKey().references(() => outlets.id, { onDelete: "restrict" }),
  organisationId: uuid("organisation_id").notNull().references(() => organisations.id, { onDelete: "restrict" }),
  policy: text("policy").notNull(),
  // Owner-set auto-release cap per staff member per local day, in the location's currency.
  autoReleaseCapMinor: bigint("auto_release_cap_minor", { mode: "number" }).notNull(),
  currencyCode: text("currency_code").notNull(),
  setBy: uuid("set_by").notNull().references(() => users.id),
  setAt: timestamp("set_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  check("tip_location_settings_policy_check", sql`${t.policy} in ('DIRECT', 'SHIFT_POOL')`),
  check("tip_location_settings_cap_check", sql`${t.autoReleaseCapMinor} between 1 and 9007199254740991 and ${t.currencyCode} ~ '^[A-Z]{3}$'`),
]);

// Shift blocks of a SHIFT_POOL location: [start, end) local minutes. Replaced as a set: old blocks
// are deactivated, never edited, because allocations keep their snapshot and reference.
export const tipShiftBlocks = pgTable("tip_shift_blocks", {
  id: uuid("id").primaryKey(),
  organisationId: uuid("organisation_id").notNull().references(() => organisations.id, { onDelete: "restrict" }),
  outletId: uuid("outlet_id").notNull().references(() => outlets.id, { onDelete: "restrict" }),
  name: text("name").notNull(),
  startMinute: integer("start_minute").notNull(),
  endMinute: integer("end_minute").notNull(),
  active: boolean("active").notNull().default(true),
  createdBy: uuid("created_by").notNull().references(() => users.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("tip_shift_blocks_outlet_idx").on(t.outletId, t.active),
  check("tip_shift_blocks_time_check", sql`${t.startMinute} >= 0 and ${t.endMinute} <= 1440 and ${t.startMinute} < ${t.endMinute}`),
  check("tip_shift_blocks_name_check", sql`char_length(${t.name}) between 1 and 40`),
]);

// The Owner's standing weekly block roster of permanent staff.
export const tipBlockRoster = pgTable("tip_block_roster", {
  id: uuid("id").primaryKey(),
  organisationId: uuid("organisation_id").notNull().references(() => organisations.id, { onDelete: "restrict" }),
  outletId: uuid("outlet_id").notNull().references(() => outlets.id, { onDelete: "restrict" }),
  workerId: uuid("worker_id").notNull().references(() => workers.id, { onDelete: "restrict" }),
  blockId: uuid("block_id").notNull().references(() => tipShiftBlocks.id, { onDelete: "restrict" }),
  isoWeekday: integer("iso_weekday").notNull(),
  createdBy: uuid("created_by").notNull().references(() => users.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("tip_block_roster_unique").on(t.workerId, t.blockId, t.isoWeekday),
  index("tip_block_roster_outlet_idx").on(t.outletId, t.isoWeekday),
  check("tip_block_roster_weekday_check", sql`${t.isoWeekday} between 1 and 7`),
]);

// One import of labelled POS tip evidence (synthetic demo CSV; never live POS data). The same file
// imported twice is the same import.
export const tipImports = pgTable("tip_imports", {
  id: uuid("id").primaryKey(),
  organisationId: uuid("organisation_id").notNull().references(() => organisations.id, { onDelete: "restrict" }),
  outletId: uuid("outlet_id").notNull().references(() => outlets.id, { onDelete: "restrict" }),
  label: text("label").notNull(),
  fileSha256: text("file_sha256").notNull(),
  // The location's policy when the tips were imported; every allocation of the import uses it.
  policy: text("policy").notNull(),
  rowCount: integer("row_count").notNull(),
  duplicateRowsSkipped: integer("duplicate_rows_skipped").notNull(),
  totalTipMinor: bigint("total_tip_minor", { mode: "number" }).notNull(),
  currencyCode: text("currency_code").notNull(),
  importedBy: uuid("imported_by").notNull().references(() => users.id),
  importedAt: timestamp("imported_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("tip_imports_file_unique").on(t.outletId, t.fileSha256),
  check("tip_imports_label_check", sql`${t.label} = 'IMPORTED_POS_EVIDENCE'`),
  check("tip_imports_policy_check", sql`${t.policy} in ('DIRECT', 'SHIFT_POOL')`),
  check("tip_imports_counts_check", sql`${t.rowCount} >= 0 and ${t.duplicateRowsSkipped} >= 0 and ${t.totalTipMinor} >= 0 and ${t.fileSha256} ~ '^[0-9a-f]{64}$'`),
]);

// One tip row of imported POS evidence, assigned exactly once: to one allocation, or left
// unallocated with its reason. A row reference is stored once per location and source, so a
// repeated row is never counted twice.
export const tipEvidenceRows = pgTable("tip_evidence_rows", {
  id: uuid("id").primaryKey(),
  organisationId: uuid("organisation_id").notNull().references(() => organisations.id, { onDelete: "restrict" }),
  outletId: uuid("outlet_id").notNull().references(() => outlets.id, { onDelete: "restrict" }),
  importId: uuid("import_id").notNull().references(() => tipImports.id, { onDelete: "restrict" }),
  source: text("source").notNull(),
  rowRef: text("row_ref").notNull(),
  transactionAt: timestamp("transaction_at", { withTimezone: true }).notNull(),
  localDate: date("local_date", { mode: "string" }).notNull(),
  staffRef: text("staff_ref"),
  // The staff member the POS row names, when the reference matches one at this location.
  workerId: uuid("worker_id").references(() => workers.id, { onDelete: "restrict" }),
  billMinor: bigint("bill_minor", { mode: "number" }).notNull(),
  tipMinor: bigint("tip_minor", { mode: "number" }).notNull(),
  currencyCode: text("currency_code").notNull(),
  blockId: uuid("block_id").references(() => tipShiftBlocks.id, { onDelete: "restrict" }),
  allocationId: uuid("allocation_id").references((): AnyPgColumn => tipAllocations.id, { onDelete: "restrict" }),
  // POOL: in a SHIFT_POOL block's pool. DIRECT: to the permanent staff member on the row.
  // CASUAL_SHIFT_PAY: a DIRECT row naming a casual worker, whose tips stay on shift pay.
  // UNATTRIBUTED / OUTSIDE_BLOCKS: unallocated and visible.
  disposition: text("disposition").notNull(),
  importedAt: timestamp("imported_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("tip_evidence_rows_ref_unique").on(t.outletId, t.source, t.rowRef),
  index("tip_evidence_rows_allocation_idx").on(t.allocationId),
  check("tip_evidence_rows_amount_check", sql`${t.billMinor} between 0 and 9007199254740991 and ${t.tipMinor} between 1 and 9007199254740991 and ${t.currencyCode} ~ '^[A-Z]{3}$'`),
  // An UNATTRIBUTED row of a DIRECT day belongs to that day's allocation as its unallocated part.
  check("tip_evidence_rows_disposition_check", sql`(${t.disposition} in ('POOL', 'DIRECT') and ${t.allocationId} is not null) or (${t.disposition} in ('CASUAL_SHIFT_PAY', 'OUTSIDE_BLOCKS') and ${t.allocationId} is null) or ${t.disposition} = 'UNATTRIBUTED'`),
]);

// One deterministic allocation: a SHIFT_POOL block's pool on one local date, or a DIRECT
// location's tips for one local date. Totals reconcile to the evidence to the cent.
export const tipAllocations = pgTable("tip_allocations", {
  id: uuid("id").primaryKey(),
  organisationId: uuid("organisation_id").notNull().references(() => organisations.id, { onDelete: "restrict" }),
  outletId: uuid("outlet_id").notNull().references(() => outlets.id, { onDelete: "restrict" }),
  importId: uuid("import_id").notNull().references(() => tipImports.id, { onDelete: "restrict" }),
  policy: text("policy").notNull(),
  localDate: date("local_date", { mode: "string" }).notNull(),
  // DAY for DIRECT; the block ID for SHIFT_POOL.
  blockKey: text("block_key").notNull(),
  blockId: uuid("block_id").references(() => tipShiftBlocks.id, { onDelete: "restrict" }),
  blockName: text("block_name"),
  blockStartMinute: integer("block_start_minute"),
  blockEndMinute: integer("block_end_minute"),
  totalTipMinor: bigint("total_tip_minor", { mode: "number" }).notNull(),
  allocatedMinor: bigint("allocated_minor", { mode: "number" }).notNull(),
  unallocatedMinor: bigint("unallocated_minor", { mode: "number" }).notNull(),
  currencyCode: text("currency_code").notNull(),
  evidenceVersion: text("evidence_version").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("tip_allocations_unique").on(t.importId, t.localDate, t.blockKey),
  index("tip_allocations_outlet_idx").on(t.outletId, t.localDate),
  check("tip_allocations_policy_check", sql`(${t.policy} = 'DIRECT' and ${t.blockKey} = 'DAY' and ${t.blockId} is null) or (${t.policy} = 'SHIFT_POOL' and ${t.blockId} is not null and ${t.blockKey} = ${t.blockId}::text and ${t.blockName} is not null)`),
  check("tip_allocations_totals_check", sql`${t.allocatedMinor} >= 0 and ${t.unallocatedMinor} >= 0 and ${t.totalTipMinor} = ${t.allocatedMinor} + ${t.unallocatedMinor}`),
  check("tip_allocations_version_check", sql`${t.evidenceVersion} ~ '^[0-9a-f]{64}$'`),
]);

// One staff member's share of an allocation. Release state is held by its payout and holds.
export const tipAllocationLines = pgTable("tip_allocation_lines", {
  id: uuid("id").primaryKey(),
  allocationId: uuid("allocation_id").notNull().references(() => tipAllocations.id, { onDelete: "restrict" }),
  organisationId: uuid("organisation_id").notNull().references(() => organisations.id, { onDelete: "restrict" }),
  outletId: uuid("outlet_id").notNull().references(() => outlets.id, { onDelete: "restrict" }),
  workerId: uuid("worker_id").notNull().references(() => workers.id, { onDelete: "restrict" }),
  workerType: text("worker_type").notNull(),
  // ROSTER (permanent staff on the block roster), CONFIRMED_SHIFT (casual with a confirmed shift
  // overlapping the block) or POS_ROW (DIRECT).
  membership: text("membership").notNull(),
  shareMinor: bigint("share_minor", { mode: "number" }).notNull(),
  currencyCode: text("currency_code").notNull(),
  localDate: date("local_date", { mode: "string" }).notNull(),
  // The last settlement-gate outcome (DRY_RUN_ELIGIBLE or a block code); not a financial fact.
  gateOutcome: text("gate_outcome"),
  gateCheckedAt: timestamp("gate_checked_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("tip_allocation_lines_unique").on(t.allocationId, t.workerId),
  index("tip_allocation_lines_worker_idx").on(t.workerId, t.localDate),
  check("tip_allocation_lines_share_check", sql`${t.shareMinor} between 0 and 9007199254740991 and ${t.currencyCode} ~ '^[A-Z]{3}$'`),
  check("tip_allocation_lines_type_check", sql`${t.workerType} in ('REGULAR', 'CASUAL') and ${t.membership} in ('ROSTER', 'CONFIRMED_SHIFT', 'POS_ROW')`),
]);

// The Pay Agent's tip journal (FS-TIP-AGENT-DEC-001): one event per allocation and evidence
// version, claimed and fenced like pay_agent_events. It holds no amount or recipient.
export const tipAgentEvents = pgTable("tip_agent_events", {
  id: uuid("id").primaryKey(),
  organisationId: uuid("organisation_id").notNull().references(() => organisations.id, { onDelete: "restrict" }),
  outletId: uuid("outlet_id").notNull().references(() => outlets.id, { onDelete: "restrict" }),
  allocationId: uuid("allocation_id").notNull().references(() => tipAllocations.id, { onDelete: "restrict" }),
  evidenceVersion: text("evidence_version").notNull(),
  createdBy: uuid("created_by").references(() => users.id),
  status: text("status").notNull(),
  outcomeCode: text("outcome_code"),
  errorClass: text("error_class"),
  attemptCount: integer("attempt_count").notNull().default(0),
  modelCallCount: integer("model_call_count").notNull().default(0),
  claimToken: uuid("claim_token"),
  claimedAt: timestamp("claimed_at", { withTimezone: true }),
  leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
  nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }),
  configuredModel: text("configured_model"),
  responseModel: text("response_model"),
  responseId: text("response_id"),
  decision: text("decision"),
  reasonCode: text("reason_code"),
  summary: text("summary"),
  decidedAt: timestamp("decided_at", { withTimezone: true }),
  dryRun: boolean("dry_run"),
  // The Owner who released a model hold; the settlement then runs on that authority.
  releasedBy: uuid("released_by").references(() => users.id),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("tip_agent_events_version_unique").on(t.allocationId, t.evidenceVersion),
  index("tip_agent_events_recovery_idx").on(t.status, t.nextAttemptAt),
  check("tip_agent_events_status_check", sql`${t.status} in ('PENDING', 'CLAIMED', 'SKIPPED', 'BLOCKED', 'REJECTED_OUTPUT', 'FAILED_RETRYABLE', 'FAILED_TERMINAL', 'DECIDED_RELEASE', 'DECIDED_HOLD', 'HOLD_RELEASED', 'SETTLING', 'SETTLED')`),
  check("tip_agent_events_claim_check", sql`(${t.status} in ('CLAIMED', 'SETTLING')) = (${t.claimToken} is not null and ${t.leaseExpiresAt} is not null and ${t.claimedAt} is not null)`),
  check("tip_agent_events_decision_check", sql`(${t.decision} is null and ${t.reasonCode} is null and ${t.summary} is null and ${t.decidedAt} is null)
    or (${t.decision} = 'RELEASE' and ${t.reasonCode} is null and ${t.summary} is null and ${t.decidedAt} is not null)
    or (${t.decision} = 'HOLD' and ${t.reasonCode} in ('UNATTRIBUTED_TIPS', 'INACTIVE_STAFF_ATTRIBUTION', 'TIP_OUTLIER', 'RECONCILIATION_GAP', 'DUPLICATE_ROWS', 'ROSTER_MISMATCH') and char_length(${t.summary}) between 1 and 200 and ${t.decidedAt} is not null)`),
  check("tip_agent_events_counts_check", sql`${t.attemptCount} >= 0 and ${t.modelCallCount} >= 0 and ${t.modelCallCount} <= ${t.attemptCount} and ${t.evidenceVersion} ~ '^[0-9a-f]{64}$'`),
  check("tip_agent_events_codes_check", sql`coalesce(char_length(${t.outcomeCode}), 0) <= 64 and coalesce(char_length(${t.errorClass}), 0) <= 64 and coalesce(char_length(${t.responseId}), 0) <= 200`),
]);

// Every tip hold, permanently (Owner requirement, 7 November 2026): the Pay Agent's reason code
// and summary, or the server's deterministic reason. Append-only: never edited or deleted.
export const tipHolds = pgTable("tip_holds", {
  id: uuid("id").primaryKey(),
  organisationId: uuid("organisation_id").notNull().references(() => organisations.id, { onDelete: "restrict" }),
  outletId: uuid("outlet_id").notNull().references(() => outlets.id, { onDelete: "restrict" }),
  allocationId: uuid("allocation_id").notNull().references(() => tipAllocations.id, { onDelete: "restrict" }),
  // Null: the whole allocation (a model hold). Set: one staff member's line (a server hold).
  lineId: uuid("line_id").references(() => tipAllocationLines.id, { onDelete: "restrict" }),
  tipAgentEventId: uuid("tip_agent_event_id").references(() => tipAgentEvents.id, { onDelete: "restrict" }),
  source: text("source").notNull(),
  reasonCode: text("reason_code").notNull(),
  summary: text("summary").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("tip_holds_allocation_idx").on(t.allocationId),
  check("tip_holds_source_check", sql`(${t.source} = 'MODEL' and ${t.lineId} is null and ${t.tipAgentEventId} is not null and ${t.reasonCode} in ('UNATTRIBUTED_TIPS', 'INACTIVE_STAFF_ATTRIBUTION', 'TIP_OUTLIER', 'RECONCILIATION_GAP', 'DUPLICATE_ROWS', 'ROSTER_MISMATCH'))
    or (${t.source} = 'DETERMINISTIC' and ${t.lineId} is not null and ${t.reasonCode} in ('AUTO_RELEASE_CAP_EXCEEDED', 'DESTINATION_RECENTLY_CHANGED'))`),
  check("tip_holds_summary_check", sql`char_length(${t.summary}) between 1 and 200`),
]);

// Every Owner decision on a hold, permanently: released as calculated, or kept held, by whom, when
// and why (a written reason is required). Append-only. A hold is released at most once.
export const tipHoldDecisions = pgTable("tip_hold_decisions", {
  id: uuid("id").primaryKey(),
  holdId: uuid("hold_id").notNull().references(() => tipHolds.id, { onDelete: "restrict" }),
  organisationId: uuid("organisation_id").notNull().references(() => organisations.id, { onDelete: "restrict" }),
  outletId: uuid("outlet_id").notNull().references(() => outlets.id, { onDelete: "restrict" }),
  decision: text("decision").notNull(),
  decidedBy: uuid("decided_by").notNull().references(() => users.id),
  decidedAt: timestamp("decided_at", { withTimezone: true }).notNull().defaultNow(),
  reason: text("reason").notNull(),
}, (t) => [
  index("tip_hold_decisions_hold_idx").on(t.holdId, t.decidedAt),
  uniqueIndex("tip_hold_decisions_release_unique").on(t.holdId).where(sql`${t.decision} = 'RELEASED'`),
  check("tip_hold_decisions_decision_check", sql`${t.decision} in ('RELEASED', 'KEPT_HELD')`),
  check("tip_hold_decisions_reason_check", sql`char_length(btrim(${t.reason})) between 1 and 500`),
]);

// A permanent staff member's statement link: a random token stored only as its SHA-256, bound to
// one organisation, location and staff record, with an explicit expiry. It opens a read-only
// statement; its destination confirmation or change can be used once.
export const staffStatementLinks = pgTable("staff_statement_links", {
  id: uuid("id").primaryKey(),
  organisationId: uuid("organisation_id").notNull().references(() => organisations.id, { onDelete: "restrict" }),
  outletId: uuid("outlet_id").notNull().references(() => outlets.id, { onDelete: "restrict" }),
  workerId: uuid("worker_id").notNull().references(() => workers.id, { onDelete: "restrict" }),
  tokenHash: text("token_hash").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdBy: uuid("created_by").notNull().references(() => users.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  destinationUsedAt: timestamp("destination_used_at", { withTimezone: true }),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
}, (t) => [
  uniqueIndex("staff_statement_links_token_unique").on(t.tokenHash),
  check("staff_statement_links_token_check", sql`${t.tokenHash} ~ '^[0-9a-f]{64}$' and ${t.expiresAt} > ${t.createdAt}`),
]);

// The payout-destination journal of a permanent staff member, without the address itself:
// RECORDED by the Owner, CONFIRMED or CHANGED by the staff member through a link. Append-only.
export const staffDestinationEvents = pgTable("staff_destination_events", {
  id: uuid("id").primaryKey(),
  organisationId: uuid("organisation_id").notNull().references(() => organisations.id, { onDelete: "restrict" }),
  workerId: uuid("worker_id").notNull().references(() => workers.id, { onDelete: "restrict" }),
  linkId: uuid("link_id").references(() => staffStatementLinks.id, { onDelete: "restrict" }),
  kind: text("kind").notNull(),
  recordedBy: uuid("recorded_by").references(() => users.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("staff_destination_events_worker_idx").on(t.workerId, t.createdAt),
  check("staff_destination_events_kind_check", sql`(${t.kind} = 'RECORDED' and ${t.recordedBy} is not null and ${t.linkId} is null) or (${t.kind} in ('CONFIRMED', 'CHANGED') and ${t.linkId} is not null)`),
]);

// An organisation-independent public feed (a country's public holidays, the ECB reference rate):
// its latest good payload and the state of its last fetch. A failed fetch changes only the attempt
// and failure fields, so the last good data stays and is shown with its age.
export const externalFeeds = pgTable("external_feeds", {
  feed: text("feed").primaryKey(),
  sourceUrl: text("source_url").notNull(),
  lastAttemptAt: timestamp("last_attempt_at", { withTimezone: true }).notNull(),
  lastSuccessAt: timestamp("last_success_at", { withTimezone: true }),
  lastFailureCode: text("last_failure_code"),
  payload: jsonb("payload").notNull().default({}),
}, t => [check("external_feeds_feed_check", sql`${t.feed} ~ '^(HOLIDAYS:[A-Z]{2}|ECB_EUROFXREF)$'`), check("external_feeds_source_check", sql`${t.sourceUrl} like 'https://%'`)]);

// Each scheduled job's last run, so a restart neither repeats a job that isn't due nor forgets one
// that is, and a lease so two servers never run one job at the same time.
export const scheduledJobs = pgTable("scheduled_jobs", {
  job: text("job").primaryKey(),
  leaseUntil: timestamp("lease_until", { withTimezone: true }),
  lastStartedAt: timestamp("last_started_at", { withTimezone: true }),
  lastFinishedAt: timestamp("last_finished_at", { withTimezone: true }),
  lastSuccessAt: timestamp("last_success_at", { withTimezone: true }),
  lastFailureCode: text("last_failure_code"),
  lastResult: jsonb("last_result").notNull().default({}),
});

// One local-intelligence model call for one location: what it was given (the location's public
// facts, never a person's details), the searches the provider recorded, every page it consulted, the
// coverage log for every category asked, and the response identifier. Recorded as RUNNING before the
// call, so an interrupted call still counts against the daily cap.
export const localIntelligenceRuns = pgTable("local_intelligence_runs", {
  id: uuid("id").primaryKey(),
  organisationId: uuid("organisation_id").notNull().references(() => organisations.id, { onDelete: "restrict" }),
  outletId: uuid("outlet_id").notNull().references(() => outlets.id, { onDelete: "restrict" }),
  kind: text("kind").notNull(),
  trigger: text("trigger").notNull(),
  requestedBy: uuid("requested_by").references(() => users.id),
  windowFrom: date("window_from", { mode: "string" }).notNull(),
  windowTo: date("window_to", { mode: "string" }).notNull(),
  status: text("status").notNull(),
  failureCode: text("failure_code"),
  policyVersion: text("policy_version").notNull(),
  outputVersion: text("output_version").notNull(),
  provider: text("provider").notNull(),
  model: text("model").notNull(),
  responseModel: text("response_model"),
  providerResponseId: text("provider_response_id"),
  input: jsonb("input").notNull(),
  coverage: jsonb("coverage").notNull().default([]),
  searches: jsonb("searches").notNull().default([]),
  consultedUrls: jsonb("consulted_urls").notNull().default([]),
  counts: jsonb("counts").notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
}, t => [
  index("local_intelligence_runs_scope_idx").on(t.organisationId, t.outletId, t.createdAt),
  check("local_intelligence_runs_kind_check", sql`${t.kind} in ('DAILY', 'DISRUPTIONS')`),
  check("local_intelligence_runs_trigger_check", sql`${t.trigger} in ('SCHEDULE', 'MANUAL')`),
  check("local_intelligence_runs_status_check", sql`(${t.status} = 'RUNNING' and ${t.failureCode} is null and ${t.completedAt} is null)
    or (${t.status} = 'COMPLETED' and ${t.failureCode} is null and ${t.completedAt} is not null)
    or (${t.status} = 'FAILED' and ${t.failureCode} is not null and ${t.completedAt} is not null)`),
  check("local_intelligence_runs_window_check", sql`${t.windowTo} >= ${t.windowFrom}`),
]);

// A signal as the model reported it and as FairShift judged it. Only ACCEPTED signals, with a source
// page FairShift reached (or that refused an automated check) and the search had opened, and a source
// tier other than UNCONFIRMED, can shape demand. Rows are evidence: never edited or deleted.
export const localIntelligenceSignals = pgTable("local_intelligence_signals", {
  id: uuid("id").primaryKey(),
  runId: uuid("run_id").notNull().references(() => localIntelligenceRuns.id, { onDelete: "restrict" }),
  organisationId: uuid("organisation_id").notNull().references(() => organisations.id, { onDelete: "restrict" }),
  outletId: uuid("outlet_id").notNull().references(() => outlets.id, { onDelete: "restrict" }),
  signalKey: text("signal_key").notNull(),
  status: text("status").notNull(),
  rejectionCode: text("rejection_code"),
  serverNote: text("server_note"),
  category: text("category").notNull(),
  otherLabel: text("other_label"),
  effectType: text("effect_type").notNull(),
  name: text("name").notNull(),
  validFrom: date("valid_from", { mode: "string" }).notNull(),
  validTo: date("valid_to", { mode: "string" }).notNull(),
  startMinute: integer("start_minute"),
  endMinute: integer("end_minute"),
  dateCertainty: text("date_certainty").notNull(),
  shiftBlocks: jsonb("shift_blocks").notNull().default([]),
  roles: jsonb("roles").notNull().default([]),
  direction: text("direction"),
  sizeBand: text("size_band"),
  severity: text("severity"),
  closureLikely: boolean("closure_likely").notNull().default(false),
  confidence: text("confidence").notNull(),
  sourceTier: text("source_tier").notNull(),
  reasoning: text("reasoning").notNull(),
  sourceUrl: text("source_url").notNull(),
  sourceTitle: text("source_title"),
  sourceCheck: text("source_check").notNull(),
  sourceHttpStatus: integer("source_http_status"),
  consultedInSearch: text("consulted_in_search").notNull(),
  impact: integer("impact").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, t => [
  index("local_intelligence_signals_run_idx").on(t.runId),
  index("local_intelligence_signals_scope_idx").on(t.organisationId, t.outletId, t.validTo),
  check("local_intelligence_signals_status_check", sql`(${t.status} in ('ACCEPTED', 'UNCONFIRMED') and ${t.rejectionCode} is null) or (${t.status} = 'REJECTED' and ${t.rejectionCode} is not null)`),
  check("local_intelligence_signals_source_check", sql`${t.status} <> 'ACCEPTED' or (${t.sourceUrl} like 'https://%' and ${t.sourceCheck} in ('REACHABLE', 'RESTRICTED') and ${t.consultedInSearch} in ('EXACT', 'SAME_SITE') and ${t.sourceTier} in ('OFFICIAL', 'EVENT_ORGANISER', 'NEWS'))`),
  check("local_intelligence_signals_effect_check", sql`${t.status} = 'REJECTED'
    or (${t.effectType} = 'DEMAND' and ${t.direction} in ('UP', 'DOWN') and ${t.sizeBand} in ('MINOR', 'MODERATE') and ${t.severity} is null and not ${t.closureLikely})
    or (${t.effectType} in ('CAPACITY', 'ACCESS') and ${t.direction} is null and ${t.sizeBand} is null and ${t.severity} in ('LOW', 'MEDIUM', 'HIGH') and (${t.effectType} = 'CAPACITY' or not ${t.closureLikely}))`),
  check("local_intelligence_signals_dates_check", sql`${t.status} = 'REJECTED' or ${t.validTo} >= ${t.validFrom}`),
  check("local_intelligence_signals_time_check", sql`(${t.startMinute} is null or (${t.startMinute} >= 0 and ${t.startMinute} <= 1440)) and (${t.endMinute} is null or (${t.endMinute} >= 0 and ${t.endMinute} <= 1440))`),
]);

// A person's choice whether staffing uses one day's AI-found adjustments, append-only. The latest
// for a location and date stands, and only while the adjustments it was made on are still current.
export const localIntelligenceDecisions = pgTable("local_intelligence_decisions", {
  id: uuid("id").primaryKey(),
  organisationId: uuid("organisation_id").notNull().references(() => organisations.id, { onDelete: "restrict" }),
  outletId: uuid("outlet_id").notNull().references(() => outlets.id, { onDelete: "restrict" }),
  targetDate: date("target_date", { mode: "string" }).notNull(),
  sequence: integer("sequence").notNull(),
  action: text("action").notNull(),
  adjustmentFingerprint: text("adjustment_fingerprint").notNull(),
  adjustments: jsonb("adjustments").notNull(),
  policyVersion: text("policy_version").notNull(),
  decidedBy: uuid("decided_by").notNull().references(() => users.id),
  decidedByRole: text("decided_by_role").notNull(),
  decidedAt: timestamp("decided_at", { withTimezone: true }).notNull().defaultNow(),
}, t => [
  uniqueIndex("local_intelligence_decisions_sequence_unique").on(t.outletId, t.targetDate, t.sequence),
  index("local_intelligence_decisions_scope_idx").on(t.organisationId, t.outletId, t.targetDate),
  check("local_intelligence_decisions_action_check", sql`${t.action} in ('ACCEPTED', 'WITHDRAWN')`),
  check("local_intelligence_decisions_role_check", sql`${t.decidedByRole} in ('OWNER', 'MANAGER')`),
  check("local_intelligence_decisions_fingerprint_check", sql`${t.adjustmentFingerprint} ~ '^[0-9a-f]{64}$'`),
]);

// A person's choice to set one AI-found demand signal aside (or bring it back), append-only. The latest
// row for a location and signal key stands. A dismissed signal moves no demand; the day's adjustments are
// worked out again without it, so an earlier acceptance of that day no longer matches.
export const localIntelligenceSignalDecisions = pgTable("local_intelligence_signal_decisions", {
  id: uuid("id").primaryKey(),
  organisationId: uuid("organisation_id").notNull().references(() => organisations.id, { onDelete: "restrict" }),
  outletId: uuid("outlet_id").notNull().references(() => outlets.id, { onDelete: "restrict" }),
  signalKey: text("signal_key").notNull(),
  signalId: uuid("signal_id").notNull().references(() => localIntelligenceSignals.id, { onDelete: "restrict" }),
  action: text("action").notNull(),
  decidedBy: uuid("decided_by").notNull().references(() => users.id),
  decidedByRole: text("decided_by_role").notNull(),
  decidedAt: timestamp("decided_at", { withTimezone: true }).notNull().defaultNow(),
}, t => [
  index("local_intelligence_signal_decisions_scope_idx").on(t.organisationId, t.outletId, t.signalKey, t.decidedAt),
  check("local_intelligence_signal_decisions_action_check", sql`${t.action} in ('DISMISSED', 'RESTORED')`),
  check("local_intelligence_signal_decisions_role_check", sql`${t.decidedByRole} in ('OWNER', 'MANAGER')`),
]);

// The AI signal track record: one accepted demand signal on one completed day, its predicted direction
// against what happened in the hours it covered. Here measured against synthetic reference history,
// which has no real-world events in it. Rows are evidence: never edited or deleted.
export const localIntelligenceOutcomes = pgTable("local_intelligence_outcomes", {
  id: uuid("id").primaryKey(),
  organisationId: uuid("organisation_id").notNull().references(() => organisations.id, { onDelete: "restrict" }),
  outletId: uuid("outlet_id").notNull().references(() => outlets.id, { onDelete: "restrict" }),
  signalId: uuid("signal_id").notNull().references(() => localIntelligenceSignals.id, { onDelete: "restrict" }),
  signalKey: text("signal_key").notNull(),
  targetDate: date("target_date", { mode: "string" }).notNull(),
  predictedDirection: text("predicted_direction").notNull(),
  sizeBand: text("size_band").notNull(),
  baselineMilliTransactions: integer("baseline_milli_transactions").notNull(),
  actualMilliTransactions: integer("actual_milli_transactions").notNull(),
  actualDirection: text("actual_direction").notNull(),
  matched: boolean("matched").notNull(),
  measuredAgainst: text("measured_against").notNull(),
  method: text("method").notNull(),
  recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull().defaultNow(),
}, t => [
  uniqueIndex("local_intelligence_outcomes_unique").on(t.outletId, t.signalKey, t.targetDate),
  index("local_intelligence_outcomes_scope_idx").on(t.organisationId, t.outletId, t.targetDate),
  check("local_intelligence_outcomes_direction_check", sql`${t.predictedDirection} in ('UP', 'DOWN') and ${t.actualDirection} in ('UP', 'DOWN', 'FLAT') and ${t.matched} = (${t.predictedDirection} = ${t.actualDirection})`),
  check("local_intelligence_outcomes_source_check", sql`${t.measuredAgainst} = 'SYNTHETIC_REFERENCE'`),
  check("local_intelligence_outcomes_counts_check", sql`${t.baselineMilliTransactions} >= 0 and ${t.actualMilliTransactions} >= 0`),
]);

export const schema = {
  fxReferenceRates,
  externalFeeds, scheduledJobs, localIntelligenceRuns, localIntelligenceSignals, localIntelligenceDecisions, localIntelligenceOutcomes,
  users, sessions, identityTokens, authLimits, memberships, subscriptions, subscriptionEvents, notifications, notificationDeliveries,
  organisations,
  outlets,
  paypalConnections,
  saleTransactions,
  commerceConnections,
  commerceSyncRuns,
  commercePaymentEvidence,
  commerceRefundEvidence,
  commerceWorkerIdentities,
  providerEvents,
  tipLocationSettings, tipShiftBlocks, tipBlockRoster, tipImports, tipEvidenceRows, tipAllocations, tipAllocationLines, tipAgentEvents, tipHolds, tipHoldDecisions, staffStatementLinks, staffDestinationEvents,
  workers, workerAvailability, regularStaffCoverage, labourPolicies, workloadPolicies, outletTradingHours, regularCoverageWindows,
  departments, workPolicies, teamInvitations, workAcceptances, workAllocations, workPayables, workPayouts, aiStaffingAssessments, demandContextSignals, demandContextFeeds, demandContextProposals, demandContextDecisions, attributedSales, workPerformanceResults,
  shifts,
  shiftOpportunityEvidence,
  shiftOffers,
  shiftIncentives,
  auditEvents,
  payAgentEvents,
};

// A location's shift-length rules and offer-round window (Owner decisions, 9 November 2026), as dated
// versions: the latest stands, earlier ones stay as the record. Suggested shifts are cut from the
// casual gap with these; the first offer round closes after firstRoundMinutes, or firstRoundCutoffMinutes
// before the shift starts if that is sooner. No default: a location without rules gets no suggestions.
export const locationShiftRules = pgTable("location_shift_rules", {
  id: uuid("id").primaryKey(),
  organisationId: uuid("organisation_id").notNull().references(() => organisations.id, { onDelete: "restrict" }),
  outletId: uuid("outlet_id").notNull().references(() => outlets.id, { onDelete: "restrict" }),
  minMinutes: integer("min_minutes").notNull(),
  maxMinutes: integer("max_minutes").notNull(),
  preferredMinutes: integer("preferred_minutes").notNull(),
  firstRoundMinutes: integer("first_round_minutes").notNull(),
  firstRoundCutoffMinutes: integer("first_round_cutoff_minutes").notNull(),
  source: text("source").notNull(),
  createdBy: uuid("created_by").references(() => users.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, t => [
  index("location_shift_rules_scope_idx").on(t.organisationId, t.outletId, t.createdAt),
  check("location_shift_rules_lengths_check", sql`${t.minMinutes} >= 60 and ${t.minMinutes} <= ${t.preferredMinutes} and ${t.preferredMinutes} <= ${t.maxMinutes} and ${t.maxMinutes} <= 960 and ${t.minMinutes} % 15 = 0 and ${t.maxMinutes} % 15 = 0 and ${t.preferredMinutes} % 15 = 0`),
  check("location_shift_rules_round_check", sql`${t.firstRoundMinutes} >= 0 and ${t.firstRoundCutoffMinutes} >= 0`),
  check("location_shift_rules_source_check", sql`${t.source} in ('OWNER', 'DEMO_SEED')`),
]);

// A business's guaranteed-hours alert (FS-PATHWAY-DEC-001; Owner decision, 9 November 2026): the Owner is
// alerted when a casual worker averages weeklyThresholdMinutes or more over referenceWeeks. FairShift only
// alerts. The same figure orders the first offer round: fewest hours left to it first. Dated versions.
export const organisationHoursRules = pgTable("organisation_hours_rules", {
  id: uuid("id").primaryKey(),
  organisationId: uuid("organisation_id").notNull().references(() => organisations.id, { onDelete: "restrict" }),
  weeklyThresholdMinutes: integer("weekly_threshold_minutes").notNull(),
  referenceWeeks: integer("reference_weeks").notNull(),
  source: text("source").notNull(),
  createdBy: uuid("created_by").references(() => users.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, t => [
  index("organisation_hours_rules_scope_idx").on(t.organisationId, t.createdAt),
  check("organisation_hours_rules_values_check", sql`${t.weeklyThresholdMinutes} > 0 and ${t.weeklyThresholdMinutes} <= 4800 and ${t.referenceWeeks} between 1 and 52`),
  check("organisation_hours_rules_source_check", sql`${t.source} in ('OWNER', 'DEMO_SEED')`),
]);

// One offer round for a shift (FS-OFFER-ORDER-DEC-001): who it went to, why, and until when. Round 1 goes
// to eligible workers who want more hours, fewest hours left to the threshold first; round 2 to every
// other eligible worker at the location, open until the shift is filled. A record: never edited.
export const offerRounds = pgTable("offer_rounds", {
  id: uuid("id").primaryKey(),
  organisationId: uuid("organisation_id").notNull().references(() => organisations.id, { onDelete: "restrict" }),
  outletId: uuid("outlet_id").notNull().references(() => outlets.id, { onDelete: "restrict" }),
  shiftId: uuid("shift_id").notNull().references(() => shifts.id, { onDelete: "restrict" }),
  round: integer("round").notNull(),
  openedAt: timestamp("opened_at", { withTimezone: true }).notNull(),
  closesAt: timestamp("closes_at", { withTimezone: true }),
  criteria: text("criteria").notNull(),
  offers: jsonb("offers").notNull(),
  openedBy: uuid("opened_by").references(() => users.id),
}, t => [
  uniqueIndex("offer_rounds_shift_round_unique").on(t.shiftId, t.round),
  index("offer_rounds_scope_idx").on(t.organisationId, t.outletId, t.openedAt),
  check("offer_rounds_round_check", sql`${t.round} in (1, 2)`),
]);
