/**
 * SDRs + AEs this dashboard tracks: HubSpot owner ID -> display name.
 *
 * Resolved against HubSpot portal 242626590 (app-na2.hubspot.com) and
 * cross-checked against the existing call-scoring-agent sdr_map.ts.
 * This is the single source of truth for who appears on the dashboard.
 * 
 * AEs added for pod visibility (each pod lead sees their AEs + SDRs).
 */
export const REPS: Record<string, string> = {
  // Existing SDRs (30)
  "66975998": "Sanamdeep .",
  "69016314": "Rajveer Singh",
  "160353848": "Utsav Yadav",
  "79528942": "Khubaib Akram Khan",
  "160214774": "Anisha Jaiswal",
  "164380450": "Shubham Singha",
  "160673631": "Vaansh Sharma",
  "160043135": "Drishti Aggarwal",
  "159458371": "Vaibhav Kumar",
  "159865948": "Ashish Baweja",
  "81615528": "Jayant Trivedi",
  "164014269": "Palak Narula",
  "62715106": "Kshitij Agarwal",
  "70740200": "Priyanka Sambyal",
  "77266515": "Vikram Choudhary",
  "159458372": "Simran Grover",
  "79785093": "Shikhar Paroha",
  "68537320": "Ketan Srivastava",
  "79900347": "Shadman Khalid",
  "164845034": "Divyansh Gupta",
  "160955299": "Prabhjeet Kaur",
  "163855147": "Gagandeep Kaur",
  "164019464": "Kreeti Chhabra",
  "71105578": "Rishabh Sharma",
  "159761343": "Viplove Tyagi",
  "71105580": "Abhishek Bhattacharyya",
  "76546199": "Nam Harrison",
  "165126708": "Lakshya Gaurh",
  "165867085": "Sourav Singh",
  "165725776": "Animesh Anand",
   
  // AEs added for AE Pod visibility
  // Archit Pod
  "300786392766": "Liam Fallon",
  "283366799094": "Anmol Sehgal",
  "314515428073": "Jace Larsen",
  // Neelima Pod
  "207645325029": "Arun Divya Prakash",
  "303562897138": "Pallav Pandey",
  "129303672507": "Jatin Arora",
  // Saarthak Pod
  "127226246901": "Jaiaditya Berry",
  "127556571875": "Saurabh Nawale",
  "127219567335": "Shivam Ahuja",
  // Shashank Pod
  "128676855527": "Ankur Patel",
  "127555089110": "Vanshit Kothari",
  "127556567790": "Mayank Joshi",
};

/** Owner IDs as an array — used as the `IN` filter for HubSpot searches. */
export const REP_OWNER_IDS: string[] = Object.keys(REPS);

/** Resolve an owner ID to a display name (falls back to the raw ID). */
export function resolveRep(ownerId: string | null | undefined): string {
  if (!ownerId) return "—";
  return REPS[ownerId] ?? `ID:${ownerId}`;
}
