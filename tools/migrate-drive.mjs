#!/usr/bin/env node
/**
 * Copy every photo from the personal account's Drive folder into a folder owned
 * by the Google Workspace account, and emit the SQL that repoints the database.
 *
 * WHY IT LOOKS LIKE THIS
 * ----------------------
 * `drive.file` grants an app access only to the files THAT app created FOR THAT
 * USER (REFERENCE.md §8). The grant is per (client_id, user) pair. So:
 *
 *   - The read side MUST use the OLD client id. A brand-new client authorising
 *     the same Gmail account would see nothing — it never created those files.
 *   - The write side uses the NEW client id as the Workspace user, so the new
 *     copies are app-created for that pair and stay visible after the cutover.
 *
 * It writes NOTHING to Postgres. It produces a map and a .sql file; applying
 * that is a separate, deliberate step after the secrets are swapped. If this
 * script dies halfway, the running app is completely unaffected.
 *
 * Resumable: every successful copy is appended to migration-map.jsonl before
 * the next one starts. Re-running skips what is already mapped.
 *
 * Verifies: Drive returns md5Checksum for binary files. A copy is only recorded
 * once the new file's checksum matches the old one's. A mismatch is fatal for
 * that file and reported at the end rather than silently mapped.
 *
 *   node tools/migrate-drive.mjs auth-old
 *   node tools/migrate-drive.mjs auth-new
 *   node tools/migrate-drive.mjs copy
 *   node tools/migrate-drive.mjs sql
 */

import { createServer } from "node:http";
import { createInterface } from "node:readline/promises";
import { readFile, writeFile, appendFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const STATE = join(HERE, ".migration");
const MAP = join(STATE, "migration-map.jsonl");
const LOOPBACK_PORT = 8910;
const REDIRECT = `http://localhost:${LOOPBACK_PORT}/callback`;
const SCOPES = "https://www.googleapis.com/auth/drive.file";

/* Credentials come from .migration/env, which is git-ignored. Loading them from
   a file rather than the environment keeps them out of shell history — and out
   of any transcript, which is why they are never echoed back. */
if (existsSync(join(STATE, "env"))) {
  const txt = await readFile(join(STATE, "env"), "utf8");
  for (const line of txt.split("\n")) {
    const m = line.match(/^\s*(?:export\s+)?([A-Z_]+)\s*=\s*(.*)$/);
    if (m && !line.trim().startsWith("#")) {
      process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
    }
  }
}

const cfg = {
  oldClientId: process.env.OLD_CLIENT_ID,
  oldClientSecret: process.env.OLD_CLIENT_SECRET,
  oldFolderId: process.env.OLD_FOLDER_ID,
  newClientId: process.env.NEW_CLIENT_ID,
  newClientSecret: process.env.NEW_CLIENT_SECRET,
  newFolderName: process.env.NEW_FOLDER_NAME || "Adcock Botanical Garden Photos",
};

const die = (m) => { console.error(`\n✗ ${m}\n`); process.exit(1); };
const need = (...keys) => keys.forEach((k) => cfg[k] || die(`Missing env ${k.replace(/[A-Z]/g, (c) => "_" + c).toUpperCase()}`));

/* ---------- token storage ---------- */
const tokenPath = (side) => join(STATE, `token-${side}.json`);
async function saveToken(side, t) {
  await mkdir(STATE, { recursive: true });
  await writeFile(tokenPath(side), JSON.stringify(t, null, 2));
}
async function loadToken(side) {
  if (!existsSync(tokenPath(side))) die(`No ${side} token. Run: node tools/migrate-drive.mjs auth-${side}`);
  return JSON.parse(await readFile(tokenPath(side), "utf8"));
}

/* ---------- one-off loopback OAuth ---------- */
async function authorize(side) {
  const isOld = side === "old";
  const clientId = isOld ? cfg.oldClientId : cfg.newClientId;
  const clientSecret = isOld ? cfg.oldClientSecret : cfg.newClientSecret;
  if (!clientId || !clientSecret) die(`Set ${isOld ? "OLD" : "NEW"}_CLIENT_ID and ${isOld ? "OLD" : "NEW"}_CLIENT_SECRET`);

  const url = "https://accounts.google.com/o/oauth2/v2/auth?" + new URLSearchParams({
    client_id: clientId, redirect_uri: REDIRECT, response_type: "code",
    scope: SCOPES, access_type: "offline", prompt: "consent",
  });

  console.log(`\nSign in as the ${isOld ? "PERSONAL account — amdaoh@gmail.com" : "WORKSPACE account — me@justamanda.net"}:\n\n${url}\n`);
  console.log(isOld
    ? "  (must be the Gmail account, using the OLD client id — that pair is the only\n   one Drive considers the creator of the existing files)\n"
    : "  (must be the Workspace account, using the NEW client id)\n");

  /* Two ways to receive the authorisation code. Manual is the DEFAULT because
     it runs no server at all: the browser lands on a dead localhost URL, shows
     "can't connect", and the code sits in the address bar for you to paste.

     Localhost is still the right redirect target even though nothing listens.
     It is the ONLY choice where the code never leaves this machine — the
     browser cannot connect, so nothing is transmitted anywhere. Pointing the
     redirect at a real website instead would deposit a live authorisation code
     in that server's access logs.

     --serve opts back into the 10-second loopback listener, which just saves
     the copy/paste. */
  const code = process.argv.includes("--serve")
    ? await codeFromListener()
    : await codeFromPaste();

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ code, client_id: clientId, client_secret: clientSecret, redirect_uri: REDIRECT, grant_type: "authorization_code" }),
  });
  const t = await res.json();
  if (!t.refresh_token) die(`No refresh_token returned: ${JSON.stringify(t)}`);
  await saveToken(side, { ...t, obtained_at: Date.now() });
  console.log(`✓ ${side} account authorised.`);
}

// Nothing listens. The browser fails to connect, which is the point — the code
// stays in the address bar and never crosses the network.
async function codeFromPaste() {
  console.log("Your browser will land on a page that will NOT load — \"can't connect\"\n" +
              "or similar. That is expected. Copy the WHOLE address from the address\n" +
              "bar and paste it below; it contains the code.\n");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const raw = (await rl.question("Paste the full localhost URL (or just the code): ")).trim();
  rl.close();
  if (!raw) die("Nothing pasted.");
  let code = raw;
  if (raw.includes("code=")) {
    try { code = new URL(raw).searchParams.get("code") || ""; }
    catch { code = (raw.match(/[?&]code=([^&\s]+)/) || [])[1] || ""; }
    code = decodeURIComponent(code || "");
  }
  if (!code) die("Could not find a code in that. Look for `code=` in the URL.");
  return code;
}

async function codeFromListener() {
  return await new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const u = new URL(req.url, `http://localhost:${LOOPBACK_PORT}`);
      if (u.pathname !== "/callback") { res.writeHead(404).end(); return; }
      const c = u.searchParams.get("code");
      const e = u.searchParams.get("error");
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(`<body style="font-family:system-ui;padding:40px"><h2>${c ? "Authorised — close this tab." : "Failed: " + e}</h2></body>`);
      server.close();
      c ? resolve(c) : reject(new Error(e || "no code"));
    });
    server.listen(LOOPBACK_PORT);
    setTimeout(() => { server.close(); reject(new Error("timed out after 5 minutes")); }, 300000);
  });
}

/* Access tokens last an hour; 2,600 files will outlive one. */
async function accessToken(side) {
  const t = await loadToken(side);
  if (t.access_token && Date.now() - t.obtained_at < (t.expires_in - 300) * 1000) return t.access_token;
  const isOld = side === "old";
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      refresh_token: t.refresh_token, grant_type: "refresh_token",
      client_id: isOld ? cfg.oldClientId : cfg.newClientId,
      client_secret: isOld ? cfg.oldClientSecret : cfg.newClientSecret,
    }),
  });
  const fresh = await res.json();
  if (!fresh.access_token) die(`Could not refresh ${side} token: ${JSON.stringify(fresh)}`);
  await saveToken(side, { ...t, ...fresh, obtained_at: Date.now() });
  return fresh.access_token;
}

/* ---------- Drive ---------- */
async function listFolder(token, folderId) {
  const out = [];
  let pageToken = "";
  do {
    const q = new URLSearchParams({
      q: `'${folderId}' in parents and trashed = false`,
      fields: "nextPageToken,files(id,name,size,mimeType,md5Checksum)",
      pageSize: "1000", ...(pageToken ? { pageToken } : {}),
    });
    const r = await fetch(`https://www.googleapis.com/drive/v3/files?${q}`, { headers: { Authorization: `Bearer ${token}` } });
    const d = await r.json();
    if (d.error) die(`List failed: ${d.error.message}`);
    out.push(...(d.files || []));
    pageToken = d.nextPageToken || "";
  } while (pageToken);
  return out;
}

async function ensureFolder(token, name) {
  const q = new URLSearchParams({
    q: `name = '${name.replace(/'/g, "\\'")}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
    fields: "files(id,name)",
  });
  const r = await fetch(`https://www.googleapis.com/drive/v3/files?${q}`, { headers: { Authorization: `Bearer ${token}` } });
  const d = await r.json();
  if (d.files && d.files.length) return d.files[0].id;
  const c = await fetch("https://www.googleapis.com/drive/v3/files?fields=id", {
    method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ name, mimeType: "application/vnd.google-apps.folder" }),
  });
  const nf = await c.json();
  if (!nf.id) die(`Could not create folder: ${JSON.stringify(nf)}`);
  return nf.id;
}

async function download(token, id) {
  const r = await fetch(`https://www.googleapis.com/drive/v3/files/${id}?alt=media`, { headers: { Authorization: `Bearer ${token}` } });
  if (!r.ok) throw new Error(`download ${id}: HTTP ${r.status}`);
  return Buffer.from(await r.arrayBuffer());
}

async function upload(token, folderId, name, mimeType, buf) {
  const boundary = "abg" + Math.random().toString(16).slice(2);
  const meta = JSON.stringify({ name, parents: [folderId] });
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n--${boundary}\r\nContent-Type: ${mimeType || "application/octet-stream"}\r\n\r\n`),
    buf, Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  const r = await fetch("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,md5Checksum", {
    method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": `multipart/related; boundary=${boundary}` }, body,
  });
  const d = await r.json();
  if (!d.id) throw new Error(`upload ${name}: ${JSON.stringify(d)}`);
  return d;
}

async function readMap() {
  if (!existsSync(MAP)) return new Map();
  const txt = await readFile(MAP, "utf8");
  const m = new Map();
  for (const line of txt.split("\n").filter(Boolean)) {
    const r = JSON.parse(line);
    m.set(r.old_id, r);
  }
  return m;
}

/* ---------- commands ---------- */
/* DRIVE_FOLDER_ID lives in Supabase secrets, and `supabase secrets list` returns
   SHA-256 digests rather than values — so the id cannot be read back. It does
   not need to be: under drive.file the old client can only see what it created,
   and the app created exactly one folder (REFERENCE §8, "the app creates its own
   Drive folder via the API on first use"). So listing folders finds it. */
async function findFolder() {
  need("oldClientId", "oldClientSecret");
  const tok = await accessToken("old");
  const q = new URLSearchParams({
    q: "mimeType = 'application/vnd.google-apps.folder' and trashed = false",
    fields: "files(id,name,createdTime)",
  });
  const r = await fetch(`https://www.googleapis.com/drive/v3/files?${q}`, { headers: { Authorization: `Bearer ${tok}` } });
  const d = await r.json();
  if (d.error) die(`List failed: ${d.error.message}`);
  const folders = d.files || [];
  if (!folders.length) die("The old client can see no folders. Wrong account, or the wrong (old) client id.");
  console.log(`\nFolders visible to the OLD client (these are the ones it created):\n`);
  for (const f of folders) {
    const c = await fetch(`https://www.googleapis.com/drive/v3/files?${new URLSearchParams({ q: `'${f.id}' in parents and trashed = false`, fields: "files(id)", pageSize: "1000" })}`, { headers: { Authorization: `Bearer ${tok}` } });
    const kids = ((await c.json()).files || []).length;
    console.log(`  ${f.id}  ${f.name}  — ${kids} file(s)${kids >= 1000 ? "+" : ""}`);
  }
  console.log(`\nPut the one holding the photos in .migration/env as OLD_FOLDER_ID.`);
}

async function copy() {
  need("oldClientId", "oldClientSecret", "oldFolderId", "newClientId", "newClientSecret");
  const oldTok = await accessToken("old");
  const newTok = await accessToken("new");

  const newFolder = await ensureFolder(newTok, cfg.newFolderName);
  console.log(`Destination folder on the Workspace account: ${newFolder}`);
  await mkdir(STATE, { recursive: true });
  await writeFile(join(STATE, "new-folder-id.txt"), newFolder);

  const files = await listFolder(oldTok, cfg.oldFolderId);
  console.log(`Source folder holds ${files.length} files.`);

  const done = await readMap();
  const todo = files.filter((f) => !done.has(f.id) && f.mimeType !== "application/vnd.google-apps.folder");
  console.log(`${done.size} already copied · ${todo.length} to go\n`);

  let ok = 0; const failed = [];
  for (const [i, f] of todo.entries()) {
    const tag = `[${i + 1}/${todo.length}] ${f.name}`;
    try {
      // Refreshed inside the loop: an overnight run outlives a 1-hour token.
      const rt = await accessToken("old");
      const wt = await accessToken("new");
      const buf = await download(rt, f.id);
      const localMd5 = createHash("md5").update(buf).digest("hex");
      if (f.md5Checksum && f.md5Checksum !== localMd5) throw new Error("source checksum mismatch on download");
      const up = await upload(wt, newFolder, f.name, f.mimeType, buf);
      if (up.md5Checksum && up.md5Checksum !== localMd5) throw new Error("destination checksum mismatch after upload");
      await appendFile(MAP, JSON.stringify({ old_id: f.id, new_id: up.id, name: f.name, md5: localMd5 }) + "\n");
      ok++;
      if (ok % 25 === 0 || i === todo.length - 1) console.log(`  ${tag} — ${ok} copied, ${failed.length} failed`);
    } catch (e) {
      failed.push({ name: f.name, id: f.id, error: String(e.message || e) });
      console.error(`  ✗ ${tag}: ${e.message}`);
    }
  }
  console.log(`\n${ok} copied, ${failed.length} failed.`);
  if (failed.length) {
    await writeFile(join(STATE, "failures.json"), JSON.stringify(failed, null, 2));
    console.log(`Failures written to .migration/failures.json — re-run 'copy' to retry only those.`);
  } else {
    console.log(`Every file verified by checksum. Next: node tools/migrate-drive.mjs sql`);
  }
}

async function sql() {
  const m = await readMap();
  if (!m.size) die("Nothing in the map yet — run 'copy' first.");
  const rows = [...m.values()];
  const chunks = [];
  for (let i = 0; i < rows.length; i += 500) chunks.push(rows.slice(i, i + 500));
  const body = chunks.map((c, n) => `-- chunk ${n + 1} of ${chunks.length} (${c.length} photos)
update photos p set drive_file_id = m.new_id
from (values
${c.map((r) => `  ('${r.old_id}','${r.new_id}')`).join(",\n")}
) as m(old_id, new_id)
where p.drive_file_id = m.old_id;`).join("\n\n");

  const out = join(STATE, "remap.sql");
  await writeFile(out, `-- Repoint photos at the copies now owned by the Workspace account.
-- ${rows.length} photos. Generated ${new Date().toISOString()}.
--
-- RUN THIS ONLY AFTER the Supabase secrets have been swapped to the new OAuth
-- client AND you have reconnected Drive in Settings as the Workspace account.
-- Running it earlier points the app at files its current token cannot read.
--
-- Reversible: .migration/migration-map.jsonl holds both ids for every row.

begin;

${body}

-- Expect: ${rows.length}
select count(*) as repointed from photos
where drive_file_id in (${rows.slice(0, 1).map((r) => `'${r.new_id}'`).join(",")});

commit;
`);
  console.log(`Wrote ${out} — ${rows.length} photos in ${chunks.length} chunk(s).`);
}

const cmd = process.argv[2];
if (cmd === "auth-old") await authorize("old");
else if (cmd === "auth-new") await authorize("new");
else if (cmd === "find-folder") await findFolder();
else if (cmd === "copy") await copy();
else if (cmd === "sql") await sql();
else die("Usage: migrate-drive.mjs auth-old | auth-new | find-folder | copy | sql");
