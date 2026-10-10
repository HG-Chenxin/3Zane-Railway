const { PLAN_LIMITS, MAX_SPOOFER_ASSETS_PER_BATCH } = require('../account-limits');
const { isValidAccountId } = require('./auth');

function validateSpooferJobEntitlement({ ownerId, tier, maxAssetsPerBatch }) {
    if (!isValidAccountId(ownerId)) {
        return {
            error: 'Worker tidak menerima Discord account ID yang valid dari aplikasi utama.',
            code: 'INVALID_JOB_ACCOUNT_ID',
        };
    }

    const normalizedTier = typeof tier === 'string' ? tier.trim().toLowerCase() : '';
    if (!Object.hasOwn(PLAN_LIMITS, normalizedTier)) {
        return {
            error: `Tier akun tidak dikenali worker: ${normalizedTier || '(kosong)'}.`,
            code: 'INVALID_JOB_TIER',
        };
    }

    const resolvedBatchLimit = maxAssetsPerBatch === undefined
        ? PLAN_LIMITS[normalizedTier].spooferMaxAssetsPerBatch
        : maxAssetsPerBatch;
    if ((resolvedBatchLimit !== null
            && (!Number.isInteger(resolvedBatchLimit)
                || resolvedBatchLimit < 1
                || resolvedBatchLimit > MAX_SPOOFER_ASSETS_PER_BATCH))
        || (resolvedBatchLimit === null && normalizedTier !== 'elite')) {
        return {
            error: 'Spoofer batch limit is invalid.',
            code: 'INVALID_BATCH_LIMIT',
        };
    }

    return {
        ownerId,
        tier: normalizedTier,
        maxAssetsPerBatch: resolvedBatchLimit,
    };
}

module.exports = { validateSpooferJobEntitlement };
