const API_RATE_LIMITS = Object.freeze({
    windowSeconds: 60,
    generalApiRequestsPerMinute: 30,
    generalApiRequestsPerIpPerMinute: 300,
    generalApiRequestsPerGlobalMinute: 3000,
    detectRequestsPerMinute: 6,
    detectRequestsPerIpPerMinute: 12,
    detectRequestsPerGlobalMinute: 30,
    convertRequestsPerMinute: 6,
    convertRequestsPerIpPerMinute: 12,
    convertRequestsPerGlobalMinute: 30,
    bulkConvertRequestsPerMinute: 6,
    bulkConvertRequestsPerIpPerMinute: 12,
    bulkConvertRequestsPerGlobalMinute: 30,
    youtubeSearchRequestsPerMinute: 6,
    youtubeSearchRequestsPerIpPerMinute: 12,
    youtubeSearchRequestsPerGlobalMinute: 30,
    publishRequestsPerMinute: 10,
    publishRequestsPerIpPerMinute: 20,
    publishRequestsPerGlobalMinute: 60,
    publishConcurrentRequestsPerInstance: 4,
    publishStatusRequestsPerMinute: 300,
    publishStatusRequestsPerIpPerMinute: 3000,
    publishStatusRequestsPerGlobalMinute: 30000,
    chatRequestsPerMinute: 10,
    chatRequestsPerIpPerMinute: 100,
    chatRequestsPerGlobalMinute: 1000,
    chatModelsRequestsPerMinute: 60,
    chatModelsRequestsPerIpPerMinute: 600,
    chatModelsRequestsPerGlobalMinute: 6000,
    chatProjectRequestsPerMinute: 10,
    chatProjectRequestsPerIpPerMinute: 100,
    chatProjectRequestsPerGlobalMinute: 1000,
    concurrentConversionsPerUser: 1,
    concurrentConversionsPerIp: 3,
    heavyOperationsPerInstance: 1,
    heavyOperationsMaxQueued: 3,
    heavyOperationsBulkMaxQueued: 1,
    spooferConcurrentJobsPerInstance: 1,
    spooferMaxQueuedJobs: 50,
    spooferMaxBytesPerJob: 2 * 1024 ** 3,
    chatConcurrentRequestsPerInstance: 2,
    progressPollsPerMinute: 300,
    progressPollsPerIpPerMinute: 3000,
    progressPollsPerGlobalMinute: 30000,
    robloxToolsRequestsPerMinute: 30,
    robloxToolsRequestsPerIpPerMinute: 300,
    robloxToolsRequestsPerGlobalMinute: 3000,
    userDataRequestsPerMinute: 120,
    userDataRequestsPerIpPerMinute: 1200,
    userDataRequestsPerGlobalMinute: 12000,
    historyStatusRequestsPerMinute: 60,
    historyStatusRequestsPerIpPerMinute: 600,
    historyStatusRequestsPerGlobalMinute: 6000,
    fileTransferRequestsPerMinute: 30,
    fileTransferRequestsPerIpPerMinute: 300,
    fileTransferRequestsPerGlobalMinute: 3000,
    authRequestsPerMinute: 30,
    authRequestsPerIpPerMinute: 300,
    authRequestsPerGlobalMinute: 3000,
    activityRequestsPerMinute: 60,
    activityRequestsPerIpPerMinute: 600,
    activityRequestsPerGlobalMinute: 6000,
    spooferRequestsPerMinute: 5,
    spooferRequestsPerIpPerMinute: 30,
    spooferRequestsPerGlobalMinute: 300,
    spooferProgressRequestsPerMinute: 120,
    spooferProgressRequestsPerIpPerMinute: 600,
    spooferProgressRequestsPerGlobalMinute: 6000,
    systemRequestsPerMinute: 120,
    systemRequestsPerIpPerMinute: 1200,
    systemRequestsPerGlobalMinute: 12000,
});

function consumeRateLimit({
    buckets,
    feature,
    userId,
    ip,
    userLimit,
    ipLimit,
    globalLimit,
    now = Date.now(),
    windowMs = 60_000,
}) {
    const checks = [
        { scope: 'global', key: `${feature}:global`, limit: globalLimit },
        ...(userId
            ? [
                { scope: 'user', key: `${feature}:user:${userId}`, limit: userLimit },
                { scope: 'ip', key: `${feature}:ip:${ip}`, limit: ipLimit },
            ]
            : [
                { scope: 'ip', key: `${feature}:anonymous-ip:${ip}`, limit: userLimit },
                { scope: 'ip', key: `${feature}:ip:${ip}`, limit: ipLimit },
            ]),
    ];
    const activeBuckets = checks.map((check) => {
        let bucket = buckets.get(check.key);
        if (!bucket || now - bucket.startedAt >= windowMs) {
            bucket = { startedAt: now, count: 0 };
        }
        const seconds = Math.max(1, Math.ceil((bucket.startedAt + windowMs - now) / 1000));
        return { check, bucket, retryAfterSeconds: seconds };
    });

    const blocked = activeBuckets.find(({ check, bucket }) => bucket.count >= check.limit);
    if (blocked) {
        if (buckets.size > 10_000) {
            for (const [key, bucket] of buckets) {
                if (now - bucket.startedAt >= windowMs) buckets.delete(key);
            }
        }
        return {
            allowed: false,
            scope: blocked.check.scope,
            limit: blocked.check.limit,
            remaining: 0,
            retryAfterSeconds: blocked.retryAfterSeconds,
        };
    }

    let closest = null;
    for (const { check, bucket, retryAfterSeconds } of activeBuckets) {
        bucket.count++;
        buckets.set(check.key, bucket);
        const checkRemaining = Math.max(0, check.limit - bucket.count);
        const utilization = bucket.count / check.limit;
        if (!closest || utilization > closest.utilization) {
            closest = {
                scope: check.scope,
                limit: check.limit,
                remaining: checkRemaining,
                retryAfterSeconds,
                utilization,
            };
        }
    }

    if (buckets.size > 10_000) {
        for (const [key, bucket] of buckets) {
            if (now - bucket.startedAt >= windowMs) buckets.delete(key);
        }
    }

    return {
        allowed: true,
        scope: closest.scope,
        limit: closest.limit,
        remaining: closest.remaining,
        retryAfterSeconds: closest.retryAfterSeconds,
    };
}

const LIMITER_CONFIG = [
    ['rateLimit', 'general-api', 'generalApi', 'Batas API umum tercapai.'],
    ['detectRateLimit', 'detect', 'detect', 'Batas Detect tercapai.'],
    ['convertRateLimit', 'convert', 'convert', 'Batas Convert tercapai.'],
    ['bulkConvertRateLimit', 'bulk-convert', 'bulkConvert', 'Batas Bulk Convert tercapai.'],
    ['youtubeSearchRateLimit', 'youtube-search', 'youtubeSearch', 'Batas pencarian YouTube tercapai.'],
    ['publishRateLimit', 'publish', 'publish', 'Batas publish tercapai.'],
    ['publishStatusRateLimit', 'publish-status', 'publishStatus', 'Batas pengecekan status publish tercapai.'],
    ['convertProgressRateLimit', 'convert-progress', 'progressPolls', 'Batas request status konversi tercapai.'],
    ['chatRateLimit', 'chat-ai', 'chat', 'Batas Chat AI tercapai.'],
    ['chatModelsRateLimit', 'chat-ai-models', 'chatModels', 'Batas daftar model Chat AI tercapai.'],
    ['chatProjectRateLimit', 'chat-ai-project', 'chatProject', 'Batas pembuatan ZIP project tercapai.'],
    ['robloxToolsRateLimit', 'roblox-tools', 'robloxTools', 'Batas validasi Roblox tercapai.'],
    ['userDataRateLimit', 'user-data', 'userData', 'Batas data akun tercapai.'],
    ['historyStatusRateLimit', 'history-status', 'historyStatus', 'Batas pengecekan file history tercapai.'],
    ['fileTransferRateLimit', 'file-transfer', 'fileTransfer', 'Batas transfer file tercapai.'],
    ['authRateLimit', 'auth', 'auth', 'Batas autentikasi tercapai.'],
    ['activityRateLimit', 'activity', 'activity', 'Batas activity feed tercapai.'],
    ['assetDownloadRateLimit', 'roblox-spoofer', 'spoofer', 'Batas Roblox Spoofer tercapai.'],
    ['assetDownloadProgressRateLimit', 'roblox-spoofer-progress', 'spooferProgress', 'Batas pemeriksaan progress Roblox Spoofer tercapai.'],
    ['systemRateLimit', 'system', 'system', 'Batas API sistem tercapai.'],
];

function createApiRateLimitMiddleware({ requestBuckets, getSession, getClientKey }) {
    function createRateLimiter(name, limitPrefix, message) {
        const limitKeys = name === 'convert-progress'
            ? {
                user: 'progressPollsPerMinute',
                ip: 'progressPollsPerIpPerMinute',
                global: 'progressPollsPerGlobalMinute',
            }
            : {
                user: `${limitPrefix}RequestsPerMinute`,
                ip: `${limitPrefix}RequestsPerIpPerMinute`,
                global: `${limitPrefix}RequestsPerGlobalMinute`,
            };
        const ipLimit = API_RATE_LIMITS[limitKeys.ip];
        const globalLimit = API_RATE_LIMITS[limitKeys.global];
        const tierLimitProperty = {
            convert: 'conversionRequestsPerMinute',
            'bulk-convert': 'conversionRequestsPerMinute',
            publish: 'publishRequestsPerMinute',
            'chat-ai': 'chatRequestsPerMinute',
            'roblox-spoofer': 'spooferRequestsPerMinute',
        }[name];

        return (req, res, next) => {
            const limit = tierLimitProperty
                ? req.accountPlan?.limits?.[tierLimitProperty] ?? API_RATE_LIMITS[limitKeys.user]
                : API_RATE_LIMITS[limitKeys.user];
            const userId = getSession(req)?.user?.id;
            const result = consumeRateLimit({
                buckets: requestBuckets,
                feature: name,
                userId: userId ? String(userId) : null,
                ip: getClientKey(req),
                userLimit: limit,
                ipLimit,
                globalLimit,
            });
            res.setHeader('RateLimit-Limit', result.limit);
            res.setHeader('RateLimit-Remaining', result.remaining);
            res.setHeader('RateLimit-Reset', result.retryAfterSeconds);
            res.setHeader('RateLimit-Scope', result.scope);
            res.setHeader('RateLimit-IP-Limit', ipLimit);
            res.setHeader('RateLimit-Global-Limit', globalLimit);
            if (!result.allowed) {
                res.setHeader('Retry-After', result.retryAfterSeconds);
                return res.status(429).json({
                    error: `${message} Batas ${result.scope === 'user' ? 'akun' : 'IP'} tercapai. Coba lagi dalam ${result.retryAfterSeconds} detik.`,
                    retryAfterSeconds: result.retryAfterSeconds,
                    scope: result.scope,
                });
            }
            next();
        };
    }

    const limiters = Object.fromEntries(LIMITER_CONFIG.map(([key, name, prefix, message]) => [
        key,
        createRateLimiter(name, prefix, message),
    ]));

    const dedicatedApiRoutes = new Map([
        ['POST /download', limiters.assetDownloadRateLimit],
        ['POST /roblox/spoofer', limiters.assetDownloadRateLimit],
        ['POST /convert', limiters.convertRateLimit],
        ['POST /bulk-convert', limiters.bulkConvertRateLimit],
        ['POST /detect', limiters.detectRateLimit],
        ['POST /youtube/search', limiters.youtubeSearchRateLimit],
        ['POST /youtube/playlist', limiters.youtubeSearchRateLimit],
        ['POST /publish-roblox', limiters.publishRateLimit],
        ['POST /publish-roblox-direct', limiters.publishRateLimit],
        ['POST /roblox/check-status', limiters.publishStatusRateLimit],
    ]);

    function routeRateLimit(req) {
        const path = req.path.replace(/\/+$/, '') || '/';
        const method = req.method;
        if (path === '/chat-ai' && method === 'POST') return limiters.chatRateLimit;
        if (path === '/chat-ai/models') return limiters.chatModelsRateLimit;
        if (path === '/chat-ai/project-zip' && method === 'POST') return limiters.chatProjectRateLimit;
        if (path.startsWith('/roblox/spoofer')) return limiters.assetDownloadRateLimit;
        if (path.startsWith('/roblox-settings')) return limiters.userDataRateLimit;
        if (path.startsWith('/admin')) return limiters.userDataRateLimit;
        if (path.startsWith('/roblox/validate-')) return limiters.robloxToolsRateLimit;
        if (path === '/history/status' && method === 'POST') return limiters.historyStatusRateLimit;
        if (path.startsWith('/history') || path.startsWith('/presets') || path.startsWith('/workspace-stats')) return limiters.userDataRateLimit;
        if (path === '/activity') return limiters.activityRateLimit;
        if (path.startsWith('/download') || path === '/bulk-zip' || path === '/share') return limiters.fileTransferRateLimit;
        if (path.startsWith('/auth')) return limiters.authRateLimit;
        if (['/health', '/version', '/formats', '/rate-limits'].includes(path)) return limiters.systemRateLimit;
        return limiters.rateLimit;
    }

    return { ...limiters, dedicatedApiRoutes, routeRateLimit };
}

module.exports = { API_RATE_LIMITS, consumeRateLimit, createApiRateLimitMiddleware };
