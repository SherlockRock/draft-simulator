import { Component, For, Show } from "solid-js";
import type { PlayerId } from "../../utils/playerStats";
import { dragPayload, parseDragPayload, type DragOrigin } from "../../utils/lineupMove";
import type { MatchupSide } from "./RoleSlot";

export interface BenchSide {
    side: MatchupSide;
    players: PlayerId[];
    /**
     * True while the side's param is still list-form. The move handler refuses
     * those drags (there are no slots to move between yet), so the bench must
     * LOOK inert rather than silently swallow them.
     */
    disabled: boolean;
}

interface BenchHalfProps extends BenchSide {
    onMove?: (side: MatchupSide, from: DragOrigin, to: DragOrigin) => void;
}

const idLabel = (p: PlayerId): string => `${p.gameName}#${p.tagLine}`;

const BenchHalf: Component<BenchHalfProps> = (props) => {
    const dropOn = (e: DragEvent, target: DragOrigin) => {
        e.preventDefault();
        if (props.disabled) return;
        const raw = e.dataTransfer?.getData("text/plain");
        if (!raw) return;
        const parsed = parseDragPayload(raw);
        if (!parsed) return;
        if (parsed.side !== props.side) return;
        props.onMove?.(props.side, parsed.origin, target);
    };

    return (
        <div
            class="custom-scrollbar flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto p-2"
            classList={{ "opacity-50": props.disabled }}
            onDragOver={(e) => e.preventDefault()}
            // The empty area IS the append target. Without it a starter can
            // never be demoted to an empty bench.
            onDrop={(e) => dropOn(e, { kind: "bench", index: props.players.length })}
        >
            <For
                each={props.players}
                fallback={
                    <div class="flex flex-1 items-center justify-center px-1 text-center text-xs text-slate-500">
                        {props.disabled ? "Assigning roles…" : "Drop a player here"}
                    </div>
                }
            >
                {(player, index) => (
                    <div
                        draggable={!props.disabled}
                        onDragStart={(e) => {
                            if (props.disabled) return;
                            e.dataTransfer?.setData(
                                "text/plain",
                                dragPayload(props.side, {
                                    kind: "bench",
                                    index: index()
                                })
                            );
                        }}
                        onDragOver={(e) => e.preventDefault()}
                        onDrop={(e) => {
                            // Beat the container's append handler.
                            e.stopPropagation();
                            dropOn(e, { kind: "bench", index: index() });
                        }}
                        class="min-w-0 select-text truncate rounded border border-slate-700/50 bg-slate-900/70 px-2 py-1 text-xs text-slate-200"
                        classList={{ "cursor-grab": !props.disabled }}
                        title={idLabel(player)}
                    >
                        {idLabel(player)}
                    </div>
                )}
            </For>
        </div>
    );
};

interface BenchColumnProps {
    you: BenchSide;
    /** Matchup mode only — the column then splits like MatchupColumn does. */
    enemy?: BenchSide;
    onMove?: (side: MatchupSide, from: DragOrigin, to: DragOrigin) => void;
}

/**
 * The bench, as a narrow sixth column in the same horizontal scroller.
 *
 * Chips carry names and nothing else: the reported gap is curation ("you cannot
 * promote a sub into a role"), not comparison, and keeping pools off the bench
 * is what lets the scout request stay at five players.
 */
export const BenchColumn: Component<BenchColumnProps> = (props) => (
    <section class="flex w-[168px] shrink-0 flex-col rounded-xl border border-slate-700/50 bg-slate-800/95">
        <div class="flex items-center justify-center gap-1.5 border-b border-slate-700/60 py-1.5">
            <span class="text-xs font-semibold uppercase tracking-wide text-slate-300">
                Bench
            </span>
        </div>
        {/* Explicit props rather than a spread: a spread of `props.you` would
            read the object once and lose the per-field reactivity. */}
        <BenchHalf
            side={props.you.side}
            players={props.you.players}
            disabled={props.you.disabled}
            onMove={props.onMove}
        />
        <Show when={props.enemy}>
            {(enemy) => (
                <>
                    {/* Mirrors MatchupColumn's shared-champs divider so the two
                        halves line up with the you/enemy bands beside them. */}
                    <div class="border-y border-slate-700/60 bg-slate-900/60 px-1.5 py-1">
                        <div
                            aria-hidden="true"
                            class="py-0.5 text-[10px] text-transparent"
                        >
                            .
                        </div>
                    </div>
                    <BenchHalf
                        side={enemy().side}
                        players={enemy().players}
                        disabled={enemy().disabled}
                        onMove={props.onMove}
                    />
                </>
            )}
        </Show>
    </section>
);
