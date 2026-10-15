CREATE TABLE "shift_offers" (
	"id" uuid PRIMARY KEY NOT NULL,
	"shift_id" uuid NOT NULL,
	"worker_id" uuid NOT NULL,
	"status" text DEFAULT 'OFFERED' NOT NULL,
	"offered_at" timestamp with time zone DEFAULT now() NOT NULL,
	"responded_at" timestamp with time zone,
	"accepted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "shift_offers_status_check" CHECK ("shift_offers"."status" in ('OFFERED', 'ACCEPTED', 'DECLINED', 'CANCELLED')),
	CONSTRAINT "shift_offers_acceptance_check" CHECK (("shift_offers"."status" = 'ACCEPTED' and "shift_offers"."accepted_at" is not null and "shift_offers"."responded_at" is not null)
          or ("shift_offers"."status" != 'ACCEPTED' and "shift_offers"."accepted_at" is null))
);
--> statement-breakpoint
CREATE TABLE "shifts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"outlet_id" uuid NOT NULL,
	"shift_date" date NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"role_name" text NOT NULL,
	"status" text DEFAULT 'DRAFT' NOT NULL,
	"currency_code" text NOT NULL,
	"guaranteed_base_pay_minor" bigint NOT NULL,
	"gratuity_policy" text NOT NULL,
	"incentive_policy" text NOT NULL,
	"published_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "shifts_status_check" CHECK ("shifts"."status" in ('DRAFT', 'PUBLISHED', 'CANCELLED', 'COMPLETED')),
	CONSTRAINT "shifts_currency_code_check" CHECK (char_length("shifts"."currency_code") = 3),
	CONSTRAINT "shifts_base_pay_nonnegative" CHECK ("shifts"."guaranteed_base_pay_minor" >= 0),
	CONSTRAINT "shifts_time_order_check" CHECK ("shifts"."ends_at" > "shifts"."starts_at")
);
--> statement-breakpoint
CREATE TABLE "workers" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organisation_id" uuid NOT NULL,
	"display_name" text NOT NULL,
	"worker_type" text NOT NULL,
	"status" text DEFAULT 'ACTIVE' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workers_type_check" CHECK ("workers"."worker_type" in ('REGULAR', 'CASUAL')),
	CONSTRAINT "workers_status_check" CHECK ("workers"."status" in ('ACTIVE', 'INACTIVE'))
);
--> statement-breakpoint
ALTER TABLE "shift_offers" ADD CONSTRAINT "shift_offers_shift_id_shifts_id_fk" FOREIGN KEY ("shift_id") REFERENCES "public"."shifts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shift_offers" ADD CONSTRAINT "shift_offers_worker_id_workers_id_fk" FOREIGN KEY ("worker_id") REFERENCES "public"."workers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shifts" ADD CONSTRAINT "shifts_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workers" ADD CONSTRAINT "workers_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "shift_offers_shift_worker_unique" ON "shift_offers" USING btree ("shift_id","worker_id");--> statement-breakpoint
CREATE INDEX "shift_offers_worker_status_idx" ON "shift_offers" USING btree ("worker_id","status");--> statement-breakpoint
CREATE INDEX "shifts_outlet_date_idx" ON "shifts" USING btree ("outlet_id","shift_date");--> statement-breakpoint
CREATE INDEX "workers_organisation_idx" ON "workers" USING btree ("organisation_id");