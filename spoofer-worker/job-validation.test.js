const assert = require('node:assert/strict');
const test = require('node:test');
const { PLAN_LIMITS } = require('../account-limits');
const { validateSpooferJobEntitlement } = require('./job-validation');

const ownerId = '1044986769331998780';

test('validates every account tier and preserves Elite unlimited batch limits', () => {
    for (const [tier, limits] of Object.entries(PLAN_LIMITS)) {
        assert.deepEqual(
            validateSpooferJobEntitlement({
                ownerId,
                tier,
                maxAssetsPerBatch: limits.spooferMaxAssetsPerBatch,
            }),
            { ownerId, tier, maxAssetsPerBatch: limits.spooferMaxAssetsPerBatch },
            `${tier} must match its account Spoofer batch limit`,
        );
    }
});

test('normalizes tier casing before resolving worker entitlements', () => {
    assert.deepEqual(
        validateSpooferJobEntitlement({ ownerId, tier: ' ELITE ', maxAssetsPerBatch: null }),
        { ownerId, tier: 'elite', maxAssetsPerBatch: null },
    );
});

test('allows custom unlimited daily quota for paid non-Elite tiers up to the technical batch limit', () => {
    assert.deepEqual(
        validateSpooferJobEntitlement({ ownerId, tier: 'pro', maxAssetsPerBatch: 1000 }),
        { ownerId, tier: 'pro', maxAssetsPerBatch: 1000 },
    );
});

test('returns separate errors for invalid owner, tier, and batch limit', () => {
    assert.equal(validateSpooferJobEntitlement({
        ownerId: 'not-an-account',
        tier: 'elite',
        maxAssetsPerBatch: null,
    }).code, 'INVALID_JOB_ACCOUNT_ID');
    assert.equal(validateSpooferJobEntitlement({
        ownerId,
        tier: 'unknown',
        maxAssetsPerBatch: 25,
    }).code, 'INVALID_JOB_TIER');
    assert.equal(validateSpooferJobEntitlement({
        ownerId,
        tier: 'elite',
        maxAssetsPerBatch: 1001,
    }).code, 'INVALID_BATCH_LIMIT');
});
