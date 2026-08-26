import { withSupabase } from "npm:@supabase/server@^1";
import { getValidGoogleAccessToken, getSupabaseAdmin } from "../_shared/google-auth.ts";
import { buildContext, arrayBufferToBase64, callClaude, parseJson } from "../_shared/abg-context.ts";

// AI-1. Replaces identify-plant-claude's "what species is this?" with "which of
// HER records does this belong to?" — a different question with a checkable
// answer. Species guessing stays with Pl@ntNet, which is cheaper and purpose
// built for it.
export default {
  fetch: withSupabase({ auth: "user" }, async (req, ctx) => {
    const { photo_id } = await req.json();
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
        `${l.id} | ${l.path}${l.holds_plants ? " | holds plants" : " | area, holds no plants directly"}${l.archive ? " | ARCHIVE, a former home" : ""}`),
      cx.corrections.length ? "\n## Recent decisions by the collection owner — learn from these\n" + cx.corrections.join("\n") : "",
    ].join("\n");

    const task = [
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

    let parsed: Record<string, unknown>;
    let claudeData: Record<string, unknown>;
    try {
      claudeData = await callClaude({
        model: "claude-sonnet-5",
        max_tokens: 600,
        system: [{ type: "text", text: catalogue, cache_control: { type: "ephemeral" } }],
        messages: [{
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: mediaType, data: base64Image } },
            { type: "text", text: task },
          ],
        }],
      });
      parsed = parseJson((claudeData as any).content?.[0]?.text || "");
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

    const rows: Record<string, unknown>[] = [];
    const add = (kind: string, extra: Record<string, unknown>) =>
      rows.push({ photo_id, kind, confidence: conf, rationale, status: "pending", raw_response: parsed, ...extra });

    if (validPlant) add("plant_tag", { value_id: validPlant });
    else if (validTaxon) add("new_specimen", { value_id: validTaxon });
    if (validLoc && validLoc !== photo.location_id) add("location_tag", { value_id: validLoc });
    if (typeof parsed.photo_type === "string" &&
        ["general", "bloom", "detail", "condition"].includes(parsed.photo_type) &&
        parsed.photo_type !== (photo.photo_type || "general")) {
      add("photo_type", { value_text: parsed.photo_type });
    }
    if (parsed.in_bloom === true) add("bloom", { value_text: "in_bloom" });
    if (typeof parsed.health_note === "string" && parsed.health_note.trim()) {
      add("health_note", { value_text: parsed.health_note.trim().slice(0, 400) });
    }

    // Re-asking replaces the previous pending answer rather than stacking a
    // second opinion nobody asked for.
    await ctx.supabase.from("suggestions").delete().eq("photo_id", photo_id).eq("status", "pending");

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
