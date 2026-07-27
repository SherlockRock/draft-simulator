import type { RosterInput } from "@draft-sim/shared-types";

export type SavePayload = { players: RosterInput[]; region?: string };

export type RosterSaver = {
    request(teamId: string, payload: SavePayload): void;
    dispose(): void;
};

type TeamState = {
    timer?: ReturnType<typeof setTimeout>;
    // The payload the debounce timer is holding. Kept on the state rather than
    // only in the timer's closure so `dispose` can see — and flush — it.
    pending?: SavePayload;
    inFlight: boolean;
    queued?: SavePayload;
};

type SaverDeps = {
    delayMs: number;
    save(teamId: string, payload: SavePayload): Promise<void>;
    onSaved(teamId: string): void;
    onError(teamId: string, error: Error): void;
};

// Debounces roster writes per team AND serializes them. Serialization matters
// because PUT /teams/:id/roster is a destructive whole-roster replace: two
// overlapping requests can commit in either order, so an older lineup could
// win. Only the newest payload is ever queued behind an in-flight save —
// intermediate states have no value once superseded.
//
// Every entry point is a deliberate user gesture. This module must never be
// driven by a reactive effect (decision 26).
export function createRosterSaver(deps: SaverDeps): RosterSaver {
    const teams = new Map<string, TeamState>();
    let disposed = false;

    const stateFor = (teamId: string): TeamState => {
        const existing = teams.get(teamId);
        if (existing) return existing;
        const created: TeamState = { inFlight: false };
        teams.set(teamId, created);
        return created;
    };

    // `disposed` deliberately does NOT gate this: dispose flushes the last
    // debounced gesture, and the chain below must be able to carry that flush
    // even after teardown. Suppression lives on the callbacks instead.
    const run = (teamId: string, payload: SavePayload): void => {
        const state = stateFor(teamId);
        state.inFlight = true;
        deps.save(teamId, payload)
            .then(() => {
                if (disposed) return;
                deps.onSaved(teamId);
            })
            .catch((error: unknown) => {
                if (disposed) return;
                deps.onError(
                    teamId,
                    error instanceof Error ? error : new Error(String(error))
                );
            })
            .finally(() => {
                state.inFlight = false;
                const next = state.queued;
                state.queued = undefined;
                if (next) run(teamId, next);
            });
    };

    return {
        request(teamId, payload) {
            if (disposed) return;
            const state = stateFor(teamId);
            clearTimeout(state.timer);
            state.pending = payload;
            state.timer = setTimeout(() => {
                state.timer = undefined;
                state.pending = undefined;
                if (disposed) return;
                if (state.inFlight) {
                    state.queued = payload;
                    return;
                }
                run(teamId, payload);
            }, deps.delayMs);
        },
        // Flushes rather than cancels. There is no save button and no dirty
        // state, so a drag followed by navigating away inside the debounce
        // window would otherwise lose the user's last edit with no way to
        // notice or retry. The write is fire-and-forget — `disposed` already
        // suppresses onSaved/onError, since the view that would render them is
        // gone — but it is still SERIALIZED behind any in-flight PUT, because
        // the endpoint is a destructive whole-roster replace and two racing
        // writes could commit oldest-last.
        dispose() {
            disposed = true;
            teams.forEach((state, teamId) => {
                clearTimeout(state.timer);
                state.timer = undefined;
                const pending = state.pending;
                state.pending = undefined;
                if (!pending) return;
                if (state.inFlight) {
                    state.queued = pending;
                    return;
                }
                run(teamId, pending);
            });
        }
    };
}
