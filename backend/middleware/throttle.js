// backend/middleware/throttle.js
//
// Lightweight in-memory per-user sliding-window throttle. Slice-1 scale
// (personal/friends) — no Redis, no dependency. Guards scout endpoints, which
// trigger outbound u.gg fetches and must not be an open amplifier.

function perUserThrottle({ windowMs, max }) {
  const hits = new Map(); // userId -> number[] (timestamps)

  return function throttle(req, res, next) {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ error: "Not authenticated" });
    }
    const now = Date.now();
    const recent = (hits.get(userId) || []).filter((t) => now - t < windowMs);
    if (recent.length >= max) {
      return res.status(429).json({ error: "Too many scout requests; please slow down." });
    }
    recent.push(now);
    hits.set(userId, recent);
    next();
  };
}

module.exports = { perUserThrottle };
