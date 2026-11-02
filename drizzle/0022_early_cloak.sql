CREATE TABLE "outlet_trading_hours" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organisation_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"iso_weekday" integer NOT NULL,
	"windows" jsonb NOT NULL,
	"source" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "outlet_trading_hours_weekday_check" CHECK ("outlet_trading_hours"."iso_weekday" between 1 and 7),
	CONSTRAINT "outlet_trading_hours_windows_check" CHECK (jsonb_typeof("outlet_trading_hours"."windows") = 'array'),
	CONSTRAINT "outlet_trading_hours_source_check" CHECK ("outlet_trading_hours"."source" in ('REFERENCE', 'CONFIGURED'))
);
--> statement-breakpoint
CREATE TABLE "regular_coverage_windows" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organisation_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"iso_weekday" integer NOT NULL,
	"windows" jsonb NOT NULL,
	"source" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "regular_coverage_windows_weekday_check" CHECK ("regular_coverage_windows"."iso_weekday" between 1 and 7),
	CONSTRAINT "regular_coverage_windows_windows_check" CHECK (jsonb_typeof("regular_coverage_windows"."windows") = 'array'),
	CONSTRAINT "regular_coverage_windows_source_check" CHECK ("regular_coverage_windows"."source" in ('REFERENCE', 'CONFIGURED'))
);
--> statement-breakpoint
CREATE TABLE "shift_opportunity_evidence" (
	"shift_id" uuid PRIMARY KEY NOT NULL,
	"organisation_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"local_date" date NOT NULL,
	"window_starts_at" timestamp with time zone NOT NULL,
	"window_ends_at" timestamp with time zone NOT NULL,
	"evidence" jsonb NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "shift_opportunity_evidence_window_check" CHECK ("shift_opportunity_evidence"."window_ends_at" > "shift_opportunity_evidence"."window_starts_at")
);
--> statement-breakpoint
CREATE TABLE "workload_policies" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organisation_id" uuid NOT NULL,
	"outlet_id" uuid,
	"version" integer NOT NULL,
	"transactions_per_staff_hour" integer NOT NULL,
	"minimum_staff_while_open" integer NOT NULL,
	"source" text NOT NULL,
	"status" text DEFAULT 'ACTIVE' NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"superseded_at" timestamp with time zone,
	CONSTRAINT "workload_policies_capacity_check" CHECK ("workload_policies"."transactions_per_staff_hour" between 1 and 1000),
	CONSTRAINT "workload_policies_minimum_check" CHECK ("workload_policies"."minimum_staff_while_open" between 0 and 100),
	CONSTRAINT "workload_policies_version_check" CHECK ("workload_policies"."version" > 0),
	CONSTRAINT "workload_policies_source_check" CHECK ("workload_policies"."source" in ('CONFIGURED', 'REFERENCE')),
	CONSTRAINT "workload_policies_status_check" CHECK (("workload_policies"."status" = 'ACTIVE' and "workload_policies"."superseded_at" is null) or ("workload_policies"."status" = 'SUPERSEDED' and "workload_policies"."superseded_at" is not null))
);
--> statement-breakpoint
ALTER TABLE "outlet_trading_hours" ADD CONSTRAINT "outlet_trading_hours_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outlet_trading_hours" ADD CONSTRAINT "outlet_trading_hours_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "regular_coverage_windows" ADD CONSTRAINT "regular_coverage_windows_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "regular_coverage_windows" ADD CONSTRAINT "regular_coverage_windows_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shift_opportunity_evidence" ADD CONSTRAINT "shift_opportunity_evidence_shift_id_shifts_id_fk" FOREIGN KEY ("shift_id") REFERENCES "public"."shifts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shift_opportunity_evidence" ADD CONSTRAINT "shift_opportunity_evidence_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shift_opportunity_evidence" ADD CONSTRAINT "shift_opportunity_evidence_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shift_opportunity_evidence" ADD CONSTRAINT "shift_opportunity_evidence_created_by_auth_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."auth_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workload_policies" ADD CONSTRAINT "workload_policies_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workload_policies" ADD CONSTRAINT "workload_policies_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workload_policies" ADD CONSTRAINT "workload_policies_created_by_auth_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."auth_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "outlet_trading_hours_outlet_weekday_unique" ON "outlet_trading_hours" USING btree ("outlet_id","iso_weekday");--> statement-breakpoint
CREATE INDEX "outlet_trading_hours_organisation_idx" ON "outlet_trading_hours" USING btree ("organisation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "regular_coverage_windows_outlet_weekday_unique" ON "regular_coverage_windows" USING btree ("outlet_id","iso_weekday");--> statement-breakpoint
CREATE INDEX "regular_coverage_windows_organisation_idx" ON "regular_coverage_windows" USING btree ("organisation_id");--> statement-breakpoint
CREATE INDEX "shift_opportunity_evidence_outlet_idx" ON "shift_opportunity_evidence" USING btree ("outlet_id","local_date");--> statement-breakpoint
CREATE UNIQUE INDEX "workload_policies_active_organisation_unique" ON "workload_policies" USING btree ("organisation_id") WHERE "workload_policies"."status" = 'ACTIVE' and "workload_policies"."outlet_id" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "workload_policies_active_location_unique" ON "workload_policies" USING btree ("outlet_id") WHERE "workload_policies"."status" = 'ACTIVE' and "workload_policies"."outlet_id" is not null;--> statement-breakpoint
CREATE INDEX "workload_policies_organisation_idx" ON "workload_policies" USING btree ("organisation_id","created_at");--> statement-breakpoint
-- A location policy must name a location of its organisation. A policy version's facts
-- never change: it can only be superseded, and is never deleted. No policy is created
-- here: a business has none until one is configured.
CREATE FUNCTION fairshift_workload_policy_integrity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Workload policies are retained'; END IF;
 IF TG_OP = 'UPDATE' THEN
   IF ROW(NEW.id, NEW.organisation_id, NEW.outlet_id, NEW.version, NEW.transactions_per_staff_hour, NEW.minimum_staff_while_open, NEW.source, NEW.created_by, NEW.created_at)
     IS DISTINCT FROM ROW(OLD.id, OLD.organisation_id, OLD.outlet_id, OLD.version, OLD.transactions_per_staff_hour, OLD.minimum_staff_while_open, OLD.source, OLD.created_by, OLD.created_at)
     OR OLD.status <> 'ACTIVE' THEN
     RAISE EXCEPTION 'Workload policy versions are immutable';
   END IF;
   RETURN NEW;
 END IF;
 IF NEW.outlet_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM outlets WHERE id = NEW.outlet_id AND organisation_id = NEW.organisation_id) THEN
   RAISE EXCEPTION 'Workload policy location must belong to its organisation';
 END IF;
 RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER fairshift_workload_policy_integrity BEFORE INSERT OR UPDATE OR DELETE ON workload_policies FOR EACH ROW EXECUTE FUNCTION fairshift_workload_policy_integrity();
--> statement-breakpoint
CREATE FUNCTION fairshift_location_window_scope() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS (SELECT 1 FROM outlets WHERE id=NEW.outlet_id AND organisation_id=NEW.organisation_id) THEN RAISE EXCEPTION 'Location windows must belong to a location of their organisation'; END IF;
 RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER fairshift_trading_hours_scope BEFORE INSERT OR UPDATE ON outlet_trading_hours FOR EACH ROW EXECUTE FUNCTION fairshift_location_window_scope();
--> statement-breakpoint
CREATE TRIGGER fairshift_regular_coverage_windows_scope BEFORE INSERT OR UPDATE ON regular_coverage_windows FOR EACH ROW EXECUTE FUNCTION fairshift_location_window_scope();
--> statement-breakpoint
-- Why a shift was created is a frozen record: it must match its shift's location and can't change or be removed.
CREATE FUNCTION fairshift_shift_opportunity_evidence_integrity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'Shift opportunity evidence is immutable'; END IF;
 IF NOT EXISTS (SELECT 1 FROM shifts JOIN outlets ON outlets.id = shifts.outlet_id WHERE shifts.id = NEW.shift_id AND shifts.outlet_id = NEW.outlet_id AND outlets.organisation_id = NEW.organisation_id) THEN
   RAISE EXCEPTION 'Shift opportunity evidence must match its shift''s location and organisation';
 END IF;
 RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER fairshift_shift_opportunity_evidence_integrity BEFORE INSERT OR UPDATE OR DELETE ON shift_opportunity_evidence FOR EACH ROW EXECUTE FUNCTION fairshift_shift_opportunity_evidence_integrity();
