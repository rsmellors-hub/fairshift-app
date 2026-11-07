CREATE TABLE "staff_destination_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organisation_id" uuid NOT NULL,
	"worker_id" uuid NOT NULL,
	"link_id" uuid,
	"kind" text NOT NULL,
	"recorded_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "staff_destination_events_kind_check" CHECK (("staff_destination_events"."kind" = 'RECORDED' and "staff_destination_events"."recorded_by" is not null and "staff_destination_events"."link_id" is null) or ("staff_destination_events"."kind" in ('CONFIRMED', 'CHANGED') and "staff_destination_events"."link_id" is not null))
);
--> statement-breakpoint
CREATE TABLE "staff_statement_links" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organisation_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"worker_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"destination_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "staff_statement_links_token_check" CHECK ("staff_statement_links"."token_hash" ~ '^[0-9a-f]{64}$' and "staff_statement_links"."expires_at" > "staff_statement_links"."created_at")
);
--> statement-breakpoint
CREATE TABLE "tip_agent_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organisation_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"allocation_id" uuid NOT NULL,
	"evidence_version" text NOT NULL,
	"created_by" uuid,
	"status" text NOT NULL,
	"outcome_code" text,
	"error_class" text,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"model_call_count" integer DEFAULT 0 NOT NULL,
	"claim_token" uuid,
	"claimed_at" timestamp with time zone,
	"lease_expires_at" timestamp with time zone,
	"next_attempt_at" timestamp with time zone,
	"configured_model" text,
	"response_model" text,
	"response_id" text,
	"decision" text,
	"reason_code" text,
	"summary" text,
	"decided_at" timestamp with time zone,
	"dry_run" boolean,
	"released_by" uuid,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tip_agent_events_status_check" CHECK ("tip_agent_events"."status" in ('PENDING', 'CLAIMED', 'SKIPPED', 'BLOCKED', 'REJECTED_OUTPUT', 'FAILED_RETRYABLE', 'FAILED_TERMINAL', 'DECIDED_RELEASE', 'DECIDED_HOLD', 'HOLD_RELEASED', 'SETTLING', 'SETTLED')),
	CONSTRAINT "tip_agent_events_claim_check" CHECK (("tip_agent_events"."status" in ('CLAIMED', 'SETTLING')) = ("tip_agent_events"."claim_token" is not null and "tip_agent_events"."lease_expires_at" is not null and "tip_agent_events"."claimed_at" is not null)),
	CONSTRAINT "tip_agent_events_decision_check" CHECK (("tip_agent_events"."decision" is null and "tip_agent_events"."reason_code" is null and "tip_agent_events"."summary" is null and "tip_agent_events"."decided_at" is null)
    or ("tip_agent_events"."decision" = 'RELEASE' and "tip_agent_events"."reason_code" is null and "tip_agent_events"."summary" is null and "tip_agent_events"."decided_at" is not null)
    or ("tip_agent_events"."decision" = 'HOLD' and "tip_agent_events"."reason_code" in ('UNATTRIBUTED_TIPS', 'INACTIVE_STAFF_ATTRIBUTION', 'TIP_OUTLIER', 'RECONCILIATION_GAP', 'DUPLICATE_ROWS', 'ROSTER_MISMATCH') and char_length("tip_agent_events"."summary") between 1 and 200 and "tip_agent_events"."decided_at" is not null)),
	CONSTRAINT "tip_agent_events_counts_check" CHECK ("tip_agent_events"."attempt_count" >= 0 and "tip_agent_events"."model_call_count" >= 0 and "tip_agent_events"."model_call_count" <= "tip_agent_events"."attempt_count" and "tip_agent_events"."evidence_version" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "tip_agent_events_codes_check" CHECK (coalesce(char_length("tip_agent_events"."outcome_code"), 0) <= 64 and coalesce(char_length("tip_agent_events"."error_class"), 0) <= 64 and coalesce(char_length("tip_agent_events"."response_id"), 0) <= 200)
);
--> statement-breakpoint
CREATE TABLE "tip_allocation_lines" (
	"id" uuid PRIMARY KEY NOT NULL,
	"allocation_id" uuid NOT NULL,
	"organisation_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"worker_id" uuid NOT NULL,
	"worker_type" text NOT NULL,
	"membership" text NOT NULL,
	"share_minor" bigint NOT NULL,
	"currency_code" text NOT NULL,
	"local_date" date NOT NULL,
	"gate_outcome" text,
	"gate_checked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tip_allocation_lines_share_check" CHECK ("tip_allocation_lines"."share_minor" between 0 and 9007199254740991 and "tip_allocation_lines"."currency_code" ~ '^[A-Z]{3}$'),
	CONSTRAINT "tip_allocation_lines_type_check" CHECK ("tip_allocation_lines"."worker_type" in ('REGULAR', 'CASUAL') and "tip_allocation_lines"."membership" in ('ROSTER', 'CONFIRMED_SHIFT', 'POS_ROW'))
);
--> statement-breakpoint
CREATE TABLE "tip_allocations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organisation_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"import_id" uuid NOT NULL,
	"policy" text NOT NULL,
	"local_date" date NOT NULL,
	"block_key" text NOT NULL,
	"block_id" uuid,
	"block_name" text,
	"block_start_minute" integer,
	"block_end_minute" integer,
	"total_tip_minor" bigint NOT NULL,
	"allocated_minor" bigint NOT NULL,
	"unallocated_minor" bigint NOT NULL,
	"currency_code" text NOT NULL,
	"evidence_version" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tip_allocations_policy_check" CHECK (("tip_allocations"."policy" = 'DIRECT' and "tip_allocations"."block_key" = 'DAY' and "tip_allocations"."block_id" is null) or ("tip_allocations"."policy" = 'SHIFT_POOL' and "tip_allocations"."block_id" is not null and "tip_allocations"."block_key" = "tip_allocations"."block_id"::text and "tip_allocations"."block_name" is not null)),
	CONSTRAINT "tip_allocations_totals_check" CHECK ("tip_allocations"."allocated_minor" >= 0 and "tip_allocations"."unallocated_minor" >= 0 and "tip_allocations"."total_tip_minor" = "tip_allocations"."allocated_minor" + "tip_allocations"."unallocated_minor"),
	CONSTRAINT "tip_allocations_version_check" CHECK ("tip_allocations"."evidence_version" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "tip_block_roster" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organisation_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"worker_id" uuid NOT NULL,
	"block_id" uuid NOT NULL,
	"iso_weekday" integer NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tip_block_roster_weekday_check" CHECK ("tip_block_roster"."iso_weekday" between 1 and 7)
);
--> statement-breakpoint
CREATE TABLE "tip_evidence_rows" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organisation_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"import_id" uuid NOT NULL,
	"source" text NOT NULL,
	"row_ref" text NOT NULL,
	"transaction_at" timestamp with time zone NOT NULL,
	"local_date" date NOT NULL,
	"staff_ref" text,
	"worker_id" uuid,
	"bill_minor" bigint NOT NULL,
	"tip_minor" bigint NOT NULL,
	"currency_code" text NOT NULL,
	"block_id" uuid,
	"allocation_id" uuid,
	"disposition" text NOT NULL,
	"imported_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tip_evidence_rows_amount_check" CHECK ("tip_evidence_rows"."bill_minor" between 0 and 9007199254740991 and "tip_evidence_rows"."tip_minor" between 1 and 9007199254740991 and "tip_evidence_rows"."currency_code" ~ '^[A-Z]{3}$'),
	CONSTRAINT "tip_evidence_rows_disposition_check" CHECK (("tip_evidence_rows"."disposition" in ('POOL', 'DIRECT') and "tip_evidence_rows"."allocation_id" is not null) or ("tip_evidence_rows"."disposition" in ('CASUAL_SHIFT_PAY', 'OUTSIDE_BLOCKS') and "tip_evidence_rows"."allocation_id" is null) or "tip_evidence_rows"."disposition" = 'UNATTRIBUTED')
);
--> statement-breakpoint
CREATE TABLE "tip_hold_decisions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"hold_id" uuid NOT NULL,
	"organisation_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"decision" text NOT NULL,
	"decided_by" uuid NOT NULL,
	"decided_at" timestamp with time zone DEFAULT now() NOT NULL,
	"reason" text NOT NULL,
	CONSTRAINT "tip_hold_decisions_decision_check" CHECK ("tip_hold_decisions"."decision" in ('RELEASED', 'KEPT_HELD')),
	CONSTRAINT "tip_hold_decisions_reason_check" CHECK (char_length(btrim("tip_hold_decisions"."reason")) between 1 and 500)
);
--> statement-breakpoint
CREATE TABLE "tip_holds" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organisation_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"allocation_id" uuid NOT NULL,
	"line_id" uuid,
	"tip_agent_event_id" uuid,
	"source" text NOT NULL,
	"reason_code" text NOT NULL,
	"summary" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tip_holds_source_check" CHECK (("tip_holds"."source" = 'MODEL' and "tip_holds"."line_id" is null and "tip_holds"."tip_agent_event_id" is not null and "tip_holds"."reason_code" in ('UNATTRIBUTED_TIPS', 'INACTIVE_STAFF_ATTRIBUTION', 'TIP_OUTLIER', 'RECONCILIATION_GAP', 'DUPLICATE_ROWS', 'ROSTER_MISMATCH'))
    or ("tip_holds"."source" = 'DETERMINISTIC' and "tip_holds"."line_id" is not null and "tip_holds"."reason_code" in ('AUTO_RELEASE_CAP_EXCEEDED', 'DESTINATION_RECENTLY_CHANGED'))),
	CONSTRAINT "tip_holds_summary_check" CHECK (char_length("tip_holds"."summary") between 1 and 200)
);
--> statement-breakpoint
CREATE TABLE "tip_imports" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organisation_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"label" text NOT NULL,
	"file_sha256" text NOT NULL,
	"policy" text NOT NULL,
	"row_count" integer NOT NULL,
	"duplicate_rows_skipped" integer NOT NULL,
	"total_tip_minor" bigint NOT NULL,
	"currency_code" text NOT NULL,
	"imported_by" uuid NOT NULL,
	"imported_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tip_imports_label_check" CHECK ("tip_imports"."label" = 'IMPORTED_POS_EVIDENCE'),
	CONSTRAINT "tip_imports_policy_check" CHECK ("tip_imports"."policy" in ('DIRECT', 'SHIFT_POOL')),
	CONSTRAINT "tip_imports_counts_check" CHECK ("tip_imports"."row_count" >= 0 and "tip_imports"."duplicate_rows_skipped" >= 0 and "tip_imports"."total_tip_minor" >= 0 and "tip_imports"."file_sha256" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "tip_location_settings" (
	"outlet_id" uuid PRIMARY KEY NOT NULL,
	"organisation_id" uuid NOT NULL,
	"policy" text NOT NULL,
	"auto_release_cap_minor" bigint NOT NULL,
	"currency_code" text NOT NULL,
	"set_by" uuid NOT NULL,
	"set_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tip_location_settings_policy_check" CHECK ("tip_location_settings"."policy" in ('DIRECT', 'SHIFT_POOL')),
	CONSTRAINT "tip_location_settings_cap_check" CHECK ("tip_location_settings"."auto_release_cap_minor" between 1 and 9007199254740991 and "tip_location_settings"."currency_code" ~ '^[A-Z]{3}$')
);
--> statement-breakpoint
CREATE TABLE "tip_shift_blocks" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organisation_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"name" text NOT NULL,
	"start_minute" integer NOT NULL,
	"end_minute" integer NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tip_shift_blocks_time_check" CHECK ("tip_shift_blocks"."start_minute" >= 0 and "tip_shift_blocks"."end_minute" <= 1440 and "tip_shift_blocks"."start_minute" < "tip_shift_blocks"."end_minute"),
	CONSTRAINT "tip_shift_blocks_name_check" CHECK (char_length("tip_shift_blocks"."name") between 1 and 40)
);
--> statement-breakpoint
ALTER TABLE "work_payouts" ALTER COLUMN "payable_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "work_payouts" ADD COLUMN "tip_line_id" uuid;--> statement-breakpoint
ALTER TABLE "staff_destination_events" ADD CONSTRAINT "staff_destination_events_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_destination_events" ADD CONSTRAINT "staff_destination_events_worker_id_workers_id_fk" FOREIGN KEY ("worker_id") REFERENCES "public"."workers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_destination_events" ADD CONSTRAINT "staff_destination_events_link_id_staff_statement_links_id_fk" FOREIGN KEY ("link_id") REFERENCES "public"."staff_statement_links"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_destination_events" ADD CONSTRAINT "staff_destination_events_recorded_by_auth_users_id_fk" FOREIGN KEY ("recorded_by") REFERENCES "public"."auth_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_statement_links" ADD CONSTRAINT "staff_statement_links_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_statement_links" ADD CONSTRAINT "staff_statement_links_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_statement_links" ADD CONSTRAINT "staff_statement_links_worker_id_workers_id_fk" FOREIGN KEY ("worker_id") REFERENCES "public"."workers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_statement_links" ADD CONSTRAINT "staff_statement_links_created_by_auth_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."auth_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tip_agent_events" ADD CONSTRAINT "tip_agent_events_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tip_agent_events" ADD CONSTRAINT "tip_agent_events_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tip_agent_events" ADD CONSTRAINT "tip_agent_events_allocation_id_tip_allocations_id_fk" FOREIGN KEY ("allocation_id") REFERENCES "public"."tip_allocations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tip_agent_events" ADD CONSTRAINT "tip_agent_events_created_by_auth_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."auth_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tip_agent_events" ADD CONSTRAINT "tip_agent_events_released_by_auth_users_id_fk" FOREIGN KEY ("released_by") REFERENCES "public"."auth_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tip_allocation_lines" ADD CONSTRAINT "tip_allocation_lines_allocation_id_tip_allocations_id_fk" FOREIGN KEY ("allocation_id") REFERENCES "public"."tip_allocations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tip_allocation_lines" ADD CONSTRAINT "tip_allocation_lines_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tip_allocation_lines" ADD CONSTRAINT "tip_allocation_lines_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tip_allocation_lines" ADD CONSTRAINT "tip_allocation_lines_worker_id_workers_id_fk" FOREIGN KEY ("worker_id") REFERENCES "public"."workers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tip_allocations" ADD CONSTRAINT "tip_allocations_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tip_allocations" ADD CONSTRAINT "tip_allocations_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tip_allocations" ADD CONSTRAINT "tip_allocations_import_id_tip_imports_id_fk" FOREIGN KEY ("import_id") REFERENCES "public"."tip_imports"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tip_allocations" ADD CONSTRAINT "tip_allocations_block_id_tip_shift_blocks_id_fk" FOREIGN KEY ("block_id") REFERENCES "public"."tip_shift_blocks"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tip_block_roster" ADD CONSTRAINT "tip_block_roster_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tip_block_roster" ADD CONSTRAINT "tip_block_roster_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tip_block_roster" ADD CONSTRAINT "tip_block_roster_worker_id_workers_id_fk" FOREIGN KEY ("worker_id") REFERENCES "public"."workers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tip_block_roster" ADD CONSTRAINT "tip_block_roster_block_id_tip_shift_blocks_id_fk" FOREIGN KEY ("block_id") REFERENCES "public"."tip_shift_blocks"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tip_block_roster" ADD CONSTRAINT "tip_block_roster_created_by_auth_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."auth_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tip_evidence_rows" ADD CONSTRAINT "tip_evidence_rows_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tip_evidence_rows" ADD CONSTRAINT "tip_evidence_rows_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tip_evidence_rows" ADD CONSTRAINT "tip_evidence_rows_import_id_tip_imports_id_fk" FOREIGN KEY ("import_id") REFERENCES "public"."tip_imports"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tip_evidence_rows" ADD CONSTRAINT "tip_evidence_rows_worker_id_workers_id_fk" FOREIGN KEY ("worker_id") REFERENCES "public"."workers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tip_evidence_rows" ADD CONSTRAINT "tip_evidence_rows_block_id_tip_shift_blocks_id_fk" FOREIGN KEY ("block_id") REFERENCES "public"."tip_shift_blocks"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tip_evidence_rows" ADD CONSTRAINT "tip_evidence_rows_allocation_id_tip_allocations_id_fk" FOREIGN KEY ("allocation_id") REFERENCES "public"."tip_allocations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tip_hold_decisions" ADD CONSTRAINT "tip_hold_decisions_hold_id_tip_holds_id_fk" FOREIGN KEY ("hold_id") REFERENCES "public"."tip_holds"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tip_hold_decisions" ADD CONSTRAINT "tip_hold_decisions_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tip_hold_decisions" ADD CONSTRAINT "tip_hold_decisions_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tip_hold_decisions" ADD CONSTRAINT "tip_hold_decisions_decided_by_auth_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."auth_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tip_holds" ADD CONSTRAINT "tip_holds_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tip_holds" ADD CONSTRAINT "tip_holds_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tip_holds" ADD CONSTRAINT "tip_holds_allocation_id_tip_allocations_id_fk" FOREIGN KEY ("allocation_id") REFERENCES "public"."tip_allocations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tip_holds" ADD CONSTRAINT "tip_holds_line_id_tip_allocation_lines_id_fk" FOREIGN KEY ("line_id") REFERENCES "public"."tip_allocation_lines"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tip_holds" ADD CONSTRAINT "tip_holds_tip_agent_event_id_tip_agent_events_id_fk" FOREIGN KEY ("tip_agent_event_id") REFERENCES "public"."tip_agent_events"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tip_imports" ADD CONSTRAINT "tip_imports_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tip_imports" ADD CONSTRAINT "tip_imports_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tip_imports" ADD CONSTRAINT "tip_imports_imported_by_auth_users_id_fk" FOREIGN KEY ("imported_by") REFERENCES "public"."auth_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tip_location_settings" ADD CONSTRAINT "tip_location_settings_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tip_location_settings" ADD CONSTRAINT "tip_location_settings_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tip_location_settings" ADD CONSTRAINT "tip_location_settings_set_by_auth_users_id_fk" FOREIGN KEY ("set_by") REFERENCES "public"."auth_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tip_shift_blocks" ADD CONSTRAINT "tip_shift_blocks_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tip_shift_blocks" ADD CONSTRAINT "tip_shift_blocks_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tip_shift_blocks" ADD CONSTRAINT "tip_shift_blocks_created_by_auth_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."auth_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "staff_destination_events_worker_idx" ON "staff_destination_events" USING btree ("worker_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "staff_statement_links_token_unique" ON "staff_statement_links" USING btree ("token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "tip_agent_events_version_unique" ON "tip_agent_events" USING btree ("allocation_id","evidence_version");--> statement-breakpoint
CREATE INDEX "tip_agent_events_recovery_idx" ON "tip_agent_events" USING btree ("status","next_attempt_at");--> statement-breakpoint
CREATE UNIQUE INDEX "tip_allocation_lines_unique" ON "tip_allocation_lines" USING btree ("allocation_id","worker_id");--> statement-breakpoint
CREATE INDEX "tip_allocation_lines_worker_idx" ON "tip_allocation_lines" USING btree ("worker_id","local_date");--> statement-breakpoint
CREATE UNIQUE INDEX "tip_allocations_unique" ON "tip_allocations" USING btree ("import_id","local_date","block_key");--> statement-breakpoint
CREATE INDEX "tip_allocations_outlet_idx" ON "tip_allocations" USING btree ("outlet_id","local_date");--> statement-breakpoint
CREATE UNIQUE INDEX "tip_block_roster_unique" ON "tip_block_roster" USING btree ("worker_id","block_id","iso_weekday");--> statement-breakpoint
CREATE INDEX "tip_block_roster_outlet_idx" ON "tip_block_roster" USING btree ("outlet_id","iso_weekday");--> statement-breakpoint
CREATE UNIQUE INDEX "tip_evidence_rows_ref_unique" ON "tip_evidence_rows" USING btree ("outlet_id","source","row_ref");--> statement-breakpoint
CREATE INDEX "tip_evidence_rows_allocation_idx" ON "tip_evidence_rows" USING btree ("allocation_id");--> statement-breakpoint
CREATE INDEX "tip_hold_decisions_hold_idx" ON "tip_hold_decisions" USING btree ("hold_id","decided_at");--> statement-breakpoint
CREATE UNIQUE INDEX "tip_hold_decisions_release_unique" ON "tip_hold_decisions" USING btree ("hold_id") WHERE "tip_hold_decisions"."decision" = 'RELEASED';--> statement-breakpoint
CREATE INDEX "tip_holds_allocation_idx" ON "tip_holds" USING btree ("allocation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "tip_imports_file_unique" ON "tip_imports" USING btree ("outlet_id","file_sha256");--> statement-breakpoint
CREATE INDEX "tip_shift_blocks_outlet_idx" ON "tip_shift_blocks" USING btree ("outlet_id","active");--> statement-breakpoint
ALTER TABLE "work_payouts" ADD CONSTRAINT "work_payouts_tip_line_id_tip_allocation_lines_id_fk" FOREIGN KEY ("tip_line_id") REFERENCES "public"."tip_allocation_lines"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "work_payouts_tip_line_unique" ON "work_payouts" USING btree ("tip_line_id");--> statement-breakpoint
-- Tip lines are paid through the shared payout engine (DEC-SA-011: one settlement engine). A
-- payout now settles exactly one obligation: one approved work payable, or one tip allocation line.
ALTER TABLE "work_payouts" ADD CONSTRAINT "work_payouts_obligation_check" CHECK (("work_payouts"."payable_id" is null) <> ("work_payouts"."tip_line_id" is null));--> statement-breakpoint
CREATE OR REPLACE FUNCTION fairshift_work_payout_integrity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Work payouts are retained'; END IF;
 IF TG_OP = 'INSERT' THEN
   IF NEW.status IS DISTINCT FROM 'SUBMITTING' OR NEW.paypal_batch_id IS NOT NULL OR NEW.paid_at IS NOT NULL THEN
     RAISE EXCEPTION 'Work payouts are created as a reservation';
   END IF;
   IF NEW.payable_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM work_payables WHERE id = NEW.payable_id AND status = 'APPROVED' AND organisation_id = NEW.organisation_id
     AND outlet_id = NEW.outlet_id AND worker_id = NEW.worker_id AND approved_amount_minor = NEW.amount_minor AND approved_currency_code = NEW.currency_code) THEN
     RAISE EXCEPTION 'Work payout must match one approved payable';
   END IF;
   IF NEW.tip_line_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM tip_allocation_lines WHERE id = NEW.tip_line_id AND organisation_id = NEW.organisation_id
     AND outlet_id = NEW.outlet_id AND worker_id = NEW.worker_id AND share_minor = NEW.amount_minor AND currency_code = NEW.currency_code) THEN
     RAISE EXCEPTION 'Tip payout must match one tip allocation line';
   END IF;
   RETURN NEW;
 END IF;
 IF ROW(NEW.id, NEW.payable_id, NEW.tip_line_id, NEW.organisation_id, NEW.outlet_id, NEW.worker_id, NEW.amount_minor, NEW.currency_code, NEW.provider_currency, NEW.provider_amount_minor, NEW.fx_rate_micros, NEW.fx_rate_source, NEW.sender_batch_id, NEW.sender_item_id, NEW.reserved_at, NEW.created_at)
   IS DISTINCT FROM ROW(OLD.id, OLD.payable_id, OLD.tip_line_id, OLD.organisation_id, OLD.outlet_id, OLD.worker_id, OLD.amount_minor, OLD.currency_code, OLD.provider_currency, OLD.provider_amount_minor, OLD.fx_rate_micros, OLD.fx_rate_source, OLD.sender_batch_id, OLD.sender_item_id, OLD.reserved_at, OLD.created_at) THEN
   RAISE EXCEPTION 'Work payout facts are immutable';
 END IF;
 IF (OLD.paypal_batch_id IS NOT NULL AND NEW.paypal_batch_id IS DISTINCT FROM OLD.paypal_batch_id)
  OR (OLD.paypal_item_id IS NOT NULL AND NEW.paypal_item_id IS DISTINCT FROM OLD.paypal_item_id)
  OR (OLD.paypal_transaction_id IS NOT NULL AND NEW.paypal_transaction_id IS DISTINCT FROM OLD.paypal_transaction_id) THEN
   RAISE EXCEPTION 'PayPal payout identifiers are immutable';
 END IF;
 IF NEW.recipient IS DISTINCT FROM OLD.recipient AND NOT (OLD.status = 'NOT_SENT' AND NEW.status = 'SUBMITTING') THEN
   RAISE EXCEPTION 'Payout recipient is fixed once a payout may have been sent';
 END IF;
 IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
   (OLD.status = 'SUBMITTING' AND NEW.status IN ('NOT_SENT', 'PROCESSING', 'PAID', 'FAILED', 'RECONCILIATION_REQUIRED'))
   OR (OLD.status = 'NOT_SENT' AND NEW.status = 'SUBMITTING')
   OR (OLD.status = 'RECONCILIATION_REQUIRED' AND NEW.status IN ('SUBMITTING', 'PROCESSING', 'PAID', 'FAILED'))
   OR (OLD.status IN ('PROCESSING', 'PAID', 'FAILED') AND NEW.status IN ('PROCESSING', 'PAID', 'FAILED'))
 ) THEN
   RAISE EXCEPTION 'Invalid work payout status transition';
 END IF;
 RETURN NEW;
END $$;--> statement-breakpoint
-- Imported tip evidence, allocations, lines, holds and Owner decisions are permanent records.
CREATE OR REPLACE FUNCTION fairshift_tip_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 RAISE EXCEPTION '% records are append-only', TG_TABLE_NAME;
END $$;--> statement-breakpoint
CREATE TRIGGER tip_imports_append_only BEFORE UPDATE OR DELETE ON "tip_imports" FOR EACH ROW EXECUTE FUNCTION fairshift_tip_append_only();--> statement-breakpoint
CREATE TRIGGER tip_evidence_rows_append_only BEFORE UPDATE OR DELETE ON "tip_evidence_rows" FOR EACH ROW EXECUTE FUNCTION fairshift_tip_append_only();--> statement-breakpoint
CREATE TRIGGER tip_allocations_append_only BEFORE UPDATE OR DELETE ON "tip_allocations" FOR EACH ROW EXECUTE FUNCTION fairshift_tip_append_only();--> statement-breakpoint
CREATE TRIGGER tip_holds_append_only BEFORE UPDATE OR DELETE ON "tip_holds" FOR EACH ROW EXECUTE FUNCTION fairshift_tip_append_only();--> statement-breakpoint
CREATE TRIGGER tip_hold_decisions_append_only BEFORE UPDATE OR DELETE ON "tip_hold_decisions" FOR EACH ROW EXECUTE FUNCTION fairshift_tip_append_only();--> statement-breakpoint
CREATE TRIGGER staff_destination_events_append_only BEFORE UPDATE OR DELETE ON "staff_destination_events" FOR EACH ROW EXECUTE FUNCTION fairshift_tip_append_only();--> statement-breakpoint
-- A line's share and identity are fixed; only its last gate outcome may be recorded.
CREATE OR REPLACE FUNCTION fairshift_tip_line_integrity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Tip allocation lines are retained'; END IF;
 IF ROW(NEW.id, NEW.allocation_id, NEW.organisation_id, NEW.outlet_id, NEW.worker_id, NEW.worker_type, NEW.membership, NEW.share_minor, NEW.currency_code, NEW.local_date, NEW.created_at)
   IS DISTINCT FROM ROW(OLD.id, OLD.allocation_id, OLD.organisation_id, OLD.outlet_id, OLD.worker_id, OLD.worker_type, OLD.membership, OLD.share_minor, OLD.currency_code, OLD.local_date, OLD.created_at) THEN
   RAISE EXCEPTION 'Tip allocation line facts are immutable';
 END IF;
 RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER tip_allocation_lines_integrity BEFORE UPDATE OR DELETE ON "tip_allocation_lines" FOR EACH ROW EXECUTE FUNCTION fairshift_tip_line_integrity();--> statement-breakpoint
-- The tip journal: identity and decisions are final; events are retained.
CREATE OR REPLACE FUNCTION fairshift_tip_agent_event_integrity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Tip agent events are retained'; END IF;
 IF ROW(NEW.id, NEW.organisation_id, NEW.outlet_id, NEW.allocation_id, NEW.evidence_version, NEW.created_by, NEW.created_at) IS DISTINCT FROM ROW(OLD.id, OLD.organisation_id, OLD.outlet_id, OLD.allocation_id, OLD.evidence_version, OLD.created_by, OLD.created_at) THEN
   RAISE EXCEPTION 'Tip agent event identity is immutable';
 END IF;
 IF OLD.decision IS NOT NULL AND ROW(NEW.decision, NEW.reason_code, NEW.summary, NEW.decided_at) IS DISTINCT FROM ROW(OLD.decision, OLD.reason_code, OLD.summary, OLD.decided_at) THEN
   RAISE EXCEPTION 'A tip agent decision is final';
 END IF;
 IF OLD.released_by IS NOT NULL AND NEW.released_by IS DISTINCT FROM OLD.released_by THEN
   RAISE EXCEPTION 'An Owner release is final';
 END IF;
 IF NEW.attempt_count < OLD.attempt_count OR NEW.model_call_count < OLD.model_call_count THEN
   RAISE EXCEPTION 'Tip agent attempt counts never decrease';
 END IF;
 RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER tip_agent_events_integrity BEFORE UPDATE OR DELETE ON "tip_agent_events" FOR EACH ROW EXECUTE FUNCTION fairshift_tip_agent_event_integrity();
