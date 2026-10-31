CREATE TABLE "labour_policies" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organisation_id" uuid NOT NULL,
	"outlet_id" uuid,
	"version" integer NOT NULL,
	"currency_code" text NOT NULL,
	"sales_minor_per_labour_hour" bigint NOT NULL,
	"source" text NOT NULL,
	"status" text DEFAULT 'ACTIVE' NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"superseded_at" timestamp with time zone,
	CONSTRAINT "labour_policies_rate_check" CHECK ("labour_policies"."sales_minor_per_labour_hour" between 1 and 10000000),
	CONSTRAINT "labour_policies_currency_check" CHECK ("labour_policies"."currency_code" ~ '^[A-Z]{3}$'),
	CONSTRAINT "labour_policies_version_check" CHECK ("labour_policies"."version" > 0),
	CONSTRAINT "labour_policies_source_check" CHECK ("labour_policies"."source" in ('CONFIGURED', 'REFERENCE')),
	CONSTRAINT "labour_policies_status_check" CHECK (("labour_policies"."status" = 'ACTIVE' and "labour_policies"."superseded_at" is null) or ("labour_policies"."status" = 'SUPERSEDED' and "labour_policies"."superseded_at" is not null))
);
--> statement-breakpoint
ALTER TABLE "regular_staff_coverage" DROP CONSTRAINT "regular_staff_coverage_source_check";--> statement-breakpoint
ALTER TABLE "sale_transactions" DROP CONSTRAINT "sale_transactions_source_check";--> statement-breakpoint
ALTER TABLE "sale_transactions" ADD COLUMN "source_system" text;--> statement-breakpoint
ALTER TABLE "sale_transactions" ADD COLUMN "source_transaction_id" text;--> statement-breakpoint
ALTER TABLE "labour_policies" ADD CONSTRAINT "labour_policies_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "labour_policies" ADD CONSTRAINT "labour_policies_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "labour_policies" ADD CONSTRAINT "labour_policies_created_by_auth_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."auth_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "labour_policies_active_organisation_unique" ON "labour_policies" USING btree ("organisation_id") WHERE "labour_policies"."status" = 'ACTIVE' and "labour_policies"."outlet_id" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "labour_policies_active_location_unique" ON "labour_policies" USING btree ("outlet_id") WHERE "labour_policies"."status" = 'ACTIVE' and "labour_policies"."outlet_id" is not null;--> statement-breakpoint
CREATE INDEX "labour_policies_organisation_idx" ON "labour_policies" USING btree ("organisation_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "sale_transactions_source_identity_unique" ON "sale_transactions" USING btree ("outlet_id","source","source_system","source_transaction_id") WHERE "sale_transactions"."source_transaction_id" is not null;--> statement-breakpoint
ALTER TABLE "regular_staff_coverage" ADD CONSTRAINT "regular_staff_coverage_source_check" CHECK ("regular_staff_coverage"."source" in ('REFERENCE', 'CONFIGURED'));--> statement-breakpoint
ALTER TABLE "sale_transactions" ADD CONSTRAINT "sale_transactions_imported_provenance_check" CHECK ("sale_transactions"."source" != 'IMPORTED' or (
      "sale_transactions"."paypal_order_id" is null and "sale_transactions"."paypal_capture_id" is null and
      "sale_transactions"."paypal_custom_id" is null and "sale_transactions"."provider_created_at" is null and
      "sale_transactions"."provider_updated_at" is null and "sale_transactions"."reconciled_at" is null and
      "sale_transactions"."verification_state" = 'PENDING' and "sale_transactions"."reconciliation_state" = 'NOT_RECONCILED' and
      "sale_transactions"."provider_status" = 'IMPORTED' and "sale_transactions"."occurred_at" is not null and
      "sale_transactions"."source_system" is not null and "sale_transactions"."source_transaction_id" is not null
    ));--> statement-breakpoint
ALTER TABLE "sale_transactions" ADD CONSTRAINT "sale_transactions_source_check" CHECK ("sale_transactions"."source" in ('PAYPAL_SANDBOX', 'DEMO_SEEDED', 'REFERENCE', 'IMPORTED'));--> statement-breakpoint
-- A location policy must name a location of its organisation. A policy version's
-- facts never change: it can only be superseded, and is never deleted. No policy is
-- created here: a business has none until one is configured or provisioned.
CREATE FUNCTION fairshift_labour_policy_integrity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Labour policies are retained'; END IF;
 IF TG_OP = 'UPDATE' THEN
   IF ROW(NEW.id, NEW.organisation_id, NEW.outlet_id, NEW.version, NEW.currency_code, NEW.sales_minor_per_labour_hour, NEW.source, NEW.created_by, NEW.created_at)
     IS DISTINCT FROM ROW(OLD.id, OLD.organisation_id, OLD.outlet_id, OLD.version, OLD.currency_code, OLD.sales_minor_per_labour_hour, OLD.source, OLD.created_by, OLD.created_at)
     OR OLD.status <> 'ACTIVE' THEN
     RAISE EXCEPTION 'Labour policy versions are immutable';
   END IF;
   RETURN NEW;
 END IF;
 IF NEW.outlet_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM outlets WHERE id = NEW.outlet_id AND organisation_id = NEW.organisation_id) THEN
   RAISE EXCEPTION 'Labour policy location must belong to its organisation';
 END IF;
 RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER fairshift_labour_policy_integrity BEFORE INSERT OR UPDATE OR DELETE ON labour_policies FOR EACH ROW EXECUTE FUNCTION fairshift_labour_policy_integrity();
