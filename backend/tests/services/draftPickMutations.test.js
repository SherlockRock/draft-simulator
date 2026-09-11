import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const Draft = require("../../models/Draft");
const { CanvasDraft, UserCanvas, CanvasGroup } = require("../../models/Canvas");
const sequelize = require("../../config/database");
const { createCanvasMutationGate } = require("../../services/canvasMutations");

const id = "7ebb27f4-2a62-478e-91d0-b056de9ba936";
const mutationId = "dbd529ed-22b0-4b87-8f60-a5bb8d4bce74";
const actor = { userId: "owner", socketId: "socket" };
let row, emit, gate, transaction, committed;
const request = (overrides = {}) => ({
  actor,
  id,
  mutationId,
  baseVersion: 0,
  changes: [{ index: 10, championId: "Orianna" }],
  ...overrides,
});

beforeEach(() => {
  committed = false;
  transaction = { LOCK: { UPDATE: "UPDATE" } };
  vi.spyOn(sequelize, "transaction").mockImplementation(async (run) => {
    const result = await run(transaction);
    committed = true;
    return result;
  });
  row = {
    id,
    picks: Array(20).fill(""),
    picksVersion: 0,
    lastPickMutationId: null,
    owner_id: "owner",
    save: vi.fn().mockResolvedValue(undefined),
  };
  row.picks[10] = "Ahri";
  vi.spyOn(Draft, "findByPk").mockResolvedValue(row);
  vi.spyOn(CanvasDraft, "findAll").mockResolvedValue([
    { canvas_id: "canvas", is_locked: false, group_id: null },
  ]);
  vi.spyOn(UserCanvas, "findAll").mockResolvedValue([{ permissions: "edit" }]);
  emit = vi.fn(() => expect(committed).toBe(true));
  gate = createCanvasMutationGate({ io: { to: vi.fn(() => ({ emit })) } });
});
afterEach(() => vi.restoreAllMocks());

describe("acknowledged draft pick mutations", () => {
  it("locks the specific draft, saves a slot edit, and broadcasts only after commit", async () => {
    row.picks[15] = "Zed";
    const result = await gate.applyDraftPickMutation(request());
    expect(Draft.findByPk).toHaveBeenCalledWith(
      id,
      expect.objectContaining({ transaction, lock: "UPDATE" }),
    );
    expect(result).toMatchObject({ id, picksVersion: 1 });
    expect(result.picks[10]).toBe("Orianna");
    expect(result.picks[15]).toBe("Zed");
    expect(row.save).toHaveBeenCalledWith({ transaction });
    expect(row.lastPickMutationId).toBe(mutationId);
    expect(emit).toHaveBeenCalledWith("draftUpdate", result, id);
  });

  it("acknowledges a retry after a lost acknowledgement without saving twice", async () => {
    await gate.applyDraftPickMutation(request());
    await expect(gate.applyDraftPickMutation(request())).resolves.toMatchObject(
      { picksVersion: 1 },
    );
    expect(row.save).toHaveBeenCalledTimes(1);
  });

  it("rejects an old retry after another editor's mutation instead of overwriting it", async () => {
    row.picksVersion = 2;
    row.lastPickMutationId = "699021e2-6e94-4aab-a02e-73fe7b20ad8a";
    row.picks[10] = "Syndra";
    await expect(gate.applyDraftPickMutation(request())).rejects.toMatchObject({
      code: "PICK_CONFLICT",
      draft: { id, picksVersion: 2 },
    });
    expect(row.picks[10]).toBe("Syndra");
    expect(row.save).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
  });

  it("still checks current permissions for a duplicate mutation", async () => {
    row.lastPickMutationId = mutationId;
    UserCanvas.findAll.mockResolvedValue([{ permissions: "view" }]);
    await expect(gate.applyDraftPickMutation(request())).rejects.toMatchObject({
      code: "NOT_AUTHORIZED",
    });
    expect(row.save).not.toHaveBeenCalled();
  });

  it("rejects locked drafts", async () => {
    CanvasDraft.findAll.mockResolvedValue([
      { canvas_id: "canvas", is_locked: true },
    ]);
    await expect(gate.applyDraftPickMutation(request())).rejects.toMatchObject({
      code: "DRAFT_LOCKED",
    });
  });

  it("uses the existing group champion restrictions", async () => {
    CanvasDraft.findAll.mockResolvedValue([
      { canvas_id: "canvas", group_id: "group" },
    ]);
    vi.spyOn(CanvasGroup, "findByPk").mockResolvedValue({
      type: "custom",
      metadata: { disabledChampions: ["Orianna"] },
    });
    await expect(gate.applyDraftPickMutation(request())).rejects.toMatchObject({
      code: "CHAMPION_RESTRICTED",
    });
    expect(row.save).not.toHaveBeenCalled();
  });

  it("runs group restriction queries on the transaction that holds the row lock", async () => {
    CanvasDraft.findAll
      .mockResolvedValueOnce([{ canvas_id: "canvas", group_id: "group" }])
      .mockResolvedValueOnce([]);
    vi.spyOn(CanvasGroup, "findByPk").mockResolvedValue({
      type: "custom",
      metadata: { draftMode: "fearless" },
    });
    await gate.applyDraftPickMutation(request());
    expect(CanvasGroup.findByPk).toHaveBeenCalledWith(
      "group",
      expect.objectContaining({ transaction }),
    );
    // The restriction check's own read of the current picks and the sibling
    // scan must both ride the same connection, never a second pool slot.
    expect(Draft.findByPk).toHaveBeenLastCalledWith(
      id,
      expect.objectContaining({ attributes: ["picks"], transaction }),
    );
    expect(CanvasDraft.findAll).toHaveBeenLastCalledWith(
      expect.objectContaining({ where: { group_id: "group" }, transaction }),
    );
    expect(row.save).toHaveBeenCalledTimes(1);
  });

  it("normalises a row that does not hold exactly 20 slots before saving and acknowledging", async () => {
    row.picks = ["", "", "Zed"];
    const result = await gate.applyDraftPickMutation(request());
    expect(result.picks).toHaveLength(20);
    expect(result.picks[2]).toBe("Zed");
    expect(result.picks[10]).toBe("Orianna");
    expect(result.picks.every((pick) => typeof pick === "string")).toBe(true);
    expect(row.picks).toHaveLength(20);
    row.picks = null;
    row.lastPickMutationId = mutationId;
    expect((await gate.applyDraftPickMutation(request())).picks).toEqual(
      Array(20).fill(""),
    );
  });

  it("validates slot indices before accessing the database", async () => {
    await expect(
      gate.applyDraftPickMutation(
        request({ changes: [{ index: 20, championId: "Ahri" }] }),
      ),
    ).rejects.toMatchObject({ code: "INVALID_MUTATION" });
    expect(Draft.findByPk).not.toHaveBeenCalled();
  });

  it("does not broadcast or acknowledge success when commit fails", async () => {
    sequelize.transaction.mockRejectedValue(new Error("commit failed"));
    await expect(gate.applyDraftPickMutation(request())).rejects.toThrow(
      "commit failed",
    );
    expect(emit).not.toHaveBeenCalled();
  });
});
