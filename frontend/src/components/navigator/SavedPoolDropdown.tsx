import { Component, For, Show, createResource, createSignal } from "solid-js";
import { ChevronDown } from "lucide-solid";
import toast from "solid-toast";
import type { RolePoolMap, SavedPool } from "@draft-sim/shared-types";
import { fetchSavedPools } from "../../utils/savedPoolsApi";
import { champions as allChampions } from "../../utils/constants";

interface SavedPoolDropdownProps {
    // Fires when the user picks a saved pool from the list.
    // Implementations usually call onDisplayPoolChange with the pool's champions.
    onSelect: (pool: SavedPool) => void;
    // Signal bumped by consumers to force a refetch (e.g. after SavePoolAsDialog
    // or JsonImportDialog creates a new pool).
    refreshKey: () => number;
}

function sanitizeAgainstCatalog(champions: RolePoolMap): {
    champions: RolePoolMap;
    droppedCount: number;
} {
    const validIds = new Set(allChampions.map((c) => c.id));
    let dropped = 0;
    const next: RolePoolMap = {
        top: [],
        jungle: [],
        mid: [],
        adc: [],
        support: []
    };
    for (const role of ["top", "jungle", "mid", "adc", "support"] as const) {
        for (const id of champions[role] ?? []) {
            if (validIds.has(id)) {
                next[role].push(id);
            } else {
                dropped += 1;
            }
        }
    }
    return { champions: next, droppedCount: dropped };
}

export const SavedPoolDropdown: Component<SavedPoolDropdownProps> = (props) => {
    const [isOpen, setIsOpen] = createSignal(false);
    const [pools, { refetch }] = createResource(
        () => props.refreshKey(),
        fetchSavedPools
    );

    const handlePick = (pool: SavedPool) => {
        const { champions, droppedCount } = sanitizeAgainstCatalog(pool.champions);
        if (droppedCount > 0) {
            toast(
                `Dropped ${droppedCount} champion${droppedCount === 1 ? "" : "s"} no longer in catalog`,
                { icon: "⚠️" }
            );
        }
        props.onSelect({ ...pool, champions });
        setIsOpen(false);
    };

    return (
        <div class="relative">
            <button
                type="button"
                onClick={() => {
                    if (!isOpen()) refetch();
                    setIsOpen(!isOpen());
                }}
                class="flex items-center gap-1 rounded-md border border-slate-600 bg-slate-900 px-3 py-1.5 text-xs font-medium text-slate-200 transition-colors hover:border-slate-500 hover:bg-slate-800"
            >
                Load saved
                <ChevronDown size={14} />
            </button>
            <Show when={isOpen()}>
                <div class="fixed inset-0 z-40" onClick={() => setIsOpen(false)} />
                <div class="absolute left-0 top-full z-50 mt-1 max-h-[320px] w-72 overflow-y-auto rounded-md border border-slate-700 bg-slate-900 shadow-xl">
                    <Show when={!pools.loading} fallback={<LoadingRow />}>
                        <Show when={(pools() ?? []).length > 0} fallback={<EmptyRow />}>
                            <For each={pools() ?? []}>
                                {(pool) => (
                                    <button
                                        type="button"
                                        onClick={() => handlePick(pool)}
                                        class="flex w-full flex-col gap-0.5 border-b border-slate-800 px-3 py-2 text-left transition-colors last:border-b-0 hover:bg-slate-800"
                                    >
                                        <span class="text-sm text-slate-100">
                                            {pool.name}
                                        </span>
                                        <span class="text-xs text-slate-400">
                                            {countRoles(pool.champions)}
                                        </span>
                                    </button>
                                )}
                            </For>
                        </Show>
                    </Show>
                </div>
            </Show>
        </div>
    );
};

const LoadingRow: Component = () => (
    <div class="px-3 py-2 text-xs text-slate-400">Loading…</div>
);

const EmptyRow: Component = () => (
    <div class="px-3 py-2 text-xs text-slate-400">
        No saved pools yet. Use "Save as…" to create one.
    </div>
);

function countRoles(map: RolePoolMap): string {
    const total =
        map.top.length +
        map.jungle.length +
        map.mid.length +
        map.adc.length +
        map.support.length;
    return `${total} champion${total === 1 ? "" : "s"}`;
}
