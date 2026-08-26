import { withSupabase } from "npm:@supabase/server@^1";
import { getValidGoogleAccessToken, getSupabaseAdmin } from "../_shared/google-auth.ts";

export default {
  fetch: withSupabase({ auth: "user" }, async (req, ctx) => {
    const formData = await req.formData();
    const file = formData.get("photo") as File | null;
    const plantId = formData.get("plant_id") as string | null;
    const locationId = formData.get("location_id") as string | null;
    const notes = formData.get("notes") as string | null;
    // Capture date read from the JPEG's EXIF by the browser before upload.
    // This was being sent by the frontend and silently dropped here, so every
    // photo fell back to its upload date — 556 of them, 0 with a real date.
    const takenAt = formData.get("taken_at") as string | null;

    if (!file) {
      return Response.json({ error: "No photo provided" }, { status: 400 });
    }

    const supabaseAdmin = getSupabaseAdmin();

    let accessToken: string;
    try {
      accessToken = await getValidGoogleAccessToken(supabaseAdmin);
    } catch (err) {
      return Response.json({ error: String(err) }, { status: 401 });
    }

    const folderId = Deno.env.get("DRIVE_FOLDER_ID")!;
    const metadata = { name: `${Date.now()}-${file.name}`, parents: [folderId] };
    const boundary = "-------314159265358979323846";
    const fileBytes = new Uint8Array(await file.arrayBuffer());

    const multipartBody = new Blob([
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n`,
      `--${boundary}\r\nContent-Type: ${file.type}\r\n\r\n`,
      fileBytes,
      `\r\n--${boundary}--`,
    ]);

    const uploadResponse = await fetch(
      "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": `multipart/related; boundary=${boundary}`,
        },
        body: multipartBody,
      }
    );

    const uploadResult = await uploadResponse.json();
    if (!uploadResult.id) {
      return Response.json({ error: `Drive upload failed: ${JSON.stringify(uploadResult)}` }, { status: 500 });
    }

    const { data: photoRow, error: dbError } = await ctx.supabase
      .from("photos")
      .insert({
        plant_id: plantId || null,
        location_id: locationId || null,
        drive_file_id: uploadResult.id,
        notes: notes || null,
        taken_at: takenAt || null,
      })
      .select()
      .single();

    if (dbError) {
      return Response.json({ error: dbError.message }, { status: 500 });
    }

    return Response.json({ success: true, photo: photoRow });
  }),
};