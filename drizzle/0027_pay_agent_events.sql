CREATE TABLE "pay_agent_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organisation_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"payable_id" uuid NOT NULL,
	"evidence_version" text NOT NULL,
	"trigger" text NOT NULL,
	"created_by" uuid,
	"status" text NOT NULL,
	"outcome_code" text,
	"error_class" text,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"model_call_count" integer DEFAULT 0 NOT NULL,
	"claim_token" uuid,
	"claimed_at" timestamp with time zone,
	"lease_expires_at" timestamp with time zone,
	"next_attempt_at" timestamp with time zone,
	"configured_model" text,
	"response_model" text,
	"response_id" text,
	"decision" text,
	"reason_code" text,
	"summary" text,
	"decided_at" timestamp with time zone,
	"dry_run" boolean,
	"payout_id" uuid,
	"resolution" text,
	"resolved_by" uuid,
	"resolved_at" timestamp with time zone,
	"resolution_note" text,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pay_agent_events_status_check" CHECK ("pay_agent_events"."status" in ('PENDING', 'CLAIMED', 'SKIPPED', 'BLOCKED', 'REJECTED_OUTPUT', 'FAILED_RETRYABLE', 'FAILED_TERMINAL', 'DECIDED_SETTLE', 'DECIDED_HOLD', 'HOLD_RELEASED', 'HOLD_REJECTED', 'SETTLING', 'DRY_RUN_ELIGIBLE', 'SETTLEMENT_BLOCKED', 'SETTLEMENT_SUBMITTED')),
	CONSTRAINT "pay_agent_events_trigger_check" CHECK ("pay_agent_events"."trigger" in ('WORK_CONFIRMED', 'PERFORMANCE_CONFIRMED', 'EVIDENCE_REFRESHED')),
	CONSTRAINT "pay_agent_events_version_check" CHECK ("pay_agent_events"."evidence_version" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "pay_agent_events_counts_check" CHECK ("pay_agent_events"."attempt_count" >= 0 and "pay_agent_events"."model_call_count" >= 0 and "pay_agent_events"."model_call_count" <= "pay_agent_events"."attempt_count"),
	CONSTRAINT "pay_agent_events_claim_check" CHECK (("pay_agent_events"."status" in ('CLAIMED', 'SETTLING')) = ("pay_agent_events"."claim_token" is not null and "pay_agent_events"."lease_expires_at" is not null and "pay_agent_events"."claimed_at" is not null)),
	CONSTRAINT "pay_agent_events_outcome_check" CHECK ("pay_agent_events"."status" in ('PENDING', 'CLAIMED', 'DECIDED_SETTLE', 'DECIDED_HOLD', 'HOLD_RELEASED', 'SETTLING') or "pay_agent_events"."outcome_code" is not null),
	CONSTRAINT "pay_agent_events_error_check" CHECK ("pay_agent_events"."status" not in ('REJECTED_OUTPUT', 'FAILED_RETRYABLE', 'FAILED_TERMINAL') or "pay_agent_events"."error_class" is not null),
	CONSTRAINT "pay_agent_events_codes_check" CHECK (coalesce(char_length("pay_agent_events"."outcome_code"), 0) <= 64 and coalesce(char_length("pay_agent_events"."error_class"), 0) <= 64 and coalesce(char_length("pay_agent_events"."response_id"), 0) <= 200 and coalesce(char_length("pay_agent_events"."configured_model"), 0) <= 100 and coalesce(char_length("pay_agent_events"."response_model"), 0) <= 100),
	CONSTRAINT "pay_agent_events_decision_check" CHECK (("pay_agent_events"."decision" is null and "pay_agent_events"."reason_code" is null and "pay_agent_events"."summary" is null and "pay_agent_events"."decided_at" is null)
    or ("pay_agent_events"."decision" = 'SETTLE' and "pay_agent_events"."reason_code" is null and "pay_agent_events"."summary" is null and "pay_agent_events"."decided_at" is not null)
    or ("pay_agent_events"."decision" = 'HOLD' and "pay_agent_events"."reason_code" in ('HOURS_MISMATCH', 'INCOMPLETE_EVIDENCE', 'CONFIRMATION_DELAY', 'CONFLICTING_RECORDS') and char_length("pay_agent_events"."summary") between 1 and 200 and "pay_agent_events"."decided_at" is not null)),
	CONSTRAINT "pay_agent_events_decided_status_check" CHECK (("pay_agent_events"."status" not in ('DECIDED_HOLD', 'HOLD_RELEASED', 'HOLD_REJECTED') or "pay_agent_events"."decision" = 'HOLD') and ("pay_agent_events"."status" <> 'DECIDED_SETTLE' or "pay_agent_events"."decision" = 'SETTLE')),
	CONSTRAINT "pay_agent_events_resolution_check" CHECK (("pay_agent_events"."resolution" is null and "pay_agent_events"."resolved_by" is null and "pay_agent_events"."resolved_at" is null and "pay_agent_events"."resolution_note" is null)
    or ("pay_agent_events"."resolution" = 'RELEASED' and "pay_agent_events"."decision" = 'HOLD' and "pay_agent_events"."resolved_by" is not null and "pay_agent_events"."resolved_at" is not null and coalesce(char_length("pay_agent_events"."resolution_note"), 0) <= 500)
    or ("pay_agent_events"."resolution" = 'REJECTED' and "pay_agent_events"."decision" = 'HOLD' and "pay_agent_events"."resolved_by" is not null and "pay_agent_events"."resolved_at" is not null and char_length("pay_agent_events"."resolution_note") between 1 and 500)),
	CONSTRAINT "pay_agent_events_resolved_status_check" CHECK (("pay_agent_events"."status" <> 'HOLD_RELEASED' or "pay_agent_events"."resolution" = 'RELEASED') and ("pay_agent_events"."status" <> 'HOLD_REJECTED' or "pay_agent_events"."resolution" = 'REJECTED') and ("pay_agent_events"."status" <> 'DECIDED_HOLD' or "pay_agent_events"."resolution" is null)),
	CONSTRAINT "pay_agent_events_payout_check" CHECK (("pay_agent_events"."status" = 'SETTLEMENT_SUBMITTED') = ("pay_agent_events"."payout_id" is not null))
);
--> statement-breakpoint
ALTER TABLE "pay_agent_events" ADD CONSTRAINT "pay_agent_events_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pay_agent_events" ADD CONSTRAINT "pay_agent_events_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pay_agent_events" ADD CONSTRAINT "pay_agent_events_payable_id_work_payables_id_fk" FOREIGN KEY ("payable_id") REFERENCES "public"."work_payables"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pay_agent_events" ADD CONSTRAINT "pay_agent_events_created_by_auth_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."auth_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pay_agent_events" ADD CONSTRAINT "pay_agent_events_payout_id_work_payouts_id_fk" FOREIGN KEY ("payout_id") REFERENCES "public"."work_payouts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pay_agent_events" ADD CONSTRAINT "pay_agent_events_resolved_by_auth_users_id_fk" FOREIGN KEY ("resolved_by") REFERENCES "public"."auth_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "pay_agent_events_payable_version_unique" ON "pay_agent_events" USING btree ("payable_id","evidence_version");--> statement-breakpoint
CREATE INDEX "pay_agent_events_scope_idx" ON "pay_agent_events" USING btree ("organisation_id","outlet_id","payable_id","created_at");--> statement-breakpoint
CREATE INDEX "pay_agent_events_recovery_idx" ON "pay_agent_events" USING btree ("status","next_attempt_at");--> statement-breakpoint
-- Pay Agent events (DEC-SA-011): one durable orchestration record per payable and evidence
-- version, in the payable's own organisation and location, for confirmed work only. Rows are
-- never deleted. Identity, the evidence version, a recorded decision, a manager's resolution and
-- a payout reference are final. Status moves only along the state machine below. Taking a claim
-- needs a new fencing token, one more attempt and an unexpired lease, and a live claim can be
-- taken over only after its lease has expired. Which attempt owns a claim is checked by the
-- conditional update that finishes it (claim_token), so a fenced late writer changes nothing.
CREATE FUNCTION fairshift_pay_agent_event_integrity() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE allowed boolean;
BEGIN
 IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Pay Agent events are retained'; END IF;
 IF TG_OP = 'INSERT' THEN
   IF NEW.status NOT IN ('PENDING', 'SKIPPED', 'BLOCKED') OR NEW.attempt_count <> 0 OR NEW.model_call_count <> 0
     OR NEW.claim_token IS NOT NULL OR NEW.decision IS NOT NULL OR NEW.resolution IS NOT NULL OR NEW.payout_id IS NOT NULL THEN
     RAISE EXCEPTION 'Pay Agent events are created unprocessed';
   END IF;
   IF NOT EXISTS (SELECT 1 FROM work_payables p JOIN work_allocations a ON a.id = p.allocation_id
     WHERE p.id = NEW.payable_id AND p.organisation_id = NEW.organisation_id AND p.outlet_id = NEW.outlet_id AND a.confirmed_at IS NOT NULL) THEN
     RAISE EXCEPTION 'Pay Agent event must reference one confirmed payable in its organisation and location';
   END IF;
   RETURN NEW;
 END IF;
 IF ROW(NEW.id, NEW.organisation_id, NEW.outlet_id, NEW.payable_id, NEW.evidence_version, NEW.trigger, NEW.created_by, NEW.created_at)
   IS DISTINCT FROM ROW(OLD.id, OLD.organisation_id, OLD.outlet_id, OLD.payable_id, OLD.evidence_version, OLD.trigger, OLD.created_by, OLD.created_at) THEN
   RAISE EXCEPTION 'Pay Agent event identity is immutable';
 END IF;
 IF NEW.attempt_count < OLD.attempt_count OR NEW.model_call_count < OLD.model_call_count THEN
   RAISE EXCEPTION 'Pay Agent attempt counts never decrease';
 END IF;
 IF OLD.decision IS NOT NULL AND ROW(NEW.decision, NEW.reason_code, NEW.summary, NEW.decided_at) IS DISTINCT FROM ROW(OLD.decision, OLD.reason_code, OLD.summary, OLD.decided_at) THEN
   RAISE EXCEPTION 'A Pay Agent decision is final';
 END IF;
 IF OLD.resolution IS NOT NULL AND ROW(NEW.resolution, NEW.resolved_by, NEW.resolved_at, NEW.resolution_note) IS DISTINCT FROM ROW(OLD.resolution, OLD.resolved_by, OLD.resolved_at, OLD.resolution_note) THEN
   RAISE EXCEPTION 'A manager resolution of a Pay Agent hold is final';
 END IF;
 IF OLD.payout_id IS NOT NULL AND NEW.payout_id IS DISTINCT FROM OLD.payout_id THEN
   RAISE EXCEPTION 'A Pay Agent payout reference is final';
 END IF;
 IF NEW.payout_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM work_payouts WHERE id = NEW.payout_id AND payable_id = NEW.payable_id) THEN
   RAISE EXCEPTION 'A Pay Agent payout must belong to the event payable';
 END IF;
 IF NEW.status IN ('CLAIMED', 'SETTLING') AND (NEW.status IS DISTINCT FROM OLD.status OR NEW.claim_token IS DISTINCT FROM OLD.claim_token) THEN
   IF NEW.claim_token IS NOT DISTINCT FROM OLD.claim_token OR NEW.attempt_count <> OLD.attempt_count + 1 OR NEW.lease_expires_at <= now() THEN
     RAISE EXCEPTION 'A Pay Agent claim needs a new token, one more attempt and an unexpired lease';
   END IF;
   IF NEW.status = OLD.status AND OLD.lease_expires_at > now() THEN
     RAISE EXCEPTION 'An unexpired Pay Agent claim cannot be taken over';
   END IF;
 END IF;
 IF NEW.status IS DISTINCT FROM OLD.status OR (NEW.status IN ('CLAIMED', 'SETTLING') AND NEW.claim_token IS DISTINCT FROM OLD.claim_token) THEN
   allowed := CASE OLD.status
     WHEN 'PENDING' THEN NEW.status IN ('CLAIMED', 'SKIPPED', 'BLOCKED')
     WHEN 'CLAIMED' THEN NEW.status IN ('CLAIMED', 'SKIPPED', 'BLOCKED', 'REJECTED_OUTPUT', 'FAILED_RETRYABLE', 'FAILED_TERMINAL', 'DECIDED_SETTLE', 'DECIDED_HOLD')
     WHEN 'FAILED_RETRYABLE' THEN NEW.status = 'CLAIMED'
     WHEN 'REJECTED_OUTPUT' THEN NEW.status = 'CLAIMED'
     WHEN 'FAILED_TERMINAL' THEN NEW.status = 'CLAIMED'
     WHEN 'DECIDED_SETTLE' THEN NEW.status = 'SETTLING'
     WHEN 'DECIDED_HOLD' THEN NEW.status IN ('HOLD_RELEASED', 'HOLD_REJECTED')
     WHEN 'HOLD_RELEASED' THEN NEW.status = 'SETTLING'
     WHEN 'SETTLING' THEN NEW.status IN ('SETTLING', 'DRY_RUN_ELIGIBLE', 'SETTLEMENT_BLOCKED', 'SETTLEMENT_SUBMITTED')
     WHEN 'DRY_RUN_ELIGIBLE' THEN NEW.status = 'SETTLING'
     WHEN 'SETTLEMENT_BLOCKED' THEN NEW.status = 'SETTLING'
     ELSE false
   END;
   IF NOT allowed THEN RAISE EXCEPTION 'Invalid Pay Agent status transition from % to %', OLD.status, NEW.status; END IF;
 END IF;
 RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER fairshift_pay_agent_event_integrity BEFORE INSERT OR UPDATE OR DELETE ON pay_agent_events FOR EACH ROW EXECUTE FUNCTION fairshift_pay_agent_event_integrity();
