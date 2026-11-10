CREATE TABLE "pay_queries" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organisation_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"worker_id" uuid NOT NULL,
	"payable_id" uuid NOT NULL,
	"topic" text NOT NULL,
	"message" text NOT NULL,
	"triage" jsonb NOT NULL,
	"status" text DEFAULT 'OPEN' NOT NULL,
	"answer" text,
	"answered_by" uuid,
	"answered_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pay_queries_topic_check" CHECK ("pay_queries"."topic" in ('HOURS', 'AMOUNT', 'TIPS', 'NOT_RECEIVED', 'OTHER')),
	CONSTRAINT "pay_queries_message_check" CHECK (char_length("pay_queries"."message") between 1 and 1000),
	CONSTRAINT "pay_queries_status_check" CHECK (("pay_queries"."status" = 'OPEN' and "pay_queries"."answer" is null and "pay_queries"."answered_at" is null)
    or ("pay_queries"."status" = 'ANSWERED' and char_length("pay_queries"."answer") between 1 and 1000 and "pay_queries"."answered_by" is not null and "pay_queries"."answered_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "payout_destination_changes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organisation_id" uuid NOT NULL,
	"worker_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"new_email" text NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"confirmed_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payout_destination_changes_final_check" CHECK ("payout_destination_changes"."confirmed_at" is null or "payout_destination_changes"."cancelled_at" is null)
);
--> statement-breakpoint
CREATE TABLE "worker_messages" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organisation_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"worker_id" uuid NOT NULL,
	"author_user_id" uuid NOT NULL,
	"from_worker" boolean NOT NULL,
	"body" text NOT NULL,
	"read_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "worker_messages_body_check" CHECK (char_length("worker_messages"."body") between 1 and 1000)
);
--> statement-breakpoint
ALTER TABLE "pay_queries" ADD CONSTRAINT "pay_queries_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pay_queries" ADD CONSTRAINT "pay_queries_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pay_queries" ADD CONSTRAINT "pay_queries_worker_id_workers_id_fk" FOREIGN KEY ("worker_id") REFERENCES "public"."workers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pay_queries" ADD CONSTRAINT "pay_queries_payable_id_work_payables_id_fk" FOREIGN KEY ("payable_id") REFERENCES "public"."work_payables"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pay_queries" ADD CONSTRAINT "pay_queries_answered_by_auth_users_id_fk" FOREIGN KEY ("answered_by") REFERENCES "public"."auth_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payout_destination_changes" ADD CONSTRAINT "payout_destination_changes_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payout_destination_changes" ADD CONSTRAINT "payout_destination_changes_worker_id_workers_id_fk" FOREIGN KEY ("worker_id") REFERENCES "public"."workers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payout_destination_changes" ADD CONSTRAINT "payout_destination_changes_user_id_auth_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."auth_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "worker_messages" ADD CONSTRAINT "worker_messages_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "worker_messages" ADD CONSTRAINT "worker_messages_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "worker_messages" ADD CONSTRAINT "worker_messages_worker_id_workers_id_fk" FOREIGN KEY ("worker_id") REFERENCES "public"."workers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "worker_messages" ADD CONSTRAINT "worker_messages_author_user_id_auth_users_id_fk" FOREIGN KEY ("author_user_id") REFERENCES "public"."auth_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "pay_queries_open_unique" ON "pay_queries" USING btree ("payable_id") WHERE "pay_queries"."status" = 'OPEN';--> statement-breakpoint
CREATE UNIQUE INDEX "payout_destination_changes_token_unique" ON "payout_destination_changes" USING btree ("token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "payout_destination_changes_open_unique" ON "payout_destination_changes" USING btree ("worker_id") WHERE "payout_destination_changes"."confirmed_at" is null and "payout_destination_changes"."cancelled_at" is null;--> statement-breakpoint
CREATE INDEX "worker_messages_thread_idx" ON "worker_messages" USING btree ("worker_id","outlet_id","created_at");