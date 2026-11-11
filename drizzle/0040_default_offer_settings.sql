ALTER TABLE "location_shift_rules" DROP CONSTRAINT "location_shift_rules_source_check";--> statement-breakpoint
ALTER TABLE "organisation_hours_rules" DROP CONSTRAINT "organisation_hours_rules_source_check";--> statement-breakpoint
ALTER TABLE "location_shift_rules" ADD CONSTRAINT "location_shift_rules_source_check" CHECK ("location_shift_rules"."source" in ('OWNER', 'DEMO_SEED', 'DEFAULT'));--> statement-breakpoint
ALTER TABLE "organisation_hours_rules" ADD CONSTRAINT "organisation_hours_rules_source_check" CHECK ("organisation_hours_rules"."source" in ('OWNER', 'DEMO_SEED', 'DEFAULT'));