// Reserve CPU capacity for OCR, the filter, and the coordinating process.
export function threadCandidates(available, workers) {
  const limit = Math.max(1, Math.min(8, available - workers - 2));
  return limit < 4 ? [limit] : Array.from({ length: limit - 3 }, (_, i) => i + 4);
}

export function fastestThreads(trials) {
  const totals = new Map();
  for (const { threads, elapsedMs } of trials)
    totals.set(threads, (totals.get(threads) ?? 0) + elapsedMs);
  const best = Math.min(...totals.values());
  // Prefer fewer threads when measurements differ by less than 3%.
  return Math.min(...[...totals].filter(([, ms]) => ms <= best * 1.03).map(([n]) => n));
}

export function memoizeOcr(cache, key, create, limit = 2048) {
  if (cache.has(key)) {
    const value = cache.get(key);
    cache.delete(key);
    cache.set(key, value);
    return value;
  }
  if (cache.size >= limit) cache.delete(cache.keys().next().value);
  const pending = Promise.resolve().then(create);
  cache.set(key, pending);
  pending.catch(() => {
    if (cache.get(key) === pending) cache.delete(key);
  });
  return pending;
}
