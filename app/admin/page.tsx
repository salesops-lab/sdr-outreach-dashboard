import { redirect } from "next/navigation";
import { supabaseServer } from "../../lib/supabase/server";
import { supabaseAdmin } from "../../lib/supabase/admin";
import { resolveViewer } from "../../lib/access/resolve";
import { loadTeamStructure } from "../../lib/team/load";
import { addUser, setUserActive, savePod, removePod, saveManager, removeManager, addRole, removeRole } from "./actions";

export const dynamic = "force-dynamic";

const inputCls = "rounded-lg border border-slate-200 px-2 py-1.5 text-sm";
const btnCls = "rounded-lg bg-slate-900 px-3 py-1.5 text-sm font-semibold text-white hover:bg-slate-700";

export default async function AdminPage() {
  const { data: { user } } = await supabaseServer().auth.getUser();
  const viewer = await resolveViewer(user?.email ?? "");
  if (!viewer.isAdmin) redirect("/");

  const sb = supabaseAdmin();
  async function rows<T>(q: PromiseLike<{ data: T[] | null }> | undefined): Promise<T[]> {
    if (!q) return [];
    const { data } = await q;
    return data ?? [];
  }
  const ts = await loadTeamStructure({ fresh: true });
  const roles = await rows(sb?.from("sdr_roles").select("email,role,team_id").order("role"));
  const syncState = await rows(sb?.from("sdr_sync_state").select("*").order("key"));

  const podName = new Map(ts.pods.map((p) => [p.key, p.name]));
  const mgrName = new Map(Object.values(ts.managers).map((m) => [m.key, m.name]));
  const members = [...ts.members].sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind.localeCompare(b.kind)));
  const active = members.filter((m) => m.active);
  const inactive = members.filter((m) => !m.active);

  const seeded = ts.members.some((m) => m.email); // DB seed sets emails; config fallback has none

  return (
    <main className="mx-auto max-w-6xl space-y-8 px-4 py-8 sm:px-6">
      <header className="flex items-center justify-between">
        <h1 className="text-2xl font-black text-slate-900">Admin · Control Center</h1>
        <a href="/" className="text-sm text-blue-600 hover:underline">← Dashboard</a>
      </header>

      {!seeded && (
        <div className="rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
          Showing the config fallback — the DB roster isn’t seeded yet. Apply <code>supabase/sdr_schema.sql</code>, then run
          <code> npm run team:seed</code>. Until then, edits here won’t persist.
        </div>
      )}

      {/* ── Add / update user ─────────────────────────────────────────── */}
      <section className="rounded-2xl border border-slate-200 bg-white p-5">
        <h2 className="mb-1 text-sm font-bold uppercase tracking-wide text-slate-500">Add / update user</h2>
        <p className="mb-4 text-xs text-slate-500">
          The email is matched to a HubSpot user (so the owner id is always correct). Pick an SDR manager for SDRs, or leave it
          “None” for AEs. New users get a targeted history pull automatically.
        </p>
        <form action={addUser} className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          <input name="first_name" placeholder="First name" className={inputCls} />
          <input name="last_name" placeholder="Last name" className={inputCls} />
          <input name="email" required placeholder="name@spyne.ai" className={inputCls} />
          <select name="role" className={inputCls} defaultValue="user">
            <option value="user">User</option>
            <option value="manager">Manager</option>
            <option value="admin">Admin</option>
          </select>
          <select name="manager_key" className={inputCls} defaultValue="">
            <option value="">SDR team — None (AE)</option>
            {Object.values(ts.managers).map((m) => (
              <option key={m.key} value={m.key}>{m.name}{m.parent ? ` (TL → ${mgrName.get(m.parent) ?? m.parent})` : ""}</option>
            ))}
          </select>
          <select name="ae_pod" className={inputCls} defaultValue="">
            <option value="">AE pod — None</option>
            {ts.pods.map((p) => <option key={p.key} value={p.key}>{p.name}{p.leadEmail ? ` (${p.leadEmail})` : ""}</option>)}
          </select>
          <div className="sm:col-span-2 lg:col-span-3"><button className={btnCls}>Add / update user</button></div>
        </form>
      </section>

      {/* ── Roster ────────────────────────────────────────────────────── */}
      <section className="rounded-2xl border border-slate-200 bg-white p-5">
        <h2 className="mb-3 text-sm font-bold uppercase tracking-wide text-slate-500">Tracked roster ({active.length} active{inactive.length ? `, ${inactive.length} inactive` : ""})</h2>
        <table className="w-full text-sm">
          <thead><tr className="border-b border-slate-200 text-left text-xs uppercase text-slate-400">
            <th className="py-1">Name</th><th>Email</th><th>Type</th><th>AE pod</th><th>Manager</th><th /></tr></thead>
          <tbody>
            {members.map((m) => (
              <tr key={m.ownerId} className={`border-b border-slate-100 ${m.active ? "" : "opacity-40"}`}>
                <td className="py-1.5 font-medium text-slate-800">{m.name}</td>
                <td className="text-slate-500">{m.email ?? "—"}</td>
                <td className="uppercase text-xs font-semibold text-slate-600">{m.kind}</td>
                <td className="text-slate-600">{m.aePod ? podName.get(m.aePod) ?? m.aePod : "—"}</td>
                <td className="text-slate-600">{m.managerKey ? mgrName.get(m.managerKey) ?? m.managerKey : "—"}</td>
                <td className="text-right">
                  <form action={setUserActive}>
                    <input type="hidden" name="owner_id" value={m.ownerId} />
                    <input type="hidden" name="active" value={m.active ? "false" : "true"} />
                    <button className={`text-xs hover:underline ${m.active ? "text-rose-600" : "text-emerald-600"}`}>{m.active ? "deactivate" : "reactivate"}</button>
                  </form>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <div className="grid gap-8 lg:grid-cols-2">
        {/* ── Manage AE pods ─────────────────────────────────────────── */}
        <section className="rounded-2xl border border-slate-200 bg-white p-5">
          <h2 className="mb-3 text-sm font-bold uppercase tracking-wide text-slate-500">AE pods</h2>
          <ul className="mb-4 space-y-1.5 text-sm">
            {ts.pods.map((p) => (
              <li key={p.key} className="flex items-center justify-between">
                <span><span className="font-semibold">{p.name}</span> <span className="text-xs text-slate-400">{p.leadEmail ?? "(no lead)"}</span></span>
                <form action={removePod}><input type="hidden" name="pod_key" value={p.key} /><button className="text-xs text-rose-600 hover:underline">remove</button></form>
              </li>
            ))}
          </ul>
          <form action={savePod} className="flex flex-wrap items-center gap-2">
            <input name="name" required placeholder="Pod name (e.g. Saarthak)" className={inputCls} />
            <input name="lead_email" placeholder="lead@spyne.ai (optional)" className={inputCls} />
            <button className={btnCls}>Save pod</button>
          </form>
        </section>

        {/* ── Manage managers / TLs ──────────────────────────────────── */}
        <section className="rounded-2xl border border-slate-200 bg-white p-5">
          <h2 className="mb-3 text-sm font-bold uppercase tracking-wide text-slate-500">Managers / TLs</h2>
          <ul className="mb-4 space-y-1.5 text-sm">
            {Object.values(ts.managers).map((m) => (
              <li key={m.key} className="flex items-center justify-between">
                <span><span className="font-semibold">{m.name}</span>{m.parent && <span className="text-xs text-slate-400"> → {mgrName.get(m.parent) ?? m.parent}</span>}</span>
                <form action={removeManager}><input type="hidden" name="manager_key" value={m.key} /><button className="text-xs text-rose-600 hover:underline">remove</button></form>
              </li>
            ))}
          </ul>
          <form action={saveManager} className="grid gap-2">
            <div className="flex flex-wrap gap-2">
              <input name="name" required placeholder="Manager name" className={inputCls} />
              <input name="email" placeholder="manager@spyne.ai (for team view)" className={inputCls} />
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <select name="parent_key" className={inputCls} defaultValue="">
                <option value="">Top-level (no parent)</option>
                {Object.values(ts.managers).map((m) => <option key={m.key} value={m.key}>reports to {m.name}</option>)}
              </select>
              <button className={btnCls}>Save manager</button>
            </div>
          </form>
        </section>
      </div>

      {/* ── Raw roles (advanced) ──────────────────────────────────────── */}
      <section className="rounded-2xl border border-slate-200 bg-white p-5">
        <h2 className="mb-1 text-sm font-bold uppercase tracking-wide text-slate-500">Roles (advanced)</h2>
        <p className="mb-3 text-xs text-slate-500">Raw <code>sdr_roles</code> overrides. Adding a user above already sets this — use here only for leadership / edge cases.</p>
        <table className="w-full text-sm">
          <thead><tr className="border-b border-slate-200 text-left text-xs uppercase text-slate-400">
            <th className="py-1">Email</th><th>Role</th><th>Team id</th><th /></tr></thead>
          <tbody>
            {(roles as { email: string; role: string; team_id: string | null }[]).map((r) => (
              <tr key={r.email} className="border-b border-slate-100">
                <td className="py-1.5">{r.email}</td>
                <td className="font-semibold">{r.role}</td>
                <td className="text-slate-500">{r.team_id ?? "—"}</td>
                <td className="text-right">
                  <form action={removeRole}><input type="hidden" name="email" value={r.email} />
                    <button className="text-xs text-rose-600 hover:underline">remove</button></form>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <form action={addRole} className="mt-4 flex flex-wrap items-center gap-2">
          <input name="email" required placeholder="name@spyne.ai" className={inputCls} />
          <select name="role" className={inputCls}>
            <option value="viewer">viewer</option><option value="manager">manager</option>
            <option value="leadership">leadership</option><option value="admin">admin</option>
          </select>
          <input name="team_id" placeholder="team id (manager only)" className={inputCls} />
          <button className={btnCls}>Add / update role</button>
        </form>
      </section>

      {/* ── Sync health ───────────────────────────────────────────────── */}
      <section className="rounded-2xl border border-slate-200 bg-white p-5">
        <h2 className="mb-3 text-sm font-bold uppercase tracking-wide text-slate-500">Sync health</h2>
        <table className="w-full text-sm">
          <thead><tr className="border-b border-slate-200 text-left text-xs uppercase text-slate-400">
            <th className="py-1">Key</th><th>Watermark</th><th>Last run</th><th>Duration</th><th>Counts</th><th>Notes</th></tr></thead>
          <tbody>
            {(syncState as { key: string; watermark_ms: number; last_run_at: string | null; last_duration_ms: number | null; last_counts: object | null; notes: string | null }[]).map((s) => (
              <tr key={s.key} className="border-b border-slate-100">
                <td className="py-1.5 font-semibold">{s.key}</td>
                <td className="tabular-nums">{s.watermark_ms ? new Date(Number(s.watermark_ms)).toLocaleString("en-US", { timeZone: "America/New_York" }) : "—"}</td>
                <td className="tabular-nums">{s.last_run_at ? new Date(s.last_run_at).toLocaleString("en-US", { timeZone: "America/New_York" }) : "—"}</td>
                <td className="tabular-nums">{s.last_duration_ms ? `${Math.round(s.last_duration_ms / 1000)}s` : "—"}</td>
                <td className="text-xs">{s.last_counts ? JSON.stringify(s.last_counts) : "—"}</td>
                <td className="text-xs text-slate-500">{s.notes ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </main>
  );
}
