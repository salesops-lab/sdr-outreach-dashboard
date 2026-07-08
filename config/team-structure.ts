/**
 * SDR org hierarchy for the focus-model RBAC (per the "AE Pod (New)" sheet).
 * Three layers: SDR → AE pod → Manager. Some SDRs are ALSO managers/TLs ("player-coaches"):
 * they keep their SDR owner id AND get a team view. TLs (Shikhar, Kshitij) roll up to Vaibhav.
 *
 * Keyed by HubSpot owner id (from config/reps.ts). This drives DEFAULT scope only — everyone
 * keeps the org-wide "All reps" toggle (focus model, not confidentiality).
 *
 * GAPS (default to org-wide viewer until placed): Ketan Srivastava (68537320), Divyansh Gupta
 * (164845034), Rishabh Sharma (71105578), and Abhishek Bhattacharyya (71105580) are in
 * config/reps.ts but not in any pod the org sheet lists. "central" is a shared pool (no single
 * AE login). Sourav Singh + Animesh Anand are now tracked (added to config/reps.ts).
 */

export const AE_PODS = ["saarthak", "neelima", "archit", "prince", "central"] as const;
export type AePod = (typeof AE_PODS)[number];

/** AE login email → pod. "central" is a pool with no dedicated AE login. */
export const AE_EMAIL: Partial<Record<AePod, string>> = {
  saarthak: "saarthak.seth@spyne.ai",
  neelima: "neelima.tiwari@spyne.ai",
  archit: "archit.gupta@spyne.ai",
  prince: "prince.arora@spyne.ai",
};

/** Managers (player-coach SDRs). `parent` = the manager they roll up to (TLs → Vaibhav). */
export const MANAGERS: Record<string, { name: string; ownerId: string; parent?: string }> = {
  prabhjeet: { name: "Prabhjeet Kaur", ownerId: "160955299" },
  rajveer: { name: "Rajveer Singh", ownerId: "69016314" },
  vaibhav: { name: "Vaibhav Kumar", ownerId: "159458371" },
  shikhar: { name: "Shikhar Paroha", ownerId: "79785093", parent: "vaibhav" },
  kshitij: { name: "Kshitij Agarwal", ownerId: "62715106", parent: "vaibhav" },
};

/** SDR owner id → { pod, manager }. Sourav/Animesh included but pending a reps.ts add. */
export const SDR_TEAM: Record<string, { pod: AePod; manager: string }> = {
  // Prabhjeet's team
  "163855147": { pod: "saarthak", manager: "prabhjeet" }, // Gagandeep Kaur
  "164019464": { pod: "saarthak", manager: "prabhjeet" }, // Kreeti Chhabra
  "159761343": { pod: "saarthak", manager: "prabhjeet" }, // Viplove Tyagi
  "76546199": { pod: "saarthak", manager: "prabhjeet" }, // Nam Harrison (sheet: "Namrata Sharma")
  "160955299": { pod: "saarthak", manager: "prabhjeet" }, // Prabhjeet Kaur (player-coach)
  "165126708": { pod: "central", manager: "prabhjeet" }, // Lakshya Gaurh
  // Rajveer's team
  "160214774": { pod: "neelima", manager: "rajveer" }, // Anisha Jaiswal
  "160673631": { pod: "archit", manager: "rajveer" }, // Vaansh Sharma
  "160043135": { pod: "archit", manager: "rajveer" }, // Drishti Aggarwal
  "77266515": { pod: "saarthak", manager: "rajveer" }, // Vikram Choudhary
  "69016314": { pod: "archit", manager: "rajveer" }, // Rajveer Singh (player-coach)
  "66975998": { pod: "archit", manager: "rajveer" }, // Sanamdeep .
  // Vaibhav's org (Shikhar + Kshitij are TLs under Vaibhav)
  "160353848": { pod: "neelima", manager: "vaibhav" }, // Utsav Yadav
  "164380450": { pod: "neelima", manager: "kshitij" }, // Shubham Singha (TL Kshitij's team)
  "81615528": { pod: "archit", manager: "vaibhav" }, // Jayant Trivedi
  "164014269": { pod: "central", manager: "shikhar" }, // Palak Narula
  "159865948": { pod: "saarthak", manager: "kshitij" }, // Ashish Baweja
  "62715106": { pod: "neelima", manager: "vaibhav" }, // Kshitij Agarwal (TL, player-coach)
  "70740200": { pod: "neelima", manager: "shikhar" }, // Priyanka Sambyal
  "159458372": { pod: "neelima", manager: "kshitij" }, // Simran Grover
  "79785093": { pod: "neelima", manager: "vaibhav" }, // Shikhar Paroha (TL, player-coach)
  "79900347": { pod: "prince", manager: "shikhar" }, // Shadman Khalid
  "79528942": { pod: "central", manager: "vaibhav" }, // Khubaib Akram Khan
  "165867085": { pod: "central", manager: "kshitij" }, // Sourav Singh (TL Kshitij's team)
  "165725776": { pod: "central", manager: "shikhar" }, // Animesh Anand (TL Shikhar's team)
};

/** Which manager (if any) this owner id IS (player-coach lookup). */
export function managerKeyByOwnerId(ownerId: string | null | undefined): string | null {
  if (!ownerId) return null;
  for (const [key, m] of Object.entries(MANAGERS)) if (m.ownerId === ownerId) return key;
  return null;
}

/** Which pod a login email leads, if any. */
export function podByEmail(email: string | null | undefined): AePod | null {
  if (!email) return null;
  const lower = email.toLowerCase();
  for (const pod of AE_PODS) if (AE_EMAIL[pod] === lower) return pod;
  return null;
}

/** SDR owner ids in a pod. */
export function sdrOwnersInPod(pod: AePod): string[] {
  return Object.entries(SDR_TEAM).filter(([, t]) => t.pod === pod).map(([id]) => id);
}

/** SDR owner ids under a manager, recursively including child managers' teams (TLs → manager). */
export function sdrOwnersUnderManager(mgrKey: string): string[] {
  const keys = new Set<string>([mgrKey]);
  // walk down: add any manager whose parent chain reaches mgrKey
  let added = true;
  while (added) {
    added = false;
    for (const [key, m] of Object.entries(MANAGERS)) {
      if (m.parent && keys.has(m.parent) && !keys.has(key)) { keys.add(key); added = true; }
    }
  }
  return Object.entries(SDR_TEAM).filter(([, t]) => keys.has(t.manager)).map(([id]) => id);
}
