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
  CanvasConnection,
  CanvasAnnotation,
} = require("../../models/Canvas");
const Draft = require("../../models/Draft");
const VersusDraft = require("../../models/VersusDraft");
const UserToken = require("../../models/UserToken");

const IMPORT_FORBIDDEN =
  "Forbidden: You don't have permission to import into this canvas";

function loadRouter() {
  const routePath = require.resolve("../../routes/users");
  delete require.cache[routePath];
  return require("../../routes/users");
}

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/users", loadRouter());
  return app;
}

function importBody() {
  return {
    data: {
      drafts: [{ name: "Imported Draft", picks: Array(20).fill("") }],
      versusSeries: [],
    },
    options: { dedupeStrategy: "skip" },
  };
}

function makeTransaction() {
  const transaction = {
    finished: false,
    commit: vi.fn().mockImplementation(async () => {
      transaction.finished = "commit";
    }),
    rollback: vi.fn().mockImplementation(async () => {
      transaction.finished = "rollback";
    }),
  };
  return transaction;
}

function mockOwnedCanvasWith({ annotations = [], groups = [], drafts = [] }) {
  vi.spyOn(UserCanvas, "findAll").mockResolvedValue([
    {
      Canvas: {
        id: "source-canvas",
        name: "Review board",
        description: "",
        icon: "",
        createdAt: new Date("2026-08-12T00:00:00.000Z"),
        CanvasDrafts: drafts,
        CanvasGroups: groups,
        CanvasAnnotations: annotations,
      },
    },
  ]);
  vi.spyOn(VersusDraft, "findAll").mockResolvedValue([]);
}

async function importCanvasWith(
  importedCanvas,
  { canvasId = "destination-canvas", dedupeStrategy = "overwrite" } = {},
) {
  return request(buildApp())
    .post("/api/users/me/import")
    .send({
      exportData: {
        exportedAt: "2026-08-12T00:00:00.000Z",
        canvases: [
          {
            id: "source-canvas",
            name: "Review board",
            drafts: [],
            groups: [],
            ...importedCanvas,
          },
        ],
        versusSeries: [],
      },
      options: {
        canvasIds: ["source-canvas"],
        versusSeriesIds: [],
        dedupeStrategy,
        canvasImportMode: "target_canvas",
        targetCanvasId: canvasId,
      },
    });
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(auth, "protect").mockImplementation((req, _res, next) => {
    req.user = { id: "u1" };
    next();
  });
  vi.spyOn(socketService, "emitToRoom").mockImplementation(() => {});
  vi.spyOn(canvasProjections, "buildCanvasSnapshot").mockResolvedValue({
    canvas: { id: "c-1" },
    drafts: [],
    groups: [],
    connections: [],
    annotations: [],
  });
});

describe("user import route canvas access", () => {
  it("POST /me/import/canvas/:canvasId returns original 403 text and does not create a transaction for view permission", async () => {
    vi.spyOn(UserCanvas, "findOne").mockResolvedValue({ permissions: "view" });
    const transaction = vi.spyOn(sequelize, "transaction");

    const res = await request(buildApp())
      .post("/api/users/me/import/canvas/c-1")
      .send(importBody());

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: IMPORT_FORBIDDEN });
    expect(transaction).not.toHaveBeenCalled();
  });
});

describe("annotation deletion cleanup", () => {
  it("new_canvases overwrite clears annotations from an existing same-name canvas", async () => {
    const transaction = {
      finished: false,
      commit: vi.fn().mockImplementation(async () => {
        transaction.finished = "commit";
      }),
      rollback: vi.fn().mockImplementation(async () => {
        transaction.finished = "rollback";
      }),
    };
    vi.spyOn(sequelize, "transaction").mockResolvedValue(transaction);
    const destinationCanvas = {
      id: "c-1",
      update: vi.fn().mockResolvedValue(),
      changed: vi.fn(),
      save: vi.fn().mockResolvedValue(),
    };
    vi.spyOn(UserCanvas, "findOne").mockResolvedValue({
      Canvas: destinationCanvas,
    });
    vi.spyOn(CanvasDraft, "findAll").mockResolvedValue([]);
    vi.spyOn(CanvasDraft, "destroy").mockResolvedValue(0);
    vi.spyOn(CanvasConnection, "destroy").mockResolvedValue(0);
    vi.spyOn(CanvasGroup, "destroy").mockResolvedValue(1);
    const annotationDestroy = vi
      .spyOn(CanvasAnnotation, "destroy")
      .mockResolvedValue(3);

    const res = await request(buildApp())
      .post("/api/users/me/import")
      .send({
        exportData: {
          exportedAt: "2026-08-12T00:00:00.000Z",
          canvases: [
            {
              id: "source-canvas",
              name: "Collision",
              drafts: [],
              groups: [],
              annotations: [],
            },
          ],
          versusSeries: [],
        },
        options: {
          canvasIds: ["source-canvas"],
          versusSeriesIds: [],
          dedupeStrategy: "overwrite",
          canvasImportMode: "new_canvases",
        },
      });

    expect(res.status).toBe(200);
    expect(annotationDestroy).toHaveBeenCalledWith(
      expect.objectContaining({ where: { canvas_id: "c-1" } }),
    );
    expect(annotationDestroy.mock.invocationCallOrder[0]).toBeLessThan(
      CanvasGroup.destroy.mock.invocationCallOrder[0],
    );
  });

  it("account deletion destroys annotations before each owned canvas", async () => {
    const user = { id: "u1", email: "owner@example.com", destroy: vi.fn() };
    vi.spyOn(auth, "protect").mockImplementation((req, _res, next) => {
      req.user = user;
      next();
    });
    vi.spyOn(UserCanvas, "findAll").mockResolvedValue([{ canvas_id: "c-1" }]);
    vi.spyOn(UserCanvas, "destroy").mockResolvedValue(1);
    vi.spyOn(CanvasDraft, "findAll").mockResolvedValue([]);
    vi.spyOn(CanvasConnection, "destroy").mockResolvedValue(0);
    const annotationDestroy = vi
      .spyOn(CanvasAnnotation, "destroy")
      .mockResolvedValue(2);
    vi.spyOn(Canvas, "destroy").mockResolvedValue(1);
    vi.spyOn(Draft, "destroy").mockResolvedValue(0);
    vi.spyOn(VersusDraft, "update").mockResolvedValue([0]);
    vi.spyOn(UserToken, "destroy").mockResolvedValue(1);

    const res = await request(buildApp())
      .delete("/api/users/me")
      .send({ confirmEmail: "owner@example.com" });

    expect(res.status).toBe(200);
    expect(annotationDestroy).toHaveBeenCalledWith({
      where: { canvas_id: "c-1" },
    });
    expect(annotationDestroy.mock.invocationCallOrder[0]).toBeLessThan(
      Canvas.destroy.mock.invocationCallOrder[0],
    );
  });
});

describe("user export annotations", () => {
  it("exports content, membership, and both manual size floors", async () => {
    mockOwnedCanvasWith({
      annotations: [
        {
          id: "annotation-1",
          positionX: 10,
          positionY: 20,
          width: 420,
          height: 180,
          manualWidth: 420,
          manualHeight: 180,
          text: "their jungler always flexes here",
          championIds: ["Ahri"],
          color: "amber",
          fontSize: "lg",
          group_id: "group-1",
        },
      ],
    });

    const res = await request(buildApp()).get("/api/users/me/export");

    expect(res.status).toBe(200);
    expect(res.body.canvases[0].annotations).toEqual([
      expect.objectContaining({
        id: "annotation-1",
        text: "their jungler always flexes here",
        championIds: ["Ahri"],
        color: "amber",
        fontSize: "lg",
        manualWidth: 420,
        manualHeight: 180,
        group_id: "group-1",
      }),
    ]);
  });

  it("preserves null manual size floors and emits an empty annotation array", async () => {
    mockOwnedCanvasWith({
      annotations: [
        {
          id: "annotation-null-floor",
          positionX: 0,
          positionY: 0,
          width: 380,
          height: 120,
          manualWidth: null,
          manualHeight: null,
          text: "",
          championIds: [],
          color: "slate",
          fontSize: "md",
          group_id: null,
        },
      ],
    });
    const withNulls = await request(buildApp()).get("/api/users/me/export");
    expect(withNulls.body.canvases[0].annotations[0]).toEqual(
      expect.objectContaining({ manualWidth: null, manualHeight: null }),
    );

    mockOwnedCanvasWith({ annotations: [] });
    const empty = await request(buildApp()).get("/api/users/me/export");
    expect(empty.body.canvases[0].annotations).toEqual([]);
  });
});

describe("user import annotations", () => {
  beforeEach(() => {
    vi.spyOn(sequelize, "transaction").mockImplementation(async () =>
      makeTransaction(),
    );
    vi.spyOn(UserCanvas, "findOne").mockResolvedValue({ permissions: "edit" });
    vi.spyOn(Canvas, "findByPk").mockImplementation(async (id) => ({
      id,
      changed: vi.fn(),
      save: vi.fn().mockResolvedValue(undefined),
    }));
    vi.spyOn(CanvasGroup, "findAll").mockResolvedValue([]);
    vi.spyOn(CanvasGroup, "findOne").mockResolvedValue(null);
    vi.spyOn(CanvasDraft, "findOne").mockResolvedValue(null);
  });

  it("remaps group membership and preserves manual size floors", async () => {
    vi.spyOn(CanvasGroup, "create").mockResolvedValue({ id: "new-group" });
    vi.spyOn(CanvasAnnotation, "findOne").mockResolvedValue(null);
    const create = vi
      .spyOn(CanvasAnnotation, "create")
      .mockResolvedValue({ id: "new-annotation" });

    const res = await importCanvasWith({
      groups: [
        {
          id: "export-group",
          name: "Faker — Mid",
          type: "custom",
          positionX: 0,
          positionY: 0,
        },
      ],
      annotations: [
        {
          id: "export-annotation",
          positionX: 5,
          positionY: 6,
          width: 420,
          height: 180,
          manualWidth: 410,
          manualHeight: 170,
          text: "S tier",
          championIds: [],
          color: "slate",
          fontSize: "md",
          group_id: "export-group",
        },
      ],
    });

    expect(res.status).toBe(200);
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        canvas_id: "destination-canvas",
        source_id: "export-annotation",
        group_id: "new-group",
        manualWidth: 410,
        manualHeight: 170,
      }),
      expect.anything(),
    );
    expect(create.mock.calls[0][0]).not.toHaveProperty("id");
  });

  it("keeps null manual size floors null on import", async () => {
    vi.spyOn(CanvasAnnotation, "findOne").mockResolvedValue(null);
    const create = vi
      .spyOn(CanvasAnnotation, "create")
      .mockResolvedValue({ id: "new-annotation" });

    await importCanvasWith({
      annotations: [
        {
          id: "export-annotation",
          positionX: 0,
          positionY: 0,
          width: 380,
          height: 120,
          manualWidth: null,
          manualHeight: null,
          text: "",
          championIds: [],
          color: "slate",
          fontSize: "md",
          group_id: null,
        },
      ],
    });

    expect(create.mock.calls[0][0]).toEqual(
      expect.objectContaining({ manualWidth: null, manualHeight: null }),
    );
  });

  it("dedupes a repeated export by canvas_id and source_id", async () => {
    const stored = new Map();
    vi.spyOn(CanvasAnnotation, "findOne").mockImplementation(async ({ where }) =>
      stored.get(`${where.canvas_id}:${where.source_id}`) ?? null,
    );
    const create = vi
      .spyOn(CanvasAnnotation, "create")
      .mockImplementation(async (attrs) => {
        stored.set(`${attrs.canvas_id}:${attrs.source_id}`, {
          id: "destination-annotation",
          update: vi.fn().mockResolvedValue(undefined),
        });
        return stored.get(`${attrs.canvas_id}:${attrs.source_id}`);
      });
    const annotation = {
      id: "export-annotation",
      positionX: 0,
      positionY: 0,
      width: 380,
      height: 120,
      text: "same note",
      championIds: [],
      color: "slate",
      fontSize: "md",
      group_id: null,
    };

    expect((await importCanvasWith({ annotations: [annotation] })).status).toBe(200);
    expect((await importCanvasWith({ annotations: [annotation] })).status).toBe(200);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("imports one export into two canvases without reusing its primary key", async () => {
    vi.spyOn(CanvasAnnotation, "findOne").mockResolvedValue(null);
    const create = vi
      .spyOn(CanvasAnnotation, "create")
      .mockResolvedValue({ id: "model-generated-id" });
    const imported = {
      annotations: [
        {
          id: "export-annotation",
          positionX: 0,
          positionY: 0,
          width: 380,
          height: 120,
          text: "portable",
          championIds: [],
          color: "slate",
          fontSize: "md",
          group_id: null,
        },
      ],
    };

    expect((await importCanvasWith(imported, { canvasId: "canvas-a" })).status).toBe(200);
    expect((await importCanvasWith(imported, { canvasId: "canvas-b" })).status).toBe(200);
    expect(create.mock.calls.map(([attrs]) => attrs.canvas_id)).toEqual([
      "canvas-a",
      "canvas-b",
    ]);
    for (const [attrs] of create.mock.calls) {
      expect(attrs.source_id).toBe("export-annotation");
      expect(attrs).not.toHaveProperty("id");
    }
  });

  it("accepts an older export with no annotations key", async () => {
    vi.spyOn(CanvasAnnotation, "findOne").mockResolvedValue(null);
    const create = vi.spyOn(CanvasAnnotation, "create");
    const res = await importCanvasWith({});
    expect(res.status).toBe(200);
    expect(create).not.toHaveBeenCalled();
  });
});
