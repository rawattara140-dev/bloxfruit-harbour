'use strict';
// Fruit images. The browser always asks THIS server for /img/fruit/:id, so the page never depends on the wiki
// being up and the Content Security Policy only has to allow our own origin.
//
// How an image is found (once per fruit name, then never again unless you ask):
//   1. admin-set image link on the item, if there is one (no wiki request at all)
//   2. otherwise the MediaWiki API on the public Blox Fruits wiki returns the lead image of the page whose
//      title matches the fruit name (many fruits are looked up in ONE request)
// The answer is remembered in the database (table image_cache: wiki title, resolved image URL, file name,
// ok/missing) and the picture itself is stored under data/img-cache. After a restart nothing is asked again.
//
// Failure handling:
//   - "page or image does not exist"  -> remembered as `missing` for 24 hours (no repeated lookups)
//   - "wiki unreachable / error"      -> NOT remembered as missing; all lookups pause for 5 minutes (circuit
//                                        breaker) so a slow wiki cannot cause one failing request per page view
//   - image file deleted from disk    -> re-downloaded from the stored URL, no API request needed
//   - nothing found                   -> the route falls back to the base fruit, then a generic icon
//
// Consistency: the cache key is the normalised fruit name ("T-Rex" and "t rex" -> name-trex), not the numeric id,
// so the same name always maps to the same picture, even across renames or re-created items.
const fs = require('fs');
const path = require('path');
const db = require('./db');

const CACHE_DIR = path.join(process.env.DATABASE_PATH ? path.dirname(path.resolve(process.env.DATABASE_PATH)) : path.join(__dirname, '..', 'data'), 'img-cache');
fs.mkdirSync(CACHE_DIR, { recursive: true });

const WIKI_API = 'https://blox-fruits.fandom.com/api.php';
const HOST_OK = (h) => h === 'static.wikia.nocookie.net' || h === 'vignette.wikia.nocookie.net' || h === 'blox-fruits.fandom.com' || h.endsWith('.rbxcdn.com');
const TYPES = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' }; // no SVG: it can carry scripts
const MIME = Object.fromEntries(Object.entries(TYPES).map(([m, e]) => [e, m]));
const MAX_BYTES = 3 * 1024 * 1024;
const MISSING_TTL = 24 * 60 * 60 * 1000; // re-check "no image on the wiki" once a day
const RETRY_MS = 10 * 60 * 1000;         // after a failed download of one image
const DOWN_MS = 5 * 60 * 1000;           // after the wiki itself failed: pause every lookup
const BATCH = 20;                        // wiki titles per API request
const GAP_MS = 300;                      // minimum pause between wiki API requests

// If a fruit's wiki page has a different title than its name, list it here (key = normalised name).
// Example: { 'name-trex': 'T-Rex' }. Empty by default: the fruit's own name is used as the page title.
const TITLE_OVERRIDES = {};

db.exec(`CREATE TABLE IF NOT EXISTS image_cache (
  key TEXT PRIMARY KEY,
  title TEXT NOT NULL DEFAULT '',
  source_url TEXT NOT NULL DEFAULT '',
  file TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL,
  checked_at INTEGER NOT NULL
)`);
const q = {
  get: db.prepare('SELECT * FROM image_cache WHERE key = ?'),
  put: db.prepare('INSERT OR REPLACE INTO image_cache (key, title, source_url, file, status, checked_at) VALUES (?, ?, ?, ?, ?, ?)'),
  del: db.prepare('DELETE FROM image_cache WHERE key = ?'),
  itemName: db.prepare('SELECT name FROM items WHERE id = ?')
};

const backoff = new Map(); // key -> time of last failed download (memory only)
const inflight = new Map(); // key -> Promise (one job per key at a time)
let apiDownUntil = 0;
let apiChain = Promise.resolve();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function allowed(u) { try { const x = new URL(u); return x.protocol === 'https:' && HOST_OK(x.hostname); } catch { return false; } }
const hasOverride = (item) => Boolean(item.image_url && allowed(item.image_url));

// Stable cache key for an item.
function keyOf(item) {
  if (hasOverride(item)) return `item-${item.id}`;
  const norm = String(item.name || '').normalize('NFKD').toLowerCase().replace(/[^a-z0-9]+/g, '');
  return norm ? `name-${norm}` : `item-${item.id}`;
}
function titleFor(item) { return (TITLE_OVERRIDES[keyOf(item)] || String(item.name)).replace(/\|/g, ' ').trim(); }

async function get(url, asJson) {
  let cur = url;
  for (let hop = 0; hop < 3; hop++) {
    if (!allowed(cur)) throw new Error('host not allowed');
    const r = await fetch(cur, { redirect: 'manual', signal: AbortSignal.timeout(8000), headers: { 'User-Agent': 'BloxfruitHarbour/2.0 (fan site image cache)' } });
    if (r.status >= 300 && r.status < 400 && r.headers.get('location')) { cur = new URL(r.headers.get('location'), cur).href; continue; }
    if (!r.ok) throw Object.assign(new Error(`HTTP ${r.status}`), { status: r.status });
    return asJson ? r.json() : r;
  }
  throw new Error('too many redirects');
}

// One wiki request for many titles. Resolves to Map(requested title -> { title, url } | null).
// null means the wiki answered and there is no page or no image (that is a real answer, not an outage).
async function wikiResolve(titles) {
  const params = new URLSearchParams({ action: 'query', redirects: '1', titles: titles.join('|'), prop: 'pageimages', piprop: 'thumbnail|original', pithumbsize: '400', format: 'json', formatversion: '2' });
  const d = await get(`${WIKI_API}?${params}`, true);
  if (!d || !d.query) throw new Error('unexpected wiki response');
  const pages = Array.isArray(d.query.pages) ? d.query.pages : Object.values(d.query.pages || {});
  const byTitle = new Map(pages.map((p) => [p.title, p]));
  const hop = new Map();
  for (const list of [d.query.normalized, d.query.redirects]) for (const e of list || []) hop.set(e.from, e.to);
  const out = new Map();
  for (const t of titles) {
    let final = t;
    for (let i = 0; i < 4 && hop.has(final); i++) final = hop.get(final); // follow normalisation, then redirects
    const page = byTitle.get(final);
    const url = page && !page.missing && ((page.thumbnail && page.thumbnail.source) || (page.original && page.original.source));
    out.set(t, typeof url === 'string' && allowed(url) ? { title: final, url } : null);
  }
  return out;
}

// Wiki API calls run one at a time with a small gap, and stop entirely while the wiki is considered down.
function viaApi(fn) {
  const paused = () => Promise.reject(Object.assign(new Error('wiki paused'), { down: true }));
  if (Date.now() < apiDownUntil) return paused();
  const run = apiChain.then(() => (Date.now() < apiDownUntil ? paused() : fn()));
  apiChain = run.catch(() => {}).then(() => sleep(GAP_MS));
  return run.catch((e) => {
    if (!e.down) { apiDownUntil = Date.now() + DOWN_MS; console.warn(`Wiki image lookup failed (${e.message}); pausing lookups for 5 minutes.`); }
    throw e;
  });
}

function kindOf(buf, header) {
  if (TYPES[header]) return TYPES[header];
  if (buf.length > 12) { // some CDNs send application/octet-stream: trust the file's own signature instead
    if (buf[0] === 0x89 && buf.toString('latin1', 1, 4) === 'PNG') return 'png';
    if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
    if (buf.toString('latin1', 0, 4) === 'GIF8') return 'gif';
    if (buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'webp';
  }
  return null;
}

async function download(key, url) {
  const r = await get(url, false);
  const header = String(r.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  const buf = Buffer.from(await r.arrayBuffer());
  const ext = kindOf(buf, header);
  if (!ext) throw new Error(`unsupported type ${header}`);
  if (!buf.length || buf.length > MAX_BYTES) throw new Error('bad size');
  const name = `${key}.${ext}`;
  const file = path.join(CACHE_DIR, name);
  for (const e of Object.keys(MIME)) if (e !== ext) fs.rmSync(path.join(CACHE_DIR, `${key}.${e}`), { force: true });
  fs.writeFileSync(`${file}.tmp`, buf);
  fs.renameSync(`${file}.tmp`, file);
  const row = q.get.get(key) || { title: '' };
  q.put.run(key, row.title, url, name, 'ok', Date.now());
  return { file, type: MIME[ext] };
}

function onDisk(row) {
  if (!row || row.status !== 'ok' || !row.file) return null;
  const file = path.join(CACHE_DIR, path.basename(row.file));
  const ext = path.extname(file).slice(1);
  return MIME[ext] && fs.existsSync(file) ? { file, type: MIME[ext] } : null;
}

const isFresh = (row) => Boolean(row && (row.status === 'ok' || Date.now() - row.checked_at < MISSING_TTL));

// Looks up wiki images for entries [{ key, item }] with ONE request per BATCH titles and stores the answers.
// Returns 'ok' or 'down'.
async function resolveEntries(entries) {
  for (let i = 0; i < entries.length; i += BATCH) {
    const chunk = entries.slice(i, i + BATCH);
    const titles = [...new Set(chunk.map((e) => titleFor(e.item)))];
    let found;
    try { found = await viaApi(() => wikiResolve(titles)); } catch (e) { return 'down'; }
    for (const e of chunk) {
      const hit = found.get(titleFor(e.item));
      if (hit) q.put.run(e.key, hit.title, hit.url, '', 'ok', Date.now());
      else q.put.run(e.key, titleFor(e.item), '', '', 'missing', Date.now());
    }
  }
  return 'ok';
}

async function work(item, key) {
  let row = q.get.get(key);
  let url = row && row.status === 'ok' && row.source_url ? row.source_url : '';
  if (!url && hasOverride(item)) { url = item.image_url; q.put.run(key, '', url, '', 'ok', Date.now()); }
  for (let attempt = 0; attempt < 2; attempt++) {
    if (!url) {
      if (await resolveEntries([{ key, item }]) === 'down') { backoff.set(key, Date.now()); return null; }
      row = q.get.get(key);
      if (!row || row.status !== 'ok') return null; // the wiki has no image for this name (remembered)
      url = row.source_url;
    }
    try { return await download(key, url); } catch (e) {
      if ((e.status === 404 || e.status === 410) && attempt === 0 && !hasOverride(item)) { q.del.run(key); url = ''; continue; } // stored URL went stale: ask the wiki again once
      backoff.set(key, Date.now());
      console.warn(`Image for "${item.name}" not downloaded: ${e.message}`);
      return null;
    }
  }
  return null;
}

// Returns { file, type } or null. Never throws.
async function forItem(item) {
  if (!item) return null;
  try {
    const key = keyOf(item);
    const row = q.get.get(key);
    const hit = onDisk(row);
    if (hit) return hit; // normal case: no network, no API
    if (row && row.status === 'missing' && Date.now() - row.checked_at < MISSING_TTL) return null;
    if (backoff.has(key) && Date.now() - backoff.get(key) < RETRY_MS) return null;
    if (!row && Date.now() < apiDownUntil && !hasOverride(item)) return null; // wiki is paused and we have nothing stored
    if (!inflight.has(key)) inflight.set(key, work(item, key).catch(() => null).finally(() => inflight.delete(key)));
    return await inflight.get(key);
  } catch { return null; }
}

// Fills the cache for many items in the background (called once at startup and after items are added), so the
// first visitors do not trigger one lookup per fruit. Items that are already cached cost nothing.
async function warm(items) {
  const todoLookup = new Map();
  const todoDownload = new Map();
  for (const item of items || []) {
    const key = keyOf(item);
    const row = q.get.get(key);
    if (onDisk(row)) continue;
    if (row && row.status === 'ok' && row.source_url) todoDownload.set(key, item);
    else if (hasOverride(item)) todoDownload.set(key, item);
    else if (!isFresh(row)) todoLookup.set(key, item);
  }
  const stats = { looked_up: 0, downloaded: 0, failed: 0, wiki_down: false };
  if (todoLookup.size && await resolveEntries([...todoLookup].map(([key, item]) => ({ key, item }))) === 'down') stats.wiki_down = true;
  for (const [key, item] of todoLookup) { const r = q.get.get(key); if (r && r.status === 'ok' && r.source_url) todoDownload.set(key, item); }
  stats.looked_up = todoLookup.size;
  for (const [key, item] of todoDownload) {
    const r = q.get.get(key);
    const url = (r && r.source_url) || item.image_url;
    try { await download(key, url); stats.downloaded++; } catch (e) { stats.failed++; backoff.set(key, Date.now()); }
    await sleep(120);
  }
  if (stats.looked_up || stats.downloaded || stats.failed) console.log(`Fruit images: ${stats.looked_up} looked up, ${stats.downloaded} downloaded, ${stats.failed} failed${stats.wiki_down ? ' (wiki unreachable, will retry later)' : ''}.`);
  return stats;
}

// Forget what we know about an item's picture (used when an admin changes its name or image link).
function clear(id, oldName) {
  const keys = new Set([`item-${id}`]);
  const row = q.itemName.get(id);
  for (const n of [oldName, row && row.name]) if (n) keys.add(keyOf({ id, name: n }));
  for (const key of keys) {
    q.del.run(key);
    backoff.delete(key);
    for (const ext of Object.keys(MIME)) fs.rmSync(path.join(CACHE_DIR, `${key}.${ext}`), { force: true });
  }
}

module.exports = { forItem, warm, clear, allowed, keyOf, CACHE_DIR };
