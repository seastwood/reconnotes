# Backups and offsite copies

The server backs up every note once a day (set by `RECON_BACKUP_INTERVAL_HOURS`) and keeps the last 14 (`RECON_BACKUP_KEEP`). Each backup is a copy of the database plus every note as a plain Markdown file, in `/var/lib/reconnotes/backups`.

## Restoring

**Settings › Backups** lists the backups and what changed since each. Restore a single note or the whole library; each note's current state goes into its version history first, so a restore can be undone. **Back up now** makes one on demand, as does `node dist/index.js backup` on the server.

## An offsite copy

One disk can fail, so send each backup somewhere else too: **Settings › Backups › Offsite copy**.

| Destination | Setup |
| --- | --- |
| Another disk | A NAS share or USB drive mounted on the server, e.g. `/mnt/nas/reconnotes`; the server must be able to write there. |
| Cloud (S3) | Backblaze B2, Wasabi, Cloudflare R2, MinIO or AWS S3: endpoint, bucket and a key that can only write to that bucket. |

1. Fill in the destination and press **Test**.
2. For the cloud, set an **encryption passphrase** and keep it somewhere safe: without it the copy can't be opened.
3. Press **Save**, then **Copy the latest backup now**.

Attachments are sent once, and the last copies are kept (14 by default). To open an encrypted copy:

```bash
RECON_BACKUP_PASSPHRASE='your passphrase' node /opt/reconnotes/apps/server/dist/index.js decrypt <folder>
```

## Taking everything with you

**Settings › Export & import** downloads every note as Markdown in its folders, with pictures, files and drawings, in one zip.
