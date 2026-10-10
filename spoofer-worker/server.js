const express = require('express');
const { Pool } = require('pg');
const fsPromises = require('node:fs/promises');
const { pipeline } = require('node:stream/promises');
const { createContentLengthVerifier } = require('./download-integrity');
const {
    createRailwayObjectStorageFromEnv,
} = require('../railway-object-storage');
const {
    createRobloxAssetBulkDownloadHandler,
    createRobloxAssetDownloadHandler,
    attachmentDisposition,
} = require('../roblox-asset-download');
const {
    MAX_SPOOFER_ASSETS_PER_BATCH,
    PLAN_LIMITS,
    failSpooferJobAfterRestart,
    settleSpooferJobQuota,
} = require('../account-limits');
const { API_RATE_LIMITS } = require('../api-rate-limit');
const { isValidAccountId, matchesSecret } = require('./auth');
const { validateSpooferJobEntitlement } = require('./job-validation');

const PORT = Number(process.env.PORT || 8790);
const API_KEY = (process.env.SPOOFER_WORKER_API_KEY || '').trim();
const DOWNLOADER_URL = (process.env.NEARSX_DOWNLOADER_URL || '').trim();
const DOWNLOADER_KEY = (process.env.ROBLOX_DOWNLOAD_API_KEY || '').trim();
const MAX_ASSETS_PER_BATCH = Number(process.env.SPOOFER_MAX_ASSETS_PER_BATCH || MAX_SPOOFER_ASSETS_PER_BATCH);
const MAX_BYTES_PER_JOB = Number(process.env.SPOOFER_MAX_BYTES_PER_JOB || 2 * 1024 ** 3);
const MAX_CONCURRENT_JOBS = API_RATE_LIMITS.spooferConcurrentJobsPerInstance;
const MAX_QUEUED_JOBS = API_RATE_LIMITS.spooferMaxQueuedJobs;
const BUCKET_PREFIX = (process.env.SPOOFER_BUCKET_PREFIX || 'spoofer').replace(/^\/+|\/+$/g, '');
const JOB_RETENTION_MS = 60 * 60 * 1000;

function requiredEnv(name, value) {
    if (!value) throw new Error(`${name} must be configured.`);
}

requiredEnv('SPOOFER_WORKER_API_KEY', API_KEY);
requiredEnv('NEARSX_DOWNLOADER_URL', DOWNLOADER_URL);
requiredEnv('ROBLOX_DOWNLOAD_API_KEY', DOWNLOADER_KEY);
requiredEnv('DATABASE_URL', process.env.DATABASE_URL);
if (!Number.isInteger(MAX_ASSETS_PER_BATCH) || MAX_ASSETS_PER_BATCH < 1 || MAX_ASSETS_PER_BATCH > MAX_SPOOFER_ASSETS_PER_BATCH) {
    throw new RangeError(`SPOOFER_MAX_ASSETS_PER_BATCH must be between 1 and ${MAX_SPOOFER_ASSETS_PER_BATCH}.`);
}
if (!Number.isSafeInteger(MAX_BYTES_PER_JOB) || MAX_BYTES_PER_JOB < 1) {
    throw new RangeError('SPOOFER_MAX_BYTES_PER_JOB must be a positive safe integer.');
}

const storage = createRailwayObjectStorageFromEnv();
if (!storage) throw new Error('Railway Bucket credentials must be configured on the Spoofer worker.');

const db = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false },
    max: 4,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
});
const filesByJob = new Map();
const persistenceQueues = new Map();
const liveJobs = new Set();
const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '2mb' }));

async function ensureSchema() {
    await db.query(`
        CREATE TABLE IF NOT EXISTS spoofer_worker_jobs (
            progress_id TEXT PRIMARY KEY,
            owner_id TEXT NOT NULL,
            job_state TEXT NOT NULL,
            job_data JSONB NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    `);
    await db.query(`
        CREATE INDEX IF NOT EXISTS spoofer_worker_jobs_owner_updated_idx
        ON spoofer_worker_jobs (owner_id, updated_at DESC)
    `);
}

function safeJobData(job) {
    return {
        state: job.state,
        startedAt: job.startedAt,
        updatedAt: job.updatedAt,
        finishedAt: job.finishedAt,
        completed: job.completed,
        succeeded: job.succeeded,
        failed: job.failed,
        totalBytes: job.totalBytes,
        archiveBytes: job.archiveBytes,
        error: job.error,
        errorCode: job.errorCode,
        downloadType: job.downloadType,
        fileName: job.fileName,
        assets: job.assets,
        remoteFiles: job.remoteFiles || null,
        quotaReservation: job.quotaReservation || null,
        quotaSettlement: job.quotaSettlement || null,
    };
}

function persistJob(progressId, job) {
    const ownerId = String(job.ownerKey);
    const jobState = job.state;
    const jobData = JSON.stringify(safeJobData(job));
    const previous = persistenceQueues.get(progressId) || Promise.resolve();
    const operation = previous.catch(() => {}).then(() => db.query(`
        INSERT INTO spoofer_worker_jobs (progress_id, owner_id, job_state, job_data)
        VALUES ($1, $2, $3, $4::jsonb)
        ON CONFLICT (progress_id) DO UPDATE SET
            job_state = EXCLUDED.job_state,
            job_data = CASE
                WHEN spoofer_worker_jobs.job_data ? 'quotaSettlement'
                    THEN EXCLUDED.job_data || jsonb_build_object(
                        'quotaSettlement',
                        spoofer_worker_jobs.job_data->'quotaSettlement'
                    )
                ELSE EXCLUDED.job_data
            END,
            updated_at = NOW()
    `, [progressId, ownerId, jobState, jobData]));
    persistenceQueues.set(progressId, operation);
    return operation.finally(() => {
        if (persistenceQueues.get(progressId) === operation) persistenceQueues.delete(progressId);
    });
}

async function deleteJobFiles(progressId, job) {
    const files = job.remoteFiles?.all || filesByJob.get(progressId) || [];
    const errors = [];
    for (const key of files) {
        try {
            await storage.deleteObject(key);
        } catch (error) {
            errors.push(error);
        }
    }
    filesByJob.delete(progressId);
    if (errors.length) throw new AggregateError(errors, `Failed to delete ${errors.length} Spoofer objects.`);
    await db.query('DELETE FROM spoofer_worker_jobs WHERE progress_id = $1', [progressId]);
}

async function cleanupExpiredPersistedJobs() {
    const { rows } = await db.query(`
        SELECT progress_id, owner_id, job_state, job_data, updated_at
        FROM spoofer_worker_jobs
        WHERE job_state IN ('queued', 'processing', 'packaging')
            OR updated_at < NOW() - ($1::double precision * INTERVAL '1 millisecond')
            OR (
                job_state IN ('ready', 'failed', 'stopped')
                AND job_data ? 'quotaReservation'
                AND job_data->>'quotaSettlement' IS NULL
            )
        LIMIT 100
    `, [JOB_RETENTION_MS]);
    for (const row of rows) {
        if (liveJobs.has(row.progress_id)) continue;
        if (['queued', 'processing', 'packaging'].includes(row.job_state)) {
            try {
                await failSpooferJobAfterRestart(db, row.progress_id, row.owner_id);
            } catch (error) {
                console.error('[SPOOFER WORKER] Failed to settle restarted job quota:', row.progress_id, error.message);
            }
            continue;
        }
        if (row.job_data.quotaReservation && !row.job_data.quotaSettlement) {
            try {
                row.job_data.quotaSettlement = await settleSpooferJobQuota(db, row.progress_id, row.owner_id);
            } catch (error) {
                console.error('[SPOOFER WORKER] Failed to settle completed job quota:', row.progress_id, error.message);
                continue;
            }
            if (Date.now() - new Date(row.updated_at).getTime() < JOB_RETENTION_MS) continue;
        }
        if (Date.now() - new Date(row.updated_at).getTime() < JOB_RETENTION_MS) continue;
        try {
            await deleteJobFiles(row.progress_id, { remoteFiles: row.job_data.remoteFiles });
        } catch (error) {
            console.error('[SPOOFER WORKER] Failed to clean up expired job:', row.progress_id, error.message);
        }
    }
}

async function uploadJobFiles({ progressId, job, assets, archivePath }) {
    const remoteFiles = job.remoteFiles || { assets: {}, archive: null, all: [] };
    for (const asset of assets) {
        if (!remoteFiles.assets?.[asset.assetId]) {
            const error = new Error('Asset is missing from Railway Bucket.');
            error.code = 'SPOOFER_BUCKET_UPLOAD_FAILED';
            throw error;
        }
    }
    if (!archivePath) return;

    const key = `${BUCKET_PREFIX}/${progressId}/roblox-spoofer-assets.zip`;
    remoteFiles.archive = key;
    if (!remoteFiles.all.includes(key)) remoteFiles.all.push(key);
    job.remoteFiles = remoteFiles;
    try {
        await persistJob(progressId, job);
    } catch (cause) {
        const error = new Error('Failed to persist the Spoofer archive result.', { cause });
        error.code = 'SPOOFER_JOB_PERSIST_FAILED';
        throw error;
    }
    try {
        await storage.uploadFile(archivePath, key, 'application/zip');
    } catch (cause) {
        const error = new Error('Failed to upload the Spoofer archive to Railway Bucket.', { cause });
        error.code = 'SPOOFER_BUCKET_UPLOAD_FAILED';
        throw error;
    }
}

async function uploadJobAsset({ progressId, job, asset }) {
    const remoteFiles = job.remoteFiles || { assets: {}, archive: null, all: [] };
    const key = `${BUCKET_PREFIX}/${progressId}/assets/${asset.assetId}`;
    if (!remoteFiles.assets[asset.assetId]) remoteFiles.all.push(key);
    remoteFiles.assets[asset.assetId] = key;
    job.remoteFiles = remoteFiles;
    try {
        await persistJob(progressId, job);
    } catch (cause) {
        const error = new Error('Failed to persist a Spoofer asset result.', { cause });
        error.code = 'SPOOFER_JOB_PERSIST_FAILED';
        throw error;
    }
    try {
        await storage.uploadFile(asset.filePath, key, 'application/octet-stream');
    } catch (cause) {
        const error = new Error('Failed to upload a Spoofer asset to Railway Bucket.', { cause });
        error.code = 'SPOOFER_BUCKET_UPLOAD_FAILED';
        throw error;
    }
}

function captureProgress(handler, req) {
    const result = { status: 200, body: null };
    const res = {
        status(status) {
            result.status = status;
            return this;
        },
        set() {
            return this;
        },
        json(body) {
            result.body = body;
            return this;
        },
    };
    handler.getProgress(req, res);
    return result;
}

const bulkHandler = createRobloxAssetBulkDownloadHandler({
    apiKey: DOWNLOADER_KEY,
    downloaderUrl: DOWNLOADER_URL,
    maxConcurrentJobs: MAX_CONCURRENT_JOBS,
    maxQueuedJobs: MAX_QUEUED_JOBS,
    maxTotalBytes: MAX_BYTES_PER_JOB,
    maxAssetsPerBatch: MAX_ASSETS_PER_BATCH,
    jobRetentionMs: JOB_RETENTION_MS,
    retainLocalFiles: false,
    getOwnerKey: (req) => req.ownerId,
    onJobAccepted: async ({ progressId, job }) => {
        await persistJob(progressId, job);
        liveJobs.add(progressId);
    },
    onJobUpdate: async ({ progressId, job }) => {
        try {
            await persistJob(progressId, job);
            if (!['queued', 'processing', 'packaging'].includes(job.state)) {
                job.quotaSettlement = await settleSpooferJobQuota(db, progressId, job.ownerKey);
            }
        } finally {
            if (!['queued', 'processing', 'packaging'].includes(job.state)) liveJobs.delete(progressId);
        }
    },
    onAssetReady: uploadJobAsset,
    onJobReady: async (jobData) => {
        await uploadJobFiles(jobData);
        try {
            await fsPromises.rm(jobData.job.tempDir, { recursive: true, force: true });
            jobData.job.archivePath = null;
            jobData.job.assetPaths.clear();
        } catch (error) {
            console.error('[SPOOFER WORKER] Failed to remove local files after bucket upload:', error.message);
        }
    },
    onJobCleanup: ({ progressId, job }) => deleteJobFiles(progressId, job),
});
const singleDownloadHandler = createRobloxAssetDownloadHandler({
    apiKey: DOWNLOADER_KEY,
    downloaderUrl: DOWNLOADER_URL,
    upstreamAuthHeader: 'X-App-Password',
});

function validApiKey(req) {
    const supplied = req.get('x-spoofer-worker-key') || '';
    return matchesSecret(API_KEY, supplied);
}

function requireWorkerKey(req, res, next) {
    if (!validApiKey(req)) {
        return res.status(401).json({ error: 'Unauthorized', code: 'WORKER_AUTH_REQUIRED' });
    }
    next();
}

app.get('/health', (_req, res) => {
    res.json({
        status: 'ok',
        apiVersion: 3,
        supportedTiers: Object.keys(PLAN_LIMITS),
        bucket: 'configured',
        database: 'configured',
        jobs: bulkHandler.getStatus(),
    });
});

app.post('/api/download', singleDownloadHandler);

app.post('/internal/jobs', requireWorkerKey, (req, res, next) => {
    const ownerId = req.get('x-account-id');
    const entitlement = validateSpooferJobEntitlement({
        ownerId,
        tier: req.body?.tier,
        maxAssetsPerBatch: req.body?.maxAssetsPerBatch,
    });
    if (entitlement.error) return res.status(400).json(entitlement);
    const { tier, maxAssetsPerBatch } = entitlement;
    const quotaReservation = req.body?.quotaReservation;
    const assetIds = Array.isArray(req.body?.asset_ids)
        ? [...new Set(req.body.asset_ids.map(String))]
        : [];
    const usageDay = quotaReservation?.usageDay;
    const parsedUsageDay = typeof usageDay === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(usageDay)
        ? new Date(`${usageDay}T00:00:00.000Z`)
        : null;
    const validUsageDay = parsedUsageDay
        && Number.isFinite(parsedUsageDay.getTime())
        && parsedUsageDay.toISOString().slice(0, 10) === usageDay;
    if (!validUsageDay
        || !Number.isSafeInteger(quotaReservation?.reservedAssets)
        || quotaReservation.reservedAssets !== assetIds.length
        || assetIds.length < 1) {
        return res.status(400).json({ error: 'Spoofer quota reservation is invalid.', code: 'INVALID_QUOTA_RESERVATION' });
    }
    req.ownerId = ownerId;
    req.spooferQuotaReservation = {
        usageDay,
        reservedAssets: quotaReservation.reservedAssets,
    };
    req.accountPlan = {
        tier,
        limits: { ...PLAN_LIMITS[tier], spooferMaxAssetsPerBatch: maxAssetsPerBatch },
    };
    req.headers['x-api-key'] = DOWNLOADER_KEY;
    return bulkHandler(req, res, next);
});

app.post('/internal/jobs/:progressId/stop', requireWorkerKey, async (req, res) => {
    const ownerId = req.get('x-account-id');
    if (!isValidAccountId(ownerId)) {
        return res.status(400).json({ error: 'A valid account is required.', code: 'INVALID_JOB_OWNER' });
    }
    const result = await bulkHandler.cancel(req.params.progressId, ownerId);
    if (!result.found) {
        return res.status(404).json({ error: 'Progress tidak ditemukan atau sudah kedaluwarsa.', code: 'PROGRESS_NOT_FOUND' });
    }
    if (!result.stopped && result.reason === 'PACKAGING') {
        return res.status(409).json({ error: 'Arsip sedang disiapkan dan tidak dapat dihentikan.', code: 'JOB_PACKAGING' });
    }
    if (!result.stopped && result.reason === 'NOT_ACTIVE') {
        return res.status(409).json({ error: 'Job sudah selesai dan tidak dapat dihentikan.', code: 'JOB_NOT_ACTIVE' });
    }
    return res.status(202).json({ accepted: true, stopped: result.stopped });
});

app.get('/internal/jobs/:progressId', requireWorkerKey, async (req, res) => {
    const ownerId = req.get('x-account-id');
    if (!isValidAccountId(ownerId)) {
        return res.status(400).json({ error: 'A valid account is required.', code: 'INVALID_JOB_OWNER' });
    }
    const workerReq = { params: req.params, ownerId };
    const inMemory = captureProgress(bulkHandler, workerReq);
    if (inMemory.status === 200) {
        if (!['queued', 'processing', 'packaging'].includes(inMemory.body.state)) {
            await bulkHandler.persistProgress(req.params.progressId, ownerId);
        }
        const refreshed = captureProgress(bulkHandler, workerReq);
        return res.set('Cache-Control', 'no-store').json(withDownloadRoutes(req.params.progressId, refreshed.body));
    }
    if (inMemory.status !== 404) return res.status(inMemory.status).json(inMemory.body);

    const { rows } = await db.query(
        'SELECT owner_id, job_data FROM spoofer_worker_jobs WHERE progress_id = $1',
        [req.params.progressId],
    );
    const saved = rows[0];
    if (!saved || saved.owner_id !== ownerId) {
        return res.status(404).json({ error: 'Progress tidak ditemukan atau sudah kedaluwarsa.', code: 'PROGRESS_NOT_FOUND' });
    }
    let data = saved.job_data;
    if (['queued', 'processing', 'packaging'].includes(data.state)) {
        await failSpooferJobAfterRestart(db, req.params.progressId, ownerId);
        const refreshed = await db.query(
            'SELECT job_data FROM spoofer_worker_jobs WHERE progress_id = $1',
            [req.params.progressId],
        );
        data = refreshed.rows[0].job_data;
    } else if (data.quotaReservation && !data.quotaSettlement) {
        data.quotaSettlement = await settleSpooferJobQuota(db, req.params.progressId, ownerId);
    }
    const body = {
        ...data,
        total: data.assets.length,
        elapsedMs: Math.max(0, (data.finishedAt || Date.now()) - data.startedAt),
        downloadUrl: null,
        assets: data.assets.map((asset) => ({
            ...asset,
            downloadUrl: asset.status === 'success'
                ? `/internal/jobs/${req.params.progressId}/download/asset/${encodeURIComponent(asset.assetId)}`
                : null,
        })),
    };
    return res.set('Cache-Control', 'no-store').json(withDownloadRoutes(req.params.progressId, body));
});

function withDownloadRoutes(progressId, progress) {
    return {
        ...progress,
        downloadUrl: progress.downloadType === 'zip'
            ? `/internal/jobs/${progressId}/download/archive`
            : progress.downloadType === 'file'
                ? `/internal/jobs/${progressId}/download/asset/${encodeURIComponent(progress.assets[0]?.assetId || '')}`
                : null,
        assets: (progress.assets || []).map((asset) => ({
            ...asset,
            downloadUrl: asset.status === 'success'
                ? `/internal/jobs/${progressId}/download/asset/${encodeURIComponent(asset.assetId)}`
                : null,
        })),
    };
}

app.get('/internal/jobs/:progressId/download/:kind/:assetId?', requireWorkerKey, async (req, res) => {
    const ownerId = req.get('x-account-id');
    if (!isValidAccountId(ownerId)) {
        return res.status(400).json({ error: 'A valid account is required.', code: 'INVALID_JOB_OWNER' });
    }
    try {
        const { rows } = await db.query(
            'SELECT owner_id, job_state, job_data FROM spoofer_worker_jobs WHERE progress_id = $1',
            [req.params.progressId],
        );
        const saved = rows[0];
        if (!saved || saved.owner_id !== ownerId) {
            return res.status(404).json({ error: 'File tidak ditemukan atau sudah kedaluwarsa.', code: 'FILE_NOT_FOUND' });
        }
        const files = saved.job_data.remoteFiles;
        const archive = req.params.kind === 'archive' && !req.params.assetId;
        const assetId = req.params.kind === 'asset' ? req.params.assetId : null;
        if (!archive && !assetId) {
            return res.status(400).json({ error: 'Jenis file download tidak valid.', code: 'INVALID_FILE_KIND' });
        }
        if (archive && saved.job_state !== 'ready') {
            return res.status(404).json({ error: 'Arsip belum siap atau sudah kedaluwarsa.', code: 'FILE_NOT_FOUND' });
        }
        const asset = assetId
            ? saved.job_data.assets.find((item) => item.assetId === assetId && item.status === 'success')
            : null;
        const key = archive ? files?.archive : files?.assets?.[assetId];
        if (!key || (!archive && (!asset || !/^\d{1,20}$/.test(assetId || '')))) {
            return res.status(404).json({ error: 'File tidak ditemukan atau sudah kedaluwarsa.', code: 'FILE_NOT_FOUND' });
        }
        const fileName = archive
            ? 'roblox-spoofer-assets.zip'
            : asset.fileName;
        if (!fileName) return res.status(404).json({ error: 'File tidak ditemukan.', code: 'FILE_NOT_FOUND' });
        let object;
        try {
            object = await storage.getObject(key);
        } catch (error) {
            if (error.name === 'NoSuchKey' || error.name === 'NotFound' || error.$metadata?.httpStatusCode === 404) {
                return res.status(404).json({ error: 'File hasil tidak ditemukan di object storage.', code: 'RESULT_FILE_MISSING' });
            }
            throw error;
        }
        if (!object.Body) {
            return res.status(502).json({ error: 'Object storage tidak mengembalikan isi file.', code: 'RESULT_FILE_EMPTY' });
        }
        const expectedBytes = archive ? saved.job_data.archiveBytes : asset.sizeBytes;
        if (!Number.isSafeInteger(expectedBytes)
            || expectedBytes < 1
            || !Number.isSafeInteger(object.ContentLength)
            || object.ContentLength !== expectedBytes) {
            object.Body.destroy?.();
            console.error('[SPOOFER WORKER] Stored result size mismatch:', req.params.progressId, req.params.kind);
            return res.status(502).json({
                error: 'Ukuran file hasil di object storage tidak sesuai. Coba buat ulang arsip.',
                code: 'RESULT_SIZE_MISMATCH',
            });
        }
        await db.query(
            'UPDATE spoofer_worker_jobs SET updated_at = NOW() WHERE progress_id = $1 AND owner_id = $2',
            [req.params.progressId, ownerId],
        );
        bulkHandler.touchProgress(req.params.progressId, ownerId);
        res.status(200);
        res.setHeader('Content-Type', archive ? 'application/zip' : 'application/octet-stream');
        res.setHeader('Content-Disposition', attachmentDisposition(fileName));
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('Content-Length', String(expectedBytes));
        await pipeline(object.Body, createContentLengthVerifier(expectedBytes), res);
    } catch (error) {
        console.error('[SPOOFER WORKER] Failed to stream result file:', error.message);
        if (res.headersSent) res.destroy(error);
        else res.status(502).json({ error: 'Gagal mengirim file hasil.', code: 'RESULT_STREAM_FAILED' });
    }
});

app.use((error, _req, res, next) => {
    console.error('[SPOOFER WORKER] Request failed:', error.message);
    if (res.headersSent) return next(error);
    return res.status(500).json({ error: 'Spoofer worker gagal memproses permintaan.', code: 'WORKER_ERROR' });
});

async function start() {
    await ensureSchema();
    await cleanupExpiredPersistedJobs();
    const cleanupTimer = setInterval(() => {
        void cleanupExpiredPersistedJobs().catch((error) => {
            console.error('[SPOOFER WORKER] Expired-job cleanup failed:', error.message);
        });
    }, 5 * 60 * 1000);
    cleanupTimer.unref();
    const server = app.listen(PORT, '0.0.0.0', () => {
        console.log(`[SPOOFER WORKER] Listening on port ${PORT}`);
    });
    const shutdown = async () => {
        clearInterval(cleanupTimer);
        server.close();
        await db.end();
        process.exit(0);
    };
    process.once('SIGTERM', shutdown);
    process.once('SIGINT', shutdown);
}

start().catch((error) => {
    console.error('[SPOOFER WORKER] Startup failed:', error.message);
    process.exitCode = 1;
});
