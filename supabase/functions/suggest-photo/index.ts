import { withSupabase } from "npm:@supabase/server@^1";
import { getValidGoogleAccessToken, getSupabaseAdmin } from "../_shared/google-auth.ts";
import { buildContext, arrayBufferToBase64, callClaude, parseJson, textFromResponse } from "../_shared/abg-context.ts";

// AI-1. Replaces identify-plant-claude's "what species is this?" with "which of
// HER records does this belong to?" — a different question with a checkable
// answer. Species guessing stays with Pl@ntNet, which is cheaper and purpose
// built for it.
export default {
  fetch: withSupabase({ auth: "user" }, async (req, ctx) => {
    // focus lets her ask ONE question instead of all of them. "Where was this
    // taken?" is a different job from "what plant is this?", it is the one she
    // has 932 photos of, and a narrower prompt is both cheaper and better —
    // the model is not splitting attention across five answers.
    const { photo_id, focus } = await req.json();
    const locationOnly = focus === "location";
    const plantOnly = focus === "plant";
    // "How is this plant doing?" is a third question, and unlike the other two
    // it is only answerable once the photo is already filed: the diagnosis is
    // worth little without knowing which specimen it is and where it lives.
    const healthOnly = focus === "health";
    if (!photo_id) return Response.json({ error: "Missing photo_id" }, { status: 400 });

    const { data: photo, error: photoErr } = await ctx.supabase
      .from("photos").select("*").eq("id", photo_id).single();
    if (photoErr || !photo) return Response.json({ error: "Photo not found" }, { status: 404 });

    const supabaseAdmin = getSupabaseAdmin();
    let accessToken: string;
    try {
      accessToken = await getValidGoogleAccessToken(supabaseAdmin);
    } catch (err) {
      return Response.json({ error: String(err) }, { status: 401 });
    }

    const driveResp = await fetch(
      `https://www.googleapis.com/drive/v3/files/${photo.drive_file_id}?alt=media`,
      { headers: { Authorization: `Bearer ${accessToken}` } },
    );
    if (!driveResp.ok) return Response.json({ error: "Could not fetch photo from Drive" }, { status: 502 });
    const mediaType = driveResp.headers.get("Content-Type") || "image/jpeg";
    const base64Image = arrayBufferToBase64(await driveResp.arrayBuffer());

    const cx = await buildContext(ctx.supabase);
    const filedAt = photo.location_id
      ? cx.locations.find((l) => l.id === photo.location_id)?.path || null
      : null;

    // The catalogue is identical across a batch, so it goes in a cache_control
    // block: the first call pays for it, the next hour of calls do not. That is
    // what makes "select 40 photos and ask" affordable.
    const catalogue = [
      "You are assisting with Adcock Botanical Garden, a private succulent and cactus collection.",
      "Below is the ENTIRE collection. Suggest records that EXIST in it, by id.",
      "",
      "## Species (taxa)",
      ...cx.taxa.map((t) => `${t.id} | ${t.name}${t.common ? ` | ${t.common}` : ""}`),
      "",
      "## Specimens (individual plants, active only)",
      ...cx.specimens.map((s) => `${s.id} | ${s.acc} | ${s.taxon} | ${s.location || "no location"}`),
      "",
      "## Locations",
      ...cx.locations.map((l) =>
        `${l.id} | ${l.path}${l.holds_plants ? " | holds plants" : " | area, holds no plants directly"}${l.archive ? " | ARCHIVE, a former home" : ""}${l.period ? ` | ${l.period}` : ""}`),
      cx.corrections.length ? "\n## Recent decisions by the collection owner — learn from these\n" + cx.corrections.join("\n") : "",
    ].join("\n");

    const dated = photo.taken_at ? String(photo.taken_at).slice(0, 10) : null;

    const locationTask = [
      "Where was this photograph taken? Match it to one location from the list above.",
      dated ? `It was taken on ${dated}. Several locations carry the years the collection lived there — use that first, it is the strongest evidence you have.` : "It has no capture date.",
      filedAt ? `It is currently filed under: ${filedAt}.` : "It is not filed anywhere yet.",
      "",
      "What to look at, in order:",
      "1. The date against each location's period. A photo from a year the collection lived somewhere else is almost certainly from that place.",
      "2. The setting — flooring, walls, fencing, light, the pots and staging visible around the plant.",
      "3. Whether it is a close-up of one plant (suggest the container it sits in) or a wide view (suggest the area).",
      "",
      "Rules:",
      "- Return an id copied exactly from the list. Never invent one.",
      "- Return null if you genuinely cannot tell. Null is far more useful than a guess: she has 932 of these and undoing a wrong one costs more than filing it by hand.",
      "- A close-up with no surroundings visible is usually a null. Say so in the rationale.",
      "",
      "Respond with ONLY this JSON, no prose and no markdown:",
      `{"location_id": "uuid or null", "confidence": "high|medium|low", "rationale": "one sentence naming what in the image or the date led you here"}`,
    ].filter(Boolean).join("\n");

    const fullTask = [
      "Look at the photograph and suggest how it should be filed.",
      photo.taken_at ? `The photo was taken on ${String(photo.taken_at).slice(0, 10)}.` : "",
      filedAt ? `It is currently filed under: ${filedAt}.` : "It is not filed to any location yet.",
      "",
      "Rules:",
      "- Only ever return ids copied exactly from the lists above. Never invent one.",
      "- If nothing in the collection is a good match, return null for that field. A confident null is far more useful than a guess; she has to undo wrong suggestions by hand.",
      "- Only suggest a location where 'holds plants' is true, unless the photo is clearly a wide view of an area.",
      "- Never suggest an ARCHIVE location for a recent photo.",
      "- new_specimen_taxa_id: set this ONLY if the plant is clearly one of her known species but no existing specimen matches the location. It offers to create a new specimen of that species.",
      "",
      "Respond with ONLY this JSON, no prose and no markdown:",
      `{"plant_id": "uuid or null",`,
      ` "location_id": "uuid or null",`,
      ` "new_specimen_taxa_id": "uuid or null",`,
      ` "photo_type": "general|bloom|detail|condition",`,
      ` "in_bloom": true or false,`,
      ` "health_note": "one short sentence if the plant looks stressed, damaged or diseased, otherwise null",`,
      ` "confidence": "high|medium|low",`,
      ` "rationale": "one sentence on what in the image led you here"}`,
    ].filter(Boolean).join("\n");

    // The specimen and its species, so the read is against what this plant is
    // supposed to look like rather than against cacti in general.
    const subject = photo.plant_id ? cx.specimens.find((sp) => sp.id === photo.plant_id) : null;

    const healthTask = [
      "Assess the health of the plant in this photograph. Do not identify it and do not file it — both are already settled.",
      subject ? `This is ${subject.acc}, ${subject.taxon}${subject.location ? `, growing at ${subject.location}` : ""}.` : "",
      dated ? `The photo was taken on ${dated}.` : "",
      "",
      "Judge it against what this species should look like when healthy. Several succulents look alarming when they are entirely fine:",
      "- Lower leaves drying and shrivelling is normal growth, not decline.",
      "- Some species are summer-dormant and look half dead in July. That is correct behaviour, not a problem.",
      "- Red, purple or bronze colouring is often sun stress, which is usually cosmetic and sometimes desirable.",
      "",
      "Say plainly when something is genuinely wrong: rot at the base or centre, pests, etiolation, sunburn scarring, desiccation, or a plant outgrowing its container.",
      "",
      "Rules:",
      "- A photograph shows one moment from one angle. Where you cannot tell, say so rather than guessing — this drives what she does to a living plant.",
      "- Rot at the centre or the base is the one thing worth being forward about, because it spreads and it is often fatal.",
      "- suggested_health must be one of: healthy, watch, urgent, recovery, unknown. Use urgent only for something needing attention within days.",
      "",
      "Respond with ONLY this JSON, no prose and no markdown:",
      `{"assessment": "two or three sentences on what you can actually see",`,
      ` "issues": ["short phrase per problem, empty array if none"],`,
      ` "recommendation": "one sentence on what to do, or null if nothing is needed",`,
      ` "suggested_health": "healthy|watch|urgent|recovery|unknown",`,
      ` "confidence": "high|medium|low"}`,
    ].filter(Boolean).join("\n");

    const task = locationOnly ? locationTask : healthOnly ? healthTask : fullTask;

    let parsed: Record<string, unknown>;
    let claudeData: Record<string, unknown>;
    try {
      claudeData = await callClaude({
        model: "claude-sonnet-5",
        max_tokens: locationOnly ? 400 : healthOnly ? 700 : 1400,
        system: [{ type: "text", text: catalogue, cache_control: { type: "ephemeral" } }],
        messages: [{
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: mediaType, data: base64Image } },
            { type: "text", text: task },
          ],
        }],
      });
      parsed = parseJson(textFromResponse(claudeData));
    } catch (err) {
      return Response.json({ error: String((err as Error).message || err) }, { status: 502 });
    }

    // Anything not present in the catalogue is discarded rather than stored. A
    // hallucinated uuid would render as a blank row she cannot act on.
    const validPlant = cx.specimens.some((s) => s.id === parsed.plant_id) ? parsed.plant_id : null;
    const validLoc = cx.locations.some((l) => l.id === parsed.location_id) ? parsed.location_id : null;
    const validTaxon = cx.taxa.some((t) => t.id === parsed.new_specimen_taxa_id) ? parsed.new_specimen_taxa_id : null;
    const conf = ({ high: 0.85, medium: 0.55, low: 0.25 } as Record<string, number>)[String(parsed.confidence)] ?? null;
    const rationale = typeof parsed.rationale === "string" ? parsed.rationale.slice(0, 400) : null;

    // The rationale explains the IDENTIFICATION — why this photo is that plant.
    // Repeating it under the photo type, the bloom flag and the health note
    // made every card say the same paragraph three times, and put the plant's
    // reasoning under a health note it did not describe.
    const rows: Record<string, unknown>[] = [];
    let rationaleUsed = false;
    const add = (kind: string, extra: Record<string, unknown>, explain?: boolean) => {
      const withWhy = explain && !rationaleUsed;
      if (withWhy) rationaleUsed = true;
      rows.push({
        photo_id, kind, confidence: conf,
        rationale: withWhy ? rationale : null,
        status: "pending", raw_response: parsed, ...extra,
      });
    };

    if (healthOnly) {
      const assessment = typeof parsed.assessment === "string" ? parsed.assessment.trim() : "";
      const issues = Array.isArray(parsed.issues) ? parsed.issues.filter((x) => typeof x === "string" && x.trim()) : [];
      const rec = typeof parsed.recommendation === "string" ? parsed.recommendation.trim() : "";
      const note = [assessment, issues.length ? `Issues: ${issues.join("; ")}.` : "", rec ? `Suggested: ${rec}` : ""]
        .filter(Boolean).join(" ");
      if (note) {
        rows.push({
          photo_id, kind: "health_note", confidence: conf, rationale: null,
          status: "pending", raw_response: parsed, value_text: note.slice(0, 900),
        });
      }
      // A proposed tier is a separate, separately-acceptable suggestion: she may
      // want the note on the record without changing the plant's status.
      const sh = String(parsed.suggested_health || "");
      if (["healthy", "watch", "urgent", "recovery", "unknown"].includes(sh) && photo.plant_id) {
        rows.push({
          photo_id, kind: "health_status", confidence: conf, rationale: null,
          status: "pending", raw_response: parsed, value_text: sh,
        });
      }
    }

    if (!locationOnly && !healthOnly) {
      if (validPlant) add("plant_tag", { value_id: validPlant }, true);
      else if (validTaxon) add("new_specimen", { value_id: validTaxon }, true);
    }
    if (!plantOnly && !healthOnly && validLoc && validLoc !== photo.location_id) add("location_tag", { value_id: validLoc }, true);
    if (!locationOnly && !healthOnly && typeof parsed.photo_type === "string" &&
        ["general", "bloom", "detail", "condition"].includes(parsed.photo_type) &&
        parsed.photo_type !== (photo.photo_type || "general")) {
      add("photo_type", { value_text: parsed.photo_type });
    }
    if (!locationOnly && !healthOnly && parsed.in_bloom === true) add("bloom", { value_text: "in_bloom" });
    if (!locationOnly && !healthOnly && typeof parsed.health_note === "string" && parsed.health_note.trim()) {
      add("health_note", { value_text: parsed.health_note.trim().slice(0, 400) });
    }

    // Re-asking replaces the previous pending answer rather than stacking a
    // second opinion nobody asked for.
    // A focused ask replaces only what it can answer. Asking "where?" must not
    // discard a plant suggestion from an earlier full pass.
    let clear = ctx.supabase.from("suggestions").delete().eq("photo_id", photo_id).eq("status", "pending");
    if (locationOnly) clear = clear.eq("kind", "location_tag");
    if (plantOnly) clear = clear.in("kind", ["plant_tag", "new_specimen"]);
    if (healthOnly) clear = clear.in("kind", ["health_note", "health_status"]);
    await clear;

    if (!rows.length) {
      return Response.json({ success: true, suggestions: [], note: "Claude found nothing it could match with confidence." });
    }
    const { data, error } = await ctx.supabase.from("suggestions").insert(rows).select();
    if (error) {
      // The commonest first-run failure by a distance: the code deployed, the
      // migration did not. Say which statement is missing rather than echoing
      // "relation does not exist" nine times.
      const missing = /does not exist|schema cache|PGRST205/i.test(error.message);
      return Response.json({
        error: missing
          ? "The suggestions table does not exist yet — run the CREATE TABLE from BACKLOG v1.80.0, then: notify pgrst, 'reload schema';"
          : error.message,
      }, { status: 500 });
    }
    return Response.json({ success: true, suggestions: data, usage: (claudeData as any).usage || null });
  }),
};
