import { withSupabase } from "npm:@supabase/server@^1";

export default {
  fetch: withSupabase({ auth: "user" }, async (req, ctx) => {
    const clientId = Deno.env.get("GOOGLE_OAUTH_CLIENT_ID")!;
    const redirectUri = "https://fsckwgicmvviefuivgza.supabase.co/functions/v1/drive-oauth-callback";

    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: "code",
      // drive.file  — per-file access to files this app creates. Never the
      //               user's wider Drive; see REFERENCE.md section 8.
      // photospicker — read the media items the user explicitly picks in the
      //               Google Photos picker. Bulk library access was removed on
      //               2025-03-31, so this is the only route in (PHOTOS-1).
      scope: [
        "https://www.googleapis.com/auth/drive.file",
        "https://www.googleapis.com/auth/photospicker.mediaitems.readonly",
      ].join(" "),
      access_type: "offline",  // required to receive a refresh_token
      prompt: "consent",       // forces Google to issue a fresh refresh_token every time
    });

    const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;

    return Response.json({ url: authUrl });
  }),
};