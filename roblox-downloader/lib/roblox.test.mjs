import assert from "node:assert/strict";
import { after, test } from "node:test";
import { thumbnail, verifyApiKey } from "./roblox.mjs";

const originalFetch = globalThis.fetch;

after(() => {
  globalThis.fetch = originalFetch;
});

test("thumbnail cache reuses fresh entries and refreshes expired entries", async () => {
  let now = 1_000_000;
  let requests = 0;
  const originalNow = Date.now;
  Date.now = () => now;
  globalThis.fetch = async () => {
    requests += 1;
    return new Response('<meta property="og:image" content="https://images.example/avatar.png">');
  };

  try {
    assert.equal(await thumbnail("user", "cache-test-expiration"), "https://images.example/avatar.png");
    assert.equal(await thumbnail("user", "cache-test-expiration"), "https://images.example/avatar.png");
    assert.equal(requests, 1);

    now += 6 * 60 * 60 * 1000;
    assert.equal(await thumbnail("user", "cache-test-expiration"), "https://images.example/avatar.png");
    assert.equal(requests, 2);
  } finally {
    Date.now = originalNow;
  }
});

test("thumbnail cache evicts the oldest entry when its limit is reached", async () => {
  let requests = 0;
  globalThis.fetch = async () => {
    requests += 1;
    return new Response(`<meta property="og:image" content="https://images.example/${requests}.png">`);
  };

  for (let index = 0; index < 1001; index += 1) {
    await thumbnail("user", `cache-test-cap-${index}`);
  }
  const requestsBeforeOldEntry = requests;

  await thumbnail("user", "cache-test-cap-0");

  assert.equal(requests, requestsBeforeOldEntry + 1);
});

test("API key verification accepts only conclusive Roblox statuses", async () => {
  for (const status of [200, 204, 403, 404]) {
    globalThis.fetch = async () => new Response(null, { status });
    const result = await verifyApiKey("test-key");
    assert.equal(result.valid, true, `HTTP ${status} should confirm the key`);
  }

  for (const status of [401, 418, 429, 500, 502, 503]) {
    globalThis.fetch = async () => new Response("temporary upstream response", { status });
    const result = await verifyApiKey("test-key");
    assert.equal(result.valid, false, `HTTP ${status} must not confirm the key`);
    if (status !== 401) assert.match(result.reason, new RegExp(`HTTP ${status}`));
  }
});
