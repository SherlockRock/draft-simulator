import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  SERIES_PADDING_X,
  SERIES_GAME_STEP,
  SERIES_FIRST_CARD_Y,
  nextSeriesCardOrigin,
  seriesCardOrigin,
} = require("../../utils/seriesCardLayout");

describe("series card layout", () => {
  it("exposes the chrome numbers", () => {
    expect(SERIES_PADDING_X).toBe(0);
    expect(SERIES_GAME_STEP).toBe(380);
    expect(SERIES_FIRST_CARD_Y).toBe(172.5);
  });

  it("seriesCardOrigin steps by the game step at a fixed y", () => {
    expect(seriesCardOrigin(0)).toEqual({ x: 0, y: 172.5 });
    expect(seriesCardOrigin(2)).toEqual({ x: 760, y: 172.5 });
  });

  it("nextSeriesCardOrigin agrees with seriesCardOrigin", () => {
    expect(nextSeriesCardOrigin(null)).toEqual(seriesCardOrigin(0));
    expect(
      nextSeriesCardOrigin({ positionX: 380, positionY: 172.5 }),
    ).toEqual(seriesCardOrigin(2));
  });
});
