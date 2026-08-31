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

   **Nothing listens on that port.** By default the script prints the consent
   URL, the browser lands on a page that fails to load, and you paste the
   address bar back in — the code is in the query string. The URI still has to
   be registered because Google validates it before redirecting, but no server
   runs. `--serve` opts into a 10-second loopback listener that skips the paste.

   Localhost is the right target precisely *because* nothing is there: the
   browser cannot connect, so the authorisation code never crosses the network.
   Redirecting to a real website instead would leave a live code in that
   server's access logs.

2. **Put the credentials in a file, not the environment.**
   ```
   cp tools/env.template tools/.migration/env
   # fill it in — .migration/ is git-ignored
   ```
   The script loads that file itself. Keeping them out of `export` keeps them
   out of shell history, and out of any transcript.

3. **Authorise both sides.** Two browser consents, one per account.
   ```
   node tools/migrate-drive.mjs auth-old   # amandamarienash@gmail.com
   node tools/migrate-drive.mjs auth-new   # me@justamanda.net
   ```

4. **Find the old folder id**, if you do not have it to hand. `supabase secrets
   list` returns SHA-256 digests, not values, so `DRIVE_FOLDER_ID` cannot be
   read back — but it does not need to be. Under `drive.file` the old client
   sees only what it created, and the app created exactly one folder.
   ```
   node tools/migrate-drive.mjs find-folder
   ```
   Put the id in `.migration/env` as `OLD_FOLDER_ID`.

5. **Copy and verify.** Resumable — re-run it after a failure and it skips what
   is already mapped. Every file is checksum-verified on both sides before it
   is recorded.
   ```
   node tools/migrate-drive.mjs copy
   ```
   Nothing is written to Postgres. The app is unaffected throughout.

6. **Cutover** (the only step with downtime, a few minutes):
   ```
   supabase secrets set GOOGLE_OAUTH_CLIENT_ID=… GOOGLE_OAUTH_CLIENT_SECRET=… \
                        DRIVE_FOLDER_ID=<from .migration/new-folder-id.txt>
   ```
   Then in the app: Settings → reconnect Google Drive as the Workspace account.
   New uploads now land in the Workspace folder; historical photos are still
   pointing at the old ids and will not render yet. That is expected.

7. **Repoint the database.**
   ```
   node tools/migrate-drive.mjs sql     # writes .migration/remap.sql
   ```
   Paste it into the Supabase SQL editor. Photos come back.

## Rollback

Before step 7, rollback is: put the old secrets back and reconnect as the
personal account. After step 7, `.migration/migration-map.jsonl` holds both ids
for every row, so the update is reversible by swapping the columns in the
generated SQL.

**The originals are never touched.** The old folder stays as a backup until you
delete it by hand.

## .migration/ is git-ignored

It holds refresh tokens. Never commit it.
