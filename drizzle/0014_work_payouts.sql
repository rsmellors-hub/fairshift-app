CREATE TABLE "work_payouts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"payable_id" uuid NOT NULL,
	"organisation_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"worker_id" uuid NOT NULL,
	"amount_minor" bigint NOT NULL,
	"currency_code" text NOT NULL,
	"recipient" text NOT NULL,
	"sender_batch_id" text NOT NULL,
	"sender_item_id" text NOT NULL,
	"status" text NOT NULL,
	"paypal_batch_id" text,
	"paypal_item_id" text,
	"paypal_transaction_id" text,
	"paypal_batch_status" text,
	"paypal_status" text,
	"last_error" jsonb,
	"attempts" integer DEFAULT 1 NOT NULL,
	"requested_by" uuid,
	"reserved_at" timestamp with time zone NOT NULL,
	"submitted_at" timestamp with time zone,
	"status_checked_at" timestamp with time zone,
	"paid_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "work_payouts_status_check" CHECK ("work_payouts"."status" in ('SUBMITTING', 'NOT_SENT', 'PROCESSING', 'PAID', 'FAILED', 'RECONCILIATION_REQUIRED')),
	CONSTRAINT "work_payouts_amount_check" CHECK ("work_payouts"."amount_minor" > 0 and "work_payouts"."amount_minor" <= 9007199254740991 and "work_payouts"."currency_code" ~ '^[A-Z]{3}$' and "work_payouts"."attempts" > 0),
	CONSTRAINT "work_payouts_provider_check" CHECK (("work_payouts"."status" not in ('PROCESSING', 'PAID') or "work_payouts"."paypal_batch_id" is not null) and ("work_payouts"."status" not in ('SUBMITTING', 'NOT_SENT') or "work_payouts"."paypal_batch_id" is null)),
	CONSTRAINT "work_payouts_paid_check" CHECK (("work_payouts"."status" = 'PAID') = ("work_payouts"."paid_at" is not null and coalesce("work_payouts"."paypal_status", '') = 'SUCCESS'))
);
--> statement-breakpoint
ALTER TABLE "work_payables" DROP CONSTRAINT "work_payables_status_check";--> statement-breakpoint
ALTER TABLE "work_payables" ADD COLUMN "approved_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "work_payables" ADD COLUMN "approved_by" uuid;--> statement-breakpoint
ALTER TABLE "work_payables" ADD COLUMN "approved_amount_minor" bigint;--> statement-breakpoint
ALTER TABLE "work_payables" ADD COLUMN "approved_currency_code" text;--> statement-breakpoint
ALTER TABLE "work_payouts" ADD CONSTRAINT "work_payouts_payable_id_work_payables_id_fk" FOREIGN KEY ("payable_id") REFERENCES "public"."work_payables"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_payouts" ADD CONSTRAINT "work_payouts_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_payouts" ADD CONSTRAINT "work_payouts_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_payouts" ADD CONSTRAINT "work_payouts_worker_id_workers_id_fk" FOREIGN KEY ("worker_id") REFERENCES "public"."workers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_payouts" ADD CONSTRAINT "work_payouts_requested_by_auth_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."auth_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "work_payouts_payable_unique" ON "work_payouts" USING btree ("payable_id");--> statement-breakpoint
CREATE UNIQUE INDEX "work_payouts_sender_batch_unique" ON "work_payouts" USING btree ("sender_batch_id");--> statement-breakpoint
CREATE UNIQUE INDEX "work_payouts_sender_item_unique" ON "work_payouts" USING btree ("sender_item_id");--> statement-breakpoint
CREATE UNIQUE INDEX "work_payouts_paypal_batch_unique" ON "work_payouts" USING btree ("paypal_batch_id");--> statement-breakpoint
CREATE INDEX "work_payouts_scope_idx" ON "work_payouts" USING btree ("organisation_id","outlet_id");--> statement-breakpoint
CREATE INDEX "work_payouts_worker_idx" ON "work_payouts" USING btree ("worker_id");--> statement-breakpoint
ALTER TABLE "work_payables" ADD CONSTRAINT "work_payables_approved_by_auth_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."auth_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_payables" ADD CONSTRAINT "work_payables_approval_check" CHECK (("work_payables"."status" = 'PENDING_REVIEW' and "work_payables"."approved_at" is null and "work_payables"."approved_by" is null and "work_payables"."approved_amount_minor" is null and "work_payables"."approved_currency_code" is null)
    or ("work_payables"."status" = 'APPROVED' and "work_payables"."approved_at" is not null and "work_payables"."approved_by" is not null and "work_payables"."approved_amount_minor" = "work_payables"."base_amount_minor" and "work_payables"."approved_currency_code" = "work_payables"."currency_code"));--> statement-breakpoint
ALTER TABLE "work_payables" ADD CONSTRAINT "work_payables_status_check" CHECK ("work_payables"."status" in ('PENDING_REVIEW', 'APPROVED'));--> statement-breakpoint
-- Approval is the only change a payable's status can undergo: PENDING_REVIEW to
-- APPROVED, once, recording who approved which amount. A payable is created awaiting
-- review, and an approval is final. All other rules of 0013 are unchanged.
CREATE OR REPLACE FUNCTION fairshift_work_payable_integrity() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE terms jsonb;
BEGIN
 IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Work payables are retained'; END IF;
 IF TG_OP = 'UPDATE' THEN
   IF ROW(NEW.id, NEW.organisation_id, NEW.outlet_id, NEW.shift_id, NEW.worker_id, NEW.offer_id, NEW.allocation_id, NEW.acceptance_id, NEW.terms_version, NEW.calculation_method, NEW.earnings_model, NEW.currency_code, NEW.rate_minor, NEW.scheduled_starts_at, NEW.scheduled_ends_at, NEW.base_amount_minor, NEW.confirmed_at, NEW.confirmed_by, NEW.created_at)
   IS DISTINCT FROM ROW(OLD.id, OLD.organisation_id, OLD.outlet_id, OLD.shift_id, OLD.worker_id, OLD.offer_id, OLD.allocation_id, OLD.acceptance_id, OLD.terms_version, OLD.calculation_method, OLD.earnings_model, OLD.currency_code, OLD.rate_minor, OLD.scheduled_starts_at, OLD.scheduled_ends_at, OLD.base_amount_minor, OLD.confirmed_at, OLD.confirmed_by, OLD.created_at) THEN
     RAISE EXCEPTION 'Work payable financial facts are immutable';
   END IF;
   IF OLD.status = 'APPROVED' AND ROW(NEW.status, NEW.approved_at, NEW.approved_by, NEW.approved_amount_minor, NEW.approved_currency_code)
     IS DISTINCT FROM ROW(OLD.status, OLD.approved_at, OLD.approved_by, OLD.approved_amount_minor, OLD.approved_currency_code) THEN
     RAISE EXCEPTION 'Work payable approval is final';
   END IF;
   RETURN NEW;
 END IF;
 IF NEW.status IS DISTINCT FROM 'PENDING_REVIEW' THEN RAISE EXCEPTION 'Work payables are created awaiting review'; END IF;
 IF NOT EXISTS (SELECT 1 FROM outlets WHERE id = NEW.outlet_id AND organisation_id = NEW.organisation_id)
  OR NOT EXISTS (SELECT 1 FROM shifts WHERE id = NEW.shift_id AND outlet_id = NEW.outlet_id AND terms_version = NEW.terms_version)
  OR NOT EXISTS (SELECT 1 FROM workers WHERE id = NEW.worker_id AND organisation_id = NEW.organisation_id)
  OR NOT EXISTS (SELECT 1 FROM shift_offers WHERE id = NEW.offer_id AND shift_id = NEW.shift_id AND worker_id = NEW.worker_id AND status = 'ACCEPTED')
  OR NOT EXISTS (SELECT 1 FROM work_allocations WHERE id = NEW.allocation_id AND offer_id = NEW.offer_id AND acceptance_id = NEW.acceptance_id AND state = 'ALLOCATED' AND date_trunc('milliseconds', confirmed_at) = date_trunc('milliseconds', NEW.confirmed_at)) THEN
   RAISE EXCEPTION 'Work payable must reference one confirmed allocation in its organisation and location';
 END IF;
 SELECT snapshot INTO terms FROM work_acceptances WHERE id = NEW.acceptance_id AND offer_id = NEW.offer_id AND worker_id = NEW.worker_id AND terms_version = NEW.terms_version;
 IF terms IS NULL OR terms->>'earningsModel' IS DISTINCT FROM NEW.earnings_model OR terms->>'currencyCode' IS DISTINCT FROM NEW.currency_code
  OR (terms->>'rateMinor')::bigint IS DISTINCT FROM NEW.rate_minor OR (terms->>'expectedEarningsMinor')::bigint IS DISTINCT FROM NEW.base_amount_minor
  OR (terms->>'startsAt')::timestamptz IS DISTINCT FROM NEW.scheduled_starts_at OR (terms->>'endsAt')::timestamptz IS DISTINCT FROM NEW.scheduled_ends_at THEN
   RAISE EXCEPTION 'Work payable must match the accepted terms';
 END IF;
 RETURN NEW;
END $$;
--> statement-breakpoint
-- A payout may only be reserved for an approved payable, in the payable's own
-- organisation, location and worker, for exactly the approved amount and currency.
-- Those facts and the sender IDs never change; PayPal identifiers, once recorded,
-- never change; the recipient may only be re-read when a payout that certainly never
-- reached PayPal is reserved again; and status moves only along the payout lifecycle.
-- Payouts are never deleted.
CREATE FUNCTION fairshift_work_payout_integrity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Work payouts are retained'; END IF;
 IF TG_OP = 'INSERT' THEN
   IF NEW.status IS DISTINCT FROM 'SUBMITTING' OR NEW.paypal_batch_id IS NOT NULL OR NEW.paid_at IS NOT NULL THEN
     RAISE EXCEPTION 'Work payouts are created as a reservation';
   END IF;
   IF NOT EXISTS (SELECT 1 FROM work_payables WHERE id = NEW.payable_id AND status = 'APPROVED' AND organisation_id = NEW.organisation_id
     AND outlet_id = NEW.outlet_id AND worker_id = NEW.worker_id AND approved_amount_minor = NEW.amount_minor AND approved_currency_code = NEW.currency_code) THEN
     RAISE EXCEPTION 'Work payout must match one approved payable';
   END IF;
   RETURN NEW;
 END IF;
 IF ROW(NEW.id, NEW.payable_id, NEW.organisation_id, NEW.outlet_id, NEW.worker_id, NEW.amount_minor, NEW.currency_code, NEW.sender_batch_id, NEW.sender_item_id, NEW.reserved_at, NEW.created_at)
   IS DISTINCT FROM ROW(OLD.id, OLD.payable_id, OLD.organisation_id, OLD.outlet_id, OLD.worker_id, OLD.amount_minor, OLD.currency_code, OLD.sender_batch_id, OLD.sender_item_id, OLD.reserved_at, OLD.created_at) THEN
   RAISE EXCEPTION 'Work payout facts are immutable';
 END IF;
 IF (OLD.paypal_batch_id IS NOT NULL AND NEW.paypal_batch_id IS DISTINCT FROM OLD.paypal_batch_id)
  OR (OLD.paypal_item_id IS NOT NULL AND NEW.paypal_item_id IS DISTINCT FROM OLD.paypal_item_id)
  OR (OLD.paypal_transaction_id IS NOT NULL AND NEW.paypal_transaction_id IS DISTINCT FROM OLD.paypal_transaction_id) THEN
   RAISE EXCEPTION 'PayPal payout identifiers are immutable';
 END IF;
 IF NEW.recipient IS DISTINCT FROM OLD.recipient AND NOT (OLD.status = 'NOT_SENT' AND NEW.status = 'SUBMITTING') THEN
   RAISE EXCEPTION 'Payout recipient is fixed once a payout may have been sent';
 END IF;
 IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
   (OLD.status = 'SUBMITTING' AND NEW.status IN ('NOT_SENT', 'PROCESSING', 'PAID', 'FAILED', 'RECONCILIATION_REQUIRED'))
   OR (OLD.status = 'NOT_SENT' AND NEW.status = 'SUBMITTING')
   OR (OLD.status = 'RECONCILIATION_REQUIRED' AND NEW.status IN ('SUBMITTING', 'PROCESSING', 'PAID', 'FAILED'))
   OR (OLD.status IN ('PROCESSING', 'PAID', 'FAILED') AND NEW.status IN ('PROCESSING', 'PAID', 'FAILED'))
 ) THEN
   RAISE EXCEPTION 'Invalid work payout status transition';
 END IF;
 RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER fairshift_work_payout_integrity BEFORE INSERT OR UPDATE OR DELETE ON work_payouts FOR EACH ROW EXECUTE FUNCTION fairshift_work_payout_integrity();
