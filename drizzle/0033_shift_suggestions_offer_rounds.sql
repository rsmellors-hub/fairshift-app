CREATE TABLE "location_shift_rules" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organisation_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"min_minutes" integer NOT NULL,
	"max_minutes" integer NOT NULL,
	"preferred_minutes" integer NOT NULL,
	"first_round_minutes" integer NOT NULL,
	"first_round_cutoff_minutes" integer NOT NULL,
	"source" text NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "location_shift_rules_lengths_check" CHECK ("location_shift_rules"."min_minutes" >= 60 and "location_shift_rules"."min_minutes" <= "location_shift_rules"."preferred_minutes" and "location_shift_rules"."preferred_minutes" <= "location_shift_rules"."max_minutes" and "location_shift_rules"."max_minutes" <= 960 and "location_shift_rules"."min_minutes" % 15 = 0 and "location_shift_rules"."max_minutes" % 15 = 0 and "location_shift_rules"."preferred_minutes" % 15 = 0),
	CONSTRAINT "location_shift_rules_round_check" CHECK ("location_shift_rules"."first_round_minutes" >= 0 and "location_shift_rules"."first_round_cutoff_minutes" >= 0),
	CONSTRAINT "location_shift_rules_source_check" CHECK ("location_shift_rules"."source" in ('OWNER', 'DEMO_SEED'))
);
--> statement-breakpoint
CREATE TABLE "offer_rounds" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organisation_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"shift_id" uuid NOT NULL,
	"round" integer NOT NULL,
	"opened_at" timestamp with time zone NOT NULL,
	"closes_at" timestamp with time zone,
	"criteria" text NOT NULL,
	"offers" jsonb NOT NULL,
	"opened_by" uuid,
	CONSTRAINT "offer_rounds_round_check" CHECK ("offer_rounds"."round" in (1, 2))
);
--> statement-breakpoint
CREATE TABLE "organisation_hours_rules" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organisation_id" uuid NOT NULL,
	"weekly_threshold_minutes" integer NOT NULL,
	"reference_weeks" integer NOT NULL,
	"source" text NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "organisation_hours_rules_values_check" CHECK ("organisation_hours_rules"."weekly_threshold_minutes" > 0 and "organisation_hours_rules"."weekly_threshold_minutes" <= 4800 and "organisation_hours_rules"."reference_weeks" between 1 and 52),
	CONSTRAINT "organisation_hours_rules_source_check" CHECK ("organisation_hours_rules"."source" in ('OWNER', 'DEMO_SEED'))
);
--> statement-breakpoint
ALTER TABLE "workers" ADD COLUMN "wants_more_hours" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "location_shift_rules" ADD CONSTRAINT "location_shift_rules_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "location_shift_rules" ADD CONSTRAINT "location_shift_rules_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "location_shift_rules" ADD CONSTRAINT "location_shift_rules_created_by_auth_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."auth_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offer_rounds" ADD CONSTRAINT "offer_rounds_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offer_rounds" ADD CONSTRAINT "offer_rounds_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offer_rounds" ADD CONSTRAINT "offer_rounds_shift_id_shifts_id_fk" FOREIGN KEY ("shift_id") REFERENCES "public"."shifts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offer_rounds" ADD CONSTRAINT "offer_rounds_opened_by_auth_users_id_fk" FOREIGN KEY ("opened_by") REFERENCES "public"."auth_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organisation_hours_rules" ADD CONSTRAINT "organisation_hours_rules_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organisation_hours_rules" ADD CONSTRAINT "organisation_hours_rules_created_by_auth_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."auth_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "location_shift_rules_scope_idx" ON "location_shift_rules" USING btree ("organisation_id","outlet_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "offer_rounds_shift_round_unique" ON "offer_rounds" USING btree ("shift_id","round");--> statement-breakpoint
CREATE INDEX "offer_rounds_scope_idx" ON "offer_rounds" USING btree ("organisation_id","outlet_id","opened_at");--> statement-breakpoint
CREATE INDEX "organisation_hours_rules_scope_idx" ON "organisation_hours_rules" USING btree ("organisation_id","created_at");--> statement-breakpoint
-- An offer round, and a dated rule version, are records: never edited or deleted.
CREATE OR REPLACE FUNCTION fairshift_append_only_record() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 RAISE EXCEPTION '% rows are retained unchanged', TG_TABLE_NAME;
END $$;--> statement-breakpoint
CREATE TRIGGER offer_rounds_immutable BEFORE UPDATE OR DELETE ON "offer_rounds" FOR EACH ROW EXECUTE FUNCTION fairshift_append_only_record();--> statement-breakpoint
CREATE TRIGGER location_shift_rules_immutable BEFORE UPDATE OR DELETE ON "location_shift_rules" FOR EACH ROW EXECUTE FUNCTION fairshift_append_only_record();--> statement-breakpoint
CREATE TRIGGER organisation_hours_rules_immutable BEFORE UPDATE OR DELETE ON "organisation_hours_rules" FOR EACH ROW EXECUTE FUNCTION fairshift_append_only_record();
