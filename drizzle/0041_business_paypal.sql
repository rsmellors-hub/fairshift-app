CREATE TABLE "business_paypal_connections" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organisation_id" uuid NOT NULL,
	"environment" text DEFAULT 'SANDBOX' NOT NULL,
	"client_id" text NOT NULL,
	"secret_sealed" text NOT NULL,
	"secret_last4" text NOT NULL,
	"app_id" text,
	"sender_email" text NOT NULL,
	"connected_by" uuid,
	"connected_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_tested_at" timestamp with time zone,
	"disconnected_at" timestamp with time zone,
	CONSTRAINT "business_paypal_connections_environment_check" CHECK ("business_paypal_connections"."environment" = 'SANDBOX'),
	CONSTRAINT "business_paypal_connections_last4_check" CHECK (char_length("business_paypal_connections"."secret_last4") = 4)
);
--> statement-breakpoint
ALTER TABLE "work_payouts" ADD COLUMN "sender_connection_id" uuid;--> statement-breakpoint
ALTER TABLE "work_payouts" ADD COLUMN "sender_email" text;--> statement-breakpoint
ALTER TABLE "business_paypal_connections" ADD CONSTRAINT "business_paypal_connections_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "business_paypal_connections" ADD CONSTRAINT "business_paypal_connections_connected_by_auth_users_id_fk" FOREIGN KEY ("connected_by") REFERENCES "public"."auth_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "business_paypal_connections_current_unique" ON "business_paypal_connections" USING btree ("organisation_id") WHERE "business_paypal_connections"."disconnected_at" is null;