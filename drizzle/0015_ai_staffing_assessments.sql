CREATE TABLE "ai_staffing_assessments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organisation_id" uuid NOT NULL,
	"outlet_id" uuid,
	"scope_key" text NOT NULL,
	"input_version" text NOT NULL,
	"output_schema_version" text NOT NULL,
	"input_fingerprint" text NOT NULL,
	"input" jsonb NOT NULL,
	"location_keys" jsonb NOT NULL,
	"planning_start" date,
	"planning_end" date,
	"evidence_through" date,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"response_model" text,
	"provider_response_id" text,
	"status" text NOT NULL,
	"failure_code" text,
	"assessment" jsonb,
	"requested_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_staffing_assessments_status_check" CHECK (("ai_staffing_assessments"."status" = 'AVAILABLE' and "ai_staffing_assessments"."assessment" is not null and "ai_staffing_assessments"."failure_code" is null and "ai_staffing_assessments"."response_model" is not null)
    or ("ai_staffing_assessments"."status" = 'FAILED' and "ai_staffing_assessments"."assessment" is null and "ai_staffing_assessments"."failure_code" is not null)),
	CONSTRAINT "ai_staffing_assessments_scope_check" CHECK (("ai_staffing_assessments"."scope_key" = 'ORGANISATION' and "ai_staffing_assessments"."outlet_id" is null) or ("ai_staffing_assessments"."outlet_id" is not null and "ai_staffing_assessments"."scope_key" = 'LOCATION:' || "ai_staffing_assessments"."outlet_id"::text)),
	CONSTRAINT "ai_staffing_assessments_fingerprint_check" CHECK ("ai_staffing_assessments"."input_fingerprint" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
ALTER TABLE "ai_staffing_assessments" ADD CONSTRAINT "ai_staffing_assessments_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_staffing_assessments" ADD CONSTRAINT "ai_staffing_assessments_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_staffing_assessments" ADD CONSTRAINT "ai_staffing_assessments_requested_by_auth_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."auth_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ai_staffing_assessments_scope_idx" ON "ai_staffing_assessments" USING btree ("organisation_id","scope_key","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "ai_staffing_assessments_current_unique" ON "ai_staffing_assessments" USING btree ("organisation_id","scope_key","input_fingerprint") WHERE "ai_staffing_assessments"."status" = 'AVAILABLE';--> statement-breakpoint
-- Assessments are an audit record of what the model was given and returned: a
-- location-scoped row must name a location of its organisation, and rows are never
-- changed or deleted. A newer assessment supersedes an older one by fingerprint.
CREATE FUNCTION fairshift_ai_assessment_integrity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'AI staffing assessments are immutable'; END IF;
 IF NEW.outlet_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM outlets WHERE id = NEW.outlet_id AND organisation_id = NEW.organisation_id) THEN
   RAISE EXCEPTION 'AI staffing assessment location must belong to its organisation';
 END IF;
 RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER fairshift_ai_assessment_integrity BEFORE INSERT OR UPDATE OR DELETE ON ai_staffing_assessments FOR EACH ROW EXECUTE FUNCTION fairshift_ai_assessment_integrity();
