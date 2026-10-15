ALTER TABLE "work_allocations" ADD COLUMN "confirmed_at" timestamp with time zone;--> statement-breakpoint
CREATE FUNCTION fairshift_stable_attribution_code() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.attribution_code IS DISTINCT FROM OLD.attribution_code THEN RAISE EXCEPTION 'FairShift attribution codes are stable'; END IF;
 RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER fairshift_attribution_code_immutable BEFORE UPDATE ON workers FOR EACH ROW EXECUTE FUNCTION fairshift_stable_attribution_code();
--> statement-breakpoint
CREATE FUNCTION fairshift_validate_work_terms() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.department_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM departments WHERE id = NEW.department_id AND outlet_id = NEW.outlet_id) THEN
   RAISE EXCEPTION 'Department must belong to the assignment location';
 END IF;
 IF NEW.earnings_model = 'DAILY' AND TG_OP = 'INSERT' THEN
   NEW.rate_minor := COALESCE(NEW.rate_minor, NEW.guaranteed_base_pay_minor);
   NEW.expected_earnings_minor := COALESCE(NEW.expected_earnings_minor, NEW.rate_minor);
 END IF;
 IF NEW.earnings_model = 'COMMISSION' THEN
   IF NEW.rate_minor IS NOT NULL OR NEW.expected_earnings_minor IS NOT NULL OR NEW.guaranteed_base_pay_minor != 0 OR NEW.commission_bps IS NULL OR NEW.commission_bps NOT BETWEEN 0 AND 10000 OR NEW.commission_basis IS DISTINCT FROM 'VERIFIED_ATTRIBUTED_SALES' THEN
     RAISE EXCEPTION 'Commission requires a percentage and verified attribution basis, without fixed earnings';
   END IF;
 ELSIF NEW.earnings_model IN ('DAILY', 'HOURLY') THEN
   IF NEW.rate_minor IS NULL OR NEW.rate_minor < 0 OR NEW.rate_minor > 9007199254740991 OR NEW.expected_earnings_minor IS NULL OR NEW.expected_earnings_minor < 0 OR NEW.expected_earnings_minor > 9007199254740991 OR NEW.commission_bps IS NOT NULL OR NEW.commission_basis IS NOT NULL THEN
     RAISE EXCEPTION 'Invalid fixed work terms';
   END IF;
   IF NEW.earnings_model = 'DAILY' AND NEW.expected_earnings_minor != NEW.rate_minor THEN
     RAISE EXCEPTION 'Daily earnings must preserve the daily rate';
   END IF;
   IF NEW.earnings_model = 'HOURLY' AND NEW.expected_earnings_minor::numeric * 3600 != NEW.rate_minor::numeric * EXTRACT(EPOCH FROM NEW.ends_at - NEW.starts_at) THEN
     RAISE EXCEPTION 'Hourly earnings must match exact scheduled duration';
   END IF;
 ELSE RAISE EXCEPTION 'Unsupported earnings model';
 END IF;
 RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER fairshift_validate_work_terms BEFORE INSERT OR UPDATE ON shifts FOR EACH ROW EXECUTE FUNCTION fairshift_validate_work_terms();
