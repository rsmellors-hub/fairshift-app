import { revalidatePath as nextRevalidatePath } from "next/cache";
import { planningChanged } from "@/server/intelligence/planning-cache";

// Every server action that changes data revalidates pages; it also tells the planning cache that what it
// holds may be out of date (src/server/intelligence/planning-cache.ts), so the next page shows the change.
export function revalidatePath(...args: Parameters<typeof nextRevalidatePath>) {
  planningChanged();
  return nextRevalidatePath(...args);
}
