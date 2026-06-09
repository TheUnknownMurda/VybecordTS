/**
 * Point installed VybecordTS at D:\VybecordTS and verify LRCLib + custom lyrics.
 */
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const ROOT = path.resolve(import.meta.dirname, '..');
const appData = path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'VybecordTS');
const dumpPath = path.join(ROOT, 'lrclib-db-dump-20260410T172629Z.sqlite3');

fs.mkdirSync(appData, { recursive: true });
fs.writeFileSync(path.join(appData, 'data-location.txt'), ROOT + '\n', 'utf8');
console.log('data-location.txt →', ROOT);

for (const name of [
  'flagged-lyrics.json',
  'listening-history.json',
  'stats-history.json',
  'translate-cache.json',
  'config.json',
]) {
  const from = path.join(ROOT, name);
  const to = path.join(ROOT, name);
  if (fs.existsSync(from)) console.log('OK', name, Math.round(fs.statSync(from).size / 1024), 'KB');
}

if (!fs.existsSync(dumpPath)) {
  console.error('Missing LRCLib dump:', dumpPath);
  process.exit(1);
}
console.log('OK LRCLib dump', Math.round(fs.statSync(dumpPath).size / 1024 / 1024), 'MB');

const db = new Database(dumpPath, { readonly: true });
const custom = db.prepare("SELECT COUNT(*) as c FROM lyrics WHERE source='custom'").get().c;
const sample = db.prepare(`
  SELECT t.name, t.artist_name FROM tracks t
  JOIN lyrics l ON l.id = t.last_lyrics_id
  WHERE l.source = 'custom'
  ORDER BY l.created_at DESC
  LIMIT 8
`).all();
console.log('Custom lyrics in dump:', custom);
console.log('Sample:', sample.map((r) => `${r.name} — ${r.artist_name}`).join('\n  '));
db.close();

console.log('\nInstalled app will use:', ROOT);
