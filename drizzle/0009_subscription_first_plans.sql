ALTER TABLE "organisations" ADD COLUMN "setup_completed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "outlets" ADD COLUMN "active" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "organisation_subscriptions" ADD COLUMN "tier" text;--> statement-breakpoint
ALTER TABLE "organisation_subscriptions" ADD COLUMN "billing_period" text;--> statement-breakpoint
ALTER TABLE "organisation_subscriptions" ADD COLUMN "location_limit" integer;--> statement-breakpoint
ALTER TABLE "organisation_subscriptions" ADD CONSTRAINT "subscription_tier_check" CHECK ("organisation_subscriptions"."tier" in ('SINGLE_OUTLET','MULTI_OUTLET','ENTERPRISE'));--> statement-breakpoint
ALTER TABLE "organisation_subscriptions" ADD CONSTRAINT "subscription_period_check" CHECK ("organisation_subscriptions"."billing_period" in ('MONTHLY','ANNUAL'));--> statement-breakpoint
ALTER TABLE "organisation_subscriptions" ADD CONSTRAINT "subscription_location_limit_check" CHECK (case when "organisation_subscriptions"."tier" is null then "organisation_subscriptions"."location_limit" is null and "organisation_subscriptions"."billing_period" is null when "organisation_subscriptions"."tier" = 'SINGLE_OUTLET' then coalesce("organisation_subscriptions"."location_limit" = 1 and "organisation_subscriptions"."billing_period" is not null, false) when "organisation_subscriptions"."tier" = 'MULTI_OUTLET' then coalesce("organisation_subscriptions"."location_limit" = 5 and "organisation_subscriptions"."billing_period" is not null, false) when "organisation_subscriptions"."tier" = 'ENTERPRISE' then coalesce("organisation_subscriptions"."location_limit" > 0, false) else false end);--> statement-breakpoint
-- Preserve completed legacy workplaces without assigning an invented commercial tier.
-- Incomplete records remain editable after authoritative subscription activation.
UPDATE organisations o SET setup_completed_at = o.updated_at
WHERE trim(o.name) <> '' AND trim(coalesce(o.business_address,'')) <> ''
  AND trim(coalesce(o.city,'')) <> '' AND trim(coalesce(o.province,'')) <> ''
  AND trim(coalesce(o.postal_code,'')) <> '' AND trim(coalesce(o.country,'')) <> ''
  AND EXISTS (SELECT 1 FROM outlets l WHERE l.organisation_id=o.id AND l.active)
  AND EXISTS (SELECT 1 FROM organisation_memberships m JOIN auth_users u ON u.id=m.user_id
    WHERE m.organisation_id=o.id AND m.role='OWNER' AND m.state='ACTIVE'
      AND u.title IS NOT NULL AND trim(coalesce(u.first_name,'')) <> ''
      AND trim(coalesce(u.surname,'')) <> '' AND trim(coalesce(u.position,'')) <> ''
      AND trim(coalesce(u.telephone,'')) <> '');
