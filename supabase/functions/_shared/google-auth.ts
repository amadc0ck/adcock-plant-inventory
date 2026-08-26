import { createClient } from "npm:@supabase/supabase-js@2";

// Shared by upload-photo and get-photo — reads the stored Google
// token, refreshing it first if it's expired or close to it.
export async function getValidGoogleAccessToken(
  supabaseAdmin: ReturnType<typeof createClient>
): Promise<string> {
  const { data: tokenRow, error } = await supabaseAdmin
    .from("google_auth_tokens")
    .select("*")
    .single();

  if (error || !tokenRow) {
    throw new Error("No Google Drive connection found. Please connect Google Drive first.");
  }

  const expiresAt = new Date(tokenRow.expires_at).getTime();
  const now = Date.now();
  const bufferMs = 5 * 60 * 1000;

  if (expiresAt - now > bufferMs) {
    return tokenRow.access_token;
  }

  const clientId = Deno.env.get("GOOGLE_OAUTH_CLIENT_ID")!;
  const clientSecret = Deno.env.get("GOOGLE_OAUTH_CLIENT_SECRET")!;

  const refreshResponse = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: tokenRow.refresh_token,
      grant_type: "refresh_token",
    }),
  });

  const refreshData = await refreshResponse.json();

  if (!refreshData.access_token) {
    throw new Error(
      `Google Drive connection expired. Please reconnect. (${JSON.stringify(refreshData)})`
    );
  }

  const newExpiresAt = new Date(Date.now() + refreshData.expires_in * 1000).toISOString();

  await supabaseAdmin
    .from("google_auth_tokens")
    .update({
      access_token: refreshData.access_token,
      expires_at: newExpiresAt,
      updated_at: new Date().toISOString(),
    })
    .eq("id", tokenRow.id);

  return refreshData.access_token;
}

export function getSupabaseAdmin() {
  const SUPABASE_SECRET_KEYS = JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS")!);
  return createClient(Deno.env.get("SUPABASE_URL")!, SUPABASE_SECRET_KEYS["default"]);
}