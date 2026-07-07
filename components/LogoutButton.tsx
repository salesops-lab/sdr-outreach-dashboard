"use client";

import { supabaseBrowser } from "../lib/supabase/client";

export default function LogoutButton() {
  async function signOut() {
    await supabaseBrowser().auth.signOut();
    window.location.href = "/login";
  }
  return (
    <button onClick={signOut} className="rounded-xl border border-slate-200 bg-white px-3 py-1.5 text-xs text-slate-600 shadow-sm hover:bg-slate-100">
      Sign out
    </button>
  );
}
