CREATE TABLE "local_intelligence_signal_decisions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organisation_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"signal_key" text NOT NULL,
	"signal_id" uuid NOT NULL,
	"action" text NOT NULL,
	"decided_by" uuid NOT NULL,
	"decided_by_role" text NOT NULL,
	"decided_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "local_intelligence_signal_decisions_action_check" CHECK ("local_intelligence_signal_decisions"."action" in ('DISMISSED', 'RESTORED')),
	CONSTRAINT "local_intelligence_signal_decisions_role_check" CHECK ("local_intelligence_signal_decisions"."decided_by_role" in ('OWNER', 'MANAGER'))
);
--> statement-breakpoint
ALTER TABLE "local_intelligence_signal_decisions" ADD CONSTRAINT "local_intelligence_signal_decisions_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "local_intelligence_signal_decisions" ADD CONSTRAINT "local_intelligence_signal_decisions_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "local_intelligence_signal_decisions" ADD CONSTRAINT "local_intelligence_signal_decisions_signal_id_local_intelligence_signals_id_fk" FOREIGN KEY ("signal_id") REFERENCES "public"."local_intelligence_signals"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "local_intelligence_signal_decisions" ADD CONSTRAINT "local_intelligence_signal_decisions_decided_by_auth_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."auth_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "local_intelligence_signal_decisions_scope_idx" ON "local_intelligence_signal_decisions" USING btree ("organisation_id","outlet_id","signal_key","decided_at");--> statement-breakpoint
-- A dismissal or restoration is a record of who decided what: never edited or deleted.
CREATE OR REPLACE FUNCTION fairshift_local_intelligence_signal_decision_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 RAISE EXCEPTION 'Signal decisions are retained unchanged';
END $$;--> statement-breakpoint
CREATE TRIGGER local_intelligence_signal_decisions_immutable BEFORE UPDATE OR DELETE ON "local_intelligence_signal_decisions" FOR EACH ROW EXECUTE FUNCTION fairshift_local_intelligence_signal_decision_immutable();
