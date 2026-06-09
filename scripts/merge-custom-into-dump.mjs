/**
 * Merge manual custom lyrics (dist/lrclib-custom + WAL) into the LRCLib dump on D:.
 */
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const ROOT = path.resolve(import.meta.dirname, '..');
const dataDir = process.env.VYBECORD_DATA_DIR || ROOT;
const dumpPath = path.join(dataDir, 'lrclib-db-dump-20260410T172629Z.sqlite3');
const customSrcDir = path.join(ROOT, 'dist');

function openCustomDb() {
  const tmpBase = path.join(dataDir, '.lrclib-custom-merge.sqlite3');
  for (const ext of ['', '-wal', '-shm']) {
    const from = path.join(customSrcDir, `lrclib-custom.sqlite3${ext}`);
    if (fs.existsSync(from)) fs.copyFileSync(from, `${tmpBase}${ext}`);
  }
  const db = new Database(tmpBase);
  db.pragma('wal_checkpoint(TRUNCATE)');
  return db;
}

function main() {
  if (!fs.existsSync(dumpPath)) {
    console.error('Dump not found:', dumpPath);
    process.exit(1);
  }

  let customDb;
  try {
    customDb = openCustomDb();
  } catch (e) {
    console.error('Cannot open custom DB from dist:', e.message);
    process.exit(1);
  }

  const customRows = customDb.prepare(`
    SELECT t.name AS track_name, t.artist_name, t.album_name, t.duration, l.synced_lyrics
    FROM tracks t
    JOIN lyrics l ON l.id = t.last_lyrics_id
    WHERE l.source = 'custom'
  `).all();
  customDb.close();
  fs.unlinkSync(path.join(dataDir, '.lrclib-custom-merge.sqlite3'));
  for (const ext of ['-wal', '-shm']) {
    try { fs.unlinkSync(path.join(dataDir, `.lrclib-custom-merge.sqlite3${ext}`)); } catch { /* */ }
  }

  console.log(`Custom entries in dist DB: ${customRows.length}`);

  const dump = new Database(dumpPath);
  dump.pragma('journal_mode = WAL');

  const before = dump.prepare("SELECT COUNT(*) as c FROM lyrics WHERE source='custom'").get().c;
  console.log(`Custom in LRCLib dump before: ${before}`);

  if (customRows.length === 0) {
    console.log('Nothing to merge from dist.');
    dump.close();
    return;
  }

  const insertLyrics = dump.prepare(`
    INSERT INTO lyrics (plain_lyrics, synced_lyrics, track_id, has_plain_lyrics, has_synced_lyrics, instrumental, source, created_at, updated_at)
    VALUES (NULL, ?, NULL, 0, 1, 0, 'custom', ?, ?)
  `);
  const insertTrack = dump.prepare(`
    INSERT INTO tracks (name, name_lower, artist_name, artist_name_lower, album_name, album_name_lower, duration, last_lyrics_id, created_at, updated_at)
    VALUES (?, lower(?), ?, lower(?), ?, lower(?), ?, ?, ?, ?)
  `);
  const backlink = dump.prepare('UPDATE lyrics SET track_id = ? WHERE id = ?');
  const findExisting = dump.prepare(`
    SELECT t.id FROM tracks t
    JOIN lyrics l ON l.id = t.last_lyrics_id
    WHERE t.name_lower = lower(?) AND t.artist_name_lower = lower(?) AND l.source = 'custom'
    LIMIT 1
  `);

  const now = new Date().toISOString();
  let merged = 0;
  let skipped = 0;

  const tx = dump.transaction((rows) => {
    for (const row of rows) {
      if (findExisting.get(row.track_name, row.artist_name)) {
        skipped++;
        continue;
      }
      const lr = insertLyrics.run(row.synced_lyrics, now, now);
      const lyricsId = lr.lastInsertRowid;
      const tr = insertTrack.run(
        row.track_name, row.track_name,
        row.artist_name, row.artist_name,
        row.album_name || '', row.album_name || '',
        row.duration ?? null,
        lyricsId, now, now,
      );
      backlink.run(tr.lastInsertRowid, lyricsId);
      merged++;
    }
  });

  tx(customRows);
  const after = dump.prepare("SELECT COUNT(*) as c FROM lyrics WHERE source='custom'").get().c;
  dump.close();

  console.log(`Merged ${merged} new, skipped ${skipped} duplicates. Custom in dump now: ${after}`);

  const appData = path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'VybecordTS');
  fs.mkdirSync(appData, { recursive: true });
  fs.writeFileSync(path.join(appData, 'data-location.txt'), path.resolve(dataDir) + '\n', 'utf8');
  console.log('data-location.txt →', path.resolve(dataDir));
}

main();
