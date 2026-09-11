import type {
    DraftPickAck,
    DraftPickChange,
    DraftPickMutation,
    DraftPickState
} from "@draft-sim/shared-types";

type DraftPicks = { id: string; picks: string[]; picksVersion?: number };
type Pending = {
    changes: DraftPickChange[];
    request?: DraftPickMutation;
    attempts: number;
};
type Entry = {
    confirmed: DraftPickState;
    pending: Pending[];
    flight?: object;
    timer?: ReturnType<typeof setTimeout>;
    error?: string;
    conflict?: boolean;
};

// Owns delivery and the optimistic overlay across Canvas and the draft detail
// view. Socket reconnect and incoming snapshots never clear pending intent.
export function createDraftPickSync(options: {
    send: (request: DraftPickMutation, reply: (result?: DraftPickAck) => void) => void;
    changed: () => void;
}) {
    const entries = new Map<string, Entry>();
    let connected = false;

    function accept(draft: DraftPicks): Entry {
        let entry = entries.get(draft.id);
        if (!entry) {
            entry = {
                confirmed: {
                    id: draft.id,
                    picks: [...draft.picks],
                    picksVersion: draft.picksVersion ?? 0
                },
                pending: []
            };
            entries.set(draft.id, entry);
        } else if ((draft.picksVersion ?? 0) > entry.confirmed.picksVersion) {
            entry.confirmed = {
                id: draft.id,
                picks: [...draft.picks],
                picksVersion: draft.picksVersion ?? 0
            };
        }
        return entry;
    }

    function merge<T extends DraftPicks>(draft: T): T {
        const entry = accept(draft);
        const picks = [...entry.confirmed.picks];
        for (const op of entry.pending) {
            for (const change of op.changes) picks[change.index] = change.championId;
        }
        // Hand back the same object when nothing would change, so store
        // writers that merge every card on each sync event stay no-ops for
        // untouched cards instead of replacing every picks array.
        const unchanged =
            draft.picksVersion === entry.confirmed.picksVersion &&
            draft.picks.length === picks.length &&
            picks.every((champion, index) => champion === draft.picks[index]);
        if (unchanged) return draft;
        return { ...draft, picks, picksVersion: entry.confirmed.picksVersion };
    }

    function pump(entry: Entry) {
        const op = entry.pending[0];
        if (!connected || !op || entry.flight || entry.timer || entry.error) return;
        if (op.attempts >= 3) {
            entry.error = "Pick changes are not saved yet. Please retry when connected.";
            options.changed();
            return;
        }
        const request = (op.request ??= {
            id: entry.confirmed.id,
            mutationId: crypto.randomUUID(),
            baseVersion: entry.confirmed.picksVersion,
            changes: op.changes
        });
        const flight = {};
        entry.flight = flight;
        op.attempts++;
        options.send(request, (result) => {
            if (entry.flight !== flight || entries.get(request.id) !== entry) return;
            entry.flight = undefined;
            if (
                !result ||
                result.mutationId !== request.mutationId ||
                (result.draft && result.draft.id !== request.id)
            ) {
                if (op.attempts >= 3) {
                    entry.error =
                        "Pick changes are not saved yet. Please retry when connected.";
                } else if (connected) {
                    entry.timer = setTimeout(() => {
                        entry.timer = undefined;
                        pump(entry);
                    }, 500);
                }
            } else if (result.ok) {
                accept(result.draft);
                entry.pending.shift();
                pump(entry);
            } else {
                if (result.draft) accept(result.draft);
                entry.error = result.message;
                entry.conflict = result.code === "PICK_CONFLICT";
            }
            options.changed();
        });
    }

    return {
        merge,
        receive(draft: DraftPicks) {
            accept(draft);
            options.changed();
        },
        edit(draft: DraftPicks, changes: DraftPickChange[]) {
            if (!changes.length) return;
            const entry = accept(draft);
            entry.pending.push({
                changes: changes.map((change) => ({ ...change })),
                attempts: 0
            });
            options.changed();
            pump(entry);
        },
        setConnected(value: boolean) {
            connected = value;
            for (const entry of entries.values()) {
                if (!value) {
                    // A request abandoned by a disconnect never got a verdict,
                    // so it must not spend one of the bounded attempts; only
                    // a timeout or rejection on a live connection does.
                    const op = entry.pending[0];
                    if (entry.flight && op) op.attempts = Math.max(0, op.attempts - 1);
                    entry.flight = undefined;
                    clearTimeout(entry.timer);
                    entry.timer = undefined;
                } else pump(entry);
            }
            options.changed();
        },
        pendingCount() {
            return [...entries.values()].reduce(
                (sum, entry) => sum + entry.pending.length,
                0
            );
        },
        error() {
            return [...entries.values()].find((entry) => entry.error)?.error;
        },
        retry() {
            for (const entry of entries.values()) {
                if (!entry.error) continue;
                const op = entry.pending[0];
                if (op) {
                    op.attempts = 0;
                    // Only an explicit conflict retry may use a new base. A
                    // timeout retry must keep its original deduplication ID.
                    if (entry.conflict) op.request = undefined;
                }
                entry.error = undefined;
                entry.conflict = false;
                pump(entry);
            }
            options.changed();
        },
        discardFailed() {
            for (const entry of entries.values()) {
                if (!entry.error) continue;
                entry.pending = [];
                entry.error = undefined;
                entry.conflict = false;
            }
            options.changed();
        },
        reset() {
            for (const entry of entries.values()) clearTimeout(entry.timer);
            entries.clear();
            connected = false;
            options.changed();
        }
    };
}

export type DraftPickSync = ReturnType<typeof createDraftPickSync>;
