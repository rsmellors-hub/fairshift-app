CREATE TABLE "local_intelligence_outcomes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organisation_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"signal_id" uuid NOT NULL,
	"signal_key" text NOT NULL,
	"target_date" date NOT NULL,
	"predicted_direction" text NOT NULL,
	"size_band" text NOT NULL,
	"baseline_milli_transactions" integer NOT NULL,
	"actual_milli_transactions" integer NOT NULL,
	"actual_direction" text NOT NULL,
	"matched" boolean NOT NULL,
	"measured_against" text NOT NULL,
	"method" text NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "local_intelligence_outcomes_direction_check" CHECK ("local_intelligence_outcomes"."predicted_direction" in ('UP', 'DOWN') and "local_intelligence_outcomes"."actual_direction" in ('UP', 'DOWN', 'FLAT') and "local_intelligence_outcomes"."matched" = ("local_intelligence_outcomes"."predicted_direction" = "local_intelligence_outcomes"."actual_direction")),
	CONSTRAINT "local_intelligence_outcomes_source_check" CHECK ("local_intelligence_outcomes"."measured_against" = 'SYNTHETIC_REFERENCE'),
	CONSTRAINT "local_intelligence_outcomes_counts_check" CHECK ("local_intelligence_outcomes"."baseline_milli_transactions" >= 0 and "local_intelligence_outcomes"."actual_milli_transactions" >= 0)
);
--> statement-breakpoint
ALTER TABLE "local_intelligence_outcomes" ADD CONSTRAINT "local_intelligence_outcomes_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "local_intelligence_outcomes" ADD CONSTRAINT "local_intelligence_outcomes_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "local_intelligence_outcomes" ADD CONSTRAINT "local_intelligence_outcomes_signal_id_local_intelligence_signals_id_fk" FOREIGN KEY ("signal_id") REFERENCES "public"."local_intelligence_signals"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "local_intelligence_outcomes_unique" ON "local_intelligence_outcomes" USING btree ("outlet_id","signal_key","target_date");--> statement-breakpoint
CREATE INDEX "local_intelligence_outcomes_scope_idx" ON "local_intelligence_outcomes" USING btree ("organisation_id","outlet_id","target_date");--> statement-breakpoint
-- A measured outcome is evidence for the track record: never edited or deleted.
CREATE OR REPLACE FUNCTION fairshift_local_intelligence_outcome_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 RAISE EXCEPTION 'Local intelligence outcomes are retained unchanged';
END $$;--> statement-breakpoint
CREATE TRIGGER local_intelligence_outcomes_immutable BEFORE UPDATE OR DELETE ON "local_intelligence_outcomes" FOR EACH ROW EXECUTE FUNCTION fairshift_local_intelligence_outcome_immutable();
