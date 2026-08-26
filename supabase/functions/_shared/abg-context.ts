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
  const [taxaRes, plantsRes, locsRes, corrRes] = await Promise.all([
    db.from("taxa").select("id,botanical_name,common_name,genus,species_epithet,cultivar,is_hybrid,working_label"),
    db.from("plants").select("id,accession_number,taxa_id,location_id,status"),
    db.from("locations").select("id,name,parent_location_id,type,holds_plants,gallery_row,archived"),
    db.from("suggestions").select("kind,status,rationale,value_text")
      .in("status", ["accepted", "dismissed"]).order("created_at", { ascending: false }).limit(20),
  ]);

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
    // Her accepted and dismissed decisions, fed back as examples. This is the
    // only thing here that actually accumulates: the model is never trained,
    // but it can be shown what she has already corrected.
    corrections: (corrRes.data || [])
      .filter((r) => r.rationale)
      .map((r) => `${r.status === "accepted" ? "ACCEPTED" : "REJECTED"} (${r.kind}): ${r.rationale}`),
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

// Claude is asked for bare JSON, but a stray fence or preamble should not lose
// the whole call.
export function parseJson(text: string): Record<string, unknown> {
  const cleaned = String(text || "").replace(/```json|```/g, "").trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start >= 0 && end > start) return JSON.parse(cleaned.slice(start, end + 1));
    throw new Error("Could not parse Claude's response");
  }
}
