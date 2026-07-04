import { Component, For, Show, createSignal, JSX } from "solid-js";
import { Portal } from "solid-js/web";
import type { SharedChamp, FlexChamp, RoleStat } from "../../utils/playerStats";
import { winrateColor } from "../../utils/playerStats";
import { getChampionImg } from "../../utils/championRoles";
import { RoleIcon } from "./PlayerPanel";

export type ChipDetail =
    | { kind: "shared"; champ: SharedChamp; youName: string; enemyName: string }
    | { kind: "flex"; champ: FlexChamp };

interface ChampChipStripProps {
    chips: ChipDetail[];
    onChipClick?: (championId: string) => void;
    class?: string;
}

interface HoverState {
    chip: ChipDetail;
    rect: DOMRect;
}

const championIdOf = (c: ChipDetail): string =>
    c.kind === "shared" ? c.champ.championId : c.champ.championId;

// One popover line: who plays it, in which role(s), with games/WR.
const StatLine: Component<{
    name: string;
    games: number;
    wins: number;
    roles: RoleStat[];
}> = (props) => {
    const wr = () => (props.games ? Math.round((props.wins / props.games) * 100) : 0);
    return (
        <div class="flex items-center gap-2 whitespace-nowrap">
            <span class="min-w-0 max-w-[140px] truncate font-semibold text-slate-100">
                {props.name}
            </span>
            <span class="flex items-center gap-1">
                <For each={props.roles}>
                    {(r) => (
                        <span class="flex items-center gap-0.5 text-slate-400">
                            <RoleIcon role={r.role} active class="h-3 w-3" />
                            <span class="tabular-nums">{r.games}g</span>
                        </span>
                    )}
                </For>
            </span>
            <span class={`font-semibold tabular-nums ${winrateColor(wr())}`}>
                {wr()}%
            </span>
        </div>
    );
};

// Popover body: shared = your player stacked over theirs; flex = one line per
// teammate. This is the piece to inline into chips if "always visible" wins later.
const PopoverBody: Component<{ chip: ChipDetail }> = (props) => (
    <Show
        when={props.chip.kind === "shared" ? props.chip : null}
        fallback={
            <For each={props.chip.kind === "flex" ? props.chip.champ.players : []}>
                {(p) => (
                    <StatLine
                        name={p.riotId}
                        games={p.games}
                        wins={p.wins}
                        roles={p.roles}
                    />
                )}
            </For>
        }
    >
        {(shared) => (
            <>
                <StatLine
                    name={shared().youName}
                    games={shared().champ.you.games}
                    wins={shared().champ.you.wins}
                    roles={shared().champ.you.roles}
                />
                <StatLine
                    name={shared().enemyName}
                    games={shared().champ.enemy.games}
                    wins={shared().champ.enemy.wins}
                    roles={shared().champ.enemy.roles}
                />
            </>
        )}
    </Show>
);

export const ChampChipStrip: Component<ChampChipStripProps> = (props) => {
    const [hover, setHover] = createSignal<HoverState | null>(null);

    // Fixed positioning from the chip's viewport rect, portaled to <body> -
    // the column row is overflow-x-auto, so an in-flow popover would clip.
    const popoverStyle = (rect: DOMRect): JSX.CSSProperties => ({
        position: "fixed",
        left: `${Math.max(8, rect.left + rect.width / 2)}px`,
        top: `${rect.bottom + 6}px`,
        transform: "translateX(-50%)",
        "z-index": "50"
    });

    return (
        <div
            class={`custom-scrollbar flex items-center gap-1 overflow-x-auto ${props.class ?? ""}`}
        >
            <For each={props.chips}>
                {(chip) => {
                    const id = championIdOf(chip);
                    const img = getChampionImg(id);
                    return (
                        <button
                            type="button"
                            title={id}
                            onClick={() => props.onChipClick?.(id)}
                            onMouseEnter={(e) =>
                                setHover({
                                    chip,
                                    rect: e.currentTarget.getBoundingClientRect()
                                })
                            }
                            onMouseLeave={() => setHover(null)}
                            class="shrink-0 rounded ring-1 ring-slate-600 transition-transform hover:scale-110 hover:ring-amber-400/70"
                        >
                            <Show
                                when={img}
                                fallback={<div class="h-5 w-5 rounded bg-slate-700" />}
                            >
                                <img src={img} alt={id} class="h-5 w-5 rounded" />
                            </Show>
                        </button>
                    );
                }}
            </For>
            <Show when={hover()}>
                {(h) => (
                    <Portal>
                        <div
                            style={popoverStyle(h().rect)}
                            class="flex flex-col gap-1 rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-xs shadow-xl"
                        >
                            <div class="text-[10px] font-semibold uppercase tracking-wide text-slate-500">
                                {championIdOf(h().chip)}
                            </div>
                            <PopoverBody chip={h().chip} />
                        </div>
                    </Portal>
                )}
            </Show>
        </div>
    );
};
