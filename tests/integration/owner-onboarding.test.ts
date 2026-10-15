import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { createTestDatabase } from "../helpers/database";
import { personal, business } from "../helpers/onboarding";
import { registerIdentity } from "@/server/auth/identity";
import { createOrganisation } from "@/server/auth/tenancy";
import { personalDetails, businessDetails, savePersonalDetails, saveBusinessDetails } from "@/server/auth/onboarding";
import { organisationEntitled, isEntitled } from "@/server/billing/entitlement";
import { memberships, organisations, outlets, subscriptions, users } from "@/server/db/schema";

describe("personal and business onboarding", () => {
  it("migrates a blank database through 0008 with the new nullable fields and title constraint", async () => {
    const t=await createTestDatabase();
    try {
      const journal=await t.db.execute(sql`SELECT count(*)::int AS count FROM drizzle.__drizzle_migrations`);
      expect(journal.rows[0]).toMatchObject({count:9});
      const id=randomUUID();
      await t.db.insert(users).values({id,email:"historical@example.test",name:"Existing identity",passwordHash:"unused"});
      expect((await t.db.select().from(users))[0]).toMatchObject({title:null,firstName:null,surname:null,position:null,telephone:null});
      await expect(t.db.execute(sql`UPDATE auth_users SET title='Invalid'`)).rejects.toThrow();
    } finally {await t.close();}
  });

  it("requires all personal fields, controlled title, and retains the canonical identity email", async () => {
    const t = await createTestDatabase();
    try {
      for (const key of Object.keys(personal)) {
        await expect(registerIdentity(t.db, {...personal, [key]: "", email:"owner@example.test", password:"long-test-password-42"})).rejects.toThrow();
      }
      expect(personalDetails.safeParse({...personal,title:"Professor"}).success).toBe(false);
      expect(await t.db.select().from(users)).toHaveLength(0);
      const identity = await registerIdentity(t.db, {...personal,email:" OWNER@EXAMPLE.TEST ",password:"long-test-password-42"});
      await savePersonalDetails(t.db,identity.id,{...personal,firstName:"Updated"});
      const [user] = await t.db.select().from(users).where(eq(users.id,identity.id));
      expect(user).toMatchObject({...personal,firstName:"Updated",name:"Updated Taylor",email:"owner@example.test"});
      await expect(savePersonalDetails(t.db,identity.id,{...personal,email:"replacement@example.test"})).rejects.toThrow();
    } finally {await t.close();}
  });
  it("requires verification and complete business fields, then atomically creates Owner, workplace, and unconfigured subscription", async () => {
    const t = await createTestDatabase();
    try {
      const id = randomUUID();
      await t.db.insert(users).values({id,email:"owner@example.test",name:"Sam Taylor",passwordHash:"unused",...personal});
      const input={...business,name:"FairShift Demo",locationName:"Johannesburg store"};
      await expect(createOrganisation(t.db,id,input)).rejects.toThrow(/Verify/);
      await t.db.update(users).set({emailVerifiedAt:new Date()}).where(eq(users.id,id));
      for (const key of Object.keys(business)) {
        await expect(createOrganisation(t.db,id,{...input,[key]:""})).rejects.toThrow();
      }
      expect(await t.db.select().from(memberships)).toHaveLength(0);
      const result = await createOrganisation(t.db,id,input);
      const [org] = await t.db.select().from(organisations).where(eq(organisations.id,result.organisationId));
      const [location] = await t.db.select().from(outlets).where(eq(outlets.id,result.locationId));
      expect(org).toMatchObject({...business,name:"FairShift Demo"});
      expect(location).toMatchObject({organisationId:org.id,name:"Johannesburg store"});
      expect(org.businessAddress).not.toBe(location.name);
      expect(await t.db.select().from(memberships).where(eq(memberships.organisationId,org.id))).toMatchObject([{userId:id,role:"OWNER",outletId:null,invitationId:null}]);
      expect(await t.db.select().from(subscriptions).where(eq(subscriptions.organisationId,org.id))).toMatchObject([{status:"UNCONFIGURED",verifiedAt:null,providerId:null}]);
      expect(await organisationEntitled(t.db,org.id)).toBe(false);
    } finally {await t.close();}
  });
  it("rolls back all organisation creation when location persistence fails", async () => {
    const t = await createTestDatabase();
    try {
      const id=randomUUID();
      await t.db.insert(users).values({id,email:"owner@example.test",name:"Owner",passwordHash:"unused",emailVerifiedAt:new Date(),...personal});
      await t.db.execute(sql`CREATE FUNCTION fail_location_fixture() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'controlled location failure'; END $$`);
      await t.db.execute(sql`CREATE TRIGGER fail_location_fixture BEFORE INSERT ON outlets FOR EACH ROW EXECUTE FUNCTION fail_location_fixture()`);
      const before=await t.db.select().from(organisations);
      await expect(createOrganisation(t.db,id,{...business,name:"Cannot persist",locationName:"Rejected"})).rejects.toThrow();
      expect(await t.db.select().from(organisations)).toEqual(before);
      expect(await t.db.select().from(memberships)).toHaveLength(0);
      expect(await t.db.select().from(subscriptions)).toHaveLength(0);
    } finally {await t.close();}
  });
  it("lets an existing Owner complete business details without changing locations or gaining entitlement, and rejects another identity", async () => {
    const t = await createTestDatabase();
    try {
      const id=randomUUID();
      await t.db.insert(users).values({id,email:"owner@example.test",name:"Historical owner",passwordHash:"unused",emailVerifiedAt:new Date()});
      // Migration-compatible legacy profile has no guessed personal details.
      await expect(createOrganisation(t.db,id,{...business,name:"Missing personal data",locationName:"HQ"})).rejects.toThrow();
      await savePersonalDetails(t.db,id,personal);
      const result=await createOrganisation(t.db,id,{...business,name:"FairShift Demo",locationName:"Johannesburg"});
      await t.db.update(organisations).set({businessAddress:null,city:null,province:null,postalCode:null,country:null}).where(eq(organisations.id,result.organisationId));
      const beforeLocations=await t.db.select().from(outlets);
      const [owner]=await t.db.select().from(users).where(eq(users.id,id));
      const updated=await saveBusinessDetails(t.db,id,result.organisationId,{...business,name:"FairShift Demo"});
      expect(businessDetails.safeParse(updated).success).toBe(true);
      expect(await t.db.select().from(outlets)).toEqual(beforeLocations);
      expect(await organisationEntitled(t.db,result.organisationId)).toBe(false);
      await expect(saveBusinessDetails(t.db,randomUUID(),result.organisationId,{...business,name:"Intrusion"})).rejects.toThrow(/denied/);
      await expect(saveBusinessDetails(t.db,id,randomUUID(),{...business,name:"Intrusion"})).rejects.toThrow(/denied/);
      expect((await t.db.select().from(users).where(eq(users.id,id)))[0].email).toBe(owner.email);
    } finally {await t.close();}
  });
});

describe("subscription entitlement decision", () => {
  const verified={providerId:"I-VERIFIED",planId:"P-VERIFIED",verifiedAt:new Date()};
  it.each(["UNCONFIGURED","PENDING","APPROVAL_PENDING","APPROVED","SUSPENDED","CANCELLED","EXPIRED","FAILED","UNKNOWN"])("denies %s even if previously verified", status => {
    expect(isEntitled({...verified,status})).toBe(false);
  });
  it("requires ACTIVE with provider identity, plan, and authoritative verification", () => {
    expect(isEntitled({...verified,status:"ACTIVE"})).toBe(true);
    expect(isEntitled({...verified,status:"ACTIVE",verifiedAt:null})).toBe(false);
    expect(isEntitled({...verified,status:"ACTIVE",providerId:null})).toBe(false);
    expect(isEntitled({...verified,status:"ACTIVE",planId:null})).toBe(false);
    expect(isEntitled(null)).toBe(false);
  });
});
