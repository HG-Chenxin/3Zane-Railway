/**
 * nearsxdownloader - Roblox asset downloader (self-hosted)
 *
 * Zero dependency. Cookie .ROBLOSECURITY dikirim dari browser per-request,
 * dipakai sekali di memory, lalu dibuang. Tidak pernah ditulis ke disk/log.
 */
import http from "node:http";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import * as roblox from "./lib/roblox.mjs";
import * as music from "./lib/music.mjs";
import { createBoundedQueue } from "./lib/bounded-queue.mjs";
import { consumeRateLimit } from "./lib/rate-limit.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, "public");

const PORT = Number(process.env.PORT || 8789);
const HOST = process.env.HOST || "127.0.0.1";
const APP_PASSWORD = process.env.APP_PASSWORD || "";
const MAX_BYTES = Number(process.env.MAX_BYTES || 64 * 1024 * 1024);
const TIMEOUT_MS = Number(process.env.UPSTREAM_TIMEOUT_MS || 30_000);
const RATE_MAX = Number(process.env.RATE_MAX || 30);
const GLOBAL_RATE_MAX = Number(process.env.GLOBAL_RATE_MAX || 120);
const RATE_WINDOW_MS = 60_000;
const MAX_BODY = 64 * 1024;

// Musik: yt-dlp + ffmpeg itu mahal, jadi limiter-nya sendiri + antrean.
const MUSIC_RATE_MAX = Number(process.env.MUSIC_RATE_MAX || 12);
const MUSIC_GLOBAL_RATE_MAX = Number(process.env.MUSIC_GLOBAL_RATE_MAX || 60);
const MUSIC_CONCURRENCY = Number(process.env.MUSIC_CONCURRENCY || 1);
const MUSIC_QUEUE_MAX = Number(process.env.MUSIC_QUEUE_MAX || 20);
const ASSET_DOWNLOAD_CONCURRENCY = Number(process.env.ASSET_DOWNLOAD_CONCURRENCY || 1);
const ASSET_DOWNLOAD_QUEUE_MAX = Number(process.env.ASSET_DOWNLOAD_QUEUE_MAX || 20);
const ASSET_UPLOAD_QUEUE_MAX = Number(process.env.ASSET_UPLOAD_QUEUE_MAX || 5);
const CACHE_DIR = process.env.CACHE_DIR || "/var/lib/rad-web";
const MAX_UPLOAD_BYTES = Number(process.env.MAX_UPLOAD_BYTES || 20 * 1024 * 1024);
const MAX_UPLOAD_BODY = Math.ceil((MAX_UPLOAD_BYTES * 4) / 3) + 64 * 1024;   // base64

const UPSTREAM = "https://assetdelivery.roblox.com/v1/asset";
const CLIENT_UA = "Roblox/WinInet";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".webmanifest": "application/manifest+json",
};

const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "Content-Security-Policy":
    "default-src 'self'; script-src 'self'; style-src 'self'; " +
    "img-src 'self' data: https://tr.rbxcdn.com https://i.ytimg.com https://*.ytimg.com; " +
    "connect-src 'self'; object-src 'none'; " +
    "base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
};

/* ------------------------------ utilities ------------------------------ */

function sniffExtension(buf) {
  if (buf.length >= 8) {
    const magic = buf.toString("latin1", 0, 8);
    if (magic === "<roblox!") return "rbxm";
    if (magic.startsWith("<roblox")) return "rbxmx";
  }
  if (buf.length < 12) return "bin";

  const tag = (start, end) => buf.toString("latin1", start, end);
  const be32 = (o) => buf.readUInt32BE(o);
  const be16 = (o) => buf.readUInt16BE(o);

  if (be32(0) === 0x89504e47) return "png";
  if (be16(0) === 0xffd8) return "jpg";
  if (tag(0, 4) === "GIF8") return "gif";
  if (tag(0, 4) === "OggS") return "ogg";
  if (tag(0, 4) === "fLaC") return "flac";
  if (tag(0, 4) === "RIFF" && tag(8, 12) === "WAVE") return "wav";
  if (be32(0) === 0x1a45dfa3) return "webm";
  if (tag(0, 3) === "ID3") return "mp3";
  if (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0) return "mp3";
  if (tag(4, 8) === "ftyp") {
    const brand = tag(8, 12);
    if (brand.startsWith("M4A")) return "m4a";
    if (brand.startsWith("qt")) return "mov";
    if (brand.startsWith("avif")) return "avif";
    if (brand.startsWith("heic")) return "heic";
    if (brand.startsWith("webp")) return "webp";
    return "mp4";
  }
  if (tag(0, 4) === "BM3D") return "bin";
  return "bin";
}

/**
 * .ROBLOSECURITY bisa kepaste dalam beberapa bentuk. Yang dikirim ke Roblox
 * harus CUMA nilai - kalau bukan, header jadi ".ROBLOSECURITY=.ROBLOSECURITY=..."
 * dan cookie dianggap tidak valid.
 *
 *   abc123                              -> apa adanya
 *   .ROBLOSECURITY=abc123               -> prefix dibuang
 *   ".ROBLOSECURITY"=abc123             -> quote dibuang
 *   a=b; .ROBLOSECURITY=abc123          -> diekstrak dari cookie string
 *   \n / spasi di sekitar                -> dipangkas
 */
function normalizeCookie(raw) {
  let value = String(raw ?? "").trim();
  if (!value) return { value: "", note: null, error: null };

  value = value.replace(/^["']|["']$/g, "").trim();

  if (value.includes(";")) {
    const pair = value
      .split(";")
      .map((part) => part.trim())
      .find((part) => /^\.roblosecurity\s*=/i.test(part));
    if (!pair) {
      return { value: "", note: null, error: "Cookie string nggak punya .ROBLOSECURITY" };
    }
    value = pair.slice(pair.indexOf("=") + 1).trim();
    return { value, note: "cookie string utuh -> .ROBLOSECURITY diekstrak" };
  }

  if (/^\.roblosecurity\s*=/i.test(value)) {
    value = value.slice(value.indexOf("=") + 1).trim();
    return { value, note: "prefix .ROBLOSECURITY= dibuang otomatis" };
  }

  return { value, note: null, error: null };
}

function sanitizeAssetId(input) {
  const digits = String(input ?? "").replace(/\D+/g, "");
  if (!digits || digits.length > 20) return null;
  return digits;
}

function safeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function clientIp(req) {
  const fwd = req.headers["x-forwarded-for"];
  if (typeof fwd === "string" && fwd.length) return fwd.split(",")[0].trim();
  return req.socket.remoteAddress || "unknown";
}

function sendJson(res, status, payload) {
  const body = Buffer.from(JSON.stringify(payload));
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": body.length,
    "Cache-Control": "no-store",
  });
  res.end(body);
}

function readJsonBody(req, limit = MAX_BODY) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(Object.assign(new Error("Payload terlalu besar"), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(Object.assign(new Error("Body bukan JSON valid"), { status: 400 }));
      }
    });
    req.on("error", reject);
  });
}

/* --------------------------- rate limiting ---------------------------- */

const hits = new Map();
const globalHits = new Map();
const musicHits = new Map();
const musicGlobalHits = new Map();

setInterval(() => {
  const now = Date.now();
  for (const store of [hits, globalHits, musicHits, musicGlobalHits]) {
    for (const [key, timestamps] of store) {
      const activeTimestamps = timestamps.filter((timestamp) => now - timestamp < RATE_WINDOW_MS);
      if (activeTimestamps.length) store.set(key, activeTimestamps);
      else store.delete(key);
    }
  }
}, RATE_WINDOW_MS);

function bucketLimited(store, key, max) {
  const now = Date.now();
  const list = (store.get(key) || []).filter((t) => now - t < RATE_WINDOW_MS);
  if (list.length >= max) {
    store.set(key, list);
    return true;
  }
  list.push(now);
  store.set(key, list);
  if (store.size > 5_000) {
    for (const [k, times] of store) {
      if (!times.some((t) => now - t < RATE_WINDOW_MS)) store.delete(k);
    }
  }
  return false;
}

const rateLimitResult = (ip) => consumeRateLimit({
  key: ip,
  keyHits: hits,
  globalHits,
  keyLimit: RATE_MAX,
  globalLimit: GLOBAL_RATE_MAX,
  windowMs: RATE_WINDOW_MS,
});
const rateLimited = (ip) => Boolean(rateLimitResult(ip));
const musicRateLimited = (ip) =>
  bucketLimited(musicHits, ip, MUSIC_RATE_MAX)
  || bucketLimited(musicGlobalHits, "global", MUSIC_GLOBAL_RATE_MAX);

const musicQueue = createBoundedQueue({
  concurrency: Math.max(1, MUSIC_CONCURRENCY),
  maxQueued: Math.max(0, MUSIC_QUEUE_MAX),
});
const assetDownloadQueue = createBoundedQueue({
  concurrency: Math.max(1, ASSET_DOWNLOAD_CONCURRENCY),
  maxQueued: Math.max(0, ASSET_DOWNLOAD_QUEUE_MAX),
});
const assetUploadQueue = createBoundedQueue({
  concurrency: 1,
  maxQueued: Math.max(0, ASSET_UPLOAD_QUEUE_MAX),
});

/* ------------------------------ download ------------------------------- */

async function fetchAsset({ assetId, cookie, placeId }) {
  const headers = {
    "User-Agent": CLIENT_UA,
    Cookie: `.ROBLOSECURITY=${cookie}`,
  };
  if (placeId) headers["Roblox-Place-Id"] = placeId;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const upstream = await fetch(`${UPSTREAM}?id=${encodeURIComponent(assetId)}`, {
      headers,
      signal: controller.signal,
      redirect: "follow",
    });

    if (!upstream.ok) {
      let detail = { message: upstream.statusText, code: String(upstream.status) };
      try {
        const parsed = JSON.parse(await upstream.text());
        const first = parsed?.errors?.[0];
        if (first) {
          detail = {
            message: first.message || detail.message,
            code: String(first.customErrorCode ?? first.code ?? detail.code),
          };
        }
      } catch {
        /* body bukan JSON, pakai statusText */
      }
      return { ok: false, status: upstream.status, ...detail };
    }

    const declared = Number(upstream.headers.get("content-length") || 0);
    if (declared > MAX_BYTES) {
      return { ok: false, status: 413, message: "File melebihi batas ukuran server", code: "TOO_LARGE" };
    }

    const buffer = Buffer.from(await upstream.arrayBuffer());
    if (buffer.length > MAX_BYTES) {
      return { ok: false, status: 413, message: "File melebihi batas ukuran server", code: "TOO_LARGE" };
    }

    return { ok: true, buffer, ext: sniffExtension(buffer) };
  } finally {
    clearTimeout(timer);
  }
}

/* ------------------------- creator -> place lookup ---------------------- */

const placeCache = new Map();      // assetId -> { creator, places[], at }
const hitCache = new Map();        // assetId -> { placeId, at }
const recentPlaceHints = new Map(); // placeId -> last successful download time
const TTL_PLACES = 6 * 60 * 60 * 1000;
const TTL_HIT = 24 * 60 * 60 * 1000;
const MAX_RECENT_PLACE_HINTS = 20;
const MAX_PLACE_CACHE_ENTRIES = 1000;
const MAX_HIT_CACHE_ENTRIES = 1000;

const LOOKUP_TIMEOUT = 8000;

async function mapWithConcurrency(items, concurrency, mapper) {
  const results = new Array(items.length);
  let nextIndex = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      results[index] = await mapper(items[index], index);
    }
  }));
  return results;
}

const json = async (url, headers = {}) => {
  const res = await fetch(url, {
    headers: { "User-Agent": CLIENT_UA, Accept: "application/json", ...headers },
    signal: AbortSignal.timeout(LOOKUP_TIMEOUT),
  });
  if (!res.ok) return null;
  return res.json().catch(() => null);
};

async function creatorGames(creatorType, creatorId) {
  const kind = creatorType === "Group" ? "groups" : "users";
  const out = [];
  let cursor = "";
  const seenCursors = new Set();

  while (true) {
    const url = new URL(`https://games.roblox.com/v2/${kind}/${creatorId}/games`);
    url.searchParams.set("limit", "50");
    url.searchParams.set("sortOrder", "Asc");
    if (cursor) url.searchParams.set("cursor", cursor);

    let data;
    try {
      data = await json(url);
    } catch {
      break;
    }
    if (!data) break;

    for (const game of data.data || []) {
      const universeId = game.id;
      if (!universeId) continue;
      const rootId = typeof game.rootPlace === "object" ? game.rootPlace.id : game.rootPlace;
      out.push({ universeId, name: game.name || "", rootPlaceId: rootId || null });
    }

    cursor = data.nextPageCursor;
    if (!cursor) break;
    if (seenCursors.has(cursor)) {
      console.error(`[ROBLOX DOWNLOAD] Repeated game pagination cursor for ${kind}/${creatorId}; stopping this source.`);
      break;
    }
    seenCursors.add(cursor);
  }
  return out;
}

async function universePlaces(universeId) {
  try {
    const data = await json(`https://develop.roblox.com/v1/universes/${universeId}/places`);
    return (data?.data || []).map((place) => ({ id: String(place.id), name: place.name || "" }));
  } catch {
    return [];
  }
}

async function publicUserGroups(userId) {
  const data = await json(`https://groups.roblox.com/v2/users/${encodeURIComponent(userId)}/groups/roles`);
  return (data?.data || []).flatMap((entry) => {
    const group = entry.group || entry;
    const id = group.id ?? entry.id;
    if (!id) return [];
    return [{
      id: String(id),
      name: group.name || entry.name || "",
      role: entry.role?.name || "",
    }];
  });
}

/**
 * Kumpulkan kandidat Place ID dari beberapa sumber, berurutan dari yang
 * paling mungkin: creator asset -> group creator -> game akun sendiri -> group sendiri.
 * Semua endpoint publik kecuali auth.roblox.com (perlu cookie, opsional).
 */
async function gatherCandidates(assetId, cookie, refresh = false) {
  const cached = placeCache.get(assetId);
  if (!refresh && cached) {
    if (Date.now() - cached.at < TTL_PLACES) {
      return { ...cached, user: null, cached: true };
    }
    placeCache.delete(assetId);
  }

  const sources = [];
  let assetMeta = null;

  // `details` (batas ~0.7s, call paling lambat) dan `whoAmI` (batas ~0.3s)
  // saling bebas, jadi jalankan bareng. Sebelumnya berurutan = 1.0s.
  const [detailsResult, me] = await Promise.all([
    json(`https://economy.roproxy.com/v2/assets/${assetId}/details`).catch(() => null),
    whoAmI(cookie),
  ]);

  if (detailsResult?.Creator?.Id) {
    assetMeta = { name: detailsResult.Name || null, assetTypeId: detailsResult.AssetTypeId ?? null };
    const creatorType = detailsResult.Creator.CreatorType;
    const creatorId = String(creatorType === "Group"
      ? detailsResult.Creator.CreatorTargetId || detailsResult.Creator.Id
      : detailsResult.Creator.Id);
    sources.push({
      label: `creator asset: ${detailsResult.Creator.Name}`,
      type: creatorType,
      id: creatorId,
    });

    if (creatorType !== "Group") {
      const creatorGroups = await publicUserGroups(creatorId).catch(() => []);
      for (const group of creatorGroups) {
        if (sources.some((source) => source.type === "Group" && source.id === group.id)) continue;
        sources.push({
          label: `group creator: ${group.name} (${group.role})`,
          type: "Group",
          id: group.id,
        });
      }
    }
  }

  if (me.identified) {
    sources.push({ label: `akun lo: ${me.username}`, type: "User", id: me.userId });
    for (const group of me.groups) {
      if (sources.some((source) => source.type === "Group" && source.id === group.id)) continue;
      sources.push({ label: `group: ${group.name} (${group.role})`, type: "Group", id: group.id });
    }
  }

  // Semua sumber independen: ambil daftar game-nya bareng-bareng, bukan
  // satu per satu. Owner aset biasanya皋 jadi kandidat terkuat, tapi urutan
  // assembling di bawah tetap dijaga supaya root place tetap di depan.
  const usable = sources;
  const gamesPerSource = await mapWithConcurrency(
    usable,
    5,
    (source) => creatorGames(source.type, source.id).catch(() => [])
  );

  const places = [];
  const universes = [];
  const seen = new Set();
  const seenUniverses = new Set();
  const add = (place) => {
    if (!place?.id || seen.has(place.id)) return;
    seen.add(place.id);
    places.push(place);
  };

  const rootPlacesPerSource = [];
  for (let index = 0; index < usable.length; index++) {
    const source = usable[index];
    const games = gamesPerSource[index] || [];

    for (const game of games) {
      if (!seenUniverses.has(game.universeId)) {
        seenUniverses.add(game.universeId);
        universes.push({
          universeId: game.universeId,
          name: game.name,
          rootPlaceId: game.rootPlaceId ? String(game.rootPlaceId) : null,
          source: source.label,
        });
      }
    }
    rootPlacesPerSource.push(games
      .filter((game) => game.rootPlaceId)
      .map((game) => ({
        id: String(game.rootPlaceId),
        game: game.name,
        source: source.label,
        root: true,
      })));
  }

  const sourceOffsets = rootPlacesPerSource.map(() => 0);
  let addedRootPlace = true;
  while (addedRootPlace) {
    addedRootPlace = false;
    for (let index = 0; index < rootPlacesPerSource.length; index++) {
      const candidate = rootPlacesPerSource[index][sourceOffsets[index]];
      sourceOffsets[index] += 1;
      if (!candidate) continue;
      add(candidate);
      addedRootPlace = true;
    }
  }

  const result = {
    places,
    universes,
    assetMeta,
    user: me,
    sources: usable.map(({ type, label }) => ({ type, label })),
  };
  placeCache.set(assetId, { places: result.places, universes, assetMeta, sources: result.sources, at: Date.now() });
  for (const [id, entry] of placeCache) {
    if (Date.now() - entry.at >= TTL_PLACES) placeCache.delete(id);
  }
  while (placeCache.size > MAX_PLACE_CACHE_ENTRIES) {
    placeCache.delete(placeCache.keys().next().value);
  }
  return { ...result, cached: false };
}

async function expandUniverseCandidates(assetId, resolved) {
  if (!resolved.universes?.length) return resolved;

  const seen = new Set(resolved.places.map((place) => place.id));
  const expanded = await mapWithConcurrency(
    resolved.universes,
    10,
    async (universe) => ({
      universe,
      places: await universePlaces(universe.universeId),
    })
  );

  for (const { universe, places } of expanded) {
    for (const place of places) {
      if (place.id === universe.rootPlaceId || seen.has(place.id)) continue;
      seen.add(place.id);
      resolved.places.push({
        ...place,
        game: place.name || universe.name,
        source: universe.source,
        root: false,
      });
    }
  }

  placeCache.set(assetId, {
    places: resolved.places,
    universes: resolved.universes,
    assetMeta: resolved.assetMeta,
    sources: resolved.sources,
    at: Date.now(),
  });
  return resolved;
}

/**
 * Identitas cookie hanya dipakai untuk menemukan experience milik akun login;
 * kegagalan endpoint identitas tidak dianggap sebagai validasi cookie.
 */
async function whoAmI(cookie) {
  const headers = { "User-Agent": CLIENT_UA, Cookie: `.ROBLOSECURITY=${cookie}`, Accept: "application/json" };
  const out = { identified: false, userId: null, username: null, groups: [] };
  const [authenticated, legacy] = await Promise.all([
    json("https://users.roblox.com/v1/users/authenticated", headers).catch(() => null),
    json("https://auth.roblox.com/v1/users/0", headers).catch(() => null),
  ]);
  const me = authenticated?.id ? authenticated : legacy;
  if (!me?.id) return out;

  out.identified = true;
  out.userId = String(me.id);
  out.username = me.name || me.displayName || null;
  out.groups = await publicUserGroups(out.userId).catch(() => []);
  if (!out.groups.length) {
    try {
      const groups = await json("https://auth.roblox.com/v1/users/0/groups", headers);
      out.groups = (groups || []).map((g) => ({
        id: String(g.id),
        name: g.name,
        role: g.role?.name,
      }));
    } catch {
      /* group tidak wajib */
    }
  }
  return out;
}

const rememberHit = (assetId, placeId) => {
  if (!placeId) return;
  const at = Date.now();
  for (const [id, hit] of hitCache) {
    if (at - hit.at >= TTL_HIT) hitCache.delete(id);
  }
  hitCache.delete(assetId);
  hitCache.set(assetId, { placeId, at });
  while (hitCache.size > MAX_HIT_CACHE_ENTRIES) {
    hitCache.delete(hitCache.keys().next().value);
  }
  recentPlaceHints.delete(placeId);
  recentPlaceHints.set(placeId, at);
  while (recentPlaceHints.size > MAX_RECENT_PLACE_HINTS) {
    recentPlaceHints.delete(recentPlaceHints.keys().next().value);
  }
};
const recallHit = (assetId) => {
  const hit = hitCache.get(assetId);
  return hit && Date.now() - hit.at < TTL_HIT ? hit.placeId : null;
};
const recallRecentPlaces = () => {
  const now = Date.now();
  for (const [placeId, at] of recentPlaceHints) {
    if (now - at >= TTL_HIT) recentPlaceHints.delete(placeId);
  }
  return [...recentPlaceHints.keys()].reverse();
};

/* ---------------------------- name resolution ------------------------- */

const nameCache = new Map();
const NAME_TTL_MS = 6 * 60 * 60 * 1000;
const MAX_NAME_CACHE_ENTRIES = 1000;

function cacheAssetName(assetId, name, assetTypeId) {
  const at = Date.now();
  nameCache.delete(assetId);
  nameCache.set(assetId, { name, assetTypeId, at });
  for (const [id, entry] of nameCache) {
    if (at - entry.at >= NAME_TTL_MS) nameCache.delete(id);
  }
  while (nameCache.size > MAX_NAME_CACHE_ENTRIES) {
    nameCache.delete(nameCache.keys().next().value);
  }
}

function safeFilename(name) {
  return String(name)
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
}

function asciiFilename(filename) {
  return filename
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\x20-\x7e]/g, "_");
}

function attachmentDisposition(filename) {
  const fallback = asciiFilename(filename);
  const encoded = encodeURIComponent(filename).replace(/[!'()*]/g, (char) =>
    `%${char.charCodeAt(0).toString(16).toUpperCase()}`
  );
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

/**
 * Ambil nama asli asset dari economy.roproxy.com (publik, tanpa auth).
 * Dipakai biar file bernama "R15Idle.rbxm" alih-alih "1234567890.rbxm".
 * Kalau gagal, caller fallback ke assetId - fitur ini kosmetik, bukan kritis.
 */
async function fetchAssetName(assetId) {
  const hit = nameCache.get(assetId);
  if (hit && Date.now() - hit.at < NAME_TTL_MS) {
    return { name: hit.name, assetTypeId: hit.assetTypeId ?? null };
  }

  try {
    const res = await fetch(`https://economy.roproxy.com/v2/assets/${assetId}/details`, {
      headers: { "User-Agent": CLIENT_UA, Accept: "application/json" },
      signal: AbortSignal.timeout(6000),
    });
    if (res.ok) {
      const data = await res.json().catch(() => null);
      const clean = safeFilename(data?.Name || "");
      const assetTypeId = Number.isInteger(data?.AssetTypeId) ? data.AssetTypeId : null;
      if (clean || assetTypeId !== null) {
        cacheAssetName(assetId, clean || null, assetTypeId);
        return { name: clean || null, assetTypeId };
      }
    }
  } catch {
    /* kosmetik - abaikan */
  }
  cacheAssetName(assetId, null, null);
  return { name: null, assetTypeId: null };
}

/* ---------------------------- static files ---------------------------- */

async function serveStatic(_req, res, pathname) {
  const rel = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const target = path.resolve(PUBLIC_DIR, rel);
  if (!target.startsWith(PUBLIC_DIR + path.sep)) {
    return sendJson(res, 403, { error: "Forbidden" });
  }
  let data;
  try {
    data = await fsp.readFile(target);
  } catch {
    return sendJson(res, 404, { error: "Not found" });
  }
  const type = MIME[path.extname(target).toLowerCase()] || "application/octet-stream";
  res.writeHead(200, {
    ...SECURITY_HEADERS,
    "Content-Type": type,
    "Content-Length": data.length,
    "Cache-Control": "no-store",
  });
  res.end(data);
}

/* ------------------------------- routes ------------------------------- */

/** Cek apakah sebuah place bisa accessed, TANPA download isi file. */
async function probeAsset({ assetId, cookie, placeId }) {
  try {
    const res = await fetch(`${UPSTREAM}?id=${encodeURIComponent(assetId)}`, {
      headers: { "User-Agent": CLIENT_UA, Cookie: `.ROBLOSECURITY=${cookie}`, ...(placeId ? { "Roblox-Place-Id": placeId } : {}) },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    res.body?.cancel().catch(() => {});
    return { status: res.status, ok: res.ok };
  } catch (err) {
    return { status: err?.name === "AbortError" ? 504 : 502, ok: false };
  }
}

async function attemptDownload({ assetId, cookie, placeId }) {
  try {
    return await fetchAsset({ assetId, cookie, placeId });
  } catch (err) {
    return {
      ok: false,
      status: err?.name === "AbortError" ? 504 : 502,
      message: err?.name === "AbortError"
        ? `Roblox tidak merespons dalam ${TIMEOUT_MS / 1000}s`
        : "Gagal menghubungi Roblox",
      code: err?.name === "AbortError" ? "TIMEOUT" : "UPSTREAM_UNREACHABLE",
    };
  }
}

/**
 * Probe kandidat secara paralel, lalu verifikasi yang lolos dengan unduhan
 * penuh. Bila unduhan penuh ditolak, lanjutkan ke kandidat berikutnya.
 */
async function downloadFromPlaces(assetId, cookie, places, batchSize = 10) {
  let lastAttempt = null;

  for (let i = 0; i < places.length; i += batchSize) {
    const batch = places.slice(i, i + batchSize);
    const results = await Promise.all(
      batch.map((place) => probeAsset({ assetId, cookie, placeId: place.id }))
    );

    for (let j = 0; j < batch.length; j++) {
      if (!results[j].ok) continue;
      const result = await attemptDownload({ assetId, cookie, placeId: batch[j].id });
      lastAttempt = { placeId: batch[j].id, result };
      if (result.ok || result.status === 429) return lastAttempt;
    }

    // 429 = kena rate limit Roblox, lanjutkan cuma memperburuk
    if (results.some((r) => r.status === 429)) return lastAttempt;
  }

  if (lastAttempt) return lastAttempt;
  if (!places.length) return null;

  const last = places[places.length - 1];
  return {
    placeId: last.id,
    result: await attemptDownload({ assetId, cookie, placeId: last.id }),
  };
}

async function handleDownload(req, res, ip) {
  let body;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    return sendJson(res, err.status || 400, { error: err.message });
  }

  const assetId = sanitizeAssetId(body.assetId);
  if (!assetId) return sendJson(res, 400, { error: "Asset ID tidak valid" });

  const cookieRaw = body.cookie ?? "";
  const cookie = normalizeCookie(cookieRaw).value;
  const explicitPlace = sanitizeAssetId(body.placeId) || "";
  const rawPlaceIdHints = body.placeIdHints ?? [];
  if (!Array.isArray(rawPlaceIdHints) || rawPlaceIdHints.length > 10
    || rawPlaceIdHints.some((id) => typeof id !== "string" || !/^\d{1,20}$/.test(id))) {
    return sendJson(res, 400, { error: "Daftar Place ID hint tidak valid", code: "INVALID_PLACE_ID_HINTS" });
  }
  const placeIdHints = [...new Set(rawPlaceIdHints)];
  if (!cookie) {
    return sendJson(res, 400, { error: "Cookie .ROBLOSECURITY kosong - wajib untuk asset privat" });
  }

  const started = Date.now();
  let result;
  let usedPlace = explicitPlace;
  let auto = null;

  if (explicitPlace) {
    result = await attemptDownload({ assetId, cookie, placeId: explicitPlace });
    if (result.ok) rememberHit(assetId, explicitPlace);
  } else {
    // 1)_place yang pernah berhasil untuk asset ini
    const known = recallHit(assetId);
    if (known) {
      result = await attemptDownload({ assetId, cookie, placeId: known });
    }
    // 2) asset publik sering langsung jalan tanpa Place ID sama sekali
    if (!result?.ok) {
      result = await attemptDownload({ assetId, cookie, placeId: "" });
    }
    if (!result?.ok) {
      // Assets from the same creator community often share a working experience.
      const recentPlaces = [...new Set([...placeIdHints, ...recallRecentPlaces()])]
        .filter((placeId) => placeId !== known)
        .map((id) => ({ id }));
      const recentDownload = await downloadFromPlaces(
        assetId,
        cookie,
        recentPlaces
      );
      if (recentDownload) {
        result = recentDownload.result;
        usedPlace = recentDownload.placeId;
        if (result.ok) rememberHit(assetId, usedPlace);
      }
    }

    // 4) petakan kandidat place dari creator asset + game milik akun sendiri
    if (!result?.ok) {
      let resolved = await gatherCandidates(assetId, cookie);
      let downloaded = await downloadFromPlaces(assetId, cookie, resolved.places);
      if (!downloaded?.result.ok) {
        resolved = await gatherCandidates(assetId, cookie, true);
        downloaded = await downloadFromPlaces(assetId, cookie, resolved.places);
      }
      if (!downloaded?.result.ok) {
        resolved = await expandUniverseCandidates(assetId, resolved);
        downloaded = await downloadFromPlaces(assetId, cookie, resolved.places);
      }
      auto = {
        asset: resolved.assetMeta?.name || null,
        assetTypeId: resolved.assetMeta?.assetTypeId ?? null,
        user: resolved.user?.identified ? resolved.user.username : "(tidak teridentifikasi)",
        candidates: resolved.places.length,
        groups: resolved.sources
          .filter((source) => source.type === "Group")
          .map((source) => ({
            name: source.label,
            experiences: resolved.universes.filter((universe) => universe.source === source.label).length,
          })),
        experiences: resolved.universes.length,
      };
      if (downloaded) {
        result = downloaded.result;
        usedPlace = downloaded.placeId;
        if (result.ok) rememberHit(assetId, usedPlace);
      }
    } else {
      if (!usedPlace) usedPlace = known;
      if (usedPlace) rememberHit(assetId, usedPlace);
    }
  }

  console.log(
    JSON.stringify({
      ip, assetId,
      placeId: usedPlace || null,
      cookieFixed: normalizeCookie(cookieRaw).note,
      auto,
      ok: Boolean(result?.ok),
      status: result?.status,
      ms: Date.now() - started,
    })
  );

  if (!result?.ok) {
    if (result?.status === 403) {
      const details = auto?.assetTypeId == null
        ? await json(`https://economy.roproxy.com/v2/assets/${assetId}/details`).catch(() => null)
        : null;
      const assetTypeId = auto?.assetTypeId ?? details?.AssetTypeId;
      if (assetTypeId === 24) {
        const groupsWithExperiences = auto?.groups?.filter((group) => group.experiences > 0) || [];
        const groupSummary = groupsWithExperiences.length
          ? `Experience ditemukan dari ${groupsWithExperiences.length} group: ${groupsWithExperiences.slice(0, 10).map((group) => `${group.name}: ${group.experiences}`).join("; ")}${groupsWithExperiences.length > 10 ? "; dan lainnya" : ""}.`
          : `Tidak ada experience group yang ditemukan melalui daftar publik/akun (group diperiksa: ${auto?.groups?.length || 0}; experience ditemukan: ${auto?.experiences || 0}).`;
        return sendJson(res, 403, {
          error: `Roblox mengenali asset ini sebagai animasi, tetapi menolak akses. ${groupSummary} Place ID kandidat: ${auto?.candidates || 0}. Pastikan asset diberi izin ke experience yang ditemukan.`,
          code: result.code,
          discovery: {
            user: auto?.user,
            experiences: auto?.experiences || 0,
            candidatePlaces: auto?.candidates || 0,
            groupsChecked: auto?.groups?.length || 0,
            groupsWithExperiences: groupsWithExperiences.slice(0, 20),
          },
        });
      }
      return sendJson(res, 403, { error: result.message, code: result.code });
    }
    if (!explicitPlace && !usedPlace) {
      return sendJson(res, result?.status || 404, {
        error: "Gagal auto-detect Place ID. Creator's game belum ketemu — isi Place ID manual.",
        code: result?.code || "NO_PLACE",
      });
    }
    return sendJson(res, result?.status || 502, {
      error: result?.message || "Unduhan gagal tanpa respons dari Roblox.",
      code: result?.code || "DOWNLOAD_FAILED",
    });
  }

  const assetInfo = await fetchAssetName(assetId);
  const filename = `${assetInfo.name || assetId}.${result.ext}`;
  res.writeHead(200, {
    ...SECURITY_HEADERS,
    "Content-Type": "application/octet-stream",
    "Content-Disposition": attachmentDisposition(filename),
    "Content-Length": result.buffer.length,
    "X-Asset-Filename": asciiFilename(filename),
    "X-Place-Id": usedPlace || "",
    ...(assetInfo.assetTypeId !== null ? { "X-Asset-Type-Id": String(assetInfo.assetTypeId) } : {}),
    "Cache-Control": "no-store",
  });
  res.end(result.buffer);
}

/* Versi yt-dlp/ffmpeg dicek sekali saat boot lalu di-cache; UI memakainya
 * buat mengunci tombol saat toolnya belum ada. */
let musicTools = { ytdlp: null, ffmpeg: null };

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const { pathname } = url;
  const ip = clientIp(req);

  res.setHeader("X-App", "nearsxdownloader");

  try {
    if (pathname === "/api/health") {
      return sendJson(res, 200, {
        ok: true,
        auth: Boolean(APP_PASSWORD),
        uptime: Math.round(process.uptime()),
        music: { ...(await musicTools), settings: music.musicSettings },
      });
    }

    if (pathname === "/api/identity") {
      const type = url.searchParams.get("type") === "group" ? "group" : "user";
      const id = String(url.searchParams.get("id") || "").replace(/\D+/g, "").slice(0, 24);
      if (!id) return sendJson(res, 400, { error: "ID tidak valid" });
      if (rateLimited(ip)) return sendJson(res, 429, { error: "Terlalu banyak permintaan." });

      const creator = await roblox.resolveCreator(type, id);
      if (!creator) return sendJson(res, 404, { error: `${type === "group" ? "Group" : "User"} ${id} tidak ditemukan` });
      const image = await roblox.thumbnail(type, id);
      return sendJson(res, 200, { creator, thumbnail: image });
    }

    if (pathname === "/api/accounts/verify") {
      if (req.method !== "POST") return sendJson(res, 405, { error: "Method not allowed" });
      if (rateLimited(ip)) return sendJson(res, 429, { error: "Terlalu banyak permintaan." });

      let body;
      try {
        body = await readJsonBody(req);
      } catch (err) {
        return sendJson(res, err.status || 400, { error: err.message });
      }

      const apiKey = String(body.apiKey || "").trim();
      if (!apiKey) return sendJson(res, 400, { error: "API key kosong" });

      const type = body.creatorType === "group" ? "group" : "user";
      const id = String(body.creatorId || "").replace(/\D+/g, "").slice(0, 24);
      const [key, creator, image] = await Promise.all([
        roblox.verifyApiKey(apiKey),
        id ? roblox.resolveCreator(type, id) : Promise.resolve(null),
        id ? roblox.thumbnail(type, id) : Promise.resolve(null),
      ]);

      if (!key.valid) return sendJson(res, 400, { error: key.reason, detail: key.detail });
      if (id && !creator) return sendJson(res, 404, { error: `${type === "group" ? "Group" : "User"} ${id} tidak ditemukan` });

      return sendJson(res, 200, { ok: true, note: key.reason, creator, thumbnail: image });
    }

    if (pathname === "/api/music/probe") {
      if (req.method !== "POST") return sendJson(res, 405, { error: "Method not allowed" });
      if (musicRateLimited(ip)) return sendJson(res, 429, { error: "Terlalu banyak permintaan musik. Tunggu sebentar." });

      let body;
      try {
        body = await readJsonBody(req);
      } catch (err) {
        return sendJson(res, err.status || 400, { error: err.message });
      }

      const result = await musicQueue(() => music.probeQuery(body.query));
      return sendJson(res, 200, { ...result, settings: music.musicSettings });
    }

    if (pathname === "/api/music/prepare") {
      if (req.method !== "POST") return sendJson(res, 405, { error: "Method not allowed" });
      if (musicRateLimited(ip)) return sendJson(res, 429, { error: "Terlalu banyak permintaan musik. Tunggu sebentar." });

      let body;
      try {
        body = await readJsonBody(req);
      } catch (err) {
        return sendJson(res, err.status || 400, { error: err.message });
      }

      const job = await musicQueue(() =>
        music.prepare({
          url: body.url,
          speed: body.speed,
          db: body.db,
          title: body.title,
          artist: body.artist,
        })
      );
      return sendJson(res, 200, { job });
    }

    if (pathname.startsWith("/api/music/file/")) {
      if (rateLimited(ip)) return sendJson(res, 429, { error: "Terlalu banyak permintaan." });
      const jobId = pathname.slice("/api/music/file/".length);
      const file = music.jobFile(jobId);
      if (!file) return sendJson(res, 404, { error: "Job tidak ada atau sudah kedaluwarsa. Siapkan ulang." });

      let fileStat;
      try {
        fileStat = await fsp.stat(file.path);
      } catch (error) {
        if (error.code === "ENOENT") return sendJson(res, 410, { error: "File sudah dibersihkan" });
        throw error;
      }

      const name = `${file.job.title || "audio"}`.replace(/[\\/:*?"<>|]/g, "").slice(0, 60) || "audio";
      res.writeHead(200, {
        ...SECURITY_HEADERS,
        "Content-Type": "audio/mpeg",
        "Content-Disposition": `attachment; filename="${name}.mp3"`,
        "Content-Length": fileStat.size,
        "Cache-Control": "no-store",
      });
      const stream = fs.createReadStream(file.path);
      stream.once("error", (error) => {
        console.error(`gagal mengirim file musik: ${error.message}`);
        if (res.headersSent) res.destroy(error);
        else sendJson(res, 500, { error: "Gagal mengirim file musik." });
      });
      stream.pipe(res);
      return;
    }

    if (pathname === "/api/music/upload") {
      if (req.method !== "POST") return sendJson(res, 405, { error: "Method not allowed" });
      if (musicRateLimited(ip)) return sendJson(res, 429, { error: "Terlalu banyak permintaan. Tunggu sebentar." });

      let body;
      try {
        body = await readJsonBody(req);
      } catch (err) {
        return sendJson(res, err.status || 400, { error: err.message });
      }

      const file = music.jobFile(body.jobId);
      if (!file) return sendJson(res, 404, { error: "Job tidak ada atau sudah kedaluwarsa. Siapkan ulang." });

      const apiKey = String(body.apiKey || "").trim();
      if (!apiKey) return sendJson(res, 400, { error: "API key akun belum diisi" });

      const type = body.creatorType === "group" ? "group" : "user";
      const id = String(body.creatorId || "").replace(/\D+/g, "").slice(0, 24);
      if (!id) return sendJson(res, 400, { error: "ID creator akun belum diisi" });

      let fileStat;
      try {
        fileStat = await fsp.stat(file.path);
      } catch (error) {
        if (error.code === "ENOENT") return sendJson(res, 410, { error: "File sudah dibersihkan" });
        throw error;
      }
      if (fileStat.size > MAX_UPLOAD_BYTES) {
        return sendJson(res, 413, {
          error: `File ${(fileStat.size / 1048576).toFixed(1)}MB melebihi batas ${(MAX_UPLOAD_BYTES / 1048576).toFixed(0)}MB`,
        });
      }

      let result;
      let buffer;
      try {
        result = await musicQueue(async () => {
          buffer = await fsp.readFile(file.path);
          return roblox.uploadAsset({
            apiKey,
            creatorType: type,
            creatorId: id,
            assetType: "Audio",
            displayName: music.smartTitle(body.title || file.job.title, 100, file.job.artist),
            buffer,
            filename: file.job.filename,
            mime: "audio/mpeg",
          });
        });
      } catch (err) {
        return sendJson(res, err.status || 502, { error: err.message || "Upload gagal" });
      }

      console.log(JSON.stringify({ ip, event: "music_upload", assetId: result.assetId, bytes: buffer.length, creator: `${type}:${id}` }));
      return sendJson(res, 200, { ok: true, assetId: result.assetId, job: file.job });
    }

    if (pathname === "/api/music/status") {
      if (req.method !== "POST") return sendJson(res, 405, { error: "Method not allowed" });
      if (rateLimited(ip)) return sendJson(res, 429, { error: "Terlalu banyak permintaan." });

      let body;
      try {
        body = await readJsonBody(req);
      } catch (err) {
        return sendJson(res, err.status || 400, { error: err.message });
      }

      const assetId = String(body.assetId || "").replace(/\D+/g, "");
      const apiKey = String(body.apiKey || "").trim();
      if (!assetId) return sendJson(res, 400, { error: "Asset ID kosong" });
      if (!apiKey) return sendJson(res, 400, { error: "API key akun belum diisi" });

      const status = await roblox.assetStatus(apiKey, assetId);
      return sendJson(res, status.ok ? 200 : 400, status);
    }

    if (pathname === "/api/assets/upload") {
      if (req.method !== "POST") return sendJson(res, 405, { error: "Method not allowed" });
      if (musicRateLimited(ip)) return sendJson(res, 429, { error: "Terlalu banyak permintaan. Tunggu sebentar." });

      return await assetUploadQueue(async () => {
      let body;
      try {
        body = await readJsonBody(req, MAX_UPLOAD_BODY);
      } catch (err) {
        return sendJson(res, err.status || 400, { error: err.message });
      }

      const apiKey = String(body.apiKey || "").trim();
      if (!apiKey) return sendJson(res, 400, { error: "API key akun belum diisi" });

      const type = body.creatorType === "group" ? "group" : "user";
      const id = String(body.creatorId || "").replace(/\D+/g, "").slice(0, 24);
      if (!id) return sendJson(res, 400, { error: "ID creator akun belum diisi" });

      const fileName = String(body.fileName || "asset.bin").replace(/[^\w.\- ]+/g, "").slice(0, 80) || "asset.bin";
      const buffer = Buffer.from(String(body.data || ""), "base64");
      if (!buffer.length) return sendJson(res, 400, { error: "File kosong" });
      if (buffer.length > MAX_UPLOAD_BYTES) {
        return sendJson(res, 413, {
          error: `File ${(buffer.length / 1048576).toFixed(1)}MB melebihi batas ${(MAX_UPLOAD_BYTES / 1048576).toFixed(0)}MB`,
        });
      }

      let result;
      try {
        result = await roblox.uploadAsset({
          apiKey,
          creatorType: type,
          creatorId: id,
          assetType: String(body.assetType || "Model").slice(0, 24),
          displayName: music.smartTitle(String(body.displayName || fileName).replace(/\.[^.]+$/, ""), 100),
          buffer,
          filename: fileName,
          mime: String(body.mime || "application/octet-stream").slice(0, 120),
        });
      } catch (err) {
        return sendJson(res, err.status || 502, { error: err.message || "Upload gagal" });
      }

      console.log(JSON.stringify({ ip, event: "asset_upload", assetId: result.assetId, bytes: buffer.length, creator: `${type}:${id}` }));
      return sendJson(res, 200, { ok: true, assetId: result.assetId });
      });
    }

    if (pathname === "/api/download") {
      if (req.method !== "POST") return sendJson(res, 405, { error: "Method not allowed" });
      const rateLimit = rateLimitResult(ip);
      if (rateLimit) {
        res.setHeader("Retry-After", String(rateLimit.retryAfterSeconds));
        return sendJson(res, 429, { error: "Terlalu banyak permintaan. Tunggu sebentar." });
      }
      if (APP_PASSWORD) {
        const supplied = req.headers["x-app-password"] || "";
        if (!safeEqual(supplied, APP_PASSWORD)) {
          return sendJson(res, 401, { error: "Password aplikasi salah", code: "UNAUTHORIZED" });
        }
      }
      return await assetDownloadQueue(() => handleDownload(req, res, ip));
    }

    if (req.method !== "GET" && req.method !== "HEAD") {
      return sendJson(res, 405, { error: "Method not allowed" });
    }

    return await serveStatic(req, res, pathname);
  } catch (err) {
    console.error(JSON.stringify({ ip, path: pathname, err: String(err?.message || err) }));
    const status = Number.isInteger(err?.status) && err.status >= 400 && err.status <= 599 ? err.status : 500;
    if (status === 503) res.setHeader("Retry-After", "15");
    if (!res.headersSent) return sendJson(res, status, { error: status === 500 ? "Internal server error" : err.message });
    res.end();
  }
});

server.listen(PORT, HOST, async () => {
  console.log(`nearsxdownloader listening on http://${HOST}:${PORT}`);
  console.log(`auth: ${APP_PASSWORD ? "on" : "off"} | max: ${(MAX_BYTES / 1048576).toFixed(0)}MB | rate: ${RATE_MAX}/min`);

  try {
    await fsp.mkdir(CACHE_DIR, { recursive: true });
    await music.ensureDir();
  } catch (err) {
    console.error(`gagal menyiapkan direktori: ${err.message}`);
  }
  musicTools = await music.toolVersions();
  console.log(
    `musik: yt-dlp ${musicTools.ytdlp || "TIDAK ADA"} | ffmpeg ${musicTools.ffmpeg || "TIDAK ADA"} | dB default ${music.musicSettings.defaultDb}`
  );
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    console.log(`${signal} diterima, shutting down`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5_000).unref();
  });
}
