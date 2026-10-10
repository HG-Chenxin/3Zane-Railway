/**
 * Lapisan Roblox: identitas creator, thumbnail, dan Open Cloud Assets API.
 *
 * Semua request tanpa auth kecuali yang butuh API key. API key nggak pernah
 * ditulis ke log atau disk - cuma dipakai sekali per request.
 */
import crypto from "node:crypto";

const UA = "Roblox/WinInet";
const API_HOST = "https://apis.roblox.com";

const json = async (url, { headers = {}, timeout = 8000 } = {}) => {
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": UA, Accept: "application/json", ...headers },
      signal: AbortSignal.timeout(timeout),
    });
    if (!res.ok) return null;
    return await res.json().catch(() => null);
  } catch {
    return null;
  }
};

/* ------------------------------ identitas ------------------------------ */

export async function fetchUser(userId) {
  const data = await json(`https://users.roblox.com/v1/users/${userId}`);
  if (!data?.id) return null;
  return {
    kind: "user",
    id: String(data.id),
    name: data.name || `User ${data.id}`,
    displayName: data.displayName || data.name || `User ${data.id}`,
  };
}

export async function fetchGroup(groupId) {
  const data = await json(`https://groups.roblox.com/v1/groups/${groupId}`);
  if (!data?.id) return null;
  return {
    kind: "group",
    id: String(data.id),
    name: data.name || `Group ${groupId}`,
    displayName: data.name || `Group ${groupId}`,
  };
}

export function resolveCreator(type, id) {
  return type === "group" ? fetchGroup(id) : fetchUser(id);
}

/* ------------------------------ thumbnail ------------------------------ */

/*
 * thumbnails.roblox.com/v1 sudah dimatikan (balas 404 global), jadi URL
 * avatar diambil dari meta tag og:image halaman profil publik. Signature di
 * URL itu dibuat CDN Roblox; kita cuma pakai yang sudah jadi.
 */
const thumbCache = new Map();      // "user:1" -> { url, at }
const THUMB_TTL_MS = 6 * 60 * 60 * 1000;
const MAX_THUMB_CACHE_ENTRIES = 1000;
const inflight = new Map();

const OG_RE = /<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i;

async function scrapeOgImage(url, cacheKey) {
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122 Safari/537.36",
        Accept: "text/html",
      },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    const html = await res.text();
    const hit = html.match(OG_RE);
    const imageUrl = hit?.[1] || null;
    if (imageUrl) {
      const now = Date.now();
      thumbCache.delete(cacheKey);
      thumbCache.set(cacheKey, { url: imageUrl, at: now });
      for (const [key, entry] of thumbCache) {
        if (now - entry.at >= THUMB_TTL_MS) thumbCache.delete(key);
      }
      while (thumbCache.size > MAX_THUMB_CACHE_ENTRIES) {
        thumbCache.delete(thumbCache.keys().next().value);
      }
    }
    return imageUrl;
  } catch {
    return null;
  }
}

export function thumbnail(kind, id) {
  const key = `${kind}:${id}`;
  const hit = thumbCache.get(key);
  if (hit) {
    if (Date.now() - hit.at < THUMB_TTL_MS) return Promise.resolve(hit.url);
    thumbCache.delete(key);
  }
  if (inflight.has(key)) return inflight.get(key);

  const page = kind === "group" ? `https://www.roblox.com/groups/${id}` : `https://www.roblox.com/users/${id}/profile`;
  const task = scrapeOgImage(page, key)
    .finally(() => inflight.delete(key));

  inflight.set(key, task);
  return task;
}

/* --------------------------- validasi API key -------------------------- */

/**
 * Nggak ada endpoint "validate key" resmi. Yang bisa kita pakai: request ke
 * salah satu route Assets API. 401 + "Invalid API Key" = key salah,
 * 403/404 atau 2xx = key diterima (izin atau objeknya mungkin bermasalah).
 * Status lain tidak cukup untuk menyimpulkan bahwa key valid.
 */
export async function verifyApiKey(apiKey) {
  const res = await fetch(`${API_HOST}/assets/v1/assets/1`, {
    headers: { "x-api-key": apiKey, "User-Agent": UA },
    signal: AbortSignal.timeout(10_000),
  }).catch(() => null);

  if (!res) return { valid: false, reason: "Server Roblox tidak merespons" };

  const body = await res.text().catch(() => "");
  if (res.status === 401) {
    return { valid: false, reason: "API key ditolak Roblox", detail: body.slice(0, 200) };
  }
  if (res.status === 403) {
    return { valid: true, reason: "Key hidup, tapi butuh izin Assets API" };
  }
  if (res.status === 404 || (res.status >= 200 && res.status < 300)) {
    return { valid: true, reason: "Key hidup" };
  }
  return {
    valid: false,
    reason: `Roblox tidak dapat memverifikasi API key (HTTP ${res.status})`,
    detail: body.slice(0, 200),
  };
}

/* ---------------------------- Assets API ------------------------------- */

function multipart(fields, file) {
  const boundary = `----rad${crypto.randomBytes(16).toString("hex")}`;
  const parts = [];
  for (const [name, value] of Object.entries(fields)) {
    parts.push(
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`, "utf8")
    );
  }
  if (file) {
    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${file.field}"; filename="${file.name}"\r\n` +
          `Content-Type: ${file.type}\r\n\r\n`,
        "utf8"
      ),
      file.buffer,
      Buffer.from("\r\n", "utf8")
    );
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`, "utf8"));
  return { boundary, body: Buffer.concat(parts) };
}

/**
 * Upload asset lewat Open Cloud Assets API. Returns { assetId } setelah
 * operation-nya selesai diproses Roblox.
 */
export async function uploadAsset({ apiKey, creatorType, creatorId, assetType, displayName, description = "", buffer, filename, mime }) {
  const creator = creatorType === "group" ? { groupId: String(creatorId) } : { userId: String(creatorId) };
  const request = JSON.stringify({ assetType, displayName, description, creationContext: { creator } });

  const form = multipart(
    { request },
    { field: "fileContent", name: filename, type: mime, buffer }
  );

  const res = await fetch(`${API_HOST}/assets/v1/assets`, {
    method: "POST",
    headers: { "x-api-key": apiKey, "User-Agent": UA, "Content-Type": `multipart/form-data; boundary=${form.boundary}` },
    body: form.body,
    signal: AbortSignal.timeout(60_000),
  }).catch(() => null);

  if (!res) throw Object.assign(new Error("Server Roblox tidak merespons"), { status: 502 });
  const text = await res.text();
  if (!res.ok) {
    let message = text.slice(0, 300);
    try {
      const parsed = JSON.parse(text);
      message = parsed?.errors?.[0]?.message || parsed?.message || message;
    } catch { /* body bukan JSON */ }
    throw Object.assign(new Error(message || `HTTP ${res.status}`), { status: res.status });
  }

  let initial;
  try {
    initial = JSON.parse(text);
  } catch {
    throw new Error("Balasan Roblox bukan JSON");
  }

  const operationId = initial.operationId || initial.path?.split("/").pop();
  if (!operationId) {
    const direct = initial.assetId || initial.asset?.id;
    if (direct) return { assetId: String(direct), operationId: null };
    throw new Error(`operationId tidak ditemukan di balasan: ${text.slice(0, 200)}`);
  }

  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1_500));
    const poll = await fetch(`${API_HOST}/assets/v1/operations/${encodeURIComponent(operationId)}`, {
      headers: { "x-api-key": apiKey, "User-Agent": UA },
      signal: AbortSignal.timeout(15_000),
    }).catch(() => null);
    if (!poll) continue;
    const data = await poll.json().catch(() => null);
    if (!data) continue;
    if (data.done) {
      if (data.error) {
        const msg = data.error.message || JSON.stringify(data.error);
        throw new Error(`Operasi gagal: ${msg}`);
      }
      const assetId = data.response?.assetId;
      if (!assetId) throw new Error(`Operasi selesai tanpa assetId: ${JSON.stringify(data).slice(0, 200)}`);
      return { assetId: String(assetId), operationId };
    }
  }
  throw new Error(`Operation ${operationId} tidak selesai dalam 90 detik`);
}

/* --------------------------- status moderasi --------------------------- */

const NORMALIZE = (value) => String(value ?? "").replace(/[\s_-]+/g, "").toLowerCase();

const MODERATION_LABELS = {
  approved: { state: "approved", label: "Disetujui" },
  passed: { state: "approved", label: "Disetujui" },
  success: { state: "approved", label: "Disetujui" },
  moderating: { state: "pending", label: "Sedang direview" },
  pendingreview: { state: "pending", label: "Menunggu review" },
  pending: { state: "pending", label: "Menunggu moderasi" },
  inflight: { state: "pending", label: "Diproses" },
  unmoderated: { state: "pending", label: "Belum dimoderasi" },
  reviewing: { state: "pending", label: "Sedang direview" },
  rejected: { state: "rejected", label: "Ditolak" },
  failed: { state: "rejected", label: "Ditolak" },
  error: { state: "rejected", label: "Ditolak" },
  restricted: { state: "rejected", label: "Dibatasi" },
  unpublishable: { state: "rejected", label: "Tidak bisa dipublikasikan" },
};

const dig = (obj, depth = 0) => {
  if (!obj || typeof obj !== "object" || depth > 4) return [];
  const out = [];
  for (const [key, value] of Object.entries(obj)) {
    if (/status|state|moderation|review/i.test(key)) {
      if (typeof value === "string") out.push({ key, value });
      else if (value && typeof value === "object") {
        for (const [k2, v2] of Object.entries(value)) {
          if (typeof v2 === "string" && /status|state|name|reason/i.test(k2)) out.push({ key: `${key}.${k2}`, value: v2 });
        }
      }
    } else if (typeof value === "object" && value) {
      out.push(...dig(value, depth + 1));
    }
  }
  return out;
};

/**
 * Baca status moderasi sebuah asset. Field balasan Assets API berubah-ubah,
 * jadi kita scan rekursif dan ambil kandidat pertama yang peta MODERATION_LABELS-nya kena.
 */
export async function assetStatus(apiKey, assetId) {
  const res = await fetch(`${API_HOST}/assets/v1/assets/${encodeURIComponent(assetId)}`, {
    headers: { "x-api-key": apiKey, "User-Agent": UA },
    signal: AbortSignal.timeout(15_000),
  }).catch(() => null);

  if (!res) return { ok: false, error: "Server Roblox tidak merespons" };

  const text = await res.text().catch(() => "");
  if (!res.ok) {
    let message = `HTTP ${res.status}`;
    try {
      const parsed = JSON.parse(text);
      message = parsed?.errors?.[0]?.message || message;
    } catch { /* bukan JSON */ }
    if (res.status === 401) return { ok: false, error: "API key ditolak" };
    return { ok: false, error: message.slice(0, 200), status: res.status };
  }

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return { ok: false, error: "Balasan bukan JSON" };
  }

  const candidates = dig(data);
  let raw = null;
  let source = null;
  for (const c of candidates) {
    if (MODERATION_LABELS[NORMALIZE(c.value)]) {
      raw = c.value;
      source = c.key;
      break;
    }
  }

  const asset = data.asset || data.data?.asset || data;
  const matched = MODERATION_LABELS[NORMALIZE(raw)] || null;

  return {
    ok: true,
    state: matched?.state || "unknown",
    label: matched?.label || (raw ? String(raw) : "Tidak diketahui"),
    raw: raw || null,
    source,
    name: asset?.displayName || asset?.name || null,
    creatorType: asset?.creator?.type || asset?.creatorType || null,
    creatorId: asset?.creator?.id ? String(asset.creator.id) : asset?.creatorId ? String(asset.creatorId) : null,
    assetType: asset?.assetType || asset?.assetTypeId || null,
  };
}
