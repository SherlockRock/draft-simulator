import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const VersusDraft = require("../../models/VersusDraft");

function buildSeries(length) {
  return VersusDraft.build({
    name: `Length ${length}`,
    blueTeamName: "Team 1",
    redTeamName: "Team 2",
    length,
  });
}

describe("VersusDraft length validation", () => {
  it("accepts every series length from 1 through 7", async () => {
    for (let length = 1; length <= 7; length += 1) {
      await expect(buildSeries(length).validate()).resolves.toBeDefined();
    }
  });

  it("rejects series lengths outside 1 through 7", async () => {
    await expect(buildSeries(0).validate()).rejects.toThrow();
    await expect(buildSeries(8).validate()).rejects.toThrow();
  });
});
