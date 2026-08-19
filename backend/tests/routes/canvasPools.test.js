import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRequire } from "node:module";
import express from "express";
import request from "supertest";

const require = createRequire(import.meta.url);
const auth = require("../../middleware/auth");
const socketService = require("../../middleware/socketService");
const sequelize = require("../../config/database");
const Pool = require("../../models/Pool");
const {
  Canvas,
  UserCanvas,
  CanvasDraft,
  CanvasConnection,
  CanvasGroup,
  CanvasAnnotation,
  CanvasPoolPlacement,
} = require("../../models/Canvas");

function buildApp() {
  const routePath = require.resolve("../../routes/canvas");
  // canvas.js mounts the pools router with a static `require("./canvasPools")`
  // at its own top level (beside the annotations router). Deleting only
  // canvas.js's cache entry re-executes canvas.js (so its own
  // `const { protect } = require(...)` picks up this test's spy), but node
  // still serves the cached canvasPools.js module — whose `protect` was
  // captured once, on the first buildApp() call, and never updates. Every
  // test after the first would run the REAL auth middleware and 401 instead
  // of hitting the mock.
  const poolsRoutePath = require.resolve("../../routes/canvasPools");
  delete require.cache[routePath];
  delete require.cache[poolsRoutePath];
  const app = express();
  app.use(express.json());
  app.use("/api/canvas", require("../../routes/canvas"));
  return app;
}

function expectCanvasUpdateBroadcast() {
  expect(socketService.emitToRoom).toHaveBeenCalledWith(
    "c1",
    "canvasUpdate",
    expect.objectContaining({ pools: [] }),
  );
}

const EMPTY_ROLE_POOL_MAP = {
  top: [],
  jungle: [],
  mid: [],
  adc: [],
  support: [],
};

const poolRow = (overrides = {}) => ({
  id: "p1",
  name: "New Pool",
  champions: EMPTY_ROLE_POOL_MAP,
  version: 0,
  save: vi.fn().mockResolvedValue(undefined),
  destroy: vi.fn().mockResolvedValue(undefined),
  toJSON() {
    const { save, destroy, toJSON, ...rest } = this;
    return rest;
  },
  ...overrides,
});

const placementRow = (overrides = {}) => {
  const row = {
    id: "pl1",
    canvas_id: "c1",
    pool_id: "p1",
    positionX: 10,
    positionY: 20,
    source_id: null,
    Pool: poolRow(),
    update: vi.fn().mockResolvedValue(undefined),
    destroy: vi.fn().mockResolvedValue(undefined),
    toJSON() {
      const { update, destroy, toJSON, Pool: _p, ...rest } = this;
      return rest;
    },
    ...overrides,
  };
  return row;
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
    toJSON: () => ({ id: "c1" }),
  });
  vi.spyOn(CanvasDraft, "findAll").mockResolvedValue([]);
  vi.spyOn(CanvasConnection, "findAll").mockResolvedValue([]);
  vi.spyOn(CanvasGroup, "findAll").mockResolvedValue([]);
  vi.spyOn(CanvasAnnotation, "findAll").mockResolvedValue([]);
  vi.spyOn(CanvasPoolPlacement, "findAll").mockResolvedValue([]);
  vi.spyOn(sequelize, "transaction").mockImplementation(async (cb) =>
    cb({}),
  );
});

describe("pool routes — the Canvas Mutation Gate", () => {
  for (const [name, send] of [
    ["create", (app) => request(app).post("/api/canvas/c1/pools").send({})],
    [
      "update",
      (app) =>
        request(app)
          .patch("/api/canvas/c1/pools/pl1")
          .send({ name: "x" }),
    ],
    ["delete", (app) => request(app).delete("/api/canvas/c1/pools/pl1")],
  ]) {
    it(`403s ${name} for a view-only user and writes nothing`, async () => {
      vi.spyOn(UserCanvas, "findOne").mockResolvedValue({
        permissions: "view",
      });
      const create = vi.spyOn(Pool, "create");
      const res = await send(buildApp());
      expect(res.status).toBe(403);
      expect(create).not.toHaveBeenCalled();
    });
  }
});

describe("POST /:canvasId/pools", () => {
  beforeEach(() => {
    vi.spyOn(UserCanvas, "findOne").mockResolvedValue({ permissions: "edit" });
  });

  it("creates a Pool + placement, touches the canvas, broadcasts, 201 with nested Pool", async () => {
    const created = poolRow();
    vi.spyOn(Pool, "create").mockResolvedValue(created);
    const placed = placementRow({ Pool: created });
    vi.spyOn(CanvasPoolPlacement, "create").mockResolvedValue(placed);

    const res = await request(buildApp())
      .post("/api/canvas/c1/pools")
      .send({ positionX: 10, positionY: 20, name: "Blue picks" });

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.pool.Pool).toBeDefined();
    expect(res.body.pool.Pool.id).toBe("p1");
    expectCanvasUpdateBroadcast();
  });

  it("defaults position (50,50), name 'New Pool', empty champions when body is empty", async () => {
    const created = poolRow();
    const poolCreate = vi.spyOn(Pool, "create").mockResolvedValue(created);
    const placementCreate = vi
      .spyOn(CanvasPoolPlacement, "create")
      .mockResolvedValue(placementRow({ Pool: created }));

    const res = await request(buildApp()).post("/api/canvas/c1/pools").send({});

    expect(res.status).toBe(201);
    expect(poolCreate).toHaveBeenCalledWith(
      expect.objectContaining({ name: "New Pool" }),
      expect.anything(),
    );
    const poolCreateArgs = poolCreate.mock.calls[0][0];
    expect(poolCreateArgs.champions).toBeUndefined();
    expect(placementCreate).toHaveBeenCalledWith(
      expect.objectContaining({ positionX: 50, positionY: 50 }),
      expect.anything(),
    );
  });

  it("returns the EXISTING placement (200) and creates nothing when sourceId already exists on this canvas", async () => {
    const existingPlacement = placementRow({
      source_id: "11111111-1111-1111-1111-111111111111",
    });
    vi.spyOn(CanvasPoolPlacement, "findOne").mockResolvedValue(
      existingPlacement,
    );
    const poolCreate = vi.spyOn(Pool, "create");
    const placementCreate = vi.spyOn(CanvasPoolPlacement, "create");

    const res = await request(buildApp())
      .post("/api/canvas/c1/pools")
      .send({ sourceId: "11111111-1111-1111-1111-111111111111" });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(poolCreate).not.toHaveBeenCalled();
    expect(placementCreate).not.toHaveBeenCalled();
  });

  it("re-fetches and returns 200 with the existing row when create loses the race to the unique index", async () => {
    vi.spyOn(CanvasPoolPlacement, "findOne")
      .mockResolvedValueOnce(null) // precheck: nothing yet
      .mockResolvedValueOnce(
        placementRow({
          source_id: "22222222-2222-2222-2222-222222222222",
        }),
      ); // post-failure re-fetch: the winner's row

    vi.spyOn(Pool, "create").mockResolvedValue(poolRow());
    const raceError = new Error("duplicate key value violates unique constraint");
    raceError.name = "SequelizeUniqueConstraintError";
    vi.spyOn(CanvasPoolPlacement, "create").mockRejectedValue(raceError);

    const res = await request(buildApp())
      .post("/api/canvas/c1/pools")
      .send({ sourceId: "22222222-2222-2222-2222-222222222222" });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(CanvasPoolPlacement.findOne).toHaveBeenCalledTimes(2);
  });

  it("400s invalid champions (role key missing)", async () => {
    const res = await request(buildApp())
      .post("/api/canvas/c1/pools")
      .send({ champions: { top: [], jungle: [], mid: [], adc: [] } }); // missing support
    expect(res.status).toBe(400);
  });

  it("400s a malformed sourceId that is not a UUID", async () => {
    const res = await request(buildApp())
      .post("/api/canvas/c1/pools")
      .send({ sourceId: "not-a-uuid" });
    expect(res.status).toBe(400);
  });

  it("403s a view-only user via respondCanvasMutationError", async () => {
    vi.spyOn(UserCanvas, "findOne").mockResolvedValue({ permissions: "view" });
    const res = await request(buildApp()).post("/api/canvas/c1/pools").send({});
    expect(res.status).toBe(403);
  });

  it("builds the snapshot before sending the response, and emits only after", async () => {
    const created = poolRow();
    vi.spyOn(Pool, "create").mockResolvedValue(created);
    vi.spyOn(CanvasPoolPlacement, "create").mockResolvedValue(
      placementRow({ Pool: created }),
    );

    const callOrder = [];
    CanvasPoolPlacement.findAll.mockImplementation(async () => {
      callOrder.push("snapshot-built");
      return [];
    });
    socketService.emitToRoom.mockImplementation(() => {
      callOrder.push("emit");
    });

    const res = await request(buildApp()).post("/api/canvas/c1/pools").send({});

    expect(res.status).toBe(201);
    expect(callOrder).toEqual(["snapshot-built", "emit"]);
  });

  it("yields a 500 with no double-send when the snapshot builder throws", async () => {
    const created = poolRow();
    vi.spyOn(Pool, "create").mockResolvedValue(created);
    vi.spyOn(CanvasPoolPlacement, "create").mockResolvedValue(
      placementRow({ Pool: created }),
    );
    CanvasPoolPlacement.findAll.mockRejectedValue(new Error("snapshot boom"));

    const res = await request(buildApp()).post("/api/canvas/c1/pools").send({});

    expect(res.status).toBe(500);
    expect(socketService.emitToRoom).not.toHaveBeenCalled();
  });
});

describe("PATCH /:canvasId/pools/:placementId", () => {
  beforeEach(() => {
    vi.spyOn(UserCanvas, "findOne").mockResolvedValue({ permissions: "edit" });
  });

  it("writes the Pool row when name is patched", async () => {
    const pool = poolRow();
    const placement = placementRow({ Pool: pool });
    vi.spyOn(CanvasPoolPlacement, "findOne").mockResolvedValue(placement);

    const res = await request(buildApp())
      .patch("/api/canvas/c1/pools/pl1")
      .send({ name: "Renamed" });

    expect(res.status).toBe(200);
    expect(pool.name).toBe("Renamed");
    expect(pool.save).toHaveBeenCalled();
    expect(placement.update).not.toHaveBeenCalled();
    expectCanvasUpdateBroadcast();
  });

  it("writes the placement when position is patched", async () => {
    const pool = poolRow();
    const placement = placementRow({ Pool: pool });
    vi.spyOn(CanvasPoolPlacement, "findOne").mockResolvedValue(placement);

    const res = await request(buildApp())
      .patch("/api/canvas/c1/pools/pl1")
      .send({ positionX: 100, positionY: 200 });

    expect(res.status).toBe(200);
    expect(placement.update).toHaveBeenCalledWith({
      positionX: 100,
      positionY: 200,
    });
    expect(pool.save).not.toHaveBeenCalled();
  });

  it("404s an unknown placement", async () => {
    vi.spyOn(CanvasPoolPlacement, "findOne").mockResolvedValue(null);
    const res = await request(buildApp())
      .patch("/api/canvas/c1/pools/plX")
      .send({ name: "x" });
    expect(res.status).toBe(404);
  });

  it("404s a placement that belongs to another canvas", async () => {
    // findOne is scoped by { id, canvas_id }; a placement on another canvas
    // simply doesn't match and resolves null.
    vi.spyOn(CanvasPoolPlacement, "findOne").mockResolvedValue(null);
    const res = await request(buildApp())
      .patch("/api/canvas/c1/pools/pl1")
      .send({ name: "x" });
    expect(res.status).toBe(404);
    expect(CanvasPoolPlacement.findOne).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "pl1", canvas_id: "c1" },
      }),
    );
  });
});

describe("DELETE /:canvasId/pools/:placementId", () => {
  beforeEach(() => {
    vi.spyOn(UserCanvas, "findOne").mockResolvedValue({ permissions: "edit" });
  });

  it("destroys the POOL row (not the placement) and broadcasts", async () => {
    const pool = poolRow();
    const placement = placementRow({ Pool: pool });
    vi.spyOn(CanvasPoolPlacement, "findOne").mockResolvedValue(placement);

    const res = await request(buildApp()).delete("/api/canvas/c1/pools/pl1");

    expect(res.status).toBe(200);
    expect(pool.destroy).toHaveBeenCalled();
    expect(placement.destroy).not.toHaveBeenCalled();
    expectCanvasUpdateBroadcast();
  });

  it("404s an unknown placement", async () => {
    vi.spyOn(CanvasPoolPlacement, "findOne").mockResolvedValue(null);
    const res = await request(buildApp()).delete("/api/canvas/c1/pools/plX");
    expect(res.status).toBe(404);
  });
});
