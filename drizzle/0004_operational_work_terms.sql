CREATE TABLE "attributed_sales" (
	"id" uuid PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"provider_transaction_id" text NOT NULL,
	"attribution_code" text NOT NULL,
	"worker_id" uuid,
	"outlet_id" uuid NOT NULL,
	"amount_minor" bigint NOT NULL,
	"currency_code" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"source" text NOT NULL,
	"verification_state" text DEFAULT 'UNVERIFIED' NOT NULL,
	CONSTRAINT "attributed_sales_verification_check" CHECK ("attributed_sales"."verification_state" in ('UNVERIFIED', 'VERIFIED', 'FAILED')),
	CONSTRAINT "attributed_sales_amount_check" CHECK ("attributed_sales"."amount_minor" >= 0 and "attributed_sales"."amount_minor" <= 9007199254740991)
);
--> statement-breakpoint
CREATE TABLE "departments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"outlet_id" uuid NOT NULL,
	"name" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "team_invitations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"worker_id" uuid NOT NULL,
	"state" text DEFAULT 'CREATED_NOT_SENT' NOT NULL,
	"token" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "team_invitation_state_check" CHECK ("team_invitations"."state" = 'CREATED_NOT_SENT')
);
--> statement-breakpoint
CREATE TABLE "work_acceptances" (
	"id" uuid PRIMARY KEY NOT NULL,
	"offer_id" uuid NOT NULL,
	"worker_id" uuid NOT NULL,
	"terms_version" integer NOT NULL,
	"snapshot" jsonb NOT NULL,
	"accepted_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "work_allocations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"offer_id" uuid NOT NULL,
	"acceptance_id" uuid NOT NULL,
	"state" text DEFAULT 'ALLOCATED' NOT NULL,
	CONSTRAINT "work_allocation_state_check" CHECK ("work_allocations"."state" in ('ALLOCATED', 'REACCEPTANCE_REQUIRED'))
);
--> statement-breakpoint
CREATE TABLE "work_policies" (
	"id" uuid PRIMARY KEY NOT NULL,
	"outlet_id" uuid NOT NULL,
	"name" text NOT NULL,
	"earnings_model" text NOT NULL,
	"rate_minor" bigint,
	"commission_bps" integer,
	"commission_basis" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "work_policy_terms_check" CHECK ((
  "work_policies"."earnings_model" in ('HOURLY', 'DAILY') and "work_policies"."rate_minor" is not null and "work_policies"."rate_minor" >= 0 and "work_policies"."rate_minor" <= 9007199254740991 and "work_policies"."commission_bps" is null and "work_policies"."commission_basis" is null
) or (
  "work_policies"."earnings_model" = 'COMMISSION' and "work_policies"."rate_minor" is null and "work_policies"."commission_bps" is not null and "work_policies"."commission_basis" is not null and "work_policies"."commission_bps" between 0 and 10000 and "work_policies"."commission_basis" = 'VERIFIED_ATTRIBUTED_SALES'
))
);
--> statement-breakpoint
ALTER TABLE "shifts" ADD COLUMN "department_id" uuid;--> statement-breakpoint
ALTER TABLE "shifts" ADD COLUMN "required_headcount" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "shifts" ADD COLUMN "terms_version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "shifts" ADD COLUMN "policy_id" uuid;--> statement-breakpoint
ALTER TABLE "shifts" ADD COLUMN "earnings_model" text DEFAULT 'DAILY' NOT NULL;--> statement-breakpoint
ALTER TABLE "shifts" ADD COLUMN "rate_minor" bigint;--> statement-breakpoint
ALTER TABLE "shifts" ADD COLUMN "commission_bps" integer;--> statement-breakpoint
ALTER TABLE "shifts" ADD COLUMN "commission_basis" text;--> statement-breakpoint
ALTER TABLE "shifts" ADD COLUMN "expected_earnings_minor" bigint;--> statement-breakpoint
ALTER TABLE "workers" ADD COLUMN "first_name" text;--> statement-breakpoint
ALTER TABLE "workers" ADD COLUMN "surname" text;--> statement-breakpoint
ALTER TABLE "workers" ADD COLUMN "telephone" text;--> statement-breakpoint
ALTER TABLE "workers" ADD COLUMN "email" text;--> statement-breakpoint
ALTER TABLE "workers" ADD COLUMN "location_id" uuid;--> statement-breakpoint
ALTER TABLE "workers" ADD COLUMN "attribution_code" text DEFAULT 'FS-' || upper(replace(gen_random_uuid()::text, '-', '')) NOT NULL;--> statement-breakpoint
ALTER TABLE "attributed_sales" ADD CONSTRAINT "attributed_sales_worker_id_workers_id_fk" FOREIGN KEY ("worker_id") REFERENCES "public"."workers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attributed_sales" ADD CONSTRAINT "attributed_sales_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "departments" ADD CONSTRAINT "departments_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_invitations" ADD CONSTRAINT "team_invitations_worker_id_workers_id_fk" FOREIGN KEY ("worker_id") REFERENCES "public"."workers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_acceptances" ADD CONSTRAINT "work_acceptances_offer_id_shift_offers_id_fk" FOREIGN KEY ("offer_id") REFERENCES "public"."shift_offers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_acceptances" ADD CONSTRAINT "work_acceptances_worker_id_workers_id_fk" FOREIGN KEY ("worker_id") REFERENCES "public"."workers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_allocations" ADD CONSTRAINT "work_allocations_offer_id_shift_offers_id_fk" FOREIGN KEY ("offer_id") REFERENCES "public"."shift_offers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_allocations" ADD CONSTRAINT "work_allocations_acceptance_id_work_acceptances_id_fk" FOREIGN KEY ("acceptance_id") REFERENCES "public"."work_acceptances"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_policies" ADD CONSTRAINT "work_policies_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "attributed_sales_provider_transaction_unique" ON "attributed_sales" USING btree ("provider","provider_transaction_id");--> statement-breakpoint
CREATE UNIQUE INDEX "departments_location_name_unique" ON "departments" USING btree ("outlet_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "team_invitation_token_unique" ON "team_invitations" USING btree ("token");--> statement-breakpoint
CREATE UNIQUE INDEX "work_acceptances_offer_version_unique" ON "work_acceptances" USING btree ("offer_id","terms_version");--> statement-breakpoint
CREATE UNIQUE INDEX "work_allocations_offer_unique" ON "work_allocations" USING btree ("offer_id");--> statement-breakpoint
ALTER TABLE "shifts" ADD CONSTRAINT "shifts_department_id_departments_id_fk" FOREIGN KEY ("department_id") REFERENCES "public"."departments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shifts" ADD CONSTRAINT "shifts_policy_id_work_policies_id_fk" FOREIGN KEY ("policy_id") REFERENCES "public"."work_policies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workers" ADD CONSTRAINT "workers_location_id_outlets_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "workers_attribution_code_unique" ON "workers" USING btree ("attribution_code");--> statement-breakpoint
ALTER TABLE "shifts" ADD CONSTRAINT "shifts_headcount_check" CHECK ("shifts"."required_headcount" > 0 and "shifts"."terms_version" > 0);--> statement-breakpoint
UPDATE workers SET location_id = '20000000-0000-4000-8000-000000000001' WHERE id = '30000000-0000-4000-8000-000000000001';
--> statement-breakpoint
UPDATE shifts SET rate_minor = guaranteed_base_pay_minor, expected_earnings_minor = guaranteed_base_pay_minor;
--> statement-breakpoint
INSERT INTO departments (id, outlet_id, name) SELECT gen_random_uuid(), id, 'General' FROM outlets;
--> statement-breakpoint
UPDATE shifts SET department_id = departments.id FROM departments WHERE shifts.outlet_id = departments.outlet_id AND departments.name = 'General';
--> statement-breakpoint
CREATE FUNCTION fairshift_terms_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF ROW(NEW.outlet_id, NEW.department_id, NEW.starts_at, NEW.ends_at, NEW.shift_date, NEW.earnings_model, NEW.rate_minor, NEW.commission_bps, NEW.commission_basis, NEW.expected_earnings_minor, NEW.currency_code, NEW.guaranteed_base_pay_minor, NEW.incentive_policy, NEW.incentive_target_minor, NEW.incentive_amount_minor, NEW.gratuity_policy)
 IS DISTINCT FROM ROW(OLD.outlet_id, OLD.department_id, OLD.starts_at, OLD.ends_at, OLD.shift_date, OLD.earnings_model, OLD.rate_minor, OLD.commission_bps, OLD.commission_basis, OLD.expected_earnings_minor, OLD.currency_code, OLD.guaranteed_base_pay_minor, OLD.incentive_policy, OLD.incentive_target_minor, OLD.incentive_amount_minor, OLD.gratuity_policy) THEN
   IF OLD.status = 'COMPLETED' OR EXISTS (SELECT 1 FROM shift_incentives WHERE shift_id = OLD.id) OR EXISTS (SELECT 1 FROM work_allocations a JOIN shift_offers o ON o.id = a.offer_id WHERE o.shift_id = OLD.id AND a.confirmed_at IS NOT NULL) THEN
     RAISE EXCEPTION 'Reviewed work terms cannot be changed';
   END IF;
   NEW.terms_version := OLD.terms_version + 1;
   UPDATE shift_offers SET status = 'OFFERED', accepted_at = NULL, responded_at = NULL WHERE shift_id = OLD.id AND status = 'ACCEPTED';
   UPDATE work_allocations SET state = 'REACCEPTANCE_REQUIRED' WHERE offer_id IN (SELECT id FROM shift_offers WHERE shift_id = OLD.id);
 ELSE
   NEW.terms_version := OLD.terms_version;
 END IF;
 RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER fairshift_material_terms BEFORE UPDATE ON shifts FOR EACH ROW EXECUTE FUNCTION fairshift_terms_version();
--> statement-breakpoint
CREATE FUNCTION fairshift_immutable_acceptance() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Acceptance evidence is immutable'; END $$;
--> statement-breakpoint
CREATE TRIGGER fairshift_acceptance_immutable BEFORE UPDATE OR DELETE ON work_acceptances FOR EACH ROW EXECUTE FUNCTION fairshift_immutable_acceptance();
