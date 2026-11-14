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
  CanvasPoolPlacement,
} = require("../../models/Canvas.js");
const Draft = require("../../models/Draft.js");
const VersusDraft = require("../../models/VersusDraft.js");
const Team = require("../../models/Team");
const sequelize = require("../../config/database");
const setupAssociations = require("../../models/associations");
const canvasMutations = require("../../services/canvasMutations");

/**
 * S3 Task 6 (plan D9, D10, Answer Q3 A): an imported series — its VersusDraft
 * has a `league_series_id` — is read-only where esclub is the source: the
 * group's teams, team names, length and draft type, and each game's sides,
 * first pick, winner and per-card team names. Everything lifts once a purge
 * sets `league_series_id` to NULL.
 */

function buildApp() {
  const routePath = require.resolve("../../routes/canvas");
  delete require.cache[routePath];
  const app = express();
  app.use(express.json());
  app.use("/api/canvas", require("../../routes/canvas"));
  return app;
}

const T1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const T2 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const T_OTHER = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const SERIES_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

const TEAMS_REFUSAL = "Teams of an imported series are set by esclub";

let group;
let versusDraft;
let transaction;

beforeEach(() => {
  vi.restoreAllMocks();
  transaction = {
    commit: vi.fn().mockResolvedValue(),
    rollback: vi.fn().mockResolvedValue(),
    finished: false,
  };
  group = {
    id: "g-1",
    canvas_id: "c-1",
    name: "Alpha vs Beta",
    type: "series",
    positionX: 0,
    positionY: 0,
    width: null,
    height: null,
    versus_draft_id: "vd-1",
    team1_id: T1,
    team2_id: T2,
    metadata: {
      blueTeamName: "Alpha",
      redTeamName: "Beta",
      length: 3,
      competitive: true,
      seriesType: "fearless",
      draftMode: "fearless",
      origin: "manual",
      disabledChampions: [],
      gameType: "official",
    },
    update: vi.fn(async function (values) {
      Object.assign(this, values);
    }),
    toJSON() {
      return { ...this };
    },
  };
  versusDraft = {
    id: "vd-1",
    origin: "manual",
    name: "Alpha vs Beta",
    blueTeamName: "Alpha",
    redTeamName: "Beta",
    length: 3,
    type: "fearless",
    competitive: true,
    disabledChampions: [],
    league_series_id: SERIES_ID,
    update: vi.fn(async function (values) {
      Object.assign(this, values);
    }),
    toJSON() {
      return { ...this };
    },
  };

  vi.spyOn(auth, "protect").mockImplementation((req, _res, next) => {
    req.user = { id: "u-editor" };
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
  vi.spyOn(CanvasGroup, "findOne").mockResolvedValue(group);
  vi.spyOn(CanvasGroup, "findAll").mockResolvedValue([]);
  vi.spyOn(CanvasGroup, "create").mockResolvedValue({
    id: "g-new",
    toJSON: () => ({ id: "g-new" }),
  });
  vi.spyOn(CanvasDraft, "findAll").mockResolvedValue([]);
  vi.spyOn(CanvasDraft, "create").mockResolvedValue({ toJSON: () => ({}) });
  vi.spyOn(CanvasDraft, "destroy").mockResolvedValue(0);
  vi.spyOn(CanvasConnection, "findAll").mockResolvedValue([]);
  vi.spyOn(CanvasAnnotation, "findAll").mockResolvedValue([]);
  vi.spyOn(CanvasPoolPlacement, "findAll").mockResolvedValue([]);
  vi.spyOn(VersusDraft, "findByPk").mockResolvedValue(versusDraft);
  vi.spyOn(Team, "findAll").mockResolvedValue([]);
  vi.spyOn(Draft, "findAll").mockResolvedValue(
    [0, 1, 2].map((i) => ({ id: `d-${i}`, seriesIndex: i, picks: [] })),
  );
  vi.spyOn(Draft, "create").mockImplementation(async (values) => ({
    id: `d-${values.seriesIndex}`,
    ...values,
  }));
  vi.spyOn(Draft, "destroy").mockResolvedValue(0);
});

const putGroup = (body) =>
  request(buildApp()).put("/api/canvas/c-1/group/g-1").send(body);

// What the settings dialog sends for a manual series (Canvas.tsx): the stored
// names, length, type and team ids come back unchanged next to the edit.
const dialogSave = (overrides = {}) => ({
  name: "Alpha vs Beta",
  metadata: {
    disabledChampions: [],
    gameType: "official",
    draftMode: "fearless",
    blueTeamName: "Alpha",
    redTeamName: "Beta",
    length: 3,
    seriesType: "fearless",
    ...overrides.metadata,
  },
  team1_id: T1,
  team2_id: T2,
  ...overrides.body,
});

const expectRefusedBeforeAnyWrite = () => {
  expect(transaction.rollback).toHaveBeenCalled();
  expect(transaction.commit).not.toHaveBeenCalled();
  expect(group.update).not.toHaveBeenCalled();
  expect(versusDraft.update).not.toHaveBeenCalled();
  expect(Draft.create).not.toHaveBeenCalled();
  expect(Draft.destroy).not.toHaveBeenCalled();
  expect(CanvasDraft.create).not.toHaveBeenCalled();
  expect(CanvasDraft.destroy).not.toHaveBeenCalled();
  expect(socketService.emitToRoom).not.toHaveBeenCalled();
};

describe("PUT group on an imported series: refusals", () => {
  it.each([
    ["team1_id to another team", { team1_id: T_OTHER }],
    ["team1_id to null", { team1_id: null }],
    ["team2_id to another team", { team2_id: T_OTHER }],
    ["team2_id to null", { team2_id: null }],
    ["the two slots swapped", { team1_id: T2, team2_id: T1 }],
  ])("refuses %s", async (_label, body) => {
    const res = await putGroup(dialogSave({ body }));

    expect(res.status).toBe(400);
    expect(res.body.error).toBe(TEAMS_REFUSAL);
    expectRefusedBeforeAnyWrite();
    // Refused before the link lookup, so no Team query either.
    expect(Team.findAll).not.toHaveBeenCalled();
  });

  it("refuses a team id change sent alone", async () => {
    const res = await putGroup({ team2_id: T_OTHER });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe(TEAMS_REFUSAL);
    expectRefusedBeforeAnyWrite();
  });

  it.each([
    ["blueTeamName", { blueTeamName: "Renamed" }],
    ["redTeamName", { redTeamName: "Renamed" }],
  ])("refuses a different %s", async (_label, metadata) => {
    const res = await putGroup(dialogSave({ metadata }));

    expect(res.status).toBe(400);
    expect(res.body.error).toBe(TEAMS_REFUSAL);
    expectRefusedBeforeAnyWrite();
  });

  it("refuses a length change and creates no game", async () => {
    const res = await putGroup(dialogSave({ metadata: { length: 5 } }));

    expect(res.status).toBe(400);
    expect(res.body.error).toBe(
      "The length of an imported series is set by esclub",
    );
    expectRefusedBeforeAnyWrite();
  });

  it("refuses a length change sent alone", async () => {
    const res = await putGroup({ metadata: { length: 1 } });

    expect(res.status).toBe(400);
    expectRefusedBeforeAnyWrite();
  });

  it.each([
    ["seriesType", { seriesType: "standard" }],
    ["draftMode", { draftMode: "standard" }],
    ["both", { seriesType: "ironman", draftMode: "ironman" }],
  ])("refuses a draft type change through %s", async (_label, metadata) => {
    const res = await putGroup(dialogSave({ metadata }));

    expect(res.status).toBe(400);
    expect(res.body.error).toBe(
      "The draft type of an imported series is set by esclub",
    );
    expectRefusedBeforeAnyWrite();
  });
});

describe("PUT group on an imported series: what stays editable", () => {
  it("saves the dialog's unchanged teams, names, length and type with a gameType change", async () => {
    const res = await putGroup(
      dialogSave({ metadata: { gameType: "scrim", disabledChampions: ["Ahri"] } }),
    );

    expect(res.body.error).toBeUndefined();
    expect(res.status).toBe(200);
    expect(transaction.commit).toHaveBeenCalled();
    const patch = group.update.mock.calls.at(-1)[0];
    expect(patch.metadata).toMatchObject({
      gameType: "scrim",
      blueTeamName: "Alpha",
      redTeamName: "Beta",
      length: 3,
      seriesType: "fearless",
      disabledChampions: ["Ahri"],
    });
    expect(patch.team1_id).toBe(T1);
    expect(patch.team2_id).toBe(T2);
    expect(versusDraft.update).toHaveBeenCalledWith(
      expect.objectContaining({ disabledChampions: ["Ahri"] }),
      expect.anything(),
    );
    expect(Draft.create).not.toHaveBeenCalled();
    // The VersusDraft is read once, not again by the manual-series branch.
    expect(VersusDraft.findByPk).toHaveBeenCalledTimes(1);
  });

  it("saves a rename", async () => {
    const res = await putGroup(dialogSave({ body: { name: "Week 3" } }));

    expect(res.status).toBe(200);
    expect(group.update.mock.calls.at(-1)[0].name).toBe("Week 3");
    expect(versusDraft.update).toHaveBeenCalledWith(
      expect.objectContaining({ name: "Week 3" }),
      expect.anything(),
    );
  });

  it("saves a rename sent alone", async () => {
    const res = await putGroup({ name: "Week 3" });

    expect(res.status).toBe(200);
    expect(VersusDraft.findByPk).toHaveBeenCalledTimes(1);
  });

  it("accepts a name the stored metadata leaves to the VersusDraft", async () => {
    delete group.metadata.blueTeamName;

    const res = await putGroup(dialogSave());

    expect(res.status).toBe(200);
  });

  it("accepts the length as a numeric string equal to the stored one", async () => {
    const res = await putGroup(dialogSave({ metadata: { length: "3" } }));

    expect(res.status).toBe(200);
    expect(Draft.create).not.toHaveBeenCalled();
  });

  it("moves and resizes without loading the VersusDraft", async () => {
    const res = await putGroup({ positionX: 40, width: 640, height: 400 });

    expect(res.status).toBe(200);
    expect(VersusDraft.findByPk).not.toHaveBeenCalled();
  });
});

describe("PUT group after a purge (league_series_id NULL)", () => {
  beforeEach(() => {
    versusDraft.league_series_id = null;
    group.team1_id = null;
    group.team2_id = null;
  });

  it("links teams again", async () => {
    Team.findAll.mockResolvedValue([
      { id: T_OTHER, source: "esclub", owner_id: null },
    ]);

    const res = await putGroup({ team1_id: T_OTHER, team2_id: null });

    expect(res.status).toBe(200);
    expect(group.update.mock.calls.at(-1)[0].team1_id).toBe(T_OTHER);
  });

  it("renames the teams, changes the type and grows the length", async () => {
    const res = await putGroup(
      dialogSave({
        metadata: {
          blueTeamName: "Gamma",
          redTeamName: "Delta",
          length: 5,
          seriesType: "standard",
          draftMode: "standard",
        },
        body: { team1_id: null, team2_id: null },
      }),
    );

    expect(res.body.error).toBeUndefined();
    expect(res.status).toBe(200);
    expect(versusDraft.update).toHaveBeenCalledWith(
      expect.objectContaining({
        blueTeamName: "Gamma",
        redTeamName: "Delta",
        type: "standard",
        length: 5,
      }),
      expect.anything(),
    );
    expect(Draft.create).toHaveBeenCalled();
  });
});

describe("POST import/series of an imported series (plan D10)", () => {
  const importSeries = () =>
    request(buildApp())
      .post("/api/canvas/c-1/import/series")
      .send({ versusDraftId: "vd-1", positionX: 10, positionY: 20 });

  it("refuses a VersusDraft that has a league_series_id", async () => {
    versusDraft.Drafts = [];

    const res = await importSeries();

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/imported from esclub/);
    expect(CanvasGroup.create).not.toHaveBeenCalled();
    expect(CanvasDraft.create).not.toHaveBeenCalled();
    expect(transaction.rollback).toHaveBeenCalled();
    expect(transaction.commit).not.toHaveBeenCalled();
  });

  it("imports it again once the purge cleared league_series_id", async () => {
    versusDraft.league_series_id = null;
    versusDraft.Drafts = [];

    const res = await importSeries();

    expect(res.status).toBe(201);
    expect(CanvasGroup.create).toHaveBeenCalled();
  });
});

describe("PUT draft on an imported game (Answer Q3 A)", () => {
  let canvasDraftRow;

  beforeEach(() => {
    canvasDraftRow = { update: vi.fn().mockResolvedValue(undefined) };
    vi.spyOn(CanvasDraft, "findOne").mockResolvedValue(canvasDraftRow);
    vi.spyOn(Draft, "update").mockResolvedValue([1]);
    // The draft's series is imported: the lookup finds it.
    vi.spyOn(Draft, "findOne").mockResolvedValue({ id: "d-1" });
  });

  const putDraft = (body) =>
    request(buildApp()).put("/api/canvas/c-1/draft/d-1").send(body);

  it.each([
    ["winner", { winner: "blue" }],
    ["winner cleared", { winner: null }],
    ["blueSideTeam", { blueSideTeam: 2 }],
    ["firstPick", { firstPick: "red" }],
    ["team1Name", { team1Name: "Other" }],
    ["team2Name", { team2Name: "" }],
    ["winner with a position", { winner: "red", positionX: 10 }],
  ])("refuses %s", async (_label, body) => {
    const res = await putDraft(body);

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Set by esclub");
    expect(Draft.update).not.toHaveBeenCalled();
    expect(canvasDraftRow.update).not.toHaveBeenCalled();
    expect(socketService.emitToRoom).not.toHaveBeenCalled();
  });

  it("looks the series up by the draft id, once", async () => {
    await putDraft({ winner: "blue" });

    expect(Draft.findOne).toHaveBeenCalledTimes(1);
    expect(Draft.findOne.mock.calls[0][0].where).toEqual({ id: "d-1" });
  });

  it("still moves the card, with no extra query", async () => {
    const res = await putDraft({ positionX: 10, positionY: 20 });

    expect(res.status).toBe(200);
    expect(canvasDraftRow.update).toHaveBeenCalledWith({
      positionX: 10,
      positionY: 20,
    });
    expect(Draft.findOne).not.toHaveBeenCalled();
  });

  it("still ungroups the card, with no extra query", async () => {
    const res = await putDraft({ group_id: null });

    expect(res.status).toBe(200);
    expect(canvasDraftRow.update).toHaveBeenCalledWith({ group_id: null });
    expect(Draft.findOne).not.toHaveBeenCalled();
  });

  it("answers 404 for a card not on this canvas before looking up the series", async () => {
    CanvasDraft.findOne.mockResolvedValue(null);

    const res = await putDraft({ winner: "blue" });

    expect(res.status).toBe(404);
    expect(Draft.findOne).not.toHaveBeenCalled();
  });

  it("sets sides, first pick, winner and names once the game is not imported", async () => {
    Draft.findOne.mockResolvedValue(null);

    const res = await putDraft({
      winner: "blue",
      blueSideTeam: 2,
      firstPick: "red",
      team1Name: "Alpha",
    });

    expect(res.status).toBe(200);
    expect(Draft.update).toHaveBeenCalledWith(
      expect.objectContaining({ winner: "blue", blueSideTeam: 2, firstPick: "red" }),
      { where: { id: "d-1" } },
    );
    expect(canvasDraftRow.update).toHaveBeenCalledWith(
      expect.objectContaining({ team1Name: "Alpha" }),
    );
  });
});

describe("generated SQL of the imported-draft lookup", () => {
  it("is one query joining the draft's VersusDraft with league_series_id set", async () => {
    setupAssociations();
    const query = vi.spyOn(sequelize, "query").mockResolvedValue(null);
    const { isDraftImported } = require("../../routes/canvas");

    // findOne goes through findAll, which the outer beforeEach stubs.
    Draft.findAll.mockRestore();

    const imported = await isDraftImported("d-1");

    expect(imported).toBe(false);

    expect(query).toHaveBeenCalledTimes(1);
    const sql = query.mock.calls[0][0];
    expect(typeof sql).toBe("string");
    expect(sql).toMatch(/^SELECT "Draft"\."id".* FROM "Drafts" AS "Draft"/s);
    expect(sql).toMatch(/INNER JOIN "VersusDrafts" AS "VersusDraft" ON "Draft"\."versus_draft_id" = "VersusDraft"\."id"/);
    expect(sql).toMatch(/"VersusDraft"\."league_series_id" IS NOT NULL/);
    expect(sql).toMatch(/WHERE "Draft"\."id" = 'd-1'/);
    expect(sql).not.toMatch(/FROM \(SELECT/);
    // A where on the primary key: Sequelize leaves the LIMIT out.
    expect(sql).toBe(
      'SELECT "Draft"."id" FROM "Drafts" AS "Draft" INNER JOIN "VersusDrafts" AS "VersusDraft" ON "Draft"."versus_draft_id" = "VersusDraft"."id" AND "VersusDraft"."league_series_id" IS NOT NULL WHERE "Draft"."id" = \'d-1\';',
    );
  });
});
