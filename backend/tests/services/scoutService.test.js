import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const scoutService = require("../../services/scoutService");
const { SCOUT_CACHE_TTL_MS } = scoutService;

const envelope = {
  provider: "ugg", schemaVersion: 1, fetchedAt: "2026-06-28T12:00:00.000Z",
  season: "2026-S1", queue: "ranked_solo_5x5",
  entries: [{ championId: "Sylas", role: "mid", games: 37, wins: 22, lastPlayed: null, recentWindowGames: null }],
};

beforeEach(() => {
  vi.restoreAllMocks();
  scoutService.scoutCache.clear();
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

describe("scoutService.scoutPlayer caching", () => {
  const foo = { region: "na1", gameName: "Foo", tagLine: "NA1" };

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("serves a repeat scout of the same player from cache", async () => {
    const fetchPlayer = vi.spyOn(scoutService, "fetchPlayer").mockResolvedValue(envelope);
    const first = await scoutService.scoutPlayer(foo);
    const second = await scoutService.scoutPlayer(foo);
    expect(fetchPlayer).toHaveBeenCalledTimes(1);
    expect(first).toBe(envelope);
    expect(second).toBe(envelope);
  });

  it("re-fetches once the TTL has elapsed", async () => {
    const fetchPlayer = vi.spyOn(scoutService, "fetchPlayer").mockResolvedValue(envelope);
    await scoutService.scoutPlayer(foo);
    vi.advanceTimersByTime(SCOUT_CACHE_TTL_MS);
    await scoutService.scoutPlayer(foo);
    expect(fetchPlayer).toHaveBeenCalledTimes(2);
  });

  it("does not cache a failed fetch", async () => {
    const fetchPlayer = vi
      .spyOn(scoutService, "fetchPlayer")
      .mockRejectedValueOnce(new Error("u.gg 502"))
      .mockResolvedValueOnce(envelope);
    await expect(scoutService.scoutPlayer(foo)).rejects.toThrow("u.gg 502");
    await expect(scoutService.scoutPlayer(foo)).resolves.toBe(envelope);
    expect(fetchPlayer).toHaveBeenCalledTimes(2);
  });

  it("keys on region, gameName and tagLine together", async () => {
    const fetchPlayer = vi.spyOn(scoutService, "fetchPlayer").mockResolvedValue(envelope);
    await scoutService.scoutPlayer(foo);
    await scoutService.scoutPlayer({ ...foo, gameName: "Bar" });
    await scoutService.scoutPlayer({ ...foo, tagLine: "EUW" });
    await scoutService.scoutPlayer({ ...foo, region: "euw1" });
    expect(fetchPlayer).toHaveBeenCalledTimes(4);
  });

  // Riot game names may contain spaces, so a printable key delimiter would let
  // one player's id be forged into another's cache entry.
  it("does not let a game name containing the delimiter collide with another key", async () => {
    const fetchPlayer = vi.spyOn(scoutService, "fetchPlayer").mockResolvedValue(envelope);
    await scoutService.scoutPlayer({ region: "na1", gameName: "Foo Bar", tagLine: "NA1" });
    await scoutService.scoutPlayer({ region: "na1 Foo", gameName: "Bar", tagLine: "NA1" });
    expect(fetchPlayer).toHaveBeenCalledTimes(2);
  });

  it("treats keys case-insensitively", async () => {
    const fetchPlayer = vi.spyOn(scoutService, "fetchPlayer").mockResolvedValue(envelope);
    await scoutService.scoutPlayer(foo);
    await scoutService.scoutPlayer({ region: "NA1", gameName: "fOO", tagLine: "na1" });
    expect(fetchPlayer).toHaveBeenCalledTimes(1);
  });

  it("fetches the u.gg client with the caller's original casing", async () => {
    const fetchPlayer = vi.spyOn(scoutService, "fetchPlayer").mockResolvedValue(envelope);
    await scoutService.scoutPlayer(foo);
    expect(fetchPlayer).toHaveBeenCalledWith(foo);
  });

  it("refresh: true bypasses the cache and stores the fresh envelope", async () => {
    const fresh = { ...envelope, fetchedAt: "2026-06-28T13:00:00.000Z" };
    const fetchPlayer = vi
      .spyOn(scoutService, "fetchPlayer")
      .mockResolvedValueOnce(envelope)
      .mockResolvedValueOnce(fresh);
    await scoutService.scoutPlayer(foo);
    expect(await scoutService.scoutPlayer({ ...foo, refresh: true })).toBe(fresh);
    expect(fetchPlayer).toHaveBeenCalledTimes(2);
    expect(await scoutService.scoutPlayer(foo)).toBe(fresh);
    expect(fetchPlayer).toHaveBeenCalledTimes(2);
  });

  it("re-scouting an overlapping roster only fetches the players it has not seen", async () => {
    const fetchPlayer = vi.spyOn(scoutService, "fetchPlayer").mockResolvedValue(envelope);
    await scoutService.scoutPlayers({
      region: "na1",
      players: [{ gameName: "Foo", tagLine: "NA1" }, { gameName: "Bar", tagLine: "NA1" }],
    });
    await scoutService.scoutPlayers({
      region: "na1",
      players: [{ gameName: "Foo", tagLine: "NA1" }, { gameName: "Baz", tagLine: "NA1" }],
    });
    expect(fetchPlayer).toHaveBeenCalledTimes(3);
  });
});
