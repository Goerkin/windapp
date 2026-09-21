import { loadDashboard } from "@/lib/data";
import Dashboard from "@/components/Dashboard";
import type { SpotPayload } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default async function Page() {
  let spots: SpotPayload[] = [];
  let error: string | null = null;
  try {
    spots = await loadDashboard();
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }
  return <Dashboard initialSpots={spots} initialError={error} />;
}
