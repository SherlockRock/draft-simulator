// backend/routes/scouting.js
const express = require("express");
const auth = require("../middleware/auth");
const { perUserThrottle } = require("../middleware/throttle");
const scoutService = require("../services/scoutService");

function isNonEmptyString(v) {
  return typeof v === "string" && v.trim().length > 0;
}

// Factory so each instance owns its own throttle hit-map. Production uses one
// shared router; tests build isolated routers to avoid cross-test throttle leak.
// auth.protect and scoutService.scoutPlayer are referenced through their module
// objects (not destructured at load) so vi.spyOn(...) on them is honored.
function makeScoutingRouter({ windowMs = 10_000, max = 3 } = {}) {
  const router = express.Router();
  // 3 scouts / 10s per user — enough for a quick re-try, not an amplifier.
  const scoutThrottle = perUserThrottle({ windowMs, max });

  router.post(
    "/player",
    (req, res, next) => auth.protect(req, res, next),
    scoutThrottle,
    async (req, res) => {
      const { region, gameName, tagLine } = req.body || {};
      if (![region, gameName, tagLine].every(isNonEmptyString)) {
        return res
          .status(400)
          .json({ error: "region, gameName and tagLine are required non-empty strings" });
      }
      try {
        const envelope = await scoutService.scoutPlayer({
          region: region.trim(),
          gameName: gameName.trim(),
          tagLine: tagLine.trim(),
        });
        return res.json(envelope);
      } catch (err) {
        console.error("scout player failed:", err);
        return res.status(502).json({ error: "Failed to fetch player data from u.gg" });
      }
    }
  );

  return router;
}

module.exports = { router: makeScoutingRouter(), makeScoutingRouter };
