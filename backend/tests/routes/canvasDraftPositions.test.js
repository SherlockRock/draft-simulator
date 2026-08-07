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
  CanvasGroup,
  CanvasConnection,
} = require("../../models/Canvas");
const Draft = require("../../models/Draft.js");

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

function mockTransaction() {
  const t = { commit: vi.fn(), rollback: vi.fn(), finished: false };
  t.commit.mockImplementation(async () => {
    t.finished = "commit";
  });
  t.rollback.mockImplementation(async () => {
    t.finished = "rollback";
  });
  vi.spyOn(Canvas.sequelize, "transaction").mockResolvedValue(t);
  return t;
}

const BODY = {
  positions: [
    { draft_id: "d1", positionX: 16, positionY: 64 },
    { draft_id: "d2", positionX: 740, positionY: 64 },
  ],
};

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(auth, "protect").mockImplementation((req, _res, next) => {
    req.user = { id: "u1" };
    next();
  });
  vi.spyOn(socketService, "emitToRoom").mockImplementation(() => {});
  vi.spyOn(Canvas, "findByPk").mockResolvedValue({
    changed: vi.fn(),
    save: vi.fn().mockResolvedValue(undefined),
  });
});

describe("PUT /:canvasId/draft-positions", () => {
  it("returns 403 for view-only permission and opens no transaction", async () => {
    vi.spyOn(UserCanvas, "findOne").mockResolvedValue({ permissions: "view" });
    const transaction = vi.spyOn(Canvas.sequelize, "transaction");

    const res = await request(buildApp())
      .put("/api/canvas/c1/draft-positions")
      .send(BODY);

    expect(res.status).toBe(403);
    expect(transaction).not.toHaveBeenCalled();
  });

  it("rejects malformed positions with 400", async () => {
    vi.spyOn(UserCanvas, "findOne").mockResolvedValue({ permissions: "edit" });

    const res = await request(buildApp())
      .put("/api/canvas/c1/draft-positions")
      .send({ positions: [{ draft_id: "d1", positionX: "nope" }] });

    expect(res.status).toBe(400);
  });

  // An empty group has no cards to quantize, so "Arrange as grid" sends
  // positions: [] with a real group. The old non-empty guard 400d it, and the
  // optimistic store write made it look like it worked until a reload.
  it("accepts empty positions when the group carries the work", async () => {
    vi.spyOn(UserCanvas, "findOne").mockResolvedValue({ permissions: "edit" });
    mockTransaction();
    const update = vi.spyOn(CanvasDraft, "update").mockResolvedValue([1]);
    const groupRow = {
      id: "g1",
      metadata: { layout: "free" },
      update: vi.fn().mockResolvedValue(undefined),
      toJSON: () => ({ id: "g1", metadata: { layout: "grid" } }),
    };
    vi.spyOn(CanvasGroup, "findOne").mockResolvedValue(groupRow);

    const res = await request(buildApp())
      .put("/api/canvas/c1/draft-positions")
      .send({
        positions: [],
        group: {
          id: "g1",
          width: 1200,
          height: 800,
          metadata: { layout: "grid", gridCols: 3 },
        },
      });

    expect(res.status).toBe(200);
    expect(update).not.toHaveBeenCalled();
    expect(groupRow.update).toHaveBeenCalled();
    expect(socketService.emitToRoom).toHaveBeenCalledWith(
      "c1",
      "draftPositionsUpdated",
      expect.objectContaining({
        positions: [],
        group: { id: "g1", metadata: { layout: "grid" } },
      })
    );
  });

  // Relaxing the boolean guard alone would let an omitted array reach the
  // `for (const p of positions)` loop and 500 instead of 400.
  it("400s rather than 500s when positions is omitted and no group is sent", async () => {
    vi.spyOn(UserCanvas, "findOne").mockResolvedValue({ permissions: "edit" });
    const transaction = vi.spyOn(Canvas.sequelize, "transaction");

    const res = await request(buildApp())
      .put("/api/canvas/c1/draft-positions")
      .send({});

    expect(res.status).toBe(400);
    expect(transaction).not.toHaveBeenCalled();
  });

  it("400s when positions is empty and the group carries no updatable props", async () => {
    vi.spyOn(UserCanvas, "findOne").mockResolvedValue({ permissions: "edit" });
    const transaction = vi.spyOn(Canvas.sequelize, "transaction");

    const res = await request(buildApp())
      .put("/api/canvas/c1/draft-positions")
      .send({ positions: [], group: { id: "g1" } });

    expect(res.status).toBe(400);
    expect(transaction).not.toHaveBeenCalled();
  });

  it("400s when positions is not an array", async () => {
    vi.spyOn(UserCanvas, "findOne").mockResolvedValue({ permissions: "edit" });

    const res = await request(buildApp())
      .put("/api/canvas/c1/draft-positions")
      .send({ positions: "nope", group: { id: "g1", width: 100 } });

    expect(res.status).toBe(400);
  });

  it("updates every draft in one transaction and emits draftPositionsUpdated", async () => {
    vi.spyOn(UserCanvas, "findOne").mockResolvedValue({ permissions: "edit" });
    const t = mockTransaction();
    const update = vi.spyOn(CanvasDraft, "update").mockResolvedValue([1]);

    const res = await request(buildApp())
      .put("/api/canvas/c1/draft-positions")
      .send(BODY);

    expect(res.status).toBe(200);
    expect(update).toHaveBeenCalledTimes(2);
    expect(update).toHaveBeenCalledWith(
      { positionX: 16, positionY: 64 },
      expect.objectContaining({
        where: { canvas_id: "c1", draft_id: "d1" },
        transaction: t,
      })
    );
    expect(t.commit).toHaveBeenCalled();
    expect(socketService.emitToRoom).toHaveBeenCalledWith(
      "c1",
      "draftPositionsUpdated",
      expect.objectContaining({ positions: BODY.positions, group: null })
    );
  });

  // The container lookup is new: a Card's group_id is now checked against this
  // canvas's Groups, so this test has to say the group exists.
  it("includes group_id in the draft update when provided", async () => {
    vi.spyOn(UserCanvas, "findOne").mockResolvedValue({ permissions: "edit" });
    mockTransaction();
    vi.spyOn(CanvasGroup, "findAll").mockResolvedValue([{ id: "g1" }]);
    const update = vi.spyOn(CanvasDraft, "update").mockResolvedValue([1]);

    await request(buildApp())
      .put("/api/canvas/c1/draft-positions")
      .send({
        positions: [
          { draft_id: "d1", positionX: 16, positionY: 64, group_id: "g1" },
        ],
      });

    expect(update).toHaveBeenCalledWith(
      { positionX: 16, positionY: 64, group_id: "g1" },
      expect.objectContaining({ where: { canvas_id: "c1", draft_id: "d1" } })
    );
  });

  it("rolls back and 404s when a draft is not on the canvas", async () => {
    vi.spyOn(UserCanvas, "findOne").mockResolvedValue({ permissions: "edit" });
    const t = mockTransaction();
    vi.spyOn(CanvasDraft, "update").mockResolvedValue([0]);

    const res = await request(buildApp())
      .put("/api/canvas/c1/draft-positions")
      .send(BODY);

    expect(res.status).toBe(404);
    expect(t.rollback).toHaveBeenCalled();
    expect(socketService.emitToRoom).not.toHaveBeenCalled();
  });

  it("merges group metadata and broadcasts the updated group", async () => {
    vi.spyOn(UserCanvas, "findOne").mockResolvedValue({ permissions: "edit" });
    mockTransaction();
    vi.spyOn(CanvasDraft, "update").mockResolvedValue([1]);
    const groupRow = {
      id: "g1",
      metadata: { layout: "free", disabledChampions: ["Ahri"] },
      update: vi.fn().mockResolvedValue(undefined),
      toJSON: () => ({ id: "g1", metadata: { layout: "grid" } }),
    };
    vi.spyOn(CanvasGroup, "findOne").mockResolvedValue(groupRow);

    const res = await request(buildApp())
      .put("/api/canvas/c1/draft-positions")
      .send({
        ...BODY,
        group: {
          id: "g1",
          width: 2200,
          height: 1800,
          metadata: { layout: "grid", gridCols: 3 },
        },
      });

    expect(res.status).toBe(200);
    expect(groupRow.update).toHaveBeenCalledWith(
      {
        width: 2200,
        height: 1800,
        metadata: {
          layout: "grid",
          gridCols: 3,
          disabledChampions: ["Ahri"],
        },
      },
      expect.anything()
    );
    expect(socketService.emitToRoom).toHaveBeenCalledWith(
      "c1",
      "draftPositionsUpdated",
      expect.objectContaining({ group: { id: "g1", metadata: { layout: "grid" } } })
    );
  });
});

// A canvas's Groups as the locked findAll returns them: real instances need
// only the fields the walker and the fan-out read, plus an update spy.
const groupRow = (id, opts = {}) => ({
  id,
  type: opts.type ?? "custom",
  parent_group_id: opts.parent ?? null,
  positionX: opts.x ?? 0,
  positionY: opts.y ?? 0,
  metadata: opts.metadata ?? {},
  update: vi.fn().mockResolvedValue(undefined),
  toJSON: () => ({ id }),
});

const mockCanvasGroups = (rows) => {
  vi.spyOn(CanvasGroup, "findAll").mockResolvedValue(rows);
  return new Map(rows.map((row) => [row.id, row]));
};

const putGroups = (body) =>
  request(buildApp()).put("/api/canvas/c1/draft-positions").send(body);

describe("PUT /:canvasId/draft-positions — groups[]", () => {
  beforeEach(() => {
    vi.spyOn(UserCanvas, "findOne").mockResolvedValue({ permissions: "edit" });
  });

  it("400s when groups is not an array", async () => {
    const transaction = vi.spyOn(Canvas.sequelize, "transaction");

    const res = await putGroups({ groups: "nope" });

    expect(res.status).toBe(400);
    expect(transaction).not.toHaveBeenCalled();
  });

  it("400s on a malformed group entry", async () => {
    const res = await putGroups({ groups: [{ id: "g1", positionX: 10 }] });

    expect(res.status).toBe(400);
  });

  it("400s on a non-string, non-null parentId", async () => {
    const res = await putGroups({
      groups: [{ id: "g1", positionX: 10, positionY: 10, parentId: 7 }],
    });

    expect(res.status).toBe(400);
  });

  // Two entries for one id have no defined resolution order, and the fan-out
  // would take its delta from whichever happened to be written last.
  it("400s when the same group id appears twice", async () => {
    const res = await putGroups({
      groups: [
        { id: "g1", positionX: 10, positionY: 10 },
        { id: "g1", positionX: 20, positionY: 20 },
      ],
    });

    expect(res.status).toBe(400);
  });

  // The whole point of the relaxed guard: a container move writes no Cards.
  it("accepts a groups-only commit", async () => {
    mockTransaction();
    const rows = mockCanvasGroups([groupRow("g1", { x: 100, y: 100 })]);
    const update = vi.spyOn(CanvasDraft, "update").mockResolvedValue([1]);

    const res = await putGroups({
      groups: [{ id: "g1", positionX: 300, positionY: 250 }],
    });

    expect(res.status).toBe(200);
    expect(update).not.toHaveBeenCalled();
    expect(rows.get("g1").update).toHaveBeenCalledWith(
      { positionX: 300, positionY: 250 },
      expect.anything()
    );
  });

  it("suppresses draftPositionsUpdated on a groups-only commit", async () => {
    mockTransaction();
    mockCanvasGroups([groupRow("g1")]);

    await putGroups({ groups: [{ id: "g1", positionX: 5, positionY: 5 }] });

    const events = socketService.emitToRoom.mock.calls.map((c) => c[1]);
    expect(events).toContain("groupMoved");
    expect(events).not.toContain("draftPositionsUpdated");
  });

  it("locks the canvas's groups in id order before writing", async () => {
    mockTransaction();
    mockCanvasGroups([groupRow("g1")]);

    await putGroups({ groups: [{ id: "g1", positionX: 5, positionY: 5 }] });

    expect(CanvasGroup.findAll).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { canvas_id: "c1" },
        order: [["id", "ASC"]],
        lock: true,
      })
    );
  });

  // Card-only commits are the hot path (every grid drag) and must not start
  // taking a canvas-wide Group lock.
  it("takes no group lock when only cards move", async () => {
    mockTransaction();
    const findAll = vi.spyOn(CanvasGroup, "findAll").mockResolvedValue([]);
    vi.spyOn(CanvasDraft, "update").mockResolvedValue([1]);

    await putGroups(BODY);

    expect(findAll).not.toHaveBeenCalled();
  });

  it("404s when a group in groups[] is not on the canvas", async () => {
    const t = mockTransaction();
    mockCanvasGroups([groupRow("g1")]);

    const res = await putGroups({
      groups: [{ id: "ghost", positionX: 0, positionY: 0 }],
    });

    expect(res.status).toBe(404);
    expect(t.rollback).toHaveBeenCalled();
    expect(socketService.emitToRoom).not.toHaveBeenCalled();
  });

  // The delta is DERIVED from the locked row, never sent — that is what makes a
  // container move idempotent and what stops two concurrent drags summing.
  it("derives the delta and applies it to every descendant group", async () => {
    mockTransaction();
    const rows = mockCanvasGroups([
      groupRow("g-root", { x: 100, y: 100 }),
      groupRow("g-child", { parent: "g-root", x: 150, y: 180 }),
      groupRow("g-grandchild", { parent: "g-child", x: 160, y: 200 }),
      groupRow("g-other", { x: 900, y: 900 }),
    ]);

    const res = await putGroups({
      groups: [{ id: "g-root", positionX: 130, positionY: 90 }],
    });

    expect(res.status).toBe(200);
    // dx = +30, dy = -10 against the STORED 100,100.
    expect(rows.get("g-child").update).toHaveBeenCalledWith(
      { positionX: 180, positionY: 170 },
      expect.anything()
    );
    expect(rows.get("g-grandchild").update).toHaveBeenCalledWith(
      { positionX: 190, positionY: 190 },
      expect.anything()
    );
    expect(rows.get("g-other").update).not.toHaveBeenCalled();
  });

  it("writes nothing to descendants when the container did not move", async () => {
    mockTransaction();
    const rows = mockCanvasGroups([
      groupRow("g-root", { x: 100, y: 100 }),
      groupRow("g-child", { parent: "g-root", x: 150, y: 180 }),
    ]);

    await putGroups({
      groups: [{ id: "g-root", positionX: 100, positionY: 100 }],
    });

    expect(rows.get("g-child").update).not.toHaveBeenCalled();
  });

  // A parent and one of its descendants in the same commit: the descendant's
  // own absolute entry wins, and its subtree rides on that entry's delta, not
  // the parent's. Without pruning, g-grandchild would take both deltas.
  it("prunes an explicitly-moved descendant and its subtree from the fan-out", async () => {
    mockTransaction();
    const rows = mockCanvasGroups([
      groupRow("g-root", { x: 0, y: 0 }),
      groupRow("g-child", { parent: "g-root", x: 10, y: 10 }),
      groupRow("g-grandchild", { parent: "g-child", x: 20, y: 20 }),
    ]);

    await putGroups({
      groups: [
        { id: "g-root", positionX: 100, positionY: 0 },
        { id: "g-child", positionX: 500, positionY: 10 },
      ],
    });

    expect(rows.get("g-child").update).toHaveBeenCalledWith(
      { positionX: 500, positionY: 10 },
      expect.anything()
    );
    // +490 from g-child alone — not +590 with g-root's +100 double-applied.
    expect(rows.get("g-grandchild").update).toHaveBeenCalledWith(
      { positionX: 510, positionY: 20 },
      expect.anything()
    );
  });

  it("emits groupMoved for the container and every descendant it wrote", async () => {
    mockTransaction();
    mockCanvasGroups([
      groupRow("g-root", { x: 0, y: 0 }),
      groupRow("g-child", { parent: "g-root", x: 10, y: 10 }),
    ]);

    await putGroups({
      groups: [{ id: "g-root", positionX: 40, positionY: 0 }],
    });

    expect(socketService.emitToRoom).toHaveBeenCalledWith("c1", "groupMoved", {
      groupId: "g-root",
      positionX: 40,
      positionY: 0,
    });
    expect(socketService.emitToRoom).toHaveBeenCalledWith("c1", "groupMoved", {
      groupId: "g-child",
      positionX: 50,
      positionY: 10,
    });
  });

  // Cards render at container + relative offset, so a client applying the Card
  // message first can paint them at the OLD container position.
  it("emits every groupMoved before draftPositionsUpdated", async () => {
    mockTransaction();
    mockCanvasGroups([groupRow("g1", { x: 0, y: 0 })]);
    vi.spyOn(CanvasDraft, "update").mockResolvedValue([1]);

    await putGroups({
      ...BODY,
      groups: [{ id: "g1", positionX: 10, positionY: 10 }],
    });

    const events = socketService.emitToRoom.mock.calls.map((c) => c[1]);
    expect(events.indexOf("groupMoved")).toBeLessThan(
      events.indexOf("draftPositionsUpdated")
    );
  });

  describe("§8.1 validation", () => {
    it("rejects a parent that is not on this canvas", async () => {
      const t = mockTransaction();
      mockCanvasGroups([groupRow("g1")]);

      const res = await putGroups({
        groups: [
          { id: "g1", positionX: 0, positionY: 0, parentId: "elsewhere" },
        ],
      });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe("That group isn't on this canvas");
      expect(t.rollback).toHaveBeenCalled();
    });

    it("rejects nesting a group under a series", async () => {
      mockCanvasGroups([groupRow("g1"), groupRow("s1", { type: "series" })]);
      mockTransaction();

      const res = await putGroups({
        groups: [{ id: "g1", positionX: 0, positionY: 0, parentId: "s1" }],
      });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe("Can't put a group inside a series");
    });

    it("rejects a self-nest", async () => {
      mockTransaction();
      mockCanvasGroups([groupRow("g1")]);

      const res = await putGroups({
        groups: [{ id: "g1", positionX: 0, positionY: 0, parentId: "g1" }],
      });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe("Can't put a group inside itself");
    });

    it("rejects dropping a container into its own descendant", async () => {
      mockTransaction();
      mockCanvasGroups([
        groupRow("g-root"),
        groupRow("g-child", { parent: "g-root" }),
      ]);

      const res = await putGroups({
        groups: [
          { id: "g-root", positionX: 0, positionY: 0, parentId: "g-child" },
        ],
      });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe("Can't put a group inside itself");
    });

    // Each entry is legal against the STORED tree; together they are a cycle.
    // Validating against the tree the request would produce is what catches it.
    it("rejects a cycle formed by two entries in the same request", async () => {
      mockTransaction();
      mockCanvasGroups([groupRow("g-a"), groupRow("g-b")]);

      const res = await putGroups({
        groups: [
          { id: "g-a", positionX: 0, positionY: 0, parentId: "g-b" },
          { id: "g-b", positionX: 0, positionY: 0, parentId: "g-a" },
        ],
      });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe("Can't put a group inside itself");
    });

    it("accepts a reparent up to the depth cap", async () => {
      mockTransaction();
      const rows = mockCanvasGroups([
        groupRow("d0"),
        groupRow("d1", { parent: "d0" }),
        groupRow("d2", { parent: "d1" }),
        groupRow("d3", { parent: "d2" }),
        groupRow("loose"),
      ]);

      const res = await putGroups({
        groups: [{ id: "loose", positionX: 0, positionY: 0, parentId: "d3" }],
      });

      expect(res.status).toBe(200);
      expect(rows.get("loose").update).toHaveBeenCalledWith(
        { positionX: 0, positionY: 0, parent_group_id: "d3" },
        expect.anything()
      );
    });

    it("rejects a reparent one level past the depth cap", async () => {
      mockTransaction();
      mockCanvasGroups([
        groupRow("d0"),
        groupRow("d1", { parent: "d0" }),
        groupRow("d2", { parent: "d1" }),
        groupRow("d3", { parent: "d2" }),
        groupRow("d4", { parent: "d3" }),
        groupRow("loose"),
      ]);

      const res = await putGroups({
        groups: [{ id: "loose", positionX: 0, positionY: 0, parentId: "d4" }],
      });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe("Too deeply nested");
    });

    // The cap measures the deepest LEAF of the moved subtree, not the moved
    // node. Same destination, same moved node's depth (3) — only the subtree's
    // height differs, and that is what decides it.
    const chainToDepth2 = () => [
      groupRow("d0"),
      groupRow("d1", { parent: "d0" }),
      groupRow("d2", { parent: "d1" }),
    ];

    it("accepts a one-level subtree whose leaf lands exactly on the cap", async () => {
      mockTransaction();
      mockCanvasGroups([
        ...chainToDepth2(),
        groupRow("sub"),
        groupRow("sub-child", { parent: "sub" }),
      ]);

      const res = await putGroups({
        groups: [{ id: "sub", positionX: 0, positionY: 0, parentId: "d2" }],
      });

      expect(res.status).toBe(200);
    });

    it("rejects a two-level subtree moved to the same place", async () => {
      mockTransaction();
      mockCanvasGroups([
        ...chainToDepth2(),
        groupRow("sub"),
        groupRow("sub-child", { parent: "sub" }),
        groupRow("sub-grandchild", { parent: "sub-child" }),
      ]);

      const res = await putGroups({
        groups: [{ id: "sub", positionX: 0, positionY: 0, parentId: "d2" }],
      });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe("Too deeply nested");
    });

    it("moves a group to top level on an explicit null parentId", async () => {
      mockTransaction();
      const rows = mockCanvasGroups([
        groupRow("g-root"),
        groupRow("g-child", { parent: "g-root", x: 10, y: 10 }),
      ]);

      const res = await putGroups({
        groups: [
          { id: "g-child", positionX: 10, positionY: 10, parentId: null },
        ],
      });

      expect(res.status).toBe(200);
      expect(rows.get("g-child").update).toHaveBeenCalledWith(
        { positionX: 10, positionY: 10, parent_group_id: null },
        expect.anything()
      );
      expect(socketService.emitToRoom).toHaveBeenCalledWith("c1", "groupMoved", {
        groupId: "g-child",
        positionX: 10,
        positionY: 10,
        parentId: null,
      });
    });

    // Absent key vs null: an omitted parentId must leave parentage alone.
    it("leaves parentage untouched when parentId is omitted", async () => {
      mockTransaction();
      const rows = mockCanvasGroups([
        groupRow("g-root"),
        groupRow("g-child", { parent: "g-root", x: 10, y: 10 }),
      ]);

      await putGroups({
        groups: [{ id: "g-child", positionX: 60, positionY: 10 }],
      });

      expect(rows.get("g-child").update).toHaveBeenCalledWith(
        { positionX: 60, positionY: 10 },
        expect.anything()
      );
    });

    it("rejects a card dropped into a group that is not on this canvas", async () => {
      const t = mockTransaction();
      vi.spyOn(CanvasGroup, "findAll").mockResolvedValue([]);
      const update = vi.spyOn(CanvasDraft, "update").mockResolvedValue([1]);

      const res = await putGroups({
        positions: [
          { draft_id: "d1", positionX: 0, positionY: 0, group_id: "foreign" },
        ],
      });

      expect(res.status).toBe(404);
      expect(update).not.toHaveBeenCalled();
      expect(t.rollback).toHaveBeenCalled();
    });

    it("allows an explicit null group_id without a container lookup", async () => {
      mockTransaction();
      const findAll = vi.spyOn(CanvasGroup, "findAll").mockResolvedValue([]);
      vi.spyOn(CanvasDraft, "update").mockResolvedValue([1]);

      const res = await putGroups({
        positions: [
          { draft_id: "d1", positionX: 0, positionY: 0, group_id: null },
        ],
      });

      expect(res.status).toBe(200);
      expect(findAll).not.toHaveBeenCalled();
    });
  });
});

describe("POST /:canvasId/draft/:draftId/copy grid placement", () => {
  // The source row as the DB actually returns it: group_id is a real column, so
  // an ungrouped draft carries null, never a missing key. Getting that wrong is
  // what let the group-inheritance branch look tested when it was not.
  const mockCopyDeps = (original) => {
    vi.spyOn(UserCanvas, "findOne").mockResolvedValue({ permissions: "edit" });
    vi.spyOn(CanvasDraft, "findOne").mockResolvedValue({
      group_id: null,
      Draft: { name: "Orig", picks: Array(20).fill("") },
      ...original,
    });
    vi.spyOn(Draft, "create").mockResolvedValue({
      id: "new-draft",
      toJSON: () => ({ id: "new-draft" }),
    });
    // Broadcast fetches — return empty sets.
    vi.spyOn(CanvasDraft, "findAll").mockResolvedValue([]);
    vi.spyOn(CanvasConnection, "findAll").mockResolvedValue([]);
    vi.spyOn(CanvasGroup, "findAll").mockResolvedValue([]);
    // touchCanvasTimestamp + broadcast both call Canvas.findByPk.
    vi.spyOn(Canvas, "findByPk").mockResolvedValue({
      changed: vi.fn(),
      save: vi.fn().mockResolvedValue(undefined),
      toJSON: () => ({}),
    });
    return vi.spyOn(CanvasDraft, "create").mockResolvedValue({ toJSON: () => ({}) });
  };

  it("copy honors explicit position and group_id", async () => {
    const createCanvasDraft = mockCopyDeps({ positionX: 100, positionY: 100 });

    const res = await request(buildApp())
      .post("/api/canvas/c1/draft/d1/copy")
      .send({ positionX: 16, positionY: 64, group_id: "g1" });

    expect(res.status).toBe(201);
    expect(createCanvasDraft).toHaveBeenCalledWith(
      expect.objectContaining({
        positionX: 16,
        positionY: 64,
        group_id: "g1",
      })
    );
  });

  it("copy without a body falls back to offset placement", async () => {
    const createCanvasDraft = mockCopyDeps({ positionX: 100, positionY: 200 });

    const res = await request(buildApp())
      .post("/api/canvas/c1/draft/d1/copy")
      .send({});

    expect(res.status).toBe(201);
    expect(createCanvasDraft).toHaveBeenCalledWith(
      expect.objectContaining({
        positionX: 150,
        positionY: 250,
        group_id: null,
      })
    );
  });

  // d67ab28: a copy stays in its source's group. Copying a card out of a group
  // and having it land loose was the bug that commit fixed.
  it("copy without a body inherits the original's group", async () => {
    const createCanvasDraft = mockCopyDeps({
      positionX: 100,
      positionY: 200,
      group_id: "g9",
    });

    const res = await request(buildApp())
      .post("/api/canvas/c1/draft/d1/copy")
      .send({});

    expect(res.status).toBe(201);
    expect(createCanvasDraft).toHaveBeenCalledWith(
      expect.objectContaining({ group_id: "g9" })
    );
  });

  // The escape hatch from that inheritance: an explicit null means "loose",
  // and must not be read as "no opinion".
  it("an explicit null group_id copies a grouped draft out of its group", async () => {
    const createCanvasDraft = mockCopyDeps({
      positionX: 100,
      positionY: 200,
      group_id: "g9",
    });

    const res = await request(buildApp())
      .post("/api/canvas/c1/draft/d1/copy")
      .send({ group_id: null });

    expect(res.status).toBe(201);
    expect(createCanvasDraft).toHaveBeenCalledWith(
      expect.objectContaining({ group_id: null })
    );
  });
});
