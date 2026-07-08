import { redirect } from "next/navigation";
import { supabaseServer } from "../../lib/supabase/server";
import { supabaseAdmin } from "../../lib/supabase/admin";
import { resolveViewer } from "../../lib/access/resolve";
import { REPS, REP_OWNER_IDS } from "../../config/reps";
import { addRole, removeRole } from "./actions";

export const dynamic = "force-dynamic";

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
  const roles = await rows(sb?.from("sdr_roles").select("email,role,team_id").order("role"));
  const teams = await rows(sb?.from("sdr_teams").select("team_id,name"));
  const members = await rows(sb?.from("sdr_team_members").select("team_id,owner_id"));
  const syncState = await rows(sb?.from("sdr_sync_state").select("*").order("key"));

  const teamName = new Map((teams as { team_id: string; name: string }[]).map((t) => [t.team_id, t.name]));
  const assigned = new Set((members as { owner_id: string }[]).map((m) => m.owner_id));
  const unassigned = REP_OWNER_IDS.filter((id) => !assigned.has(id));

  return (
    <main className="mx-auto max-w-5xl space-y-8 px-4 py-8 sm:px-6">
      <header className="flex items-center justify-between">
        <h1 className="text-2xl font-black text-slate-900">Admin</h1>
        <a href="/" className="text-sm text-blue-600 hover:underline">← Dashboard</a>
      </header>

      {unassigned.length > 0 && (
        <div className="rounded-2xl border border-amber-300 bg-amber-50 p-4 text-sm text-amber-800">
          ⚠️ {unassigned.length} tracked reps are in <b>no HubSpot team</b> (invisible to every manager
          scope): {unassigned.map((id) => REPS[id]).join(", ")}. Assign them to teams in HubSpot.
        </div>
      )}

      <section className="rounded-2xl border border-slate-200 bg-white p-5">
        <h2 className="mb-3 text-sm font-bold uppercase tracking-wide text-slate-500">Roles</h2>
        <table className="w-full text-sm">
          <thead><tr className="border-b border-slate-200 text-left text-xs uppercase text-slate-400">
            <th className="py-1">Email</th><th>Role</th><th>Team</th><th /></tr></thead>
          <tbody>
            {(roles as { email: string; role: string; team_id: string | null }[]).map((r) => (
              <tr key={r.email} className="border-b border-slate-100">
                <td className="py-1.5">{r.email}</td>
                <td className="font-semibold">{r.role}</td>
                <td>{r.team_id ? teamName.get(r.team_id) ?? r.team_id : "—"}</td>
                <td className="text-right">
                  <form action={removeRole}><input type="hidden" name="email" value={r.email} />
                    <button className="text-xs text-rose-600 hover:underline">remove</button></form>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <form action={addRole} className="mt-4 flex flex-wrap items-center gap-2 text-sm">
          <input name="email" required placeholder="name@spyne.ai" className="rounded-lg border border-slate-200 px-2 py-1.5" />
          <select name="role" className="rounded-lg border border-slate-200 px-2 py-1.5">
            <option value="viewer">viewer</option><option value="manager">manager</option>
            <option value="leadership">leadership</option><option value="admin">admin</option>
          </select>
          <select name="team_id" className="rounded-lg border border-slate-200 px-2 py-1.5">
            <option value="">no team</option>
            {(teams as { team_id: string; name: string }[]).map((t) => (
              <option key={t.team_id} value={t.team_id}>{t.name}</option>))}
          </select>
          <button className="rounded-lg bg-slate-900 px-3 py-1.5 font-semibold text-white">Add / update</button>
        </form>
      </section>

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
