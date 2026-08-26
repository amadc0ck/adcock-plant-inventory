import { withSupabase } from "npm:@supabase/server@^1";
import { getValidGoogleAccessToken, getSupabaseAdmin } from "../_shared/google-auth.ts";

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

    // Pull the actual image bytes from Drive server-side
    const driveResp = await fetch(
      `https://www.googleapis.com/drive/v3/files/${photo.drive_file_id}?alt=media`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    if (!driveResp.ok) {
      return Response.json({ error: "Could not fetch photo from Drive" }, { status: 502 });
    }
    const imageBlob = await driveResp.blob();

    // Organs param deliberately omitted — Pl@ntNet defaults every
    // image to "auto" organ detection when it's left out.
    // include-related-images=true gives each candidate species a few
    // reference photos for visual comparison; nb-results=5 gives us
    // several candidates instead of just the single top guess.
    const plantnetKey = Deno.env.get("PLANTNET_API_KEY")!;
    const pnForm = new FormData();
    pnForm.append("images", imageBlob, "photo.jpg");

    const pnResp = await fetch(
      `https://my-api.plantnet.org/v2/identify/all?api-key=${plantnetKey}&include-related-images=true&nb-results=5`,
      { method: "POST", body: pnForm }
    );
    const pnData = await pnResp.json();

    if (!pnResp.ok || !pnData.results || pnData.results.length === 0) {
      return Response.json({ error: pnData.message || "No confident match found" }, { status: 200 });
    }

    const top = pnData.results[0];
    const suggestedName = top.species?.scientificNameWithoutAuthor || "Unknown";
    const confidence = top.score ?? null;

    const { data: idRow, error: idErr } = await ctx.supabase
      .from("identifications")
      .insert({
        photo_id,
        source: "PlantNet",
        suggested_name: suggestedName,
        confidence,
        raw_response: pnData,
        status: "pending",
      })
      .select()
      .single();

    if (idErr) return Response.json({ error: idErr.message }, { status: 500 });

    return Response.json({ success: true, identification: idRow });
  }),
};