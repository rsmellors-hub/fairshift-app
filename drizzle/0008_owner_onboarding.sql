ALTER TABLE "organisations" ADD COLUMN "business_address" text;--> statement-breakpoint
ALTER TABLE "organisations" ADD COLUMN "city" text;--> statement-breakpoint
ALTER TABLE "organisations" ADD COLUMN "province" text;--> statement-breakpoint
ALTER TABLE "organisations" ADD COLUMN "postal_code" text;--> statement-breakpoint
ALTER TABLE "organisations" ADD COLUMN "country" text;--> statement-breakpoint
ALTER TABLE "auth_users" ADD COLUMN "title" text;--> statement-breakpoint
ALTER TABLE "auth_users" ADD COLUMN "first_name" text;--> statement-breakpoint
ALTER TABLE "auth_users" ADD COLUMN "surname" text;--> statement-breakpoint
ALTER TABLE "auth_users" ADD COLUMN "position" text;--> statement-breakpoint
ALTER TABLE "auth_users" ADD COLUMN "telephone" text;--> statement-breakpoint
ALTER TABLE "auth_users" ADD CONSTRAINT "auth_users_title_check" CHECK ("auth_users"."title" in ('Mr','Mrs','Ms','Dr','Other'));