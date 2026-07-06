import { getSnapshot, stripBookUnits } from "../lib/snapshot";
import Dashboard from "../components/Dashboard";

// Always read the latest snapshot at request time (Blob or committed file).
export const dynamic = "force-dynamic";
export const revalidate = 0;

export default async function Page() {
  const snapshot = await getSnapshot();
  // Book units are heavy (per-rooftop drill-down) — lazy-loaded per rep via API instead.
  return <Dashboard snapshot={stripBookUnits(snapshot)} />;
}
