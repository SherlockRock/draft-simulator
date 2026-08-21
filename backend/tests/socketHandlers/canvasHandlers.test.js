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
    relayAnnotationMove: vi.fn().mockResolvedValue(undefined),
    relayAnnotationResize: vi.fn().mockResolvedValue(undefined),
    relayVertexMove: vi.fn().mockResolvedValue(undefined),
    relayGroupMove: vi.fn().mockResolvedValue(undefined),
    relayGroupResize: vi.fn().mockResolvedValue(undefined),
    applyPoolAddChampion: vi.fn().mockResolvedValue(undefined),
    applyPoolRemoveChampion: vi.fn().mockResolvedValue(undefined),
    applyPoolReorderRole: vi.fn().mockResolvedValue(undefined),
    applyPoolReplace: vi.fn().mockResolvedValue(undefined),
    relayPoolMove: vi.fn().mockResolvedValue(undefined),
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
  it("registers the twelve canvas mutation events", () => {
    const { handlers } = installHandlers();
    expect([...handlers.keys()].sort()).toEqual([
      "annotationMove",
      "annotationResize",
      "canvasObjectMove",
      "groupMove",
      "groupResize",
      "newDraft",
      "poolAddChampion",
      "poolMove",
      "poolRemoveChampion",
      "poolReorderRole",
      "poolReplace",
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

  it("annotationMove maps the payload onto the gate call", async () => {
    const { handlers, gate } = installHandlers();

    await handlers.get("annotationMove")({
      canvasId: "c-1",
      annotationId: "a-1",
      positionX: 5,
      positionY: 6,
    });

    expect(gate.relayAnnotationMove).toHaveBeenCalledWith({
      actor: { userId: "user-1", socketId: "sock-1" },
      canvasId: "c-1",
      annotationId: "a-1",
      positionX: 5,
      positionY: 6,
    });
  });

  it("maps an annotationMove gate rejection to canvasMutationError", async () => {
    const { socket, handlers, gate } = installHandlers();
    gate.relayAnnotationMove.mockRejectedValue(new NotAuthorizedError());

    await handlers.get("annotationMove")({
      canvasId: "c-1",
      annotationId: "a-1",
      positionX: 5,
      positionY: 6,
    });

    expect(socket.emit).toHaveBeenCalledWith("canvasMutationError", {
      event: "annotationMove",
      code: "NOT_AUTHORIZED",
      message: "Not authorized",
    });
  });

  it("annotationResize maps the payload onto the gate call", async () => {
    const { handlers, gate } = installHandlers();

    await handlers.get("annotationResize")({
      canvasId: "c-1",
      annotationId: "a-1",
      positionX: 16,
      width: 700,
      height: 384,
    });

    expect(gate.relayAnnotationResize).toHaveBeenCalledWith({
      actor: { userId: "user-1", socketId: "sock-1" },
      canvasId: "c-1",
      annotationId: "a-1",
      positionX: 16,
      width: 700,
      height: 384,
    });
  });

  it("maps an annotationResize gate rejection to canvasMutationError", async () => {
    const { socket, handlers, gate } = installHandlers();
    gate.relayAnnotationResize.mockRejectedValue(new NotAuthorizedError());

    await handlers.get("annotationResize")({
      canvasId: "c-1",
      annotationId: "a-1",
      positionX: 16,
      width: 700,
      height: 384,
    });

    expect(socket.emit).toHaveBeenCalledWith("canvasMutationError", {
      event: "annotationResize",
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

  it("poolAddChampion maps the payload onto applyPoolAddChampion", async () => {
    const { handlers, gate } = installHandlers();

    await handlers.get("poolAddChampion")({
      canvasId: "c-1",
      placementId: "pl-1",
      role: "top",
      championId: "Ahri",
    });

    expect(gate.applyPoolAddChampion).toHaveBeenCalledWith({
      actor: { userId: "user-1", socketId: "sock-1" },
      canvasId: "c-1",
      placementId: "pl-1",
      role: "top",
      championId: "Ahri",
    });
  });

  it("maps a poolAddChampion gate rejection to canvasMutationError", async () => {
    const { socket, handlers, gate } = installHandlers();
    gate.applyPoolAddChampion.mockRejectedValue(new NotAuthorizedError());

    await handlers.get("poolAddChampion")({
      canvasId: "c-1",
      placementId: "pl-1",
      role: "top",
      championId: "Ahri",
    });

    expect(socket.emit).toHaveBeenCalledWith("canvasMutationError", {
      event: "poolAddChampion",
      code: "NOT_AUTHORIZED",
      message: "Not authorized",
    });
  });

  it("poolRemoveChampion maps the payload onto applyPoolRemoveChampion", async () => {
    const { handlers, gate } = installHandlers();

    await handlers.get("poolRemoveChampion")({
      canvasId: "c-1",
      placementId: "pl-1",
      role: "jungle",
      championId: "LeeSin",
    });

    expect(gate.applyPoolRemoveChampion).toHaveBeenCalledWith({
      actor: { userId: "user-1", socketId: "sock-1" },
      canvasId: "c-1",
      placementId: "pl-1",
      role: "jungle",
      championId: "LeeSin",
    });
  });

  it("maps a poolRemoveChampion gate rejection to canvasMutationError", async () => {
    const { socket, handlers, gate } = installHandlers();
    gate.applyPoolRemoveChampion.mockRejectedValue(new NotAuthorizedError());

    await handlers.get("poolRemoveChampion")({
      canvasId: "c-1",
      placementId: "pl-1",
      role: "jungle",
      championId: "LeeSin",
    });

    expect(socket.emit).toHaveBeenCalledWith("canvasMutationError", {
      event: "poolRemoveChampion",
      code: "NOT_AUTHORIZED",
      message: "Not authorized",
    });
  });

  it("poolReorderRole maps the payload onto applyPoolReorderRole", async () => {
    const { handlers, gate } = installHandlers();

    await handlers.get("poolReorderRole")({
      canvasId: "c-1",
      placementId: "pl-1",
      role: "top",
      championIds: ["Sett", "Ahri"],
    });

    expect(gate.applyPoolReorderRole).toHaveBeenCalledWith({
      actor: { userId: "user-1", socketId: "sock-1" },
      canvasId: "c-1",
      placementId: "pl-1",
      role: "top",
      championIds: ["Sett", "Ahri"],
    });
  });

  it("maps a poolReorderRole gate rejection to canvasMutationError", async () => {
    const { socket, handlers, gate } = installHandlers();
    gate.applyPoolReorderRole.mockRejectedValue(new NotAuthorizedError());

    await handlers.get("poolReorderRole")({
      canvasId: "c-1",
      placementId: "pl-1",
      role: "top",
      championIds: [],
    });

    expect(socket.emit).toHaveBeenCalledWith("canvasMutationError", {
      event: "poolReorderRole",
      code: "NOT_AUTHORIZED",
      message: "Not authorized",
    });
  });

  it("poolReplace maps the payload onto applyPoolReplace", async () => {
    const { handlers, gate } = installHandlers();
    const champions = {
      top: [],
      jungle: [],
      mid: [],
      adc: [],
      support: ["Braum"],
    };

    await handlers.get("poolReplace")({
      canvasId: "c-1",
      placementId: "pl-1",
      champions,
    });

    expect(gate.applyPoolReplace).toHaveBeenCalledWith({
      actor: { userId: "user-1", socketId: "sock-1" },
      canvasId: "c-1",
      placementId: "pl-1",
      champions,
    });
  });

  it("maps a poolReplace gate rejection to canvasMutationError", async () => {
    const { socket, handlers, gate } = installHandlers();
    gate.applyPoolReplace.mockRejectedValue(new NotAuthorizedError());

    await handlers.get("poolReplace")({
      canvasId: "c-1",
      placementId: "pl-1",
      champions: {},
    });

    expect(socket.emit).toHaveBeenCalledWith("canvasMutationError", {
      event: "poolReplace",
      code: "NOT_AUTHORIZED",
      message: "Not authorized",
    });
  });

  it("poolMove maps the payload onto relayPoolMove", async () => {
    const { handlers, gate } = installHandlers();

    await handlers.get("poolMove")({
      canvasId: "c-1",
      placementId: "pl-1",
      positionX: 5,
      positionY: 9,
    });

    expect(gate.relayPoolMove).toHaveBeenCalledWith({
      actor: { userId: "user-1", socketId: "sock-1" },
      canvasId: "c-1",
      placementId: "pl-1",
      positionX: 5,
      positionY: 9,
    });
  });

  it("maps a poolMove gate rejection to canvasMutationError", async () => {
    const { socket, handlers, gate } = installHandlers();
    gate.relayPoolMove.mockRejectedValue(new NotAuthorizedError());

    await handlers.get("poolMove")({
      canvasId: "c-1",
      placementId: "pl-1",
      positionX: 5,
      positionY: 9,
    });

    expect(socket.emit).toHaveBeenCalledWith("canvasMutationError", {
      event: "poolMove",
      code: "NOT_AUTHORIZED",
      message: "Not authorized",
    });
  });
});
