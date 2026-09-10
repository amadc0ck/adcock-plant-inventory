import { withSupabase } from "npm:@supabase/server@^1";
import { callClaude, parseJson, textFromResponse } from "../_shared/abg-context.ts";

// AI-2. No image: every field here follows from the NAME, not the photograph.
// Sending a picture to answer "what zone is Aeonium arboreum hardy to" would
// cost ten times as much and add nothing.
const FIELDS: Record<string, string> = {
  family: "Botanical family, e.g. Crassulaceae",
  genus: "Genus only, e.g. Aeonium",
  species_epithet: "Species epithet only, lowercase, e.g. arboreum. Null for a cultivar of hybrid origin.",
  description: "Two sentences on what this kind of plant LOOKS like. Appearance only — no care advice.",
  // Must stay in step with PLANT_TYPE_LABELS in index.html — the app's dropdown
  // and this prompt are two copies of one vocabulary. curio, dracaena, hoya,
  // haworthiopsis and lithops added v2.8.0.
  plant_type: "Exactly one of: cactus, aeonium, agave, aloe, cotyledon, crassula, curio, dracaena, echeveria, euphorbia, haworthia, haworthiopsis, hoya, kalanchoe, lithops, portulacaria, sedum, sempervivum, senecio",
  growth_habit: "Exactly one of: columnar, globular, rosette, clumping, caudiciform, trailing, mounding, upright, climbing, groundcover, solitary",
  mature_size: "Height and spread in feet or inches, e.g. \"3-4 ft tall x 2 ft wide\"",
  bloom_season: "When this flowers. One or more of: spring, early_summer, summer, late_summer, fall, winter. Separate several with a semicolon, e.g. \"spring; early_summer\" for a plant flowering from late spring into early summer. Null if it has no seasonal bloom — say why in bloom_habit instead.",
  // BLOOM-2. `not_observed` used to be a bloom_season value AND a sentinel the
  // app counted as blank, so Claude could answer it, Amanda could accept it,
  // and the field stayed a gap forever. Six species cycled that way. It is a
  // habit value now and NOT offered here: whether anyone has seen a plant
  // bloom in her garden is not something this model can know.
  bloom_habit: "Only when there is no seasonal answer. One of: intermittent (flowers on and off through the year), monocarpic (flowers once, then the plant dies), rarely (rarely or never flowers in cultivation — true of many columnar cacti, Euphorbia trigona, Portulacaria afra). Null if it does have a normal seasonal bloom. Do NOT answer whether it has been observed blooming; that is the owner's record, not yours.",
  /* The old text ended "Almost every succulent here is introduced", which
     handed Claude the answer before it looked at the plant and made the field
     unfalsifiable — every taxon came back `introduced`, including the ones
     genuinely native to California. Amanda spotted it 2026-08-30.

     The prior was not even wrong on the facts (most of a succulent collection
     in Concord IS introduced); it was wrong as a method, because it removed
     any reason to check the handful that are not. */
  native_range: "Where the species occurs in the wild, e.g. \"Canary Islands\". For a garden hybrid say so.",
  hardy_to: "Lowest USDA zone or temperature it survives, e.g. \"Zone 9\" or \"25F\"",
  water_needs: "Exactly one of: low, moderate, high",
  frost_tender: "true if a light frost will damage or kill it, false if it tolerates freezing",
  // v2.8.0. `light_conditions` is a text[] in the database. Claude answers with
  // a semicolon-separated string and the app splits it back into an array on
  // accept — suggestions.value_text is text, so there is nowhere to put a real
  // array in between.
  container_suitability: "Will this do better in a CONTAINER or IN THE GROUND, for a garden in Concord, California (USDA 9b)? Exactly one of: container, either, ground. Answer from mature size, root depth and how much it resents disturbance — an Agave americana reaching 6ft wants ground, an Echeveria is happy in a pot, most mid-sized succulents are either. This is about where it grows best, NOT about frost protection; that is frost_tender.",
  soil_needs: "The soil or mix this wants, in a short phrase. e.g. \"Fast-draining cactus mix; tolerates poor sandy soil\" or \"Gritty, low-organic, never wet in winter\". Say what matters for keeping it alive, not a recipe.",
  feeding_needs: "How to feed it, in a short phrase. e.g. \"Dilute balanced feed monthly in growth, none in winter\" or \"Rarely needs feeding\". Null if you do not know.",
  light_conditions: "Light this plant wants. One or more of: direct, indirect, partial, full, shade, morning, afternoon, all_day. Separate several with a semicolon, e.g. \"direct; morning\".",
  // Hybrid-only, gated below — see HYBRID_ONLY.
  is_hybrid: "true if this is a hybrid, false otherwise",
};

/* v2.8.0, narrowed to one field by PROF-3. Only asked when the record looks
   like a hybrid: a named cultivar, an is_hybrid flag already set, or a
   nothogeneric name. `parentage` was the other member and is gone — see below. */
const HYBRID_ONLY = ["is_hybrid"];

/* PROF-3, 2026-09-08. `parentage` was dropped from the asked set entirely, and
   `origin` with it — the latter no longer exists as a column (ORIG-1).

   Parentage was blank on 35 of the 43 hybrid-ish taxa, and AI-4 established
   why: most succulent genera have NO cultivar registration authority, so for a
   large share of them there is no recorded cross that exists to be found. The
   v2.8.0 note below was right that a straight species has no parentage; what it
   missed is that most CULTIVARS do not have a findable one either. Asking
   forever for a fact that does not exist is what turned "Species profiles
   unfinished" into a number that could not move.

   `species_epithet` is now skipped for a taxon with a cultivar (see the blank
   test) — a cultivar has no epithet, which FIELDS has always said and the blank
   test never honoured. */
const CULTIVAR_EXEMPT = ["species_epithet"];
const NOTHOGENERA = new Set([
  "graptoveria", "graptosedum", "pachyveria", "sedeveria", "cremneria",
  "mangave", "gasteraloe", "gastrolea", "alworthia",
]);
function looksHybrid(t: Record<string, unknown>): boolean {
  const g = String(t.genus || "").trim();
  if (t.is_hybrid === true) return true;
  if (t.cultivar && String(t.cultivar).trim()) return true;
  if (/^[x\u00D7]/i.test(g) && g.length > 1) return true;
  return NOTHOGENERA.has(g.toLowerCase().replace(/^[x\u00D7]/i, ""));
}

/* EMPTY since BLOOM-2. A sentinel is a value that is present but says nothing,
   so the blank test has to treat it as absent — and both entries that ever
   lived here were values CLAUDE COULD RETURN. That is a closed loop: the model
   satisfies the prompt, the answer is accepted, and the field still counts as
   blank, so the same species comes back in the next batch. Six did, on
   `bloom_season: not_observed`.

   `origin: ["unknown"]` went with the column (ORIG-1); `not_observed` is a
   bloom_habit value now, which is a real answer.

   **If a sentinel is ever needed again, it must not be offerable to Claude.**
   Prefer null: an absent answer is honestly blank and stays visible as work. */
const SENTINELS: Record<string, string[]> = {};

export default {
  fetch: withSupabase({ auth: "user" }, async (req, ctx) => {
    // NAME-2. `focus: "name"` checks the NAME itself rather than filling blanks.
    // The default mode deliberately never touches a field she has filled in —
    // "anything she has filled in is hers" — which is exactly why a misspelled
    // name could never be corrected. This mode inverts that for the name parts
    // only, and every result still arrives as a suggestion she accepts or
    // dismisses; nothing is written behind her.
    const { taxa_id, focus } = await req.json();
    const nameOnly = focus === "name";
    if (!taxa_id) return Response.json({ error: "Missing taxa_id" }, { status: 400 });

    const { data: t, error } = await ctx.supabase.from("taxa").select("*").eq("id", taxa_id).single();
    if (error || !t) return Response.json({ error: "Species not found" }, { status: 404 });

    // Only ever the blanks. Anything she has filled in is hers, and asking
    // about it would invite a suggestion to overwrite a fact she established.
    const hybridish = looksHybrid(t as Record<string, unknown>);
    const hasCultivar = !!(t.cultivar && String(t.cultivar).trim());
    const blank = Object.keys(FIELDS).filter((f) => {
      if (HYBRID_ONLY.includes(f) && !hybridish) return false;
      // A cultivar has no species epithet. FIELDS says so in its own
      // description and the test ignored it, so every cultivar was asked for
      // one and counted incomplete forever when none came back.
      if (CULTIVAR_EXEMPT.includes(f) && hasCultivar) return false;
      // Mirrors TAXON_ANSWERED_BY in index.html: a habit answers the season,
      // and a plant WITH seasons needs no habit. Asking for both invites a
      // contradiction Amanda would then have to adjudicate.
      const seasons = Array.isArray(t.bloom_season) ? t.bloom_season : [];
      const habit = String(t.bloom_habit || "").trim();
      if (f === "bloom_season" && habit) return false;
      if (f === "bloom_habit" && seasons.length) return false;
      const v = (t as Record<string, unknown>)[f];
      if (f === "frost_tender" || f === "is_hybrid") return v === null || v === undefined;
      if (Array.isArray(v)) return v.length === 0;
      if (v === null || v === undefined || String(v).trim() === "") return true;
      return (SENTINELS[f] || []).includes(String(v).trim().toLowerCase());
    });
    if (!nameOnly && !blank.length) {
      return Response.json({ success: true, suggestions: [], note: "This species record is already complete." });
    }

    // Compose the name the way the app does, cultivar INCLUDED.
    //
    // This read `botanical_name` first and fell back to genus + epithet, never
    // touching `cultivar`. Since v1.65.0 a taxon built from parts often has no
    // `botanical_name` at all, and a cultivar of hybrid origin has no epithet
    // either — so Echeveria 'Tippy', 'Flamingo', 'Purple Perle' and the rest all
    // reduced to the bare word "Echeveria". Claude was being asked for the
    // mature size and hardiness of an entire genus of hundreds of species, and
    // correctly returned nulls for everything. It read as "Claude has no
    // suggestions"; it was really "the question was unanswerable".
    //
    // Same failure as ensureTaxonForName() before v1.83.0: reading a column
    // instead of the composed name.
    const composed = [
      t.genus,
      t.is_hybrid && t.species_epithet ? `\u00D7 ${t.species_epithet}` : t.species_epithet,
      t.infraspecific,
      t.cultivar ? `'${String(t.cultivar).replace(/^['\u2018\u2019"]+|['\u2018\u2019"]+$/g, "")}'` : null,
    ].filter(Boolean).join(" ").trim();

    const name = composed || t.botanical_name || t.working_label || t.common_name;
    if (!name) return Response.json({ error: "This species has no name to look it up by" }, { status: 400 });

    // ---------- NAME-2: check and parse the name ----------
    if (nameOnly) {
      const raw = t.botanical_name || composed || t.working_label || "";
      const namePrompt = [
        "You are checking one entry in a private succulent and cactus collection for correct botanical naming.",
        "",
        `The record currently reads: ${raw}`,
        t.common_name ? `Common name on the record: ${t.common_name}` : "",
        `Structured parts currently stored — genus: ${t.genus || "(empty)"}, species_epithet: ${t.species_epithet || "(empty)"}, infraspecific: ${t.infraspecific || "(empty)"}, cultivar: ${t.cultivar || "(empty)"}, is_hybrid: ${t.is_hybrid ? "true" : "false"}`,
        "",
        "Do two things:",
        "1. Correct the name if it is misspelled, miscapitalised, or uses an outdated synonym. Species epithets are ALWAYS lowercase. Genus is always capitalised.",
        "2. Split it into its parts.",
        "",
        "Rules:",
        "- Only correct a spelling when you are confident of the intended taxon. A plausible-looking name you do not recognise should be returned unchanged with confidence low, NOT invented into something else.",
        "- cultivar: the epithet only, no quotes. 'Zwartkop', not \"'Zwartkop'\".",
        "- species_epithet: lowercase, no genus. Null for a cultivar of hybrid origin with no species.",
        "- infraspecific: the rank and epithet together, e.g. \"var. erinacea\", \"f. palmeri\". Rank epithets are lowercase. Null if there is none.",
        "- is_hybrid: true only for an interspecific hybrid written with a multiplication sign, e.g. Sedum × rubrotinctum.",
        "- botanical_name: the full corrected name as it should read, cultivar in single quotes.",
        "- family: the botanical family, if you are confident.",
        "- A working label that is not a botanical name at all (\"unidentified cactus\") is not an error. Return it unchanged with confidence low.",
        "",
        "Respond with ONLY this JSON, no prose and no markdown:",
        `{"genus": "string or null",`,
        ` "species_epithet": "string or null",`,
        ` "infraspecific": "string or null",`,
        ` "cultivar": "string or null",`,
        ` "is_hybrid": true or false,`,
        ` "botanical_name": "string or null",`,
        ` "family": "string or null",`,
        ` "correction": "one sentence on what was wrong, or null if the name was already correct",`,
        ` "confidence": "high|medium|low"}`,
      ].filter(Boolean).join("\n");

      let np: Record<string, unknown>;
      try {
        const data = await callClaude({
          model: "claude-sonnet-5",
          max_tokens: 700,
          messages: [{ role: "user", content: namePrompt }],
        });
        np = parseJson(textFromResponse(data));
      } catch (err) {
        return Response.json({ error: String((err as Error).message || err) }, { status: 502 });
      }

      const nconf = ({ high: 0.85, medium: 0.55, low: 0.25 } as Record<string, number>)[String(np.confidence)] ?? null;
      const correction = typeof np.correction === "string" && np.correction.trim() ? np.correction.trim() : null;

      // Only propose a field that actually DIFFERS from what is stored — a
      // suggestion confirming the status quo is noise she has to dismiss.
      const NAME_FIELDS = ["genus", "species_epithet", "infraspecific", "cultivar", "botanical_name", "family", "is_hybrid"];
      const current = (f: string) => {
        const v = (t as Record<string, unknown>)[f];
        return v === null || v === undefined ? "" : String(v).trim();
      };
      let usedRationale = false;
      const nameRows = NAME_FIELDS
        .map((f) => {
          let v = np[f];
          if (f === "is_hybrid") v = v === true;
          if (v === null || v === undefined) return null;
          const text = f === "is_hybrid" ? String(v) : String(v).trim();
          if (!text) return null;
          // Case matters here — "Agavoides" -> "agavoides" IS the correction.
          if (text === current(f)) return null;
          const row = {
            taxa_id, kind: "species_field", field: f, value_text: text.slice(0, 2000),
            confidence: nconf,
            rationale: usedRationale ? null : correction,
            status: "pending", raw_response: np,
          };
          usedRationale = true;
          return row;
        })
        .filter(Boolean);

      await ctx.supabase.from("suggestions").delete().eq("taxa_id", taxa_id).eq("status", "pending");
      if (!nameRows.length) {
        return Response.json({ success: true, suggestions: [], note: "The name looks right as it is." });
      }
      const { data: nameData, error: nameErr } = await ctx.supabase.from("suggestions").insert(nameRows).select();
      if (nameErr) return Response.json({ error: nameErr.message }, { status: 500 });
      return Response.json({ success: true, suggestions: nameData });
    }

    const known = Object.keys(FIELDS)
      .filter((f) => !blank.includes(f) && (t as Record<string, unknown>)[f])
      .map((f) => `${f}: ${(t as Record<string, unknown>)[f]}`);

    const prompt = [
      `Species: ${name}`,
      t.common_name ? `Also known as: ${t.common_name}` : "",
      t.cultivar
        ? `This is a named CULTIVAR. Answer for the cultivar where it differs from the species, and fall back to the species where the cultivar is not separately documented. Do not answer for the genus as a whole.`
        : "",
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
        max_tokens: 1700,
        messages: [{ role: "user", content: prompt }],
      });
      parsed = parseJson(textFromResponse(data));
    } catch (err) {
      return Response.json({ error: String((err as Error).message || err) }, { status: 502 });
    }

    const conf = ({ high: 0.85, medium: 0.55, low: 0.25 } as Record<string, number>)[String(parsed.confidence)] ?? null;
    // "unknown" / "none" back from Claude is a non-answer. Writing it would
    // replace a blank with a word that looks like a fact.
    const NON_ANSWERS = new Set(["unknown", "none", "n/a", "na", "null", "not known", "unspecified"]);
    const rows = blank
      .filter((f) => parsed[f] !== null && parsed[f] !== undefined && String(parsed[f]).trim() !== "")
      .filter((f) => !NON_ANSWERS.has(String(parsed[f]).trim().toLowerCase()))
      .filter((f) => !(f === "is_hybrid" && parsed[f] !== true))
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
    if (insErr) {
      const missing = /does not exist|schema cache|PGRST205/i.test(insErr.message);
      return Response.json({
        error: missing
          ? "The suggestions table does not exist yet — run the CREATE TABLE from BACKLOG v1.80.0, then: notify pgrst, 'reload schema';"
          : insErr.message,
      }, { status: 500 });
    }
    return Response.json({ success: true, suggestions: data });
  }),
};
