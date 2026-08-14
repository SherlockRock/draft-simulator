import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRequire } from "node:module";
import express from "express";
import request from "supertest";

const require = createRequire(import.meta.url);
const auth = require("../../middleware/auth");
const socketService = require("../../middleware/socketService");
const {
  Canvas,
  UserCanvas,
  CanvasDraft,
  CanvasConnection,
  CanvasGroup,
  CanvasAnnotation,
} = require("../../models/Canvas.js");
const Draft = require("../../models/Draft.js");
const VersusDraft = require("../../models/VersusDraft.js");
const Team = require("../../models/Team");

// Series chrome from frontend/src/utils/helpers.ts, restated so a drift in the
// route's own constants fails here instead of silently.
const SERIES_PADDING_X = 0;
const SERIES_PADDING_Y = 20;
const SERIES_HEADER_HEIGHT = 56;
const GROUP_BORDER_WIDTH = 2;
const SERIES_GAME_CONTROLS_HEIGHT = 94.5;
const SERIES_GAME_STEP = 380;

// The composite the route seeds a first game Card at (§6.0a Task 0). The
// controls block sits above each game's Card and was missing from every one of
// these mirrors until then.
const SERIES_FIRST_CARD_Y =
  GROUP_BORDER_WIDTH +
  SERIES_HEADER_HEIGHT +
  SERIES_PADDING_Y +
  SERIES_GAME_CONTROLS_HEIGHT;

function loadRouter() {
  const routePath = require.resolve("../../routes/canvas");
  delete require.cache[routePath];
  return require("../../routes/canvas");
}

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/canvas", loadRouter());
  return app;
}

// A group far from the origin: with positionX/Y at 0 the world-coordinate bug
// and the container-relative fix produce nearly the same numbers, so the group
// has to sit somewhere for this to test anything.
const GROUP_X = 900;
const GROUP_Y = 700;

let group;
let transaction;

beforeEach(() => {
  vi.restoreAllMocks();
  group = {
    id: "g-1",
    canvas_id: "c-1",
    type: "custom",
    positionX: GROUP_X,
    positionY: GROUP_Y,
    metadata: {},
    update: vi.fn().mockResolvedValue(),
    toJSON() {
      return { id: this.id, canvas_id: this.canvas_id, type: "series" };
    },
  };
  transaction = {
    commit: vi.fn().mockResolvedValue(),
    rollback: vi.fn().mockResolvedValue(),
    finished: false,
  };

  vi.spyOn(auth, "protect").mockImplementation((req, _res, next) => {
    req.user = { id: "u1" };
    next();
  });
  vi.spyOn(socketService, "emitToRoom").mockImplementation(() => {});
  vi.spyOn(UserCanvas, "findOne").mockResolvedValue({ permissions: "edit" });
  vi.spyOn(Canvas.sequelize, "transaction").mockResolvedValue(transaction);
  vi.spyOn(Canvas, "findByPk").mockResolvedValue({
    changed: vi.fn(),
    save: vi.fn().mockResolvedValue(),
    toJSON: () => ({ id: "c-1" }),
  });

  vi.spyOn(CanvasGroup, "findOne").mockResolvedValue(group);
  vi.spyOn(CanvasGroup, "findAll").mockResolvedValue([]);
  vi.spyOn(CanvasGroup, "count").mockResolvedValue(0);
  vi.spyOn(CanvasDraft, "findAll").mockResolvedValue([]);
  vi.spyOn(CanvasDraft, "create").mockImplementation(async (values) => ({
    ...values,
    toJSON: () => values,
  }));
  vi.spyOn(CanvasConnection, "findAll").mockResolvedValue([]);
  vi.spyOn(CanvasAnnotation, "findAll").mockResolvedValue([]);
  vi.spyOn(CanvasAnnotation, "count").mockResolvedValue(0);
  vi.spyOn(Draft, "create").mockImplementation(async (values) => ({
    ...values,
    id: `d-${values.seriesIndex}`,
    toJSON: () => values,
  }));
  vi.spyOn(Team, "findAll").mockResolvedValue([]);
});

// A Card's positionX/Y are relative to its immediate container (ADR-0006).
// These routes used to seed a brand-new series' first game at
// `group.positionX + 24` / `group.positionY + 64` — a world coordinate — while
// every later game continued from the previous Card's relative one. The mix is
// invisible while series rendering computes interiors from seriesIndex, and
// becomes a jump of one group-position the moment the series is ungrouped.
describe("series game Cards are placed relative to their group", () => {
  describe("POST /:canvasId/group/:groupId/convert-to-series", () => {
    const convert = (length) =>
      request(buildApp())
        .post("/api/canvas/c-1/group/g-1/convert-to-series")
        .send({
          name: "Custom Series",
          blueTeamName: "MEOW",
          redTeamName: "TSR",
          length,
          type: "standard",
          disabledChampions: [],
        });

    beforeEach(() => {
      vi.spyOn(VersusDraft, "create").mockResolvedValue({
        id: "vd-1",
        blueTeamName: "MEOW",
        redTeamName: "TSR",
        length: 3,
        type: "standard",
        disabledChampions: [],
      });
    });

    it("seeds the first game at the series' own padding, not the group's world position", async () => {
      const res = await convert(1);

      expect(res.status).toBe(201);
      expect(CanvasDraft.create).toHaveBeenCalledWith(
        expect.objectContaining({
          positionX: SERIES_PADDING_X,
          positionY: SERIES_FIRST_CARD_Y,
          group_id: "g-1",
        }),
        expect.anything(),
      );
    });

    it("steps later games from that same relative origin", async () => {
      const res = await convert(3);

      expect(res.status).toBe(201);
      const placed = CanvasDraft.create.mock.calls.map(([values]) => values);
      expect(placed.map((v) => v.positionX)).toEqual([
        SERIES_PADDING_X,
        SERIES_PADDING_X + SERIES_GAME_STEP,
        SERIES_PADDING_X + 2 * SERIES_GAME_STEP,
      ]);
      for (const values of placed) {
        expect(values.positionY).toBe(SERIES_FIRST_CARD_Y);
      }
    });

    // The pre-existing Card is already relative, and the branch that continues
    // from it was always correct — it must stay correct.
    it("continues from an existing Card's relative position", async () => {
      CanvasDraft.findAll.mockResolvedValue([
        {
          positionX: 16,
          positionY: 64,
          Draft: {
            id: "d-existing",
            update: vi.fn().mockResolvedValue(),
            toJSON: () => ({ id: "d-existing" }),
          },
          update: vi.fn().mockResolvedValue(),
          toJSON: () => ({ draft_id: "d-existing" }),
        },
      ]);

      const res = await convert(2);

      expect(res.status).toBe(201);
      expect(CanvasDraft.create).toHaveBeenCalledWith(
        expect.objectContaining({
          positionX: 16 + SERIES_GAME_STEP,
          positionY: 64,
        }),
        expect.anything(),
      );
    });
  });

  describe("POST /:canvasId/import/series", () => {
    it("places imported games relative to the group it just created", async () => {
      vi.spyOn(VersusDraft, "findByPk").mockResolvedValue({
        id: "vd-1",
        name: "Imported",
        blueTeamName: "MEOW",
        redTeamName: "TSR",
        length: 2,
        type: "standard",
        origin: "live",
        competitive: false,
        disabledChampions: [],
        Drafts: [
          { id: "d-0", seriesIndex: 0, toJSON: () => ({ id: "d-0" }) },
          { id: "d-1", seriesIndex: 1, toJSON: () => ({ id: "d-1" }) },
        ],
      });
      vi.spyOn(CanvasGroup, "create").mockResolvedValue({
        id: "g-new",
        toJSON: () => ({ id: "g-new" }),
      });

      const res = await request(buildApp())
        .post("/api/canvas/c-1/import/series")
        .send({ versusDraftId: "vd-1", positionX: GROUP_X, positionY: GROUP_Y });

      expect(res.status).toBe(201);
      const placed = CanvasDraft.create.mock.calls.map(([values]) => values);
      expect(placed.map((v) => v.positionX)).toEqual([
        SERIES_PADDING_X,
        SERIES_PADDING_X + SERIES_GAME_STEP,
      ]);
      for (const values of placed) {
        expect(values.positionY).toBe(SERIES_FIRST_CARD_Y);
        expect(values.group_id).toBe("g-new");
      }
    });
  });
});
