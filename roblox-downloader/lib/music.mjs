/**
 * Musik: Resolve metadata lewat yt-dlp, unduh + ubah speed/dB + encode MP3
 * pakai ffmpeg, lalu simpan sebagai "job" supaya bisa diunduh ke browser
 * DAN diupload ke Roblox tanpa proses unduh ulang.
 */
import { spawn } from "node:child_process";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";

let YTDLP = process.env.YTDLP_PATH || "yt-dlp";
let FFMPEG = process.env.FFMPEG_PATH || "ffmpeg";
const MUSIC_DIR = process.env.MUSIC_DIR || path.join(os.tmpdir(), "rad-music");
const JOB_TTL_MS = 6 * 60 * 60 * 1000;
const MAX_SOURCE_SECONDS = 20 * 60;

const MIN_SPEED = 0.25;
const MAX_SPEED = 4;
const MIN_DB = -24;
const MAX_DB = 12;
const DEFAULT_DB = -4;
const BITRATE_LADDER = [128, 96, 64];

export function configureMusicTools({ ytDlpPath, ffmpegPath } = {}) {
  if (ytDlpPath) YTDLP = ytDlpPath;
  if (ffmpegPath) FFMPEG = ffmpegPath;
}

/* ------------------------------ argumen -------------------------------- */

const clampNum = (value, min, max, fallback) => {
  const raw = String(value ?? "").replace(",", ".").trim();
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
};

export const normalizeSpeed = (value) => Math.round(clampNum(value, MIN_SPEED, MAX_SPEED, 1) * 1000) / 1000;
export const normalizeDb = (value) => Math.round(clampNum(value, MIN_DB, MAX_DB, DEFAULT_DB) * 10) / 10;

/** Roblox Speed = 1 / speed. 2.3x -> 0.43 supaya keluar normal in-game. */
export const inGameSpeed = (speed) => Math.round((1 / normalizeSpeed(speed)) * 100) / 100;

const clampInt = (value, min, max, fallback) => {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
};

/** ffmpeg atempo satu instance cuma boleh 0.5 - 2.0, jadi dirantai. */
function atempoChain(speed) {
  const steps = [];
  let remaining = speed;
  while (remaining > 2.0) {
    steps.push(2.0);
    remaining /= 2.0;
  }
  while (remaining < 0.5) {
    steps.push(0.5);
    remaining /= 0.5;
  }
  steps.push(Number(remaining.toFixed(4)));
  return steps.map((step) => `atempo=${step}`).join(",");
}

/* -------------------------------- judul -------------------------------- */

// Kata-kata noise yang sering nempel di judul YouTube. Isinya bisa rangkaian
// ("(4K Remaster)", "(Official Music Video)"), jadi polanya 1-6 kata.
const NOISE_WORDS = [
  "official", "lyric", "lyrics", "visualizer", "mv", "hd", "hq", "4k", "8k",
  "1080p", "720p", "480p", "remaster", "remastered", "full", "audio", "music",
  "video", "with", "color", "coloured", "colored", "coded", "reaction", "mix",
  "remix", "cover", "extended", "version", "live", "explicit", "clean", "high",
  "quality", "outro", "outros", "instrumental", "bonus", "track", "single",
  "album", "release", "free", "download", "hdrip", "webrip", "encoded",
].join("|");

const NOISE = [
  new RegExp(`\\s*[\\(\\[]\\s*(?:(?:${NOISE_WORDS})\\b[\\s-]*){1,6}[\\)\\]]`, "gi"),
  new RegExp(`\\s*[|\\-\u2013\u2014]\\s*(?:(?:${NOISE_WORDS})\\b[\\s-]*){1,6}$`, "gi"),
  /\s*\[[^\]]{0,40}\]\s*$/g,
];

const SENTENCE_END = /[.!?。！？]/;

const reEsc = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Potong judul biar muat di Roblox: buang prefiks nama artis, potong di
 * kalimat pertama kalau ada, buang kata noisy, lalu potong keras di batas
 * kata. `artist` dipakai buat memilih mana bagian yang benar-benar judul -
 * tanpa itu, "Artis - Judul Lagu" akan terpotong jadi nama artis saja.
 */
export function smartTitle(raw, maxLen = 100, artist = "") {
  let title = String(raw ?? "").replace(/\s+/g, " ").trim();

  const name = String(artist ?? "").trim();
  if (name.length >= 3) {
    title = title.replace(new RegExp(`^\\s*${reEsc(name)}\\s*[\\-\u2013\u2014|:]\\s*`, "i"), "");
  }

  const paren = title.match(SENTENCE_END);
  if (paren && paren.index > 0) title = title.slice(0, paren.index);

  const dash = title.split(/\s+[|\u2013\u2014-]\s+/)[0];
  if (dash && dash.length >= 8) title = dash;

  for (const pattern of NOISE) title = title.replace(pattern, " ");

  title = title
    .replace(/[-\u2013\u2014]{2,}/g, " ")
    .replace(/[\s\-\u2013\u2014|,]+$/g, "")
    .replace(/[^\p{L}\p{N}\s'\-\u2013\u2014!?'&.]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (title.length > maxLen) {
    const slice = title.slice(0, maxLen);
    const cut = slice.lastIndexOf(" ");
    title = (cut > maxLen * 0.6 ? slice.slice(0, cut) : slice).trim();
  }
  return title || String(raw ?? "").trim().slice(0, maxLen) || "Untitled";
}

/* -------------------------------- proses ------------------------------- */

function run(bin, args, { timeout, onLine } = {}) {
  return new Promise((resolve) => {
    const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let killed = false;

    const timer = timeout
      ? setTimeout(() => {
          killed = true;
          child.kill("SIGKILL");
        }, timeout)
      : null;

    child.stdout.on("data", (chunk) => {
      const text = chunk.toString("utf8");
      if (onLine) onLine(text);
      else stdout += text;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
      if (stderr.length > 8000) stderr = stderr.slice(-4000);
    });

    child.on("error", (err) => {
      if (timer) clearTimeout(timer);
      resolve({ code: -1, stdout: "", stderr: String(err?.message || err), spawnError: String(err?.code || err) });
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr, killed });
    });
  });
}

export async function toolVersions() {
  const [ytdlp, ffmpeg] = await Promise.all([
    run(YTDLP, ["--version"], { timeout: 10_000 }),
    run(FFMPEG, ["-version"], { timeout: 10_000 }),
  ]);
  return {
    ytdlp: ytdlp.code === 0 ? ytdlp.stdout.trim().split("\n")[0] : null,
    ffmpeg: ffmpeg.code === 0 ? ffmpeg.stdout.trim().split("\n")[0] : null,
  };
}

const isUrl = (value) => /^(https?:\/\/|www\.)/i.test(String(value ?? "").trim());
const cleanUrl = (value) => {
  const url = String(value ?? "").trim();
  return /^https?:\/\//i.test(url) ? url : `https://${url}`;
};
function isYoutubeTarget(args) {
  return args.some((value) => {
    if (/^ytsearch\d*:/i.test(String(value))) return true;
    try {
      const url = new URL(cleanUrl(String(value)));
      return ["youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com", "youtu.be"].includes(url.hostname.toLowerCase());
    } catch {
      return false;
    }
  });
}

export async function createYoutubeCookieCopy() {
  const encodedCookies = process.env.YT_COOKIES_B64?.trim();
  const configuredPath = process.env.YT_COOKIES_PATH?.trim();
  let cookieContents;

  if (encodedCookies) {
    const normalized = encodedCookies.replace(/\s/g, "");
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(normalized)) {
      throw new Error("YT_COOKIES_B64 is not valid Base64");
    }
    cookieContents = Buffer.from(normalized, "base64");
  } else {
    const cookiePath = path.resolve(configuredPath || "cookies.txt");
    let stat;
    try {
      stat = await fsp.stat(cookiePath);
    } catch (error) {
      if (error?.code === "ENOENT" && !configuredPath) return null;
      if (error?.code === "ENOENT") {
        throw new Error("YT_COOKIES_PATH is configured but the cookie file does not exist");
      }
      throw error;
    }
    if (!stat.isFile()) throw new Error("YT_COOKIES_PATH must point to a cookie file");
    cookieContents = await fsp.readFile(cookiePath);
  }

  if (!cookieContents.length || cookieContents.length > 1024 * 1024) {
    throw new Error("YouTube cookie data must be non-empty and no larger than 1 MiB");
  }
  if (!cookieContents.toString("utf8").startsWith("# Netscape HTTP Cookie File")) {
    throw new Error("YouTube cookie data must use the Netscape cookies.txt format");
  }

  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "3zane-youtube-cookies-"));
  const tempPath = path.join(tempDir, "cookies.txt");
  try {
    await fsp.chmod(tempDir, 0o700);
    await fsp.writeFile(tempPath, cookieContents, { mode: 0o600, flag: "wx" });
  } catch (error) {
    await fsp.rm(tempDir, { recursive: true, force: true });
    throw error;
  }

  return {
    path: tempPath,
    cleanup: () => fsp.rm(tempDir, { recursive: true, force: true }),
  };
}

export async function runYtDlp(args, { timeout, execute = run } = {}) {
  const normalizedArgs = args.map((value) =>
    typeof value === "string" && /^\s*(?:https?:\/\/|www\.)/i.test(value) ? cleanUrl(value) : value
  );
  const youtubeTarget = isYoutubeTarget(normalizedArgs);
  const commandArgs = youtubeTarget
    ? ["--js-runtimes", "node", ...normalizedArgs]
    : [...normalizedArgs];
  let cookieCopy;
  if (youtubeTarget) {
    if (process.env.YT_PROXY) commandArgs.push("--proxy", process.env.YT_PROXY);
    cookieCopy = await createYoutubeCookieCopy();
    if (cookieCopy) commandArgs.push("--cookies", cookieCopy.path);
  }
  try {
    return await execute(YTDLP, commandArgs, { timeout });
  } finally {
    if (cookieCopy) await cookieCopy.cleanup();
  }
}

/* ------------------------------- resolve -------------------------------- */

const asEntry = (info) => ({
  id: info.id || null,
  title: info.title || "",
  artist: info.artist || info.uploader || info.channel || info.creator || "",
  uploader: info.uploader || info.channel || "",
  duration: Number(info.duration) || 0,
  thumbnail: info.thumbnail || "",
  url: info.webpage_url || (info.id ? `https://www.youtube.com/watch?v=${info.id}` : ""),
  album: info.album || info.release_title || null,
  upload_date: info.upload_date || null,
  release_date: info.release_date || null,
  release_timestamp: info.release_timestamp ?? null,
  timestamp: info.timestamp ?? null,
});

/** Satu lagu dari URL langsung. */
async function resolveOne(query, execute) {
  const args = ["--no-warnings", "--no-playlist", "--no-cache-dir", "--dump-single-json", cleanUrl(query)];
  let res = await runYtDlp(args, { timeout: 90_000, execute });
  if (res.code !== 0 && /page needs to be reloaded/i.test(res.stderr)) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    res = await runYtDlp(args, { timeout: 90_000, execute });
  }
  if (res.code !== 0) {
    throw Object.assign(new Error(res.spawnError ? "yt-dlp tidak terpasang di server" : res.stderr.trim().split("\n").pop() || "yt-dlp gagal"), { status: 502 });
  }
  let data;
  try {
    data = JSON.parse(res.stdout);
  } catch {
    throw new Error("Metadata tidak bisa dibaca");
  }
  const entry = asEntry(data);
  if (!entry.url) throw new Error("Link tidak menghasilkan metadata");
  return { results: [entry], kind: "url" };
}

/** Pencarian: ytsearch8 + flat-playlist, satu JSON per baris. */
async function searchMany(query, limit = 8) {
  const count = clampInt(limit, 1, 20, 8);
  const res = await runYtDlp(
    ["--no-warnings", "--no-cache-dir", "--flat-playlist", "--dump-json", "--playlist-end", String(count), `ytsearch${count}:${String(query).trim()}`],
    { timeout: 90_000 }
  );
  if (res.code !== 0) {
    throw Object.assign(new Error(res.spawnError ? "yt-dlp tidak terpasang di server" : res.stderr.trim().split("\n").pop() || "yt-dlp gagal"), { status: 502 });
  }
  const results = [];
  for (const line of res.stdout.split("\n")) {
    if (!line.trim()) continue;
    try {
      const entry = asEntry(JSON.parse(line));
      if (entry.url && entry.title) results.push(entry);
    } catch { /* baris bukan JSON, lewati */ }
  }
  return { results, kind: "search" };
}

export function probeQuery(query, { execute } = {}) {
  const value = String(query ?? "").trim();
  if (!value) throw Object.assign(new Error("Query kosong"), { status: 400 });
  if (isUrl(value)) return resolveOne(value, execute);
  return searchMany(value);
}

export async function downloadSource({ url, clients = [], execute } = {}) {
  if (!isUrl(url)) throw Object.assign(new Error("URL lagu tidak valid"), { status: 400 });

  const dir = path.join(os.tmpdir(), "3zane-convert-source", crypto.randomUUID());
  await fsp.mkdir(dir, { recursive: true });
  const output = path.join(dir, "source.%(ext)s");
  const youtubeTarget = isYoutubeTarget([url]);
  const attempts = youtubeTarget && clients.length ? clients : [null];
  let lastError;

  try {
    for (const client of attempts) {
      for (const file of await fsp.readdir(dir)) {
        await fsp.rm(path.join(dir, file), { recursive: true, force: true });
      }

      const args = [
        "--no-warnings", "--no-playlist", "--no-cache-dir",
        ...(youtubeTarget && client ? ["--extractor-args", `youtube:player_client=${client}`] : []),
        "-f", "bestaudio/best",
        "-o", output,
        "--no-part", "--no-mtime",
        cleanUrl(url),
      ];
      const result = await runYtDlp(args, { timeout: 10 * 60_000, execute });

      if (result.code !== 0) {
        const tail = result.stderr.trim().split("\n").filter(Boolean).pop()
          || (result.spawnError ? "yt-dlp tidak terpasang di server" : "yt-dlp gagal mengunduh");
        lastError = Object.assign(new Error(tail.slice(0, 220)), { status: 502 });
        const retryable = youtubeTarget && /sign in|bot|403|forbidden|unable to extract|no video formats|player response|requested format|page needs to be reloaded|format is not available/i.test(result.stderr);
        if (!retryable || client === attempts[attempts.length - 1]) throw lastError;
        continue;
      }

      const files = (await fsp.readdir(dir)).filter((file) => file.startsWith("source."));
      if (!files.length) throw new Error("yt-dlp tidak menghasilkan file audio");

      const sourcePath = path.join(dir, files[0]);
      const stat = await fsp.stat(sourcePath);
      if (!stat.isFile() || stat.size <= 0) throw new Error("yt-dlp menghasilkan file audio kosong");

      return {
        path: sourcePath,
        client: client || "default",
        cleanup: () => fsp.rm(dir, { recursive: true, force: true }),
      };
    }
    throw lastError || new Error("yt-dlp gagal mengunduh");
  } catch (error) {
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

/* --------------------------------- job ---------------------------------- */

const jobs = new Map();            // jobId -> { ... , at }
const jobDir = (jobId) => path.join(MUSIC_DIR, jobId);

function sweepJobs() {
  const now = Date.now();
  for (const [id, job] of jobs) {
    if (now - job.at > JOB_TTL_MS) {
      jobs.delete(id);
      fsp.rm(jobDir(id), { recursive: true, force: true }).catch(() => {});
    }
  }
}

function getJob(jobId) {
  const job = jobs.get(String(jobId));
  if (!job) return null;
  if (Date.now() - job.at > JOB_TTL_MS) {
    jobs.delete(job.id);
    return null;
  }
  job.at = Date.now();
  return job;
}

/** Hanya dukung file di dalam MUSIC_DIR - cegah path traversal. */
export function jobFile(jobId) {
  const job = getJob(jobId);
  if (!job) return null;
  const target = path.resolve(jobDir(job.id), job.filename);
  if (!target.startsWith(path.resolve(MUSIC_DIR) + path.sep)) return null;
  return { job, path: target, size: job.bytes };
}

export async function ensureDir() {
  await fsp.mkdir(MUSIC_DIR, { recursive: true });
  // Map job cuma hidup di memory, jadi file sisa dari run sebelumnya
  // nggak akan pernah dipakai lagi - buang sekarang biar nggak numpuk.
  for (const entry of await fsp.readdir(MUSIC_DIR, { withFileTypes: true }).catch(() => [])) {
    await fsp.rm(path.join(MUSIC_DIR, entry.name), { recursive: true, force: true }).catch(() => {});
  }
  sweepJobs();
}

const MAX_MUSIC_BYTES = Number(process.env.MAX_MUSIC_BYTES || 24 * 1024 * 1024);

async function encode(source, target, { speed, db, bitrate }) {
  const filter = `${atempoChain(speed)},volume=${db}dB`;
  const res = await run(
    FFMPEG,
    ["-y", "-hide_banner", "-loglevel", "error", "-i", source, "-vn", "-filter:a", filter, "-ar", "44100", "-ac", "2", "-codec:a", "libmp3lame", "-b:a", `${bitrate}k`, target],
    { timeout: 10 * 60_000 }
  );
  return res;
}

/**
 * Unduh lagu, terapkan speed + dB, encode MP3, simpan sebagai job.
 * Kalau MP3 terlalu besar untuk Roblox, turunkan bitrate sampai muat.
 */
export async function prepare({ url, speed, db, title, artist, maxSeconds = MAX_SOURCE_SECONDS }) {
  if (!isUrl(url)) throw Object.assign(new Error("URL lagu tidak valid"), { status: 400 });

  const jobId = crypto.randomUUID();
  const dir = jobDir(jobId);
  await fsp.mkdir(dir, { recursive: true });

  const wantedSpeed = normalizeSpeed(speed);
  const wantedDb = normalizeDb(db);
  const limit = clampInt(maxSeconds, 30, MAX_SOURCE_SECONDS, MAX_SOURCE_SECONDS);

  const source = path.join(dir, "src.%(ext)s");
  const dl = await runYtDlp(
    [
      "--no-warnings", "--no-playlist", "--no-cache-dir",
      "-f", "bestaudio/best",
      "-o", source,
      "--match-filter", `duration < ${limit}`,
      "--no-part", "--no-mtime",
      cleanUrl(url),
    ],
    { timeout: 10 * 60_000 }
  );

  if (dl.code !== 0) {
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
    const tail = dl.stderr.trim().split("\n").filter(Boolean).pop() || "yt-dlp gagal mengunduh";
    const friendly = /requested format is not available|is not a valid URL|unable to extract|video unavailable|private video|members-only/i.test(tail)
      ? "Link tidak bisa diakses (privat, dihapus, atau memblokir download)"
      : /match_filter|Skipping|Duration|Sign in|confirm you.?re not a bot|cookies/i.test(tail)
        ? "Lagu terlalu panjang, perlu login, atau diblokir rate limit"
        : tail;
    throw Object.assign(new Error(friendly.slice(0, 220)), { status: 502 });
  }

  const files = (await fsp.readdir(dir)).filter((f) => f.startsWith("src."));
  if (!files.length) {
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
    throw new Error("yt-dlp tidak menghasilkan file audio");
  }
  const sourcePath = path.join(dir, files[0]);

  const filename = "audio.mp3";
  const target = path.join(dir, filename);

  let encoded = await encode(sourcePath, target, { speed: wantedSpeed, db: wantedDb, bitrate: BITRATE_LADDER[0] });
  if (encoded.code !== 0) {
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
    throw new Error(`ffmpeg gagal: ${(encoded.stderr || "").trim().split("\n").pop() || "unknown"}`.slice(0, 220));
  }

  let stat = await fsp.stat(target);
  let bitrate = BITRATE_LADDER[0];
  for (const next of BITRATE_LADDER.slice(1)) {
    if (stat.size <= MAX_MUSIC_BYTES) break;
    const retry = await encode(sourcePath, target, { speed: wantedSpeed, db: wantedDb, bitrate: next });
    if (retry.code !== 0) break;
    stat = await fsp.stat(target);
    bitrate = next;
  }

  await fsp.rm(sourcePath, { force: true }).catch(() => {});

  if (stat.size > MAX_MUSIC_BYTES) {
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
    throw new Error(`File ${(stat.size / 1048576).toFixed(1)}MB melebihi batas ${(MAX_MUSIC_BYTES / 1048576).toFixed(0)}MB`);
  }

  const finalTitle = smartTitle(title, 100, artist);
  const job = {
    id: jobId,
    filename,
    bytes: stat.size,
    bitrate,
    speed: wantedSpeed,
    db: wantedDb,
    gameSpeed: inGameSpeed(wantedSpeed),
    title: finalTitle,
    artist: String(artist ?? "").trim().slice(0, 100),
    sourceUrl: cleanUrl(url),
    at: Date.now(),
  };
  jobs.set(jobId, job);
  sweepJobs();
  return job;
}

export const musicSettings = { minSpeed: MIN_SPEED, maxSpeed: MAX_SPEED, minDb: MIN_DB, maxDb: MAX_DB, defaultDb: DEFAULT_DB, maxBytes: MAX_MUSIC_BYTES };
