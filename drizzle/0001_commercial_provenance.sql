ALTER TABLE "sale_transactions" ALTER COLUMN "paypal_custom_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "sale_transactions" ADD COLUMN "source" text DEFAULT 'PAYPAL_SANDBOX' NOT NULL;--> statement-breakpoint
ALTER TABLE "sale_transactions" ADD CONSTRAINT "sale_transactions_source_check" CHECK ("sale_transactions"."source" in ('PAYPAL_SANDBOX', 'DEMO_SEEDED'));--> statement-breakpoint
ALTER TABLE "sale_transactions" ADD CONSTRAINT "sale_transactions_demo_provenance_check" CHECK ("sale_transactions"."source" != 'DEMO_SEEDED' or (
      "sale_transactions"."paypal_order_id" is null and "sale_transactions"."paypal_capture_id" is null and
      "sale_transactions"."paypal_custom_id" is null and "sale_transactions"."provider_created_at" is null and
      "sale_transactions"."provider_updated_at" is null and "sale_transactions"."reconciled_at" is null and
      "sale_transactions"."verification_state" = 'PENDING' and "sale_transactions"."reconciliation_state" = 'NOT_RECONCILED' and
      "sale_transactions"."provider_status" = 'DEMO_SEEDED'
    ));
--> statement-breakpoint
ALTER TABLE "sale_transactions" ADD CONSTRAINT "sale_transactions_paypal_reference_check" CHECK ("sale_transactions"."source" != 'PAYPAL_SANDBOX' or "sale_transactions"."paypal_custom_id" is not null);
