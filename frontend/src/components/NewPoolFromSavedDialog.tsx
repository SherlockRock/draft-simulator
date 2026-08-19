import { Component, For, Show, createEffect, createResource } from "solid-js";
import toast from "solid-toast";
import type { RolePoolMap, SavedPool } from "@draft-sim/shared-types";
import { Dialog, EscapeKeyHint } from "./Dialog";
import { fetchSavedPools } from "../utils/savedPoolsApi";
import { sanitizeAgainstCatalog } from "../utils/poolCard";

type NewPoolFromSavedDialogProps = {
    isOpen: () => boolean;
    onClose: () => void;
    // Copy-by-value IS the no-aliasing mechanic (design §"New Pool from
    // Saved"): only a name + a sanitized champions snapshot cross this
    // boundary. No saved-pool id crosses the wire, so the created canvas pool
    // has no live link back to the source saved pool.
    onCreate: (payload: { name: string; champions: RolePoolMap }) => void;
};

export const NewPoolFromSavedDialog: Component<NewPoolFromSavedDialogProps> = (props) => {
    const [pools, { refetch }] = createResource(fetchSavedPools);

    // Refetch every time the dialog opens (mirrors SavedPoolDropdown's
    // refetch-on-open) so a pool saved elsewhere while this canvas tab sat
    // idle shows up without a page reload.
    createEffect(() => {
        if (props.isOpen()) refetch();
    });

    const handlePick = (pool: SavedPool) => {
        const { champions, droppedCount } = sanitizeAgainstCatalog(pool.champions);
        if (droppedCount > 0) {
            toast(
                `Dropped ${droppedCount} champion${droppedCount === 1 ? "" : "s"} no longer in catalog`,
                { icon: "⚠️" }
            );
        }
        props.onCreate({ name: pool.name, champions });
        props.onClose();
    };

    return (
        <Dialog
            isOpen={props.isOpen}
            onCancel={props.onClose}
            body={
                <div class="w-96">
                    <h2 class="mb-1 text-xl font-bold text-darius-text-primary">
                        New Pool from Saved…
                    </h2>
                    <p class="mb-4 text-sm text-darius-text-secondary">
                        Copies a saved pool's champions onto this canvas. The new card is
                        independent — editing it here won't change the saved pool.
                    </p>
                    <div class="custom-scrollbar max-h-80 overflow-y-auto rounded-md border border-darius-border">
                        <Show
                            when={!pools.loading}
                            fallback={
                                <div class="px-3 py-3 text-sm text-darius-text-secondary">
                                    Loading…
                                </div>
                            }
                        >
                            <Show
                                when={(pools() ?? []).length > 0}
                                fallback={
                                    <div class="px-3 py-3 text-sm text-darius-text-secondary">
                                        No saved pools yet. Save one from the Team Prep
                                        view first.
                                    </div>
                                }
                            >
                                <For each={pools() ?? []}>
                                    {(pool) => (
                                        <button
                                            type="button"
                                            onClick={() => handlePick(pool)}
                                            class="flex w-full flex-col gap-0.5 border-b border-darius-border px-3 py-2 text-left transition-colors last:border-b-0 hover:bg-darius-card-hover"
                                        >
                                            <span class="truncate text-sm text-darius-text-primary">
                                                {pool.name}
                                            </span>
                                            <span class="text-xs text-darius-text-secondary">
                                                {countChampions(pool.champions)}
                                            </span>
                                        </button>
                                    )}
                                </For>
                            </Show>
                        </Show>
                    </div>
                    <div class="mt-4 flex justify-end border-t border-darius-border pt-4">
                        <button
                            type="button"
                            onClick={props.onClose}
                            class="flex items-center gap-2 rounded-md bg-darius-ember px-4 py-2 text-sm font-medium text-darius-text-primary transition-[filter] hover:brightness-110"
                        >
                            <span>Cancel</span>
                            <EscapeKeyHint />
                        </button>
                    </div>
                </div>
            }
        />
    );
};

// Raw per-role sum (no flex dedup) — matches SavedPoolDropdown's `countRoles`
// so the same pool shows the same number in both list surfaces.
function countChampions(map: RolePoolMap): string {
    const total =
        map.top.length +
        map.jungle.length +
        map.mid.length +
        map.adc.length +
        map.support.length;
    return `${total} champion${total === 1 ? "" : "s"}`;
}
