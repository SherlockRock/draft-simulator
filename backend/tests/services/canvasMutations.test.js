import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createRequire } from "node:module";

// Load CJS modules via Node's resolver so we can spy on the models the gate
// captured at require-time (same pattern as navigatorHandlers.test.js).
const require = createRequire(import.meta.url);
const Draft = require("../../models/Draft");
const { UserCanvas, CanvasDraft, CanvasGroup } = require("../../models/Canvas");
const {
  createCanvasMutationGate,
  CanvasMutationError,
  NotAuthenticatedError,
  NotAuthorizedError,
  DraftLockedError,
  ChampionRestrictedError,
  InvalidMutationError,
} = require("../../services/canvasMutations");

function buildIo() {
  const emit = vi.fn();
  const exceptEmit = vi.fn();
  const except = vi.fn().mockReturnValue({ emit: exceptEmit });
  const to = vi.fn().mockReturnValue({ emit, except });
  return { io: { to }, to, emit, except, exceptEmit };
}

function buildGate() {
  const fake = buildIo();
  const gate = createCanvasMutationGate({ io: fake.io });
  return { gate, ...fake };
}

const ACTOR = { userId: "user-1", socketId: "sock-1" };
const ANON = { userId: null, socketId: "sock-anon" };

function emptyPicks() {
  return Array(20).fill("");
}

function picksWith(entries) {
  const picks = emptyPicks();
  for (const [index, champ] of Object.entries(entries)) {
    picks[Number(index)] = champ;
  }
  return picks;
}

// UserCanvas responses keyed by canvas_id (findOne for single-canvas access,
// findAll for the any-canvas IN-clause lookup).
function mockPermissions(byCanvasId) {
  vi.spyOn(UserCanvas, "findOne").mockImplementation(async ({ where }) => {
    const permissions = byCanvasId[where.canvas_id];
    return permissions ? { permissions } : null;
  });
  vi.spyOn(UserCanvas, "findAll").mockImplementation(async ({ where }) => {
    const ids = Array.isArray(where.canvas_id)
      ? where.canvas_id
      : [where.canvas_id];
    return ids
      .filter((id) => byCanvasId[id])
      .map((id) => ({ canvas_id: id, permissions: byCanvasId[id] }));
  });
}

// CanvasDraft.findAll is called once with where.draft_id (containing
// canvases) and, on the restriction path, again with where.group_id
// (sibling drafts, Draft included).
function mockCanvasDrafts(containing, siblings = []) {
  vi.spyOn(CanvasDraft, "findAll").mockImplementation(async ({ where }) => {
    if (where && where.draft_id) return containing;
    return siblings;
  });
}

beforeEach(() => {
  vi.spyOn(Draft, "update").mockResolvedValue([1]);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("applyDraftPicks — payload validation", () => {
  it("throws InvalidMutation when picks is not a 20-slot array", async () => {
    const { gate } = buildGate();
    await expect(
      gate.applyDraftPicks({ actor: ACTOR, draftId: "d-1", picks: ["Ahri"] }),
    ).rejects.toThrow(InvalidMutationError);
  });

  it("throws InvalidMutation when draftId is missing", async () => {
    const { gate } = buildGate();
    await expect(
      gate.applyDraftPicks({ actor: ACTOR, picks: emptyPicks() }),
    ).rejects.toThrow(InvalidMutationError);
  });
});

describe("applyDraftPicks — canvas draft authorization", () => {
  // Unauthenticated is distinct from forbidden so the REST adapter (slice 2+)
  // can map NOT_AUTHENTICATED -> 401 and NOT_AUTHORIZED -> 403.
  it("rejects an anonymous actor with NotAuthenticated", async () => {
    mockCanvasDrafts([{ canvas_id: "c-1", is_locked: false, group_id: null }]);
    const { gate } = buildGate();
    const err = await gate
      .applyDraftPicks({ actor: ANON, draftId: "d-1", picks: emptyPicks() })
      .then(
        () => null,
        (e) => e,
      );
    expect(err).toBeInstanceOf(NotAuthenticatedError);
    expect(err.code).toBe("NOT_AUTHENTICATED");
  });

  it("rejects an actor with only view permission", async () => {
    mockCanvasDrafts([{ canvas_id: "c-1", is_locked: false, group_id: null }]);
    mockPermissions({ "c-1": "view" });
    const { gate } = buildGate();
    await expect(
      gate.applyDraftPicks({ actor: ACTOR, draftId: "d-1", picks: emptyPicks() }),
    ).rejects.toThrow(NotAuthorizedError);
  });

  // Documents the kept any-canvas quirk: edit/admin on ANY canvas containing
  // the draft grants pick permission. Benign today because cross-canvas
  // shared drafts are only versus-linked (read-only) — revisit if that changes.
  it("any-canvas quirk: edit on one of several containing canvases suffices", async () => {
    mockCanvasDrafts([
      { canvas_id: "c-1", is_locked: false, group_id: null },
      { canvas_id: "c-2", is_locked: false, group_id: null },
    ]);
    mockPermissions({ "c-1": "view", "c-2": "edit" });
    const { gate } = buildGate();
    await expect(
      gate.applyDraftPicks({ actor: ACTOR, draftId: "d-1", picks: emptyPicks() }),
    ).resolves.toBeUndefined();
    expect(Draft.update).toHaveBeenCalled();
  });

  // The lock side of the quirk: a lock on ANY containing canvas blocks all.
  it("any-canvas quirk: lock on any containing canvas throws DraftLocked", async () => {
    mockCanvasDrafts([
      { canvas_id: "c-1", is_locked: true, group_id: null },
      { canvas_id: "c-2", is_locked: false, group_id: null },
    ]);
    mockPermissions({ "c-1": "edit", "c-2": "edit" });
    const { gate } = buildGate();
    await expect(
      gate.applyDraftPicks({ actor: ACTOR, draftId: "d-1", picks: emptyPicks() }),
    ).rejects.toThrow(DraftLockedError);
    expect(Draft.update).not.toHaveBeenCalled();
  });
});

describe("applyDraftPicks — non-canvas draft authorization", () => {
  it("allows the draft owner", async () => {
    mockCanvasDrafts([]);
    vi.spyOn(Draft, "findByPk").mockResolvedValue({ owner_id: "user-1" });
    const { gate } = buildGate();
    await expect(
      gate.applyDraftPicks({ actor: ACTOR, draftId: "d-1", picks: emptyPicks() }),
    ).resolves.toBeUndefined();
    expect(Draft.update).toHaveBeenCalled();
  });

  it("rejects a non-owner with NotAuthorized", async () => {
    mockCanvasDrafts([]);
    vi.spyOn(Draft, "findByPk").mockResolvedValue({ owner_id: "someone-else" });
    const { gate } = buildGate();
    await expect(
      gate.applyDraftPicks({ actor: ACTOR, draftId: "d-1", picks: emptyPicks() }),
    ).rejects.toThrow(NotAuthorizedError);
  });

  it("rejects when the draft does not exist", async () => {
    mockCanvasDrafts([]);
    vi.spyOn(Draft, "findByPk").mockResolvedValue(null);
    const { gate } = buildGate();
    await expect(
      gate.applyDraftPicks({ actor: ACTOR, draftId: "d-1", picks: emptyPicks() }),
    ).rejects.toThrow(NotAuthorizedError);
  });
});

describe("applyDraftPicks — group restrictions", () => {
  function mockGroup(group) {
    vi.spyOn(CanvasGroup, "findByPk").mockResolvedValue(group);
  }

  function sibling(id, picks, seriesIndex = 0) {
    return { Draft: { id, picks, seriesIndex } };
  }

  function setupGroupDraft({ group, siblings, currentPicks = emptyPicks() }) {
    mockCanvasDrafts(
      [{ canvas_id: "c-1", is_locked: false, group_id: "g-1" }],
      siblings,
    );
    mockPermissions({ "c-1": "edit" });
    mockGroup(group);
    vi.spyOn(Draft, "findByPk").mockResolvedValue({ picks: currentPicks });
  }

  it("rejects a newly placed disabled champion with ChampionRestricted", async () => {
    setupGroupDraft({
      group: { type: "custom", metadata: { disabledChampions: ["Ahri"] } },
      siblings: [],
    });
    const { gate } = buildGate();
    await expect(
      gate.applyDraftPicks({
        actor: ACTOR,
        draftId: "d-1",
        picks: picksWith({ 10: "Ahri" }),
      }),
    ).rejects.toThrow(ChampionRestrictedError);
    expect(Draft.update).not.toHaveBeenCalled();
  });

  it("allows saving when a disabled champion was already present (changed-index detection)", async () => {
    setupGroupDraft({
      group: { type: "custom", metadata: { disabledChampions: ["Ahri"] } },
      siblings: [],
      currentPicks: picksWith({ 10: "Ahri" }),
    });
    const { gate } = buildGate();
    await expect(
      gate.applyDraftPicks({
        actor: ACTOR,
        draftId: "d-1",
        picks: picksWith({ 10: "Ahri", 11: "Zed" }),
      }),
    ).resolves.toBeUndefined();
    expect(Draft.update).toHaveBeenCalled();
  });

  it("fearless (custom group): champion picked elsewhere is rejected in a pick slot", async () => {
    setupGroupDraft({
      group: { type: "custom", metadata: { draftMode: "fearless" } },
      siblings: [sibling("d-2", picksWith({ 10: "Ahri" }))],
    });
    const { gate } = buildGate();
    await expect(
      gate.applyDraftPicks({
        actor: ACTOR,
        draftId: "d-1",
        picks: picksWith({ 15: "Ahri" }),
      }),
    ).rejects.toThrow(ChampionRestrictedError);
  });

  it("fearless (custom group): restricted champion is still allowed as a ban (index < 10)", async () => {
    setupGroupDraft({
      group: { type: "custom", metadata: { draftMode: "fearless" } },
      siblings: [sibling("d-2", picksWith({ 10: "Ahri" }))],
    });
    const { gate } = buildGate();
    await expect(
      gate.applyDraftPicks({
        actor: ACTOR,
        draftId: "d-1",
        picks: picksWith({ 0: "Ahri" }),
      }),
    ).resolves.toBeUndefined();
  });

  it("ironman (custom group): restricted champion is rejected even in ban slots", async () => {
    setupGroupDraft({
      group: { type: "custom", metadata: { draftMode: "ironman" } },
      siblings: [sibling("d-2", picksWith({ 0: "Ahri" }))],
    });
    const { gate } = buildGate();
    await expect(
      gate.applyDraftPicks({
        actor: ACTOR,
        draftId: "d-1",
        picks: picksWith({ 3: "Ahri" }),
      }),
    ).rejects.toThrow(ChampionRestrictedError);
  });

  it("series group: mode comes from metadata.seriesType and only earlier games restrict", async () => {
    setupGroupDraft({
      group: { type: "series", metadata: { seriesType: "fearless" } },
      siblings: [
        sibling("d-1", emptyPicks(), 1),
        sibling("d-0", picksWith({ 10: "Ahri" }), 0),
        sibling("d-2", picksWith({ 10: "Zed" }), 2),
      ],
    });
    const { gate } = buildGate();
    // "Ahri" comes from game 1 (earlier) — restricted.
    await expect(
      gate.applyDraftPicks({
        actor: ACTOR,
        draftId: "d-1",
        picks: picksWith({ 15: "Ahri" }),
      }),
    ).rejects.toThrow(ChampionRestrictedError);
    // "Zed" comes from game 3 (later) — editing game 2 is not blocked by it.
    await expect(
      gate.applyDraftPicks({
        actor: ACTOR,
        draftId: "d-1",
        picks: picksWith({ 15: "Zed" }),
      }),
    ).resolves.toBeUndefined();
  });
});

describe("applyDraftPicks — persistence and broadcast", () => {
  it("persists picks and broadcasts draftUpdate to the draft room and every canvas room", async () => {
    mockCanvasDrafts([
      { canvas_id: "c-1", is_locked: false, group_id: null },
      { canvas_id: "c-2", is_locked: false, group_id: null },
    ]);
    mockPermissions({ "c-1": "edit", "c-2": "view" });
    const { gate, to, emit } = buildGate();
    const picks = picksWith({ 10: "Ahri" });

    await gate.applyDraftPicks({ actor: ACTOR, draftId: "d-1", picks });

    expect(Draft.update).toHaveBeenCalledWith(
      { picks },
      { where: { id: "d-1" } },
    );
    expect(to).toHaveBeenCalledWith("d-1");
    expect(to).toHaveBeenCalledWith("c-1");
    expect(to).toHaveBeenCalledWith("c-2");
    expect(emit).toHaveBeenCalledWith("draftUpdate", { id: "d-1", picks }, "d-1");
  });
});

describe("ephemeral relays — authorize → broadcast only", () => {
  it("relayObjectMove broadcasts to the whole canvas room, sender included", async () => {
    mockPermissions({ "c-1": "edit" });
    const { gate, to, emit, except } = buildGate();

    await gate.relayObjectMove({
      actor: ACTOR,
      canvasId: "c-1",
      draftId: "d-1",
      positionX: 10,
      positionY: 20,
    });

    expect(to).toHaveBeenCalledWith("c-1");
    expect(emit).toHaveBeenCalledWith(
      "canvasObjectMoved",
      { draftId: "d-1", positionX: 10, positionY: 20 },
      "c-1",
    );
    expect(except).not.toHaveBeenCalled();
  });

  it("relayObjectMove rejects an anonymous actor without emitting", async () => {
    const { gate, emit, exceptEmit } = buildGate();
    await expect(
      gate.relayObjectMove({
        actor: ANON,
        canvasId: "c-1",
        draftId: "d-1",
        positionX: 0,
        positionY: 0,
      }),
    ).rejects.toThrow(NotAuthenticatedError);
    expect(emit).not.toHaveBeenCalled();
    expect(exceptEmit).not.toHaveBeenCalled();
  });

  it("relayObjectMove rejects a view-only actor", async () => {
    mockPermissions({ "c-1": "view" });
    const { gate } = buildGate();
    await expect(
      gate.relayObjectMove({
        actor: ACTOR,
        canvasId: "c-1",
        draftId: "d-1",
        positionX: 0,
        positionY: 0,
      }),
    ).rejects.toThrow(NotAuthorizedError);
  });

  it("relayVertexMove broadcasts vertexMoved to the canvas room", async () => {
    mockPermissions({ "c-1": "edit" });
    const { gate, to, emit } = buildGate();

    await gate.relayVertexMove({
      actor: ACTOR,
      canvasId: "c-1",
      connectionId: "conn-1",
      vertexId: "v-1",
      x: 5,
      y: 6,
    });

    expect(to).toHaveBeenCalledWith("c-1");
    expect(emit).toHaveBeenCalledWith("vertexMoved", {
      connectionId: "conn-1",
      vertexId: "v-1",
      x: 5,
      y: 6,
    });
  });

  it("relayGroupMove excludes the sender's socket from the broadcast", async () => {
    mockPermissions({ "c-1": "edit" });
    const { gate, to, emit, except, exceptEmit } = buildGate();

    await gate.relayGroupMove({
      actor: ACTOR,
      canvasId: "c-1",
      groupId: "g-1",
      positionX: 1,
      positionY: 2,
    });

    expect(to).toHaveBeenCalledWith("c-1");
    expect(except).toHaveBeenCalledWith("sock-1");
    expect(exceptEmit).toHaveBeenCalledWith("groupMoved", {
      groupId: "g-1",
      positionX: 1,
      positionY: 2,
    });
    expect(emit).not.toHaveBeenCalled();
  });

  it("relayGroupResize excludes the sender's socket from the broadcast", async () => {
    mockPermissions({ "c-1": "edit" });
    const { gate, except, exceptEmit } = buildGate();

    await gate.relayGroupResize({
      actor: ACTOR,
      canvasId: "c-1",
      groupId: "g-1",
      width: 100,
      height: 200,
      positionX: 3,
    });

    expect(except).toHaveBeenCalledWith("sock-1");
    expect(exceptEmit).toHaveBeenCalledWith("groupResized", {
      groupId: "g-1",
      width: 100,
      height: 200,
      positionX: 3,
    });
  });
});

describe("assertCanvasAccess — required level", () => {
  it("admin level rejects an actor with only edit permission", async () => {
    mockPermissions({ "c-1": "edit" });
    const { gate } = buildGate();
    await expect(
      gate.assertCanvasAccess({ userId: "user-1", canvasId: "c-1", level: "admin" }),
    ).rejects.toThrow(NotAuthorizedError);
  });

  it("edit level accepts an admin actor", async () => {
    mockPermissions({ "c-1": "admin" });
    const { gate } = buildGate();
    await expect(
      gate.assertCanvasAccess({ userId: "user-1", canvasId: "c-1", level: "edit" }),
    ).resolves.toBeUndefined();
  });

  it("typed errors are CanvasMutationError instances with stable codes", async () => {
    mockPermissions({});
    const { gate } = buildGate();
    const err = await gate
      .assertCanvasAccess({ userId: "user-1", canvasId: "c-1", level: "edit" })
      .then(
        () => null,
        (e) => e,
      );
    expect(err).toBeInstanceOf(CanvasMutationError);
    expect(err).toBeInstanceOf(NotAuthorizedError);
    expect(err.code).toBe("NOT_AUTHORIZED");
  });
});
