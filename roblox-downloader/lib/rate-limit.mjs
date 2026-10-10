export function consumeRateLimit({
  key,
  keyHits,
  globalHits,
  keyLimit,
  globalLimit,
  windowMs,
  now = Date.now(),
}) {
  const activeKeyHits = (keyHits.get(key) || []).filter((timestamp) => now - timestamp < windowMs);
  const activeGlobalHits = (globalHits.get("global") || []).filter((timestamp) => now - timestamp < windowMs);

  if (activeKeyHits.length >= keyLimit) {
    keyHits.set(key, activeKeyHits);
    return {
      scope: "ip",
      retryAfterSeconds: Math.max(1, Math.ceil((activeKeyHits[0] + windowMs - now) / 1000)),
    };
  }
  if (activeGlobalHits.length >= globalLimit) {
    globalHits.set("global", activeGlobalHits);
    return {
      scope: "global",
      retryAfterSeconds: Math.max(1, Math.ceil((activeGlobalHits[0] + windowMs - now) / 1000)),
    };
  }

  activeKeyHits.push(now);
  activeGlobalHits.push(now);
  keyHits.set(key, activeKeyHits);
  globalHits.set("global", activeGlobalHits);

  if (keyHits.size > 5_000) {
    for (const [storedKey, timestamps] of keyHits) {
      if (!timestamps.some((timestamp) => now - timestamp < windowMs)) keyHits.delete(storedKey);
    }
  }

  return null;
}
