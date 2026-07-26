import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRosterSaver, type SavePayload } from "./rosterSaver";

const payload = (name: string): SavePayload => ({
    players: [{ role: "top", gameName: name, tagLine: "NA1" }]
});

const nameOf = (p: SavePayload): string => p.players[0].gameName;

describe("createRosterSaver", () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    const setup = () => {
        const calls: { teamId: string; payload: SavePayload }[] = [];
        let resolveNext: (() => void) | null = null;
        const saved: string[] = [];
        const errors: Error[] = [];
        const saver = createRosterSaver({
            delayMs: 500,
            save: (teamId, p) => {
                calls.push({ teamId, payload: p });
                return new Promise<void>((resolve) => {
                    resolveNext = resolve;
                });
            },
            onSaved: (teamId) => saved.push(teamId),
            onError: (_teamId, error) => errors.push(error)
        });
        return { saver, calls, saved, errors, settle: () => resolveNext?.() };
    };

    it("does not save before the delay elapses", () => {
        const { saver, calls } = setup();
        saver.request("t1", payload("A"));
        vi.advanceTimersByTime(499);
        expect(calls).toHaveLength(0);
    });

    it("saves once after the delay", () => {
        const { saver, calls } = setup();
        saver.request("t1", payload("A"));
        vi.advanceTimersByTime(500);
        expect(calls).toHaveLength(1);
        expect(nameOf(calls[0].payload)).toBe("A");
    });

    it("coalesces rapid requests into one save carrying the last payload", () => {
        const { saver, calls } = setup();
        saver.request("t1", payload("A"));
        vi.advanceTimersByTime(200);
        saver.request("t1", payload("B"));
        vi.advanceTimersByTime(200);
        saver.request("t1", payload("C"));
        vi.advanceTimersByTime(500);
        expect(calls).toHaveLength(1);
        expect(nameOf(calls[0].payload)).toBe("C");
    });

    // Regression: the endpoint is a destructive whole-roster replace, so two
    // in-flight PUTs could commit out of order and the older lineup would win.
    it("serializes writes to one team instead of overlapping them", async () => {
        const { saver, calls, settle } = setup();
        saver.request("t1", payload("A"));
        vi.advanceTimersByTime(500);
        expect(calls).toHaveLength(1);

        saver.request("t1", payload("B"));
        vi.advanceTimersByTime(500);
        // First is still in flight — the second must not have started.
        expect(calls).toHaveLength(1);

        settle();
        await vi.runAllTimersAsync();
        expect(calls).toHaveLength(2);
        expect(nameOf(calls[1].payload)).toBe("B");
    });

    it("keeps only the newest payload queued behind an in-flight save", async () => {
        const { saver, calls, settle } = setup();
        saver.request("t1", payload("A"));
        vi.advanceTimersByTime(500);
        saver.request("t1", payload("B"));
        vi.advanceTimersByTime(500);
        saver.request("t1", payload("C"));
        vi.advanceTimersByTime(500);
        settle();
        await vi.runAllTimersAsync();
        expect(calls).toHaveLength(2);
        expect(nameOf(calls[1].payload)).toBe("C");
    });

    it("keeps timers independent per team", () => {
        const { saver, calls } = setup();
        saver.request("t1", payload("A"));
        vi.advanceTimersByTime(300);
        saver.request("t2", payload("B"));
        vi.advanceTimersByTime(200);
        expect(calls.map((c) => c.teamId)).toEqual(["t1"]);
        vi.advanceTimersByTime(300);
        expect(calls.map((c) => c.teamId)).toEqual(["t1", "t2"]);
    });

    it("reports success and failure through the callbacks", async () => {
        const calls: string[] = [];
        const saved: string[] = [];
        const errors: Error[] = [];
        const saver = createRosterSaver({
            delayMs: 500,
            save: (teamId) => {
                calls.push(teamId);
                return teamId === "bad"
                    ? Promise.reject(new Error("boom"))
                    : Promise.resolve();
            },
            onSaved: (teamId) => saved.push(teamId),
            onError: (_teamId, error) => errors.push(error)
        });
        saver.request("good", payload("A"));
        saver.request("bad", payload("B"));
        await vi.runAllTimersAsync();
        expect(saved).toEqual(["good"]);
        expect(errors.map((e) => e.message)).toEqual(["boom"]);
    });

    it("dispose cancels a pending debounce", () => {
        const { saver, calls } = setup();
        saver.request("t1", payload("A"));
        saver.dispose();
        vi.advanceTimersByTime(1000);
        expect(calls).toHaveLength(0);
    });

    it("dispose suppresses callbacks from an in-flight save", async () => {
        const { saver, calls, saved, settle } = setup();
        saver.request("t1", payload("A"));
        vi.advanceTimersByTime(500);
        expect(calls).toHaveLength(1);
        saver.dispose();
        settle();
        await vi.runAllTimersAsync();
        expect(saved).toEqual([]);
    });
});
