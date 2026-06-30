import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  getRestrictedChampionsForGroup,
} = require("../../utils/draftRestrictions");

// Picks array layout:
// 0-4 blue bans, 5-9 red bans, 10-14 blue picks, 15-19 red picks
const emptyPicks = () => Array(20).fill("");

const picksWith = (entries) => {
  const picks = emptyPicks();
  for (const [index, champ] of Object.entries(entries)) {
    picks[Number(index)] = champ;
  }
  return picks;
};

describe("getRestrictedChampionsForGroup", () => {
  describe("series groups (ordered by seriesIndex)", () => {
    it("does NOT restrict a champion that only appears in a LATER game", () => {
      // Game 1 (seriesIndex 0) is current; Game 2 (seriesIndex 1) already has Ahri.
      const game1 = { id: "g1", seriesIndex: 0, picks: emptyPicks() };
      const game2 = { id: "g2", seriesIndex: 1, picks: picksWith({ 10: "Ahri" }) };

      const restricted = getRestrictedChampionsForGroup({
        groupType: "series",
        seriesType: "ironman",
        draftMode: "ironman",
        drafts: [game1, game2],
        currentDraftId: "g1",
        currentSeriesIndex: 0,
      });

      // Editing an earlier game must not be blocked by a later game's pick.
      expect(restricted).not.toContain("Ahri");
    });

    it("restricts champions (picks AND bans) from an EARLIER game in ironman", () => {
      const game1 = {
        id: "g1",
        seriesIndex: 0,
        picks: picksWith({ 0: "Jinx", 10: "Ahri" }), // ban + pick
      };
      const game2 = { id: "g2", seriesIndex: 1, picks: emptyPicks() };

      const restricted = getRestrictedChampionsForGroup({
        groupType: "series",
        seriesType: "ironman",
        draftMode: "ironman",
        drafts: [game1, game2],
        currentDraftId: "g2",
        currentSeriesIndex: 1,
      });

      expect(restricted).toContain("Jinx");
      expect(restricted).toContain("Ahri");
    });
  });

  describe("custom groups (symmetric)", () => {
    it("restricts a champion used in ANY other draft regardless of order", () => {
      const a = { id: "a", picks: emptyPicks() };
      const b = { id: "b", picks: picksWith({ 10: "Ahri" }) };

      const restricted = getRestrictedChampionsForGroup({
        groupType: "custom",
        seriesType: undefined,
        draftMode: "fearless",
        drafts: [a, b],
        currentDraftId: "a",
        currentSeriesIndex: 0,
      });

      expect(restricted).toContain("Ahri");
    });
  });
});
