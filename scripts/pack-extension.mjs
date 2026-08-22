/**
 * Builds the store submission zips for the browser extension.
 *
 *   node scripts/pack-extension.mjs
 *
 * Two packages come out, because one manifest cannot satisfy both engines.
 * Manifest V3 says the background is a `service_worker`; Firefox has no MV3
 * service workers and runs it as an event page declared with `scripts`.
 *
 * The tree used to declare both keys at once, which Firefox 121+ accepts. The
 * cost was that Chrome and Edge reject `background.scripts` under MV3 and say
 * so in the extension's error panel — a warning shown to every user who loads
 * it unpacked, and to every reviewer. So `extension/manifest.json` is now the
 * Chromium manifest, clean, and the Firefox form is generated here instead of
 * being carried permanently in a manifest that Chromium reads.
 *
 * Written by hand rather than shelled out to PowerShell, for two reasons the
 * stores care about and the obvious tools get wrong:
 *
 *   - The root of the zip must be manifest.json, not a folder containing it.
 *     `Compress-Archive -Path dir\*` still records the parent directory in its
 *     entry paths, and the upload is rejected with a message that does not say
 *     which of the two problems it is.
 *   - Entry paths must be separated with forward slashes. Windows PowerShell
 *     5.1 writes backslashes — verified, not assumed — while pwsh 7 does not,
 *     so which one is on PATH silently decides whether the artifact is valid.
 *
 * Sixty lines of ZIP writing buys immunity from both.
 */
import { deflateRawSync, crc32 } from 'node:zlib';
import { readFileSync, writeFileSync, readdirSync, mkdirSync } from 'node:fs';
import { join, dirname, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const source = join(root, 'extension');
const outDir = join(root, 'release');

const manifestRaw = readFileSync(join(source, 'manifest.json'), 'utf8');
const { version, name } = JSON.parse(manifestRaw);
const stem = `${name.toLowerCase()}-extension-${version}`;

/** Dev-facing files that have no business in a store package. */
const EXCLUDE = new Set(['README.md', 'STORE_SUBMISSION.md', '.DS_Store', 'Thumbs.db']);

/** Every file under dir, deepest paths included, excluded names dropped. */
function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (EXCLUDE.has(entry.name)) return [];
    const full = join(dir, entry.name);
    return entry.isDirectory() ? walk(full) : [full];
  });
}

/**
 * The same extension, declared the way Firefox needs it.
 *
 * Only the background changes. Everything else — permissions, content scripts,
 * the gecko id and version floor — is already what Firefox expects.
 */
function toFirefox(raw) {
  const m = JSON.parse(raw);
  m.background = { scripts: [m.background.service_worker] };
  return Buffer.from(`${JSON.stringify(m, null, 2)}\n`, 'utf8');
}

/*
 * A fixed timestamp, so rebuilding an unchanged extension yields a byte-identical
 * zip. 1980-01-01 is the ZIP epoch — the earliest the format can express.
 */
const DOS_TIME = 0;
const DOS_DATE = 33;  // (1980-1980)<<9 | 1<<5 | 1

const files = walk(source).sort();

/**
 * Write one zip.
 *
 * @param outPath where to write it.
 * @param overrides entry path → replacement bytes, for files that differ
 *   between browsers rather than existing separately on disk.
 */
function writeZip(outPath, overrides = {}) {
  const local = [];
  const central = [];
  let offset = 0;

  for (const file of files) {
    // Forward slashes, always: the spec says so, and a backslash here is what
    // makes a reviewer's unzip produce one file with a strange name.
    const nameInZip = relative(source, file).split(sep).join('/');
    const raw = overrides[nameInZip] ?? readFileSync(file);
    const deflated = deflateRawSync(raw, { level: 9 });

    // Storing beats deflating when deflating made it bigger, which happens for
    // tiny files like a 306-byte icon.
    const useDeflate = deflated.length < raw.length;
    const body = useDeflate ? deflated : raw;
    const method = useDeflate ? 8 : 0;
    const sum = crc32(raw);
    const nameBytes = Buffer.from(nameInZip, 'utf8');

    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);   // local file header signature
    header.writeUInt16LE(20, 4);           // version needed
    header.writeUInt16LE(0, 6);            // flags
    header.writeUInt16LE(method, 8);
    header.writeUInt16LE(DOS_TIME, 10);
    header.writeUInt16LE(DOS_DATE, 12);
    header.writeUInt32LE(sum, 14);
    header.writeUInt32LE(body.length, 18);
    header.writeUInt32LE(raw.length, 22);
    header.writeUInt16LE(nameBytes.length, 26);
    header.writeUInt16LE(0, 28);           // extra field length
    local.push(header, nameBytes, body);

    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);    // central directory signature
    entry.writeUInt16LE(20, 4);            // version made by
    entry.writeUInt16LE(20, 6);            // version needed
    entry.writeUInt16LE(0, 8);             // flags
    entry.writeUInt16LE(method, 10);
    entry.writeUInt16LE(DOS_TIME, 12);
    entry.writeUInt16LE(DOS_DATE, 14);
    entry.writeUInt32LE(sum, 16);
    entry.writeUInt32LE(body.length, 20);
    entry.writeUInt32LE(raw.length, 24);
    entry.writeUInt16LE(nameBytes.length, 28);
    entry.writeUInt16LE(0, 30);            // extra field length
    entry.writeUInt16LE(0, 32);            // comment length
    entry.writeUInt16LE(0, 34);            // disk number start
    entry.writeUInt16LE(0, 36);            // internal attributes
    entry.writeUInt32LE(0, 38);            // external attributes
    entry.writeUInt32LE(offset, 42);       // offset of local header
    central.push(entry, nameBytes);

    offset += header.length + nameBytes.length + body.length;
  }

  const centralBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);        // end of central directory signature
  end.writeUInt16LE(0, 4);                 // this disk
  end.writeUInt16LE(0, 6);                 // disk with central directory
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);                // comment length

  writeFileSync(outPath, Buffer.concat([...local, centralBuf, end]));
  return outPath;
}

mkdirSync(outDir, { recursive: true });

const chromium = writeZip(join(outDir, `${stem}.zip`));
const firefox = writeZip(join(outDir, `${stem}-firefox.zip`), {
  'manifest.json': toFirefox(manifestRaw),
});

console.log(`Chrome / Edge : ${relative(root, chromium)}`);
console.log(`Firefox       : ${relative(root, firefox)}`);
console.log(`${files.length} files`);
