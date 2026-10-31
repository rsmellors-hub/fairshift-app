CREATE TABLE "commerce_connections" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organisation_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"status" text NOT NULL,
	"provider_merchant_id" text NOT NULL,
	"sealed_credentials" text,
	"connected_by" uuid,
	"connected_at" timestamp with time zone NOT NULL,
	"disconnected_at" timestamp with time zone,
	CONSTRAINT "commerce_connections_provider_check" CHECK ("commerce_connections"."provider" in ('ZETTLE')),
	CONSTRAINT "commerce_connections_status_check" CHECK ("commerce_connections"."status" in ('CONNECTED', 'AUTH_FAILED', 'DISCONNECTED')),
	CONSTRAINT "commerce_connections_credentials_check" CHECK (("commerce_connections"."status" = 'DISCONNECTED') = ("commerce_connections"."sealed_credentials" is null))
);
--> statement-breakpoint
CREATE TABLE "commerce_sync_runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"connection_id" uuid NOT NULL,
	"status" text NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"retrieved" integer,
	"inserted" integer,
	"duplicates" integer,
	"refunds_excluded" integer,
	"failure_code" text,
	"started_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "commerce_sync_runs_status_check" CHECK ("commerce_sync_runs"."status" in ('RUNNING', 'SUCCEEDED', 'FAILED')),
	CONSTRAINT "commerce_sync_runs_outcome_check" CHECK (("commerce_sync_runs"."status" = 'FAILED') = ("commerce_sync_runs"."failure_code" is not null))
);
--> statement-breakpoint
ALTER TABLE "sale_transactions" DROP CONSTRAINT "sale_transactions_source_check";--> statement-breakpoint
ALTER TABLE "commerce_connections" ADD CONSTRAINT "commerce_connections_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commerce_connections" ADD CONSTRAINT "commerce_connections_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commerce_connections" ADD CONSTRAINT "commerce_connections_connected_by_auth_users_id_fk" FOREIGN KEY ("connected_by") REFERENCES "public"."auth_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commerce_sync_runs" ADD CONSTRAINT "commerce_sync_runs_connection_id_commerce_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."commerce_connections"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "commerce_connections_live_outlet_unique" ON "commerce_connections" USING btree ("outlet_id") WHERE "commerce_connections"."status" != 'DISCONNECTED';--> statement-breakpoint
CREATE UNIQUE INDEX "commerce_connections_live_merchant_unique" ON "commerce_connections" USING btree ("provider","provider_merchant_id") WHERE "commerce_connections"."status" != 'DISCONNECTED';--> statement-breakpoint
CREATE UNIQUE INDEX "commerce_sync_runs_one_running_unique" ON "commerce_sync_runs" USING btree ("connection_id") WHERE "commerce_sync_runs"."status" = 'RUNNING';--> statement-breakpoint
CREATE INDEX "commerce_sync_runs_connection_started_idx" ON "commerce_sync_runs" USING btree ("connection_id","started_at");--> statement-breakpoint
ALTER TABLE "sale_transactions" ADD CONSTRAINT "sale_transactions_zettle_provenance_check" CHECK ("sale_transactions"."source" != 'ZETTLE' or (
      "sale_transactions"."paypal_order_id" is null and "sale_transactions"."paypal_capture_id" is null and
      "sale_transactions"."paypal_custom_id" is null and "sale_transactions"."provider_created_at" is null and
      "sale_transactions"."provider_updated_at" is null and "sale_transactions"."reconciled_at" is null and
      "sale_transactions"."verification_state" = 'PENDING' and "sale_transactions"."reconciliation_state" = 'NOT_RECONCILED' and
      "sale_transactions"."provider_status" = 'ZETTLE' and "sale_transactions"."occurred_at" is not null and
      "sale_transactions"."source_system" is not null and "sale_transactions"."source_transaction_id" is not null
    ));--> statement-breakpoint
ALTER TABLE "sale_transactions" ADD CONSTRAINT "sale_transactions_source_check" CHECK ("sale_transactions"."source" in ('PAYPAL_SANDBOX', 'DEMO_SEEDED', 'REFERENCE', 'IMPORTED', 'ZETTLE'));