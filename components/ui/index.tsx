/**
 * Design-system primitives (Phase 1). Hand-rolled, token-driven components that replace the
 * duplicated inline Tailwind scattered across the app. Everything references the semantic
 * theme colors (surface / line / ink / primary / good / warm / hot / cold) from
 * tailwind.config.ts so restyling happens in one place.
 */
import type { LucideIcon } from "lucide-react";
import { Flame, CloudSun, Snowflake, ChevronUp, ChevronDown, ChevronsUpDown } from "lucide-react";

export function cn(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

/* ------------------------------------------------------------------ Surface (card) */

export function Surface({ className, children }: { className?: string; children: React.ReactNode }) {
  return <div className={cn("rounded-card border border-line bg-surface shadow-card", className)}>{children}</div>;
}

export function SectionTitle({ children, right }: { children: React.ReactNode; right?: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h3 className="text-[11px] font-bold uppercase tracking-[0.08em] text-ink-subtle">{children}</h3>
      {right}
    </div>
  );
}

/* ------------------------------------------------------------------ Chip / Badge */

type Tone = "neutral" | "primary" | "good" | "warn" | "danger" | "hot" | "warm" | "cold";

const CHIP_TONE: Record<Tone, string> = {
  neutral: "bg-surface-muted text-ink-muted",
  primary: "bg-primary-weak text-primary",
  good: "bg-good-weak text-good",
  warn: "bg-warn-weak text-warn",
  danger: "bg-danger-weak text-danger",
  hot: "bg-hot-weak text-hot",
  warm: "bg-warm-weak text-warm",
  cold: "bg-cold-weak text-cold",
};

export function Chip({ tone = "neutral", className, title, children }: { tone?: Tone; className?: string; title?: string; children: React.ReactNode }) {
  return (
    <span title={title} className={cn("inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold", CHIP_TONE[tone], className)}>
      {children}
    </span>
  );
}

/* ------------------------------------------------------------------ Meter bar */

const BAR_COLOR: Record<string, string> = {
  primary: "bg-primary",
  good: "bg-good",
  warm: "bg-warm",
  hot: "bg-hot",
  cold: "bg-cold",
  neutral: "bg-ink-subtle",
};

export function Bar({ value, tone = "primary", width = "w-16" }: { value: number; tone?: keyof typeof BAR_COLOR; width?: string }) {
  const pct = Math.max(0, Math.min(100, Math.round(value * 100)));
  return (
    <div className={cn("h-1.5 overflow-hidden rounded-full bg-surface-muted", width)}>
      <div className={cn("h-full rounded-full transition-[width]", BAR_COLOR[tone])} style={{ width: `${pct}%` }} />
    </div>
  );
}

/* ------------------------------------------------------------------ Stat tile (KPI) */

const ACCENT_TEXT: Record<Tone, string> = {
  neutral: "text-ink-subtle",
  primary: "text-primary",
  good: "text-good",
  warn: "text-warn",
  danger: "text-danger",
  hot: "text-hot",
  warm: "text-warm",
  cold: "text-cold",
};

export function StatTile({
  label, value, sub, icon: Icon, accent = "neutral",
}: { label: string; value: string; sub?: React.ReactNode; icon?: LucideIcon; accent?: Tone }) {
  return (
    <Surface className="p-4">
      <div className="flex items-center justify-between">
        <span className="text-[10px] font-semibold uppercase tracking-[0.09em] text-ink-subtle">{label}</span>
        {Icon && <Icon className={cn("h-4 w-4", ACCENT_TEXT[accent])} strokeWidth={2} />}
      </div>
      <div className="mt-2 font-mono text-[26px] font-bold leading-none tracking-tight tabular-nums text-ink">{value}</div>
      {sub && <div className="mt-2 text-[11px] tabular-nums text-ink-muted">{sub}</div>}
    </Surface>
  );
}

/* ------------------------------------------------------------------ Avatar (initials) */

const AVATAR_TINTS = [
  "bg-[#eef0fe] text-[#4338ca]",
  "bg-[#e6f6ee] text-[#0f7a4d]",
  "bg-[#fdf3e0] text-[#b0680a]",
  "bg-[#eaf1fe] text-[#2563eb]",
  "bg-[#fdecec] text-[#c53030]",
  "bg-[#f0eafe] text-[#7c3aed]",
];

function initials(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

export function Avatar({ name, size = 28 }: { name: string; size?: number }) {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
  const tint = AVATAR_TINTS[hash % AVATAR_TINTS.length];
  return (
    <span
      className={cn("inline-flex shrink-0 items-center justify-center rounded-full font-semibold", tint)}
      style={{ width: size, height: size, fontSize: size * 0.38 }}
    >
      {initials(name)}
    </span>
  );
}

/* ------------------------------------------------------------------ Grade badge */

const GRADE_TONE: Record<string, Tone> = { A: "good", B: "cold", C: "warm", D: "warn", F: "danger", "—": "neutral" };

export function GradeBadge({ grade, score, big }: { grade: string; score: number; big?: boolean }) {
  const tone = GRADE_TONE[grade] ?? "neutral";
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-lg font-bold tabular-nums",
        CHIP_TONE[tone],
        big ? "px-2.5 py-1 text-base" : "px-1.5 py-0.5 text-xs",
      )}
    >
      {grade}
      {grade !== "—" && <span className="font-mono font-semibold opacity-70">{score}</span>}
    </span>
  );
}

/* ------------------------------------------------------------------ Temperature badge */

export const TEMP_META: Record<"hot" | "warm" | "cold", { label: string; icon: LucideIcon; tone: Tone }> = {
  hot: { label: "Hot", icon: Flame, tone: "hot" },
  warm: { label: "Warm", icon: CloudSun, tone: "warm" },
  cold: { label: "Cold", icon: Snowflake, tone: "cold" },
};

export function TempBadge({ temp, showLabel = true, title }: { temp: "hot" | "warm" | "cold"; showLabel?: boolean; title?: string }) {
  const meta = TEMP_META[temp];
  const Icon = meta.icon;
  return (
    <Chip tone={meta.tone} title={title}>
      <Icon className="h-3 w-3" strokeWidth={2.4} />
      {showLabel && meta.label}
    </Chip>
  );
}

/* ------------------------------------------------------------------ Sortable table header */

export function SortHeader({
  children, active, dir, onClick, right,
}: { children: React.ReactNode; active: boolean; dir: "asc" | "desc"; onClick: () => void; right?: boolean }) {
  const Arrow = !active ? ChevronsUpDown : dir === "asc" ? ChevronUp : ChevronDown;
  return (
    <th className={cn("px-3 py-2.5", right ? "text-right" : "text-left")}>
      <button
        onClick={onClick}
        className={cn(
          "inline-flex items-center gap-1 transition-colors hover:text-ink",
          right && "flex-row-reverse",
          active ? "text-ink" : "text-ink-subtle",
        )}
      >
        {children}
        <Arrow className={cn("h-3 w-3", active ? "text-primary" : "text-ink-subtle/60")} strokeWidth={2.5} />
      </button>
    </th>
  );
}

/* ------------------------------------------------------------------ Segmented toggle */

export function Segmented({ options, value, onChange, tone = "primary" }: {
  options: [string, string][]; value: string; onChange: (v: string) => void; tone?: "primary" | "good";
}) {
  const active = tone === "good" ? "bg-good text-white shadow-sm" : "bg-primary text-primary-fg shadow-sm";
  return (
    <div className="flex flex-wrap gap-1 rounded-xl border border-line bg-surface p-1 shadow-card">
      {options.map(([v, label]) => (
        <button key={v} onClick={() => onChange(v)}
          className={cn("rounded-lg px-3 py-1.5 text-sm font-medium transition", value === v ? active : "text-ink-muted hover:bg-surface-muted hover:text-ink")}>
          {label}
        </button>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ Deal Health badge */

const HEALTH_META: Record<"green" | "yellow" | "red", { label: string; dot: string; cls: string }> = {
  green: { label: "Healthy", dot: "bg-good", cls: "bg-good-weak text-good ring-good/20" },
  yellow: { label: "At risk", dot: "bg-warm", cls: "bg-warm-weak text-warm ring-warm/25" },
  red: { label: "Critical", dot: "bg-danger", cls: "bg-danger-weak text-danger ring-danger/20" },
};

/** Green/Yellow/Red pill for a live deal's health (the demo→closure indicator). */
export function DealHealthBadge({ health, title }: { health: "green" | "yellow" | "red"; title?: string }) {
  const m = HEALTH_META[health];
  return (
    <span title={title} className={cn("inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-semibold ring-1", m.cls)}>
      <span className={cn("h-1.5 w-1.5 rounded-full", m.dot)} />
      {m.label}
    </span>
  );
}
