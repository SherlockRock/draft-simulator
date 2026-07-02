import { describe, it, expect, vi, afterEach } from "vitest";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { setupCanvasHandlers } = require("../../socketHandlers/canvasHandlers");
const {
  NotAuthorizedError,
  DraftLockedError,
} = require("../../services/canvasMutations");

function buildFakeSocket(overrides = {}) {
  const handlers = new Map();
  const socket = {
    id: overrides.id || "sock-1",
    user:
      "user" in overrides ? overrides.user : { dataValues: { id: "user-1" } },
    emit: vi.fn(),
    on: vi.fn((event, fn) => {
      handlers.set(event, fn);
    }),
  };
  return { socket, handlers };
}

function buildFakeGate() {
  return {
    applyDraftPicks: vi.fn().mockResolvedValue(undefined),
    relayObjectMove: vi.fn().mockResolvedValue(undefined),
    relayVertexMove: vi.fn().mockResolvedValue(undefined),
    relayGroupMove: vi.fn().mockResolvedValue(undefined),
    relayGroupResize: vi.fn().mockResolvedValue(undefined),
  };
}

function wrapSocketHandler(socket, eventName, handler) {
  socket.on(eventName, handler);
}

function installHandlers(overrides = {}) {
  const { socket, handlers } = buildFakeSocket(overrides);
  const gate = buildFakeGate();
  setupCanvasHandlers(socket, gate, wrapSocketHandler);
  return { socket, handlers, gate };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("setupCanvasHandlers", () => {
  it("registers the five canvas mutation events", () => {
    const { handlers } = installHandlers();
    expect([...handlers.keys()].sort()).toEqual([
      "canvasObjectMove",
      "groupMove",
      "groupResize",
      "newDraft",
      "vertexMove",
    ]);
  });

  it("newDraft calls applyDraftPicks with the socket actor and mapped payload", async () => {
    const { handlers, gate } = installHandlers();
    const picks = Array(20).fill("");

    await handlers.get("newDraft")({ id: "d-1", picks });

    expect(gate.applyDraftPicks).toHaveBeenCalledWith({
      actor: { userId: "user-1", socketId: "sock-1" },
      draftId: "d-1",
      picks,
    });
  });

  it("an anonymous socket produces a null-userId actor", async () => {
    const { handlers, gate } = installHandlers({ user: undefined });

    await handlers.get("newDraft")({ id: "d-1", picks: Array(20).fill("") });

    expect(gate.applyDraftPicks).toHaveBeenCalledWith(
      expect.objectContaining({
        actor: { userId: null, socketId: "sock-1" },
      }),
    );
  });

  it("translates gate errors into a canvasMutationError event", async () => {
    const { socket, handlers, gate } = installHandlers();
    gate.applyDraftPicks.mockRejectedValue(new DraftLockedError());

    await handlers.get("newDraft")({ id: "d-1", picks: Array(20).fill("") });

    expect(socket.emit).toHaveBeenCalledWith("canvasMutationError", {
      event: "newDraft",
      code: "DRAFT_LOCKED",
      message: "Draft is locked",
    });
  });

  it("relay errors are reported with their own event name", async () => {
    const { socket, handlers, gate } = installHandlers();
    gate.relayGroupMove.mockRejectedValue(new NotAuthorizedError());

    await handlers.get("groupMove")({
      canvasId: "c-1",
      groupId: "g-1",
      positionX: 0,
      positionY: 0,
    });

    expect(socket.emit).toHaveBeenCalledWith("canvasMutationError", {
      event: "groupMove",
      code: "NOT_AUTHORIZED",
      message: "Not authorized",
    });
  });

  it("unexpected errors are logged, not emitted", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { socket, handlers, gate } = installHandlers();
    gate.applyDraftPicks.mockRejectedValue(new Error("db exploded"));

    await handlers.get("newDraft")({ id: "d-1", picks: Array(20).fill("") });

    expect(socket.emit).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalled();
  });

  it("groupResize maps the full resize payload onto the gate call", async () => {
    const { handlers, gate } = installHandlers();

    await handlers.get("groupResize")({
      canvasId: "c-1",
      groupId: "g-1",
      width: 100,
      height: 200,
      positionX: 3,
    });

    expect(gate.relayGroupResize).toHaveBeenCalledWith({
      actor: { userId: "user-1", socketId: "sock-1" },
      canvasId: "c-1",
      groupId: "g-1",
      width: 100,
      height: 200,
      positionX: 3,
    });
  });
});
