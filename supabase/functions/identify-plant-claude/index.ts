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

    const driveResp = await fetch(
      `https://www.googleapis.com/drive/v3/files/${photo.drive_file_id}?alt=media`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    if (!driveResp.ok) {
      return Response.json({ error: "Could not fetch photo from Drive" }, { status: 502 });
    }
    const contentType = driveResp.headers.get("Content-Type") || "image/jpeg";
    const imageBuffer = await driveResp.arrayBuffer();
    // Convert in small chunks — spreading the whole byte array at once blows
// the call stack on any real-sized photo (millions of function arguments).
function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunkSize = 8192;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}
const base64Image = arrayBufferToBase64(imageBuffer);

    const anthropicKey = Deno.env.get("ANTHROPIC_API_KEY")!;
    const prompt = `You are helping identify a plant from a photo for a personal botanical collection database. Look at this image and identify the most likely species.

Respond ONLY with valid JSON, no other text, no markdown formatting, in this exact shape:
{"scientific_name": "Genus species", "common_name": "common name or null", "confidence": "high", "reasoning": "1-2 sentences on the identifying features you observed"}

confidence must be exactly one of: "high", "medium", "low". If you cannot identify it with real confidence, still give your best guess and set confidence to "low".`;

    const claudeResp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": anthropicKey,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-sonnet-5",
        max_tokens: 400,
        messages: [{
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: contentType, data: base64Image } },
            { type: "text", text: prompt },
          ],
        }],
      }),
    });

    const claudeData = await claudeResp.json();
    if (!claudeResp.ok) {
      return Response.json({ error: claudeData.error?.message || "Claude request failed" }, { status: 500 });
    }

    const rawText = claudeData.content?.[0]?.text || "";
    const cleaned = rawText.replace(/```json|```/g, "").trim();

    let parsed;
    try {
      parsed = JSON.parse(cleaned);
    } catch {
      return Response.json({ error: "Could not parse Claude's response", raw: rawText }, { status: 500 });
    }

    // Confidence is qualitative from Claude, not a computed score like
    // Pl@ntNet's — mapped to an approximate number just so the UI can
    // show a consistent badge. Not a precise probability.
    const confidenceMap = { high: 0.85, medium: 0.55, low: 0.25 };
    const confidence = confidenceMap[parsed.confidence] ?? null;

    const { data: idRow, error: idErr } = await ctx.supabase
      .from("identifications")
      .insert({
        photo_id,
        source: "Claude",
        suggested_name: parsed.scientific_name || "Unknown",
        confidence,
        raw_response: { ...parsed, model: "claude-sonnet-5" },
        status: "pending",
      })
      .select()
      .single();

    if (idErr) return Response.json({ error: idErr.message }, { status: 500 });

    return Response.json({ success: true, identification: idRow });
  }),
};