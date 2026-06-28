import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const scoutService = require("../../services/scoutService");

const envelope = {
  provider: "ugg", schemaVersion: 1, fetchedAt: "2026-06-28T12:00:00.000Z",
  season: "2026-S1", queue: "ranked_solo_5x5",
  entries: [{ championId: "Sylas", role: "mid", games: 37, wins: 22, lastPlayed: null, recentWindowGames: null }],
};

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("scoutService.scoutPlayers", () => {
  it("returns one ok result per player, carrying the input", async () => {
    vi.spyOn(scoutService, "scoutPlayer").mockResolvedValue(envelope);
    const out = await scoutService.scoutPlayers({
      region: "na1",
      players: [{ gameName: "Foo", tagLine: "NA1" }, { gameName: "Bar", tagLine: "EUW" }],
    });
    expect(out.results).toHaveLength(2);
    expect(out.results[0]).toEqual({
      status: "ok",
      input: { region: "na1", gameName: "Foo", tagLine: "NA1" },
      envelope,
    });
    expect(out.results[1].input.gameName).toBe("Bar");
  });

  it("isolates a per-player failure as an error result; others still ok", async () => {
    vi.spyOn(scoutService, "scoutPlayer")
      .mockResolvedValueOnce(envelope)
      .mockRejectedValueOnce(new Error("u.gg 404"));
    const out = await scoutService.scoutPlayers({
      region: "na1",
      players: [{ gameName: "Good", tagLine: "NA1" }, { gameName: "Bad", tagLine: "NA1" }],
    });
    expect(out.results[0].status).toBe("ok");
    expect(out.results[1]).toEqual({
      status: "error",
      input: { region: "na1", gameName: "Bad", tagLine: "NA1" },
      error: "u.gg 404",
    });
  });
});
