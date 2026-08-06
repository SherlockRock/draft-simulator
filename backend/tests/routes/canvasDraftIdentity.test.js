import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  CANVAS_DRAFT_ATTRIBUTES,
} = require("../../routes/canvasProjections");

/**
 * Clients reconcile their canvasDrafts store keyed on draft_id. Dropping it
 * from the payload does not fail loudly — the key silently becomes `undefined`
 * for every Card, which is worse than the positional reconcile it replaced.
 * This payload has no ORDER BY (and any drag's UPDATE can relocate a heap row),
 * so identity has to travel on the wire.
 */
describe("canvas draft projection", () => {
  it("carries the Card's wire identity", () => {
    expect(CANVAS_DRAFT_ATTRIBUTES).toContain("draft_id");
  });

  it("is the single source of truth for the canvas payload's Card fields", () => {
    expect(CANVAS_DRAFT_ATTRIBUTES).toEqual([
      "draft_id",
      "positionX",
      "positionY",
      "is_locked",
      "group_id",
      "source_type",
      "team1Name",
      "team2Name",
    ]);
  });
});
