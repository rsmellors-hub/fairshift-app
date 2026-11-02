CREATE TABLE "demand_context_feeds" (
	"organisation_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"feed" text NOT NULL,
	"last_attempt_at" timestamp with time zone NOT NULL,
	"last_success_at" timestamp with time zone,
	"last_failure_code" text,
	"current_signal_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	CONSTRAINT "demand_context_feeds_outlet_id_feed_pk" PRIMARY KEY("outlet_id","feed"),
	CONSTRAINT "demand_context_feeds_feed_check" CHECK ("demand_context_feeds"."feed" in ('WEATHER', 'EVENTS'))
);
--> statement-breakpoint
ALTER TABLE "demand_context_signals" DROP CONSTRAINT "demand_context_signals_type_check";--> statement-breakpoint
ALTER TABLE "demand_context_signals" DROP CONSTRAINT "demand_context_signals_provenance_check";--> statement-breakpoint
ALTER TABLE "demand_context_decisions" ADD COLUMN "period_start" integer;--> statement-breakpoint
ALTER TABLE "demand_context_decisions" ADD COLUMN "period_end" integer;--> statement-breakpoint
ALTER TABLE "demand_context_proposals" ADD COLUMN "period_start" integer;--> statement-breakpoint
ALTER TABLE "demand_context_proposals" ADD COLUMN "period_end" integer;--> statement-breakpoint
ALTER TABLE "demand_context_signals" ADD COLUMN "period_start" integer;--> statement-breakpoint
ALTER TABLE "demand_context_signals" ADD COLUMN "period_end" integer;--> statement-breakpoint
ALTER TABLE "outlets" ADD COLUMN "venue_profile" text;--> statement-breakpoint
ALTER TABLE "outlets" ADD COLUMN "latitude" double precision;--> statement-breakpoint
ALTER TABLE "outlets" ADD COLUMN "longitude" double precision;--> statement-breakpoint
ALTER TABLE "outlets" ADD COLUMN "venue_context_source" text;--> statement-breakpoint
ALTER TABLE "demand_context_feeds" ADD CONSTRAINT "demand_context_feeds_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "demand_context_feeds" ADD CONSTRAINT "demand_context_feeds_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "demand_context_proposals" ADD CONSTRAINT "demand_context_proposals_period_check" CHECK (("demand_context_proposals"."period_start" is null and "demand_context_proposals"."period_end" is null) or ("demand_context_proposals"."status" = 'AVAILABLE' and "demand_context_proposals"."period_start" >= 0 and "demand_context_proposals"."period_end" <= 1440 and "demand_context_proposals"."period_start" < "demand_context_proposals"."period_end"));--> statement-breakpoint
ALTER TABLE "demand_context_signals" ADD CONSTRAINT "demand_context_signals_time_check" CHECK (("demand_context_signals"."period_start" is null and "demand_context_signals"."period_end" is null) or ("demand_context_signals"."period_start" >= 0 and "demand_context_signals"."period_end" <= 1440 and "demand_context_signals"."period_start" < "demand_context_signals"."period_end"));--> statement-breakpoint
ALTER TABLE "demand_context_signals" ADD CONSTRAINT "demand_context_signals_type_check" CHECK ("demand_context_signals"."signal_type" in ('MOMENTUM', 'MANAGER_ENTERED', 'BANK_HOLIDAY', 'WEATHER_FORECAST', 'BOOKINGS', 'LOCAL_EVENT', 'PROMOTION'));--> statement-breakpoint
ALTER TABLE "demand_context_signals" ADD CONSTRAINT "demand_context_signals_provenance_check" CHECK (("demand_context_signals"."signal_type" = 'MOMENTUM' and "demand_context_signals"."provenance" = 'DETERMINISTIC_CALCULATION')
    or ("demand_context_signals"."signal_type" in ('MANAGER_ENTERED', 'BOOKINGS', 'LOCAL_EVENT', 'PROMOTION') and "demand_context_signals"."provenance" = 'MANAGER_ENTERED' and "demand_context_signals"."entered_by" is not null)
    or ("demand_context_signals"."signal_type" = 'LOCAL_EVENT' and "demand_context_signals"."provenance" = 'PROVIDER_EVENT')
    or ("demand_context_signals"."signal_type" = 'BANK_HOLIDAY' and "demand_context_signals"."provenance" = 'OFFICIAL_SNAPSHOT')
    or ("demand_context_signals"."signal_type" = 'WEATHER_FORECAST' and "demand_context_signals"."provenance" = 'PROVIDER_FORECAST'));--> statement-breakpoint
ALTER TABLE "outlets" ADD CONSTRAINT "outlets_venue_profile_check" CHECK ("outlets"."venue_profile" is null or "outlets"."venue_profile" in ('STADIUM_DISTRICT', 'WATERFRONT_OUTDOOR', 'BUSINESS_DISTRICT', 'STATION_COMMUTER', 'SHOPPING_CENTRE'));--> statement-breakpoint
ALTER TABLE "outlets" ADD CONSTRAINT "outlets_coordinates_check" CHECK (("outlets"."latitude" is null and "outlets"."longitude" is null) or ("outlets"."latitude" between -90 and 90 and "outlets"."longitude" between -180 and 180));--> statement-breakpoint
ALTER TABLE "outlets" ADD CONSTRAINT "outlets_venue_context_source_check" CHECK ("outlets"."venue_context_source" is null or "outlets"."venue_context_source" in ('REFERENCE', 'CONFIGURED'));--> statement-breakpoint
-- A decision must also repeat its proposal's period.
CREATE OR REPLACE FUNCTION fairshift_demand_context_decision_integrity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'Demand context decisions are immutable'; END IF;
 IF NOT EXISTS (SELECT 1 FROM demand_context_proposals p WHERE p.id = NEW.proposal_id AND p.status = 'AVAILABLE' AND p.organisation_id = NEW.organisation_id AND p.outlet_id = NEW.outlet_id AND p.target_date = NEW.target_date AND p.scenario = NEW.scenario AND p.input_fingerprint = NEW.input_fingerprint AND p.policy_version = NEW.policy_version AND p.period_start IS NOT DISTINCT FROM NEW.period_start AND p.period_end IS NOT DISTINCT FROM NEW.period_end) THEN
   RAISE EXCEPTION 'A demand context decision must match its proposal';
 END IF;
 RETURN NEW;
END $$;
