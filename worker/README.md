# Vybecord cover store

A content-addressed image cache on Cloudflare Workers + R2. It exists so Discord
can show artwork for music that is in no catalogue — local rips, demos, DJ sets —
whose cover art lives only inside the listener's own file.

Everything that was ever released is resolved without this, by looking the album
up on a music CDN (`src/core/cover-art.ts`). Only the remainder reaches here.

## Why not a free file host

The app used to upload to litterbox.catbox.moe, and it failed twice over:

- **Discord would not display it.** Discord accepts the presence, then its image
  proxy refuses to fetch from those hosts, so the profile shows a "?" while the
  URL opens fine in a browser.
- **Antivirus blocked the request.** Anonymous file hosts carry everyone's
  uploads, malware included, so they sit on malware blocklists —
  `litterbox.catbox.moe` is listed by IPFire among others. The block happens in
  the AV's web protection, before the request leaves the machine.

Neither problem was about uploading. Both were about *where*. A first-party
endpoint on a domain we own has neither, and costs nothing at this volume.

## Why it cannot become one of those hosts

That last point only holds while this endpoint is not itself a general-purpose
file drop. Four things keep it from becoming one, and none is optional:

- The key is the SHA-256 of the content, **recomputed server-side**. A caller
  cannot choose a filename, an extension, or a path.
- The content type is decided from the magic bytes, never from the request, and
  pinned with `nosniff`. Only JPEG and PNG can be stored.
- 512 KB cap, checked against `Content-Length` before the body is read.
- Writes are rate limited per IP.

The client strips EXIF, XMP and comment blocks before hashing, so camera and GPS
tags never reach the store. See `src/core/art-upload.ts`.

## Deploy

```bash
cd worker && npm install && npx wrangler login
```

```bash
npx wrangler r2 bucket create vybecord-art
```

```bash
npx wrangler deploy
```

### Attach a domain

Do not serve from `*.workers.dev`. Shared Cloudflare subdomains are heavily used
for phishing and appear on DNS filter lists, which puts the app straight back
into the problem this replaced. Add the zone to the same Cloudflare account,
uncomment the `[[routes]]` block in `wrangler.toml`, and redeploy.

### Point the app at it

In `src/core/config.ts`, set `art_upload_url` to the deployed origin (no
trailing slash — one is tolerated but not needed):

```
art_upload_url: 'https://art.vybecord.app',
```

`art_upload_enabled` stays `false`. The feature is offered in Settings → Cover
images rather than assumed: the store is shared and public, and what gets
published is artwork off the user's own disk.

If you flip that default to `true`, update `website/privacy/` first — at that
point the app publishes user files by default and the policy has to say so.

## Costs

On the free tiers, and this is not close to them:

| | Free allowance | What a cover costs |
|---|---|---|
| R2 storage | 10 GB | ~70 KB, once per distinct cover across all users |
| R2 Class A (writes) | 1M / month | one, only on a miss |
| R2 Class B (reads) | 10M / month | one `HEAD` per new track, skipped within an album |
| Egress | free | — |
| Workers requests | 100k / day | — |

10 GB is roughly 140,000 distinct covers. Because the address is the content,
popular rips converge on one object no matter how many people play them, and the
steady state for a returning listener is `HEAD` traffic with no uploads at all.

## Operating it

```bash
npx wrangler tail
```

```bash
npx wrangler r2 object get vybecord-art/<sha256>.jpg --file cover.jpg
```

To remove something that should not be there:

```bash
npx wrangler r2 object delete vybecord-art/<sha256>.jpg
```

Deletion is safe: the key is a hash, so nothing else can be pointing at that
object for a different reason. A client that still wants it re-uploads it.
