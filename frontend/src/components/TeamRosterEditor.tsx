import { Component, createSignal, For, Show } from "solid-js";
import toast from "solid-toast";
import { useMutation, useQueryClient } from "@tanstack/solid-query";
import type { Role, RosterInput, Team } from "@draft-sim/shared-types";
import { SCOUT_REGION_OPTIONS } from "@draft-sim/shared-types";
import { updateTeamRoster } from "../utils/actions";
import { parsePlayersInput, ROLE_ORDER } from "../utils/playerStats";
import { StyledSelect } from "./StyledSelect";

type Slot = { gameName: string; tagLine: string } | null;
type Bench = { gameName: string; tagLine: string }[];

const ROLE_LABEL: Record<Role, string> = {
    top: "Top",
    jungle: "Jungle",
    mid: "Mid",
    adc: "ADC",
    support: "Support"
};

const idLabel = (p: { gameName: string; tagLine: string }) =>
    `${p.gameName}#${p.tagLine}`;

// A drag source is either a role slot index (0..4) or a bench index.
type DragFrom = { kind: "slot"; index: number } | { kind: "bench"; index: number };

export const TeamRosterEditor: Component<{
    team: Team;
    onSaved: () => void;
}> = (props) => {
    const queryClient = useQueryClient();

    const initialSlots = (): Slot[] =>
        ROLE_ORDER.map((role) => {
            const found = (props.team.TeamPlayers ?? []).find((p) => p.role === role);
            return found ? { gameName: found.gameName, tagLine: found.tagLine } : null;
        });

    const initialBench = (): Bench =>
        (props.team.TeamPlayers ?? [])
            .filter((p) => p.role === null)
            .sort((a, b) => a.ordinal - b.ordinal)
            .map((p) => ({ gameName: p.gameName, tagLine: p.tagLine }));

    const [slots, setSlots] = createSignal<Slot[]>(initialSlots());
    const [bench, setBench] = createSignal<Bench>(initialBench());
    const [region, setRegion] = createSignal(props.team.region);
    const [pasteText, setPasteText] = createSignal("");
    const [dragFrom, setDragFrom] = createSignal<DragFrom | null>(null);

    const totalPlayers = () => slots().filter((s) => s !== null).length + bench().length;

    // Move the dragged player to a target, displacing whatever was there back
    // to the bench (slots hold at most one player). Bench drops insert AT the
    // target index (so dragging reorders the bench, which controls ordinal /
    // the "first five"), adjusting for the removal when the source was an
    // earlier bench position.
    const moveTo = (target: DragFrom) => {
        const from = dragFrom();
        setDragFrom(null);
        if (!from) return;

        const nextSlots = [...slots()];
        const nextBench = [...bench()];

        let moving: Slot = null;
        if (from.kind === "slot") {
            moving = nextSlots[from.index];
            nextSlots[from.index] = null;
        } else {
            const [p] = nextBench.splice(from.index, 1);
            moving = p ?? null;
        }
        if (!moving) return;

        if (target.kind === "slot") {
            const displaced = nextSlots[target.index];
            nextSlots[target.index] = moving;
            if (displaced) nextBench.push(displaced);
        } else {
            // target.index was computed against the pre-removal bench; if we
            // removed an earlier bench item, shift the insert point left one.
            const insertAt =
                from.kind === "bench" && from.index < target.index
                    ? target.index - 1
                    : target.index;
            nextBench.splice(insertAt, 0, moving);
        }
        setSlots(nextSlots);
        setBench(nextBench);
    };

    // × on a role slot demotes the player to the bench (they leave the role but
    // stay on the roster); × on a bench player removes them from the roster.
    const removePlayer = (from: DragFrom) => {
        if (from.kind === "slot") {
            const player = slots()[from.index];
            if (!player) return;
            setSlots(slots().map((s, i) => (i === from.index ? null : s)));
            setBench([...bench(), player]);
        } else {
            setBench(bench().filter((_, i) => i !== from.index));
        }
    };

    const applyPaste = () => {
        const parsed = parsePlayersInput(pasteText());
        if (parsed.players.length === 0) {
            toast.error("No players found in that text");
            return;
        }
        // Paste replaces the bench and clears slots — roles are unknown until
        // dragged. Cap at 10 total.
        setSlots(ROLE_ORDER.map(() => null));
        setBench(
            parsed.players
                .slice(0, 10)
                .map((p) => ({ gameName: p.gameName, tagLine: p.tagLine }))
        );
        if (parsed.region) setRegion(parsed.region);
        setPasteText("");
    };

    const saveMutation = useMutation(() => ({
        mutationFn: async () => {
            // Display order = ordinal (server assigns by array index): role
            // slots first (in ROLE_ORDER), then the bench.
            const players: RosterInput[] = [];
            slots().forEach((slot, i) => {
                if (slot)
                    players.push({
                        role: ROLE_ORDER[i],
                        gameName: slot.gameName,
                        tagLine: slot.tagLine
                    });
            });
            bench().forEach((p) => {
                players.push({
                    role: null,
                    gameName: p.gameName,
                    tagLine: p.tagLine
                });
            });
            // region + roster save atomically in one backend transaction.
            await updateTeamRoster(props.team.id, players, region());
        },
        onSuccess: () => {
            void queryClient.invalidateQueries({ queryKey: ["teams"] });
            toast.success("Roster saved");
            props.onSaved();
        },
        onError: (error: Error) => toast.error(`Save failed: ${error.message}`)
    }));

    const dragProps = (from: DragFrom) => ({
        draggable: true,
        onDragStart: (e: DragEvent) => {
            setDragFrom(from);
            e.dataTransfer?.setData("text/plain", "roster-player");
        },
        // Clear on cancel (drop outside any target) so a stale source can't
        // linger; a successful drop clears it via moveTo.
        onDragEnd: () => setDragFrom(null)
    });

    return (
        <div class="mt-2 rounded-md border border-darius-border bg-darius-card-hover p-4">
            <div class="mb-3 flex items-center gap-2">
                <span class="text-sm text-darius-text-secondary">Region</span>
                <StyledSelect
                    value={region()}
                    options={SCOUT_REGION_OPTIONS}
                    onChange={(v) => setRegion(v)}
                />
            </div>

            {/* Role slots */}
            <div class="mb-3 space-y-1">
                <For each={ROLE_ORDER}>
                    {(role, i) => (
                        <div
                            class="flex items-center gap-2 rounded border border-dashed border-darius-border px-2 py-1.5"
                            onDragOver={(e) => e.preventDefault()}
                            onDrop={() => moveTo({ kind: "slot", index: i() })}
                        >
                            <span class="w-16 shrink-0 text-xs font-medium uppercase text-darius-text-secondary">
                                {ROLE_LABEL[role]}
                            </span>
                            <Show
                                when={slots()[i()]}
                                fallback={
                                    <span class="text-xs italic text-darius-text-secondary/60">
                                        drop a player here
                                    </span>
                                }
                            >
                                {(slot) => (
                                    <span
                                        class="flex-1 cursor-grab select-text truncate text-sm text-darius-text-primary"
                                        {...dragProps({ kind: "slot", index: i() })}
                                    >
                                        {idLabel(slot())}
                                    </span>
                                )}
                            </Show>
                            <Show when={slots()[i()]}>
                                <button
                                    type="button"
                                    title="Move to bench"
                                    class="text-xs text-darius-text-secondary hover:text-darius-crimson"
                                    onClick={() =>
                                        removePlayer({ kind: "slot", index: i() })
                                    }
                                >
                                    ✕
                                </button>
                            </Show>
                        </div>
                    )}
                </For>
            </div>

            {/* Bench */}
            <div
                class="mb-3 min-h-10 rounded border border-darius-border p-2"
                onDragOver={(e) => e.preventDefault()}
                onDrop={() => moveTo({ kind: "bench", index: bench().length })}
            >
                <div class="mb-1 text-xs uppercase text-darius-text-secondary">Bench</div>
                <div class="flex flex-wrap gap-1">
                    <For
                        each={bench()}
                        fallback={
                            <span class="text-xs italic text-darius-text-secondary/60">
                                unroled players land here
                            </span>
                        }
                    >
                        {(p, i) => (
                            <span
                                class="flex cursor-grab items-center gap-1 rounded bg-darius-card px-2 py-0.5 text-xs text-darius-text-primary"
                                {...dragProps({ kind: "bench", index: i() })}
                                onDragOver={(e) => e.preventDefault()}
                                onDrop={(e) => {
                                    e.stopPropagation();
                                    moveTo({ kind: "bench", index: i() });
                                }}
                            >
                                <span class="select-text">{idLabel(p)}</span>
                                <button
                                    type="button"
                                    title="Remove from roster"
                                    class="text-darius-text-secondary hover:text-darius-crimson"
                                    onClick={() =>
                                        removePlayer({ kind: "bench", index: i() })
                                    }
                                >
                                    ✕
                                </button>
                            </span>
                        )}
                    </For>
                </div>
            </div>

            {/* Paste */}
            <div class="mb-3 flex gap-2">
                <input
                    type="text"
                    value={pasteText()}
                    placeholder="Paste op.gg multisearch link or Name#TAG, Name#TAG…"
                    onInput={(e) => setPasteText(e.currentTarget.value)}
                    onKeyDown={(e) => {
                        if (e.key === "Enter") applyPaste();
                    }}
                    class="flex-1 select-text rounded border border-darius-border bg-darius-card px-2 py-1 text-sm text-darius-text-primary focus:border-darius-purple-bright focus:outline-none"
                />
                <button
                    type="button"
                    onClick={applyPaste}
                    class="rounded bg-darius-border px-3 py-1 text-sm text-darius-text-primary hover:brightness-110"
                >
                    Fill
                </button>
            </div>

            <div class="flex items-center justify-between">
                <span class="text-xs text-darius-text-secondary">
                    {totalPlayers()}/10 players
                </span>
                <button
                    type="button"
                    onClick={() => saveMutation.mutate()}
                    disabled={saveMutation.isPending}
                    class="rounded bg-darius-purple-bright px-4 py-1.5 text-sm font-medium text-white hover:brightness-110 disabled:opacity-50"
                >
                    Save roster
                </button>
            </div>
        </div>
    );
};
