"use client";

/**
 * Nested account tables (Phase 3). One set of table primitives, three levels:
 *   Units (GD / Single)  →  Rooftops  →  Contacts
 * Reused by the Book Explorer (owned book, GD-structured) and the "Accounts tapped
 * this period" view (period-scoped rooftops). Each level is a compact grid "table"
 * with its own header row; expansion state is local to each level.
 */
import { useState } from "react";
import { ChevronRight, ExternalLink, Phone, Mail, Building2 } from "lucide-react";
import { BookUnitDetail, RooftopContact, Temperature, MARKET_SEGMENT_LABELS, MarketSegment } from "../lib/sync/types";
import { companyUrl, contactUrl } from "../config/hubspot";
import { Chip, TempBadge, Bar, cn } from "./ui";
import { STAGE_CHIP } from "./ui-tokens";

// Null-safe: a snapshot written by older sync code may omit per-contact fields.
const fmt = (n: number | null | undefined) => (n ?? 0).toLocaleString("en-IN");

function etDate(ms: number | null): string {
  if (!ms) return "—";
  try {
    return new Date(ms).toLocaleDateString("en-US", { timeZone: "America/New_York", month: "short", day: "2-digit" });
  } catch { return "—"; }
}

/** A rooftop-shaped node — RooftopDetail satisfies it; period accounts map onto it. */
export interface RooftopNode {
  id: string;
  name: string;
  calls: number;
  emails: number;
  connected: number;
  temp: Temperature;
  temp_reason: string;
  last_ms: number | null;
  contacts: RooftopContact[];
  tapped?: boolean;
  stage?: string;
  disqualified?: boolean;
}

/* ---------------------------------------------------------------- Level 3: contacts */

function ContactsTable({ contacts }: { contacts: RooftopContact[] }) {
  if (contacts.length === 0) {
    return <p className="px-3 py-2 text-xs italic text-ink-subtle">No engaged contacts recorded.</p>;
  }
  return (
    <div className="scroll-x">
      <div className="min-w-[520px]">
        <div className="grid grid-cols-[1.6fr_1.4fr_0.8fr_0.9fr_0.7fr] gap-2 border-b border-line px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wide text-ink-subtle">
          <span>Contact</span><span>Title</span><span>Last activity</span><span>Activity</span><span className="text-right">Temp</span>
        </div>
        {contacts.map((c) => (
          <div key={c.id} className="grid grid-cols-[1.6fr_1.4fr_0.8fr_0.9fr_0.7fr] items-center gap-2 border-b border-line/60 px-3 py-1.5 text-xs last:border-0">
            <span className="flex min-w-0 items-center gap-1.5">
              <a href={contactUrl(c.id)} target="_blank" rel="noopener noreferrer" className="truncate font-medium text-ink hover:text-primary">{c.name}</a>
              {c.dm && <Chip tone="primary" className="px-1 py-0 text-[9px]">DM</Chip>}
            </span>
            <span className="truncate text-ink-muted">{c.title || "—"}</span>
            <span className="tabular-nums text-ink-muted">{etDate(c.last_ms)}</span>
            <span className="inline-flex items-center gap-1 tabular-nums text-ink-muted">
              <Phone className="h-3 w-3 text-ink-subtle" />{fmt(c.calls)}
              <Mail className="ml-1 h-3 w-3 text-ink-subtle" />{fmt(c.emails)}
            </span>
            <span className="flex justify-end"><TempBadge temp={c.temp ?? "cold"} showLabel={false} title={`${c.temp ?? "cold"}`} /></span>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- Level 2: rooftops */

function RooftopRow({ r }: { r: RooftopNode }) {
  const [open, setOpen] = useState(false);
  const untapped = r.tapped === false;
  return (
    <div className="border-b border-line/60 last:border-0">
      <button
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className={cn("grid w-full grid-cols-[1.8fr_0.8fr_1fr] items-center gap-2 px-3 py-2 text-left text-xs transition-colors hover:bg-surface-muted", untapped && "opacity-70")}
      >
        <span className="flex min-w-0 items-center gap-1.5">
          <ChevronRight className={cn("h-3.5 w-3.5 shrink-0 text-ink-subtle transition-transform", open && "rotate-90")} />
          <span className="truncate font-medium text-ink">{r.name}</span>
          <a href={companyUrl(r.id)} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()} className="shrink-0 text-ink-subtle hover:text-primary"><ExternalLink className="h-3 w-3" /></a>
        </span>
        <span className="tabular-nums text-ink-muted">{untapped ? <span className="italic text-ink-subtle">untouched</span> : `${fmt(r.contacts.length)} contact${r.contacts.length === 1 ? "" : "s"}`}</span>
        <span className="flex items-center justify-between gap-2">
          <span className="hidden tabular-nums text-[10px] text-ink-subtle sm:inline">{fmt(r.calls)}c · {fmt(r.emails)}e · {etDate(r.last_ms)}</span>
          <TempBadge temp={r.temp} title={r.temp_reason} />
        </span>
      </button>
      {open && (
        <div className="bg-surface-muted/40 pb-1">
          <div className="px-3 py-1 text-[10px] italic text-ink-subtle">{r.temp_reason}</div>
          <ContactsTable contacts={r.contacts} />
        </div>
      )}
    </div>
  );
}

/** Standalone rooftop table (used by "Accounts tapped this period"). */
export function RooftopsTable({ rows }: { rows: RooftopNode[] }) {
  if (rows.length === 0) return <p className="px-1 py-2 text-sm text-ink-subtle">No accounts to show.</p>;
  return (
    <div className="overflow-hidden rounded-xl border border-line">
      <div className="grid grid-cols-[1.8fr_0.8fr_1fr] gap-2 border-b border-line bg-surface-muted px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wide text-ink-subtle">
        <span>Rooftop</span><span>Contacts</span><span className="text-right">Temperature</span>
      </div>
      {rows.map((r) => <RooftopRow key={r.id} r={r} />)}
    </div>
  );
}

/* ---------------------------------------------------------------- Level 1: GD / single units */

function UnitRow({ u }: { u: BookUnitDetail }) {
  const [open, setOpen] = useState(false);
  const tappedRoofs = u.rooftops.filter((r) => r.tapped).length;
  const cov = u.rooftops.length ? tappedRoofs / u.rooftops.length : 0;
  return (
    <div className={cn("border-b border-line/60 last:border-0", !u.tapped && "bg-warn-weak/40")}>
      <button
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="grid w-full grid-cols-[2fr_0.7fr_1fr_0.9fr_1fr] items-center gap-2 px-3 py-2.5 text-left text-sm transition-colors hover:bg-surface-muted"
      >
        <span className="flex min-w-0 items-center gap-1.5">
          <ChevronRight className={cn("h-4 w-4 shrink-0 text-ink-subtle transition-transform", open && "rotate-90")} />
          {u.isGroup
            ? <Building2 className="h-3.5 w-3.5 shrink-0 text-primary" />
            : <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-ink-subtle" />}
          <span className="truncate font-semibold text-ink">{u.name}</span>
          {u.isGroup && <Chip tone="primary" className="px-1 py-0 text-[9px]">GD</Chip>}
        </span>
        <span className="tabular-nums text-ink-muted">{fmt(u.rooftops.length)}</span>
        <span><span className={cn("rounded px-1.5 py-0.5 text-[10px] font-medium", STAGE_CHIP[u.stage])}>{u.stage}</span></span>
        <span className="hidden truncate text-[11px] text-ink-muted sm:inline">{MARKET_SEGMENT_LABELS[u.segment as MarketSegment] ?? u.segment}</span>
        <span className="flex items-center justify-end gap-2">
          <Bar value={cov} tone={cov >= 0.5 ? "good" : "warm"} width="w-10" />
          <span className="tabular-nums text-[11px] text-ink-muted">{tappedRoofs}/{u.rooftops.length}</span>
        </span>
      </button>
      {open && (
        <div className="px-3 pb-2.5 pt-0.5">
          <RooftopsTable rows={u.rooftops} />
        </div>
      )}
    </div>
  );
}

export function UnitsTable({ units }: { units: BookUnitDetail[] }) {
  if (units.length === 0) return <p className="px-1 py-2 text-sm text-ink-subtle">Nothing in this view.</p>;
  return (
    <div className="overflow-hidden rounded-xl border border-line">
      <div className="grid grid-cols-[2fr_0.7fr_1fr_0.9fr_1fr] gap-2 border-b border-line bg-surface-muted px-3 py-2 text-[10px] font-semibold uppercase tracking-wide text-ink-subtle">
        <span>Group / Account</span><span>Rooftops</span><span>Stage</span><span>Segment</span><span className="text-right">Engagement</span>
      </div>
      {units.map((u) => <UnitRow key={u.key} u={u} />)}
    </div>
  );
}
