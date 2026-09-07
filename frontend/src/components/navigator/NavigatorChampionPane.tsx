import {
    Component,
    For,
    Show,
    createEffect,
    createMemo,
    createSignal,
    onCleanup,
    onMount
} from "solid-js";
import type { NavigatorTreeNode } from "../../contexts/NavigatorContext";
import { useMultiFilterableItems } from "../../hooks/useFilterableItems";
import { getChampionImg } from "../../utils/championRoles";
import { championCategories, champions } from "../../utils/constants";
import { rankedTiles } from "../../utils/navigatorPalette";
import type { ChampionColorState } from "../ChampionPicker";
import { RoleFilter } from "../RoleFilter";

export interface NavigatorChampionPaneProps {
    /** The palette's search text. */
    query: string;
    fan: NavigatorTreeNode[];
    partnerOf: string | null;
    unavailable: Set<string>;
    /** Tooltip suffix for a disabled tile — "picked in Game 2 (fearless)" — or null. */
    unavailableReason: (championId: string) => string | null;
    coloring: (championId: string) => ChampionColorState;
    onChoose: (championId: string) => void;
}

const GRID_COLS = 6;
const nameOf = (id: string): string => champions.find((c) => c.id === id)?.name ?? id;

function borderFor(
    state: ChampionColorState,
    disabled: boolean,
    highlighted: boolean,
    ranked: boolean
): string {
    if (disabled) return "border-slate-700 opacity-30 cursor-not-allowed";
    if (highlighted) return "border-sky-300 ring-2 ring-sky-300/40";
    if (ranked) return "border-red-400/70 hover:border-sky-300";
    switch (state) {
        case "own-team":
            return "border-blue-400";
        case "other-team":
            return "border-red-400/60";
        case "shared":
            return "border-purple-400";
        default:
            return "border-darius-border hover:border-darius-purple-bright";
    }
}

export const NavigatorChampionPane: Component<NavigatorChampionPaneProps> = (props) => {
    const filterState = useMultiFilterableItems({
        items: champions,
        categoryMap: championCategories
    });
    createEffect(() => filterState.setSearchText(props.query));
    const [highlight, setHighlight] = createSignal(0);

    const idsInSelectedRoles = createMemo<Set<string> | null>(() => {
        const roles = filterState.selectedCategories();
        if (roles.size === 0) return null;
        const ids = new Set<string>();
        for (const role of roles)
            for (const idx of championCategories[role] ?? []) ids.add(champions[idx].id);
        return ids;
    });
    const ranked = createMemo(() => {
        const q = filterState.searchText().trim().toLowerCase();
        const inRoles = idsInSelectedRoles();
        return rankedTiles(props.fan, props.partnerOf).filter(
            (t) =>
                nameOf(t.championId).toLowerCase().includes(q) &&
                (inRoles === null || inRoles.has(t.championId))
        );
    });
    const pool = createMemo(() => {
        const rankedIds = new Set(ranked().map((t) => t.championId));
        return filterState
            .filteredItems()
            .filter(({ item }) => !rankedIds.has(item.id) && item.id !== props.partnerOf);
    });
    const ordered = createMemo(() => [
        ...ranked().map((t) => t.championId),
        ...pool().map(({ item }) => item.id)
    ]);
    createEffect(() => {
        ordered();
        setHighlight(0);
    });
    const exactMatch = createMemo(() => {
        const q = filterState.searchText().trim().toLowerCase();
        if (!q) return null;
        return champions.find((c) => c.name.trim().toLowerCase() === q)?.id ?? null;
    });
    const choose = (id: string) => {
        if (props.unavailable.has(id)) return;
        props.onChoose(id);
    };
    /** Execution ruling 2026-09-07 (Task 6 review): the ranked and pool sections
     *  are two separate 6-column grids, so a vertical move crosses the boundary
     *  into the same COLUMN of the other section (clamped to its last tile) —
     *  never by a flat ±6 through `ordered()`, which landed on a different
     *  visual column (and Enter would have committed it). */
    const moveVertical = (from: number, dir: 1 | -1): number => {
        const R = ranked().length;
        const P = pool().length;
        const inRanked = from < R;
        const base = inRanked ? 0 : R;
        const len = inRanked ? R : P;
        const local = from - base;
        const within = local + dir * GRID_COLS;
        if (within >= 0 && within < len) return base + within;
        const col = local % GRID_COLS;
        if (dir === 1 && inRanked && P > 0) return R + Math.min(col, P - 1);
        if (dir === -1 && !inRanked && R > 0) {
            const lastRowStart = Math.floor((R - 1) / GRID_COLS) * GRID_COLS;
            return Math.min(lastRowStart + col, R - 1);
        }
        return from;
    };
    const onKey = (e: KeyboardEvent) => {
        if (e.defaultPrevented) return; // the palette's handler acted (defence in depth; it returns in this stage)
        const n = ordered().length;
        if (e.key === "Enter") {
            const id = exactMatch() ?? ordered()[highlight()];
            if (id) choose(id);
            e.preventDefault();
            return;
        }
        if (n === 0) return;
        if (e.key === "ArrowRight") setHighlight((h) => Math.min(n - 1, h + 1));
        else if (e.key === "ArrowLeft") setHighlight((h) => Math.max(0, h - 1));
        else if (e.key === "ArrowDown") setHighlight((h) => moveVertical(h, 1));
        else if (e.key === "ArrowUp") setHighlight((h) => moveVertical(h, -1));
        else return;
        e.preventDefault();
    };
    onMount(() => window.addEventListener("keydown", onKey));
    onCleanup(() => window.removeEventListener("keydown", onKey));

    const tile = (id: string, score: number | null, idx: number) => (
        <button
            type="button"
            data-champion={id}
            data-ranked={score !== null ? "true" : "false"}
            data-highlighted={highlight() === idx ? "true" : "false"}
            disabled={props.unavailable.has(id)}
            title={(() => {
                const reason = props.unavailable.has(id)
                    ? props.unavailableReason(id)
                    : null;
                return reason ? `${nameOf(id)} — ${reason}` : nameOf(id);
            })()}
            onMouseEnter={() => setHighlight(idx)}
            onClick={() => choose(id)}
            class={`relative aspect-square overflow-hidden rounded border-2 ${borderFor(props.coloring(id), props.unavailable.has(id), highlight() === idx, score !== null)}`}
        >
            <img
                src={getChampionImg(id)}
                alt={nameOf(id)}
                draggable={false}
                class="h-full w-full object-cover"
            />
            <Show when={score !== null}>
                <span class="absolute bottom-0 right-0 rounded-tl bg-black/80 px-1 text-[10px] font-bold tabular-nums text-slate-50">
                    {score?.toFixed(2)}
                </span>
            </Show>
        </button>
    );

    return (
        <div data-champion-pane class="flex flex-col gap-2">
            <RoleFilter
                categories={filterState.categories}
                selectedCategories={filterState.selectedCategories}
                onToggle={filterState.toggleCategory}
                onClearAll={filterState.clearCategories}
                theme="neutral"
            />
            <div class="custom-scrollbar max-h-[340px] overflow-y-auto pr-1">
                <Show when={ranked().length > 0}>
                    <div class="mb-1 text-[10px] uppercase tracking-wider text-slate-400">
                        Ranked · score
                    </div>
                    <div class="mb-2 grid grid-cols-6 gap-1.5">
                        <For each={ranked()}>
                            {(t, i) => tile(t.championId, t.score, i())}
                        </For>
                    </div>
                </Show>
                <div class="mb-1 text-[10px] uppercase tracking-wider text-slate-400">
                    Pool
                </div>
                <div class="grid grid-cols-6 gap-1.5">
                    <For each={pool()}>
                        {({ item }, i) => tile(item.id, null, ranked().length + i())}
                    </For>
                </div>
            </div>
        </div>
    );
};
