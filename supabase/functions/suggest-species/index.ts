import { withSupabase } from "npm:@supabase/server@^1";
import { callClaude, parseJson } from "../_shared/abg-context.ts";

// AI-2. No image: every field here follows from the NAME, not the photograph.
// Sending a picture to answer "what zone is Aeonium arboreum hardy to" would
// cost ten times as much and add nothing.
const FIELDS: Record<string, string> = {
  family: "Botanical family, e.g. Crassulaceae",
  genus: "Genus only, e.g. Aeonium",
  species_epithet: "Species epithet only, lowercase, e.g. arboreum. Null for a cultivar of hybrid origin.",
  description: "Two sentences on what this kind of plant LOOKS like. Appearance only — no care advice.",
  plant_type: "Exactly one of: cactus, aeonium, agave, aloe, cotyledon, crassula, echeveria, euphorbia, haworthia, kalanchoe, portulacaria, sedum, sempervivum, senecio",
  growth_habit: "Exactly one of: columnar, globular, rosette, clumping, caudiciform, trailing, mounding, upright, climbing, groundcover, solitary",
  mature_size: "Height and spread in feet or inches, e.g. \"3-4 ft tall x 2 ft wide\"",
  bloom_season: "Exactly one of: spring, early_summer, summer, late_summer, fall, winter, intermittent, monocarpic, not_observed",
  origin: "Exactly one of: native, introduced, unknown. Relative to the San Francisco Bay Area, California. Almost every succulent here is introduced.",
  native_range: "Where the species occurs in the wild, e.g. \"Canary Islands\". For a garden hybrid say so.",
  hardy_to: "Lowest USDA zone or temperature it survives, e.g. \"Zone 9\" or \"25F\"",
  water_needs: "Exactly one of: low, moderate, high",
  frost_tender: "true if a light frost will damage or kill it, false if it tolerates freezing",
};

export default {
  fetch: withSupabase({ auth: "user" }, async (req, ctx) => {
    const { taxa_id } = await req.json();
    if (!taxa_id) return Response.json({ error: "Missing taxa_id" }, { status: 400 });

    const { data: t, error } = await ctx.supabase.from("taxa").select("*").eq("id", taxa_id).single();
    if (error || !t) return Response.json({ error: "Species not found" }, { status: 404 });

    // Only ever the blanks. Anything she has filled in is hers, and asking
    // about it would invite a suggestion to overwrite a fact she established.
    const blank = Object.keys(FIELDS).filter((f) => {
      const v = (t as Record<string, unknown>)[f];
      if (f === "frost_tender") return v === null || v === undefined;
      return v === null || v === undefined || String(v).trim() === "";
    });
    if (!blank.length) {
      return Response.json({ success: true, suggestions: [], note: "This species record is already complete." });
    }

    const name = [t.botanical_name, t.common_name].filter(Boolean).join(" / ") ||
      [t.genus, t.species_epithet].filter(Boolean).join(" ") || t.working_label;
    if (!name) return Response.json({ error: "This species has no name to look it up by" }, { status: 400 });

    const known = Object.keys(FIELDS)
      .filter((f) => !blank.includes(f) && (t as Record<string, unknown>)[f])
      .map((f) => `${f}: ${(t as Record<string, unknown>)[f]}`);

    const prompt = [
      `Species: ${name}`,
      known.length ? `Already recorded (do not contradict these):\n${known.join("\n")}` : "",
      "",
      "Fill in ONLY these missing fields for a private succulent collection in the San Francisco Bay Area:",
      ...blank.map((f) => `- ${f}: ${FIELDS[f]}`),
      "",
      "If you are not reasonably confident about a field, return null for it rather than guessing — a wrong horticultural fact recorded as truth is worse than a blank.",
      "Respond with ONLY a JSON object whose keys are exactly the field names listed, plus a \"confidence\" key that is high, medium or low.",
    ].filter(Boolean).join("\n");

    let parsed: Record<string, unknown>;
    try {
      const data = await callClaude({
        model: "claude-sonnet-5",
        max_tokens: 900,
        messages: [{ role: "user", content: prompt }],
      });
      parsed = parseJson((data as any).content?.[0]?.text || "");
    } catch (err) {
      return Response.json({ error: String((err as Error).message || err) }, { status: 502 });
    }

    const conf = ({ high: 0.85, medium: 0.55, low: 0.25 } as Record<string, number>)[String(parsed.confidence)] ?? null;
    const rows = blank
      .filter((f) => parsed[f] !== null && parsed[f] !== undefined && String(parsed[f]).trim() !== "")
      .map((f) => ({
        taxa_id,
        kind: "species_field",
        field: f,
        value_text: String(parsed[f]).trim().slice(0, 2000),
        confidence: conf,
        rationale: null,
        status: "pending",
        raw_response: parsed,
      }));

    await ctx.supabase.from("suggestions").delete().eq("taxa_id", taxa_id).eq("status", "pending");
    if (!rows.length) {
      return Response.json({ success: true, suggestions: [], note: "Claude was not confident enough about any of the blanks." });
    }
    const { data, error: insErr } = await ctx.supabase.from("suggestions").insert(rows).select();
    if (insErr) return Response.json({ error: insErr.message }, { status: 500 });
    return Response.json({ success: true, suggestions: data });
  }),
};
