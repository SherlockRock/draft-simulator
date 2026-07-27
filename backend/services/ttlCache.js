// backend/services/ttlCache.js
//
// Tiny in-process TTL + LRU cache. No timers: entries expire lazily on read and
// the least-recently-used entry is evicted on write once maxEntries is reached.
// A sweeper interval would keep the node process (and vitest) alive for nothing.
//
// Recency rides on Map's insertion order — re-inserting a key moves it to the
// back, so the front of the iterator is always the least-recently-used entry.

// `now` is resolved per call rather than captured, so a clock swapped in after
// the cache is built (vi.useFakeTimers) still governs expiry.
function createTtlCache({ ttlMs, maxEntries = 500, now = () => Date.now() } = {}) {
  const entries = new Map(); // key -> { value, expiresAt }

  return {
    get(key) {
      const entry = entries.get(key);
      if (!entry) return undefined;
      if (now() >= entry.expiresAt) {
        entries.delete(key);
        return undefined;
      }
      entries.delete(key);
      entries.set(key, entry); // touch: most recently used
      return entry.value;
    },

    set(key, value) {
      entries.delete(key);
      entries.set(key, { value, expiresAt: now() + ttlMs });
      while (entries.size > maxEntries) {
        entries.delete(entries.keys().next().value);
      }
    },

    delete(key) {
      entries.delete(key);
    },

    clear() {
      entries.clear();
    },

    get size() {
      return entries.size;
    },
  };
}

module.exports = { createTtlCache };
