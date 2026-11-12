import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  isPlaceholderTeamName,
  withoutPlaceholderTeamNames,
} = require("../../utils/teamPlaceholders");

describe("isPlaceholderTeamName", () => {
  it.each(["Team 1", " team 2 ", "TEAM 1", "team 2"])("%j is a placeholder", (n) => {
    expect(isPlaceholderTeamName(n)).toBe(true);
  });

  it.each(["Team 3", "Team 10", "", "  ", null, undefined, "DOG", 1])(
    "%j is not a placeholder",
    (n) => {
      expect(isPlaceholderTeamName(n)).toBe(false);
    },
  );
});

describe("withoutPlaceholderTeamNames", () => {
  it("drops a placeholder name and keeps everything else", () => {
    expect(
      withoutPlaceholderTeamNames({
        blueTeamName: "Team 1",
        redTeamName: "DOG",
        gameType: "official",
      }),
    ).toEqual({ redTeamName: "DOG", gameType: "official" });
  });

  it("drops blank and padded placeholder names", () => {
    const result = withoutPlaceholderTeamNames({
      blueTeamName: "   ",
      redTeamName: " team 2 ",
      length: 3,
    });
    expect(result).toEqual({ length: 3 });
    expect(Object.prototype.hasOwnProperty.call(result, "blueTeamName")).toBe(false);
  });

  it("drops a null or non-string name but keeps a real one", () => {
    expect(
      withoutPlaceholderTeamNames({ blueTeamName: null, redTeamName: "MEOW" }),
    ).toEqual({ redTeamName: "MEOW" });
  });

  it("does not mutate its input", () => {
    const input = { blueTeamName: "Team 1", redTeamName: "Team 2" };
    const result = withoutPlaceholderTeamNames(input);
    expect(input).toEqual({ blueTeamName: "Team 1", redTeamName: "Team 2" });
    expect(result).not.toBe(input);
  });

  it("returns an empty object for a missing input", () => {
    expect(withoutPlaceholderTeamNames(undefined)).toEqual({});
  });
});
