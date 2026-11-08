import { sandboxOrganisationId } from "@/server/config/deployment";
import { demoConfig } from "@/server/demo/config";

// The isolated demonstration organisation: the configured Sandbox organisation or public demo. Its
// staff, venues and sales history are fictional or synthetic, and every screen showing them says so.
export const isDemoOrganisation = (organisationId: string) => sandboxOrganisationId() === organisationId || demoConfig()?.organisationId === organisationId;
