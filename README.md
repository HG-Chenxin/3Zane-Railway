# 3Zane Railway services

This private repository contains only the Railway downloader and Spoofer worker source. The website stays in the separate `zaneru-id/3Zane-my-id` repository and deploys to the VPS. PostgreSQL and the S3-compatible Bucket are Railway services, not source files; never commit connection strings, API keys, bucket credentials, cookies, or database dumps.

## Services

Create both services from this repository in one Railway project and environment:

1. **Downloader**: repository root build context, `Dockerfile.downloader` Dockerfile, private networking only, port `8789`, no public domain.
2. **Spoofer worker**: repository root build context, `spoofer-worker/Dockerfile` Dockerfile, public HTTPS domain enabled, port `8790`.

Set `APP_PASSWORD` on the downloader. It must match the worker's `ROBLOX_DOWNLOAD_API_KEY`.

Set these variables on the worker:

```env
PORT=8790
SPOOFER_WORKER_API_KEY=<long-random-secret-shared-only-with-the-VPS>
ROBLOX_DOWNLOAD_API_KEY=<same-secret-as-downloader-APP_PASSWORD>
NEARSX_DOWNLOADER_URL=http://<downloader-private-hostname>:8789
DATABASE_URL=<PostgreSQL-URL-for-this-Railway-environment>
RAILWAY_BUCKET_ENDPOINT=<private-bucket-S3-endpoint>
RAILWAY_BUCKET_NAME=<bucket-name>
RAILWAY_BUCKET_ACCESS_KEY_ID=<bucket-access-key>
RAILWAY_BUCKET_SECRET_ACCESS_KEY=<bucket-secret>
RAILWAY_BUCKET_REGION=auto
```

Use Railway's private Postgres URL for the worker where available. The VPS is outside Railway's private network and must use the database's public connection URL. Keep all values in service variables or the VPS's `/opt/3zane-app/.env`; never put them in GitHub source or frontend variables.

The website VPS must have these settings:

```env
DATABASE_URL=<public-PostgreSQL-URL-for-this-Railway-environment>
RAILWAY_BUCKET_ENDPOINT=<private-bucket-S3-endpoint>
RAILWAY_BUCKET_NAME=<bucket-name>
RAILWAY_BUCKET_ACCESS_KEY_ID=<bucket-access-key>
RAILWAY_BUCKET_SECRET_ACCESS_KEY=<bucket-secret>
RAILWAY_BUCKET_REGION=auto
SPOOFER_WORKER_URL=https://<worker-public-domain>
SPOOFER_WORKER_API_KEY=<same-value-as-worker-SPOOFER_WORKER_API_KEY>
ROBLOX_DOWNLOAD_API_KEY=<same-value-as-worker-ROBLOX_DOWNLOAD_API_KEY>
NEARSX_DOWNLOADER_URL=https://<worker-public-domain>
```

`NEARSX_DOWNLOADER_URL` on the VPS intentionally points to the public worker proxy. Only the worker points to the downloader's private address.

## Local checks

From this repository root:

```bash
npm ci --prefix spoofer-worker
node --check spoofer-worker/server.js
node --test spoofer-worker
node --test roblox-downloader/lib/bounded-queue.test.mjs roblox-downloader/lib/roblox.test.mjs
```

## Moving data from an expired Railway account

Do not delete the old project, Postgres service, volume, or Bucket. The previous Railway project showed its trial expired and services offline. First restore access to the old project/database (for example, resolve billing or ask Railway support about restoring access and data export). If Railway no longer permits database access, the old database cannot be migrated with `pg_dump` until access is restored.

1. Create the new Postgres and private Bucket in the new Railway account. Do not switch the VPS to the new empty database yet.
2. Once the old Postgres accepts connections, obtain its authorized connection URL from Railway. From a trusted local terminal with PostgreSQL client tools installed, enter the old and new URLs without saving them in shell history:

   ```bash
   mkdir -p "$HOME/3zane-backups"
   cd "$HOME/3zane-backups"
   read -rsp 'Old PostgreSQL URL: ' OLD_DATABASE_URL; echo
   read -rsp 'New PostgreSQL URL: ' NEW_DATABASE_URL; echo
   pg_dump --format=custom --no-owner --no-acl --file=3zane-postgres.dump "$OLD_DATABASE_URL"
   pg_restore --no-owner --no-acl --exit-on-error --dbname="$NEW_DATABASE_URL" 3zane-postgres.dump
   unset OLD_DATABASE_URL NEW_DATABASE_URL
   ```

   Keep the dump private and outside both repositories. Do not restore over a database containing data you need; this procedure expects a new, empty destination database. Verify the restore before cutover.
3. Copy existing Bucket objects from the old account to the new private Bucket with an S3-compatible transfer tool such as `rclone`, configured locally with separate old/new endpoints and credentials. Do not paste credentials into chat, commit them, or make the bucket public. Verify object counts and sizes before switching the app.
4. Deploy the downloader and worker from this repository. Set their private/public networking and variables above. Confirm the worker `/health` response reports `status: "ok"`, `apiVersion: 3`, and all supported tiers, and test an authorized end-to-end Spoofer request.
5. Update the VPS `/opt/3zane-app/.env` with the **new** public Postgres URL, Bucket credentials, worker public URL, and matching API keys. Keep a protected copy of the old values until verification; do not print or share the `.env`. Redeploy/restart the VPS app and verify login, existing account/history data, file downloads, and Spoofer status.
6. Keep the old Railway project and data intact until the new deployment and restored data have been verified. Only then decide whether to cancel/delete the old services.

If the old database cannot be reactivated and there is no existing backup, stop before cutover and ask Railway support about data retention/recovery. Starting with an empty database would lose account, entitlement, history, and job records.
