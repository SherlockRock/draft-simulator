import type { RosterInput } from "@draft-sim/shared-types";

export type SavePayload = { players: RosterInput[]; region?: string };

export type RosterSaver = {
    request(teamId: string, payload: SavePayload): void;
    dispose(): void;
};

type TeamState = {
    timer?: ReturnType<typeof setTimeout>;
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

    const run = (teamId: string, payload: SavePayload): void => {
        if (disposed) return;
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
                if (!disposed && next) run(teamId, next);
            });
    };

    return {
        request(teamId, payload) {
            if (disposed) return;
            const state = stateFor(teamId);
            clearTimeout(state.timer);
            state.timer = setTimeout(() => {
                if (disposed) return;
                if (state.inFlight) {
                    state.queued = payload;
                    return;
                }
                run(teamId, payload);
            }, deps.delayMs);
        },
        dispose() {
            disposed = true;
            teams.forEach((state) => {
                clearTimeout(state.timer);
                state.queued = undefined;
            });
        }
    };
}
