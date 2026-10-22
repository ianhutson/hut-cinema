// Hut Cinema — a tiny Radarr remote for the household.
// Proxies the Radarr API so the API key never reaches the browser.

const express = require("express");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const cleanup = require("./cleanup");

const RADARR_URL = (process.env.RADARR_URL || "").replace(/\/+$/, "");
const RADARR_API_KEY = process.env.RADARR_API_KEY || "";
const QUALITY_PROFILE_ID = process.env.QUALITY_PROFILE_ID ? Number(process.env.QUALITY_PROFILE_ID) : null;
const PORT = Number(process.env.PORT || 8484);
const APP_PASSWORD = process.env.APP_PASSWORD || "";
const SESSION_DAYS = Number(process.env.SESSION_DAYS || 60);
const DELETE_AFTER_HOURS = Number(process.env.DELETE_AFTER_HOURS || 12);
const DATA_DIR = process.env.DATA_DIR || "/data";
const PENDING_FILE = path.join(DATA_DIR, "pending-removals.json");

if (!RADARR_URL || !RADARR_API_KEY) {
  console.error("Set RADARR_URL and RADARR_API_KEY environment variables.");
  process.exit(1);
}
if (!APP_PASSWORD) {
  console.error("Set APP_PASSWORD — the app refuses to run without a login password.");
  process.exit(1);
}

// Signed session cookie (no server-side session store needed)
const SECRET = crypto.createHash("sha256").update("hut-cinema:" + APP_PASSWORD).digest();
function makeToken() {
  const exp = Date.now() + SESSION_DAYS * 24 * 3600 * 1000;
  const sig = crypto.createHmac("sha256", SECRET).update(String(exp)).digest("hex");
  return `${exp}.${sig}`;
}
function tokenValid(token) {
  if (!token) return false;
  const [exp, sig] = token.split(".");
  if (!exp || !sig || Number(exp) < Date.now()) return false;
  const good = crypto.createHmac("sha256", SECRET).update(exp).digest("hex");
  return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(good));
}
function readCookie(req, name) {
  const m = (req.headers.cookie || "").match(new RegExp(`(?:^|; )${name}=([^;]*)`));
  return m ? decodeURIComponent(m[1]) : null;
}

// Basic brute-force damper: 8 attempts per IP per 15 minutes
const attempts = new Map();
function throttled(ip) {
  const now = Date.now();
  const rec = attempts.get(ip) || { count: 0, reset: now + 15 * 60 * 1000 };
  if (now > rec.reset) { rec.count = 0; rec.reset = now + 15 * 60 * 1000; }
  attempts.set(ip, rec);
  return rec.count >= 8;
}

const app = express();
app.use(express.json());

app.post("/login", (req, res) => {
  const ip = req.headers["cf-connecting-ip"] || req.socket.remoteAddress || "?";
  if (throttled(ip)) return res.status(429).json({ error: "Too many tries. Wait 15 minutes." });
  const pw = String(req.body.password || "");
  const ok =
    pw.length === APP_PASSWORD.length &&
    crypto.timingSafeEqual(Buffer.from(pw), Buffer.from(APP_PASSWORD));
  if (!ok) {
    attempts.get(ip).count++;
    return res.status(401).json({ error: "Wrong password." });
  }
  res.setHeader(
    "Set-Cookie",
    `hutsession=${encodeURIComponent(makeToken())}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 24 * 3600}`
  );
  res.json({ ok: true });
});

// Everything below requires a valid session
app.use((req, res, next) => {
  if (tokenValid(readCookie(req, "hutsession"))) return next();
  if (req.path.startsWith("/api/")) return res.status(401).json({ error: "Not signed in." });
  res.sendFile(path.join(__dirname, "public", "login.html"));
});

app.use(express.static(path.join(__dirname, "public")));

async function radarr(method, apiPath, body) {
  const res = await fetch(`${RADARR_URL}/api/v3${apiPath}`, {
    method,
    headers: {
      "X-Api-Key": RADARR_API_KEY,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Radarr ${method} ${apiPath} -> ${res.status} ${text.slice(0, 300)}`);
  }
  if (res.status === 204) return null;
  const raw = await res.text();
  return raw ? JSON.parse(raw) : null;
}

function posterOf(movie) {
  const imgs = movie.images || [];
  const poster = imgs.find((i) => i.coverType === "poster");
  return (poster && (poster.remoteUrl || poster.url)) || movie.remotePoster || null;
}

function slim(movie) {
  return {
    id: movie.id || null,
    tmdbId: movie.tmdbId,
    title: movie.title,
    year: movie.year,
    overview: movie.overview || "",
    poster: posterOf(movie),
    hasFile: !!movie.hasFile,
    inLibrary: !!movie.id,
  };
}

// ---- Pending removals (the 12-hour undo window) ----
function loadPending() {
  try { return JSON.parse(fs.readFileSync(PENDING_FILE, "utf8")); } catch { return []; }
}
function savePending(list) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(PENDING_FILE, JSON.stringify(list, null, 2));
}
let pending = loadPending();

// Cached quality profile (root folder is chosen fresh per add, by free space)
let profileId = null;
async function getProfileId() {
  if (profileId) return profileId;
  const profiles = await radarr("GET", "/qualityprofile");
  const p = (QUALITY_PROFILE_ID && profiles.find((x) => x.id === QUALITY_PROFILE_ID)) || profiles[0];
  profileId = p.id;
  return profileId;
}
async function bestRootFolder() {
  const folders = await radarr("GET", "/rootfolder");
  if (!folders.length) throw new Error("Radarr has no root folders configured.");
  folders.sort((a, b) => (b.freeSpace || 0) - (a.freeSpace || 0));
  return folders[0].path; // the one with the most free space
}

// Every movie added through Hut Cinema gets this Radarr tag, so the
// Letterboxd sync (which removes anything not on a watchlist) leaves it alone.
const KEEP_TAG = (process.env.RADARR_KEEP_TAG || "keep").toLowerCase();
let keepTagId = null;
async function getKeepTagId() {
  if (keepTagId) return keepTagId;
  const tags = await radarr("GET", "/tag");
  const existing = tags.find((t) => (t.label || "").toLowerCase() === KEEP_TAG);
  keepTagId = existing ? existing.id : (await radarr("POST", "/tag", { label: KEEP_TAG })).id;
  return keepTagId;
}
function withTag(tags, id) {
  return [...new Set([...(tags || []), id])];
}

// The library, with pending-removal state merged in
app.get("/api/library", async (_req, res) => {
  try {
    const movies = await radarr("GET", "/movie");
    movies.sort((a, b) => a.sortTitle.localeCompare(b.sortTitle));
    const pendingIds = new Map(pending.map((p) => [p.movieId, p]));
    res.json(
      movies.map((m) => {
        const s = slim(m);
        const p = pendingIds.get(m.id);
        if (p) {
          s.pendingRemoval = true;
          s.deleteAt = p.at + DELETE_AFTER_HOURS * 3600 * 1000;
        }
        return s;
      })
    );
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// Search TMDB via Radarr (for the Add tab)
app.get("/api/search", async (req, res) => {
  const q = (req.query.q || "").trim();
  if (!q) return res.json([]);
  try {
    const [results, exclusions] = await Promise.all([
      radarr("GET", `/movie/lookup?term=${encodeURIComponent(q)}`),
      radarr("GET", "/exclusions"),
    ]);
    const excluded = new Set(exclusions.map((e) => e.tmdbId));
    res.json(
      results.slice(0, 24).map((m) => ({ ...slim(m), excluded: excluded.has(m.tmdbId) }))
    );
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// "Recently removed" = pending (still undoable) + Radarr exclusions (fully removed)
app.get("/api/removed", async (_req, res) => {
  try {
    const exclusions = await radarr("GET", "/exclusions");
    exclusions.sort((a, b) => b.id - a.id);
    res.json({
      pending: pending.map((p) => ({
        movieId: p.movieId,
        tmdbId: p.tmdbId,
        title: p.title,
        year: p.year,
        deleteAt: p.at + DELETE_AFTER_HOURS * 3600 * 1000,
      })),
      removed: exclusions.map((e) => ({
        exclusionId: e.id,
        tmdbId: e.tmdbId,
        title: e.movieTitle,
        year: e.movieYear,
      })),
    });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// Add a movie by tmdbId (clears any exclusion first so add always works)
app.post("/api/add", async (req, res) => {
  const tmdbId = Number(req.body.tmdbId);
  if (!tmdbId) return res.status(400).json({ error: "tmdbId required" });
  try {
    const exclusions = await radarr("GET", "/exclusions");
    const excl = exclusions.find((e) => e.tmdbId === tmdbId);
    if (excl) await radarr("DELETE", `/exclusions/${excl.id}`);

    const found = await radarr("GET", `/movie/lookup/tmdb?tmdbId=${tmdbId}`);
    const tagId = await getKeepTagId();

    if (found.id) {
      // Already in Radarr (e.g. from a watchlist): tag it so it stays even if
      // it later drops off every watchlist.
      const movie = await radarr("GET", `/movie/${found.id}`);
      if (!(movie.tags || []).includes(tagId)) {
        await radarr("PUT", `/movie/${found.id}`, { ...movie, tags: withTag(movie.tags, tagId) });
      }
      return res.json({ ok: true, already: true, movie: slim(found) });
    }

    const added = await radarr("POST", "/movie", {
      ...found,
      rootFolderPath: await bestRootFolder(),
      qualityProfileId: await getProfileId(),
      monitored: true,
      tags: withTag(found.tags, tagId),
      addOptions: { searchForMovie: true },
    });
    res.json({ ok: true, movie: slim(added) });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// Remove: mark for deferred deletion (instant, fully undoable for DELETE_AFTER_HOURS)
app.delete("/api/movie/:id", async (req, res) => {
  const id = Number(req.params.id);
  if (!id) return res.status(400).json({ error: "movie id required" });
  if (pending.some((p) => p.movieId === id)) return res.json({ ok: true, already: true });
  try {
    const movie = await radarr("GET", `/movie/${id}`);
    // Unmonitor so Radarr stops caring about it during the window
    await radarr("PUT", `/movie/${id}`, { ...movie, monitored: false });
    pending.push({
      movieId: id,
      tmdbId: movie.tmdbId,
      title: movie.title,
      year: movie.year,
      at: Date.now(),
    });
    savePending(pending);
    res.json({ ok: true, deleteAt: Date.now() + DELETE_AFTER_HOURS * 3600 * 1000 });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// Undo: cancel a pending removal — nothing was deleted, nothing to re-download
app.post("/api/undo", async (req, res) => {
  const movieId = Number(req.body.movieId);
  const idx = pending.findIndex((p) => p.movieId === movieId);
  if (idx === -1) return res.status(404).json({ error: "No pending removal for that movie." });
  try {
    const movie = await radarr("GET", `/movie/${movieId}`);
    await radarr("PUT", `/movie/${movieId}`, { ...movie, monitored: true });
    pending.splice(idx, 1);
    savePending(pending);
    res.json({ ok: true });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// ---- The deferred delete worker ----
async function processPending() {
  const cutoff = Date.now() - DELETE_AFTER_HOURS * 3600 * 1000;
  const due = pending.filter((p) => p.at <= cutoff);
  for (const p of due) {
    try {
      // Kill any active/queued downloads for this movie in the download client
      const queue = await radarr("GET", "/queue?pageSize=200");
      for (const item of (queue.records || []).filter((r) => r.movieId === p.movieId)) {
        await radarr(
          "DELETE",
          `/queue/${item.id}?removeFromClient=true&blocklist=false`
        ).catch(() => {});
      }
      // Delete the movie + files, block re-adding
      await cleanup.purgeMovieDownloads(p.movieId);
      await radarr("DELETE", `/movie/${p.movieId}?deleteFiles=true&addImportExclusion=true`);
      pending = pending.filter((x) => x.movieId !== p.movieId);
      savePending(pending);
      console.log(`Deleted for good: ${p.title} (${p.year})`);
    } catch (e) {
      console.error(`Deferred delete failed for ${p.title}: ${e.message} — will retry next cycle`);
    }
  }
}
setInterval(processPending, 15 * 60 * 1000); // check every 15 minutes
processPending().catch(() => {});

app.listen(PORT, () => {
  cleanup.start();
  console.log(`Hut Cinema listening on :${PORT}, talking to ${RADARR_URL}`);
});