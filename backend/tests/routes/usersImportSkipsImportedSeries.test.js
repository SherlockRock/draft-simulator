import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRequire } from "node:module";
import express from "express";
import request from "supertest";

const require = createRequire(import.meta.url);
const auth = require("../../middleware/auth");
const sequelize = require("../../config/database");
const socketService = require("../../middleware/socketService");
const canvasProjections = require("../../routes/canvasProjections");
const {
  Canvas,
  UserCanvas,
  CanvasDraft,
  CanvasGroup,
} = require("../../models/Canvas");
const Draft = require("../../models/Draft");
const VersusDraft = require("../../models/VersusDraft");

/**
 * S3 (Task 6 review, MAJOR 2): both JSON imports match an existing series by
 * owner + name. An imported series (its VersusDraft has a league_series_id)
 * is named "<team1> vs <team2>" and owned by its sender, so an "overwrite"
 * import of a series with that name would rewrite esclub's data in place and
 * destroy its games. The name lookups leave imported series out, so the import
 * creates a new manual series instead.
 */

function buildApp() {
  const routePath = require.resolve("../../routes/users");
  delete require.cache[routePath];
  const app = express();
  app.use(express.json());
  app.use("/api/users", require("../../routes/users"));
  return app;
}

const SERIES_NAME = "Alpha vs Beta";

let importedGame;
let importedSeries;
let transaction;

/**
 * A database stand-in for VersusDraft.findOne: the imported series matches
 * any owner + name where that does not filter on `league_series_id: null`.
 */
function findOneLikeTheDatabase({ where }) {
  if (where.owner_id !== "u1" || where.name !== SERIES_NAME) return null;
  if (
    Object.prototype.hasOwnProperty.call(where, "league_series_id") &&
    where.league_series_id === null
  ) {
    return null;
  }
  return importedSeries;
}

beforeEach(() => {
  vi.restoreAllMocks();
  transaction = {
    finished: false,
    commit: vi.fn().mockImplementation(async () => {
      transaction.finished = "commit";
    }),
    rollback: vi.fn().mockImplementation(async () => {
      transaction.finished = "rollback";
    }),
  };
  importedGame = {
    id: "d-imported",
    seriesIndex: 0,
    name: "Game 1",
    update: vi.fn().mockResolvedValue(undefined),
    destroy: vi.fn().mockResolvedValue(undefined),
  };
  importedSeries = {
    id: "vd-imported",
    name: SERIES_NAME,
    league_series_id: "ls-1",
    Drafts: [importedGame, { ...importedGame, id: "d-imported-2", seriesIndex: 1 }],
    update: vi.fn().mockResolvedValue(undefined),
  };

  vi.spyOn(auth, "protect").mockImplementation((req, _res, next) => {
    req.user = { id: "u1" };
    next();
  });
  vi.spyOn(socketService, "emitToRoom").mockImplementation(() => {});
  vi.spyOn(canvasProjections, "buildCanvasSnapshot").mockResolvedValue({
    canvas: { id: "c-1" },
  });
  vi.spyOn(sequelize, "transaction").mockResolvedValue(transaction);
  vi.spyOn(UserCanvas, "findOne").mockResolvedValue({ permissions: "edit" });
  vi.spyOn(Canvas, "findByPk").mockResolvedValue({
    id: "c-1",
    changed: vi.fn(),
    save: vi.fn().mockResolvedValue(undefined),
  });
  vi.spyOn(VersusDraft, "findOne").mockImplementation(async (options) =>
    findOneLikeTheDatabase(options),
  );
  vi.spyOn(VersusDraft, "create").mockImplementation(async (values) => ({
    id: "vd-new",
    ...values,
    Drafts: [],
  }));
  vi.spyOn(Draft, "create").mockImplementation(async (values) => ({
    id: `d-new-${values.seriesIndex}`,
    ...values,
  }));
  vi.spyOn(Draft, "findAll").mockResolvedValue([]);
  vi.spyOn(CanvasGroup, "findOne").mockResolvedValue(null);
  vi.spyOn(CanvasGroup, "findAll").mockResolvedValue([]);
  vi.spyOn(CanvasGroup, "create").mockResolvedValue({ id: "g-new" });
  vi.spyOn(CanvasDraft, "create").mockResolvedValue({});
});

const expectImportedSeriesUntouched = () => {
  expect(importedSeries.update).not.toHaveBeenCalled();
  for (const game of importedSeries.Drafts) {
    expect(game.update).not.toHaveBeenCalled();
    expect(game.destroy).not.toHaveBeenCalled();
  }
};

const expectEveryNameLookupSkipsImported = () => {
  expect(VersusDraft.findOne).toHaveBeenCalled();
  for (const [options] of VersusDraft.findOne.mock.calls) {
    expect(options.where).toMatchObject({ league_series_id: null });
  }
};

const picks = () => Array(20).fill("");

describe("POST /me/import/canvas/:canvasId (canvas JSON) and an imported series", () => {
  it.each(["overwrite", "skip", "rename"])(
    "creates a new manual series under %s instead of matching the imported one",
    async (dedupeStrategy) => {
      const res = await request(buildApp())
        .post("/api/users/me/import/canvas/c-1")
        .send({
          data: {
            drafts: [],
            versusSeries: [
              {
                name: SERIES_NAME,
                seriesLength: 1,
                blueTeamName: "Alpha",
                redTeamName: "Beta",
                drafts: [{ picks: picks(), winner: "red", blueSideTeam: 2 }],
              },
            ],
          },
          options: { dedupeStrategy },
        });

      expect(res.body.error).toBeUndefined();
      expect(res.status).toBe(200);
      expect(res.body.summary.seriesCreated).toBe(1);
      expect(res.body.summary.seriesUpdated).toBe(0);
      expect(res.body.summary.seriesSkipped).toBe(0);
      expect(VersusDraft.create).toHaveBeenCalledWith(
        expect.objectContaining({ name: SERIES_NAME, origin: "manual" }),
        expect.anything(),
      );
      expectImportedSeriesUntouched();
      expectEveryNameLookupSkipsImported();
    },
  );
});

describe("POST /me/import (account export) and an imported series", () => {
  it.each(["overwrite", "skip", "rename"])(
    "creates a new manual series under %s instead of matching the imported one",
    async (dedupeStrategy) => {
      const res = await request(buildApp())
        .post("/api/users/me/import")
        .send({
          exportData: {
            exportedAt: "2026-11-14T00:00:00.000Z",
            canvases: [],
            versusSeries: [
              {
                id: "s-1",
                name: SERIES_NAME,
                seriesLength: 1,
                blueTeamName: "Alpha",
                redTeamName: "Beta",
                drafts: [{ id: "x-1", name: "Game 1", picks: picks(), winner: "red" }],
              },
            ],
          },
          options: {
            canvasIds: [],
            versusSeriesIds: ["s-1"],
            dedupeStrategy,
            canvasImportMode: "new_canvases",
          },
        });

      expect(res.body.error).toBeUndefined();
      expect(res.status).toBe(200);
      expect(res.body.summary.seriesCreated).toBe(1);
      expect(res.body.summary.seriesUpdated).toBe(0);
      expect(res.body.summary.seriesSkipped).toBe(0);
      expect(VersusDraft.create).toHaveBeenCalledWith(
        expect.objectContaining({ name: SERIES_NAME, origin: "manual" }),
        expect.anything(),
      );
      expectImportedSeriesUntouched();
      expectEveryNameLookupSkipsImported();
    },
  );
});
