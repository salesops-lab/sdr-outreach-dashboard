"use client";

import { useEffect, useMemo, useState } from "react";
import { Building2, MapPin, ChevronDown, ChevronRight, History, Loader2, Phone, Mail, User } from "lucide-react";
import AccountTimeline from "./AccountTimeline";
import DealFunnel from "./DealFunnel";
import {
  Snapshot, BookUnitDetail, RooftopDetail, DemoStatus, RepFunnel,
  STAGE_GROUPS, MARKET_SEGMENTS, MARKET_SEGMENT_LABELS, MarketSegment,
} from "../lib/sync/types";
import { Viewer } from "../lib/spine/types";
import { TeamFilterOption } from "../lib/team/helpers";
import { companyUrl } from "../config/hubspot";
import AppNav from "./AppNav";
import { Surface, Segmented, TempBadge, DealHealthBadge, cn } from "./ui";
import { STAGE_CHIP } from "./ui-tokens";

type View = "funnel" | "book";
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
const DEMO_LABEL: Record<DemoStatus, string> = { demo_pending: "Pending", demo_scheduled: "Scheduled", demo_done: "Done" };

const selectCls = "rounded-lg border border-line bg-surface px-2 py-1.5 text-xs text-ink-muted outline-none focus:ring-2 focus:ring-primary/30";

function ago(ms: number | null | undefined): string {
  if (!ms) return "never";
  const d = Math.floor((Date.now() - ms) / 86_400_000);
  if (d <= 0) return "today";
  if (d < 30) return `${d}d ago`;
  const mo = Math.floor(d / 30);
  return mo <= 1 ? "1mo ago" : `${mo}mo ago`;
}

/** The Deal Funnel page (`/accounts`): stage-wise pipeline truth (Funnel view, any scope)
 *  + the per-rep owned-book drill (Book view, GD → rooftop → contact). */
export default function AccountsView({ snapshot, viewer, teamFilters }: {
  snapshot: Snapshot; viewer: Viewer;
  teamFilters?: { pods: TeamFilterOption[]; teams: TeamFilterOption[] };
}) {
  const canToggleKind = viewer.isAdmin || viewer.role === "manager" || viewer.role === "leadership";

  const scopeIds = useMemo(() => {
    const all = Object.keys(snapshot.reps);
    const strict = viewer.defaultOwnerIds.length > 0 && viewer.defaultOwnerIds.length < all.length;
    return strict ? all.filter((id) => viewer.defaultOwnerIds.includes(id)) : all;
  }, [snapshot, viewer]);

  const [view, setView] = useState<View>("funnel");
  const [lens, setLens] = useState<Lens>("all");
  const [bucket, setBucket] = useState<Bucket>("all");
  const [team, setTeam] = useState<string>("all"); // "all" | "pod:*" | "team:*"
  const [rep, setRep] = useState<string>(""); // "" = All reps in scope
  const [units, setUnits] = useState<BookUnitDetail[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [expandedUnits, setExpandedUnits] = useState<Set<string>>(new Set());
  const [expandedRoofs, setExpandedRoofs] = useState<Set<string>>(new Set());
  const [timelineFor, setTimelineFor] = useState<{ id: string; name: string } | null>(null);
  // Column filters (Book view): health/temp at rooftop level, stage/segment at unit level.
  const [health, setHealth] = useState<string>("all"); // all | green | yellow | red | none (Temperature-governed)
  const [temp, setTemp] = useState<string>("all");
  const [stage, setStage] = useState<string>("all");
  const [segment, setSegment] = useState<string>("all");

  // Pod/SDR-team filter narrows the rep picker + the funnel scope.
  const teamIds = useMemo<Set<string> | null>(() => {
    if (team === "all" || !teamFilters) return null;
    const opt = [...teamFilters.pods, ...teamFilters.teams].find((o) => o.key === team);
    return opt ? new Set(opt.ownerIds) : null;
  }, [team, teamFilters]);

  const reps = useMemo(() => scopeIds
    .filter((id) => lens === "all" || (snapshot.owner_kinds?.[id] ?? "sdr") === lens)
    .filter((id) => !teamIds || teamIds.has(id))
    .map((id) => ({ id, name: snapshot.owner_names[id] ?? `ID:${id}`, funnel: snapshot.reps[id]?.funnel }))
    .sort((a, b) => a.name.localeCompare(b.name)), [scopeIds, lens, teamIds, snapshot]);

  // Seed view/lens/bucket/rep from deep-links (Overview funnel cells pass lens+bucket+rep →
  // those land on the Book drill); individual reps default the lens to their own type.
  useEffect(() => {
    const p = new URLSearchParams(window.location.search);
    const l = p.get("lens"); const b = p.get("bucket"); const r = p.get("rep"); const v = p.get("view");
    if (l === "sdr" || l === "ae" || l === "all") setLens(l);
    else if (viewer.kind) setLens(viewer.kind);
    if (b === "pending" || b === "scheduled" || b === "done") { setBucket(b); setView("book"); }
    if (v === "book" || v === "funnel") setView(v);
    if (r) setRep(r);
  }, [viewer.kind]);

  // Keep the selected rep valid; "" (All reps) is always valid.
  useEffect(() => {
    if (rep === "") return;
    if (!reps.some((r) => r.id === rep)) {
      const own = viewer.defaultOwnerIds.find((id) => reps.some((r) => r.id === id));
      setRep(own ?? "");
    }
  }, [reps, viewer.defaultOwnerIds, rep]);

  // Lazy-load the selected rep's book units (Book view data).
  useEffect(() => {
    if (!rep) { setUnits(null); return; }
    let cancelled = false;
    setLoading(true); setUnits(null); setExpandedUnits(new Set()); setExpandedRoofs(new Set());
    fetch(`/api/rep/${rep}/book`)
      .then((r) => r.json())
      .then((d) => { if (!cancelled) setUnits(d.units ?? []); })
      .catch(() => { if (!cancelled) setUnits([]); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [rep]);

  const funnel: RepFunnel | undefined = rep ? snapshot.reps[rep]?.funnel : undefined;

  const columnFiltersActive = health !== "all" || temp !== "all" || stage !== "all" || segment !== "all";
  const view_ = useMemo(() => {
    if (!units) return [] as BookUnitDetail[];
    const match = BUCKET_MATCH[bucket];
    const roofOk = (r: RooftopDetail) => {
      if (!match(statusOf(r))) return false;
      if (health !== "all" && (r.deal?.health ?? "none") !== health) return false;
      if (temp !== "all" && r.temp !== temp) return false;
      return true;
    };
    return units
      .filter((u) => (stage === "all" || u.stage === stage) && (segment === "all" || u.segment === segment))
      .map((u) => ({ ...u, rooftops: u.rooftops.filter(roofOk) }))
      .filter((u) => u.rooftops.length > 0);
  }, [units, bucket, health, temp, stage, segment]);

  // Filters narrow the set — auto-expand so matches are visible; browsing stays collapsed.
  const autoExpand = bucket !== "all" || columnFiltersActive;

  // Funnel-view scope: explicit rep > team > viewer scope (empty = whole tracked roster).
  const funnelOwners = useMemo(() => {
    if (rep) return [rep];
    if (teamIds) return [...teamIds];
    return scopeIds.length < Object.keys(snapshot.reps).length ? scopeIds : [];
  }, [rep, teamIds, scopeIds, snapshot]);

  const tab = (key: Bucket, label: string, n?: number): [string, string] => [key, n != null ? `${label} ${n}` : label];

  return (
    <>
      <AppNav active="accounts" viewer={viewer} />
      <main className="mx-auto max-w-[1500px] px-4 py-7 sm:px-6">
        <header className="mb-6">
          <h1 className="text-2xl font-extrabold tracking-tight text-ink sm:text-[26px]">Deals &amp; Accounts</h1>
          <p className="mt-0.5 text-sm text-ink-muted">Stage-wise pipeline truth · owned book by demo status · GD → rooftop → contact</p>
        </header>

        <div className="mb-5 flex flex-wrap items-center gap-2.5">
          <Segmented options={[["funnel", "Deal Funnel"], ["book", "Book"]]} value={view} onChange={(v) => setView(v as View)} />
          {canToggleKind && (
            <Segmented options={[["all", "All"], ["sdr", "SDRs"], ["ae", "AEs"]]} value={lens} onChange={(v) => setLens(v as Lens)} />
          )}
          {teamFilters && teamFilters.pods.length + teamFilters.teams.length > 0 && (
            <select value={team} onChange={(e) => setTeam(e.target.value)}
              className="rounded-xl border border-line bg-surface px-3 py-2 text-sm text-ink-muted shadow-card outline-none focus:ring-2 focus:ring-primary/30">
              <option value="all">All teams</option>
              {teamFilters.pods.length > 0 && (
                <optgroup label="AE Pods">
                  {teamFilters.pods.map((p) => <option key={p.key} value={p.key}>{p.name} ({p.ownerIds.length})</option>)}
                </optgroup>
              )}
              {teamFilters.teams.length > 0 && (
                <optgroup label="SDR Teams">
                  {teamFilters.teams.map((t) => <option key={t.key} value={t.key}>{t.name} ({t.ownerIds.length})</option>)}
                </optgroup>
              )}
            </select>
          )}
          <select value={rep} onChange={(e) => setRep(e.target.value)} className="rounded-xl border border-line bg-surface px-3 py-2 text-sm text-ink-muted shadow-card outline-none focus:ring-2 focus:ring-primary/30">
            <option value="">All reps ({reps.length})</option>
            {reps.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
          </select>

          {view === "book" && (
            <>
              <Segmented
                tone="good"
                options={[tab("all", "All"), tab("pending", "Pending", funnel?.demo_pending), tab("scheduled", "Scheduled", funnel?.demo_scheduled), tab("done", "Done", funnel?.demo_done)]}
                value={bucket}
                onChange={(v) => setBucket(v as Bucket)}
              />
              <select value={health} onChange={(e) => setHealth(e.target.value)} className={selectCls} aria-label="Filter by deal health">
                <option value="all">Health: all</option>
                <option value="green">🟢 Green</option>
                <option value="yellow">🟡 Yellow</option>
                <option value="red">🔴 Red</option>
                <option value="none">No deal (Temp governs)</option>
              </select>
              <select value={temp} onChange={(e) => setTemp(e.target.value)} className={selectCls} aria-label="Filter by temperature">
                <option value="all">Temp: all</option>
                <option value="hot">Hot</option>
                <option value="warm">Warm</option>
                <option value="cold">Cold</option>
              </select>
              <select value={stage} onChange={(e) => setStage(e.target.value)} className={selectCls} aria-label="Filter by GD stage">
                <option value="all">Stage: all</option>
                {STAGE_GROUPS.map((g) => <option key={g} value={g}>{g}</option>)}
              </select>
              <select value={segment} onChange={(e) => setSegment(e.target.value)} className={selectCls} aria-label="Filter by market segment">
                <option value="all">Segment: all</option>
                {MARKET_SEGMENTS.map((s) => <option key={s} value={s}>{MARKET_SEGMENT_LABELS[s as MarketSegment]}</option>)}
              </select>
              {columnFiltersActive && (
                <button onClick={() => { setHealth("all"); setTemp("all"); setStage("all"); setSegment("all"); }}
                  className="rounded-lg bg-surface-muted px-2 py-1.5 text-xs font-semibold text-ink-muted transition hover:text-ink">
                  Clear filters · {view_.length} shown
                </button>
              )}
            </>
          )}
        </div>

        {view === "funnel" && (
          <DealFunnel owners={funnelOwners} lens={lens} onTimeline={setTimelineFor} />
        )}

        {view === "book" && !rep && (
          <Surface className="p-6 text-sm text-ink-muted">
            The Book drill is per rep — pick a rep above to browse their owned book (GD → rooftop → contact).
            The <button onClick={() => setView("funnel")} className="font-semibold text-primary hover:underline">Deal Funnel</button> view covers any scope.
          </Surface>
        )}
        {view === "book" && rep && loading && (
          <Surface className="flex items-center gap-2 p-6 text-sm text-ink-muted"><Loader2 className="h-4 w-4 animate-spin" /> Loading accounts…</Surface>
        )}
        {view === "book" && rep && !loading && units && view_.length === 0 && (
          <Surface className="p-6 text-sm text-ink-muted">No accounts in this bucket.</Surface>
        )}
        {view === "book" && rep && !loading && view_.length > 0 && (
          <div className="space-y-2.5">
            {view_.map((u) => (
              <UnitCard
                key={u.key}
                u={u}
                open={autoExpand || expandedUnits.has(u.key)}
                onToggle={() => setExpandedUnits((s) => { const n = new Set(s); if (n.has(u.key)) n.delete(u.key); else n.add(u.key); return n; })}
                expandedRoofs={expandedRoofs}
                onToggleRoof={(id) => setExpandedRoofs((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; })}
                onTimeline={setTimelineFor}
              />
            ))}
          </div>
        )}
        {timelineFor && <AccountTimeline account={timelineFor} onClose={() => setTimelineFor(null)} />}
      </main>
    </>
  );
}

/* ---------------------------------------------------------------- Book view: unit card */

function UnitCard({ u, open, onToggle, expandedRoofs, onToggleRoof, onTimeline }: {
  u: BookUnitDetail; open: boolean; onToggle: () => void;
  expandedRoofs: Set<string>; onToggleRoof: (id: string) => void;
  onTimeline: (a: { id: string; name: string }) => void;
}) {
  // Demo-status distribution across the unit's (filtered) rooftops — the collapsed summary.
  const dist = useMemo(() => {
    const d = { pending: 0, scheduled: 0, done: 0, hot: 0 };
    for (const r of u.rooftops) {
      const s = statusOf(r);
      if (s === "demo_scheduled") d.scheduled++; else if (s === "demo_done") d.done++; else d.pending++;
      if (r.temp === "hot") d.hot++;
    }
    return d;
  }, [u.rooftops]);

  return (
    <Surface className="overflow-hidden">
      <button onClick={onToggle} aria-expanded={open}
        className="flex w-full items-center gap-2 px-4 py-2.5 text-left transition-colors hover:bg-surface-muted/60">
        <ChevronRight className={cn("h-4 w-4 shrink-0 text-ink-subtle transition-transform", open && "rotate-90")} />
        <span className={cn("flex h-6 w-6 shrink-0 items-center justify-center rounded-lg", u.isGroup ? "bg-primary-weak text-primary" : "bg-surface-muted text-ink-subtle")}>
          {u.isGroup ? <Building2 className="h-3.5 w-3.5" /> : <MapPin className="h-3.5 w-3.5" />}
        </span>
        <span className="truncate text-sm font-semibold text-ink">{u.name}</span>
        <span className={cn("shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold", STAGE_CHIP[u.stage])}>{u.stage}</span>
        {u.mixed_owner && <span className="shrink-0 rounded bg-warn-weak px-1.5 py-0.5 text-[9px] font-semibold text-ink-muted" title="Rooftops span more than one owner">shared</span>}
        <span className="ml-auto flex shrink-0 items-center gap-2 text-[11px] tabular-nums text-ink-subtle">
          {dist.scheduled > 0 && <span className="rounded bg-warm-weak px-1.5 py-0.5 font-semibold text-warm">{dist.scheduled} sched</span>}
          {dist.done > 0 && <span className="rounded bg-good-weak px-1.5 py-0.5 font-semibold text-good">{dist.done} done</span>}
          {dist.hot > 0 && <span className="rounded bg-hot-weak px-1.5 py-0.5 font-semibold text-hot">{dist.hot} hot</span>}
          <span>{u.rooftops.length} rooftop{u.rooftops.length > 1 ? "s" : ""}</span>
        </span>
      </button>

      {open && (
        <div className="border-t border-line">
          <div className="grid grid-cols-[2.4fr_0.9fr_0.9fr_1.1fr_1.6fr] gap-2 border-b border-line bg-surface-muted px-4 py-1.5 text-[10px] font-semibold uppercase tracking-wide text-ink-subtle">
            <span>Account</span><span>Demo status</span><span>Health / Temp</span><span>Deal stage</span><span className="text-right">Last activity</span>
          </div>
          <div className="divide-y divide-line/70">
            {u.rooftops.map((r) => (
              <RooftopRow key={r.id} r={r}
                open={expandedRoofs.has(r.id)}
                onToggle={() => onToggleRoof(r.id)}
                onTimeline={() => onTimeline({ id: r.id, name: r.name })} />
            ))}
          </div>
        </div>
      )}
    </Surface>
  );
}

/* ---------------------------------------------------------------- Book view: rooftop row */

function RooftopRow({ r, open, onToggle, onTimeline }: {
  r: RooftopDetail; open: boolean; onToggle: () => void; onTimeline: () => void;
}) {
  const status = statusOf(r);
  const la = r.last_activity;
  const hasContacts = r.contacts.length > 0;
  return (
    <div>
      <div className="grid grid-cols-[2.4fr_0.9fr_0.9fr_1.1fr_1.6fr] items-center gap-2 px-4 py-2 text-sm">
        <span className="flex min-w-0 items-center gap-1.5">
          <button onClick={onToggle} disabled={!hasContacts}
            className={cn("flex min-w-0 items-center gap-1 text-left font-medium text-ink", hasContacts && "hover:text-primary")}>
            {hasContacts
              ? (open ? <ChevronDown className="h-3.5 w-3.5 shrink-0" /> : <ChevronRight className="h-3.5 w-3.5 shrink-0" />)
              : <span className="inline-block w-3.5 shrink-0" />}
            <span className="truncate">{r.name}</span>
          </button>
          <a href={companyUrl(r.id)} target="_blank" rel="noreferrer" className="shrink-0 text-[11px] text-primary hover:underline">HS ↗</a>
          <button onClick={onTimeline} title="Full activity timeline + deal journey"
            className="inline-flex shrink-0 items-center gap-0.5 text-[11px] text-primary hover:underline">
            <History className="h-3 w-3" />
          </button>
        </span>
        <span>
          <span className={cn("rounded-full px-2 py-0.5 text-[10px] font-semibold", DEMO_CHIP[status])}>
            {DEMO_LABEL[status]}{r.deal?.at_risk ? " · risk" : ""}
          </span>
        </span>
        <span>{r.deal?.health ? <DealHealthBadge health={r.deal.health} title={r.deal.health_reason ?? undefined} /> : <TempBadge temp={r.temp} title={r.temp_reason} />}</span>
        <span className="truncate text-[11px] text-ink-muted">{r.deal?.stage ?? "—"}</span>
        <span className="truncate text-right text-[11px] text-ink-subtle">
          {la
            ? <><span className="font-medium text-ink-muted">{ago(la.ms)}</span>{la.type ? ` · ${la.type === "call" ? "Call" : "Email"}` : ""}{la.outcome ? ` · ${la.outcome}` : ""}{la.contact_name ? ` · ${la.contact_name}` : ""}</>
            : (r.tapped ? "" : "Untapped")}
        </span>
      </div>
      {open && hasContacts && (
        <div className="bg-surface-muted/40 px-4 pb-3 pl-10">
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
