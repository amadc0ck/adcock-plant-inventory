import { createClient } from "npm:@supabase/supabase-js@2";

// Note: this function is NOT wrapped in withSupabase, because Google redirects
// the browser here directly — there's no user JWT attached to that redirect.
// We use the SUPABASE_SECRET_KEYS (admin) client instead, scoped narrowly to
// just this one operation: saving the tokens we just received from Google.

export default {
  fetch: async (req: Request) => {
    const url = new URL(req.url);
    const code = url.searchParams.get("code");
    const error = url.searchParams.get("error");

    if (error) {
      return new Response(`Google sign-in was cancelled or failed: ${error}`, { status: 400 });
    }
    if (!code) {
      return new Response("Missing authorization code", { status: 400 });
    }

    const clientId = Deno.env.get("GOOGLE_OAUTH_CLIENT_ID")!;
    const clientSecret = Deno.env.get("GOOGLE_OAUTH_CLIENT_SECRET")!;
    const redirectUri = "https://fsckwgicmvviefuivgza.supabase.co/functions/v1/drive-oauth-callback";

    // Exchange the authorization code for real tokens
    const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
        grant_type: "authorization_code",
      }),
    });

    const tokenData = await tokenResponse.json();

    if (!tokenData.access_token) {
      return new Response(`Token exchange failed: ${JSON.stringify(tokenData)}`, { status: 500 });
    }
    if (!tokenData.refresh_token) {
      // This happens if Google decided not to issue a fresh refresh_token.
      // Usually fixed by revoking the app's access in your Google Account
      // permissions page, then trying the connect flow again.
      return new Response(
        "No refresh token received. Please revoke this app's access at https://myaccount.google.com/permissions and try connecting again.",
        { status: 500 }
      );
    }

    const expiresAt = new Date(Date.now() + tokenData.expires_in * 1000).toISOString();

    // Admin client — bypasses RLS, needed here since there's no user session on this request
    const SUPABASE_SECRET_KEYS = JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS")!);
    const supabaseAdmin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      SUPABASE_SECRET_KEYS["default"]
    );

    // Clear any old token row, then insert the fresh one (single-row table)
    await supabaseAdmin.from("google_auth_tokens").delete().neq("id", "00000000-0000-0000-0000-000000000000");

    const { error: dbError } = await supabaseAdmin.from("google_auth_tokens").insert({
      access_token: tokenData.access_token,
      refresh_token: tokenData.refresh_token,
      expires_at: expiresAt,
    });

    if (dbError) {
      return new Response(`Failed to save tokens: ${JSON.stringify(dbError)}`, { status: 500 });
    }

    // Redirect back into the app.
    // #drive-connected is picked up by the frontend on load to land on
    // Settings and show a confirmation toast.
    return new Response(null, {
      status: 302,
      headers: {
        Location: "https://amadc0ck.github.io/adcock-plant-inventory-app/#drive-connected",
      },
    });
  },
};