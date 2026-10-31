CREATE TABLE "worker_availability" (
	"id" uuid PRIMARY KEY NOT NULL,
	"worker_id" uuid NOT NULL,
	"iso_weekday" integer NOT NULL,
	"state" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "worker_availability_weekday_check" CHECK ("worker_availability"."iso_weekday" between 1 and 7),
	CONSTRAINT "worker_availability_state_check" CHECK ("worker_availability"."state" in ('AVAILABLE', 'UNAVAILABLE'))
);
--> statement-breakpoint
ALTER TABLE "worker_availability" ADD CONSTRAINT "worker_availability_worker_id_workers_id_fk" FOREIGN KEY ("worker_id") REFERENCES "public"."workers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "worker_availability_worker_weekday_unique" ON "worker_availability" USING btree ("worker_id","iso_weekday");