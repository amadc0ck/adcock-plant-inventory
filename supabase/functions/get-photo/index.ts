import { withSupabase } from "npm:@supabase/server@^1";
import { getValidGoogleAccessToken, getSupabaseAdmin } from "../_shared/google-auth.ts";

export default {
  fetch: withSupabase({ auth: "user" }, async (req) => {
    const url = new URL(req.url);
    const driveFileId = url.searchParams.get("id");

    if (!driveFileId) {
      return Response.json({ error: "Missing id parameter" }, { status: 400 });
    }

    const supabaseAdmin = getSupabaseAdmin();

    let accessToken: string;
    try {
      accessToken = await getValidGoogleAccessToken(supabaseAdmin);
    } catch (err) {
      return Response.json({ error: String(err) }, { status: 401 });
    }

    const driveResponse = await fetch(
      `https://www.googleapis.com/drive/v3/files/${driveFileId}?alt=media`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );

    if (!driveResponse.ok) {
      return Response.json({ error: "Could not fetch image from Drive" }, { status: driveResponse.status });
    }

    const contentType = driveResponse.headers.get("Content-Type") || "image/jpeg";
    return new Response(driveResponse.body, {
      headers: { "Content-Type": contentType, "Cache-Control": "private, max-age=3600" },
    });
  }),
};