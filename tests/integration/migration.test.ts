import { readFile } from "node:fs/promises";
import path from "node:path";

import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";

describe("commercial provenance migration", () => {
  it("preserves existing PayPal sales and constrains newly seeded history", async () => {
    const client = new PGlite();
    try {
      const base = await readFile(path.resolve("drizzle/0000_fairshift_paypal_inbound.sql"), "utf8");
      for (const statement of base.split("--> statement-breakpoint")) if (statement.trim()) await client.exec(statement);
      await client.exec(`INSERT INTO sale_transactions (
        id, internal_reference, outlet_id, paypal_order_id, paypal_capture_id, paypal_custom_id,
        currency_code, gross_amount_minor, provider_status, reconciliation_state, verification_state,
        provider_created_at, reconciled_at
      ) VALUES (
        '40000000-0000-4000-8000-000000000001', 'FS-OLD',
        '20000000-0000-4000-8000-000000000001', 'ORDER-OLD', 'CAPTURE-OLD', 'FS-OLD',
        'USD', 500, 'COMPLETED', 'RECONCILED', 'VERIFIED', now(), now()
      )`);
      const migration = await readFile(path.resolve("drizzle/0001_commercial_provenance.sql"), "utf8");
      for (const statement of migration.split("--> statement-breakpoint")) if (statement.trim()) await client.exec(statement);
      const legacy = await client.query(`SELECT source, paypal_custom_id, verification_state FROM sale_transactions WHERE id = '40000000-0000-4000-8000-000000000001'`);
      expect(legacy.rows[0]).toMatchObject({ source: "PAYPAL_SANDBOX", paypal_custom_id: "FS-OLD", verification_state: "VERIFIED" });
      await expect(client.exec(`INSERT INTO sale_transactions (
        id, internal_reference, outlet_id, currency_code, gross_amount_minor, provider_status,
        verification_state, reconciliation_state, source
      ) VALUES (
        '40000000-0000-4000-8000-000000000002', 'DEMO-BAD',
        '20000000-0000-4000-8000-000000000001', 'USD', 500, 'DEMO_SEEDED',
        'VERIFIED', 'RECONCILED', 'DEMO_SEEDED'
      )`)).rejects.toThrow();
      await expect(client.exec(`INSERT INTO sale_transactions (
        id, internal_reference, outlet_id, currency_code, gross_amount_minor, provider_status,
        verification_state, reconciliation_state
      ) VALUES (
        '40000000-0000-4000-8000-000000000003', 'PAYPAL-BAD',
        '20000000-0000-4000-8000-000000000001', 'USD', 500, 'COMPLETED',
        'VERIFIED', 'RECONCILED'
      )`)).rejects.toThrow();
    } finally {
      await client.close();
    }
  });
});

describe("operational work-term migrations", () => {
  it("preserves historical offer and payment facts without inventing accepted-term evidence", async () => {
    const client = new PGlite();
    try {
      const journal = JSON.parse(await readFile("drizzle/meta/_journal.json", "utf8")) as {entries: {tag: string}[]};
      async function apply(tag: string) {
        const sql = await readFile(`drizzle/${tag}.sql`, "utf8");
        for (const statement of sql.split("--> statement-breakpoint")) if (statement.trim()) await client.exec(statement);
      }
      for (const entry of journal.entries.slice(0,4)) await apply(entry.tag);
      await client.exec(`INSERT INTO workers(id, organisation_id, display_name, worker_type, paypal_payout_email)
        VALUES ('30000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001','Historical worker','CASUAL','fixture@example.test');
        INSERT INTO shifts(id,outlet_id,shift_date,starts_at,ends_at,role_name,status,currency_code,guaranteed_base_pay_minor,gratuity_policy,incentive_policy)
        VALUES ('40000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000001','2026-01-01','2026-01-01T08:00Z','2026-01-01T14:00Z','Historical work','COMPLETED','USD',12000,'Original gratuity','Original incentive');
        INSERT INTO shift_offers(id,shift_id,worker_id,status,accepted_at,responded_at)
        VALUES ('50000000-0000-4000-8000-000000000001','40000000-0000-4000-8000-000000000001','30000000-0000-4000-8000-000000000001','ACCEPTED','2025-12-30T10:00Z','2025-12-30T10:00Z');
        INSERT INTO shift_incentives(id,shift_id,worker_id,performance_sales_minor,target_sales_minor,earned_amount_minor,status,approved_at,approved_by,paypal_sender_batch_id,paypal_sender_item_id,failure_code,submitted_at)
        VALUES ('70000000-0000-4000-8000-000000000001','40000000-0000-4000-8000-000000000001','30000000-0000-4000-8000-000000000001',72000,65000,2500,'FAILED','2026-01-01T15:00Z','fixture-manager','fixture-batch','fixture-item','PAYOUT_REQUEST_FAILED','2026-01-01T16:00Z');`);
      const beforeOffer = await client.query("SELECT * FROM shift_offers");
      const beforePayment = await client.query("SELECT * FROM shift_incentives");
      for (const entry of journal.entries.slice(4)) await apply(entry.tag);
      expect((await client.query("SELECT * FROM shift_offers")).rows).toEqual(beforeOffer.rows);
      expect((await client.query("SELECT * FROM shift_incentives")).rows).toEqual(beforePayment.rows);
      expect((await client.query("SELECT * FROM work_acceptances")).rows).toEqual([]);
      expect((await client.query("SELECT * FROM work_allocations")).rows).toEqual([]);
      expect((await client.query("SELECT earnings_model, rate_minor, expected_earnings_minor, terms_version FROM shifts")).rows[0]).toMatchObject({earnings_model:"DAILY", rate_minor:12000, expected_earnings_minor:12000, terms_version:1});
      expect((await client.query("SELECT paypal_payout_email, location_id, attribution_code FROM workers")).rows[0]).toMatchObject({paypal_payout_email:"fixture@example.test",location_id:"20000000-0000-4000-8000-000000000001",attribution_code:expect.stringMatching(/^FS-/)});
    } finally {await client.close();}
  });
});

describe("authenticated tenancy upgrade",()=>{
 it("hashes prepared invitation tokens, retains workforce attribution and grants no historical authority",async()=>{
  const client=new PGlite();try {
   const journal=JSON.parse(await readFile("drizzle/meta/_journal.json","utf8")) as {entries:{tag:string}[]};
   async function apply(tag:string) {for(const statement of (await readFile(`drizzle/${tag}.sql`,"utf8")).split("--> statement-breakpoint")) if(statement.trim()) await client.exec(statement);}
   for(const entry of journal.entries.slice(0,6)) await apply(entry.tag);
   await client.exec(`INSERT INTO workers(id,organisation_id,location_id,display_name,worker_type,email) VALUES ('30000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000001','Existing team','CASUAL','team@example.test');
    INSERT INTO team_invitations(id,worker_id,token) VALUES ('80000000-0000-4000-8000-000000000001','30000000-0000-4000-8000-000000000001','legacy-prepared-token');`);
   const before=(await client.query("SELECT attribution_code FROM workers")).rows;
   for(const entry of journal.entries.slice(6)) await apply(entry.tag);
   const [invitation]=(await client.query<{token:string}>("SELECT * FROM team_invitations")).rows;
   expect(invitation).toMatchObject({role:"TEAM_MEMBER",state:"CREATED_NOT_SENT",organisation_id:"10000000-0000-4000-8000-000000000001",email:"team@example.test",token:expect.stringMatching(/^[0-9a-f]{64}$/)});
   expect(invitation.token).not.toBe("legacy-prepared-token");
   expect((await client.query("SELECT attribution_code FROM workers")).rows).toEqual(before);
   expect((await client.query("SELECT * FROM organisation_memberships")).rows).toEqual([]);
   expect((await client.query("SELECT * FROM auth_users")).rows).toEqual([]);
   await expect(client.exec("UPDATE team_invitations SET token='plaintext'" )).rejects.toThrow();
  }finally{await client.close();}
 });
});

describe("Owner onboarding upgrade", () => {
 it("preserves existing 0007 identities, organisations, memberships, subscriptions and locations without fabricating profile/address data", async () => {
  const client=new PGlite();
  try {
   const journal=JSON.parse(await readFile("drizzle/meta/_journal.json","utf8")) as {entries:{tag:string}[]};
   async function apply(tag:string) {for(const statement of (await readFile(`drizzle/${tag}.sql`,"utf8")).split("--> statement-breakpoint")) if(statement.trim()) await client.exec(statement);}
   for(const entry of journal.entries.slice(0,8)) await apply(entry.tag);
   await client.exec(`INSERT INTO auth_users(id,email,name,password_hash,email_verified_at) VALUES ('90000000-0000-4000-8000-000000000001','owner@example.test','Historical Owner','fixture',now());
    UPDATE organisations SET name='FairShift Demo';
    INSERT INTO organisation_memberships(id,user_id,organisation_id,role) VALUES ('90000000-0000-4000-8000-000000000002','90000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001','OWNER');
    INSERT INTO organisation_subscriptions(id,organisation_id,request_id) VALUES ('90000000-0000-4000-8000-000000000003','10000000-0000-4000-8000-000000000001','90000000-0000-4000-8000-000000000004');`);
   const unchanged=["organisation_memberships","organisation_subscriptions","outlets"];
   const before=await Promise.all(unchanged.map(table=>client.query(`SELECT * FROM ${table}`)));
   const userBefore=(await client.query<Record<string,unknown>>("SELECT * FROM auth_users")).rows[0];
   const orgBefore=(await client.query<Record<string,unknown>>("SELECT * FROM organisations")).rows[0];
   for(const entry of journal.entries.slice(8,9)) await apply(entry.tag);
   for(const [i,table] of unchanged.entries()) expect((await client.query(`SELECT * FROM ${table}`)).rows).toEqual(before[i].rows);
   expect((await client.query("SELECT * FROM auth_users")).rows[0]).toEqual({...userBefore,title:null,first_name:null,surname:null,position:null,telephone:null});
   expect((await client.query("SELECT * FROM organisations")).rows[0]).toEqual({...orgBefore,business_address:null,city:null,province:null,postal_code:null,country:null});
   await expect(client.exec("UPDATE auth_users SET title='Invalid'" )).rejects.toThrow();
  } finally {await client.close();}
 });
});

describe("subscription-first 0008 to 0009 upgrade",()=>{
 it("preserves legacy data, backfills only completed workplaces, and leaves commercial limits unassigned",async()=>{
  const client=new PGlite();try {
   const journal=JSON.parse(await readFile("drizzle/meta/_journal.json","utf8")) as {entries:{tag:string}[]};
   async function apply(tag:string) {for(const statement of (await readFile(`drizzle/${tag}.sql`,"utf8")).split("--> statement-breakpoint")) if(statement.trim()) await client.exec(statement);}
   for(const entry of journal.entries.slice(0,9)) await apply(entry.tag);
   await client.exec(`INSERT INTO auth_users(id,email,name,password_hash,email_verified_at,title,first_name,surname,position,telephone) VALUES ('90000000-0000-4000-8000-000000000001','owner@example.test','Sam Taylor','fixture',now(),'Ms','Sam','Taylor','Owner','+27111234567');
    UPDATE organisations SET name='FairShift Demo',business_address='1 Business Road',city='Johannesburg',province='Gauteng',postal_code='2000',country='South Africa';
    INSERT INTO organisation_memberships(id,user_id,organisation_id,role) VALUES ('90000000-0000-4000-8000-000000000002','90000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001','OWNER');
    INSERT INTO organisation_subscriptions(id,organisation_id,request_id,status,provider_id,plan_id,verified_at) VALUES ('90000000-0000-4000-8000-000000000003','10000000-0000-4000-8000-000000000001','90000000-0000-4000-8000-000000000004','ACTIVE','I-LEGACY','P-LEGACY',now());
    INSERT INTO organisations(id,name) VALUES ('90000000-0000-4000-8000-000000000005','Incomplete business');`);
   const unchanged=["auth_users","organisation_memberships","shift_offers","shift_incentives","sale_transactions"];
   const before=await Promise.all(unchanged.map(table=>client.query(`SELECT * FROM ${table}`)));
   const orgBefore=(await client.query<Record<string,unknown>>("SELECT * FROM organisations WHERE name='FairShift Demo'")).rows[0];
   const subBefore=(await client.query<Record<string,unknown>>("SELECT * FROM organisation_subscriptions")).rows[0];
   const locationBefore=(await client.query<Record<string,unknown>>("SELECT * FROM outlets")).rows;
   await apply(journal.entries[9].tag);
   for(const [i,table] of unchanged.entries()) expect((await client.query(`SELECT * FROM ${table}`)).rows).toEqual(before[i].rows);
   expect((await client.query("SELECT * FROM organisation_subscriptions")).rows[0]).toEqual({...subBefore,tier:null,billing_period:null,location_limit:null});
   expect((await client.query("SELECT * FROM outlets")).rows).toEqual(locationBefore.map(row=>({...row,active:true})));
   expect((await client.query("SELECT * FROM organisations WHERE name='FairShift Demo'")).rows[0]).toEqual({...orgBefore,setup_completed_at:orgBefore.updated_at});
   expect((await client.query("SELECT setup_completed_at FROM organisations WHERE name='Incomplete business'")).rows[0]).toEqual({setup_completed_at:null});
   for(const values of ["tier='SINGLE_OUTLET',billing_period='MONTHLY',location_limit=2","tier='MULTI_OUTLET',billing_period='ANNUAL',location_limit=6","tier='SINGLE_OUTLET',billing_period='MONTHLY',location_limit=null","tier='ENTERPRISE',location_limit=0","tier=null,location_limit=3","tier='MULTI_OUTLET',location_limit=5,billing_period=null"]) await expect(client.exec(`UPDATE organisation_subscriptions SET ${values}`)).rejects.toThrow();
  }finally{await client.close();}
 });
});

describe("location address upgrade",()=>{
 it("adds only nullable address columns and preserves existing locations without backfill",async()=>{
  const client=new PGlite();try {
   const journal=JSON.parse(await readFile("drizzle/meta/_journal.json","utf8")) as {entries:{tag:string}[]};
   async function apply(tag:string) {for(const statement of (await readFile(`drizzle/${tag}.sql`,"utf8")).split("--> statement-breakpoint")) if(statement.trim()) await client.exec(statement);}
   for(const entry of journal.entries.slice(0,10)) await apply(entry.tag);
   const before=(await client.query<Record<string,unknown>>("SELECT * FROM outlets ORDER BY id")).rows;
   expect(before.length).toBeGreaterThan(0);
   await apply(journal.entries[10].tag);
   expect((await client.query("SELECT * FROM outlets ORDER BY id")).rows).toEqual(before.map(row=>({...row,address:null,city:null,province:null,postal_code:null,country:null})));
   const columns=await client.query<{column_name:string;is_nullable:string;column_default:string|null}>("SELECT column_name,is_nullable,column_default FROM information_schema.columns WHERE table_name='outlets' AND column_name IN ('address','city','province','postal_code','country')");
   expect(columns.rows).toHaveLength(5);
   for(const column of columns.rows) expect(column).toMatchObject({is_nullable:"YES",column_default:null});
  }finally{await client.close();}
 });
});

describe("reference sales history upgrade",()=>{
 it("keeps existing PayPal and demo sales unchanged and admits only well-formed reference rows",async()=>{
  const client=new PGlite();try {
   const journal=JSON.parse(await readFile("drizzle/meta/_journal.json","utf8")) as {entries:{tag:string}[]};
   async function apply(tag:string) {for(const statement of (await readFile(`drizzle/${tag}.sql`,"utf8")).split("--> statement-breakpoint")) if(statement.trim()) await client.exec(statement);}
   for(const entry of journal.entries.slice(0,11)) await apply(entry.tag);
   await client.exec(`INSERT INTO sale_transactions (id,internal_reference,outlet_id,paypal_order_id,paypal_capture_id,paypal_custom_id,currency_code,gross_amount_minor,provider_status,reconciliation_state,verification_state,provider_created_at,reconciled_at,source)
     VALUES ('40000000-0000-4000-8000-000000000011','FS-PAYPAL','20000000-0000-4000-8000-000000000001','ORDER-1','CAPTURE-1','FS-PAYPAL','USD',500,'COMPLETED','RECONCILED','VERIFIED',now(),now(),'PAYPAL_SANDBOX'),
     ('40000000-0000-4000-8000-000000000012','DEMO-1','20000000-0000-4000-8000-000000000001',null,null,null,'USD',700,'DEMO_SEEDED','NOT_RECONCILED','PENDING',null,null,'DEMO_SEEDED')`);
   const before=(await client.query<Record<string,unknown>>("SELECT * FROM sale_transactions ORDER BY id")).rows;
   expect(journal.entries[11].tag).toBe("0011_reference_sales_history");
   await apply(journal.entries[11].tag);
   expect((await client.query("SELECT * FROM sale_transactions ORDER BY id")).rows).toEqual(before.map(row=>({...row,occurred_at:null})));
   const reference=`INSERT INTO sale_transactions (id,internal_reference,outlet_id,currency_code,gross_amount_minor,provider_status,source,occurred_at) VALUES`;
   await expect(client.exec(`${reference} ('40000000-0000-4000-8000-000000000013','REF-1','20000000-0000-4000-8000-000000000001','GBP',900,'REFERENCE','REFERENCE',null)`)).rejects.toThrow();
   await expect(client.exec(`${reference} ('40000000-0000-4000-8000-000000000013','REF-1','20000000-0000-4000-8000-000000000001','GBP',900,'COMPLETED','REFERENCE',now())`)).rejects.toThrow();
   await expect(client.exec(`${reference} ('40000000-0000-4000-8000-000000000013','REF-1','20000000-0000-4000-8000-000000000001','GBP',900,'REFERENCE','ZETTLE',now())`)).rejects.toThrow();
   await client.exec(`${reference} ('40000000-0000-4000-8000-000000000013','REF-1','20000000-0000-4000-8000-000000000001','GBP',900,'REFERENCE','REFERENCE',now())`);
  }finally{await client.close();}
 });
});

describe("work payable upgrade", () => {
 it("gives existing policies their location currency and leaves shifts, acceptances, allocations and payouts unchanged", async () => {
  const client = new PGlite();
  try {
   const journal = JSON.parse(await readFile("drizzle/meta/_journal.json", "utf8")) as {entries: {tag: string}[]};
   async function apply(tag: string) {for (const statement of (await readFile(`drizzle/${tag}.sql`, "utf8")).split("--> statement-breakpoint")) if (statement.trim()) await client.exec(statement);}
   for (const entry of journal.entries.slice(0, 13)) await apply(entry.tag);
   await client.exec(`
    INSERT INTO organisations (id, name, country) VALUES
     ('10000000-0000-4000-8000-0000000000c1', 'UK company', 'United Kingdom'),
     ('10000000-0000-4000-8000-0000000000c2', 'SA company', 'South Africa');
    INSERT INTO outlets (id, organisation_id, name, timezone, country) VALUES
     ('20000000-0000-4000-8000-0000000000d1', '10000000-0000-4000-8000-0000000000c1', 'UK, no country', 'Europe/London', NULL),
     ('20000000-0000-4000-8000-0000000000d2', '10000000-0000-4000-8000-0000000000c1', 'Abroad', 'Africa/Johannesburg', 'South Africa'),
     ('20000000-0000-4000-8000-0000000000d3', '10000000-0000-4000-8000-0000000000c2', 'In England', 'Europe/London', ' england ');
    INSERT INTO work_policies (id, outlet_id, name, earnings_model, rate_minor) VALUES
     ('60000000-0000-4000-8000-0000000000e1', '20000000-0000-4000-8000-0000000000d1', 'UK hourly', 'HOURLY', 1200),
     ('60000000-0000-4000-8000-0000000000e2', '20000000-0000-4000-8000-0000000000d2', 'Abroad daily', 'DAILY', 15000),
     ('60000000-0000-4000-8000-0000000000e3', '20000000-0000-4000-8000-0000000000d3', 'England hourly', 'HOURLY', 1300),
     ('60000000-0000-4000-8000-0000000000e4', '20000000-0000-4000-8000-000000000001', 'Rosebank hourly', 'HOURLY', 2000);
    INSERT INTO shifts (id, outlet_id, policy_id, earnings_model, rate_minor, expected_earnings_minor, shift_date, starts_at, ends_at, role_name, status, currency_code, guaranteed_base_pay_minor, gratuity_policy, incentive_policy)
     VALUES ('40000000-0000-4000-8000-0000000000f1', '20000000-0000-4000-8000-0000000000d1', '60000000-0000-4000-8000-0000000000e1', 'HOURLY', 1200, 7200, '2026-10-20', '2026-10-20T08:00:00Z', '2026-10-20T14:00:00Z', 'General', 'PUBLISHED', 'USD', 7200, 'None', 'None');
    INSERT INTO workers (id, organisation_id, display_name, worker_type, location_id) VALUES ('30000000-0000-4000-8000-0000000000f2', '10000000-0000-4000-8000-0000000000c1', 'Casual', 'CASUAL', '20000000-0000-4000-8000-0000000000d1');
    INSERT INTO shift_offers (id, shift_id, worker_id, status, responded_at, accepted_at) VALUES ('50000000-0000-4000-8000-0000000000f3', '40000000-0000-4000-8000-0000000000f1', '30000000-0000-4000-8000-0000000000f2', 'ACCEPTED', now(), now());
    INSERT INTO work_acceptances (id, offer_id, worker_id, terms_version, snapshot) VALUES ('70000000-0000-4000-8000-0000000000f4', '50000000-0000-4000-8000-0000000000f3', '30000000-0000-4000-8000-0000000000f2', 1, '{"currencyCode":"USD","rateMinor":1200}');
    INSERT INTO work_allocations (id, offer_id, acceptance_id, confirmed_at) VALUES ('80000000-0000-4000-8000-0000000000f5', '50000000-0000-4000-8000-0000000000f3', '70000000-0000-4000-8000-0000000000f4', now());
    INSERT INTO shift_incentives (id, shift_id, worker_id, performance_sales_minor, target_sales_minor, earned_amount_minor, status, approved_at, approved_by, payout_recipient, paypal_sender_batch_id, paypal_sender_item_id, paypal_batch_id, paypal_item_id, paypal_status, paid_at)
     VALUES ('90000000-0000-4000-8000-0000000000f6', '40000000-0000-4000-8000-0000000000f1', '30000000-0000-4000-8000-0000000000f2', 70000, 65000, 2500, 'PAID', now(), 'DEMO_MANAGER', 'worker@example.test', 'FS-BATCH-X', 'FS-ITEM-X', 'BATCH-X', 'ITEM-X', 'SUCCESS', now());`);
   const snapshot = async () => Object.fromEntries(await Promise.all(["shifts", "shift_offers", "work_acceptances", "work_allocations", "shift_incentives", "sale_transactions"].map(async table => [table, (await client.query(`SELECT * FROM ${table} ORDER BY id`)).rows])));
   const before = await snapshot();
   expect(journal.entries[13].tag).toBe("0013_work_payables");
   await apply(journal.entries[13].tag);
   expect(await snapshot()).toEqual(before);
   const policies = (await client.query<{ name: string; currency_code: string }>("SELECT name, currency_code FROM work_policies ORDER BY id")).rows;
   expect(Object.fromEntries(policies.map(row => [row.name, row.currency_code]))).toEqual({ "UK hourly": "GBP", "Abroad daily": "USD", "England hourly": "GBP", "Rosebank hourly": "USD" });
   // No payable is fabricated for work confirmed before payables existed.
   expect((await client.query("SELECT count(*)::int AS count FROM work_payables")).rows[0]).toEqual({ count: 0 });
   await expect(client.exec("INSERT INTO work_policies (id, outlet_id, name, earnings_model, rate_minor) VALUES ('60000000-0000-4000-8000-0000000000e9', '20000000-0000-4000-8000-0000000000d1', 'No currency', 'HOURLY', 1200)")).rejects.toThrow();
  } finally { await client.close(); }
 });

 it("keeps existing payables awaiting review and incentive payouts unchanged, and creates no payouts", async () => {
  const client = new PGlite();
  try {
   const journal = JSON.parse(await readFile("drizzle/meta/_journal.json", "utf8")) as {entries: {tag: string}[]};
   async function apply(tag: string) {for (const statement of (await readFile(`drizzle/${tag}.sql`, "utf8")).split("--> statement-breakpoint")) if (statement.trim()) await client.exec(statement);}
   for (const entry of journal.entries.slice(0, 14)) await apply(entry.tag);
   await client.exec(`
    INSERT INTO organisations (id, name, country) VALUES ('10000000-0000-4000-8000-0000000001c1', 'UK company', 'United Kingdom');
    INSERT INTO outlets (id, organisation_id, name, timezone) VALUES ('20000000-0000-4000-8000-0000000001d1', '10000000-0000-4000-8000-0000000001c1', 'Leeds', 'Europe/London');
    INSERT INTO work_policies (id, outlet_id, name, earnings_model, rate_minor, currency_code) VALUES ('60000000-0000-4000-8000-0000000001e1', '20000000-0000-4000-8000-0000000001d1', 'UK hourly', 'HOURLY', 1200, 'GBP');
    INSERT INTO shifts (id, outlet_id, policy_id, earnings_model, rate_minor, expected_earnings_minor, shift_date, starts_at, ends_at, role_name, status, currency_code, guaranteed_base_pay_minor, gratuity_policy, incentive_policy)
     VALUES ('40000000-0000-4000-8000-0000000001f1', '20000000-0000-4000-8000-0000000001d1', '60000000-0000-4000-8000-0000000001e1', 'HOURLY', 1200, 7200, '2026-10-20', '2026-10-20T08:00:00Z', '2026-10-20T14:00:00Z', 'General', 'PUBLISHED', 'GBP', 7200, 'None', 'None');
    INSERT INTO workers (id, organisation_id, display_name, worker_type, location_id, paypal_payout_email) VALUES ('30000000-0000-4000-8000-0000000001f2', '10000000-0000-4000-8000-0000000001c1', 'Casual', 'CASUAL', '20000000-0000-4000-8000-0000000001d1', 'worker@example.test');
    INSERT INTO shift_offers (id, shift_id, worker_id, status, responded_at, accepted_at) VALUES ('50000000-0000-4000-8000-0000000001f3', '40000000-0000-4000-8000-0000000001f1', '30000000-0000-4000-8000-0000000001f2', 'ACCEPTED', now(), now());
    INSERT INTO work_acceptances (id, offer_id, worker_id, terms_version, snapshot) VALUES ('70000000-0000-4000-8000-0000000001f4', '50000000-0000-4000-8000-0000000001f3', '30000000-0000-4000-8000-0000000001f2', 1,
     '{"earningsModel":"HOURLY","currencyCode":"GBP","rateMinor":1200,"expectedEarningsMinor":7200,"startsAt":"2026-10-20T08:00:00.000Z","endsAt":"2026-10-20T14:00:00.000Z"}');
    INSERT INTO work_allocations (id, offer_id, acceptance_id, confirmed_at) VALUES ('80000000-0000-4000-8000-0000000001f5', '50000000-0000-4000-8000-0000000001f3', '70000000-0000-4000-8000-0000000001f4', '2026-10-21T09:00:00Z');
    INSERT INTO work_payables (id, organisation_id, outlet_id, shift_id, worker_id, offer_id, allocation_id, acceptance_id, terms_version, calculation_method, earnings_model, currency_code, rate_minor, scheduled_starts_at, scheduled_ends_at, base_amount_minor, confirmed_at)
     VALUES ('a0000000-0000-4000-8000-0000000001f7', '10000000-0000-4000-8000-0000000001c1', '20000000-0000-4000-8000-0000000001d1', '40000000-0000-4000-8000-0000000001f1', '30000000-0000-4000-8000-0000000001f2', '50000000-0000-4000-8000-0000000001f3', '80000000-0000-4000-8000-0000000001f5', '70000000-0000-4000-8000-0000000001f4', 1, 'confirm-as-scheduled-v1', 'HOURLY', 'GBP', 1200, '2026-10-20T08:00:00Z', '2026-10-20T14:00:00Z', 7200, '2026-10-21T09:00:00Z');
    INSERT INTO shift_incentives (id, shift_id, worker_id, performance_sales_minor, target_sales_minor, earned_amount_minor, status, approved_at, approved_by, payout_recipient, paypal_sender_batch_id, paypal_sender_item_id, paypal_batch_id, paypal_item_id, paypal_status, paid_at)
     VALUES ('90000000-0000-4000-8000-0000000001f6', '40000000-0000-4000-8000-0000000001f1', '30000000-0000-4000-8000-0000000001f2', 70000, 65000, 2500, 'PAID', now(), 'DEMO_MANAGER', 'worker@example.test', 'FS-BATCH-Y', 'FS-ITEM-Y', 'BATCH-Y', 'ITEM-Y', 'SUCCESS', now());`);
   const snapshot = async () => Object.fromEntries(await Promise.all(["shifts", "shift_offers", "work_acceptances", "work_allocations", "shift_incentives", "workers"].map(async table => [table, (await client.query(`SELECT * FROM ${table} ORDER BY id`)).rows])));
   const before = await snapshot();
   const payableBefore = (await client.query<Record<string, unknown>>("SELECT * FROM work_payables")).rows[0];
   expect(journal.entries[14].tag).toBe("0014_work_payouts");
   await apply(journal.entries[14].tag);
   expect(await snapshot()).toEqual(before);
   expect((await client.query("SELECT * FROM work_payables")).rows[0]).toEqual({ ...payableBefore, approved_at: null, approved_by: null, approved_amount_minor: null, approved_currency_code: null });
   // Nothing is approved or paid by the migration.
   expect((await client.query("SELECT count(*)::int AS count FROM work_payouts")).rows[0]).toEqual({ count: 0 });
   await expect(client.exec("UPDATE work_payables SET base_amount_minor = 1")).rejects.toThrow();
  } finally { await client.close(); }
 });

 it("adds the AI assessment store without touching existing records", async () => {
  const client = new PGlite();
  try {
   const journal = JSON.parse(await readFile("drizzle/meta/_journal.json", "utf8")) as {entries: {tag: string}[]};
   async function apply(tag: string) {for (const statement of (await readFile(`drizzle/${tag}.sql`, "utf8")).split("--> statement-breakpoint")) if (statement.trim()) await client.exec(statement);}
   for (const entry of journal.entries.slice(0, 15)) await apply(entry.tag);
   await client.exec(`INSERT INTO organisations (id, name, country) VALUES ('10000000-0000-4000-8000-0000000002c1', 'UK company', 'United Kingdom');
    INSERT INTO outlets (id, organisation_id, name, timezone) VALUES ('20000000-0000-4000-8000-0000000002d1', '10000000-0000-4000-8000-0000000002c1', 'Leeds', 'Europe/London');`);
   const tables = async () => Object.fromEntries(await Promise.all(["organisations", "outlets", "sale_transactions", "work_payables", "work_payouts", "audit_events"].map(async table => [table, (await client.query(`SELECT * FROM ${table} ORDER BY 1`)).rows])));
   const before = await tables();
   expect(journal.entries[15].tag).toBe("0015_ai_staffing_assessments");
   await apply(journal.entries[15].tag);
   expect(await tables()).toEqual(before);
   expect((await client.query("SELECT count(*)::int AS count FROM ai_staffing_assessments")).rows[0]).toEqual({ count: 0 });
  } finally { await client.close(); }
 });

 it("adds business labour policy and imported provenance without changing existing records", async () => {
  const client = new PGlite();
  try {
   const journal = JSON.parse(await readFile("drizzle/meta/_journal.json", "utf8")) as {entries: {tag: string}[]};
   async function apply(tag: string) {for (const statement of (await readFile(`drizzle/${tag}.sql`, "utf8")).split("--> statement-breakpoint")) if (statement.trim()) await client.exec(statement);}
   for (const entry of journal.entries.slice(0, 16)) await apply(entry.tag);
   await client.exec(`INSERT INTO organisations (id, name, country) VALUES ('10000000-0000-4000-8000-0000000003c1', 'UK company', 'United Kingdom');
    INSERT INTO outlets (id, organisation_id, name, timezone) VALUES ('20000000-0000-4000-8000-0000000003d1', '10000000-0000-4000-8000-0000000003c1', 'Leeds', 'Europe/London');
    INSERT INTO sale_transactions (id, internal_reference, outlet_id, source, currency_code, gross_amount_minor, provider_status, occurred_at) VALUES ('40000000-0000-4000-8000-0000000003e1', 'REF:OLD', '20000000-0000-4000-8000-0000000003d1', 'REFERENCE', 'GBP', 900, 'REFERENCE', '2025-12-01T10:00:00Z');
    INSERT INTO regular_staff_coverage (id, organisation_id, outlet_id, iso_weekday, planned_minutes, source) VALUES ('50000000-0000-4000-8000-0000000003f1', '10000000-0000-4000-8000-0000000003c1', '20000000-0000-4000-8000-0000000003d1', 1, 480, 'REFERENCE');`);
   const rows = async (table: string) => (await client.query<Record<string, unknown>>(`SELECT * FROM ${table} ORDER BY 1`)).rows;
   const [sales, coverage, payables, payouts] = await Promise.all(["sale_transactions", "regular_staff_coverage", "work_payables", "work_payouts"].map(rows));
   expect(journal.entries[16].tag).toBe("0016_business_labour_policy");
   await apply(journal.entries[16].tag);
   expect((await rows("sale_transactions")).map(row => { const { source_system, source_transaction_id, ...rest } = row; expect([source_system, source_transaction_id]).toEqual([null, null]); return rest; })).toEqual(sales);
   expect(await rows("regular_staff_coverage")).toEqual(coverage);
   expect(await rows("work_payables")).toEqual(payables);
   expect(await rows("work_payouts")).toEqual(payouts);
   // No policy is invented for anyone, including existing reference data.
   expect(await rows("labour_policies")).toEqual([]);
   const org = "10000000-0000-4000-8000-0000000003c1", outlet = "20000000-0000-4000-8000-0000000003d1";
   const policy = (id: string, values: string) => client.exec(`INSERT INTO labour_policies (id, organisation_id, outlet_id, version, currency_code, sales_minor_per_labour_hour, source) VALUES ('${id}', '${org}', ${values})`);
   for (const invalid of [`null, 1, 'GBP', 0, 'CONFIGURED'`, `null, 1, 'GBP', -1, 'CONFIGURED'`, `null, 1, 'GBP', 10000001, 'CONFIGURED'`, `null, 1, 'gbp', 100, 'CONFIGURED'`, `null, 0, 'GBP', 100, 'CONFIGURED'`, `null, 1, 'GBP', 100, 'GUESSED'`]) {
    await expect(policy("60000000-0000-4000-8000-0000000003a1", invalid)).rejects.toThrow();
   }
   await policy("60000000-0000-4000-8000-0000000003a1", `null, 1, 'GBP', 10000, 'CONFIGURED'`);
   // One active policy per scope; versions immutable and retained.
   await expect(policy("60000000-0000-4000-8000-0000000003a2", `null, 2, 'GBP', 7500, 'CONFIGURED'`)).rejects.toThrow();
   await policy("60000000-0000-4000-8000-0000000003a3", `'${outlet}', 1, 'GBP', 18000, 'CONFIGURED'`);
   await expect(client.exec(`UPDATE labour_policies SET sales_minor_per_labour_hour = 1 WHERE outlet_id IS NULL`)).rejects.toThrow(/immutable/);
   await expect(client.exec(`DELETE FROM labour_policies`)).rejects.toThrow(/retained/);
   // Imported rows need source identity and carry no provider or verification claim.
   const sale = (id: string, cols: string, values: string) => client.exec(`INSERT INTO sale_transactions (id, internal_reference, outlet_id, source, currency_code, gross_amount_minor, provider_status, occurred_at${cols}) VALUES ('${id}', '${id}', '${outlet}', 'IMPORTED', 'GBP', 100, 'IMPORTED', now()${values})`);
   await expect(sale("70000000-0000-4000-8000-0000000003b1", "", "")).rejects.toThrow();
   await expect(sale("70000000-0000-4000-8000-0000000003b2", ", source_system, source_transaction_id, verification_state", ", 'till', 'T1', 'VERIFIED'")).rejects.toThrow();
   await expect(sale("70000000-0000-4000-8000-0000000003b3", ", source_system, source_transaction_id, paypal_capture_id", ", 'till', 'T1', 'CAP1'")).rejects.toThrow();
   await sale("70000000-0000-4000-8000-0000000003b4", ", source_system, source_transaction_id", ", 'till', 'T1'");
   await expect(sale("70000000-0000-4000-8000-0000000003b5", ", source_system, source_transaction_id", ", 'till', 'T1'")).rejects.toThrow();
   await client.exec(`UPDATE regular_staff_coverage SET source = 'CONFIGURED', planned_minutes = 0`);
   await expect(client.exec(`UPDATE regular_staff_coverage SET source = 'GUESSED'`)).rejects.toThrow();
  } finally { await client.close(); }
 });

 it("adds worker availability without changing existing records or inventing availability", async () => {
  const client = new PGlite();
  try {
   const journal = JSON.parse(await readFile("drizzle/meta/_journal.json", "utf8")) as {entries: {tag: string}[]};
   async function apply(tag: string) {for (const statement of (await readFile(`drizzle/${tag}.sql`, "utf8")).split("--> statement-breakpoint")) if (statement.trim()) await client.exec(statement);}
   for (const entry of journal.entries.slice(0, 17)) await apply(entry.tag);
   await client.exec(`INSERT INTO organisations (id, name, country) VALUES ('10000000-0000-4000-8000-0000000004c1', 'UK company', 'United Kingdom');
    INSERT INTO workers (id, organisation_id, display_name, worker_type) VALUES ('30000000-0000-4000-8000-0000000004d1', '10000000-0000-4000-8000-0000000004c1', 'Casual', 'CASUAL');`);
   const tables = async () => Object.fromEntries(await Promise.all(["workers", "shifts", "shift_offers", "work_acceptances", "work_allocations", "work_payables", "work_payouts", "sale_transactions", "organisation_subscriptions"].map(async table => [table, (await client.query(`SELECT * FROM ${table} ORDER BY 1`)).rows])));
   const before = await tables();
   expect(journal.entries[17].tag).toBe("0017_worker_availability");
   await apply(journal.entries[17].tag);
   expect(await tables()).toEqual(before);
   expect((await client.query("SELECT count(*)::int AS count FROM worker_availability")).rows[0]).toEqual({ count: 0 });
   const row = (id: string, weekday: number, state: string) => client.exec(`INSERT INTO worker_availability (id, worker_id, iso_weekday, state) VALUES ('${id}', '30000000-0000-4000-8000-0000000004d1', ${weekday}, '${state}')`);
   await expect(row("40000000-0000-4000-8000-0000000004e1", 0, "AVAILABLE")).rejects.toThrow();
   await expect(row("40000000-0000-4000-8000-0000000004e1", 8, "AVAILABLE")).rejects.toThrow();
   await expect(row("40000000-0000-4000-8000-0000000004e1", 1, "MAYBE")).rejects.toThrow();
   await row("40000000-0000-4000-8000-0000000004e1", 1, "AVAILABLE");
   await expect(row("40000000-0000-4000-8000-0000000004e2", 1, "UNAVAILABLE")).rejects.toThrow();
  } finally { await client.close(); }
 });
});
