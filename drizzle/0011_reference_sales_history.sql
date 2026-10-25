ALTER TABLE "sale_transactions" DROP CONSTRAINT "sale_transactions_source_check";--> statement-breakpoint
ALTER TABLE "sale_transactions" ADD COLUMN "occurred_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "sale_transactions_outlet_occurred_idx" ON "sale_transactions" USING btree ("outlet_id","occurred_at");--> statement-breakpoint
ALTER TABLE "sale_transactions" ADD CONSTRAINT "sale_transactions_reference_provenance_check" CHECK ("sale_transactions"."source" != 'REFERENCE' or (
      "sale_transactions"."paypal_order_id" is null and "sale_transactions"."paypal_capture_id" is null and
      "sale_transactions"."paypal_custom_id" is null and "sale_transactions"."provider_created_at" is null and
      "sale_transactions"."provider_updated_at" is null and "sale_transactions"."reconciled_at" is null and
      "sale_transactions"."verification_state" = 'PENDING' and "sale_transactions"."reconciliation_state" = 'NOT_RECONCILED' and
      "sale_transactions"."provider_status" = 'REFERENCE' and "sale_transactions"."occurred_at" is not null
    ));--> statement-breakpoint
ALTER TABLE "sale_transactions" ADD CONSTRAINT "sale_transactions_source_check" CHECK ("sale_transactions"."source" in ('PAYPAL_SANDBOX', 'DEMO_SEEDED', 'REFERENCE'));