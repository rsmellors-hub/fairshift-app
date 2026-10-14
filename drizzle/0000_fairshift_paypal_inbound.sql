CREATE TABLE "audit_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organisation_id" uuid,
	"outlet_id" uuid,
	"action" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" text,
	"correlation_id" text NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "organisations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "outlets" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organisation_id" uuid NOT NULL,
	"name" text NOT NULL,
	"timezone" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "paypal_connections" (
	"id" uuid PRIMARY KEY NOT NULL,
	"outlet_id" uuid NOT NULL,
	"environment" text NOT NULL,
	"status" text DEFAULT 'NOT_CONFIGURED' NOT NULL,
	"merchant_id" text,
	"last_checked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "paypal_connections_sandbox_only" CHECK ("paypal_connections"."environment" = 'sandbox'),
	CONSTRAINT "paypal_connections_status_check" CHECK ("paypal_connections"."status" in ('NOT_CONFIGURED', 'CONNECTED', 'ERROR'))
);
--> statement-breakpoint
CREATE TABLE "provider_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"provider_event_id" text NOT NULL,
	"event_type" text NOT NULL,
	"payload_sha256" text NOT NULL,
	"paypal_order_id" text,
	"paypal_capture_id" text,
	"currency_code" text,
	"gross_amount_minor" bigint,
	"provider_status" text,
	"verification_status" text NOT NULL,
	"processing_state" text DEFAULT 'RECEIVED' NOT NULL,
	"sale_transaction_id" uuid,
	"provider_created_at" timestamp with time zone,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "provider_events_verification_check" CHECK ("provider_events"."verification_status" = 'VERIFIED'),
	CONSTRAINT "provider_events_processing_check" CHECK ("provider_events"."processing_state" in ('RECEIVED', 'PROCESSED', 'IGNORED', 'UNMATCHED', 'ERROR'))
);
--> statement-breakpoint
CREATE TABLE "sale_transactions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"internal_reference" text NOT NULL,
	"outlet_id" uuid NOT NULL,
	"paypal_order_id" text,
	"paypal_capture_id" text,
	"paypal_custom_id" text NOT NULL,
	"currency_code" text NOT NULL,
	"gross_amount_minor" bigint NOT NULL,
	"provider_status" text DEFAULT 'CREATED' NOT NULL,
	"reconciliation_state" text DEFAULT 'NOT_RECONCILED' NOT NULL,
	"verification_state" text DEFAULT 'PENDING' NOT NULL,
	"provider_created_at" timestamp with time zone,
	"provider_updated_at" timestamp with time zone,
	"reconciled_at" timestamp with time zone,
	"failure_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sale_transactions_currency_code_check" CHECK (char_length("sale_transactions"."currency_code") = 3),
	CONSTRAINT "sale_transactions_amount_nonnegative" CHECK ("sale_transactions"."gross_amount_minor" >= 0),
	CONSTRAINT "sale_transactions_reconciliation_state_check" CHECK ("sale_transactions"."reconciliation_state" in ('NOT_RECONCILED', 'PENDING', 'RECONCILED', 'ERROR')),
	CONSTRAINT "sale_transactions_verification_state_check" CHECK ("sale_transactions"."verification_state" in ('PENDING', 'VERIFIED', 'FAILED'))
);
--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outlets" ADD CONSTRAINT "outlets_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paypal_connections" ADD CONSTRAINT "paypal_connections_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_events" ADD CONSTRAINT "provider_events_sale_transaction_id_sale_transactions_id_fk" FOREIGN KEY ("sale_transaction_id") REFERENCES "public"."sale_transactions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sale_transactions" ADD CONSTRAINT "sale_transactions_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_events_scope_created_idx" ON "audit_events" USING btree ("organisation_id","outlet_id","created_at");--> statement-breakpoint
CREATE INDEX "outlets_organisation_idx" ON "outlets" USING btree ("organisation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "paypal_connections_outlet_unique" ON "paypal_connections" USING btree ("outlet_id");--> statement-breakpoint
CREATE UNIQUE INDEX "provider_events_provider_event_unique" ON "provider_events" USING btree ("provider_event_id");--> statement-breakpoint
CREATE INDEX "provider_events_capture_idx" ON "provider_events" USING btree ("paypal_capture_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sale_transactions_internal_reference_unique" ON "sale_transactions" USING btree ("internal_reference");--> statement-breakpoint
CREATE UNIQUE INDEX "sale_transactions_paypal_order_unique" ON "sale_transactions" USING btree ("paypal_order_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sale_transactions_paypal_capture_unique" ON "sale_transactions" USING btree ("paypal_capture_id");--> statement-breakpoint
CREATE INDEX "sale_transactions_outlet_created_idx" ON "sale_transactions" USING btree ("outlet_id","created_at");--> statement-breakpoint
INSERT INTO "organisations" ("id", "name")
VALUES ('10000000-0000-4000-8000-000000000001', 'FairShift Demo Organisation')
ON CONFLICT ("id") DO NOTHING;--> statement-breakpoint
INSERT INTO "outlets" ("id", "organisation_id", "name", "timezone")
VALUES (
	'20000000-0000-4000-8000-000000000001',
	'10000000-0000-4000-8000-000000000001',
	'Rosebank Kitchen',
	'Africa/Johannesburg'
)
ON CONFLICT ("id") DO NOTHING;--> statement-breakpoint
INSERT INTO "paypal_connections" ("id", "outlet_id", "environment", "status")
VALUES (
	'30000000-0000-4000-8000-000000000001',
	'20000000-0000-4000-8000-000000000001',
	'sandbox',
	'NOT_CONFIGURED'
)
ON CONFLICT ("id") DO NOTHING;
