import { withSupabase } from "npm:@supabase/server@^1";

export default {
  fetch: withSupabase({ auth: "user" }, async (req, ctx) => {
    const clientId = Deno.env.get("GOOGLE_OAUTH_CLIENT_ID")!;
    const redirectUri = "https://fsckwgicmvviefuivgza.supabase.co/functions/v1/drive-oauth-callback";

    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: "code",
      scope: "https://www.googleapis.com/auth/drive.file",
      access_type: "offline",  // required to receive a refresh_token
      prompt: "consent",       // forces Google to issue a fresh refresh_token every time
    });

    const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;

    return Response.json({ url: authUrl });
  }),
};