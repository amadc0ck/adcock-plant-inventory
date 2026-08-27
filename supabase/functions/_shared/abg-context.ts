// The catalogue Claude needs to suggest an EXISTING record rather than guess a
// name. Without it the model can only answer "this looks like an Aeonium",
// which is a species guess, not a specimen you own — and species guessing is
// Pl@ntNet's job.
//
// Deliberately not cached, synced or "trained": the whole collection is a few
// kilobytes, so it rides along with every call and is therefore never stale. A
// specimen created a minute ago is in the next request.
import { createClient } from "npm:@supabase/supabase-js@2";

type Db = ReturnType<typeof createClient>;

export interface AbgContext {
  taxa: { id: string; name: string; common: string | null }[];
  specimens: { id: string; acc: string; taxon: string; location: string | null }[];
  locations: { id: string; path: string; holds_plants: boolean; archive: boolean }[];
  corrections: string[];
}

function taxonName(t: Record<string, unknown>): string {
  const genus = String(t.genus || "").trim();
  const epithet = String(t.species_epithet || "").trim();
  const cultivar = String(t.cultivar || "").trim();
  if (genus && (epithet || cultivar)) {
    const sci = epithet ? `${genus}${t.is_hybrid ? " ×" : ""} ${epithet}` : genus;
    return cultivar ? `${sci} '${cultivar}'` : sci;
  }
  return String(t.botanical_name || t.working_label || "Unnamed taxon").trim();
}

// Same rule the app uses: a container holds plants, an area does not, unless
// the flag says otherwise. Claude must not propose filing a specimen into a
// former home or a whole-area view.
function holdsPlants(l: Record<string, unknown>): boolean {
  if (l.holds_plants === true) return true;
  if (l.holds_plants === false) return false;
  return ["container", "hospital", "work_area"].includes(String(l.type));
}

export async function buildContext(db: Db): Promise<AbgContext> {
  const [taxaRes, plantsRes, locsRes] = await Promise.all([
    db.from("taxa").select("id,botanical_name,common_name,genus,species_epithet,cultivar,is_hybrid,working_label"),
    db.from("plants").select("id,accession_number,taxa_id,location_id,status"),
    db.from("locations").select("id,name,parent_location_id,type,holds_plants,gallery_row,archived"),
  ]);

  // Past decisions, fed back as examples. Kept out of the Promise.all and
  // wrapped in its own try: before the suggestions migration runs this table
  // does not exist, and an improvement must never take down the call it is
  // improving.
  let corrections: string[] = [];
  try {
    const corrRes = await db.from("suggestions")
      .select("kind,status,rationale")
      .in("status", ["accepted", "dismissed"])
      .order("created_at", { ascending: false })
      .limit(20);
    corrections = (corrRes.data || [])
      .filter((r: Record<string, unknown>) => r.rationale)
      .map((r: Record<string, unknown>) =>
        `${r.status === "accepted" ? "ACCEPTED" : "REJECTED"} (${r.kind}): ${r.rationale}`);
  } catch {
    corrections = [];
  }

  const taxaRows = taxaRes.data || [];
  const locRows = locsRes.data || [];
  const byId = new Map(locRows.map((l) => [l.id as string, l]));

  const pathOf = (id: string | null): string => {
    const parts: string[] = [];
    let cur = id ? byId.get(id) : null;
    let guard = 0;
    while (cur && guard++ < 12) {
      parts.unshift(String(cur.name));
      cur = cur.parent_location_id ? byId.get(cur.parent_location_id as string) : null;
    }
    return parts.join(" > ");
  };

  const taxonById = new Map(taxaRows.map((t) => [t.id as string, t]));

  return {
    taxa: taxaRows.map((t) => ({
      id: t.id as string,
      name: taxonName(t),
      common: (t.common_name as string) || null,
    })),
    specimens: (plantsRes.data || [])
      .filter((p) => p.status === "active")
      .map((p) => ({
        id: p.id as string,
        acc: p.accession_number as string,
        taxon: taxonById.has(p.taxa_id as string) ? taxonName(taxonById.get(p.taxa_id as string)!) : "unidentified",
        location: p.location_id ? pathOf(p.location_id as string) : null,
      })),
    locations: locRows
      .filter((l) => !l.archived)
      .map((l) => ({
        id: l.id as string,
        path: pathOf(l.id as string),
        holds_plants: holdsPlants(l),
        archive: l.gallery_row === "archives",
      })),
    corrections,
  };
}

// Spreading a whole byte array at once blows the call stack on any real photo —
// millions of function arguments. REFERENCE §8.
export function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunk = 8192;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export async function callClaude(body: unknown) {
  const key = Deno.env.get("ANTHROPIC_API_KEY");
  if (!key) throw new Error("ANTHROPIC_API_KEY is not set on this project");
  const resp = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const data = await resp.json();
  if (!resp.ok) throw new Error(data.error?.message || "Claude request failed");
  return data;
}

// content[0] is NOT reliably the text block — a response can lead with a
// thinking block, and `content[0].text` is then undefined, which turned every
// call into "Could not parse Claude's response". Take every text block there
// is and join them.
export function textFromResponse(data: unknown): string {
  const blocks = (data as { content?: { type?: string; text?: string }[] })?.content || [];
  return blocks.filter((b) => b && b.type === "text" && typeof b.text === "string")
    .map((b) => b.text).join("\n").trim();
}

// Claude is asked for bare JSON, but a stray fence or preamble should not lose
// the whole call.
export function parseJson(text: string): Record<string, unknown> {
  const cleaned = String(text || "").replace(/```json|```/g, "").trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(cleaned.slice(start, end + 1));
      } catch { /* fall through to the reported error */ }
    }
    // Carry what it actually said. "Could not parse" with nothing attached is
    // the least useful error in the app, and it cost two rounds to diagnose.
    throw new Error(
      cleaned
        ? `Could not parse Claude's response: ${cleaned.slice(0, 300)}`
        : "Claude returned no text content",
    );
  }
}
