const MAX_SPOOFER_ASSETS_PER_BATCH = 1000;
const MAX_CONVERSION_UPLOAD_BYTES = 1024 ** 3;
const PLAN_LIMITS = Object.freeze({
    free: Object.freeze({
        conversionRequestsPerMinute: 3,
        conversionsPerDay: 5,
        concurrentConversions: 1,
        maxQueuedHeavyRequests: 1,
        conversionMaxBytes: 50 * 1024 * 1024,
        bulkConvertEnabled: false,
        spooferRequestsPerMinute: 2,
        spooferAssetsPerDay: 100,
        spooferMaxAssetsPerBatch: 50,
        spooferMaxBytesPerBatch: 250 * 1024 * 1024,
        concurrentSpooferJobs: 1,
        publishRequestsPerMinute: 3,
        publishConcurrentUploads: 1,
        publishesPerDay: 20,
        publishMaxFiles: 10,
        publishMaxBytes: 20 * 1024 * 1024,
        chatRequestsPerMinute: 3,
        chatsPerDay: 20,
        concurrentChats: 1,
        chatMaxUploadBytes: 20 * 1024 * 1024,
    }),
    starter: Object.freeze({
        conversionRequestsPerMinute: 4,
        conversionsPerDay: 25,
        concurrentConversions: 1,
        maxQueuedHeavyRequests: 1,
        conversionMaxBytes: 75 * 1024 * 1024,
        bulkConvertEnabled: false,
        spooferRequestsPerMinute: 2,
        spooferAssetsPerDay: 25,
        spooferMaxAssetsPerBatch: 25,
        spooferMaxBytesPerBatch: 250 * 1024 * 1024,
        concurrentSpooferJobs: 1,
        publishRequestsPerMinute: 4,
        publishConcurrentUploads: 1,
        publishesPerDay: 50,
        publishMaxFiles: 25,
        publishMaxBytes: 20 * 1024 * 1024,
        chatRequestsPerMinute: 4,
        chatsPerDay: 30,
        concurrentChats: 1,
        chatMaxUploadBytes: 30 * 1024 * 1024,
    }),
    basic: Object.freeze({
        conversionRequestsPerMinute: 5,
        conversionsPerDay: 50,
        concurrentConversions: 1,
        maxQueuedHeavyRequests: 1,
        conversionMaxBytes: 100 * 1024 * 1024,
        bulkConvertEnabled: false,
        spooferRequestsPerMinute: 3,
        spooferAssetsPerDay: 50,
        spooferMaxAssetsPerBatch: 50,
        spooferMaxBytesPerBatch: 500 * 1024 * 1024,
        concurrentSpooferJobs: 1,
        publishRequestsPerMinute: 5,
        publishConcurrentUploads: 2,
        publishesPerDay: 100,
        publishMaxFiles: 50,
        publishMaxBytes: 20 * 1024 * 1024,
        chatRequestsPerMinute: 5,
        chatsPerDay: 50,
        concurrentChats: 1,
        chatMaxUploadBytes: 50 * 1024 * 1024,
    }),
    creator: Object.freeze({
        conversionRequestsPerMinute: 6,
        conversionsPerDay: 100,
        concurrentConversions: 1,
        maxQueuedHeavyRequests: 2,
        conversionMaxBytes: 150 * 1024 * 1024,
        bulkConvertEnabled: true,
        spooferRequestsPerMinute: 4,
        spooferAssetsPerDay: 150,
        spooferMaxAssetsPerBatch: 100,
        spooferMaxBytesPerBatch: 2 * 1024 ** 3,
        concurrentSpooferJobs: 1,
        publishRequestsPerMinute: 6,
        publishConcurrentUploads: 2,
        publishesPerDay: 250,
        publishMaxFiles: 200,
        publishMaxBytes: 20 * 1024 * 1024,
        chatRequestsPerMinute: 6,
        chatsPerDay: 100,
        concurrentChats: 1,
        chatMaxUploadBytes: 100 * 1024 * 1024,
    }),
    premium: Object.freeze({
        conversionRequestsPerMinute: 7,
        conversionsPerDay: 500,
        concurrentConversions: 1,
        maxQueuedHeavyRequests: 2,
        conversionMaxBytes: 200 * 1024 * 1024,
        bulkConvertEnabled: true,
        spooferRequestsPerMinute: 5,
        spooferAssetsPerDay: 500,
        spooferMaxAssetsPerBatch: 250,
        spooferMaxBytesPerBatch: 2 * 1024 ** 3,
        concurrentSpooferJobs: 1,
        publishRequestsPerMinute: 7,
        publishConcurrentUploads: 3,
        publishesPerDay: 1000,
        publishMaxFiles: 500,
        publishMaxBytes: 20 * 1024 * 1024,
        chatRequestsPerMinute: 8,
        chatsPerDay: 500,
        concurrentChats: 1,
        chatMaxUploadBytes: 100 * 1024 * 1024,
    }),
    pro: Object.freeze({
        conversionRequestsPerMinute: 10,
        conversionsPerDay: null,
        concurrentConversions: 1,
        maxQueuedHeavyRequests: 2,
        conversionMaxBytes: 500 * 1024 * 1024,
        bulkConvertEnabled: true,
        spooferRequestsPerMinute: 10,
        spooferAssetsPerDay: 1000,
        spooferMaxAssetsPerBatch: 500,
        spooferMaxBytesPerBatch: 2 * 1024 ** 3,
        concurrentSpooferJobs: 1,
        publishRequestsPerMinute: 10,
        publishConcurrentUploads: 4,
        publishesPerDay: 5000,
        publishMaxFiles: 1000,
        publishMaxBytes: 20 * 1024 * 1024,
        chatRequestsPerMinute: 10,
        chatsPerDay: 1000,
        concurrentChats: 1,
        chatMaxUploadBytes: 200 * 1024 * 1024,
    }),
    elite: Object.freeze({
        conversionRequestsPerMinute: 12,
        conversionsPerDay: null,
        concurrentConversions: 1,
        maxQueuedHeavyRequests: 3,
        conversionMaxBytes: null,
        bulkConvertEnabled: true,
        spooferRequestsPerMinute: 12,
        spooferAssetsPerDay: null,
        spooferMaxAssetsPerBatch: null,
        spooferMaxBytesPerBatch: 2 * 1024 ** 3,
        concurrentSpooferJobs: 1,
        publishRequestsPerMinute: 12,
        publishConcurrentUploads: 4,
        publishesPerDay: null,
        publishMaxFiles: null,
        publishMaxBytes: 20 * 1024 * 1024,
        chatRequestsPerMinute: 12,
        chatsPerDay: null,
        concurrentChats: 2,
        chatMaxUploadBytes: 200 * 1024 * 1024,
    }),
});

const accountActiveCounts = new Map();
const localDailyUsage = new Map();
const localDailyReservations = new Map();

function getUtcDay(now = new Date()) {
    return now.toISOString().slice(0, 10);
}

function getEffectiveAccountTier(entitlement, now = Date.now()) {
    const tier = typeof entitlement?.tier === 'string' ? entitlement.tier.trim().toLowerCase() : '';
    const expiresAt = entitlement?.expires_at ? new Date(entitlement.expires_at).getTime() : NaN;
    return Object.hasOwn(PLAN_LIMITS, tier) && Number.isFinite(expiresAt) && expiresAt > now
        ? tier
        : 'free';
}

async function failSpooferJobAfterRestart(db, progressId, expectedOwnerId) {
    const client = await db.connect();
    try {
        await client.query('BEGIN');
        const { rows } = await client.query(
            `SELECT owner_id, job_state, job_data
             FROM spoofer_worker_jobs
             WHERE progress_id = $1
             FOR UPDATE`,
            [progressId],
        );
        const row = rows[0];
        if (!row || row.owner_id !== String(expectedOwnerId)) {
            throw new Error(`Spoofer restart recovery could not find owned job ${progressId}.`);
        }
        const jobData = typeof row.job_data === 'string' ? JSON.parse(row.job_data) : row.job_data;
        if (['queued', 'processing', 'packaging'].includes(row.job_state)) {
            jobData.state = 'failed';
            jobData.error = 'Worker dimulai ulang saat job berjalan; batch tidak dapat dilanjutkan.';
            jobData.errorCode = 'WORKER_RESTARTED';
            jobData.finishedAt = Date.now();
            await client.query(
                `UPDATE spoofer_worker_jobs
                 SET job_state = 'failed', job_data = $2::jsonb, updated_at = NOW()
                 WHERE progress_id = $1`,
                [progressId, JSON.stringify(jobData)],
            );
        }
        await client.query('COMMIT');
    } catch (error) {
        try {
            await client.query('ROLLBACK');
        } catch (rollbackError) {
            error.rollbackError = rollbackError;
        }
        throw error;
    } finally {
        client.release();
    }
    return settleSpooferJobQuota(db, progressId, expectedOwnerId);
}

async function settleSpooferJobQuota(db, progressId, expectedOwnerId) {
    const client = await db.connect();
    try {
        await client.query('BEGIN');
        const { rows } = await client.query(
            `SELECT owner_id, job_data
             FROM spoofer_worker_jobs
             WHERE progress_id = $1
             FOR UPDATE`,
            [progressId],
        );
        const row = rows[0];
        if (!row || row.owner_id !== String(expectedOwnerId)) {
            throw new Error(`Spoofer quota settlement could not find owned job ${progressId}.`);
        }

        const jobData = typeof row.job_data === 'string' ? JSON.parse(row.job_data) : row.job_data;
        if (jobData.quotaSettlement) {
            await client.query('COMMIT');
            return jobData.quotaSettlement;
        }

        const reservation = jobData.quotaReservation;
        if (!reservation) {
            const legacySettlement = { status: 'legacy-untracked' };
            jobData.quotaSettlement = legacySettlement;
            await client.query(
                'UPDATE spoofer_worker_jobs SET job_data = $2::jsonb WHERE progress_id = $1',
                [progressId, JSON.stringify(jobData)],
            );
            await client.query('COMMIT');
            return legacySettlement;
        }

        const { usageDay, reservedAssets } = reservation;
        const parsedUsageDay = typeof usageDay === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(usageDay)
            ? new Date(`${usageDay}T00:00:00.000Z`)
            : null;
        const validDay = parsedUsageDay
            && Number.isFinite(parsedUsageDay.getTime())
            && parsedUsageDay.toISOString().slice(0, 10) === usageDay;
        if (!validDay || !Number.isSafeInteger(reservedAssets) || reservedAssets < 1
            || !Array.isArray(jobData.assets) || reservedAssets !== jobData.assets.length) {
            throw new Error(`Spoofer quota reservation is invalid for job ${progressId}.`);
        }

        const storedAssets = jobData.assets.filter((asset) => (
            asset.status === 'success'
            && typeof asset.assetId === 'string'
            && typeof jobData.localFiles?.assets?.[asset.assetId] === 'string'
        )).length;
        if (storedAssets > reservedAssets) {
            throw new Error(`Spoofer job ${progressId} reports more stored assets than reserved.`);
        }
        const refundedAssets = reservedAssets - storedAssets;
        const accountKey = `discord:${row.owner_id}`;
        if (refundedAssets > 0) {
            await client.query(`
                UPDATE account_daily_usage
                SET used = GREATEST(used - $3::integer, 0)
                WHERE account_key = $1::text
                    AND feature = 'spoofer-assets'
                    AND usage_day = $2::date
            `, [accountKey, usageDay, refundedAssets]);
            await client.query(`
                DELETE FROM account_daily_usage
                WHERE account_key = $1::text
                    AND feature = 'spoofer-assets'
                    AND usage_day = $2::date
                    AND used = 0
            `, [accountKey, usageDay]);
        }

        const settlement = {
            status: 'settled',
            usageDay,
            reservedAssets,
            billableAssets: storedAssets,
            refundedAssets,
            settledAt: new Date().toISOString(),
        };
        jobData.quotaSettlement = settlement;
        await client.query(
            'UPDATE spoofer_worker_jobs SET job_data = $2::jsonb WHERE progress_id = $1',
            [progressId, JSON.stringify(jobData)],
        );
        await client.query('COMMIT');
        return settlement;
    } catch (error) {
        try {
            await client.query('ROLLBACK');
        } catch (rollbackError) {
            error.rollbackError = rollbackError;
        }
        throw error;
    } finally {
        client.release();
    }
}

function getLocalDailyUsage(accountKey, feature, now = new Date()) {
    return localDailyUsage.get(`${getUtcDay(now)}:${feature}:${accountKey}`) || 0;
}

function createMinimumTierMiddleware(minimumTier, message) {
    const tiers = Object.keys(PLAN_LIMITS);
    const minimumRank = tiers.indexOf(minimumTier);
    if (minimumRank < 1) throw new RangeError(`Unknown minimum paid tier: ${minimumTier}`);
    return (req, res, next) => {
        const tier = req.accountPlan?.tier || 'free';
        if (tiers.indexOf(tier) < minimumRank) {
            return res.status(403).json({
                error: message || `Fitur ini tersedia mulai paket ${minimumTier[0].toUpperCase()}${minimumTier.slice(1)}.`,
                code: 'TIER_REQUIRED',
                minimumTier,
            });
        }
        next();
    };
}

async function getAccountPlan(db, userId) {
    if (!db || !userId) return { tier: 'free', limits: PLAN_LIMITS.free, expiresAt: null };
    const result = await db.query(
        'SELECT tier, expires_at FROM user_entitlements WHERE user_id = $1',
        [String(userId)],
    );
    const entitlement = result.rows[0];
    const expiresAt = entitlement?.expires_at ? new Date(entitlement.expires_at).getTime() : null;
    const tier = getEffectiveAccountTier(entitlement);
    const limits = { ...PLAN_LIMITS[tier] };
    const override = await db.query(
        'SELECT daily_limit FROM account_spoofer_quota_overrides WHERE user_id = $1',
        [String(userId)],
    );
    if (override.rows.length) {
        limits.spooferAssetsPerDay = override.rows[0].daily_limit === null
            ? null
            : Number(override.rows[0].daily_limit);
        if (limits.spooferAssetsPerDay === null && tier !== 'elite') {
            limits.spooferMaxAssetsPerBatch = MAX_SPOOFER_ASSETS_PER_BATCH;
        }
    }
    return { tier, limits, expiresAt: tier === 'free' ? null : expiresAt };
}

function createAccountPlanMiddleware({
    getDatabase,
    getSession,
    logger = console,
    now = Date.now,
    cacheTtlMs = 10_000,
    staleTtlMs = 60_000,
}) {
    const planCache = new Map();

    return async (req, res, next) => {
        let plan;
        const userId = getSession(req)?.user?.id;
        const cached = userId ? planCache.get(String(userId)) : null;
        const cacheValid = cached
            && cached.staleUntil > now()
            && (cached.plan.tier === 'free' || cached.plan.expiresAt > now());
        try {
            if (cacheValid && cached.freshUntil > now()) {
                plan = cached.plan;
            } else {
                plan = await getAccountPlan(getDatabase(), userId);
                if (userId) {
                    const fetchedAt = now();
                    planCache.set(String(userId), {
                        plan,
                        freshUntil: Math.min(fetchedAt + cacheTtlMs, plan.expiresAt || Infinity),
                        staleUntil: Math.min(fetchedAt + staleTtlMs, plan.expiresAt || Infinity),
                    });
                }
            }
        } catch (error) {
            logger.error('[ACCOUNT PLAN] Failed to load account entitlement:', error.message);
            if (!cacheValid) {
                if (userId) planCache.delete(String(userId));
                return res.status(503).json({ error: 'Paket akun sementara tidak dapat diverifikasi.', code: 'ACCOUNT_PLAN_UNAVAILABLE' });
            }
            plan = cached.plan;
            logger.warn(`[ACCOUNT PLAN] Using recently verified ${plan.tier} entitlement during a database outage.`);
        }
        if (planCache.size > 5000) {
            for (const [key, entry] of planCache) {
                if (entry.staleUntil <= now()) planCache.delete(key);
            }
        }
        req.accountPlan = plan;
        next();
    };
}

function createUsageQuotaMiddleware({
    getDatabase,
    getSession,
    getClientKey,
    feature,
    limitProperty,
    getCost = () => 1,
    refundOnHttpError = false,
    commitOnSuccess = false,
    logger = console,
}) {
    return async (req, res, next) => {
        const sessionUserId = getSession(req)?.user?.id;
        const accountKey = sessionUserId ? `discord:${sessionUserId}` : `ip:${getClientKey(req)}`;
        const plan = req.accountPlan || { tier: 'free', limits: PLAN_LIMITS.free };
        const limit = plan.limits[limitProperty];
        const cost = getCost(req);
        const day = getUtcDay();
        if (!Number.isSafeInteger(cost) || cost < 1) {
            return res.status(400).json({ error: 'Jumlah pemakaian tidak valid.', code: 'INVALID_QUOTA_COST' });
        }

        let used;
        try {
            const db = getDatabase();
            if (db) {
                const result = commitOnSuccess
                    ? await db.query(`
                        INSERT INTO account_daily_usage (account_key, feature, usage_day, used, reserved)
                        VALUES ($1::text, $2::text, $3::date, 0, $4::integer)
                        ON CONFLICT (account_key, feature, usage_day)
                        DO UPDATE SET reserved = account_daily_usage.reserved + EXCLUDED.reserved
                        WHERE $5::integer IS NULL
                            OR account_daily_usage.used + account_daily_usage.reserved + EXCLUDED.reserved <= $5::integer
                        RETURNING used
                    `, [accountKey, feature, day, cost, limit])
                    : limit === null
                    ? await db.query(`
                        INSERT INTO account_daily_usage (account_key, feature, usage_day, used)
                        VALUES ($1::text, $2::text, $3::date, $4::integer)
                        ON CONFLICT (account_key, feature, usage_day)
                        DO UPDATE SET used = account_daily_usage.used + EXCLUDED.used
                        RETURNING used
                    `, [accountKey, feature, day, cost])
                    : await db.query(`
                        INSERT INTO account_daily_usage (account_key, feature, usage_day, used)
                        SELECT $1::text, $2::text, $3::date, $4::integer
                        WHERE $4::integer <= $5::integer
                        ON CONFLICT (account_key, feature, usage_day)
                        DO UPDATE SET used = account_daily_usage.used + EXCLUDED.used
                        WHERE account_daily_usage.used + EXCLUDED.used <= $5::integer
                        RETURNING used
                    `, [accountKey, feature, day, cost, limit]);
                if (!result.rows.length) {
                    return res.status(429).json({
                        error: `Kuota harian ${feature} paket ${plan.tier} sudah habis.`,
                        code: 'DAILY_QUOTA_EXCEEDED',
                        feature,
                        tier: plan.tier,
                        limit,
                        retryAfterSeconds: secondsUntilUtcDayEnds(),
                    });
                }
                used = Number(result.rows[0].used);
            } else {
                const key = `${day}:${feature}:${accountKey}`;
                used = localDailyUsage.get(key) || 0;
                const reserved = localDailyReservations.get(key) || 0;
                if (limit !== null && used + reserved + cost > limit) {
                    return res.status(429).json({
                        error: `Kuota harian ${feature} paket ${plan.tier} sudah habis.`,
                        code: 'DAILY_QUOTA_EXCEEDED',
                        feature,
                        tier: plan.tier,
                        limit,
                        retryAfterSeconds: secondsUntilUtcDayEnds(),
                    });
                }
                if (commitOnSuccess) {
                    localDailyReservations.set(key, reserved + cost);
                } else {
                    used += cost;
                    localDailyUsage.set(key, used);
                }
                if (localDailyUsage.size + localDailyReservations.size > 10_000) {
                    for (const usageKey of new Set([...localDailyUsage.keys(), ...localDailyReservations.keys()])) {
                        if (!usageKey.startsWith(`${day}:`)) {
                            localDailyUsage.delete(usageKey);
                            localDailyReservations.delete(usageKey);
                        }
                    }
                }
            }
        } catch (error) {
            logger.error(`[ACCOUNT QUOTA] Failed to reserve ${feature} usage:`, error.message);
            return res.status(503).json({ error: 'Kuota akun sementara tidak dapat diverifikasi.', code: 'ACCOUNT_QUOTA_UNAVAILABLE' });
        }
        let settlementPromise;
        const settleUsage = (action) => {
            if (settlementPromise) return settlementPromise;
            settlementPromise = (async () => {
                const key = `${day}:${feature}:${accountKey}`;
                const currentDb = getDatabase();
                if (commitOnSuccess) {
                    if (currentDb) {
                        const result = await currentDb.query(action === 'commit'
                            ? `
                                UPDATE account_daily_usage
                                SET used = used + $4::integer, reserved = reserved - $4::integer
                                WHERE account_key = $1::text AND feature = $2::text
                                    AND usage_day = $3::date AND reserved >= $4::integer
                                RETURNING used
                            `
                            : `
                                UPDATE account_daily_usage
                                SET reserved = reserved - $4::integer
                                WHERE account_key = $1::text AND feature = $2::text
                                    AND usage_day = $3::date AND reserved >= $4::integer
                                RETURNING used, reserved
                            `, [accountKey, feature, day, cost]);
                        if (!result.rows.length) {
                            throw new Error(`Could not ${action} reserved ${feature} usage.`);
                        }
                        if (action === 'refund') {
                            await currentDb.query(`
                                DELETE FROM account_daily_usage
                                WHERE account_key = $1::text AND feature = $2::text
                                    AND usage_day = $3::date AND used = 0 AND reserved = 0
                            `, [accountKey, feature, day]);
                        }
                    } else {
                        const reserved = localDailyReservations.get(key) || 0;
                        if (reserved < cost) throw new Error(`Could not ${action} reserved ${feature} usage.`);
                        if (reserved === cost) localDailyReservations.delete(key);
                        else localDailyReservations.set(key, reserved - cost);
                        if (action === 'commit') localDailyUsage.set(key, (localDailyUsage.get(key) || 0) + cost);
                    }
                    return;
                }
                if (action !== 'refund' || !refundOnHttpError) return;
                if (currentDb) {
                    const params = [accountKey, feature, day, cost];
                    const updated = await currentDb.query(`
                        UPDATE account_daily_usage
                        SET used = used - $4::integer
                        WHERE account_key = $1::text
                            AND feature = $2::text
                            AND usage_day = $3::date
                            AND used > $4::integer
                        RETURNING used
                    `, params);
                    if (!updated.rows.length) {
                        await currentDb.query(`
                            DELETE FROM account_daily_usage
                            WHERE account_key = $1::text
                                AND feature = $2::text
                                AND usage_day = $3::date
                                AND used = $4::integer
                        `, params);
                    }
                } else {
                    const remaining = (localDailyUsage.get(key) || 0) - cost;
                    if (remaining > 0) localDailyUsage.set(key, remaining);
                    else localDailyUsage.delete(key);
                }
            })();
            return settlementPromise;
        };
        req.accountUsage = {
            feature,
            day,
            used,
            limit,
            cost,
            ...(commitOnSuccess ? {
                commit: () => settleUsage('commit'),
                refund: () => settleUsage('refund'),
            } : refundOnHttpError ? { refund: () => settleUsage('refund') } : {}),
        };
        if (commitOnSuccess || refundOnHttpError) {
            res.once('finish', () => {
                if (commitOnSuccess && (
                    res.locals?.deferResponseCompletionRelease
                    || res.locals?.deferQuotaSettlement
                )) return;
                const action = commitOnSuccess
                    ? res.statusCode < 400 ? 'commit' : 'refund'
                    : res.statusCode >= 400 ? 'refund' : null;
                if (!action) return;
                void settleUsage(action).catch((error) => {
                    logger.error(`[ACCOUNT QUOTA] Failed to ${action} ${feature} usage:`, error.message);
                });
            });
        }
        next();
    };
}

function secondsUntilUtcDayEnds(now = new Date()) {
    const nextDay = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
    return Math.max(1, Math.ceil((nextDay - now.getTime()) / 1000));
}

function createAccountConcurrencyMiddleware({
    getSession,
    getClientKey,
    limitProperty,
    bucketName = limitProperty,
    globalLimit,
    trackResponseCompletion,
    releaseOnClose = false,
    logger = console,
}) {
    let globalActive = 0;
    const middleware = (req, res, next) => {
        const userId = getSession(req)?.user?.id;
        const accountKey = `${bucketName}:${userId ? `discord:${userId}` : `ip:${getClientKey(req)}`}`;
        const accountLimit = (req.accountPlan || { limits: PLAN_LIMITS.free }).limits[limitProperty];
        const accountActive = accountActiveCounts.get(accountKey) || 0;
        if (accountActive >= accountLimit) {
            return res.status(429).json({
                error: `Maksimal ${accountLimit} permintaan aktif untuk akun ini.`,
                code: 'ACCOUNT_CONCURRENCY_LIMIT',
                limit: accountLimit,
            });
        }
        if (globalActive >= globalLimit) {
            res.setHeader('Retry-After', '15');
            return res.status(503).json({
                error: 'Kapasitas layanan sedang penuh. Coba lagi sebentar.',
                code: 'GLOBAL_CONCURRENCY_LIMIT',
                retryAfterSeconds: 15,
            });
        }

        globalActive += 1;
        accountActiveCounts.set(accountKey, accountActive + 1);
        let released = false;
        const release = () => {
            if (released) return;
            released = true;
            globalActive -= 1;
            const remaining = (accountActiveCounts.get(accountKey) || 1) - 1;
            if (remaining) accountActiveCounts.set(accountKey, remaining);
            else accountActiveCounts.delete(accountKey);
        };
        try {
            trackResponseCompletion(res, release);
            if (releaseOnClose) {
                res.once('close', () => {
                    if (!res.writableEnded) release();
                });
            }
            next();
        } catch (error) {
            release();
            logger.error('[ACCOUNT CONCURRENCY] Route middleware failed:', error.message);
            throw error;
        }
    };
    middleware.getStatus = () => ({
        active: [...accountActiveCounts.entries()]
            .filter(([key]) => key.startsWith(`${bucketName}:`))
            .reduce((total, [, count]) => total + count, 0),
        maxConcurrent: globalLimit,
    });
    return middleware;
}

module.exports = {
    PLAN_LIMITS,
    MAX_SPOOFER_ASSETS_PER_BATCH,
    MAX_CONVERSION_UPLOAD_BYTES,
    createAccountConcurrencyMiddleware,
    createAccountPlanMiddleware,
    createMinimumTierMiddleware,
    createUsageQuotaMiddleware,
    failSpooferJobAfterRestart,
    getAccountPlan,
    getEffectiveAccountTier,
    getLocalDailyUsage,
    getUtcDay,
    settleSpooferJobQuota,
    secondsUntilUtcDayEnds,
};
