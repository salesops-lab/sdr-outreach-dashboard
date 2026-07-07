import { getSnapshot, stripBookUnits } from "../lib/snapshot";
import { getCoachingByRep } from "../lib/callquality/fetch";
import Dashboard from "../components/Dashboard";

// Always read the latest snapshot at request time (Blob or committed file).
export const dynamic = "force-dynamic";
export const revalidate = 0;

export default async function Page() {
  const [snapshot, coaching] = await Promise.all([getSnapshot(), getCoachingByRep()]);
  return <Dashboard snapshot={stripBookUnits(snapshot)} coaching={coaching} />;
}
