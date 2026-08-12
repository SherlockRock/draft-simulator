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
  CanvasAnnotation,
} = require("../../models/Canvas");

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

const lockedRow = (id, extra = {}) => ({
  id,
  positionX: 0,
  positionY: 0,
  update: vi.fn().mockResolvedValue(undefined),
  ...extra,
});

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
  vi.spyOn(UserCanvas, "findOne").mockResolvedValue({ permissions: "edit" });
});

describe("PUT /:canvasId/draft-positions — annotations", () => {
  // Every shape case carries a legal Card entry so the batch is never empty:
  // without it these pass on the pre-existing "Nothing to update" 400 while
  // `annotations` is still ignored outright, which is a false green.
  const withCard = (body) => ({
    positions: [{ draft_id: "d1", positionX: 0, positionY: 0 }],
    ...body,
  });

  it("rejects a malformed annotation entry with 400", async () => {
    const transaction = vi.spyOn(Canvas.sequelize, "transaction");

    const res = await request(buildApp())
      .put("/api/canvas/c1/draft-positions")
      .send(
        withCard({ annotations: [{ id: "a1", positionX: "nope", positionY: 0 }] }),
      );

    expect(res.status).toBe(400);
    expect(transaction).not.toHaveBeenCalled();
  });

  it("400s when annotations is not an array", async () => {
    const transaction = vi.spyOn(Canvas.sequelize, "transaction");

    const res = await request(buildApp())
      .put("/api/canvas/c1/draft-positions")
      .send(withCard({ annotations: "nope" }));

    expect(res.status).toBe(400);
    expect(transaction).not.toHaveBeenCalled();
  });

  // Symmetric with the existing duplicate-group rejection. Duplicate ids in one
  // batch are what makes lock order caller-dependent.
  it("rejects the same annotation id twice with 400", async () => {
    const transaction = vi.spyOn(Canvas.sequelize, "transaction");

    const res = await request(buildApp())
      .put("/api/canvas/c1/draft-positions")
      .send(
        withCard({
          annotations: [
            { id: "a1", positionX: 0, positionY: 0 },
            { id: "a1", positionX: 10, positionY: 10 },
          ],
        }),
      );

    expect(res.status).toBe(400);
    expect(transaction).not.toHaveBeenCalled();
  });

  // The axis-sibling of the above, missing until now (design §3).
  it("rejects the same draft id twice with 400", async () => {
    const res = await request(buildApp())
      .put("/api/canvas/c1/draft-positions")
      .send({
        positions: [
          { draft_id: "d1", positionX: 0, positionY: 0 },
          { draft_id: "d1", positionX: 10, positionY: 10 },
        ],
      });
    expect(res.status).toBe(400);
  });

  it("404s an annotation that is not on the canvas, before any write", async () => {
    const t = mockTransaction();
    vi.spyOn(CanvasAnnotation, "findAll").mockResolvedValue([]);
    const res = await request(buildApp())
      .put("/api/canvas/c1/draft-positions")
      .send({ annotations: [{ id: "aX", positionX: 0, positionY: 0 }] });
    expect(res.status).toBe(404);
    expect(t.rollback).toHaveBeenCalled();
  });

  // Containment, not authorization: the Gate said yes, the Group is still
  // another canvas's.
  it("404s an annotation whose group_id is not on this canvas", async () => {
    const t = mockTransaction();
    const note = lockedRow("a1");
    vi.spyOn(CanvasAnnotation, "findAll").mockResolvedValue([note]);
    vi.spyOn(CanvasGroup, "findAll").mockResolvedValue([]);
    const res = await request(buildApp())
      .put("/api/canvas/c1/draft-positions")
      .send({
        annotations: [
          { id: "a1", positionX: 0, positionY: 0, group_id: "gForeign" },
        ],
      });
    expect(res.status).toBe(404);
    expect(t.rollback).toHaveBeenCalled();
    expect(note.update).not.toHaveBeenCalled();
  });

  // The TOCTOU fix: a Card-only batch used to validate group_id through an
  // UNLOCKED query when groups.length === 0.
  it("locks the referenced Groups even when no Group is being moved", async () => {
    mockTransaction();
    const groupFindAll = vi
      .spyOn(CanvasGroup, "findAll")
      .mockResolvedValue([lockedRow("g1")]);
    vi.spyOn(CanvasDraft, "findAll").mockResolvedValue([
      lockedRow("d1", { draft_id: "d1" }),
    ]);
    vi.spyOn(CanvasAnnotation, "findAll").mockResolvedValue([]);

    await request(buildApp())
      .put("/api/canvas/c1/draft-positions")
      .send({
        positions: [
          { draft_id: "d1", positionX: 0, positionY: 0, group_id: "g1" },
        ],
      });

    expect(groupFindAll).toHaveBeenCalledWith(
      expect.objectContaining({ lock: true }),
    );
  });

  // The standalone dimensions/metadata row used to be resolved by an UNLOCKED
  // findOne AFTER every Card write, then updated — a Group lock taken after the
  // Card locks, and a referenced row validated after writing.
  it("locks and validates the standalone group before any write", async () => {
    const t = mockTransaction();
    const groupFindOne = vi.spyOn(CanvasGroup, "findOne");
    vi.spyOn(CanvasGroup, "findAll").mockResolvedValue([]);
    const card = lockedRow("d1", { draft_id: "d1" });
    vi.spyOn(CanvasDraft, "findAll").mockResolvedValue([card]);

    const res = await request(buildApp())
      .put("/api/canvas/c1/draft-positions")
      .send({
        positions: [{ draft_id: "d1", positionX: 0, positionY: 0 }],
        group: { id: "gGone", width: 400 },
      });

    expect(res.status).toBe(404);
    expect(t.rollback).toHaveBeenCalled();
    expect(card.update).not.toHaveBeenCalled();
    expect(groupFindOne).not.toHaveBeenCalled();
  });

  it("takes every lock in ascending id order within its type", async () => {
    mockTransaction();
    vi.spyOn(CanvasGroup, "findAll").mockResolvedValue([]);
    const draftFindAll = vi
      .spyOn(CanvasDraft, "findAll")
      .mockResolvedValue([
        lockedRow("d1", { draft_id: "d1" }),
        lockedRow("d2", { draft_id: "d2" }),
      ]);
    const annotationFindAll = vi
      .spyOn(CanvasAnnotation, "findAll")
      .mockResolvedValue([lockedRow("a1"), lockedRow("a2")]);

    await request(buildApp())
      .put("/api/canvas/c1/draft-positions")
      .send({
        positions: [
          { draft_id: "d2", positionX: 0, positionY: 0 },
          { draft_id: "d1", positionX: 0, positionY: 0 },
        ],
        annotations: [
          { id: "a2", positionX: 0, positionY: 0 },
          { id: "a1", positionX: 0, positionY: 0 },
        ],
      });

    expect(draftFindAll).toHaveBeenCalledWith(
      expect.objectContaining({
        order: [["draft_id", "ASC"]],
        lock: true,
        where: expect.objectContaining({ draft_id: ["d1", "d2"] }),
      }),
    );
    expect(annotationFindAll).toHaveBeenCalledWith(
      expect.objectContaining({
        order: [["id", "ASC"]],
        lock: true,
        where: expect.objectContaining({ id: ["a1", "a2"] }),
      }),
    );
  });

  // The TYPE half of the order: Group, then Card, then annotation. Ascending
  // ids alone are not deadlock-free if two batches disagree on which table to
  // touch first.
  it("acquires the three types in the fixed order Group, Card, annotation", async () => {
    mockTransaction();
    const groupFindAll = vi
      .spyOn(CanvasGroup, "findAll")
      .mockResolvedValue([lockedRow("g1")]);
    const draftFindAll = vi
      .spyOn(CanvasDraft, "findAll")
      .mockResolvedValue([lockedRow("d1", { draft_id: "d1" })]);
    const annotationFindAll = vi
      .spyOn(CanvasAnnotation, "findAll")
      .mockResolvedValue([lockedRow("a1")]);

    const res = await request(buildApp())
      .put("/api/canvas/c1/draft-positions")
      .send({
        positions: [
          { draft_id: "d1", positionX: 0, positionY: 0, group_id: "g1" },
        ],
        annotations: [{ id: "a1", positionX: 0, positionY: 0, group_id: "g1" }],
      });

    expect(res.status).toBe(200);
    const [groupCall] = groupFindAll.mock.invocationCallOrder;
    const [draftCall] = draftFindAll.mock.invocationCallOrder;
    const [annotationCall] = annotationFindAll.mock.invocationCallOrder;
    expect(groupCall).toBeLessThan(draftCall);
    expect(draftCall).toBeLessThan(annotationCall);
  });

  // The whole point of one endpoint: a grid reflow moves Cards and annotations
  // together, and split across two endpoints one drag becomes two non-atomic
  // transactions.
  it("commits Cards and annotations in ONE transaction and broadcasts both", async () => {
    const t = mockTransaction();
    vi.spyOn(CanvasGroup, "findAll").mockResolvedValue([]);
    const card = lockedRow("d1", { draft_id: "d1" });
    const note = lockedRow("a1");
    vi.spyOn(CanvasDraft, "findAll").mockResolvedValue([card]);
    vi.spyOn(CanvasAnnotation, "findAll").mockResolvedValue([note]);

    const res = await request(buildApp())
      .put("/api/canvas/c1/draft-positions")
      .send({
        positions: [{ draft_id: "d1", positionX: 16, positionY: 64 }],
        annotations: [{ id: "a1", positionX: 420, positionY: 64 }],
      });

    expect(res.status).toBe(200);
    expect(Canvas.sequelize.transaction).toHaveBeenCalledTimes(1);
    expect(t.commit).toHaveBeenCalled();
    expect(card.update).toHaveBeenCalled();
    expect(note.update).toHaveBeenCalled();

    const broadcast = socketService.emitToRoom.mock.calls.find(
      ([, event]) => event === "draftPositionsUpdated",
    );
    expect(broadcast?.[2].annotations).toEqual([
      { id: "a1", positionX: 420, positionY: 64 },
    ]);
  });

  // `group_id` is tri-state on key PRESENCE, matching positions[]: absent
  // leaves membership alone, null ungroups, a string moves it.
  it("writes group_id only when the key is present", async () => {
    mockTransaction();
    vi.spyOn(CanvasGroup, "findAll").mockResolvedValue([lockedRow("g1")]);
    const stay = lockedRow("a1");
    const loose = lockedRow("a2");
    const moved = lockedRow("a3");
    vi.spyOn(CanvasAnnotation, "findAll").mockResolvedValue([
      stay,
      loose,
      moved,
    ]);

    await request(buildApp())
      .put("/api/canvas/c1/draft-positions")
      .send({
        annotations: [
          { id: "a1", positionX: 1, positionY: 1 },
          { id: "a2", positionX: 2, positionY: 2, group_id: null },
          { id: "a3", positionX: 3, positionY: 3, group_id: "g1" },
        ],
      });

    expect(stay.update).toHaveBeenCalledWith(
      { positionX: 1, positionY: 1 },
      expect.anything(),
    );
    expect(loose.update).toHaveBeenCalledWith(
      { positionX: 2, positionY: 2, group_id: null },
      expect.anything(),
    );
    expect(moved.update).toHaveBeenCalledWith(
      { positionX: 3, positionY: 3, group_id: "g1" },
      expect.anything(),
    );
  });

  // D13: the champion-pool Group is all annotations and zero Cards. An
  // annotations-only batch must not fall into the "nothing to update" 400.
  it("accepts an annotations-only batch (the zero-Card Group)", async () => {
    mockTransaction();
    vi.spyOn(CanvasGroup, "findAll").mockResolvedValue([]);
    vi.spyOn(CanvasAnnotation, "findAll").mockResolvedValue([lockedRow("a1")]);

    const res = await request(buildApp())
      .put("/api/canvas/c1/draft-positions")
      .send({ annotations: [{ id: "a1", positionX: 0, positionY: 0 }] });

    expect(res.status).toBe(200);
  });

  // D13 acceptance fixture in full: a `custom` Group laid out as a grid with
  // rowLabels S / A / Situational, holding NO Cards and three annotations. One
  // reflow of that Group is positions: [], three annotations, and the Group's
  // own metadata — the state existing canvas code handles worst.
  it("reflows the D13 champion-pool Group: no Cards, three annotations, one commit", async () => {
    const t = mockTransaction();
    const pool = {
      id: "g-pool",
      type: "custom",
      parent_group_id: null,
      positionX: 0,
      positionY: 0,
      metadata: { layout: "grid", rowLabels: ["S", "A", "Situational"] },
      update: vi.fn().mockResolvedValue(undefined),
      toJSON: () => ({
        id: "g-pool",
        metadata: { layout: "grid", rowLabels: ["S", "A", "Situational"] },
      }),
    };
    vi.spyOn(CanvasGroup, "findAll").mockResolvedValue([pool]);
    const draftFindAll = vi.spyOn(CanvasDraft, "findAll");
    const notes = [lockedRow("n1"), lockedRow("n2"), lockedRow("n3")];
    vi.spyOn(CanvasAnnotation, "findAll").mockResolvedValue(notes);

    const annotations = [
      { id: "n1", positionX: 16, positionY: 16, group_id: "g-pool" },
      { id: "n2", positionX: 416, positionY: 16, group_id: "g-pool" },
      { id: "n3", positionX: 16, positionY: 160, group_id: "g-pool" },
    ];
    const res = await request(buildApp())
      .put("/api/canvas/c1/draft-positions")
      .send({
        positions: [],
        annotations,
        group: {
          id: "g-pool",
          height: 420,
          metadata: { gridCols: 2, rowLabels: ["S", "A", "Situational"] },
        },
      });

    expect(res.status).toBe(200);
    expect(Canvas.sequelize.transaction).toHaveBeenCalledTimes(1);
    expect(t.commit).toHaveBeenCalled();
    // Zero Cards means zero Card locks, not a Card query returning nothing.
    expect(draftFindAll).not.toHaveBeenCalled();
    for (const note of notes) expect(note.update).toHaveBeenCalled();
    expect(pool.update).toHaveBeenCalledWith(
      {
        height: 420,
        metadata: {
          layout: "grid",
          gridCols: 2,
          rowLabels: ["S", "A", "Situational"],
        },
      },
      expect.anything(),
    );

    const broadcast = socketService.emitToRoom.mock.calls.find(
      ([, event]) => event === "draftPositionsUpdated",
    );
    expect(broadcast?.[2].annotations).toEqual(annotations);
    expect(broadcast?.[2].positions).toEqual([]);
  });
});
