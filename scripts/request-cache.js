/** Joins concurrent retries, expires completed results, and releases failed requests while preserving action-specific validation. */
export function oncePerOperation(cache, { key, fingerprint, ttlMs, reuseError }, operation) {
  const now = Date.now();
  for (const [entryKey, entry] of cache) {
    if (entry.completedAt && now - entry.completedAt > ttlMs) cache.delete(entryKey);
  }
  const prior = cache.get(key);
  if (prior) {
    if (prior.fingerprint !== fingerprint) throw new Error(reuseError);
    return prior.promise;
  }
  const entry = { fingerprint, promise: Promise.resolve().then(operation), completedAt: null };
  cache.set(key, entry);
  entry.promise.then(
    () => { entry.completedAt = Date.now(); },
    () => { if (cache.get(key) === entry) cache.delete(key); }
  );
  return entry.promise;
}
