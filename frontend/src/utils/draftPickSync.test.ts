import { afterEach, describe, expect, it, vi } from "vitest";
import type {
    DraftPickAck,
    DraftPickMutation,
    DraftPickState
} from "@draft-sim/shared-types";
import { createDraftPickSync } from "./draftPickSync";

const state = (version = 0, champion = "Ahri"): DraftPickState => ({
    id: "draft",
    picks: Array.from({ length: 20 }, (_, i) => (i === 10 ? champion : "")),
    picksVersion: version
});
function harness() {
    const sent: { request: DraftPickMutation; reply: (result?: DraftPickAck) => void }[] =
        [];
    const sync = createDraftPickSync({
        send: (request, reply) => {
            sent.push({ request, reply });
        },
        changed: vi.fn()
    });
    sync.setConnected(true);
    return { sync, sent };
}
afterEach(() => vi.useRealTimers());

describe("draft pick delivery", () => {
    it("preserves a dropped edit through reconnect refetch and retries the same request", () => {
        const { sync, sent } = harness();
        sync.edit(state(), [{ index: 10, championId: "Orianna" }]);
        sync.setConnected(false);
        expect(sync.merge(state()).picks[10]).toBe("Orianna");
        sync.setConnected(true);
        expect(sent).toHaveLength(2);
        expect(sent[1].request).toEqual(sent[0].request);
        sent[1].reply({
            ok: true,
            mutationId: sent[1].request.mutationId,
            draft: state(1, "Orianna")
        });
        expect(sync.pendingCount()).toBe(0);
        // A copy snapshot captured before commit must not undo the acknowledged pick.
        expect(sync.merge(state()).picks[10]).toBe("Orianna");
    });

    it("serializes rapid edits and keeps the later choice above the first acknowledgement", () => {
        const { sync, sent } = harness();
        sync.edit(state(), [{ index: 10, championId: "Orianna" }]);
        sync.edit(sync.merge(state()), [{ index: 10, championId: "Syndra" }]);
        expect(sent).toHaveLength(1);
        sent[0].reply({
            ok: true,
            mutationId: sent[0].request.mutationId,
            draft: state(1, "Orianna")
        });
        expect(sent[1].request.baseVersion).toBe(1);
        expect(sync.merge(state(1, "Orianna")).picks[10]).toBe("Syndra");
    });

    it("buffers edits while disconnected without using the socket send buffer", () => {
        const { sync, sent } = harness();
        sync.setConnected(false);
        sync.edit(state(), [{ index: 10, championId: "Orianna" }]);
        expect(sent).toHaveLength(0);
        sync.setConnected(true);
        expect(sent).toHaveLength(1);
    });

    it("keeps retrying bounded, retains unsaved edits, and allows an explicit retry", () => {
        vi.useFakeTimers();
        const { sync, sent } = harness();
        sync.edit(state(), [{ index: 10, championId: "Orianna" }]);
        for (let i = 0; i < 3; i++) {
            sent[i].reply();
            vi.runAllTimers();
        }
        expect(sent).toHaveLength(3);
        expect(sync.error()).toBeTruthy();
        expect(sync.pendingCount()).toBe(1);
        expect(sync.merge(state()).picks[10]).toBe("Orianna");
        sync.retry();
        expect(sent).toHaveLength(4);
        expect(sent[3].request).toEqual(sent[0].request);
        sync.reset();
    });

    it("stops on a conflict and only rebases after the user explicitly retries", () => {
        const { sync, sent } = harness();
        sync.edit(state(), [{ index: 10, championId: "Orianna" }]);
        const remote = state(2, "Syndra");
        remote.picks[15] = "Zed";
        sent[0].reply({
            ok: false,
            mutationId: sent[0].request.mutationId,
            code: "PICK_CONFLICT",
            message: "Draft changed",
            draft: remote
        });
        expect(sent).toHaveLength(1);
        expect(sync.error()).toBe("Draft changed");
        expect(sync.merge(remote).picks[10]).toBe("Orianna");
        sync.retry();
        expect(sent[1].request.baseVersion).toBe(2);
        expect(sent[1].request.changes).toEqual([{ index: 10, championId: "Orianna" }]);
        expect(sent[1].request.mutationId).not.toBe(sent[0].request.mutationId);
        expect(sync.merge(remote).picks[15]).toBe("Zed");
    });

    it("does not resurrect pending edits from a late callback after discard/reset", () => {
        const { sync, sent } = harness();
        sync.edit(state(), [{ index: 10, championId: "Orianna" }]);
        sent[0].reply({
            ok: false,
            mutationId: sent[0].request.mutationId,
            code: "DRAFT_LOCKED",
            message: "Locked"
        });
        sync.discardFailed();
        expect(sync.merge(state()).picks[10]).toBe("Ahri");
        expect(sync.pendingCount()).toBe(0);
        sync.reset();
        sent[0].reply({
            ok: true,
            mutationId: sent[0].request.mutationId,
            draft: state(1, "Orianna")
        });
        expect(sync.merge(state()).picks[10]).toBe("Ahri");
    });

    it("does not let an unrelated draft update replace the active draft's picks", () => {
        const { sync } = harness();
        sync.receive({ ...state(10, "Zed"), id: "another-draft" });
        expect(sync.merge(state()).picks[10]).toBe("Ahri");
    });

    it("does not spend a bounded attempt on a request abandoned by a disconnect", () => {
        const { sync, sent } = harness();
        sync.edit(state(), [{ index: 10, championId: "Orianna" }]);
        for (let i = 0; i < 3; i++) {
            sync.setConnected(false);
            sync.setConnected(true);
        }
        // Four sends, still no error: the connection is live again and the
        // queue must resume on its own rather than demand a manual retry.
        expect(sent).toHaveLength(4);
        expect(sync.error()).toBeUndefined();
        expect(sent[3].request).toEqual(sent[0].request);
    });

    it("returns the same object from merge when nothing would change", () => {
        const { sync } = harness();
        const untouched = state();
        expect(sync.merge(untouched)).toBe(untouched);
        sync.edit(untouched, [{ index: 10, championId: "Orianna" }]);
        expect(sync.merge(untouched)).not.toBe(untouched);
        expect(sync.merge(untouched).picks[10]).toBe("Orianna");
    });
});
