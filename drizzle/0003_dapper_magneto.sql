CREATE TABLE "shift_incentives" (
	"id" uuid PRIMARY KEY NOT NULL,
	"shift_id" uuid NOT NULL,
	"worker_id" uuid NOT NULL,
	"performance_sales_minor" bigint NOT NULL,
	"target_sales_minor" bigint NOT NULL,
	"earned_amount_minor" bigint NOT NULL,
	"status" text NOT NULL,
	"approved_at" timestamp with time zone,
	"approved_by" text,
	"payout_recipient" text,
	"paypal_sender_batch_id" text NOT NULL,
	"paypal_sender_item_id" text NOT NULL,
	"paypal_batch_id" text,
	"paypal_item_id" text,
	"paypal_status" text,
	"failure_code" text,
	"submitted_at" timestamp with time zone,
	"paid_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "shift_incentives_amounts_nonnegative" CHECK ("shift_incentives"."performance_sales_minor" >= 0 and "shift_incentives"."target_sales_minor" >= 0 and "shift_incentives"."earned_amount_minor" >= 0),
	CONSTRAINT "shift_incentives_status_check" CHECK ("shift_incentives"."status" in ('NOT_EARNED', 'EARNED', 'APPROVED', 'SUBMITTING', 'SUBMITTED', 'PROCESSING', 'PAID', 'FAILED')),
	CONSTRAINT "shift_incentives_approval_check" CHECK (("shift_incentives"."status" in ('APPROVED', 'SUBMITTING', 'SUBMITTED', 'PROCESSING', 'PAID', 'FAILED') and "shift_incentives"."approved_at" is not null and "shift_incentives"."approved_by" is not null) or ("shift_incentives"."status" in ('NOT_EARNED', 'EARNED') and "shift_incentives"."approved_at" is null and "shift_incentives"."approved_by" is null)),
	CONSTRAINT "shift_incentives_payout_eligibility_check" CHECK ("shift_incentives"."status" not in ('SUBMITTING', 'SUBMITTED', 'PROCESSING', 'PAID') or ("shift_incentives"."earned_amount_minor" > 0 and "shift_incentives"."payout_recipient" is not null and "shift_incentives"."approved_at" is not null))
);
--> statement-breakpoint
ALTER TABLE "shifts" ADD COLUMN "incentive_target_minor" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "shifts" ADD COLUMN "incentive_amount_minor" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "workers" ADD COLUMN "paypal_payout_email" text;--> statement-breakpoint
ALTER TABLE "shift_incentives" ADD CONSTRAINT "shift_incentives_shift_id_shifts_id_fk" FOREIGN KEY ("shift_id") REFERENCES "public"."shifts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shift_incentives" ADD CONSTRAINT "shift_incentives_worker_id_workers_id_fk" FOREIGN KEY ("worker_id") REFERENCES "public"."workers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "shift_incentives_shift_worker_unique" ON "shift_incentives" USING btree ("shift_id","worker_id");--> statement-breakpoint
CREATE UNIQUE INDEX "shift_incentives_sender_batch_unique" ON "shift_incentives" USING btree ("paypal_sender_batch_id");--> statement-breakpoint
CREATE UNIQUE INDEX "shift_incentives_sender_item_unique" ON "shift_incentives" USING btree ("paypal_sender_item_id");--> statement-breakpoint
CREATE UNIQUE INDEX "shift_incentives_paypal_batch_unique" ON "shift_incentives" USING btree ("paypal_batch_id");--> statement-breakpoint
CREATE INDEX "shift_incentives_worker_status_idx" ON "shift_incentives" USING btree ("worker_id","status");--> statement-breakpoint
ALTER TABLE "shifts" ADD CONSTRAINT "shifts_incentive_target_nonnegative" CHECK ("shifts"."incentive_target_minor" >= 0);--> statement-breakpoint
ALTER TABLE "shifts" ADD CONSTRAINT "shifts_incentive_amount_nonnegative" CHECK ("shifts"."incentive_amount_minor" >= 0);