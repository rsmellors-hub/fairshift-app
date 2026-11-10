ALTER TABLE "work_policies" ADD COLUMN "effective_from" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "work_policies" ADD COLUMN "superseded_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "work_policies" ADD COLUMN "replaces_policy_id" uuid;--> statement-breakpoint
UPDATE "work_policies" SET "effective_from" = "created_at";
