const axios = require('axios');
const archiver = require('archiver');
const crypto = require('node:crypto');
const fs = require('node:fs');
const fsPromises = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { Readable, Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { MAX_SPOOFER_ASSETS_PER_BATCH } = require('./account-limits');
const { createContentLengthVerifier } = require('./spoofer-worker/download-integrity');

const MAX_ERROR_BYTES = 64 * 1024;
const UPSTREAM_TIMEOUT_MS = 180_000;
const MAX_BULK_ASSETS = MAX_SPOOFER_ASSETS_PER_BATCH;
const MAX_RATE_LIMIT_RETRIES = 10;
const MAX_RETRY_AFTER_MS = 5 * 60 * 1000;
const FORBIDDEN_RETRY_DELAYS_MS = [1_000, 3_000];

function retryDelayMs(response, retryCount) {
    const retryAfter = response.headers?.['retry-after'];
    if (typeof retryAfter === 'string' && /^\d+(?:\.\d+)?$/.test(retryAfter)) {
        return Math.min(MAX_RETRY_AFTER_MS, Number(retryAfter) * 1000);
    }
    if (typeof retryAfter === 'string') {
        const retryAt = Date.parse(retryAfter);
        if (Number.isFinite(retryAt)) return Math.min(MAX_RETRY_AFTER_MS, Math.max(0, retryAt - Date.now()));
    }
    return Math.min(60_000, 1000 * (2 ** (retryCount - 1)));
}

function matchesApiKey(expected, supplied) {
    if (!expected || typeof supplied !== 'string') return false;
    const expectedBuffer = Buffer.from(expected);
    const suppliedBuffer = Buffer.from(supplied);
    return expectedBuffer.length === suppliedBuffer.length
        && crypto.timingSafeEqual(expectedBuffer, suppliedBuffer);
}

function validateDownloadInput(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
        return { error: 'Request body harus berupa JSON object.' };
    }

    const { assetId, cookie, placeId } = body;
    if (typeof assetId !== 'string' || !/^\d{1,20}$/.test(assetId)) {
        return { error: 'assetId wajib berupa ID numerik Roblox.' };
    }
    if (typeof cookie !== 'string' || !cookie.trim() || cookie.length > 4096) {
        return { error: 'cookie .ROBLOSECURITY wajib diisi dan maksimal 4096 karakter.' };
    }
    if (placeId !== undefined && placeId !== '' && (typeof placeId !== 'string' || !/^\d{1,20}$/.test(placeId))) {
        return { error: 'placeId harus berupa ID numerik Roblox.' };
    }

    return {
        value: {
            assetId,
            cookie: cookie.trim(),
            ...(placeId ? { placeId } : {}),
        },
    };
}

function safeArchiveName(name, fallback) {
    const baseName = String(name || fallback)
        .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
        .replace(/^\.+/, '')
        .trim()
        .slice(0, 180);
    return baseName || fallback;
}

function attachmentDisposition(name) {
    const fileName = safeArchiveName(name, 'asset.bin');
    const fallback = fileName.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
    const encoded = encodeURIComponent(fileName).replace(/[!'()*]/g, (character) =>
        `%${character.charCodeAt(0).toString(16).toUpperCase()}`
    );
    return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

async function parseUpstreamError(data, status) {
    const chunks = [];
    let size = 0;
    const source = Buffer.isBuffer(data) || data instanceof Uint8Array
        ? Readable.from([data])
        : data;
    if (!source || typeof source[Symbol.asyncIterator] !== 'function') {
        return `Download gagal (HTTP ${status}).`;
    }

    for await (const chunk of source) {
        const remaining = MAX_ERROR_BYTES - size;
        if (remaining <= 0) break;
        const bytes = Buffer.from(chunk).subarray(0, remaining);
        chunks.push(bytes);
        size += bytes.length;
        if (bytes.length < chunk.length) break;
    }

    try {
        const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        return String(payload?.error || payload?.message || `Download gagal (HTTP ${status}).`).slice(0, 400);
    } catch {
        return `Download gagal (HTTP ${status}).`;
    }
}

function toReadableStream(data) {
    if (Buffer.isBuffer(data) || data instanceof Uint8Array) return Readable.from([data]);
    if (data && typeof data.pipe === 'function') return data;
    throw new TypeError('Downloader returned an invalid asset stream.');
}

function createRobloxAssetDownloadHandler({
    apiKey = '',
    downloaderUrl = '',
    upstreamAuthHeader = 'X-API-Key',
    post = axios.post,
}) {
    const targetUrl = String(downloaderUrl).trim().replace(/\/+$/, '');

    return async function handleRobloxAssetDownload(req, res) {
        if (!apiKey) {
            return res.status(503).json({
                error: 'API key endpoint download belum dikonfigurasi.',
                code: 'API_NOT_CONFIGURED',
            });
        }
        if (!matchesApiKey(apiKey, req.get?.('x-api-key') || req.headers?.['x-api-key'])) {
            return res.status(401).json({ error: 'API key tidak valid.', code: 'UNAUTHORIZED' });
        }
        if (!targetUrl) {
            return res.status(503).json({ error: 'Layanan downloader belum dikonfigurasi.', code: 'DOWNLOADER_UNAVAILABLE' });
        }

        const parsed = validateDownloadInput(req.body);
        if (parsed.error) return res.status(400).json({ error: parsed.error, code: 'INVALID_REQUEST' });

        const abortController = new AbortController();
        const abortRequest = () => abortController.abort();
        req.once?.('aborted', abortRequest);

        try {
            const upstream = await post(`${targetUrl}/api/download`, parsed.value, {
                timeout: UPSTREAM_TIMEOUT_MS,
                maxBodyLength: 8192,
                responseType: 'stream',
                signal: abortController.signal,
                validateStatus: () => true,
                headers: {
                    'Content-Type': 'application/json',
                    [upstreamAuthHeader]: apiKey,
                },
            });

            if (upstream.status < 200 || upstream.status >= 300) {
                const chunks = [];
                let size = 0;
                for await (const chunk of upstream.data) {
                    size += chunk.length;
                    if (size > MAX_ERROR_BYTES) {
                        upstream.data.destroy();
                        return res.status(502).json({
                            error: 'Layanan downloader mengembalikan respons error terlalu besar.',
                            code: 'INVALID_UPSTREAM_RESPONSE',
                        });
                    }
                    chunks.push(chunk);
                }

                let payload = { error: 'Asset download gagal.', code: 'DOWNLOAD_FAILED' };
                try {
                    const parsedPayload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
                    if (parsedPayload && typeof parsedPayload === 'object' && !Array.isArray(parsedPayload)) {
                        payload = parsedPayload;
                    }
                } catch {
                    // Return a safe JSON error when the downloader did not return JSON.
                }
                return res.status(upstream.status).json(payload);
            }

            const headers = upstream.headers || {};
            res.status(upstream.status);
            for (const name of ['content-type', 'content-disposition', 'content-length', 'x-asset-filename', 'x-place-id']) {
                if (typeof headers[name] === 'string') res.setHeader(name, headers[name]);
            }
            res.setHeader('Cache-Control', 'no-store');
            res.setHeader('X-Content-Type-Options', 'nosniff');
            res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition, X-Asset-Filename, X-Place-Id');
            await pipeline(upstream.data, res);
        } catch (error) {
            if (req.aborted || error.code === 'ERR_CANCELED') return;
            console.error('[ROBLOX DOWNLOAD] Downloader request failed:', error.code || error.message);
            if (res.headersSent) {
                res.destroy(error);
                return;
            }
            const timedOut = error.code === 'ECONNABORTED';
            return res.status(timedOut ? 504 : 502).json({
                error: timedOut ? 'Permintaan ke downloader melewati batas waktu.' : 'Layanan downloader tidak dapat dijangkau.',
                code: timedOut ? 'DOWNLOADER_TIMEOUT' : 'DOWNLOADER_UNAVAILABLE',
            });
        } finally {
            req.removeListener?.('aborted', abortRequest);
        }
    };
}

function createRobloxAssetBulkDownloadHandler({
    apiKey = '',
    downloaderUrl = '',
    post = axios.post,
    createArchive = archiver,
    tempDirectory = os.tmpdir(),
    maxConcurrentJobs = 2,
    maxQueuedJobs = 50,
    maxTotalBytes = 2 * 1024 ** 3,
    maxAssetsPerBatch = MAX_BULK_ASSETS,
    jobRetentionMs = 24 * 60 * 60 * 1000,
    retainLocalFiles = true,
    getOwnerKey = () => null,
    onJobAccepted = async () => {},
    onJobUpdate = async () => {},
    onAssetReady = async () => {},
    onJobReady = async () => {},
    onJobCleanup = async () => {},
}) {
    if (!Number.isInteger(maxConcurrentJobs) || maxConcurrentJobs < 1) {
        throw new RangeError('Maximum concurrent Roblox bulk download jobs must be a positive integer.');
    }
    if (!Number.isInteger(maxQueuedJobs) || maxQueuedJobs < 0) {
        throw new RangeError('Maximum queued Roblox bulk download jobs must be a non-negative integer.');
    }
    if (!Number.isSafeInteger(maxTotalBytes) || maxTotalBytes < 1) {
        throw new RangeError('Maximum Roblox bulk download size must be a positive safe integer.');
    }
    if (!Number.isSafeInteger(jobRetentionMs) || jobRetentionMs < 1) {
        throw new RangeError('Roblox bulk download job retention must be a positive safe integer.');
    }
    if (!Number.isInteger(maxAssetsPerBatch) || maxAssetsPerBatch < 1 || maxAssetsPerBatch > MAX_BULK_ASSETS) {
        throw new RangeError(`Maximum Roblox assets per batch must be between 1 and ${MAX_BULK_ASSETS}.`);
    }
    const targetUrl = String(downloaderUrl).trim().replace(/\/+$/, '');
    const progressJobs = new Map();
    const activeJobsByOwner = new Map();
    const waitingJobs = [];
    let activeJobs = 0;

    function releaseOwnerJob(ownerKey) {
        const remaining = (activeJobsByOwner.get(ownerKey) || 1) - 1;
        if (remaining) activeJobsByOwner.set(ownerKey, remaining);
        else activeJobsByOwner.delete(ownerKey);
    }

    function startJob(entry) {
        entry.job.state = 'processing';
        entry.job.queuePosition = null;
        entry.job.updatedAt = Date.now();
        void Promise.resolve()
            .then(entry.persist)
            .then(entry.run)
            .catch(async (error) => {
                await entry.fail(error);
            })
            .finally(() => {
                activeJobs -= 1;
                releaseOwnerJob(entry.ownerKey);
                pumpQueue();
            });
    }

    function pumpQueue() {
        while (activeJobs < maxConcurrentJobs && waitingJobs.length) {
            const entry = waitingJobs[0];
            if (!entry.accepted) return;
            waitingJobs.shift();
            activeJobs += 1;
            startJob(entry);
        }
        waitingJobs.forEach((entry, index) => {
            entry.job.queuePosition = index + 1;
        });
    }

    function scheduleProgressCleanup(progressId, job) {
        if (['queued', 'processing', 'packaging'].includes(job.state)) return;
        clearTimeout(job.cleanupTimer);
        job.cleanupTimer = setTimeout(() => {
            if (progressJobs.get(progressId) !== job) return;
            if (job.activeDownloads > 0) {
                scheduleProgressCleanup(progressId, job);
                return;
            }
            progressJobs.delete(progressId);
            void onJobCleanup({ progressId, job }).catch((error) => {
                console.error('[ROBLOX DOWNLOAD V2] Failed to clean up remote job files:', error.message);
            });
            void fsPromises.rm(job.tempDir, { recursive: true, force: true }).catch((error) => {
                console.error('[ROBLOX DOWNLOAD V2] Failed to remove expired temporary files:', error.message);
            });
        }, jobRetentionMs);
        job.cleanupTimer.unref?.();
    }

    function pruneProgressJobs(now = Date.now()) {
        for (const [id, job] of progressJobs) {
            if (now - job.updatedAt > jobRetentionMs
                && !['queued', 'processing', 'packaging'].includes(job.state)
                && job.activeDownloads === 0) {
                progressJobs.delete(id);
                clearTimeout(job.cleanupTimer);
                void onJobCleanup({ progressId: id, job }).catch((error) => {
                    console.error('[ROBLOX DOWNLOAD V2] Failed to clean up remote job files:', error.message);
                });
                void fsPromises.rm(job.tempDir, { recursive: true, force: true }).catch((error) => {
                    console.error('[ROBLOX DOWNLOAD V2] Failed to remove expired temporary files:', error.message);
                });
            }
        }
    }

    function getProgress(req, res) {
        pruneProgressJobs();
        const job = progressJobs.get(req.params?.progressId);
        if (!job) {
            return res.status(404).json({ error: 'Progress tidak ditemukan atau sudah kedaluwarsa.', code: 'PROGRESS_NOT_FOUND' });
        }
        if (job.ownerKey !== getOwnerKey(req)) {
            return res.status(404).json({ error: 'Progress tidak ditemukan atau sudah kedaluwarsa.', code: 'PROGRESS_NOT_FOUND' });
        }
        return res.set('Cache-Control', 'no-store').json({
            state: job.state,
            total: job.assets.length,
            queuePosition: job.state === 'queued' ? job.queuePosition : null,
            completed: job.completed,
            succeeded: job.succeeded,
            failed: job.failed,
            totalBytes: job.totalBytes,
            archiveBytes: job.archiveBytes || null,
            error: job.error,
            errorCode: job.errorCode,
            downloadType: job.downloadType,
            fileName: job.fileName,
            downloadUrl: job.downloadUrl,
            elapsedMs: Math.max(0, (job.finishedAt || Date.now()) - job.startedAt),
            assets: job.assets.map((asset) => ({
                ...asset,
                downloadUrl: asset.status === 'success'
                    ? `/api/roblox/spoofer/asset/${req.params.progressId}/${encodeURIComponent(asset.assetId)}`
                    : null,
            })),
        });
    }

    async function streamPreparedFile(req, res, filePath, fileName, contentType, contentLength, job) {
        res.status(200);
        res.setHeader('Content-Type', contentType);
        res.setHeader('Content-Disposition', attachmentDisposition(fileName));
        res.setHeader('Content-Length', String(contentLength));
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('X-Content-Type-Options', 'nosniff');
        job.activeDownloads += 1;
        job.updatedAt = Date.now();
        try {
            await pipeline(fs.createReadStream(filePath), res);
        } catch (error) {
            console.error('[ROBLOX DOWNLOAD V2] Failed to stream prepared file:', error.message);
            if (res.headersSent) res.destroy(error);
            else res.status(500).json({ error: 'Gagal mengirim file hasil download.', code: 'FILE_DOWNLOAD_FAILED' });
        } finally {
            job.activeDownloads -= 1;
            scheduleProgressCleanup(req.params.progressId, job);
        }
    }

    async function getArchive(req, res) {
        pruneProgressJobs();
        const job = progressJobs.get(req.params?.progressId);
        if (!job || job.ownerKey !== getOwnerKey(req) || job.state !== 'ready' || !job.archivePath) {
            return res.status(404).json({
                error: 'Arsip belum siap atau sudah kedaluwarsa.',
                code: 'ARCHIVE_NOT_READY',
            });
        }
        return streamPreparedFile(req, res, job.archivePath, 'roblox-spoofer-assets.zip', 'application/zip', job.archiveBytes, job);
    }

    async function getAsset(req, res) {
        pruneProgressJobs();
        const job = progressJobs.get(req.params?.progressId);
        const assetId = req.params?.assetId;
        if (!job || job.ownerKey !== getOwnerKey(req) || typeof assetId !== 'string' || !/^\d{1,20}$/.test(assetId)) {
            return res.status(404).json({ error: 'File asset tidak ditemukan atau sudah kedaluwarsa.', code: 'ASSET_FILE_NOT_FOUND' });
        }
        const asset = job.assets.find((item) => item.assetId === assetId && item.status === 'success');
        const filePath = job.assetPaths.get(assetId);
        if (!asset || !filePath) {
            return res.status(404).json({ error: 'File asset tidak ditemukan atau sudah kedaluwarsa.', code: 'ASSET_FILE_NOT_FOUND' });
        }
        return streamPreparedFile(req, res, filePath, asset.fileName, 'application/octet-stream', asset.sizeBytes, job);
    }

    const handleDownload = async function handleRobloxAssetBulkDownload(req, res) {
        if (!apiKey) {
            return res.status(503).json({
                error: 'API key endpoint download belum dikonfigurasi.',
                code: 'API_NOT_CONFIGURED',
            });
        }
        if (!targetUrl) {
            return res.status(503).json({
                error: 'Layanan downloader belum dikonfigurasi.',
                code: 'DOWNLOADER_UNAVAILABLE',
            });
        }
        const body = req.body;
        const cookie = typeof body?.roblox_cookie === 'string' ? body.roblox_cookie.trim() : '';
        if (!cookie || cookie.length > 4096) {
            return res.status(400).json({
                error: 'ROBLOSECURITY cookie wajib diisi dan maksimal 4096 karakter.',
                code: 'INVALID_COOKIE',
            });
        }
        const assetIds = Array.isArray(body?.asset_ids)
            ? [...new Set(body.asset_ids.map(String))]
            : [];
        const accountPlan = req.accountPlan?.limits || {};
        const accountMaxAssets = accountPlan.spooferMaxAssetsPerBatch;
        const unlimitedBatch = accountMaxAssets === null;
        const accountMaxBytes = accountPlan.spooferMaxBytesPerBatch ?? maxTotalBytes;
        const accountConcurrentJobs = accountPlan.concurrentSpooferJobs ?? 1;
        if (!assetIds.length || assetIds.some((id) => !/^\d{1,20}$/.test(id))) {
            return res.status(400).json({
                error: 'asset_ids wajib berisi ID numerik Roblox yang valid.',
                code: 'INVALID_ASSET_IDS',
            });
        }
        const effectiveAssetLimit = unlimitedBatch
            ? null
            : Math.min(MAX_BULK_ASSETS, maxAssetsPerBatch, accountMaxAssets ?? maxAssetsPerBatch);
        if (effectiveAssetLimit !== null && assetIds.length > effectiveAssetLimit) {
            return res.status(413).json({
                error: `Paket ${req.accountPlan?.tier || 'Free'} maksimal ${effectiveAssetLimit} asset per batch.`,
                code: 'SPOOFER_BATCH_LIMIT',
            });
        }
        const placeId = body?.place_id === undefined || body.place_id === ''
            ? ''
            : typeof body.place_id === 'string' && /^\d{1,20}$/.test(body.place_id)
                ? body.place_id
                : null;
        if (placeId === null) {
            return res.status(400).json({
                error: 'place_id harus berupa ID numerik Roblox.',
                code: 'INVALID_PLACE_ID',
            });
        }
        const rawPlaceIdHints = body?.place_id_hints === undefined ? [] : body.place_id_hints;
        if (!Array.isArray(rawPlaceIdHints) || rawPlaceIdHints.length > 10
            || rawPlaceIdHints.some((id) => typeof id !== 'string' || !/^\d{1,20}$/.test(id))) {
            return res.status(400).json({
                error: 'place_id_hints harus berupa daftar maksimal 10 ID Place numerik.',
                code: 'INVALID_PLACE_ID_HINTS',
            });
        }
        const placeIdHints = [...new Set(rawPlaceIdHints)];
        const learnedPlaceIdHints = [...placeIdHints];

        const progressId = req.get?.('x-progress-id') || req.headers?.['x-progress-id'];
        if (typeof progressId !== 'string' || !/^[a-f0-9-]{36}$/i.test(progressId)) {
            return res.status(400).json({
                error: 'Header X-Progress-Id wajib berisi UUID.',
                code: 'INVALID_PROGRESS_ID',
            });
        }

        pruneProgressJobs();
        if (progressJobs.has(progressId)) {
            return res.status(409).json({
                error: 'Progress ID sudah pernah digunakan. Buat ID baru untuk batch ini.',
                code: 'PROGRESS_ID_CONFLICT',
            });
        }
        const ownerKey = getOwnerKey(req);
        const ownerActiveJobs = activeJobsByOwner.get(ownerKey) || 0;
        if (ownerKey !== null && ownerActiveJobs >= accountConcurrentJobs) {
            res.setHeader('Retry-After', '15');
            return res.status(429).json({
                error: `Maksimal ${accountConcurrentJobs} job Spoofer aktif untuk akun ini.`,
                code: 'SPOOFER_ACCOUNT_BUSY',
                retryAfterSeconds: 15,
            });
        }
        const startsImmediately = activeJobs < maxConcurrentJobs && waitingJobs.length === 0;
        if (!startsImmediately && waitingJobs.length >= maxQueuedJobs) {
            res.setHeader('Retry-After', '15');
            return res.status(503).json({
                error: 'Antrean Bulk Spoofer sedang penuh. Coba kirim batch lagi setelah ada job selesai.',
                code: 'SPOOFER_QUEUE_FULL',
                retryAfterSeconds: 15,
            });
        }
        if (progressJobs.size >= 500) {
            return res.status(503).json({ error: 'Terlalu banyak progress aktif; coba lagi sebentar.', code: 'PROGRESS_CAPACITY' });
        }

        const customNames = body?.custom_names && typeof body.custom_names === 'object' && !Array.isArray(body.custom_names)
            ? body.custom_names
            : {};
        const results = new Array(assetIds.length);
        let tempDir;
        if (startsImmediately) activeJobs += 1;
        activeJobsByOwner.set(ownerKey, ownerActiveJobs + 1);
        const startedAt = Date.now();
        const batchMaxBytes = Math.min(accountMaxBytes, maxTotalBytes);
        const batchMaxLabel = batchMaxBytes >= 1024 ** 2
            ? `${(batchMaxBytes / (1024 ** 2)).toFixed(1)} MiB`
            : `${batchMaxBytes} bytes`;
        const job = {
            ownerKey,
            quotaReservation: req.spooferQuotaReservation || null,
            quotaSettlement: null,
            maxTotalBytes: batchMaxBytes,
            maxTotalSizeLabel: batchMaxLabel,
            state: startsImmediately ? 'processing' : 'queued',
            queuePosition: startsImmediately ? null : waitingJobs.length + 1,
            startedAt,
            updatedAt: startedAt,
            completed: 0,
            succeeded: 0,
            failed: 0,
            totalBytes: 0,
            archiveBytes: null,
            tempDir: null,
            archivePath: null,
            assetPaths: new Map(),
            activeDownloads: 0,
            cleanupTimer: null,
            finishedAt: null,
            error: null,
            errorCode: null,
            downloadType: null,
            fileName: null,
            downloadUrl: null,
            cancelRequested: false,
            abortControllers: new Set(),
            assets: assetIds.map((assetId) => ({
                assetId,
                name: typeof customNames[assetId] === 'string' ? customNames[assetId].trim() : '',
                status: 'queued',
                sizeBytes: null,
                retryCount: 0,
                extension: null,
                placeId: null,
                elapsedMs: null,
                httpStatus: null,
                assetTypeId: null,
                error: null,
            })),
        };
        progressJobs.set(progressId, job);
        const entry = {
            progressId,
            ownerKey,
            job,
            accepted: false,
            persist: () => persistJobUpdate(),
            run: () => processJob(),
            fail: (error) => handleBackgroundFailure(error),
        };
        job.queueEntry = entry;
        if (!startsImmediately) waitingJobs.push(entry);
        try {
            await onJobAccepted({ progressId, job });
        } catch (error) {
            progressJobs.delete(progressId);
            if (startsImmediately) activeJobs -= 1;
            else {
                const queueIndex = waitingJobs.indexOf(entry);
                if (queueIndex !== -1) waitingJobs.splice(queueIndex, 1);
            }
            releaseOwnerJob(ownerKey);
            if (tempDir) await fsPromises.rm(tempDir, { recursive: true, force: true });
            console.error('[ROBLOX DOWNLOAD V2] Failed to persist accepted job:', error.message);
            pumpQueue();
            return res.status(503).json({
                error: 'Penyimpanan status Spoofer tidak tersedia. Silakan coba kembali.',
                code: 'JOB_STATUS_UNAVAILABLE',
            });
        }
        entry.accepted = true;
        pumpQueue();

        async function persistJobUpdate() {
            try {
                await onJobUpdate({ progressId, job });
            } catch (error) {
                console.error('[ROBLOX DOWNLOAD V2] Failed to persist job progress:', error.message);
            }
        }

        function finishAsset(index, result, startedAssetAt) {
            const elapsedMs = Date.now() - startedAssetAt;
            Object.assign(job.assets[index], result, { elapsedMs });
            job.completed += 1;
            if (result.status === 'success') {
                job.succeeded += 1;
                job.totalBytes += result.sizeBytes || 0;
            }
            else job.failed += 1;
            job.updatedAt = Date.now();
            void persistJobUpdate();
        }

        async function worker(indices = assetIds.map((_, index) => index)) {
            let nextIndex = 0;
            while (true) {
                if (job.cancelRequested) return;
                const index = indices[nextIndex++];
                if (index === undefined) return;
                const assetId = assetIds[index];
                const startedAssetAt = Date.now();
                const abortController = new AbortController();
                job.abortControllers.add(abortController);
                job.assets[index].status = 'processing';
                job.updatedAt = startedAssetAt;
                try {
                    let response;
                    let rateLimitRetries = 0;
                    while (true) {
                        if (job.cancelRequested) throw new Error('SPOOFER_JOB_STOPPED');
                        response = await post(`${targetUrl}/api/download`, {
                            assetId,
                            cookie,
                            ...(placeId ? { placeId } : {}),
                            ...(!placeId && learnedPlaceIdHints.length ? { placeIdHints: [...learnedPlaceIdHints] } : {}),
                        }, {
                            timeout: UPSTREAM_TIMEOUT_MS,
                            signal: abortController.signal,
                            maxBodyLength: 8192,
                            maxContentLength: Infinity,
                            responseType: 'stream',
                            validateStatus: () => true,
                            headers: {
                                'Content-Type': 'application/json',
                                'X-App-Password': apiKey,
                            },
                        });
                        if (response.status !== 429) break;

                        const error = await parseUpstreamError(response.data, response.status);
                        if (rateLimitRetries >= MAX_RATE_LIMIT_RETRIES) {
                            results[index] = {
                                assetId,
                                ok: false,
                                error: `${error} Percobaan ulang otomatis sudah mencapai batas.`,
                            };
                            finishAsset(index, {
                                status: 'failed',
                                error: results[index].error,
                                httpStatus: response.status,
                            }, startedAssetAt);
                            response = null;
                            break;
                        }

                        rateLimitRetries += 1;
                        job.assets[index].retryCount = rateLimitRetries;
                        job.assets[index].error = `HTTP 429 — menunggu sebelum percobaan ulang ${rateLimitRetries}/${MAX_RATE_LIMIT_RETRIES}.`;
                        job.updatedAt = Date.now();
                        await new Promise((resolve) => {
                            const timer = setTimeout(resolve, retryDelayMs(response, rateLimitRetries));
                            abortController.signal.addEventListener('abort', () => {
                                clearTimeout(timer);
                                resolve();
                            }, { once: true });
                        });
                    }
                    if (job.cancelRequested) {
                        response?.data?.destroy?.();
                        throw new Error('SPOOFER_JOB_STOPPED');
                    }
                    if (!response) continue;
                    if (response.status < 200 || response.status >= 300) {
                        const error = await parseUpstreamError(response.data, response.status);
                        results[index] = {
                            assetId,
                            ok: false,
                            error,
                        };
                        finishAsset(index, { status: 'failed', error, httpStatus: response.status }, startedAssetAt);
                        continue;
                    }

                    const rawContentLength = response.headers?.['content-length'];
                    const hasContentLength = rawContentLength !== undefined && rawContentLength !== null;
                    const expectedContentLength = !hasContentLength
                        ? null
                        : typeof rawContentLength === 'number'
                            ? rawContentLength
                            : typeof rawContentLength === 'string' && /^\d+$/.test(rawContentLength)
                                ? Number(rawContentLength)
                                : Number.NaN;
                    if (rawContentLength !== undefined
                        && (!Number.isSafeInteger(expectedContentLength) || expectedContentLength < 0)) {
                        response.data?.destroy?.();
                        const error = new Error('Downloader mengirim ukuran asset yang tidak valid.');
                        error.code = 'ASSET_CONTENT_LENGTH_INVALID';
                        throw error;
                    }

                    const filePath = path.join(tempDir, `${index}.asset`);
                    let sizeBytes = 0;
                    const byteCounter = new Transform({
                        transform(chunk, _encoding, callback) {
                            if (job.totalBytes + sizeBytes + chunk.length > job.maxTotalBytes) {
                                const error = new Error(`Total ukuran asset dalam batch melewati batas ${job.maxTotalSizeLabel}.`);
                                error.code = 'BULK_SIZE_LIMIT';
                                callback(error);
                                return;
                            }
                            sizeBytes += chunk.length;
                            callback(null, chunk);
                        },
                    });
                    const assetStreams = [
                        toReadableStream(response.data),
                        ...(expectedContentLength === null ? [] : [createContentLengthVerifier(expectedContentLength)]),
                        byteCounter,
                        fs.createWriteStream(filePath),
                    ];
                    await pipeline(...assetStreams, { signal: abortController.signal });
                    if (!sizeBytes) {
                        const error = 'Downloader mengembalikan file kosong.';
                        results[index] = { assetId, ok: false, error };
                        finishAsset(index, { status: 'failed', error, httpStatus: response.status }, startedAssetAt);
                        continue;
                    }

                    const name = typeof customNames[assetId] === 'string' ? customNames[assetId].trim() : '';
                    const upstreamName = response.headers?.['x-asset-filename'];
                    const extension = path.extname(upstreamName || '') || '.bin';
                    const nameHasMatchingExtension = name.toLowerCase().endsWith(extension.toLowerCase());
                    const customFileName = name
                        ? `${name}${nameHasMatchingExtension ? '' : extension}`
                        : upstreamName || `Asset ${assetId}${extension}`;
                    const fileName = safeArchiveName(customFileName, `${assetId}.bin`);
                    results[index] = { assetId, ok: true, fileName, filePath, sizeBytes };
                    job.assetPaths.set(assetId, filePath);
                    await onAssetReady({
                        progressId,
                        job,
                        asset: results[index],
                    });
                    const resolvedPlaceId = response.headers?.['x-place-id'];
                    if (!placeId && typeof resolvedPlaceId === 'string' && /^\d{1,20}$/.test(resolvedPlaceId)) {
                        const nextPlaceIdHints = [resolvedPlaceId, ...learnedPlaceIdHints.filter((id) => id !== resolvedPlaceId)];
                        learnedPlaceIdHints.splice(0, learnedPlaceIdHints.length, ...nextPlaceIdHints.slice(0, 10));
                    }
                    finishAsset(index, {
                        status: 'success',
                        fileName,
                        sizeBytes,
                        extension: path.extname(fileName).slice(1).toLowerCase() || 'bin',
                        placeId: typeof response.headers?.['x-place-id'] === 'string'
                            ? response.headers['x-place-id']
                            : null,
                        assetTypeId: /^\d+$/.test(response.headers?.['x-asset-type-id'] || '')
                            ? Number(response.headers['x-asset-type-id'])
                            : null,
                        httpStatus: response.status,
                    }, startedAssetAt);
                } catch (error) {
                    if (job.cancelRequested) {
                        try {
                            await fsPromises.unlink(path.join(tempDir, `${index}.asset`));
                        } catch (cleanupError) {
                            if (cleanupError.code !== 'ENOENT') {
                                console.error('[ROBLOX DOWNLOAD V2] Failed to remove stopped asset:', cleanupError.message);
                            }
                        }
                        results[index] = null;
                        Object.assign(job.assets[index], {
                            status: 'queued',
                            error: null,
                            httpStatus: null,
                            elapsedMs: null,
                        });
                        job.updatedAt = Date.now();
                        void persistJobUpdate();
                        continue;
                    }
                    const timedOut = error.code === 'ECONNABORTED';
                    const storageFailed = ['ENOSPC', 'EACCES', 'EPERM'].includes(error.code);
                    const bucketUploadFailed = error.code === 'SPOOFER_BUCKET_UPLOAD_FAILED';
                    const jobStatusFailed = error.code === 'SPOOFER_JOB_PERSIST_FAILED';
                    const sizeLimitExceeded = error.code === 'BULK_SIZE_LIMIT';
                    const message = timedOut
                        ? 'Request ke downloader melewati batas waktu.'
                        : sizeLimitExceeded
                            ? error.message
                        : bucketUploadFailed
                            ? 'Gagal menyimpan asset hasil ke Railway Bucket.'
                        : jobStatusFailed
                            ? 'Penyimpanan status worker sementara tidak tersedia.'
                        : storageFailed
                            ? 'Penyimpanan sementara server tidak cukup untuk menyiapkan asset.'
                            : 'Layanan downloader tidak dapat dijangkau.';
                    try {
                        await fsPromises.unlink(path.join(tempDir, `${index}.asset`));
                    } catch (cleanupError) {
                        if (cleanupError.code !== 'ENOENT') {
                            console.error('[ROBLOX DOWNLOAD V2] Failed to remove incomplete asset:', cleanupError.message);
                        }
                    }
                    results[index] = {
                        assetId,
                        ok: false,
                        error: message,
                    };
                    finishAsset(index, {
                        status: 'failed',
                        error: message,
                        httpStatus: error.response?.status || null,
                    }, startedAssetAt);
                } finally {
                    job.abortControllers.delete(abortController);
                }
            }
        }

        async function processJob() {
        try {
            tempDir = await fsPromises.mkdtemp(path.join(tempDirectory, '3zane-roblox-spoofer-'));
        } catch (error) {
            if (!error.code) error.code = 'TEMP_STORAGE_UNAVAILABLE';
            throw error;
        }
        job.tempDir = tempDir;
        await worker();
        if (job.cancelRequested) {
            job.state = 'stopped';
            job.error = null;
            job.errorCode = 'SPOOFER_JOB_STOPPED';
            job.finishedAt = Date.now();
            job.updatedAt = job.finishedAt;
            await persistJobUpdate();
            scheduleProgressCleanup(progressId, job);
            return;
        }

        for (let retryRound = 0; retryRound < FORBIDDEN_RETRY_DELAYS_MS.length; retryRound += 1) {
            const retryIndices = results
                .map((item, index) => item && !item.ok && job.assets[index].httpStatus === 403 ? index : -1)
                .filter((index) => index >= 0);
            if (!retryIndices.length) break;

            await new Promise((resolve) => setTimeout(resolve, FORBIDDEN_RETRY_DELAYS_MS[retryRound]));
            if (job.cancelRequested) {
                job.state = 'stopped';
                job.error = null;
                job.errorCode = 'SPOOFER_JOB_STOPPED';
                job.finishedAt = Date.now();
                job.updatedAt = job.finishedAt;
                await persistJobUpdate();
                scheduleProgressCleanup(progressId, job);
                return;
            }
            job.completed -= retryIndices.length;
            job.failed -= retryIndices.length;
            for (const index of retryIndices) {
                const asset = job.assets[index];
                asset.status = 'processing';
                asset.retryCount += 1;
                asset.error = `HTTP 403 — percobaan ulang ${asset.retryCount}, memakai konteks Place ID yang tersedia.`;
            }
            job.updatedAt = Date.now();
            await worker(retryIndices);
        }

        if (job.cancelRequested) {
            job.state = 'stopped';
            job.error = null;
            job.errorCode = 'SPOOFER_JOB_STOPPED';
            job.finishedAt = Date.now();
            job.updatedAt = job.finishedAt;
            await persistJobUpdate();
            scheduleProgressCleanup(progressId, job);
            return;
        }

        const successful = results.filter((item) => item.ok);
        const failed = results.filter((item) => !item.ok);
        if (!successful.length) {
            job.state = 'failed';
            job.error = 'Tidak ada asset yang berhasil diunduh.';
            job.errorCode = 'ALL_DOWNLOADS_FAILED';
            job.finishedAt = Date.now();
            job.updatedAt = job.finishedAt;
            await persistJobUpdate();
            await fsPromises.rm(tempDir, { recursive: true, force: true });
            scheduleProgressCleanup(progressId, job);
            return;
        }

        const usedNames = new Set(['manifest.json', ...(failed.length ? ['download-errors.txt'] : [])]);
        for (const item of successful) {
            if (!usedNames.has(item.fileName.toLowerCase())) {
                usedNames.add(item.fileName.toLowerCase());
                continue;
            }
            const extension = path.extname(item.fileName);
            const baseName = item.fileName.slice(0, -extension.length);
            item.fileName = safeArchiveName(`${baseName} (${item.assetId})${extension}`, `${item.assetId}.bin`);
            usedNames.add(item.fileName.toLowerCase());
            Object.assign(job.assets.find((asset) => asset.assetId === item.assetId), { fileName: item.fileName });
        }

        if (assetIds.length === 1) {
            const [item] = successful;
            await onJobReady({
                progressId,
                job,
                assets: successful,
                archivePath: null,
            });
            job.state = 'ready';
            job.downloadType = 'file';
            job.fileName = item.fileName;
            job.downloadUrl = `/api/roblox/spoofer/asset/${progressId}/${encodeURIComponent(item.assetId)}`;
            job.finishedAt = Date.now();
            job.updatedAt = job.finishedAt;
            await persistJobUpdate();
            scheduleProgressCleanup(progressId, job);
            return;
        }

        job.state = 'packaging';
        job.updatedAt = Date.now();
        const archivePath = path.join(tempDir, 'roblox-spoofer-assets.zip');
        try {
            const expectedAssetBytes = successful.reduce((sum, item) => sum + item.sizeBytes, 0);
            const sourceStats = await Promise.all(successful.map(({ filePath }) => fsPromises.stat(filePath)));
            if (expectedAssetBytes !== job.totalBytes
                || sourceStats.some((stat, index) => !stat.isFile() || stat.size !== successful[index].sizeBytes)) {
                const error = new Error('Ukuran file asset sumber berubah sebelum ZIP dibuat.');
                error.code = 'ARCHIVE_CONTENT_MISMATCH';
                throw error;
            }

            const archive = createArchive('zip', { store: true });
            let processedAssetBytes = 0;
            const completedEntryNames = new Set();
            archive.on('warning', (error) => archive.destroy(error));
            archive.on('progress', (progress) => {
                if (Number.isSafeInteger(progress.fs?.processedBytes)) {
                    processedAssetBytes = progress.fs.processedBytes;
                }
            });
            archive.on('entry', (entry) => completedEntryNames.add(entry.name));

            for (const item of successful) archive.file(item.filePath, { name: item.fileName });
            archive.append(JSON.stringify({
                downloaded: successful.map(({ assetId, fileName, sizeBytes }) => {
                    const details = job.assets.find((item) => item.assetId === assetId);
                    return {
                        assetId,
                        fileName,
                        sizeBytes,
                        extension: details.extension,
                        placeId: details.placeId,
                        assetTypeId: details.assetTypeId,
                        elapsedMs: details.elapsedMs,
                        httpStatus: details.httpStatus,
                    };
                }),
                failed: failed.map(({ assetId, error }) => ({
                    assetId,
                    error,
                    httpStatus: job.assets.find((item) => item.assetId === assetId).httpStatus,
                    elapsedMs: job.assets.find((item) => item.assetId === assetId).elapsedMs,
                })),
            }, null, 2), { name: 'manifest.json' });
            if (failed.length) {
                const errorReport = failed.map(({ assetId, error }) => {
                    const status = job.assets.find((item) => item.assetId === assetId).httpStatus;
                    return `${assetId}${status ? ` (HTTP ${status})` : ''}: ${error}`;
                }).join('\n');
                archive.append(`${errorReport}\n`, { name: 'download-errors.txt' });
            }

            const writing = pipeline(archive, fs.createWriteStream(archivePath));
            await archive.finalize();
            await writing;
            if (processedAssetBytes !== expectedAssetBytes
                || successful.some((item) => !completedEntryNames.has(item.fileName))) {
                const error = new Error('ZIP tidak berisi seluruh data asset yang berhasil diunduh.');
                error.code = 'ARCHIVE_CONTENT_MISMATCH';
                throw error;
            }
            const archiveStat = await fsPromises.stat(archivePath);
            if (archiveStat.size < expectedAssetBytes) {
                const error = new Error('Ukuran ZIP lebih kecil dari data asset yang seharusnya dimuat.');
                error.code = 'ARCHIVE_CONTENT_MISMATCH';
                throw error;
            }
            await onJobReady({
                progressId,
                job,
                assets: successful,
                archivePath,
            });
            if (!retainLocalFiles) {
                try {
                    await fsPromises.rm(tempDir, { recursive: true, force: true });
                    job.archivePath = null;
                    job.assetPaths.clear();
                } catch (error) {
                    console.error('[ROBLOX DOWNLOAD V2] Failed to remove local job files after upload:', error.message);
                }
            }
            job.archivePath = retainLocalFiles ? archivePath : null;
            job.archiveBytes = archiveStat.size;
            job.state = 'ready';
            job.downloadType = 'zip';
            job.fileName = 'roblox-spoofer-assets.zip';
            job.downloadUrl = `/api/roblox/spoofer/archive/${progressId}`;
            job.finishedAt = Date.now();
            job.updatedAt = job.finishedAt;
            await persistJobUpdate();
            scheduleProgressCleanup(progressId, job);
            return;
        } catch (error) {
            const storageFull = error.code === 'ENOSPC';
            const bucketUploadFailed = error.code === 'SPOOFER_BUCKET_UPLOAD_FAILED';
            const jobStatusFailed = error.code === 'SPOOFER_JOB_PERSIST_FAILED';
            const archiveContentMismatch = error.code === 'ARCHIVE_CONTENT_MISMATCH' || error.code === 'ENOENT';
            console.error('[ROBLOX DOWNLOAD V2] Failed to prepare archive:', error.code || error.message);
            job.state = 'failed';
            job.error = storageFull
                ? 'Penyimpanan sementara worker penuh saat membuat arsip. Kurangi jumlah asset dalam batch.'
                : bucketUploadFailed
                    ? 'Gagal menyimpan arsip hasil ke Railway Bucket.'
                : jobStatusFailed
                    ? 'Penyimpanan status worker sementara tidak tersedia.'
                : archiveContentMismatch
                    ? 'ZIP tidak lengkap atau ukuran data asset tidak sesuai. Jalankan ulang batch sebelum mengunduh.'
                : 'Gagal membuat arsip hasil download.';
            job.errorCode = storageFull
                ? 'TEMP_STORAGE_FULL'
                : bucketUploadFailed
                    ? 'BUCKET_UPLOAD_FAILED'
                    : jobStatusFailed
                        ? 'JOB_STATUS_UNAVAILABLE'
                    : archiveContentMismatch
                        ? 'ARCHIVE_INCOMPLETE'
                        : 'ARCHIVE_FAILED';
            job.finishedAt = Date.now();
            job.updatedAt = job.finishedAt;
            await persistJobUpdate();
            try {
                await fsPromises.rm(tempDir, { recursive: true, force: true });
            } catch (cleanupError) {
                console.error('[ROBLOX DOWNLOAD V2] Failed to remove incomplete archive files:', cleanupError.message);
            }
            scheduleProgressCleanup(progressId, job);
            return;
        }
        }

        async function handleBackgroundFailure(error) {
            console.error('[ROBLOX DOWNLOAD V2] Background job failed:', error.code || error.message);
            job.state = 'failed';
            job.error = error.code === 'TEMP_STORAGE_UNAVAILABLE'
                ? 'Server tidak dapat menyiapkan penyimpanan sementara untuk arsip.'
                : 'Unduhan gagal diproses di server.';
            job.errorCode = error.code === 'TEMP_STORAGE_UNAVAILABLE'
                ? 'TEMP_STORAGE_UNAVAILABLE'
                : 'DOWNLOAD_JOB_FAILED';
            job.finishedAt = Date.now();
            job.updatedAt = job.finishedAt;
            await persistJobUpdate();
            if (tempDir) {
                try {
                    await fsPromises.rm(tempDir, { recursive: true, force: true });
                } catch (cleanupError) {
                    console.error('[ROBLOX DOWNLOAD V2] Failed to clean up failed job:', cleanupError.message);
                }
            }
            scheduleProgressCleanup(progressId, job);
        }

        res.status(202).json({
            accepted: true,
            progressId,
            progressUrl: `/api/roblox/spoofer/progress/${progressId}`,
        });
        if (startsImmediately) setImmediate(() => startJob(entry));
    };

    handleDownload.getProgress = getProgress;
    handleDownload.getArchive = getArchive;
    handleDownload.getAsset = getAsset;
    handleDownload.cancel = async (progressId, ownerKey) => {
        pruneProgressJobs();
        const job = progressJobs.get(progressId);
        if (!job || job.ownerKey !== ownerKey) return { found: false };
        if (job.state === 'stopped') return { found: true, stopped: true };
        if (job.state === 'packaging') return { found: true, stopped: false, reason: 'PACKAGING' };
        if (!['queued', 'processing'].includes(job.state)) {
            return { found: true, stopped: false, reason: 'NOT_ACTIVE' };
        }
        job.cancelRequested = true;
        for (const controller of job.abortControllers) controller.abort();
        if (job.state === 'queued') {
            const queueIndex = waitingJobs.indexOf(job.queueEntry);
            if (queueIndex !== -1) waitingJobs.splice(queueIndex, 1);
            job.state = 'stopped';
            job.errorCode = 'SPOOFER_JOB_STOPPED';
            job.finishedAt = Date.now();
            job.updatedAt = job.finishedAt;
            releaseOwnerJob(job.ownerKey);
            await onJobUpdate({ progressId, job });
            scheduleProgressCleanup(progressId, job);
            pumpQueue();
        }
        return { found: true, stopped: job.state === 'stopped' };
    };
    handleDownload.touchProgress = (progressId, ownerKey) => {
        const job = progressJobs.get(progressId);
        if (!job || job.ownerKey !== ownerKey || job.state !== 'ready') return false;
        job.updatedAt = Date.now();
        scheduleProgressCleanup(progressId, job);
        return true;
    };
    handleDownload.persistProgress = async (progressId, ownerKey) => {
        const job = progressJobs.get(progressId);
        if (!job || job.ownerKey !== ownerKey) return false;
        await onJobUpdate({ progressId, job });
        return true;
    };
    handleDownload.getStatus = () => ({
        activeJobs,
        maxConcurrentJobs,
        queuedJobs: waitingJobs.length,
        maxQueuedJobs,
        jobRetentionMs,
        storedProgressJobs: progressJobs.size,
        maxBytesPerJob: maxTotalBytes,
    });
    return handleDownload;
}

module.exports = {
    attachmentDisposition,
    createRobloxAssetBulkDownloadHandler,
    createRobloxAssetDownloadHandler,
    validateDownloadInput,
};
