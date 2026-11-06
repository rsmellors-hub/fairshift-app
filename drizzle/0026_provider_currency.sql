-- Provider payout currency for work payouts (DEC-SA-012). amount_minor/currency_code remain
-- the worker's approved entitlement (checked against the payable by the trigger below);
-- provider_amount_minor/provider_currency are what is actually sent to PayPal, with the frozen
-- conversion rate (operating-currency micro-units per one provider unit) and its source. New
-- columns are added nullable and backfilled as an identity leg for existing payouts (all GBP/USD
-- with no conversion), then made NOT NULL, so existing records migrate safely.
ALTER TABLE "work_payouts" ADD COLUMN "provider_currency" text;--> statement-breakpoint
ALTER TABLE "work_payouts" ADD COLUMN "provider_amount_minor" bigint;--> statement-breakpoint
ALTER TABLE "work_payouts" ADD COLUMN "fx_rate_micros" bigint;--> statement-breakpoint
ALTER TABLE "work_payouts" ADD COLUMN "fx_rate_source" text;--> statement-breakpoint
UPDATE "work_payouts" SET "provider_currency" = "currency_code", "provider_amount_minor" = "amount_minor" WHERE "provider_currency" IS NULL OR "provider_amount_minor" IS NULL;--> statement-breakpoint
ALTER TABLE "work_payouts" ALTER COLUMN "provider_currency" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "work_payouts" ALTER COLUMN "provider_amount_minor" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "work_payouts" ADD CONSTRAINT "work_payouts_provider_amount_check" CHECK ("work_payouts"."provider_amount_minor" > 0 and "work_payouts"."provider_amount_minor" <= 9007199254740991 and "work_payouts"."provider_currency" ~ '^[A-Z]{3}$');--> statement-breakpoint
ALTER TABLE "work_payouts" ADD CONSTRAINT "work_payouts_provider_conversion_check" CHECK (("work_payouts"."fx_rate_micros" is null and "work_payouts"."fx_rate_source" is null and "work_payouts"."provider_currency" = "work_payouts"."currency_code" and "work_payouts"."provider_amount_minor" = "work_payouts"."amount_minor") or ("work_payouts"."fx_rate_micros" is not null and "work_payouts"."fx_rate_micros" > 0 and "work_payouts"."fx_rate_source" is not null and "work_payouts"."provider_currency" <> "work_payouts"."currency_code" and "work_payouts"."provider_amount_minor" = div("work_payouts"."amount_minor"::numeric * 1000000, "work_payouts"."fx_rate_micros"::numeric)));--> statement-breakpoint
-- Freeze the provider leg alongside the other immutable payout facts: once reserved, the
-- provider currency, provider amount, rate and rate source never change, so a later rate change
-- cannot alter a reservation and recovery re-sends the identical frozen request. Replaces the
-- function from 0014 with the provider fields added to the immutable-facts comparison; all
-- other rules (reservation shape, payable match, identifier and recipient and status rules) are
-- unchanged.
CREATE OR REPLACE FUNCTION fairshift_work_payout_integrity() RETURNS trigger LANGUAGE plpgsql AS $$
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
 IF ROW(NEW.id, NEW.payable_id, NEW.organisation_id, NEW.outlet_id, NEW.worker_id, NEW.amount_minor, NEW.currency_code, NEW.provider_currency, NEW.provider_amount_minor, NEW.fx_rate_micros, NEW.fx_rate_source, NEW.sender_batch_id, NEW.sender_item_id, NEW.reserved_at, NEW.created_at)
   IS DISTINCT FROM ROW(OLD.id, OLD.payable_id, OLD.organisation_id, OLD.outlet_id, OLD.worker_id, OLD.amount_minor, OLD.currency_code, OLD.provider_currency, OLD.provider_amount_minor, OLD.fx_rate_micros, OLD.fx_rate_source, OLD.sender_batch_id, OLD.sender_item_id, OLD.reserved_at, OLD.created_at) THEN
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