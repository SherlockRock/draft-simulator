import { describe, it, expect, vi } from "vitest";
import { createLatestWins } from "./latestWins";

function deferred() {
    let resolve!: () => void;
    let reject!: (e: Error) => void;
    const promise = new Promise<void>((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

describe("createLatestWins", () => {
    it("runs the first value immediately", () => {
        const run = vi.fn(() => Promise.resolve());
        const flight = createLatestWins<number>(run);
        flight.send(1);
        expect(run).toHaveBeenCalledWith(1);
        expect(flight.inFlight()).toBe(true);
    });

    it("keeps only the newest value while one is in flight, then runs it once", async () => {
        const first = deferred();
        const run = vi.fn().mockImplementationOnce(() => first.promise).mockResolvedValue(undefined);
        const flight = createLatestWins<number>(run);
        flight.send(1);
        flight.send(2);
        flight.send(3);
        expect(run).toHaveBeenCalledTimes(1);

        first.resolve();
        await Promise.resolve();
        await Promise.resolve();

        expect(run).toHaveBeenCalledTimes(2);
        expect(run).toHaveBeenLastCalledWith(3);
    });

    it("still runs the pending value when the in-flight run rejects", async () => {
        const first = deferred();
        const run = vi.fn().mockImplementationOnce(() => first.promise).mockResolvedValue(undefined);
        const flight = createLatestWins<number>(run);
        flight.send(1);
        flight.send(2);

        first.reject(new Error("503"));
        await Promise.resolve();
        await Promise.resolve();

        expect(run).toHaveBeenLastCalledWith(2);
    });

    it("is idle again after the last run settles", async () => {
        const run = vi.fn(() => Promise.resolve());
        const flight = createLatestWins<number>(run);
        flight.send(1);
        await Promise.resolve();
        await Promise.resolve();
        expect(flight.inFlight()).toBe(false);
    });

    it("cancel drops the pending value but not the in-flight run", async () => {
        const first = deferred();
        const run = vi.fn().mockImplementationOnce(() => first.promise).mockResolvedValue(undefined);
        const flight = createLatestWins<number>(run);
        flight.send(1);
        flight.send(2);
        flight.cancel();
        first.resolve();
        await Promise.resolve();
        await Promise.resolve();
        expect(run).toHaveBeenCalledTimes(1);
    });
});
