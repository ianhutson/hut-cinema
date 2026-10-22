// cleanup.js: keeps /Download free of torrent copies and orphaned files.
//
// 1. purgeMovieDownloads(movieId): call BEFORE Radarr deletes a movie.
//    Removes that movie's torrents (and their files) from qBittorrent,
//    plus any leftover same-size copy in Download/movies or incomplete/radarr.
// 2. start(): periodic sweep that
//    a) removes completed torrents Radarr already imported (library has its own copy)
//    b) removes completed torrents Radarr never imported after CLEANUP_ORPHAN_DAYS
//    c) deletes files on disk that no torrent owns: duplicates of library files,
//       and anything else older than CLEANUP_ORPHAN_DAYS
//
// Never touches Download/library. Deletes at most CLEANUP_MAX_GB_PER_SWEEP per
// sweep, with a pause between deletions, so the NAS isn't overloaded.
// Dry-run by default: set CLEANUP_DRY_RUN=0 to actually delete.

const fs = require("fs");
const path = require("path");

const env = process.env;
const RADARR_URL = (env.RADARR_URL || "").replace(/\/+$/, "");
const RADARR_API_KEY = env.RADARR_API_KEY || "";
const QB_URL = (env.QB_URL || "").replace(/\/+$/, "");
const QB_USER = env.QB_USER || "";
const QB_PASS = env.QB_PASS || "";
const DL = env.DOWNLOAD_ROOT || "/downloads";
const LIBRARY = path.join(DL, "library/movies");
const SOURCES = [path.join(DL, "movies"), path.join(DL, "incomplete/radarr")];
const DRY = env.CLEANUP_DRY_RUN !== "0";
const SWEEP_MIN = Number(env.CLEANUP_SWEEP_MINUTES || 60);
const GRACE_H = Number(env.CLEANUP_GRACE_HOURS || 2);
const ORPHAN_DAYS = Number(env.CLEANUP_ORPHAN_DAYS || 7);
const MAX_GB = Number(env.CLEANUP_MAX_GB_PER_SWEEP || 50);
const MIN_FILE = 500e6; // files this big are "the movie"; smaller = nfo/subs/samples

const log = (...a) => console.log(new Date().toISOString(), "[cleanup]" + (DRY ? " [dry-run]" : ""), ...a);
const gb = b => (b / 1e9).toFixed(1) + " GB";
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------- API clients ----------
let qbCookie = "";
async function qbLogin() {
  const res = await fetch(QB_URL + "/api/v2/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Referer: QB_URL },
    body: new URLSearchParams({ username: QB_USER, password: QB_PASS }),
  });
  const t = (await res.text()).trim();
  if (t !== "Ok.") throw new Error("qBittorrent login failed: " + t);
  qbCookie = (res.headers.get("set-cookie") || "").split(";")[0];
}
async function qb(p, body, retry = true) {
  if (!qbCookie) await qbLogin();
  const res = await fetch(QB_URL + p, {
    method: body ? "POST" : "GET",
    headers: { Cookie: qbCookie, Referer: QB_URL,
      ...(body && { "Content-Type": "application/x-www-form-urlencoded" }) },
    body: body ? new URLSearchParams(body) : undefined,
  });
  if (res.status === 403 && retry) { qbCookie = ""; return qb(p, body, false); }
  if (!res.ok) throw new Error(`qBittorrent ${p} -> HTTP ${res.status}`);
  return res;
}
const qbTorrents = async (q = "") => (await qb("/api/v2/torrents/info" + q)).json();

async function radarr(p) {
  const res = await fetch(RADARR_URL + p, { headers: { "X-Api-Key": RADARR_API_KEY } });
  if (!res.ok) throw new Error(`Radarr ${p} -> HTTP ${res.status}`);
  return res.json();
}
async function importedDownloadIds() {
  const ids = new Set();
  for (let page = 1; page <= 50; page++) {
    const r = await radarr(`/api/v3/history?eventType=3&pageSize=1000&page=${page}`); // 3 = downloadFolderImported
    for (const h of r.records || []) if (h.downloadId) ids.add(h.downloadId.toLowerCase());
    if (!r.records || !r.records.length || page * r.pageSize >= r.totalRecords) break;
  }
  return ids;
}

// ---------- filesystem ----------
function walk(dir, out = []) {
  let ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of ents) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.isFile()) { try { const s = fs.statSync(p).size; if (s >= MIN_FILE) out.push({ p, s }); } catch {} }
  }
  return out;
}
function sourceItems() {
  const items = [];
  for (const src of SOURCES) {
    let names; try { names = fs.readdirSync(src); } catch { continue; }
    for (const name of names) {
      if (name.startsWith("#") || name.startsWith(".")) continue;
      const top = path.join(src, name);
      let st; try { st = fs.statSync(top); } catch { continue; }
      const big = st.isDirectory() ? walk(top) : (st.size >= MIN_FILE ? [{ p: top, s: st.size }] : []);
      items.push({ top, name, big, size: big.reduce((a, f) => a + f.s, 0), mtime: st.mtimeMs });
    }
  }
  return items;
}
function liveNames(torrents) {
  const s = new Set();
  for (const t of torrents) { s.add(t.name); if (t.content_path) s.add(path.basename(t.content_path)); }
  return s;
}

// ---------- deletion (budgeted) ----------
let budget = 0;
async function deleteTorrents(list, why, useBudget = true) {
  for (const t of list) {
    if (useBudget && budget <= 0) { log("per-sweep limit reached; the rest waits for the next sweep"); return; }
    log(`remove torrent + files (${why}): ${gb(t.size)}  ${t.name}`);
    if (!DRY) { await qb("/api/v2/torrents/delete", { hashes: t.hash, deleteFiles: "true" }); await sleep(2000); }
    if (useBudget) budget -= t.size;
  }
}
async function deleteItems(list, why, useBudget = true) {
  for (const it of list) {
    if (useBudget && budget <= 0) { log("per-sweep limit reached; the rest waits for the next sweep"); return; }
    log(`delete from disk (${why}): ${gb(it.size)}  ${it.top}`);
    if (!DRY) { fs.rmSync(it.top, { recursive: true, force: true }); await sleep(2000); }
    if (useBudget) budget -= it.size;
  }
}

// ---------- 1. on movie removal ----------
async function purgeMovieDownloads(movieId) {
  if (!QB_URL) return;
  try {
    const hist = await radarr(`/api/v3/history/movie?movieId=${movieId}`);
    const hashes = [...new Set(hist.map(h => (h.downloadId || "").toLowerCase()).filter(Boolean))];
    const movie = await radarr(`/api/v3/movie/${movieId}`).catch(() => null);
    const why = `movie removed: ${movie?.title || movieId}`;

    if (hashes.length) await deleteTorrents(await qbTorrents(`?hashes=${hashes.join("|")}`), why, false);

    const size = movie?.movieFile?.size;
    if (size) {
      const live = liveNames(await qbTorrents());
      const leftovers = sourceItems().filter(it =>
        !live.has(it.name) && it.big.length && it.big.every(f => f.s === size));
      await deleteItems(leftovers, why, false);
    }
  } catch (e) { log(`purge failed for movie ${movieId}:`, e.message); }
}

// ---------- 2. periodic sweep ----------
let running = false;
async function sweep() {
  if (running) return;
  running = true;
  budget = MAX_GB * 1e9;
  try {
    const now = Date.now() / 1000;
    const imported = await importedDownloadIds();
    let torrents = await qbTorrents();
    const done = torrents.filter(t => t.progress >= 1 && t.completion_on > 0);

    await deleteTorrents(done.filter(t =>
      imported.has(t.hash.toLowerCase()) && now - t.completion_on > GRACE_H * 3600),
      "already in library");

    await deleteTorrents(done.filter(t =>
      !imported.has(t.hash.toLowerCase()) && now - t.completion_on > ORPHAN_DAYS * 86400),
      `finished ${ORPHAN_DAYS}+ days ago, never imported`);

    if (!DRY) torrents = await qbTorrents();
    const live = liveNames(torrents);
    const libSizes = new Set(walk(LIBRARY).map(f => f.s));
    const unowned = sourceItems().filter(it => !live.has(it.name));
    const dupes = unowned.filter(it => it.big.length && it.big.every(f => libSizes.has(f.s)));
    const orphans = unowned.filter(it => !dupes.includes(it) && Date.now() - it.mtime > ORPHAN_DAYS * 86400e3);

    await deleteItems(dupes, "copy of a library file, no torrent");
    await deleteItems(orphans, `not in library, no torrent, ${ORPHAN_DAYS}+ days old`);
  } catch (e) {
    log("sweep error:", e.message);
  } finally {
    running = false;
  }
}

function start() {
  if (!QB_URL) return log("QB_URL not set; download cleanup disabled");
  log(`sweep every ${SWEEP_MIN} min, max ${MAX_GB} GB per sweep, grace ${GRACE_H}h, orphans after ${ORPHAN_DAYS}d`);
  setTimeout(sweep, 60e3);
  setInterval(sweep, SWEEP_MIN * 60e3);
}

module.exports = { start, sweep, purgeMovieDownloads };