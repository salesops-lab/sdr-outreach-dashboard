"use client";

import { useEffect, useMemo, useState } from "react";
import { Building2, MapPin, ChevronDown, ChevronRight, Loader2, Phone, Mail, User } from "lucide-react";
import { Snapshot, BookUnitDetail, RooftopDetail, DemoStatus, RepFunnel } from "../lib/sync/types";
import { Viewer } from "../lib/spine/types";
import { companyUrl } from "../config/hubspot";
import AppNav from "./AppNav";
import { Surface, Segmented, TempBadge, DealHealthBadge, cn } from "./ui";
import { STAGE_CHIP } from "./ui-tokens";

type Bucket = "all" | "pending" | "scheduled" | "done";
type Lens = "all" | "sdr" | "ae";

const statusOf = (r: RooftopDetail): DemoStatus => r.deal?.demo_status ?? "demo_pending";
const BUCKET_MATCH: Record<Bucket, (s: DemoStatus) => boolean> = {
  all: () => true,
  pending: (s) => s === "demo_pending",
  scheduled: (s) => s === "demo_scheduled",
  done: (s) => s === "demo_done",
};
const DEMO_CHIP: Record<DemoStatus, string> = {
  demo_pending: "bg-primary-weak text-primary",
  demo_scheduled: "bg-warm-weak text-warm",
  demo_done: "bg-good-weak text-good",
};
const DEMO_LABEL: Record<DemoStatus, string> = { demo_pending: "Demo pending", demo_scheduled: "Scheduled", demo_done: "Demo done" };

function ago(ms: number | null | undefined): string {
  if (!ms) return "never";
  const d = Math.floor((Date.now() - ms) / 86_400_000);
  if (d <= 0) return "today";
  if (d < 30) return `${d}d ago`;
  const mo = Math.floor(d / 30);
  return mo <= 1 ? "1mo ago" : `${mo}mo ago`;
}

/** Account-tracking view: the owned book segmented by demo status, GD → rooftop → contact. */
export default function AccountsView({ snapshot, viewer }: { snapshot: Snapshot; viewer: Viewer }) {
  const canToggleKind = viewer.isAdmin || viewer.role === "manager" || viewer.role === "leadership";

  const scopeIds = useMemo(() => {
    const all = Object.keys(snapshot.reps);
    const strict = viewer.defaultOwnerIds.length > 0 && viewer.defaultOwnerIds.length < all.length;
    return strict ? all.filter((id) => viewer.defaultOwnerIds.includes(id)) : all;
  }, [snapshot, viewer]);

  const [lens, setLens] = useState<Lens>("all");
  const [bucket, setBucket] = useState<Bucket>("all");
  const [rep, setRep] = useState<string>("");
  const [units, setUnits] = useState<BookUnitDetail[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const reps = useMemo(() => scopeIds
    .filter((id) => lens === "all" || (snapshot.owner_kinds?.[id] ?? "sdr") === lens)
    .map((id) => ({ id, name: snapshot.owner_names[id] ?? `ID:${id}`, funnel: snapshot.reps[id]?.funnel }))
    .sort((a, b) => a.name.localeCompare(b.name)), [scopeIds, lens, snapshot]);

  // Seed lens/bucket from the funnel deep-links; individual reps default the lens to their own type.
  useEffect(() => {
    const p = new URLSearchParams(window.location.search);
    const l = p.get("lens"); const b = p.get("bucket");
    if (l === "sdr" || l === "ae" || l === "all") setLens(l);
    else if (viewer.kind) setLens(viewer.kind);
    if (b === "pending" || b === "scheduled" || b === "done") setBucket(b);
  }, [viewer.kind]);

  // Keep a valid selected rep (default: the viewer's own book, else the first in the filtered list).
  useEffect(() => {
    if (reps.length === 0) { setRep(""); return; }
    if (!reps.some((r) => r.id === rep)) {
      const own = viewer.defaultOwnerIds.find((id) => reps.some((r) => r.id === id));
      setRep(own ?? reps[0].id);
    }
  }, [reps, viewer.defaultOwnerIds, rep]);

  // Lazy-load the rep's book units — deal + last-activity live on each rooftop.
  useEffect(() => {
    if (!rep) { setUnits(null); return; }
    let cancelled = false;
    setLoading(true); setUnits(null); setExpanded(new Set());
    fetch(`/api/rep/${rep}/book`)
      .then((r) => r.json())
      .then((d) => { if (!cancelled) setUnits(d.units ?? []); })
      .catch(() => { if (!cancelled) setUnits([]); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [rep]);

  const funnel: RepFunnel | undefined = snapshot.reps[rep]?.funnel;

  const view = useMemo(() => {
    if (!units) return [] as BookUnitDetail[];
    const match = BUCKET_MATCH[bucket];
    return units
      .map((u) => ({ ...u, rooftops: u.rooftops.filter((r) => match(statusOf(r))) }))
      .filter((u) => u.rooftops.length > 0);
  }, [units, bucket]);

  const tab = (key: Bucket, label: string, n?: number): [string, string] => [key, n != null ? `${label} ${n}` : label];

  return (
    <>
      <AppNav active="accounts" viewer={viewer} />
      <main className="mx-auto max-w-[1500px] px-4 py-7 sm:px-6">
        <header className="mb-6">
          <h1 className="text-2xl font-extrabold tracking-tight text-ink sm:text-[26px]">Accounts</h1>
          <p className="mt-0.5 text-sm text-ink-muted">Owned book by demo status · GD → rooftop → contact · deal health &amp; last activity</p>
        </header>

        <div className="mb-5 flex flex-wrap items-center gap-2.5">
          {canToggleKind && (
            <Segmented options={[["all", "All"], ["sdr", "SDRs"], ["ae", "AEs"]]} value={lens} onChange={(v) => setLens(v as Lens)} />
          )}
          <select value={rep} onChange={(e) => setRep(e.target.value)} className="rounded-xl border border-line bg-surface px-3 py-2 text-sm text-ink-muted shadow-card outline-none focus:ring-2 focus:ring-primary/30">
            {reps.length === 0 && <option value="">No reps in scope</option>}
            {reps.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
          </select>
          <Segmented
            tone="good"
            options={[tab("all", "All"), tab("pending", "Pending", funnel?.demo_pending), tab("scheduled", "Scheduled", funnel?.demo_scheduled), tab("done", "Done", funnel?.demo_done)]}
            value={bucket}
            onChange={(v) => setBucket(v as Bucket)}
          />
        </div>

        {loading && (
          <Surface className="flex items-center gap-2 p-6 text-sm text-ink-muted"><Loader2 className="h-4 w-4 animate-spin" /> Loading accounts…</Surface>
        )}
        {!loading && units && view.length === 0 && (
          <Surface className="p-6 text-sm text-ink-muted">No accounts in this bucket.</Surface>
        )}
        {!loading && view.length > 0 && (
          <div className="space-y-3">
            {view.map((u) => (
              <Surface key={u.key} className="overflow-hidden">
                <div className="flex items-center gap-2 border-b border-line bg-surface-muted/60 px-4 py-2.5">
                  <span className={cn("flex h-6 w-6 shrink-0 items-center justify-center rounded-lg", u.isGroup ? "bg-primary-weak text-primary" : "bg-surface-muted text-ink-subtle")}>
                    {u.isGroup ? <Building2 className="h-3.5 w-3.5" /> : <MapPin className="h-3.5 w-3.5" />}
                  </span>
                  <span className="truncate text-sm font-semibold text-ink">{u.name}</span>
                  <span className={cn("shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold", STAGE_CHIP[u.stage])}>{u.stage}</span>
                  <span className="ml-auto shrink-0 text-[11px] tabular-nums text-ink-subtle">{u.rooftops.length} {u.isGroup ? "rooftop" : "account"}{u.rooftops.length > 1 ? "s" : ""}</span>
                </div>
                <div className="divide-y divide-line/70">
                  {u.rooftops.map((r) => (
                    <RooftopRow
                      key={r.id}
                      r={r}
                      open={expanded.has(r.id)}
                      onToggle={() => setExpanded((s) => { const n = new Set(s); if (n.has(r.id)) n.delete(r.id); else n.add(r.id); return n; })}
                    />
                  ))}
                </div>
              </Surface>
            ))}
          </div>
        )}
      </main>
    </>
  );
}

function RooftopRow({ r, open, onToggle }: { r: RooftopDetail; open: boolean; onToggle: () => void }) {
  const status = statusOf(r);
  const la = r.last_activity;
  const hasContacts = r.contacts.length > 0;
  return (
    <div>
      <div className="flex flex-wrap items-center gap-2 px-4 py-2.5">
        <button onClick={onToggle} className="flex items-center gap-1.5 text-left text-sm font-medium text-ink hover:text-primary" disabled={!hasContacts}>
          {hasContacts ? (open ? <ChevronDown className="h-3.5 w-3.5 shrink-0" /> : <ChevronRight className="h-3.5 w-3.5 shrink-0" />) : <span className="inline-block w-3.5" />}
          <span>{r.name}</span>
        </button>
        <a href={companyUrl(r.id)} target="_blank" rel="noreferrer" className="text-[11px] text-primary hover:underline">HubSpot ↗</a>
        <span className={cn("rounded-full px-2 py-0.5 text-[10px] font-semibold", DEMO_CHIP[status])}>{DEMO_LABEL[status]}{r.deal?.at_risk ? " · at risk" : ""}</span>
        {r.deal?.health ? <DealHealthBadge health={r.deal.health} title={r.deal.health_reason ?? undefined} /> : <TempBadge temp={r.temp} title={r.temp_reason} />}
        {r.deal?.stage && <span className="text-[11px] text-ink-subtle">{r.deal.stage}</span>}
        <span className="ml-auto text-[11px] text-ink-subtle">
          {la
            ? <>Last: <span className="font-medium text-ink-muted">{ago(la.ms)}</span>{la.type ? ` · ${la.type === "call" ? "Call" : "Email"}` : ""}{la.outcome ? ` · ${la.outcome}` : ""}{la.contact_name ? ` · ${la.contact_name}` : ""}</>
            : (r.tapped ? "" : "Untapped")}
        </span>
      </div>
      {open && hasContacts && (
        <div className="bg-surface-muted/40 px-4 pb-3 pl-9">
          <div className="space-y-1 pt-1">
            {r.contacts.map((c) => (
              <div key={c.id} className="flex items-center gap-2 text-[12px] text-ink-muted">
                <User className="h-3 w-3 shrink-0 text-ink-subtle" />
                <span className="font-medium text-ink">{c.name}</span>
                {c.title && <span className="truncate text-ink-subtle">· {c.title}</span>}
                <span className="ml-auto inline-flex items-center gap-2 tabular-nums text-ink-subtle">
                  <span className="inline-flex items-center gap-1"><Phone className="h-3 w-3" />{c.calls}</span>
                  <span className="inline-flex items-center gap-1"><Mail className="h-3 w-3" />{c.emails}</span>
                  <TempBadge temp={c.temp} showLabel={false} />
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
