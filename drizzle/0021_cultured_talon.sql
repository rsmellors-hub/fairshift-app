ALTER TABLE "auth_sessions" ADD COLUMN "demo_persona" text;--> statement-breakpoint
ALTER TABLE "auth_sessions" ADD COLUMN "demo_group" uuid;--> statement-breakpoint
ALTER TABLE "auth_sessions" ADD CONSTRAINT "auth_sessions_demo_persona_check" CHECK ("auth_sessions"."demo_persona" is null or "auth_sessions"."demo_persona" in ('OWNER','MANAGER','WORKER'));--> statement-breakpoint
ALTER TABLE "auth_sessions" ADD CONSTRAINT "auth_sessions_demo_group_check" CHECK (("auth_sessions"."demo_persona" is null) = ("auth_sessions"."demo_group" is null));