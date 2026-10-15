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
