import { Component, For, createSignal } from "solid-js";
import type {
    CanvasPoolPlacement,
    PoolChampionOp,
    Role,
    RolePoolMap
} from "@draft-sim/shared-types";
import { diffRolePoolMaps } from "@draft-sim/shared-types";
import { Dialog, EscapeKeyHint, ReturnKeyHint } from "./Dialog";
import { PoolRoleAccordion } from "./PoolRoleAccordion";
import { ROLES } from "../utils/championRoles";
import { poolChampionTotal } from "../utils/poolCard";

type PoolOverlayEditorProps = {
    placement: CanvasPoolPlacement;
    onCommitOps: (placementId: string, ops: PoolChampionOp[]) => void;
    // Wired now so the producer (Canvas.tsx's handlePoolReplace) and this
    // component's prop shape stay stable — the overlay UI that actually
    // CALLS onReplace (the "Import from Saved" launcher) lands in Task 17.
    onReplace: (placementId: string, champions: RolePoolMap) => void;
    onClose: () => void;
    isLocalMode: boolean;
    isAuthenticated: boolean;
};

const copyMap = (map: RolePoolMap): RolePoolMap => ({
    top: [...map.top],
    jungle: [...map.jungle],
    mid: [...map.mid],
    adc: [...map.adc],
    support: [...map.support]
});

/**
 * Bulk pool editor (design D4): stages edits locally across all five roles,
 * then commits the whole session as a diff-as-ops batch through
 * `handlePoolChampionOp` — never through `poolReplace`. Mounted by Canvas.tsx
 * inside a `keyed <Show>` (Task 16 Step 3) so this component REMOUNTS every
 * time it opens — that's what makes capturing `opening`/`staged` as plain
 * component-body state (rather than effects resyncing off a live prop) safe:
 * each open gets its own fresh baseline instead of the previous session's.
 */
export const PoolOverlayEditor: Component<PoolOverlayEditorProps> = (props) => {
    // Captured ONCE per mount: the diff baseline (D4). A quick-edit landing
    // while the overlay is open changes the STORE, not this baseline — Apply
    // then diffs against what the user SAW when they started, so their ops
    // express only their own edits and the concurrent edit survives.
    const opening = copyMap(props.placement.Pool.champions);
    const [staged, setStaged] = createSignal<RolePoolMap>(copyMap(opening));
    const [openRoles, setOpenRoles] = createSignal<Set<Role>>(new Set<Role>(["top"]));

    const toggleOpen = (role: Role) => {
        setOpenRoles((prev) => {
            const next = new Set(prev);
            if (next.has(role)) next.delete(role);
            else next.add(role);
            return next;
        });
    };

    const setRoleChampions = (role: Role, championIds: string[]) => {
        setStaged((prev) => ({ ...prev, [role]: championIds }));
    };

    const totalSelected = () => poolChampionTotal(staged());

    const applyChanges = () => {
        const ops = diffRolePoolMaps(opening, staged());
        // Zero ops means nothing changed across the whole session — skip the
        // no-op dispatch and just close.
        if (ops.length > 0) {
            props.onCommitOps(props.placement.id, ops);
        }
        props.onClose();
    };

    return (
        <Dialog
            isOpen={() => true}
            onCancel={props.onClose}
            onConfirm={applyChanges}
            body={
                <div class="flex w-[480px] flex-col text-darius-text-primary">
                    <div class="flex items-center justify-between border-b border-darius-border pb-2">
                        <h2 class="truncate text-xl font-bold text-darius-text-primary">
                            Edit {props.placement.Pool.name}
                        </h2>
                        <span class="ml-2 shrink-0 rounded-full border border-slate-600 bg-slate-900 px-2.5 py-1 text-xs font-medium text-slate-300">
                            {totalSelected()} total
                        </span>
                    </div>

                    <div class="custom-scrollbar mt-3 flex max-h-[60vh] flex-col gap-2 overflow-y-auto pr-1">
                        <For each={ROLES}>
                            {(role) => (
                                <PoolRoleAccordion
                                    role={role}
                                    isOpen={openRoles().has(role)}
                                    onToggleOpen={() => toggleOpen(role)}
                                    selectedChampionIds={() => staged()[role]}
                                    onSelectionChange={(ids) =>
                                        setRoleChampions(role, ids)
                                    }
                                />
                            )}
                        </For>
                    </div>

                    <div class="mt-4 flex items-center justify-end gap-2 border-t border-darius-border pt-4">
                        <button
                            type="button"
                            onClick={props.onClose}
                            class="flex items-center gap-2 rounded-md bg-darius-ember px-4 py-2 text-sm font-medium text-darius-text-primary transition-[filter] hover:brightness-110"
                        >
                            <span>Cancel</span>
                            <EscapeKeyHint />
                        </button>
                        <button
                            type="button"
                            onClick={applyChanges}
                            class="flex items-center gap-2 rounded-md bg-darius-purple px-4 py-2 text-sm font-medium text-darius-text-primary transition-colors hover:bg-darius-purple-bright"
                        >
                            <span>Apply</span>
                            <ReturnKeyHint />
                        </button>
                    </div>
                </div>
            }
        />
    );
};
