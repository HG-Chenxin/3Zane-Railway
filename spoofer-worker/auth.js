const crypto = require('node:crypto');

function matchesSecret(expected, supplied) {
    const expectedBytes = Buffer.from(String(expected || ''));
    const suppliedBytes = Buffer.from(String(supplied || ''));
    return expectedBytes.length > 0
        && expectedBytes.length === suppliedBytes.length
        && crypto.timingSafeEqual(expectedBytes, suppliedBytes);
}

function isValidAccountId(value) {
    return typeof value === 'string' && /^\d{1,24}$/.test(value);
}

module.exports = { isValidAccountId, matchesSecret };
