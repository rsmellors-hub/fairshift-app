CREATE TABLE "worker_locations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organisation_id" uuid NOT NULL,
	"worker_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL,
	"added_by" uuid,
	"removed_at" timestamp with time zone,
	"removed_by" uuid
);
--> statement-breakpoint
ALTER TABLE "location_shift_rules" ADD COLUMN "cancellation_percent" integer DEFAULT 50 NOT NULL;--> statement-breakpoint
ALTER TABLE "location_shift_rules" ADD COLUMN "cancellation_window_minutes" integer DEFAULT 1440 NOT NULL;--> statement-breakpoint
ALTER TABLE "outlets" ADD COLUMN "customer_types" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "outlets" ADD COLUMN "customer_note" text;--> statement-breakpoint
ALTER TABLE "outlets" ADD COLUMN "venue_type" text;--> statement-breakpoint
ALTER TABLE "outlets" ADD COLUMN "seats" integer;--> statement-breakpoint
ALTER TABLE "outlets" ADD COLUMN "pin_confirmed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "shifts" ADD COLUMN "cancellation_percent" integer;--> statement-breakpoint
ALTER TABLE "shifts" ADD COLUMN "cancellation_window_minutes" integer;--> statement-breakpoint
ALTER TABLE "worker_locations" ADD CONSTRAINT "worker_locations_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "worker_locations" ADD CONSTRAINT "worker_locations_worker_id_workers_id_fk" FOREIGN KEY ("worker_id") REFERENCES "public"."workers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "worker_locations" ADD CONSTRAINT "worker_locations_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "worker_locations" ADD CONSTRAINT "worker_locations_added_by_auth_users_id_fk" FOREIGN KEY ("added_by") REFERENCES "public"."auth_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "worker_locations" ADD CONSTRAINT "worker_locations_removed_by_auth_users_id_fk" FOREIGN KEY ("removed_by") REFERENCES "public"."auth_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "worker_locations_current_unique" ON "worker_locations" USING btree ("worker_id","outlet_id") WHERE "worker_locations"."removed_at" is null;--> statement-breakpoint
CREATE INDEX "worker_locations_outlet_idx" ON "worker_locations" USING btree ("outlet_id","removed_at");--> statement-breakpoint
ALTER TABLE "location_shift_rules" ADD CONSTRAINT "location_shift_rules_cancellation_check" CHECK ("location_shift_rules"."cancellation_percent" between 0 and 100 and "location_shift_rules"."cancellation_window_minutes" between 0 and 10080);--> statement-breakpoint
ALTER TABLE "outlets" ADD CONSTRAINT "outlets_customer_types_check" CHECK ("outlets"."customer_types" <@ array['OFFICE','STUDENTS','TOURISTS','THEATRE_EVENTS','SPORTS','FAMILIES','SHOPPERS','COMMUTERS','NIGHT_OUT']::text[]);--> statement-breakpoint
ALTER TABLE "outlets" ADD CONSTRAINT "outlets_venue_type_check" CHECK ("outlets"."venue_type" is null or "outlets"."venue_type" in ('CAFE_RESTAURANT','BAR','TAKEAWAY'));--> statement-breakpoint
ALTER TABLE "outlets" ADD CONSTRAINT "outlets_seats_check" CHECK ("outlets"."seats" is null or "outlets"."seats" between 1 and 5000);