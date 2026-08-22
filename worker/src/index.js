/**
 * Vybecord cover-art store — a content-addressed image cache on R2.
 *
 * Why this exists: Discord's Rich Presence needs a URL for the artwork, and
 * music played from local files has no URL anywhere — the art is bytes inside
 * the user's own file. Looking the album up on a public music CDN (see
 * src/core/cover-art.ts) answers that for anything ever released, which is most
 * of it. What is left is genuinely local: rips, demos, DJ sets, bootlegs. For
 * those, something has to put the bytes on the web.
 *
 * Uploading them to a free anonymous file host is the obvious answer and it
 * fails twice over. Discord's image proxy will not fetch from those hosts, so
 * the profile shows a "?" while the URL opens fine in a browser; and the hosts
 * themselves sit on malware blocklists — litterbox.catbox.moe is listed by
 * IPFire among others — so the user's antivirus blocks the request before it
 * leaves the machine. Both problems are about *where* the bytes go, not about
 * uploading. A first-party endpoint on a domain we own has neither.
 *
 * The design that keeps it that way:
 *
 *   - The key is the SHA-256 of the content, and the Worker recomputes it.
 *     A caller cannot choose a filename, an extension, or a path. Identical
 *     covers collapse to one object no matter how many users send them.
 *   - The content type is decided here from the magic bytes, never from the
 *     request, and pinned with nosniff. Only JPEG and PNG are storable, so the
 *     bucket cannot be turned into a general-purpose file drop — which is what
 *     got the anonymous hosts blocklisted in the first place.
 *   - Writes are rate limited per IP; reads are not, because reads are the
 *     common case and cost nothing.
 *
 * Costs, on the R2 and Workers free tiers: 10 GB of storage, 1M writes and 10M
 * reads a month, egress free, 100k requests a day. A cover is ~70 KB, so the
 * storage ceiling is around 140,000 distinct covers shared across every user.
 */

/** Bigger than any album cover worth showing in a 300px presence card. */
const MAX_BYTES = 512 * 1024;

const PREFIX = '/c/';

/** 64 hex characters of SHA-256, then the extension the bytes must match. */
const KEY_RE = /^([0-9a-f]{64})\.(jpg|png)$/;

const TYPES = { jpg: 'image/jpeg', png: 'image/png' };

/** A year, immutable — safe because the URL cannot outlive its content. */
const CACHE_CONTROL = 'public, max-age=31536000, immutable';

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    if (!pathname.startsWith(PREFIX)) return text(404, 'Not found');

    const key = pathname.slice(PREFIX.length);
    const match = KEY_RE.exec(key);
    if (!match) return text(400, 'Bad key');

    const ext = match[2];
    switch (request.method) {
      case 'GET':
      case 'HEAD':
        return serve(env, key, ext, request.method === 'HEAD');
      case 'PUT':
        return store(request, env, key, ext);
      default:
        return new Response('Method not allowed', {
          status: 405,
          headers: { Allow: 'GET, HEAD, PUT' },
        });
    }
  },
};

/**
 * Serve a stored cover.
 *
 * The client HEADs this before every upload, so a cover that anyone has already
 * sent costs one cheap request and no upload at all — which is also why the
 * app's outbound traffic looks like an update check rather than a file drop.
 */
async function serve(env, key, ext, headOnly) {
  const object = headOnly ? await env.ART.head(key) : await env.ART.get(key);
  if (!object) return new Response(null, { status: 404 });

  const headers = {
    'Content-Type': TYPES[ext],
    'Content-Disposition': 'inline',
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': CACHE_CONTROL,
    'Access-Control-Allow-Origin': '*',
  };
  if (headOnly) {
    headers['Content-Length'] = String(object.size);
    return new Response(null, { headers });
  }
  return new Response(object.body, { headers });
}

/**
 * Accept a cover, if the bytes really are the image the key claims.
 *
 * Every check here exists to keep this from becoming a file host. Dropping any
 * one of them turns the bucket into exactly the kind of endpoint that ends up
 * on the blocklists this whole design was built to avoid.
 */
async function store(request, env, key, ext) {
  if (await rateLimited(request, env)) return text(429, 'Slow down');

  // Cheap rejection before reading the body at all.
  const declared = Number(request.headers.get('content-length'));
  if (declared > MAX_BYTES) return text(413, 'Too large');

  const bytes = new Uint8Array(await request.arrayBuffer());
  if (!bytes.length || bytes.length > MAX_BYTES) return text(413, 'Bad size');

  // The type comes from the bytes. A request that says "jpg" over a ZIP is
  // rejected rather than stored and served as an image.
  if (sniff(bytes) !== ext) return text(415, 'Not a JPEG or PNG');

  // The key IS the content, verified server-side. This is what makes the store
  // idempotent and what stops a caller from writing to an address of its
  // choosing.
  const digest = hex(await crypto.subtle.digest('SHA-256', bytes));
  if (digest !== key.slice(0, 64)) return text(400, 'Digest mismatch');

  // Same bytes, same key: rewriting would only burn a Class A operation.
  if (!(await env.ART.head(key))) {
    await env.ART.put(key, bytes, {
      httpMetadata: { contentType: TYPES[ext], cacheControl: CACHE_CONTROL },
    });
  }
  return new Response(null, { status: 204 });
}

/**
 * Is this IP writing too fast?
 *
 * Fails open when the binding is absent, so a deployment without it still
 * works — the content-addressing above is the real protection, and this only
 * caps how fast someone can push distinct bytes.
 */
async function rateLimited(request, env) {
  if (!env.UPLOAD_LIMIT) return false;
  const ip = request.headers.get('cf-connecting-ip') || 'unknown';
  const { success } = await env.UPLOAD_LIMIT.limit({ key: ip });
  return !success;
}

/** Identify an image from its leading bytes. Returns 'jpg', 'png' or null. */
function sniff(b) {
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpg';
  if (
    b.length > 8 &&
    b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 &&
    b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a
  ) return 'png';
  return null;
}

function hex(buffer) {
  return [...new Uint8Array(buffer)].map(b => b.toString(16).padStart(2, '0')).join('');
}

function text(status, body) {
  return new Response(body, { status, headers: { 'Content-Type': 'text/plain' } });
}
