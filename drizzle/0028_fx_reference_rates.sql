CREATE TABLE "fx_reference_rates" (
	"id" uuid PRIMARY KEY NOT NULL,
	"rate_date" date NOT NULL,
	"eur_zar" text NOT NULL,
	"eur_usd" text NOT NULL,
	"usd_zar_micros" bigint NOT NULL,
	"source" text NOT NULL,
	"recorded_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fx_reference_rates_quote_check" CHECK ("fx_reference_rates"."eur_zar" ~ '^[0-9]{1,6}(\.[0-9]{1,6})?$' and "fx_reference_rates"."eur_usd" ~ '^[0-9]{1,6}(\.[0-9]{1,6})?$' and "fx_reference_rates"."eur_zar"::numeric > 0 and "fx_reference_rates"."eur_usd"::numeric > 0),
	CONSTRAINT "fx_reference_rates_micros_check" CHECK ("fx_reference_rates"."usd_zar_micros" > 0 and "fx_reference_rates"."usd_zar_micros" = ceil("fx_reference_rates"."eur_zar"::numeric * 1000000 / "fx_reference_rates"."eur_usd"::numeric)),
	CONSTRAINT "fx_reference_rates_source_check" CHECK (("fx_reference_rates"."source" = 'ECB_EUROFXREF_DAILY') or ("fx_reference_rates"."source" = 'OWNER_MANUAL' and "fx_reference_rates"."recorded_by" is not null))
);
--> statement-breakpoint
ALTER TABLE "fx_reference_rates" ADD CONSTRAINT "fx_reference_rates_recorded_by_auth_users_id_fk" FOREIGN KEY ("recorded_by") REFERENCES "public"."auth_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "fx_reference_rates_date_unique" ON "fx_reference_rates" USING btree ("rate_date");--> statement-breakpoint
-- A recorded reference rate is evidence for every payout that froze it: never edited or deleted.
CREATE OR REPLACE FUNCTION fairshift_fx_reference_rate_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 RAISE EXCEPTION 'FX reference rates are retained unchanged';
END $$;--> statement-breakpoint
CREATE TRIGGER fx_reference_rates_immutable BEFORE UPDATE OR DELETE ON "fx_reference_rates" FOR EACH ROW EXECUTE FUNCTION fairshift_fx_reference_rate_immutable();
