"use client";

/**
 * Slide-over rep detail: right panel on desktop (~2/3 width), full-screen sheet
 * on mobile. Own scroll container — the page behind never scrolls or reflows.
 * Content comes in as children to avoid an import cycle with Dashboard.tsx.
 */
import { ReactNode, useEffect, useRef } from "react";

export default function RepDrawer({ title, badge, subtitle, onClose, children }: {
  title: string; badge?: ReactNode; subtitle?: string; onClose: () => void; children: ReactNode;
}) {
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    closeRef.current?.focus();
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50">
      <div className="absolute inset-0 bg-slate-900/40 backdrop-blur-[2px]" onClick={onClose} />
      <aside role="dialog" aria-modal="true" className="absolute inset-y-0 right-0 flex w-full flex-col bg-slate-50 shadow-2xl sm:w-[min(66vw,1100px)] sm:min-w-[640px]">
        <header className="flex items-center justify-between gap-3 border-b border-slate-200 bg-white px-4 py-3 sm:px-6">
          <div className="flex min-w-0 items-center gap-3">
            <h2 className="truncate text-lg font-black text-slate-900">{title}</h2>
            {badge}
            {subtitle && <span className="hidden rounded-lg bg-slate-100 px-2 py-0.5 text-xs font-semibold text-slate-500 sm:inline">{subtitle}</span>}
          </div>
          <button ref={closeRef} onClick={onClose} aria-label="Close" className="rounded-xl border border-slate-200 bg-white px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-100">✕</button>
        </header>
        <div className="flex-1 overflow-y-auto px-4 py-5 sm:px-6">{children}</div>
      </aside>
    </div>
  );
}
