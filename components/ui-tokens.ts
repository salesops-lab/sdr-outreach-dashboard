/** Shared chip/icon lookups used by Dashboard + drawer components (single source, no drift). */
import { StageGroup } from "../lib/sync/types";

export const STAGE_CHIP: Record<StageGroup, string> = {
  Prospect: "bg-slate-100 text-slate-600",
  "In Pipeline": "bg-violet-100 text-violet-700",
  "Contract Closed": "bg-emerald-100 text-emerald-700",
  "Drop Off": "bg-rose-100 text-rose-700",
  Other: "bg-slate-50 text-slate-400",
};
export const TEMP_CHIP: Record<string, string> = { hot: "bg-gradient-to-br from-rose-500 to-orange-500 text-white", warm: "bg-amber-400 text-white", cold: "bg-sky-400 text-white" };
export const TEMP_ICON: Record<string, string> = { hot: "🔥", warm: "🌤", cold: "🧊" };
