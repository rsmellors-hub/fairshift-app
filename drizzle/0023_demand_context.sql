CREATE TABLE "demand_context_decisions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organisation_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"target_date" date NOT NULL,
	"sequence" integer NOT NULL,
	"proposal_id" uuid NOT NULL,
	"action" text NOT NULL,
	"scenario" text NOT NULL,
	"adjustment_bps" integer NOT NULL,
	"policy_version" text NOT NULL,
	"input_fingerprint" text NOT NULL,
	"output_fingerprint" text NOT NULL,
	"signal_ids" jsonb NOT NULL,
	"decided_by" uuid NOT NULL,
	"decided_by_role" text NOT NULL,
	"decided_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "demand_context_decisions_action_check" CHECK ("demand_context_decisions"."action" in ('ACCEPTED', 'DISMISSED', 'WITHDRAWN')),
	CONSTRAINT "demand_context_decisions_scenario_check" CHECK (("demand_context_decisions"."scenario" = 'NONE' and "demand_context_decisions"."adjustment_bps" = 0) or ("demand_context_decisions"."scenario" = 'MINOR_UP' and "demand_context_decisions"."adjustment_bps" = 500)
    or ("demand_context_decisions"."scenario" = 'MODERATE_UP' and "demand_context_decisions"."adjustment_bps" = 1000) or ("demand_context_decisions"."scenario" = 'MINOR_DOWN' and "demand_context_decisions"."adjustment_bps" = -500) or ("demand_context_decisions"."scenario" = 'MODERATE_DOWN' and "demand_context_decisions"."adjustment_bps" = -1000)),
	CONSTRAINT "demand_context_decisions_role_check" CHECK ("demand_context_decisions"."decided_by_role" in ('OWNER', 'MANAGER'))
);
--> statement-breakpoint
CREATE TABLE "demand_context_proposals" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organisation_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"target_date" date NOT NULL,
	"policy_version" text NOT NULL,
	"input_version" text NOT NULL,
	"output_schema_version" text NOT NULL,
	"input_fingerprint" text NOT NULL,
	"input" jsonb NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"response_model" text,
	"provider_response_id" text,
	"status" text NOT NULL,
	"failure_code" text,
	"scenario" text,
	"cited_signal_ids" jsonb,
	"reason" text,
	"requested_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "demand_context_proposals_status_check" CHECK (("demand_context_proposals"."status" = 'AVAILABLE' and "demand_context_proposals"."scenario" in ('NONE', 'MINOR_UP', 'MODERATE_UP', 'MINOR_DOWN', 'MODERATE_DOWN') and "demand_context_proposals"."cited_signal_ids" is not null and "demand_context_proposals"."reason" is not null and "demand_context_proposals"."failure_code" is null and "demand_context_proposals"."response_model" is not null)
    or ("demand_context_proposals"."status" = 'FAILED' and "demand_context_proposals"."scenario" is null and "demand_context_proposals"."cited_signal_ids" is null and "demand_context_proposals"."reason" is null and "demand_context_proposals"."failure_code" is not null)),
	CONSTRAINT "demand_context_proposals_fingerprint_check" CHECK ("demand_context_proposals"."input_fingerprint" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "demand_context_signals" (
	"id" text PRIMARY KEY NOT NULL,
	"organisation_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"signal_type" text NOT NULL,
	"valid_from" date NOT NULL,
	"valid_to" date NOT NULL,
	"direction" text NOT NULL,
	"provenance" text NOT NULL,
	"source_label" text NOT NULL,
	"source_ref" text,
	"summary" text NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"entered_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"withdrawn_at" timestamp with time zone,
	"withdrawn_by" uuid,
	CONSTRAINT "demand_context_signals_type_check" CHECK ("demand_context_signals"."signal_type" in ('MOMENTUM', 'MANAGER_ENTERED', 'BANK_HOLIDAY')),
	CONSTRAINT "demand_context_signals_direction_check" CHECK ("demand_context_signals"."direction" in ('UP', 'DOWN', 'FLAT', 'UNSPECIFIED')),
	CONSTRAINT "demand_context_signals_provenance_check" CHECK (("demand_context_signals"."signal_type" = 'MOMENTUM' and "demand_context_signals"."provenance" = 'DETERMINISTIC_CALCULATION')
    or ("demand_context_signals"."signal_type" = 'MANAGER_ENTERED' and "demand_context_signals"."provenance" = 'MANAGER_ENTERED' and "demand_context_signals"."entered_by" is not null)
    or ("demand_context_signals"."signal_type" = 'BANK_HOLIDAY' and "demand_context_signals"."provenance" = 'OFFICIAL_SNAPSHOT')),
	CONSTRAINT "demand_context_signals_period_check" CHECK ("demand_context_signals"."valid_to" >= "demand_context_signals"."valid_from")
);
--> statement-breakpoint
ALTER TABLE "demand_context_decisions" ADD CONSTRAINT "demand_context_decisions_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "demand_context_decisions" ADD CONSTRAINT "demand_context_decisions_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "demand_context_decisions" ADD CONSTRAINT "demand_context_decisions_proposal_id_demand_context_proposals_id_fk" FOREIGN KEY ("proposal_id") REFERENCES "public"."demand_context_proposals"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "demand_context_decisions" ADD CONSTRAINT "demand_context_decisions_decided_by_auth_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."auth_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "demand_context_proposals" ADD CONSTRAINT "demand_context_proposals_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "demand_context_proposals" ADD CONSTRAINT "demand_context_proposals_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "demand_context_proposals" ADD CONSTRAINT "demand_context_proposals_requested_by_auth_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."auth_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "demand_context_signals" ADD CONSTRAINT "demand_context_signals_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "demand_context_signals" ADD CONSTRAINT "demand_context_signals_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "demand_context_signals" ADD CONSTRAINT "demand_context_signals_entered_by_auth_users_id_fk" FOREIGN KEY ("entered_by") REFERENCES "public"."auth_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "demand_context_signals" ADD CONSTRAINT "demand_context_signals_withdrawn_by_auth_users_id_fk" FOREIGN KEY ("withdrawn_by") REFERENCES "public"."auth_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "demand_context_decisions_sequence_unique" ON "demand_context_decisions" USING btree ("outlet_id","target_date","sequence");--> statement-breakpoint
CREATE INDEX "demand_context_decisions_scope_idx" ON "demand_context_decisions" USING btree ("organisation_id","outlet_id","target_date");--> statement-breakpoint
CREATE INDEX "demand_context_proposals_scope_idx" ON "demand_context_proposals" USING btree ("organisation_id","outlet_id","target_date","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "demand_context_proposals_current_unique" ON "demand_context_proposals" USING btree ("outlet_id","target_date","input_fingerprint") WHERE "demand_context_proposals"."status" = 'AVAILABLE';--> statement-breakpoint
CREATE INDEX "demand_context_signals_scope_idx" ON "demand_context_signals" USING btree ("organisation_id","outlet_id","valid_to");--> statement-breakpoint
-- A signal belongs to a location of its organisation and keeps what it said. It can only be withdrawn.
CREATE FUNCTION fairshift_demand_context_signal_integrity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Demand context signals cannot be deleted'; END IF;
 IF NOT EXISTS (SELECT 1 FROM outlets WHERE id = NEW.outlet_id AND organisation_id = NEW.organisation_id) THEN RAISE EXCEPTION 'A demand context signal must belong to a location of its organisation'; END IF;
 IF TG_OP = 'UPDATE' AND ((to_jsonb(NEW) - 'withdrawn_at' - 'withdrawn_by') <> (to_jsonb(OLD) - 'withdrawn_at' - 'withdrawn_by') OR OLD.withdrawn_at IS NOT NULL OR NEW.withdrawn_at IS NULL) THEN RAISE EXCEPTION 'A demand context signal can only be withdrawn'; END IF;
 RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER fairshift_demand_context_signal_integrity BEFORE INSERT OR UPDATE OR DELETE ON demand_context_signals FOR EACH ROW EXECUTE FUNCTION fairshift_demand_context_signal_integrity();
--> statement-breakpoint
-- A proposal is a frozen record of what was asked and answered.
CREATE FUNCTION fairshift_demand_context_proposal_integrity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'Demand context proposals are immutable'; END IF;
 IF NOT EXISTS (SELECT 1 FROM outlets WHERE id = NEW.outlet_id AND organisation_id = NEW.organisation_id) THEN RAISE EXCEPTION 'A demand context proposal must belong to a location of its organisation'; END IF;
 RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER fairshift_demand_context_proposal_integrity BEFORE INSERT OR UPDATE OR DELETE ON demand_context_proposals FOR EACH ROW EXECUTE FUNCTION fairshift_demand_context_proposal_integrity();
--> statement-breakpoint
-- A decision is append-only and must repeat exactly what its proposal said. Nothing can be typed in.
CREATE FUNCTION fairshift_demand_context_decision_integrity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'Demand context decisions are immutable'; END IF;
 IF NOT EXISTS (SELECT 1 FROM demand_context_proposals p WHERE p.id = NEW.proposal_id AND p.status = 'AVAILABLE' AND p.organisation_id = NEW.organisation_id AND p.outlet_id = NEW.outlet_id AND p.target_date = NEW.target_date AND p.scenario = NEW.scenario AND p.input_fingerprint = NEW.input_fingerprint AND p.policy_version = NEW.policy_version) THEN
   RAISE EXCEPTION 'A demand context decision must match its proposal';
 END IF;
 RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER fairshift_demand_context_decision_integrity BEFORE INSERT OR UPDATE OR DELETE ON demand_context_decisions FOR EACH ROW EXECUTE FUNCTION fairshift_demand_context_decision_integrity();
