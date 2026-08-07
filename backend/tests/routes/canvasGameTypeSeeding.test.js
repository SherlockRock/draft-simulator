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
} = require("../../models/Canvas.js");
const Draft = require("../../models/Draft.js");
const VersusDraft = require("../../models/VersusDraft.js");
const Team = require("../../models/Team");
const canvasMutations = require("../../services/canvasMutations");

/**
 * gameType seeding, preservation and the clear protocol.
 * Design D2/D3/D7 and required fix R1 in
 * docs/designs/canvas-game-classification-design.md.
 *
 * getSeriesMetadata is route-private, so every case goes through a route.
 */

function buildCanvasApp() {
  const routePath = require.resolve("../../routes/canvas");
  delete require.cache[routePath];
  const app = express();
  app.use(express.json());
  app.use("/api/canvas", require("../../routes/canvas"));
  return app;
}

function buildUsersApp() {
  const routePath = require.resolve("../../routes/users");
  delete require.cache[routePath];
  const app = express();
  app.use(express.json());
  app.use("/api/users", require("../../routes/users"));
  return app;
}

let transaction;

beforeEach(() => {
  vi.restoreAllMocks();
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
  vi.spyOn(canvasMutations, "assertCanvasAccess").mockResolvedValue(undefined);
  vi.spyOn(Canvas.sequelize, "transaction").mockResolvedValue(transaction);
  vi.spyOn(Canvas, "findByPk").mockResolvedValue({
    changed: vi.fn(),
    save: vi.fn().mockResolvedValue(),
    toJSON: () => ({ id: "c-1" }),
  });
  vi.spyOn(CanvasGroup, "findAll").mockResolvedValue([]);
  // convert-to-series refuses a container holding Groups (series-leaf
  // invariant); none of these fixtures nest, so the count is zero.
  vi.spyOn(CanvasGroup, "count").mockResolvedValue(0);
  vi.spyOn(CanvasDraft, "findAll").mockResolvedValue([]);
  vi.spyOn(CanvasConnection, "findAll").mockResolvedValue([]);
  vi.spyOn(CanvasDraft, "create").mockImplementation(async (values) => ({
    ...values,
    toJSON: () => values,
  }));
  vi.spyOn(Draft, "create").mockImplementation(async (values) => ({
    ...values,
    id: "d-1",
    toJSON: () => values,
  }));
  vi.spyOn(Team, "findAll").mockResolvedValue([]);
});

describe("live series import seeds gameType from competitive", () => {
  const importSeries = async (competitive) => {
    vi.spyOn(VersusDraft, "findByPk").mockResolvedValue({
      id: "vd-1",
      name: "Series",
      blueTeamName: "MEOW",
      redTeamName: "TSR",
      length: 3,
      competitive,
      type: "standard",
      origin: "live",
      disabledChampions: [],
      Drafts: [],
    });
    const created = vi.spyOn(CanvasGroup, "create").mockResolvedValue({
      id: "g-1",
      toJSON: () => ({ id: "g-1" }),
    });
    await request(buildCanvasApp())
      .post("/api/canvas/c-1/import/series")
      .send({ versusDraftId: "vd-1" })
      .expect(201);
    return created.mock.calls.at(-1)[0].metadata;
  };

  it("maps competitive: true to official", async () => {
    expect(await importSeries(true)).toMatchObject({ gameType: "official" });
  });

  it("maps competitive: false to scrim", async () => {
    expect(await importSeries(false)).toMatchObject({ gameType: "scrim" });
  });
});

describe("custom -> series conversion (R1 path 2)", () => {
  const convert = async (groupMetadata, body = {}) => {
    const group = {
      id: "g-1",
      canvas_id: "c-1",
      type: "custom",
      positionX: 0,
      positionY: 0,
      metadata: groupMetadata,
      update: vi.fn().mockResolvedValue(),
      toJSON: () => ({ id: "g-1", type: "series" }),
    };
    vi.spyOn(CanvasGroup, "findOne").mockResolvedValue(group);
    vi.spyOn(VersusDraft, "create").mockResolvedValue({
      id: "vd-1",
      blueTeamName: "MEOW",
      redTeamName: "TSR",
      length: 1,
      competitive: false,
      type: "standard",
      origin: "manual",
      disabledChampions: [],
    });
    const res = await request(buildCanvasApp())
      .post("/api/canvas/c-1/group/g-1/convert-to-series")
      .send({
        name: "Custom Series",
        blueTeamName: "MEOW",
        redTeamName: "TSR",
        length: 1,
        type: "standard",
        disabledChampions: [],
        ...body,
      });
    expect(res.status).toBe(201);
    return group.update.mock.calls.at(-1)[0].metadata;
  };

  it("keeps a tag the custom group already carried", async () => {
    expect(await convert({ gameType: "official" })).toMatchObject({
      gameType: "official",
    });
  });

  it("honours a gameType supplied in the conversion body", async () => {
    // normalizeSeriesData returned only six fields, so this used to be discarded.
    expect(await convert({}, { gameType: "official" })).toMatchObject({
      gameType: "official",
    });
  });

  it("preserves unrelated layout metadata the rebuild used to wipe", async () => {
    const metadata = await convert({
      gameType: "scrim",
      layout: "grid",
      gridCols: 3,
      rowLabels: ["a"],
    });
    expect(metadata).toMatchObject({
      gameType: "scrim",
      layout: "grid",
      gridCols: 3,
      rowLabels: ["a"],
    });
  });
});

describe("manual-series settings save (R1 path 1)", () => {
  const saveSettings = async (groupMetadata, body) => {
    const group = {
      id: "g-1",
      canvas_id: "c-1",
      type: "series",
      versus_draft_id: "vd-1",
      metadata: groupMetadata,
      update: vi.fn().mockResolvedValue(),
      toJSON: () => ({ id: "g-1" }),
    };
    const hydrated = { toJSON: () => ({ id: "g-1" }) };
    vi.spyOn(CanvasGroup, "findOne").mockImplementation(async (options) =>
      options?.include ? hydrated : group,
    );
    vi.spyOn(VersusDraft, "findByPk").mockResolvedValue({
      id: "vd-1",
      name: "Series",
      blueTeamName: "MEOW",
      redTeamName: "TSR",
      length: 1,
      // Manual series are always false: normalizeSeriesData never sets it and
      // the model defaults it false. Deriving here would reset the user's choice.
      competitive: false,
      type: "standard",
      origin: "manual",
      disabledChampions: [],
      toJSON() {
        return { ...this };
      },
      update: vi.fn().mockResolvedValue(),
    });
    const res = await request(buildCanvasApp())
      .put("/api/canvas/c-1/group/g-1")
      .send(body);
    expect(res.status).toBe(200);
    return group.update.mock.calls.at(-1)[0].metadata;
  };

  it("keeps a stored official tag through a name + draft-mode change", async () => {
    const metadata = await saveSettings(
      { gameType: "official", blueTeamName: "MEOW", redTeamName: "TSR" },
      {
        name: "Renamed",
        metadata: {
          blueTeamName: "MEOW",
          redTeamName: "TSR",
          draftMode: "fearless",
        },
      },
    );
    expect(metadata).toMatchObject({ gameType: "official" });
  });

  it("keeps the tag on a rename alone, where the request carries no metadata", async () => {
    // The outer guard admits updates.name with no metadata at all, which makes
    // the getSeriesMetadata spread a FULL replacement.
    const metadata = await saveSettings({ gameType: "official" }, {
      name: "Renamed",
    });
    expect(metadata).toMatchObject({ gameType: "official" });
  });

  it("preserves layout metadata across a rename alone", async () => {
    const metadata = await saveSettings(
      { gameType: "scrim", layout: "grid", gridCols: 4 },
      { name: "Renamed" },
    );
    expect(metadata).toMatchObject({ layout: "grid", gridCols: 4 });
  });

  it("applies an explicit gameType sent with the save", async () => {
    const metadata = await saveSettings(
      { gameType: "scrim" },
      { metadata: { gameType: "official" } },
    );
    expect(metadata).toMatchObject({ gameType: "official" });
  });
});

describe("JSON series import (users.js)", () => {
  const sequelize = require("../../config/database");

  // Both branches of the import share ONE metadata object, so create and update
  // need different treatment: create has no existing group to read from.
  const importSeries = async ({
    competitive,
    existingGroup = null,
    dedupeStrategy = "overwrite",
  }) => {
    vi.spyOn(sequelize, "transaction").mockResolvedValue(transaction);
    vi.spyOn(CanvasDraft, "findOne").mockResolvedValue(null);
    vi.spyOn(CanvasDraft, "destroy").mockResolvedValue(0);
    vi.spyOn(VersusDraft, "findOne").mockResolvedValue(null);
    vi.spyOn(VersusDraft, "create").mockResolvedValue({
      id: "vd-1",
      name: "Imported Series",
      blueTeamName: "MEOW",
      redTeamName: "TSR",
      length: 1,
      competitive,
      type: "standard",
      disabledChampions: [],
    });
    vi.spyOn(Draft, "findAll").mockResolvedValue([]);
    vi.spyOn(Draft, "findOne").mockResolvedValue(null);
    vi.spyOn(CanvasGroup, "findOne").mockResolvedValue(existingGroup);
    const created = vi.spyOn(CanvasGroup, "create").mockResolvedValue({
      id: "g-1",
      positionX: 0,
      positionY: 0,
      toJSON: () => ({ id: "g-1" }),
    });

    const res = await request(buildUsersApp())
      .post("/api/users/me/import/canvas/c-1")
      .send({
        data: {
          drafts: [],
          versusSeries: [
            {
              name: "Imported Series",
              blueTeamName: "MEOW",
              redTeamName: "TSR",
              seriesLength: 1,
              draftType: "standard",
              competitive,
              disabledChampions: [],
              drafts: [{ name: "Game 1", picks: Array(20).fill("") }],
            },
          ],
        },
        options: { dedupeStrategy },
      });
    expect(res.status).toBe(200);
    return existingGroup
      ? existingGroup.update.mock.calls.at(-1)[0].metadata
      : created.mock.calls.at(-1)[0].metadata;
  };

  it("seeds a newly created group from series.competitive", async () => {
    expect(await importSeries({ competitive: true })).toMatchObject({
      gameType: "official",
    });
    vi.restoreAllMocks();
  });

  it("seeds scrim for a non-competitive imported series", async () => {
    expect(await importSeries({ competitive: false })).toMatchObject({
      gameType: "scrim",
    });
  });

  it.each(["overwrite", "rename"])(
    "re-import over a tagged group keeps the tag (%s strategy, R1 path 3)",
    async (dedupeStrategy) => {
      // The clobber precedes the overwrite branch, so it applies under BOTH
      // strategies — not only overwrite.
      const existingGroup = {
        id: "g-1",
        positionX: 10,
        positionY: 20,
        metadata: { gameType: "official", layout: "grid" },
        update: vi.fn().mockResolvedValue(),
        toJSON: () => ({ id: "g-1" }),
      };
      const metadata = await importSeries({
        competitive: false,
        existingGroup,
        dedupeStrategy,
      });
      expect(metadata).toMatchObject({ gameType: "official", layout: "grid" });
    },
  );
});

describe("clear protocol: null deletes the key (D3)", () => {
  const putGroup = async (type, groupMetadata, body) => {
    const group = {
      id: "g-1",
      canvas_id: "c-1",
      type,
      versus_draft_id: null,
      metadata: groupMetadata,
      update: vi.fn().mockResolvedValue(),
      toJSON: () => ({ id: "g-1" }),
    };
    const hydrated = { toJSON: () => ({ id: "g-1" }) };
    vi.spyOn(CanvasGroup, "findOne").mockImplementation(async (options) =>
      options?.include ? hydrated : group,
    );
    const res = await request(buildCanvasApp())
      .put("/api/canvas/c-1/group/g-1")
      .send(body);
    expect(res.status).toBe(200);
    return group.update.mock.calls.at(-1)[0].metadata;
  };

  it("removes the key entirely rather than storing JSON null", async () => {
    const metadata = await putGroup(
      "custom",
      { gameType: "scrim", layout: "grid" },
      { metadata: { gameType: null } },
    );
    // hasOwnProperty, not === undefined: Zod's .catch(undefined) leaves a
    // present-but-undefined key, so only key presence distinguishes the states.
    expect(Object.prototype.hasOwnProperty.call(metadata, "gameType")).toBe(
      false,
    );
    expect(metadata).toMatchObject({ layout: "grid" });
  });

  it("also clears through the draft-positions merge point", async () => {
    const group = {
      id: "g-1",
      metadata: { gameType: "scrim", layout: "grid" },
      update: vi.fn().mockResolvedValue(),
      toJSON: () => ({ id: "g-1" }),
    };
    vi.spyOn(CanvasGroup, "findOne").mockResolvedValue(group);
    vi.spyOn(CanvasDraft, "update").mockResolvedValue([1]);
    await request(buildCanvasApp())
      .put("/api/canvas/c-1/draft-positions")
      .send({
        positions: [{ draft_id: "d-1", positionX: 0, positionY: 0 }],
        group: { id: "g-1", metadata: { gameType: null } },
      })
      .expect(200);

    const metadata = group.update.mock.calls.at(-1)[0].metadata;
    expect(Object.prototype.hasOwnProperty.call(metadata, "gameType")).toBe(
      false,
    );
    expect(metadata).toMatchObject({ layout: "grid" });
  });
});
