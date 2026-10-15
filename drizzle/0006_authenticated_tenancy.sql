CREATE TABLE "auth_limits" (
	"key" text PRIMARY KEY NOT NULL,
	"count" integer NOT NULL,
	"resets_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "identity_tokens" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"purpose" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	CONSTRAINT "identity_token_purpose" CHECK ("identity_tokens"."purpose" in ('VERIFY_EMAIL','RESET_PASSWORD'))
);
--> statement-breakpoint
CREATE TABLE "organisation_memberships" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"organisation_id" uuid NOT NULL,
	"outlet_id" uuid,
	"worker_id" uuid,
	"role" text NOT NULL,
	"invitation_id" uuid,
	"state" text DEFAULT 'ACTIVE' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "membership_role_check" CHECK ("organisation_memberships"."role" in ('OWNER','MANAGER','TEAM_MEMBER')),
	CONSTRAINT "membership_state_check" CHECK ("organisation_memberships"."state" in ('ACTIVE','REVOKED')),
	CONSTRAINT "membership_scope_check" CHECK (("organisation_memberships"."role" = 'OWNER' and "organisation_memberships"."outlet_id" is null and "organisation_memberships"."worker_id" is null and "organisation_memberships"."invitation_id" is null) or ("organisation_memberships"."role" = 'MANAGER' and "organisation_memberships"."outlet_id" is not null and "organisation_memberships"."worker_id" is null and "organisation_memberships"."invitation_id" is not null) or ("organisation_memberships"."role" = 'TEAM_MEMBER' and "organisation_memberships"."outlet_id" is not null and "organisation_memberships"."worker_id" is not null and "organisation_memberships"."invitation_id" is not null))
);
--> statement-breakpoint
CREATE TABLE "notification_deliveries" (
	"id" uuid PRIMARY KEY NOT NULL,
	"notification_id" uuid NOT NULL,
	"channel" text DEFAULT 'EMAIL' NOT NULL,
	"destination" text NOT NULL,
	"provider" text DEFAULT 'RESEND' NOT NULL,
	"provider_message_id" text,
	"status" text DEFAULT 'PENDING' NOT NULL,
	"attempted_at" timestamp with time zone,
	"accepted_at" timestamp with time zone,
	"delivered_at" timestamp with time zone,
	"failure_code" text,
	CONSTRAINT "delivery_status_check" CHECK ("notification_deliveries"."status" in ('PENDING','UNCONFIGURED','SENDING','ACCEPTED','FAILED','UNKNOWN','DELIVERED'))
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organisation_id" uuid,
	"user_id" uuid,
	"worker_id" uuid,
	"recipient_email" text NOT NULL,
	"event_key" text NOT NULL,
	"kind" text NOT NULL,
	"entity_id" text NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"href" text NOT NULL,
	"read_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "auth_sessions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"membership_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "subscription_events" (
	"id" text PRIMARY KEY NOT NULL,
	"payload_hash" text NOT NULL,
	"provider_id" text NOT NULL,
	"event_type" text NOT NULL,
	"processed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "organisation_subscriptions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organisation_id" uuid NOT NULL,
	"provider_id" text,
	"plan_id" text,
	"status" text DEFAULT 'UNCONFIGURED' NOT NULL,
	"request_id" uuid NOT NULL,
	"approval_url" text,
	"verified_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "subscription_status_check" CHECK ("organisation_subscriptions"."status" in ('UNCONFIGURED','PENDING','APPROVAL_PENDING','APPROVED','ACTIVE','SUSPENDED','CANCELLED','EXPIRED'))
);
--> statement-breakpoint
CREATE TABLE "auth_users" (
	"id" uuid PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"name" text NOT NULL,
	"password_hash" text NOT NULL,
	"email_verified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "auth_users_email_normalized" CHECK ("auth_users"."email" = lower(trim("auth_users"."email")))
);
--> statement-breakpoint
ALTER TABLE "team_invitations" DROP CONSTRAINT "team_invitation_state_check";--> statement-breakpoint
ALTER TABLE "team_invitations" ALTER COLUMN "worker_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "team_invitations" ADD COLUMN "organisation_id" uuid;--> statement-breakpoint
ALTER TABLE "team_invitations" ADD COLUMN "outlet_id" uuid;--> statement-breakpoint
ALTER TABLE "team_invitations" ADD COLUMN "email" text;--> statement-breakpoint
ALTER TABLE "team_invitations" ADD COLUMN "role" text DEFAULT 'TEAM_MEMBER' NOT NULL;--> statement-breakpoint
ALTER TABLE "team_invitations" ADD COLUMN "expires_at" timestamp with time zone DEFAULT now() + interval '7 days' NOT NULL;--> statement-breakpoint
ALTER TABLE "team_invitations" ADD COLUMN "redeemed_by" uuid;--> statement-breakpoint
ALTER TABLE "team_invitations" ADD COLUMN "redeemed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "team_invitations" ADD COLUMN "created_by" uuid;--> statement-breakpoint
ALTER TABLE "workers" ADD COLUMN "user_id" uuid;--> statement-breakpoint
ALTER TABLE "identity_tokens" ADD CONSTRAINT "identity_tokens_user_id_auth_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."auth_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organisation_memberships" ADD CONSTRAINT "organisation_memberships_user_id_auth_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."auth_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organisation_memberships" ADD CONSTRAINT "organisation_memberships_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organisation_memberships" ADD CONSTRAINT "organisation_memberships_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organisation_memberships" ADD CONSTRAINT "organisation_memberships_worker_id_workers_id_fk" FOREIGN KEY ("worker_id") REFERENCES "public"."workers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organisation_memberships" ADD CONSTRAINT "organisation_memberships_invitation_id_team_invitations_id_fk" FOREIGN KEY ("invitation_id") REFERENCES "public"."team_invitations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_deliveries" ADD CONSTRAINT "notification_deliveries_notification_id_notifications_id_fk" FOREIGN KEY ("notification_id") REFERENCES "public"."notifications"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_auth_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."auth_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_worker_id_workers_id_fk" FOREIGN KEY ("worker_id") REFERENCES "public"."workers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_sessions" ADD CONSTRAINT "auth_sessions_user_id_auth_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."auth_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organisation_subscriptions" ADD CONSTRAINT "organisation_subscriptions_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "identity_tokens_hash_unique" ON "identity_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "membership_invitation_unique" ON "organisation_memberships" USING btree ("invitation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "membership_worker_unique" ON "organisation_memberships" USING btree ("worker_id");--> statement-breakpoint
CREATE INDEX "membership_user_org_idx" ON "organisation_memberships" USING btree ("user_id","organisation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "notification_delivery_channel_unique" ON "notification_deliveries" USING btree ("notification_id","channel");--> statement-breakpoint
CREATE UNIQUE INDEX "notification_event_unique" ON "notifications" USING btree ("event_key");--> statement-breakpoint
CREATE INDEX "notification_recipient_idx" ON "notifications" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "auth_sessions_token_unique" ON "auth_sessions" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "auth_sessions_user_idx" ON "auth_sessions" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "subscription_org_unique" ON "organisation_subscriptions" USING btree ("organisation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "subscription_provider_unique" ON "organisation_subscriptions" USING btree ("provider_id");--> statement-breakpoint
CREATE UNIQUE INDEX "subscription_request_unique" ON "organisation_subscriptions" USING btree ("request_id");--> statement-breakpoint
CREATE UNIQUE INDEX "auth_users_email_unique" ON "auth_users" USING btree ("email");--> statement-breakpoint
ALTER TABLE "team_invitations" ADD CONSTRAINT "team_invitations_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_invitations" ADD CONSTRAINT "team_invitations_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_invitations" ADD CONSTRAINT "team_invitations_redeemed_by_auth_users_id_fk" FOREIGN KEY ("redeemed_by") REFERENCES "public"."auth_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_invitations" ADD CONSTRAINT "team_invitations_created_by_auth_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."auth_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workers" ADD CONSTRAINT "workers_user_id_auth_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."auth_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "workers_org_user_unique" ON "workers" USING btree ("organisation_id","user_id");--> statement-breakpoint
ALTER TABLE "team_invitations" ADD CONSTRAINT "team_invitation_role_check" CHECK ("team_invitations"."role" in ('MANAGER','TEAM_MEMBER'));--> statement-breakpoint
ALTER TABLE "team_invitations" ADD CONSTRAINT "team_invitation_state_check" CHECK ("team_invitations"."state" in ('CREATED_NOT_SENT','SENT','DELIVERY_FAILED','REDEEMED','EXPIRED','REVOKED'));
--> statement-breakpoint
UPDATE team_invitations i SET organisation_id=w.organisation_id, outlet_id=w.location_id, email=lower(w.email), token=encode(sha256(convert_to(i.token,'UTF8')),'hex') FROM workers w WHERE w.id=i.worker_id;
--> statement-breakpoint
ALTER TABLE auth_sessions ADD CONSTRAINT session_membership_fk FOREIGN KEY (membership_id) REFERENCES organisation_memberships(id);
--> statement-breakpoint
CREATE FUNCTION fairshift_membership_scope() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.outlet_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM outlets WHERE id=NEW.outlet_id AND organisation_id=NEW.organisation_id) THEN RAISE EXCEPTION 'Invalid membership location'; END IF;
 IF NEW.role <> 'OWNER' AND NOT EXISTS (SELECT 1 FROM team_invitations i JOIN auth_users u ON u.id=NEW.user_id WHERE i.id=NEW.invitation_id AND i.organisation_id=NEW.organisation_id AND i.outlet_id=NEW.outlet_id AND i.role=NEW.role AND i.worker_id IS NOT DISTINCT FROM NEW.worker_id AND i.email=u.email) THEN RAISE EXCEPTION 'Membership must match invitation'; END IF;
 IF NEW.worker_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM workers WHERE id=NEW.worker_id AND organisation_id=NEW.organisation_id AND location_id=NEW.outlet_id AND user_id=NEW.user_id) THEN RAISE EXCEPTION 'Invalid worker membership'; END IF;
 RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER fairshift_membership_scope BEFORE INSERT OR UPDATE ON organisation_memberships FOR EACH ROW EXECUTE FUNCTION fairshift_membership_scope();
--> statement-breakpoint
CREATE FUNCTION fairshift_notification_delivery() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 INSERT INTO notification_deliveries (id,notification_id,destination) VALUES (gen_random_uuid(),NEW.id,NEW.recipient_email) ON CONFLICT DO NOTHING;
 RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER fairshift_notification_delivery AFTER INSERT ON notifications FOR EACH ROW EXECUTE FUNCTION fairshift_notification_delivery();
--> statement-breakpoint
CREATE FUNCTION fairshift_offer_notification() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 INSERT INTO notifications (id,organisation_id,user_id,worker_id,recipient_email,event_key,kind,entity_id,title,body,href)
 SELECT gen_random_uuid(),w.organisation_id,w.user_id,w.id,w.email,'offer:'||NEW.id,'SHIFT_OFFER',NEW.id,'New work assignment offer','Review the assignment location, department, schedule and earnings terms before responding.','/worker/shifts'
 FROM workers w WHERE w.id=NEW.worker_id AND w.email IS NOT NULL ON CONFLICT DO NOTHING;
 RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER fairshift_offer_notification AFTER INSERT ON shift_offers FOR EACH ROW EXECUTE FUNCTION fairshift_offer_notification();
--> statement-breakpoint
CREATE FUNCTION fairshift_shift_notification() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE kind text; label text;
BEGIN
 IF NEW.status='CANCELLED' AND OLD.status<>'CANCELLED' THEN
   kind := 'SHIFT_CANCELLED'; label := 'Work assignment cancelled';
   UPDATE shift_offers SET status='CANCELLED',accepted_at=NULL WHERE shift_id=NEW.id AND status IN ('OFFERED','ACCEPTED');
   UPDATE work_allocations SET state='REACCEPTANCE_REQUIRED' WHERE offer_id IN (SELECT id FROM shift_offers WHERE shift_id=NEW.id);
 ELSIF NEW.terms_version<>OLD.terms_version THEN kind := 'SHIFT_CHANGED'; label := 'Work assignment terms changed';
 ELSE RETURN NEW; END IF;
 INSERT INTO notifications (id,organisation_id,user_id,worker_id,recipient_email,event_key,kind,entity_id,title,body,href)
 SELECT gen_random_uuid(),w.organisation_id,w.user_id,w.id,w.email,'shift:'||NEW.id||':'||NEW.terms_version||':'||kind||':'||w.id,kind,NEW.id,label,
 CASE WHEN kind='SHIFT_CANCELLED' THEN 'This work assignment has been cancelled. Review your schedule.' ELSE 'Review the updated material terms. Previous acceptance does not apply to the new version.' END,'/worker/shifts'
 FROM shift_offers o JOIN workers w ON w.id=o.worker_id WHERE o.shift_id=NEW.id AND w.email IS NOT NULL AND o.status IN ('OFFERED','ACCEPTED','CANCELLED') ON CONFLICT DO NOTHING;
 RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER fairshift_shift_notification AFTER UPDATE ON shifts FOR EACH ROW EXECUTE FUNCTION fairshift_shift_notification();
--> statement-breakpoint
CREATE FUNCTION fairshift_work_notification() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.confirmed_at IS NOT NULL AND OLD.confirmed_at IS NULL THEN
 INSERT INTO notifications (id,organisation_id,user_id,worker_id,recipient_email,event_key,kind,entity_id,title,body,href)
 SELECT gen_random_uuid(),w.organisation_id,w.user_id,w.id,w.email,'work-confirmed:'||NEW.id,'WORK_CONFIRMED',NEW.id,'Work confirmed','Your manager confirmed work for this assignment. This does not mean a payment has been sent.','/worker/earnings'
 FROM shift_offers o JOIN workers w ON w.id=o.worker_id WHERE o.id=NEW.offer_id AND w.email IS NOT NULL ON CONFLICT DO NOTHING;
 END IF;
 RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER fairshift_work_notification AFTER UPDATE ON work_allocations FOR EACH ROW EXECUTE FUNCTION fairshift_work_notification();
--> statement-breakpoint
CREATE FUNCTION fairshift_payment_notification() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.status IN ('APPROVED','PAID','FAILED') AND NEW.status IS DISTINCT FROM OLD.status THEN
 INSERT INTO notifications (id,organisation_id,user_id,worker_id,recipient_email,event_key,kind,entity_id,title,body,href)
 SELECT gen_random_uuid(),w.organisation_id,w.user_id,w.id,w.email,'payment:'||NEW.id||':'||NEW.status,'INCENTIVE_STATUS',NEW.id,'Incentive payment update','Your incentive status changed. Check Earnings for the current payment state.','/worker/earnings'
 FROM workers w WHERE w.id=NEW.worker_id AND w.email IS NOT NULL ON CONFLICT DO NOTHING;
 END IF;
 RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER fairshift_payment_notification AFTER UPDATE ON shift_incentives FOR EACH ROW EXECUTE FUNCTION fairshift_payment_notification();
