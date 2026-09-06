// backend/tests/navigator/navigator_engine_boot_line.test.js
// Same loading pattern as backend/tests/services/navigatorEngine.test.js:1-10:
// the service is CommonJS and builds the engine singleton at module load, so
// it is loaded through createRequire (which already works there).
import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { formatPositionsSourceLine } = require("../../services/navigatorEngine");

// The expected strings below are the SAME strings scripts/champion-positions/derive.test.mjs
// pins for formatPositionsSource — the backend keeps a verbatim CommonJS copy of that
// function, and these tests are what keep the copies from drifting.
describe("formatPositionsSourceLine", () => {
  it("names the provenance the compile carried into champion-meta.json, with its feasibility", () => {
    const line = formatPositionsSourceLine({
      cdragonScrapedAt: "x",
      merakiScrapedAt: "y",
      positions: { kind: "corpus", patches: ["16.15", "16.16"], games: 300885, threshold: 0.1, generatedAt: "2026-09-05T10:00:00.000Z", feasibility: { sets: 34159, bothSides: 0.785 } },
    });
    expect(line).toBe("[navigator] champion-meta positions: corpus patches=16.15,16.16 threshold=0.1 generated=2026-09-05T10:00:00.000Z feasibility=0.785");
  });

  it("shows a carried-forward feasibility and an unmeasured-at-parity source", () => {
    expect(formatPositionsSourceLine({ positions: { kind: "corpus", patches: ["16.17"], games: 1, threshold: 0.1, generatedAt: "2026-10-01T00:00:00.000Z",
      feasibility: { sets: 34159, bothSides: 0.785, carriedFrom: { generatedAt: "2026-09-05T10:00:00.000Z", kind: "corpus" } } } })).toBe(
      "[navigator] champion-meta positions: corpus patches=16.17 threshold=0.1 generated=2026-10-01T00:00:00.000Z feasibility=0.785 (carried from 2026-09-05T10:00:00.000Z)",
    );
    expect(formatPositionsSourceLine({ positions: { kind: "ugg", patches: ["16_8"], games: 450, gamesUnit: "champion-matches", unmeasuredAtParity: true, threshold: 0.1, generatedAt: "x" } })).toBe(
      "[navigator] champion-meta positions: ugg patches=16_8 threshold=0.1 generated=x feasibility=unmeasured [source unmeasured at parity]",
    );
    expect(formatPositionsSourceLine({ positions: { kind: "corpus", patches: ["16.15", "16.16"], games: 300885, threshold: 0.1, generatedAt: "x" } })).toBe(
      "[navigator] champion-meta positions: corpus patches=16.15,16.16 threshold=0.1 generated=x feasibility=unmeasured",
    );
  });

  it("says so when no provenance is recorded (a pre-refresh or hand-edited compile)", () => {
    expect(formatPositionsSourceLine({ cdragonScrapedAt: "x" })).toBe(
      "[navigator] champion-meta positions: none recorded (Meraki verbatim)",
    );
    expect(formatPositionsSourceLine(undefined)).toBe(
      "[navigator] champion-meta positions: none recorded (Meraki verbatim)",
    );
  });
});
