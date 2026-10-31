CREATE TABLE "work_payables" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organisation_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"shift_id" uuid NOT NULL,
	"worker_id" uuid NOT NULL,
	"offer_id" uuid NOT NULL,
	"allocation_id" uuid NOT NULL,
	"acceptance_id" uuid NOT NULL,
	"terms_version" integer NOT NULL,
	"calculation_method" text NOT NULL,
	"earnings_model" text NOT NULL,
	"currency_code" text NOT NULL,
	"rate_minor" bigint NOT NULL,
	"scheduled_starts_at" timestamp with time zone NOT NULL,
	"scheduled_ends_at" timestamp with time zone NOT NULL,
	"base_amount_minor" bigint NOT NULL,
	"status" text DEFAULT 'PENDING_REVIEW' NOT NULL,
	"confirmed_at" timestamp with time zone NOT NULL,
	"confirmed_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "work_payables_method_check" CHECK ("work_payables"."calculation_method" = 'confirm-as-scheduled-v1'),
	CONSTRAINT "work_payables_model_check" CHECK ("work_payables"."earnings_model" in ('HOURLY', 'DAILY')),
	CONSTRAINT "work_payables_currency_check" CHECK ("work_payables"."currency_code" ~ '^[A-Z]{3}$'),
	CONSTRAINT "work_payables_amounts_check" CHECK ("work_payables"."rate_minor" between 0 and 9007199254740991 and "work_payables"."base_amount_minor" between 0 and 9007199254740991 and "work_payables"."terms_version" > 0),
	CONSTRAINT "work_payables_schedule_check" CHECK ("work_payables"."scheduled_ends_at" > "work_payables"."scheduled_starts_at"),
	CONSTRAINT "work_payables_formula_check" CHECK (("work_payables"."earnings_model" = 'DAILY' and "work_payables"."base_amount_minor" = "work_payables"."rate_minor") or ("work_payables"."earnings_model" = 'HOURLY' and "work_payables"."base_amount_minor"::numeric * 3600 = "work_payables"."rate_minor"::numeric * extract(epoch from "work_payables"."scheduled_ends_at" - "work_payables"."scheduled_starts_at"))),
	CONSTRAINT "work_payables_status_check" CHECK ("work_payables"."status" in ('PENDING_REVIEW'))
);
--> statement-breakpoint
ALTER TABLE "work_policies" ADD COLUMN "currency_code" text;--> statement-breakpoint
-- Work policies had no currency and requirements were created in USD. Policies at a
-- location whose own country, or (when it has none) whose organisation's country, is
-- the United Kingdom are in GBP; every other existing policy keeps the USD it was used
-- with (mirrors resolveLocationCurrency in src/server/domain/currency.ts). Existing
-- shifts, offers and accepted terms are not rewritten.
UPDATE work_policies SET currency_code = CASE
 WHEN lower(trim(coalesce(nullif(trim(outlets.country), ''), organisations.country, ''))) IN ('united kingdom','uk','gb','great britain','england','scotland','wales','northern ireland') THEN 'GBP'
 ELSE 'USD' END
FROM outlets JOIN organisations ON organisations.id = outlets.organisation_id
WHERE outlets.id = work_policies.outlet_id;--> statement-breakpoint
ALTER TABLE "work_policies" ALTER COLUMN "currency_code" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "work_payables" ADD CONSTRAINT "work_payables_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_payables" ADD CONSTRAINT "work_payables_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_payables" ADD CONSTRAINT "work_payables_shift_id_shifts_id_fk" FOREIGN KEY ("shift_id") REFERENCES "public"."shifts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_payables" ADD CONSTRAINT "work_payables_worker_id_workers_id_fk" FOREIGN KEY ("worker_id") REFERENCES "public"."workers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_payables" ADD CONSTRAINT "work_payables_offer_id_shift_offers_id_fk" FOREIGN KEY ("offer_id") REFERENCES "public"."shift_offers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_payables" ADD CONSTRAINT "work_payables_allocation_id_work_allocations_id_fk" FOREIGN KEY ("allocation_id") REFERENCES "public"."work_allocations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_payables" ADD CONSTRAINT "work_payables_acceptance_id_work_acceptances_id_fk" FOREIGN KEY ("acceptance_id") REFERENCES "public"."work_acceptances"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_payables" ADD CONSTRAINT "work_payables_confirmed_by_auth_users_id_fk" FOREIGN KEY ("confirmed_by") REFERENCES "public"."auth_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "work_payables_allocation_unique" ON "work_payables" USING btree ("allocation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "work_payables_shift_worker_unique" ON "work_payables" USING btree ("shift_id","worker_id");--> statement-breakpoint
CREATE INDEX "work_payables_scope_idx" ON "work_payables" USING btree ("organisation_id","outlet_id","confirmed_at");--> statement-breakpoint
CREATE INDEX "work_payables_worker_idx" ON "work_payables" USING btree ("worker_id");--> statement-breakpoint
ALTER TABLE "work_policies" ADD CONSTRAINT "work_policy_currency_check" CHECK ("work_policies"."currency_code" ~ '^[A-Z]{3}$');--> statement-breakpoint
-- A payable references exactly one confirmed allocation, and every reference must
-- agree: location in the organisation, shift at the location on the payable's terms
-- version, worker in the organisation, accepted offer of that worker for that shift,
-- allocation of that offer under that acceptance, and the acceptance snapshot's
-- currency, rate, schedule and expected earnings. Financial facts are immutable and
-- payables are never deleted; only the status may later change.
CREATE FUNCTION fairshift_work_payable_integrity() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE terms jsonb;
BEGIN
 IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Work payables are retained'; END IF;
 IF TG_OP = 'UPDATE' THEN
   IF ROW(NEW.id, NEW.organisation_id, NEW.outlet_id, NEW.shift_id, NEW.worker_id, NEW.offer_id, NEW.allocation_id, NEW.acceptance_id, NEW.terms_version, NEW.calculation_method, NEW.earnings_model, NEW.currency_code, NEW.rate_minor, NEW.scheduled_starts_at, NEW.scheduled_ends_at, NEW.base_amount_minor, NEW.confirmed_at, NEW.confirmed_by, NEW.created_at)
   IS DISTINCT FROM ROW(OLD.id, OLD.organisation_id, OLD.outlet_id, OLD.shift_id, OLD.worker_id, OLD.offer_id, OLD.allocation_id, OLD.acceptance_id, OLD.terms_version, OLD.calculation_method, OLD.earnings_model, OLD.currency_code, OLD.rate_minor, OLD.scheduled_starts_at, OLD.scheduled_ends_at, OLD.base_amount_minor, OLD.confirmed_at, OLD.confirmed_by, OLD.created_at) THEN
     RAISE EXCEPTION 'Work payable financial facts are immutable';
   END IF;
   RETURN NEW;
 END IF;
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
 RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER fairshift_work_payable_integrity BEFORE INSERT OR UPDATE OR DELETE ON work_payables FOR EACH ROW EXECUTE FUNCTION fairshift_work_payable_integrity();
