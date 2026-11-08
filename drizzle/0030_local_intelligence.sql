CREATE TABLE "external_feeds" (
	"feed" text PRIMARY KEY NOT NULL,
	"source_url" text NOT NULL,
	"last_attempt_at" timestamp with time zone NOT NULL,
	"last_success_at" timestamp with time zone,
	"last_failure_code" text,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "external_feeds_feed_check" CHECK ("external_feeds"."feed" ~ '^(HOLIDAYS:[A-Z]{2}|ECB_EUROFXREF)$'),
	CONSTRAINT "external_feeds_source_check" CHECK ("external_feeds"."source_url" like 'https://%')
);
--> statement-breakpoint
CREATE TABLE "local_intelligence_decisions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organisation_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"target_date" date NOT NULL,
	"sequence" integer NOT NULL,
	"action" text NOT NULL,
	"adjustment_fingerprint" text NOT NULL,
	"adjustments" jsonb NOT NULL,
	"policy_version" text NOT NULL,
	"decided_by" uuid NOT NULL,
	"decided_by_role" text NOT NULL,
	"decided_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "local_intelligence_decisions_action_check" CHECK ("local_intelligence_decisions"."action" in ('ACCEPTED', 'WITHDRAWN')),
	CONSTRAINT "local_intelligence_decisions_role_check" CHECK ("local_intelligence_decisions"."decided_by_role" in ('OWNER', 'MANAGER')),
	CONSTRAINT "local_intelligence_decisions_fingerprint_check" CHECK ("local_intelligence_decisions"."adjustment_fingerprint" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "local_intelligence_runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organisation_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"trigger" text NOT NULL,
	"requested_by" uuid,
	"window_from" date NOT NULL,
	"window_to" date NOT NULL,
	"status" text NOT NULL,
	"failure_code" text,
	"policy_version" text NOT NULL,
	"output_version" text NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"response_model" text,
	"provider_response_id" text,
	"input" jsonb NOT NULL,
	"coverage" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"searches" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"consulted_urls" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"counts" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "local_intelligence_runs_kind_check" CHECK ("local_intelligence_runs"."kind" in ('DAILY', 'DISRUPTIONS')),
	CONSTRAINT "local_intelligence_runs_trigger_check" CHECK ("local_intelligence_runs"."trigger" in ('SCHEDULE', 'MANUAL')),
	CONSTRAINT "local_intelligence_runs_status_check" CHECK (("local_intelligence_runs"."status" = 'RUNNING' and "local_intelligence_runs"."failure_code" is null and "local_intelligence_runs"."completed_at" is null)
    or ("local_intelligence_runs"."status" = 'COMPLETED' and "local_intelligence_runs"."failure_code" is null and "local_intelligence_runs"."completed_at" is not null)
    or ("local_intelligence_runs"."status" = 'FAILED' and "local_intelligence_runs"."failure_code" is not null and "local_intelligence_runs"."completed_at" is not null)),
	CONSTRAINT "local_intelligence_runs_window_check" CHECK ("local_intelligence_runs"."window_to" >= "local_intelligence_runs"."window_from")
);
--> statement-breakpoint
CREATE TABLE "local_intelligence_signals" (
	"id" uuid PRIMARY KEY NOT NULL,
	"run_id" uuid NOT NULL,
	"organisation_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"signal_key" text NOT NULL,
	"status" text NOT NULL,
	"rejection_code" text,
	"server_note" text,
	"category" text NOT NULL,
	"other_label" text,
	"effect_type" text NOT NULL,
	"name" text NOT NULL,
	"valid_from" date NOT NULL,
	"valid_to" date NOT NULL,
	"start_minute" integer,
	"end_minute" integer,
	"date_certainty" text NOT NULL,
	"shift_blocks" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"roles" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"direction" text,
	"size_band" text,
	"severity" text,
	"closure_likely" boolean DEFAULT false NOT NULL,
	"confidence" text NOT NULL,
	"source_tier" text NOT NULL,
	"reasoning" text NOT NULL,
	"source_url" text NOT NULL,
	"source_title" text,
	"source_check" text NOT NULL,
	"source_http_status" integer,
	"consulted_in_search" text NOT NULL,
	"impact" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "local_intelligence_signals_status_check" CHECK (("local_intelligence_signals"."status" in ('ACCEPTED', 'UNCONFIRMED') and "local_intelligence_signals"."rejection_code" is null) or ("local_intelligence_signals"."status" = 'REJECTED' and "local_intelligence_signals"."rejection_code" is not null)),
	CONSTRAINT "local_intelligence_signals_source_check" CHECK ("local_intelligence_signals"."status" <> 'ACCEPTED' or ("local_intelligence_signals"."source_url" like 'https://%' and "local_intelligence_signals"."source_check" in ('REACHABLE', 'RESTRICTED') and "local_intelligence_signals"."consulted_in_search" in ('EXACT', 'SAME_SITE') and "local_intelligence_signals"."source_tier" in ('OFFICIAL', 'EVENT_ORGANISER', 'NEWS'))),
	CONSTRAINT "local_intelligence_signals_effect_check" CHECK ("local_intelligence_signals"."status" = 'REJECTED'
    or ("local_intelligence_signals"."effect_type" = 'DEMAND' and "local_intelligence_signals"."direction" in ('UP', 'DOWN') and "local_intelligence_signals"."size_band" in ('MINOR', 'MODERATE') and "local_intelligence_signals"."severity" is null and not "local_intelligence_signals"."closure_likely")
    or ("local_intelligence_signals"."effect_type" in ('CAPACITY', 'ACCESS') and "local_intelligence_signals"."direction" is null and "local_intelligence_signals"."size_band" is null and "local_intelligence_signals"."severity" in ('LOW', 'MEDIUM', 'HIGH') and ("local_intelligence_signals"."effect_type" = 'CAPACITY' or not "local_intelligence_signals"."closure_likely"))),
	CONSTRAINT "local_intelligence_signals_dates_check" CHECK ("local_intelligence_signals"."status" = 'REJECTED' or "local_intelligence_signals"."valid_to" >= "local_intelligence_signals"."valid_from"),
	CONSTRAINT "local_intelligence_signals_time_check" CHECK (("local_intelligence_signals"."start_minute" is null or ("local_intelligence_signals"."start_minute" >= 0 and "local_intelligence_signals"."start_minute" <= 1440)) and ("local_intelligence_signals"."end_minute" is null or ("local_intelligence_signals"."end_minute" >= 0 and "local_intelligence_signals"."end_minute" <= 1440)))
);
--> statement-breakpoint
CREATE TABLE "scheduled_jobs" (
	"job" text PRIMARY KEY NOT NULL,
	"lease_until" timestamp with time zone,
	"last_started_at" timestamp with time zone,
	"last_finished_at" timestamp with time zone,
	"last_success_at" timestamp with time zone,
	"last_failure_code" text,
	"last_result" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
ALTER TABLE "demand_context_signals" DROP CONSTRAINT "demand_context_signals_provenance_check";--> statement-breakpoint
ALTER TABLE "outlets" ADD COLUMN "location_profile" jsonb;--> statement-breakpoint
ALTER TABLE "outlets" ADD COLUMN "location_profile_source" text;--> statement-breakpoint
ALTER TABLE "local_intelligence_decisions" ADD CONSTRAINT "local_intelligence_decisions_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "local_intelligence_decisions" ADD CONSTRAINT "local_intelligence_decisions_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "local_intelligence_decisions" ADD CONSTRAINT "local_intelligence_decisions_decided_by_auth_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."auth_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "local_intelligence_runs" ADD CONSTRAINT "local_intelligence_runs_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "local_intelligence_runs" ADD CONSTRAINT "local_intelligence_runs_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "local_intelligence_runs" ADD CONSTRAINT "local_intelligence_runs_requested_by_auth_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."auth_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "local_intelligence_signals" ADD CONSTRAINT "local_intelligence_signals_run_id_local_intelligence_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."local_intelligence_runs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "local_intelligence_signals" ADD CONSTRAINT "local_intelligence_signals_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "local_intelligence_signals" ADD CONSTRAINT "local_intelligence_signals_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "local_intelligence_decisions_sequence_unique" ON "local_intelligence_decisions" USING btree ("outlet_id","target_date","sequence");--> statement-breakpoint
CREATE INDEX "local_intelligence_decisions_scope_idx" ON "local_intelligence_decisions" USING btree ("organisation_id","outlet_id","target_date");--> statement-breakpoint
CREATE INDEX "local_intelligence_runs_scope_idx" ON "local_intelligence_runs" USING btree ("organisation_id","outlet_id","created_at");--> statement-breakpoint
CREATE INDEX "local_intelligence_signals_run_idx" ON "local_intelligence_signals" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "local_intelligence_signals_scope_idx" ON "local_intelligence_signals" USING btree ("organisation_id","outlet_id","valid_to");--> statement-breakpoint
ALTER TABLE "demand_context_signals" ADD CONSTRAINT "demand_context_signals_provenance_check" CHECK (("demand_context_signals"."signal_type" = 'MOMENTUM' and "demand_context_signals"."provenance" = 'DETERMINISTIC_CALCULATION')
    or ("demand_context_signals"."signal_type" in ('MANAGER_ENTERED', 'BOOKINGS', 'LOCAL_EVENT', 'PROMOTION') and "demand_context_signals"."provenance" = 'MANAGER_ENTERED' and "demand_context_signals"."entered_by" is not null)
    or ("demand_context_signals"."signal_type" = 'LOCAL_EVENT' and "demand_context_signals"."provenance" = 'PROVIDER_EVENT')
    or ("demand_context_signals"."signal_type" = 'BANK_HOLIDAY' and "demand_context_signals"."provenance" in ('OFFICIAL_SNAPSHOT', 'HOLIDAY_FEED', 'HOLIDAY_FALLBACK'))
    or ("demand_context_signals"."signal_type" = 'WEATHER_FORECAST' and "demand_context_signals"."provenance" = 'PROVIDER_FORECAST'));--> statement-breakpoint
ALTER TABLE "outlets" ADD CONSTRAINT "outlets_location_profile_check" CHECK (("outlets"."location_profile" is null and "outlets"."location_profile_source" is null) or ("outlets"."location_profile" is not null and "outlets"."location_profile_source" in ('OWNER', 'DEMO_SEED')));--> statement-breakpoint
-- A judged signal is evidence for the forecast and the decisions made on it: never edited or deleted.
CREATE OR REPLACE FUNCTION fairshift_local_intelligence_signal_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 RAISE EXCEPTION 'Local intelligence signals are retained unchanged';
END $$;--> statement-breakpoint
CREATE TRIGGER local_intelligence_signals_immutable BEFORE UPDATE OR DELETE ON "local_intelligence_signals" FOR EACH ROW EXECUTE FUNCTION fairshift_local_intelligence_signal_immutable();
