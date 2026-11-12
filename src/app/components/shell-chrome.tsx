import type { Scope } from "@/server/auth/access";
import { DemoBar, SandboxBar } from "@/app/demo/demo-bar";
import { SandboxStrip } from "@/app/components/fs-shell";
import { LocationSwitcher } from "@/app/components/location-switcher";
import { isDemoOrganisation } from "@/server/demo/organisation";
import { getDatabase } from "@/server/db/client";
import { activeLocations } from "@/server/product/locations";

// The strips above an Owner or Manager page (design, 10 Nov 2026). The public demo keeps its demo bar
// and the Sandbox demo business keeps its bar with Reset demo; every other business gets the sandbox
// strip, because every payout in this deployment goes to PayPal Sandbox.
export function shellStrips(scope: Scope, detail: string) {
  if (scope.demo) return { banner: <DemoBar persona={scope.demo.persona} /> };
  if (isDemoOrganisation(scope.organisationId)) return { notice: <SandboxBar /> };
  return { strip: <SandboxStrip detail={detail} /> };
}

// The Owner's location switch for the top bar. If the list can't be read the selected location still
// shows as the page context and the work goes on.
export async function ownerLocationControl(scope: Scope) {
  let locations: { id: string; name: string }[] = [];
  try { locations = await activeLocations(getDatabase(), scope.organisationId); } catch { locations = []; }
  return locations.length ? <LocationSwitcher locations={locations} current={scope.locationId} /> : undefined;
}
