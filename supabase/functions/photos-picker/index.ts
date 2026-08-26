// PHOTOS-1 — import from Google Photos via the Picker API.
//
// Bulk library access (photoslibrary.readonly) was removed on 2025-03-31; apps
// can now only reach media they created themselves. The Picker API is the
// replacement: the user selects items in Google Photos' own UI and the app is
// granted access to exactly those. Same restriction that shaped the Drive
// integration — see REFERENCE.md section 8.
//
// One function, three actions, because they share auth and are meaningless
// apart:
//   POST ?action=create           -> { sessionId, pickerUri, pollIntervalMs }
//   POST ?action=poll  {sessionId}-> { mediaItemsSet, items? }
//   POST ?action=import{sessionId, mediaItemId, filename, createTime}
//                                 -> { photo }
import { withSupabase } from "npm:@supabase/server@^1";
import { getValidGoogleAccessToken, getSupabaseAdmin } from "../_shared/google-auth.ts";

const PICKER = "https://photospicker.googleapis.com/v1";

// A picked item's baseUrl needs a suffix or it returns nothing useful.
// `=d` gives the original bytes, which for an iPhone library means HEIC —
// unreadable in most browsers and in the rest of this app. `=w-h` returns a
// scaled JPEG instead. Capture time comes from the API's createTime, so
// nothing depends on the EXIF the rendition drops.
const RENDITION = "=w2560-h2560";

export default {
  fetch: withSupabase({ auth: "user" }, async (req, ctx) => {
    const action = new URL(req.url).searchParams.get("action");
    const supabaseAdmin = getSupabaseAdmin();

    let accessToken: string;
    try {
      accessToken = await getValidGoogleAccessToken(supabaseAdmin);
    } catch (err) {
      return Response.json({ error: String(err) }, { status: 401 });
    }
    const auth = { Authorization: `Bearer ${accessToken}` };

    if (action === "create") {
      const res = await fetch(`${PICKER}/sessions`, { method: "POST", headers: auth });
      const data = await res.json();
      if (!res.ok || !data.id) {
        // A 403 here almost always means the token predates the Photos scope
        // being added, so the frontend tells the user to reconnect.
        return Response.json(
          { error: data.error?.message || "Could not start a Google Photos session", needsReconnect: res.status === 403 },
          { status: res.status === 403 ? 403 : 500 },
        );
      }
      return Response.json({
        sessionId: data.id,
        pickerUri: data.pickerUri,
        pollIntervalMs: parseInterval(data.pollingConfig?.pollInterval) ?? 3000,
        expireTime: data.expireTime ?? null,
      });
    }

    if (action === "poll") {
      const { sessionId } = await req.json();
      if (!sessionId) return Response.json({ error: "sessionId required" }, { status: 400 });

      const res = await fetch(`${PICKER}/sessions/${encodeURIComponent(sessionId)}`, { headers: auth });
      const data = await res.json();
      if (!res.ok) return Response.json({ error: data.error?.message || "Session lookup failed" }, { status: res.status });
      if (!data.mediaItemsSet) {
        return Response.json({ mediaItemsSet: false, pollIntervalMs: parseInterval(data.pollingConfig?.pollInterval) ?? 3000 });
      }

      // Selection is complete. Page through everything picked.
      const items: unknown[] = [];
      // Anything not imported is counted and reported. Dropping items silently
      // meant a selection of 2000 could import 1957 with no explanation.
      const skipped = { videos: 0, unavailable: 0 };
      let pageToken: string | undefined;
      do {
        const q = new URLSearchParams({ sessionId, pageSize: "100" });
        if (pageToken) q.set("pageToken", pageToken);
        const listRes = await fetch(`${PICKER}/mediaItems?${q}`, { headers: auth });
        const listData = await listRes.json();
        if (!listRes.ok) return Response.json({ error: listData.error?.message || "Could not list picked items" }, { status: listRes.status });
        for (const it of listData.mediaItems ?? []) {
          // Videos are out of scope: the app stores and renders stills only.
          if (it.type && it.type !== "PHOTO") { skipped.videos++; continue; }
          // No baseUrl means there is nothing to download; importing it would
          // fail one item at a time rather than being reported up front.
          if (!it.mediaFile?.baseUrl) { skipped.unavailable++; continue; }
          items.push({
            id: it.id,
            createTime: it.createTime ?? null,
            filename: it.mediaFile?.filename ?? "photo.jpg",
            mimeType: it.mediaFile?.mimeType ?? null,
            baseUrl: it.mediaFile?.baseUrl ?? null,
          });
        }
        pageToken = listData.nextPageToken;
      } while (pageToken);

      return Response.json({ mediaItemsSet: true, items, skipped, selected: items.length + skipped.videos + skipped.unavailable });
    }

    if (action === "import") {
      const { baseUrl, filename, createTime, locationId, plantId, mediaItemId } = await req.json();
      if (!baseUrl) return Response.json({ error: "baseUrl required" }, { status: 400 });

      // baseUrls stay valid for 60 minutes; past that this 4xx's and the user
      // has to pick again. Surfaced explicitly rather than as a generic failure.
      const mediaRes = await fetch(`${baseUrl}${RENDITION}`, { headers: auth });
      if (!mediaRes.ok) {
        return Response.json(
          { error: "Could not download from Google Photos. Picker links expire after an hour — reselect the photos.", expired: true },
          { status: 410 },
        );
      }
      const bytes = new Uint8Array(await mediaRes.arrayBuffer());

      const folderId = Deno.env.get("DRIVE_FOLDER_ID")!;
      const safeName = String(filename || "photo.jpg").replace(/[^\w.\-]+/g, "_");
      const metadata = { name: `${Date.now()}-${safeName}`, parents: [folderId] };
      const boundary = "-------314159265358979323846";
      const multipartBody = new Blob([
        `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n`,
        `--${boundary}\r\nContent-Type: image/jpeg\r\n\r\n`,
        bytes,
        `\r\n--${boundary}--`,
      ]);

      const uploadResponse = await fetch(
        "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id",
        { method: "POST", headers: { ...auth, "Content-Type": `multipart/related; boundary=${boundary}` }, body: multipartBody },
      );
      const uploadResult = await uploadResponse.json();
      if (!uploadResult.id) {
        return Response.json({ error: `Drive upload failed: ${JSON.stringify(uploadResult)}` }, { status: 500 });
      }

      const { data: photoRow, error: dbError } = await ctx.supabase
        .from("photos")
        .insert({
          drive_file_id: uploadResult.id,
          // Straight from the API — the time the photo was taken, not uploaded.
          // No EXIF parsing, which is why HEIC originals are not a problem here.
          taken_at: createTime || null,
          location_id: locationId || null,
          plant_id: plantId || null,
          // Picker media item ids are stable across sessions, so recording one
          // lets a later import skip anything already brought in. A partial
          // unique index backstops it if two runs race.
          google_photos_id: mediaItemId || null,
        })
        .select()
        .single();

      if (dbError) {
        // 23505 = unique violation on google_photos_id: this exact media item is
        // already in the collection. Not a failure, just nothing to do.
        if (dbError.code === "23505") return Response.json({ success: true, duplicate: true });
        return Response.json({ error: dbError.message }, { status: 500 });
      }
      return Response.json({ success: true, photo: photoRow });
    }

    return Response.json({ error: "Unknown action" }, { status: 400 });
  }),
};

// Google returns durations as a string of seconds with an "s" suffix, e.g. "3s".
function parseInterval(v: unknown): number | null {
  if (typeof v !== "string") return null;
  const n = parseFloat(v.replace(/s$/, ""));
  return Number.isFinite(n) ? Math.max(1000, n * 1000) : null;
}
