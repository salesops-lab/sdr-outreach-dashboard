import { getSnapshot } from "../lib/snapshot";
import Dashboard from "../components/Dashboard";

// Always read the latest snapshot at request time (Blob or committed file).
export const dynamic = "force-dynamic";
export const revalidate = 0;

export default async function Page() {
  const snapshot = await getSnapshot();
  return <Dashboard snapshot={snapshot} />;
}
