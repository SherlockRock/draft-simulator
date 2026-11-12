// Series chrome, mirroring SERIES_PADDING_X / SERIES_PADDING_Y /
// SERIES_HEADER_HEIGHT in frontend/src/utils/helpers.ts. A Card's positionX/Y
// are relative to its immediate container, so the first game of a brand-new
// series seeds at the series' own padding — NOT at the group's world position,
// which is what the series-creation paths in routes/canvas.js used to add on
// top of it (and the JSON import in routes/users.js, until P1).
//
// X is 0 so a Bo-N series measures exactly N grid columns (design §6). These
// three runtimes — this file, the frontend, and useLocalCanvasMutations —
// must move together or a Card jumps the moment it leaves a series.
const SERIES_PADDING_X = 0;
const SERIES_PADDING_Y = 20;
const SERIES_HEADER_HEIGHT = 56;
// GROUP_BORDER_WIDTH and SERIES_GAME_CONTROLS_HEIGHT mirror helpers.ts too.
// The controls block is the per-game team panels that sit ABOVE each game's
// Card; it arrived in e442845 and was missing from the seed until §6.0a Task 0,
// which put the seed ~96.5px above where the Card actually paints.
const GROUP_BORDER_WIDTH = 2;
const SERIES_GAME_CONTROLS_HEIGHT = 94.5;
const SERIES_GAME_STEP = 380;

// The container-relative y of a series' first game Card. Mirrors the composite
// in getSeriesDraftWorldPosition — change one, change all four mirrors (this file,
// helpers.ts, useLocalCanvasMutations, and the two test files' private copies).
const SERIES_FIRST_CARD_Y =
  GROUP_BORDER_WIDTH +
  SERIES_HEADER_HEIGHT +
  SERIES_PADDING_Y +
  SERIES_GAME_CONTROLS_HEIGHT;

// Where the next game Card goes, given the last one already placed (if any).
// Both coordinates stay container-relative in either branch.
function nextSeriesCardOrigin(lastCanvasDraft) {
  return {
    x: lastCanvasDraft
      ? lastCanvasDraft.positionX + SERIES_GAME_STEP
      : SERIES_PADDING_X,
    y: lastCanvasDraft ? lastCanvasDraft.positionY : SERIES_FIRST_CARD_Y,
  };
}

// The container-relative origin of the game Card at `index` in a fresh series.
function seriesCardOrigin(index) {
  return {
    x: SERIES_PADDING_X + index * SERIES_GAME_STEP,
    y: SERIES_FIRST_CARD_Y,
  };
}

module.exports = {
  SERIES_PADDING_X,
  SERIES_GAME_STEP,
  SERIES_FIRST_CARD_Y,
  nextSeriesCardOrigin,
  seriesCardOrigin,
};
