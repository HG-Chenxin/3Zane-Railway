const assert = require('node:assert/strict');
const test = require('node:test');
const { isValidAccountId, matchesSecret } = require('./auth');

test('compares worker secrets without accepting empty or different-length values', () => {
    assert.equal(matchesSecret('worker-secret', 'worker-secret'), true);
    assert.equal(matchesSecret('worker-secret', 'worker-secret!'), false);
    assert.equal(matchesSecret('', ''), false);
});

test('accepts only numeric Discord account identifiers', () => {
    assert.equal(isValidAccountId('1044986769331998780'), true);
    assert.equal(isValidAccountId('../other-account'), false);
    assert.equal(isValidAccountId(''), false);
});
