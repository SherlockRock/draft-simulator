import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRequire } from "node:module";
import express from "express";
import request from "supertest";
import { MAX_GROUP_DEPTH } from "@draft-sim/shared-types/canvas-tree-vector";

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
const VersusDraft = require("../../models/VersusDraft.js");
const Team = require("../../models/Team");

/**
 * The three routes 5a-1 teaches about nesting:
 *
 *  - `POST /:canvasId/group` accepting `parentId` (design §9.1c, plan A6),
 *    through the SAME `resolveParentage` predicate and the SAME canvas-wide
 *    lock the batch route uses.
 *  - `DELETE /:canvasId/group/:groupId` promoting direct child Groups before
 *    the destroy (§8.2.0, plan A2) — `parent_group_id` has no `onDelete`, so
 *    without this the delete is a 500 and the container is undeletable.
 *  - `POST /.../convert-to-series` refusing a container that holds Groups
 *    (plan A13) — the series-leaf invariant was enforced on every parentage
 *    write and on no TYPE write.
 */

function buildApp() {
  const routePath = require.resolve("../../routes/canvas");
  delete require.cache[routePath];
  const app = express();
  app.use(express.json());
  app.use("/api/canvas", require("../../routes/canvas"));
  return app;
}

const groupRow = (id, opts = {}) => ({
  id,
  canvas_id: "c1",
  type: opts.type ?? "custom",
  parent_group_id: opts.parent ?? null,
  positionX: opts.x ?? 0,
  positionY: opts.y ?? 0,
  width: 400,
  height: 200,
  versus_draft_id: opts.versus ?? null,
  metadata: opts.metadata ?? {},
  update: vi.fn().mockResolvedValue(undefined),
  destroy: vi.fn().mockResolvedValue(undefined),
  toJSON() {
    return { ...this };
  },
});

let transaction;

beforeEach(() => {
  vi.restoreAllMocks();
  transaction = { commit: vi.fn(), rollback: vi.fn(), finished: false };
  transaction.commit.mockImplementation(async () => {
    transaction.finished = "commit";
  });
  transaction.rollback.mockImplementation(async () => {
    transaction.finished = "rollback";
  });

  vi.spyOn(auth, "protect").mockImplementation((req, _res, next) => {
    req.user = { id: "u1" };
    next();
  });
  vi.spyOn(socketService, "emitToRoom").mockImplementation(() => {});
  vi.spyOn(UserCanvas, "findOne").mockResolvedValue({ permissions: "edit" });
  vi.spyOn(Canvas.sequelize, "transaction").mockResolvedValue(transaction);
  vi.spyOn(Canvas, "findByPk").mockResolvedValue({
    changed: vi.fn(),
    save: vi.fn().mockResolvedValue(undefined),
    toJSON: () => ({ id: "c1" }),
  });
  vi.spyOn(CanvasDraft, "findAll").mockResolvedValue([]);
  vi.spyOn(CanvasConnection, "findAll").mockResolvedValue([]);
  vi.spyOn(Team, "findAll").mockResolvedValue([]);
});

describe("POST /:canvasId/group with parentId", () => {
  const create = (body) =>
    request(buildApp()).post("/api/canvas/c1/group").send(body);

  const onCanvas = (rows) => {
    vi.spyOn(CanvasGroup, "findAll").mockResolvedValue(rows);
  };

  it("nests the new group and writes the position UNCHANGED (ADR-0006)", async () => {
    onCanvas([groupRow("parent", { x: 500, y: 400 })]);
    const created = vi.spyOn(CanvasGroup, "create").mockImplementation(
      async (values) => ({ ...values, toJSON: () => values }),
    );

    const res = await create({
      name: "Child",
      positionX: 540,
      positionY: 460,
      parentId: "parent",
    });

    expect(res.status).toBe(201);
    expect(created.mock.calls.at(-1)[0]).toMatchObject({
      parent_group_id: "parent",
      // Absolute world, NOT rebased against the parent's origin.
      positionX: 540,
      positionY: 460,
    });
    expect(transaction.commit).toHaveBeenCalled();
  });

  it("takes the canvas-wide lock in id order before validating", async () => {
    onCanvas([groupRow("parent")]);
    vi.spyOn(CanvasGroup, "create").mockImplementation(async (values) => ({
      ...values,
      toJSON: () => values,
    }));

    await create({ positionX: 0, positionY: 0, parentId: "parent" });

    expect(CanvasGroup.findAll).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { canvas_id: "c1" },
        order: [["id", "ASC"]],
        lock: true,
      }),
    );
  });

  it("keeps the unparented create lock-free", async () => {
    const findAll = vi.spyOn(CanvasGroup, "findAll").mockResolvedValue([]);
    vi.spyOn(CanvasGroup, "create").mockImplementation(async (values) => ({
      ...values,
      toJSON: () => values,
    }));

    const res = await create({ positionX: 0, positionY: 0 });

    expect(res.status).toBe(201);
    expect(Canvas.sequelize.transaction).not.toHaveBeenCalled();
    // The broadcast still reads every group; what must not happen is a lock.
    for (const call of findAll.mock.calls) {
      expect(call[0].lock).toBeUndefined();
    }
  });

  it("400s on a parent that is not on this canvas", async () => {
    onCanvas([groupRow("parent")]);
    const created = vi.spyOn(CanvasGroup, "create");

    const res = await create({ positionX: 0, positionY: 0, parentId: "ghost" });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("That group isn't on this canvas");
    expect(created).not.toHaveBeenCalled();
    expect(transaction.rollback).toHaveBeenCalled();
  });

  it("400s on a series parent", async () => {
    onCanvas([groupRow("bo3", { type: "series" })]);

    const res = await create({ positionX: 0, positionY: 0, parentId: "bo3" });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Can't put a group inside a series");
  });

  // Derived from the shared constant, not from a literal: the route keeps its
  // own copy because it is CommonJS, and this is what makes them agree.
  const chainOfDepth = (depth) =>
    Array.from({ length: depth + 1 }, (_, i) =>
      groupRow(`d${i}`, i === 0 ? {} : { parent: `d${i - 1}` }),
    );

  it("400s when the new row would sit past the depth cap", async () => {
    // A child of a MAX_GROUP_DEPTH-deep Group has MAX_GROUP_DEPTH + 1 ancestors.
    onCanvas(chainOfDepth(MAX_GROUP_DEPTH));

    const res = await create({
      positionX: 0,
      positionY: 0,
      parentId: `d${MAX_GROUP_DEPTH}`,
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Too deeply nested");
  });

  it("permits the deepest legal parent", async () => {
    onCanvas(chainOfDepth(MAX_GROUP_DEPTH - 1));
    vi.spyOn(CanvasGroup, "create").mockImplementation(async (values) => ({
      ...values,
      toJSON: () => values,
    }));

    const res = await create({
      positionX: 0,
      positionY: 0,
      parentId: `d${MAX_GROUP_DEPTH - 1}`,
    });

    expect(res.status).toBe(201);
  });
});

describe("DELETE /:canvasId/group/:groupId promotes child Groups", () => {
  const del = (id) => request(buildApp()).delete(`/api/canvas/c1/group/${id}`);

  beforeEach(() => {
    vi.spyOn(VersusDraft, "findOne").mockResolvedValue(null);
    vi.spyOn(CanvasDraft, "destroy").mockResolvedValue(0);
  });

  it("re-parents direct children to the deleted group's own parent", async () => {
    const target = groupRow("mid", { parent: "top" });
    vi.spyOn(CanvasGroup, "findOne").mockResolvedValue(target);
    vi.spyOn(CanvasGroup, "findAll").mockResolvedValue([]);
    const update = vi.spyOn(CanvasGroup, "update").mockResolvedValue([1]);

    const res = await del("mid");

    expect(res.status).toBe(200);
    expect(update).toHaveBeenCalledWith(
      { parent_group_id: "top" },
      expect.objectContaining({
        where: { parent_group_id: "mid", canvas_id: "c1" },
      }),
    );
    // The promotion has to precede the destroy, or the FK is already violated.
    expect(update.mock.invocationCallOrder[0]).toBeLessThan(
      target.destroy.mock.invocationCallOrder[0],
    );
  });

  it("promotes to top level when the deleted group was top level", async () => {
    vi.spyOn(CanvasGroup, "findOne").mockResolvedValue(groupRow("top"));
    vi.spyOn(CanvasGroup, "findAll").mockResolvedValue([]);
    const update = vi.spyOn(CanvasGroup, "update").mockResolvedValue([0]);

    await del("top");

    expect(update).toHaveBeenCalledWith(
      { parent_group_id: null },
      expect.anything(),
    );
  });
});

describe("POST /:canvasId/group/:groupId/convert-to-series", () => {
  const convert = (id) =>
    request(buildApp())
      .post(`/api/canvas/c1/group/${id}/convert-to-series`)
      .send({ name: "Series", length: 3 });

  it("refuses a container that holds Groups (series-leaf invariant)", async () => {
    vi.spyOn(CanvasGroup, "findOne").mockResolvedValue(groupRow("holder"));
    const count = vi.spyOn(CanvasGroup, "count").mockResolvedValue(2);
    const created = vi.spyOn(VersusDraft, "create");

    const res = await convert("holder");

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Can't convert a group that contains groups");
    expect(count).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { parent_group_id: "holder", canvas_id: "c1" },
      }),
    );
    expect(created).not.toHaveBeenCalled();
    expect(transaction.rollback).toHaveBeenCalled();
  });
});
