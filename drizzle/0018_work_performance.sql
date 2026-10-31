CREATE TABLE "work_performance_results" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organisation_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"shift_id" uuid NOT NULL,
	"worker_id" uuid NOT NULL,
	"allocation_id" uuid NOT NULL,
	"acceptance_id" uuid NOT NULL,
	"sales_count" integer NOT NULL,
	"sales_minor" bigint NOT NULL,
	"currency_code" text NOT NULL,
	"target_minor" bigint NOT NULL,
	"bonus_minor" bigint NOT NULL,
	"earned_minor" bigint NOT NULL,
	"evidence_provenance" text NOT NULL,
	"confirmed_at" timestamp with time zone NOT NULL,
	"confirmed_by" uuid,
	CONSTRAINT "work_performance_results_amounts_check" CHECK ("work_performance_results"."sales_count" >= 0 and "work_performance_results"."sales_minor" between 0 and 9007199254740991 and "work_performance_results"."target_minor" > 0 and "work_performance_results"."bonus_minor" > 0 and ("work_performance_results"."sales_count" > 0 or "work_performance_results"."sales_minor" = 0)),
	CONSTRAINT "work_performance_results_formula_check" CHECK ("work_performance_results"."earned_minor" = case when "work_performance_results"."sales_minor" >= "work_performance_results"."target_minor" then "work_performance_results"."bonus_minor" else 0 end),
	CONSTRAINT "work_performance_results_provenance_check" CHECK ("work_performance_results"."evidence_provenance" = 'IMPORTED_NOT_PROVIDER_VERIFIED'),
	CONSTRAINT "work_performance_results_currency_check" CHECK ("work_performance_results"."currency_code" ~ '^[A-Z]{3}$')
);
--> statement-breakpoint
ALTER TABLE "work_payables" DROP CONSTRAINT "work_payables_approval_check";--> statement-breakpoint
DROP INDEX "attributed_sales_provider_transaction_unique";--> statement-breakpoint
ALTER TABLE "shifts" ADD COLUMN "incentive_basis" text;--> statement-breakpoint
ALTER TABLE "work_payables" ADD COLUMN "incentive_required" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "work_payables" ADD COLUMN "incentive_amount_minor" bigint;--> statement-breakpoint
ALTER TABLE "work_payables" ADD COLUMN "performance_result_id" uuid;--> statement-breakpoint
ALTER TABLE "work_policies" ADD COLUMN "incentive_target_minor" bigint;--> statement-breakpoint
ALTER TABLE "work_policies" ADD COLUMN "incentive_bonus_minor" bigint;--> statement-breakpoint
ALTER TABLE "work_performance_results" ADD CONSTRAINT "work_performance_results_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_performance_results" ADD CONSTRAINT "work_performance_results_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_performance_results" ADD CONSTRAINT "work_performance_results_shift_id_shifts_id_fk" FOREIGN KEY ("shift_id") REFERENCES "public"."shifts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_performance_results" ADD CONSTRAINT "work_performance_results_worker_id_workers_id_fk" FOREIGN KEY ("worker_id") REFERENCES "public"."workers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_performance_results" ADD CONSTRAINT "work_performance_results_allocation_id_work_allocations_id_fk" FOREIGN KEY ("allocation_id") REFERENCES "public"."work_allocations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_performance_results" ADD CONSTRAINT "work_performance_results_acceptance_id_work_acceptances_id_fk" FOREIGN KEY ("acceptance_id") REFERENCES "public"."work_acceptances"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_performance_results" ADD CONSTRAINT "work_performance_results_confirmed_by_auth_users_id_fk" FOREIGN KEY ("confirmed_by") REFERENCES "public"."auth_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "work_performance_results_allocation_unique" ON "work_performance_results" USING btree ("allocation_id");--> statement-breakpoint
CREATE INDEX "work_performance_results_worker_idx" ON "work_performance_results" USING btree ("worker_id");--> statement-breakpoint
ALTER TABLE "work_payables" ADD CONSTRAINT "work_payables_performance_result_id_work_performance_results_id_fk" FOREIGN KEY ("performance_result_id") REFERENCES "public"."work_performance_results"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "attributed_sales_location_transaction_unique" ON "attributed_sales" USING btree ("outlet_id","provider","provider_transaction_id");--> statement-breakpoint
CREATE INDEX "attributed_sales_worker_time_idx" ON "attributed_sales" USING btree ("worker_id","occurred_at");--> statement-breakpoint
ALTER TABLE "shifts" ADD CONSTRAINT "shifts_incentive_basis_check" CHECK ("shifts"."incentive_basis" is null or ("shifts"."incentive_basis" = 'INDIVIDUAL_ATTRIBUTED_SALES' and "shifts"."incentive_target_minor" > 0 and "shifts"."incentive_amount_minor" > 0));--> statement-breakpoint
ALTER TABLE "work_payables" ADD CONSTRAINT "work_payables_incentive_check" CHECK (("work_payables"."incentive_amount_minor" is null and "work_payables"."performance_result_id" is null) or ("work_payables"."incentive_required" and "work_payables"."incentive_amount_minor" is not null and "work_payables"."incentive_amount_minor" between 0 and 9007199254740991 and "work_payables"."performance_result_id" is not null));--> statement-breakpoint
ALTER TABLE "work_payables" ADD CONSTRAINT "work_payables_approval_check" CHECK (("work_payables"."status" = 'PENDING_REVIEW' and "work_payables"."approved_at" is null and "work_payables"."approved_by" is null and "work_payables"."approved_amount_minor" is null and "work_payables"."approved_currency_code" is null)
    or ("work_payables"."status" = 'APPROVED' and "work_payables"."approved_at" is not null and "work_payables"."approved_by" is not null and "work_payables"."approved_amount_minor" is not null and "work_payables"."approved_amount_minor" = "work_payables"."base_amount_minor" + coalesce("work_payables"."incentive_amount_minor", 0) and "work_payables"."approved_currency_code" = "work_payables"."currency_code" and (not "work_payables"."incentive_required" or "work_payables"."incentive_amount_minor" is not null)));--> statement-breakpoint
ALTER TABLE "work_policies" ADD CONSTRAINT "work_policy_incentive_check" CHECK (("work_policies"."incentive_target_minor" is null and "work_policies"."incentive_bonus_minor" is null) or (
  "work_policies"."incentive_target_minor" is not null and "work_policies"."incentive_bonus_minor" is not null and "work_policies"."incentive_target_minor" between 1 and 9007199254740991 and "work_policies"."incentive_bonus_minor" between 1 and 9007199254740991 and "work_policies"."earnings_model" in ('HOURLY', 'DAILY')
));
--> statement-breakpoint
-- The payable's rules from 0014, plus: incentive terms follow the acceptance snapshot,
-- and the incentive is recorded once, before approval, from its own confirmed result.
-- Existing payables stay base-only: incentive_required defaults to false.
CREATE OR REPLACE FUNCTION fairshift_work_payable_integrity() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE terms jsonb;
BEGIN
 IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Work payables are retained'; END IF;
 IF TG_OP = 'UPDATE' THEN
   IF ROW(NEW.id, NEW.organisation_id, NEW.outlet_id, NEW.shift_id, NEW.worker_id, NEW.offer_id, NEW.allocation_id, NEW.acceptance_id, NEW.terms_version, NEW.calculation_method, NEW.earnings_model, NEW.currency_code, NEW.rate_minor, NEW.scheduled_starts_at, NEW.scheduled_ends_at, NEW.base_amount_minor, NEW.confirmed_at, NEW.confirmed_by, NEW.created_at)
   IS DISTINCT FROM ROW(OLD.id, OLD.organisation_id, OLD.outlet_id, OLD.shift_id, OLD.worker_id, OLD.offer_id, OLD.allocation_id, OLD.acceptance_id, OLD.terms_version, OLD.calculation_method, OLD.earnings_model, OLD.currency_code, OLD.rate_minor, OLD.scheduled_starts_at, OLD.scheduled_ends_at, OLD.base_amount_minor, OLD.confirmed_at, OLD.confirmed_by, OLD.created_at) THEN
     RAISE EXCEPTION 'Work payable financial facts are immutable';
   END IF;
   IF OLD.status = 'APPROVED' AND ROW(NEW.status, NEW.approved_at, NEW.approved_by, NEW.approved_amount_minor, NEW.approved_currency_code, NEW.incentive_amount_minor, NEW.performance_result_id)
     IS DISTINCT FROM ROW(OLD.status, OLD.approved_at, OLD.approved_by, OLD.approved_amount_minor, OLD.approved_currency_code, OLD.incentive_amount_minor, OLD.performance_result_id) THEN
     RAISE EXCEPTION 'Work payable approval is final';
   END IF;
   IF NEW.incentive_required IS DISTINCT FROM OLD.incentive_required THEN RAISE EXCEPTION 'Work payable incentive terms are immutable'; END IF;
   IF ROW(NEW.incentive_amount_minor, NEW.performance_result_id) IS DISTINCT FROM ROW(OLD.incentive_amount_minor, OLD.performance_result_id) THEN
     IF OLD.incentive_amount_minor IS NOT NULL THEN RAISE EXCEPTION 'A work payable incentive is recorded once'; END IF;
     IF NOT EXISTS (SELECT 1 FROM work_performance_results r WHERE r.id = NEW.performance_result_id AND r.allocation_id = NEW.allocation_id AND r.acceptance_id = NEW.acceptance_id AND r.earned_minor = NEW.incentive_amount_minor AND r.currency_code = NEW.currency_code) THEN
       RAISE EXCEPTION 'A work payable incentive must come from its confirmed performance result';
     END IF;
   END IF;
   RETURN NEW;
 END IF;
 IF NEW.status IS DISTINCT FROM 'PENDING_REVIEW' THEN RAISE EXCEPTION 'Work payables are created awaiting review'; END IF;
 IF NOT EXISTS (SELECT 1 FROM outlets WHERE id = NEW.outlet_id AND organisation_id = NEW.organisation_id)
  OR NOT EXISTS (SELECT 1 FROM shifts WHERE id = NEW.shift_id AND outlet_id = NEW.outlet_id AND terms_version = NEW.terms_version)
  OR NOT EXISTS (SELECT 1 FROM workers WHERE id = NEW.worker_id AND organisation_id = NEW.organisation_id)
  OR NOT EXISTS (SELECT 1 FROM shift_offers WHERE id = NEW.offer_id AND shift_id = NEW.shift_id AND worker_id = NEW.worker_id AND status = 'ACCEPTED')
  OR NOT EXISTS (SELECT 1 FROM work_allocations WHERE id = NEW.allocation_id AND offer_id = NEW.offer_id AND acceptance_id = NEW.acceptance_id AND state = 'ALLOCATED' AND date_trunc('milliseconds', confirmed_at) = date_trunc('milliseconds', NEW.confirmed_at)) THEN
   RAISE EXCEPTION 'Work payable must reference one confirmed allocation in its organisation and location';
 END IF;
 SELECT snapshot INTO terms FROM work_acceptances WHERE id = NEW.acceptance_id AND offer_id = NEW.offer_id AND worker_id = NEW.worker_id AND terms_version = NEW.terms_version;
 IF terms IS NULL OR terms->>'earningsModel' IS DISTINCT FROM NEW.earnings_model OR terms->>'currencyCode' IS DISTINCT FROM NEW.currency_code
  OR (terms->>'rateMinor')::bigint IS DISTINCT FROM NEW.rate_minor OR (terms->>'expectedEarningsMinor')::bigint IS DISTINCT FROM NEW.base_amount_minor
  OR (terms->>'startsAt')::timestamptz IS DISTINCT FROM NEW.scheduled_starts_at OR (terms->>'endsAt')::timestamptz IS DISTINCT FROM NEW.scheduled_ends_at THEN
   RAISE EXCEPTION 'Work payable must match the accepted terms';
 END IF;
 IF NEW.incentive_amount_minor IS NOT NULL OR NEW.performance_result_id IS NOT NULL THEN RAISE EXCEPTION 'Work payables are created before any performance result'; END IF;
 IF NEW.incentive_required IS DISTINCT FROM (terms->>'incentiveBasis' IS NOT NULL) THEN RAISE EXCEPTION 'Work payable must match the accepted incentive terms'; END IF;
 RETURN NEW;
END $$;
--> statement-breakpoint
-- A confirmed result must carry the accepted terms of its own allocation. Results never
-- change and are never deleted.
CREATE FUNCTION fairshift_work_performance_integrity() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE terms jsonb;
BEGIN
 IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'Work performance results are immutable'; END IF;
 IF NOT EXISTS (SELECT 1 FROM outlets WHERE id = NEW.outlet_id AND organisation_id = NEW.organisation_id)
  OR NOT EXISTS (SELECT 1 FROM shifts WHERE id = NEW.shift_id AND outlet_id = NEW.outlet_id)
  OR NOT EXISTS (SELECT 1 FROM workers WHERE id = NEW.worker_id AND organisation_id = NEW.organisation_id)
  OR NOT EXISTS (SELECT 1 FROM work_allocations a JOIN shift_offers o ON o.id = a.offer_id WHERE a.id = NEW.allocation_id AND a.acceptance_id = NEW.acceptance_id AND a.state = 'ALLOCATED' AND a.confirmed_at IS NOT NULL AND o.shift_id = NEW.shift_id AND o.worker_id = NEW.worker_id) THEN
   RAISE EXCEPTION 'A performance result must reference one confirmed allocation in its organisation and location';
 END IF;
 SELECT snapshot INTO terms FROM work_acceptances WHERE id = NEW.acceptance_id AND worker_id = NEW.worker_id;
 IF terms IS NULL OR terms->>'incentiveBasis' IS DISTINCT FROM 'INDIVIDUAL_ATTRIBUTED_SALES' OR terms->>'currencyCode' IS DISTINCT FROM NEW.currency_code
  OR (terms->>'incentiveTargetMinor')::bigint IS DISTINCT FROM NEW.target_minor OR (terms->>'incentiveAmountMinor')::bigint IS DISTINCT FROM NEW.bonus_minor THEN
   RAISE EXCEPTION 'A performance result must match the accepted incentive terms';
 END IF;
 RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER fairshift_work_performance_integrity_trigger BEFORE INSERT OR UPDATE OR DELETE ON work_performance_results FOR EACH ROW EXECUTE FUNCTION fairshift_work_performance_integrity();
