import { Radar, ShieldCheck } from "lucide-react";
import { Viewer } from "../lib/spine/types";
import LogoutButton from "./LogoutButton";
import { cn } from "./ui";

type Tab = "overview" | "accounts" | "attention" | "admin";
const TABS: { key: Tab; label: string; href: string }[] = [
  { key: "overview", label: "Overview", href: "/" },
  { key: "accounts", label: "Deals & Accounts", href: "/accounts" },
  { key: "attention", label: "Intelligence", href: "/attention" },
];

/** Persistent top navigation shared across the authenticated pages. */
export default function AppNav({ active, viewer }: { active: Tab; viewer: Viewer }) {
  const tab = (key: Tab, label: string, href: string) => (
    <a
      key={key}
      href={href}
      className={cn(
        "rounded-lg px-3 py-1.5 text-sm font-medium transition",
        active === key ? "bg-primary-weak text-primary" : "text-ink-muted hover:bg-surface-muted hover:text-ink",
      )}
    >
      {label}
    </a>
  );
  return (
    <nav className="sticky top-0 z-30 border-b border-line bg-surface/85 backdrop-blur">
      <div className="mx-auto flex max-w-[1500px] items-center gap-3 px-4 py-2.5 sm:px-6">
        <a href="/" className="mr-1 flex items-center gap-2">
          <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-primary text-primary-fg shadow-card">
            <Radar className="h-4 w-4" strokeWidth={2.4} />
          </span>
          <span className="text-sm font-extrabold tracking-tight text-ink">TrackerAI</span>
        </a>
        <div className="flex items-center gap-1">
          {TABS.map((t) => tab(t.key, t.label, t.href))}
          {viewer.isAdmin && tab("admin", "Admin", "/admin")}
        </div>
        <div className="ml-auto flex items-center gap-2 text-xs">
          <span className="hidden items-center gap-1 rounded-full bg-surface-muted px-2 py-0.5 font-semibold uppercase tracking-wide text-ink-subtle sm:inline-flex">
            <ShieldCheck className="h-3 w-3" />
            {viewer.role}
          </span>
          <LogoutButton />
        </div>
      </div>
    </nav>
  );
}
