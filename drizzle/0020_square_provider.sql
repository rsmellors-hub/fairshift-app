CREATE TABLE "commerce_payment_evidence" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organisation_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"sale_transaction_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"provider_payment_id" text NOT NULL,
	"provider_location_id" text NOT NULL,
	"provider_status" text NOT NULL,
	"provider_team_member_id" text,
	CONSTRAINT "commerce_payment_evidence_provider_check" CHECK ("commerce_payment_evidence"."provider" in ('SQUARE')),
	CONSTRAINT "commerce_payment_evidence_status_check" CHECK ("commerce_payment_evidence"."provider_status" = 'COMPLETED')
);
--> statement-breakpoint
CREATE TABLE "commerce_refund_evidence" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organisation_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"provider_refund_id" text NOT NULL,
	"provider_payment_id" text NOT NULL,
	"provider_status" text NOT NULL,
	"amount_minor" bigint NOT NULL,
	"currency_code" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	CONSTRAINT "commerce_refund_evidence_provider_check" CHECK ("commerce_refund_evidence"."provider" in ('SQUARE')),
	CONSTRAINT "commerce_refund_evidence_amount_check" CHECK ("commerce_refund_evidence"."amount_minor" >= 0 and "commerce_refund_evidence"."amount_minor" <= 9007199254740991)
);
--> statement-breakpoint
CREATE TABLE "commerce_worker_identities" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organisation_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"worker_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"provider_merchant_id" text NOT NULL,
	"provider_team_member_id" text NOT NULL,
	"status" text NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone NOT NULL,
	"removed_by" uuid,
	"removed_at" timestamp with time zone,
	CONSTRAINT "commerce_worker_identities_provider_check" CHECK ("commerce_worker_identities"."provider" in ('SQUARE')),
	CONSTRAINT "commerce_worker_identities_status_check" CHECK ("commerce_worker_identities"."status" in ('ACTIVE', 'REMOVED')),
	CONSTRAINT "commerce_worker_identities_removal_check" CHECK (("commerce_worker_identities"."status" = 'REMOVED') = ("commerce_worker_identities"."removed_at" is not null))
);
--> statement-breakpoint
ALTER TABLE "commerce_connections" DROP CONSTRAINT "commerce_connections_provider_check";--> statement-breakpoint
ALTER TABLE "sale_transactions" DROP CONSTRAINT "sale_transactions_source_check";--> statement-breakpoint
ALTER TABLE "work_performance_results" DROP CONSTRAINT "work_performance_results_provenance_check";--> statement-breakpoint
ALTER TABLE "commerce_connections" ADD COLUMN "provider_location_id" text;--> statement-breakpoint
ALTER TABLE "commerce_connections" ADD COLUMN "provider_environment" text;--> statement-breakpoint
ALTER TABLE "commerce_payment_evidence" ADD CONSTRAINT "commerce_payment_evidence_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commerce_payment_evidence" ADD CONSTRAINT "commerce_payment_evidence_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commerce_payment_evidence" ADD CONSTRAINT "commerce_payment_evidence_connection_id_commerce_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."commerce_connections"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commerce_payment_evidence" ADD CONSTRAINT "commerce_payment_evidence_sale_transaction_id_sale_transactions_id_fk" FOREIGN KEY ("sale_transaction_id") REFERENCES "public"."sale_transactions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commerce_refund_evidence" ADD CONSTRAINT "commerce_refund_evidence_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commerce_refund_evidence" ADD CONSTRAINT "commerce_refund_evidence_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commerce_refund_evidence" ADD CONSTRAINT "commerce_refund_evidence_connection_id_commerce_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."commerce_connections"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commerce_worker_identities" ADD CONSTRAINT "commerce_worker_identities_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commerce_worker_identities" ADD CONSTRAINT "commerce_worker_identities_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commerce_worker_identities" ADD CONSTRAINT "commerce_worker_identities_worker_id_workers_id_fk" FOREIGN KEY ("worker_id") REFERENCES "public"."workers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commerce_worker_identities" ADD CONSTRAINT "commerce_worker_identities_created_by_auth_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."auth_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commerce_worker_identities" ADD CONSTRAINT "commerce_worker_identities_removed_by_auth_users_id_fk" FOREIGN KEY ("removed_by") REFERENCES "public"."auth_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "commerce_payment_evidence_payment_unique" ON "commerce_payment_evidence" USING btree ("outlet_id","provider","provider_payment_id");--> statement-breakpoint
CREATE UNIQUE INDEX "commerce_payment_evidence_sale_unique" ON "commerce_payment_evidence" USING btree ("sale_transaction_id");--> statement-breakpoint
CREATE UNIQUE INDEX "commerce_refund_evidence_refund_unique" ON "commerce_refund_evidence" USING btree ("outlet_id","provider","provider_refund_id");--> statement-breakpoint
CREATE INDEX "commerce_refund_evidence_payment_idx" ON "commerce_refund_evidence" USING btree ("outlet_id","provider_payment_id");--> statement-breakpoint
CREATE UNIQUE INDEX "commerce_worker_identities_live_identity_unique" ON "commerce_worker_identities" USING btree ("provider","provider_merchant_id","provider_team_member_id") WHERE "commerce_worker_identities"."status" = 'ACTIVE';--> statement-breakpoint
CREATE UNIQUE INDEX "commerce_worker_identities_live_worker_unique" ON "commerce_worker_identities" USING btree ("outlet_id","provider","worker_id") WHERE "commerce_worker_identities"."status" = 'ACTIVE';--> statement-breakpoint
ALTER TABLE "commerce_connections" ADD CONSTRAINT "commerce_connections_square_binding_check" CHECK ("commerce_connections"."provider" != 'SQUARE' or ("commerce_connections"."provider_location_id" is not null and "commerce_connections"."provider_environment" = 'SANDBOX'));--> statement-breakpoint
ALTER TABLE "commerce_connections" ADD CONSTRAINT "commerce_connections_provider_check" CHECK ("commerce_connections"."provider" in ('ZETTLE', 'SQUARE'));--> statement-breakpoint
ALTER TABLE "sale_transactions" ADD CONSTRAINT "sale_transactions_square_provenance_check" CHECK ("sale_transactions"."source" != 'SQUARE' or (
      "sale_transactions"."paypal_order_id" is null and "sale_transactions"."paypal_capture_id" is null and
      "sale_transactions"."paypal_custom_id" is null and "sale_transactions"."provider_created_at" is null and
      "sale_transactions"."provider_updated_at" is null and "sale_transactions"."reconciled_at" is null and
      "sale_transactions"."verification_state" = 'PENDING' and "sale_transactions"."reconciliation_state" = 'NOT_RECONCILED' and
      "sale_transactions"."provider_status" = 'SQUARE' and "sale_transactions"."occurred_at" is not null and
      "sale_transactions"."source_system" is not null and "sale_transactions"."source_transaction_id" is not null
    ));--> statement-breakpoint
ALTER TABLE "sale_transactions" ADD CONSTRAINT "sale_transactions_source_check" CHECK ("sale_transactions"."source" in ('PAYPAL_SANDBOX', 'DEMO_SEEDED', 'REFERENCE', 'IMPORTED', 'ZETTLE', 'SQUARE'));--> statement-breakpoint
ALTER TABLE "work_performance_results" ADD CONSTRAINT "work_performance_results_provenance_check" CHECK ("work_performance_results"."evidence_provenance" in ('IMPORTED_NOT_PROVIDER_VERIFIED', 'SQUARE_TEAM_MEMBER'));