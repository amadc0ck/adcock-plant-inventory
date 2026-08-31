# Drive migration to Google Workspace

One-off tooling for moving Drive storage from the personal Google account to
`@justamanda.net`. Read `migrate-drive.mjs`'s header before running anything.

## The constraint that shapes all of this

`drive.file` grants an app access only to files **that app created for that
user** — the grant is per `(client_id, user)` pair (REFERENCE.md §8). So the
photos cannot simply change hands:

- Sharing the old folder with the Workspace account does **not** work.
- Transferring ownership does **not** restore app access.
- The read side of the copy **must** use the OLD client id, because that pair
  is the only one Google considers to have created those files.

Consequence: **the account swap and the file copy cannot be separated.** Swap
the secrets first and every historical photo 404s through `get-photo`.

## Order of operations

Do not reorder these. Steps 1–3 change nothing that the live app depends on.

1. **Console work** (see the checklist in BACKLOG) — new project in the
   `justamanda.net` Cloud Organization, Drive + Photos Picker APIs enabled,
   consent screen Internal, published, OAuth client created with redirect
   `https://fsckwgicmvviefuivgza.supabase.co/functions/v1/drive-oauth-callback`.
   Also add `http://localhost:8910/callback` to **both** the old and the new
   client, so this script can authorise. Remove it afterwards.

2. **Authorise both sides.** Two browser consents, one per account.
   ```
   export OLD_CLIENT_ID=… OLD_CLIENT_SECRET=… OLD_FOLDER_ID=…
   export NEW_CLIENT_ID=… NEW_CLIENT_SECRET=…
   node tools/migrate-drive.mjs auth-old   # amandamarienash@gmail.com
   node tools/migrate-drive.mjs auth-new   # amanda@justamanda.net
   ```

3. **Copy and verify.** Resumable — re-run it after a failure and it skips what
   is already mapped. Every file is checksum-verified on both sides before it
   is recorded.
   ```
   node tools/migrate-drive.mjs copy
   ```
   Nothing is written to Postgres. The app is unaffected throughout.

4. **Cutover** (the only step with downtime, a few minutes):
   ```
   supabase secrets set GOOGLE_OAUTH_CLIENT_ID=… GOOGLE_OAUTH_CLIENT_SECRET=… \
                        DRIVE_FOLDER_ID=<from .migration/new-folder-id.txt>
   ```
   Then in the app: Settings → reconnect Google Drive as the Workspace account.
   New uploads now land in the Workspace folder; historical photos are still
   pointing at the old ids and will not render yet. That is expected.

5. **Repoint the database.**
   ```
   node tools/migrate-drive.mjs sql     # writes .migration/remap.sql
   ```
   Paste it into the Supabase SQL editor. Photos come back.

## Rollback

Before step 5, rollback is: put the old secrets back and reconnect as the
personal account. After step 5, `.migration/migration-map.jsonl` holds both ids
for every row, so the update is reversible by swapping the columns in the
generated SQL.

**The originals are never touched.** The old folder stays as a backup until you
delete it by hand.

## .migration/ is git-ignored

It holds refresh tokens. Never commit it.
