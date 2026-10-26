CREATE TABLE "regular_staff_coverage" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organisation_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"iso_weekday" integer NOT NULL,
	"planned_minutes" integer NOT NULL,
	"source" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "regular_staff_coverage_weekday_check" CHECK ("regular_staff_coverage"."iso_weekday" between 1 and 7),
	CONSTRAINT "regular_staff_coverage_minutes_check" CHECK ("regular_staff_coverage"."planned_minutes" between 0 and 1440000),
	CONSTRAINT "regular_staff_coverage_source_check" CHECK ("regular_staff_coverage"."source" in ('REFERENCE'))
);
--> statement-breakpoint
ALTER TABLE "regular_staff_coverage" ADD CONSTRAINT "regular_staff_coverage_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "regular_staff_coverage" ADD CONSTRAINT "regular_staff_coverage_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "regular_staff_coverage_outlet_weekday_unique" ON "regular_staff_coverage" USING btree ("outlet_id","iso_weekday");--> statement-breakpoint
CREATE INDEX "regular_staff_coverage_organisation_idx" ON "regular_staff_coverage" USING btree ("organisation_id");--> statement-breakpoint
CREATE FUNCTION fairshift_regular_coverage_scope() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS (SELECT 1 FROM outlets WHERE id=NEW.outlet_id AND organisation_id=NEW.organisation_id) THEN RAISE EXCEPTION 'Regular coverage location must belong to its organisation'; END IF;
 RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER fairshift_regular_coverage_scope BEFORE INSERT OR UPDATE ON regular_staff_coverage FOR EACH ROW EXECUTE FUNCTION fairshift_regular_coverage_scope();
--> statement-breakpoint
-- Locations were created with a hard-coded Africa/Johannesburg time zone. Correct
-- those whose own country, or else whose organisation's country, is the United
-- Kingdom (mirrors timezoneForCountry in src/server/domain/timezone.ts).
UPDATE outlets SET timezone='Europe/London', updated_at=now()
FROM organisations
WHERE organisations.id=outlets.organisation_id AND outlets.timezone='Africa/Johannesburg'
 AND lower(trim(coalesce(outlets.country, organisations.country, ''))) IN ('united kingdom','uk','gb','great britain','england','scotland','wales','northern ireland');
