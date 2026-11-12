// CDragon's alias casing drifts from the canonical alias used by champion-meta.json,
// the engine and the frontend catalog. Normalise the known divergences so every
// consumer emits engine-canonical aliases.
const ALIAS_OVERRIDES = {
  FiddleSticks: "Fiddlesticks",
};

/**
 * @param {string} alias CDragon alias
 * @returns {string} engine-canonical alias
 */
function canonicalizeAlias(alias) {
  return ALIAS_OVERRIDES[alias] ?? alias;
}

module.exports = { canonicalizeAlias };
