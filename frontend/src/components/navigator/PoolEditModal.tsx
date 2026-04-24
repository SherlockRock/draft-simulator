import { Component, createSignal, createEffect } from "solid-js";
import toast from "solid-toast";
import type { RolePoolMap, TeamPool } from "@draft-sim/shared-types";
import { Dialog } from "../Dialog";
import { flattenDisplayPool } from "../../utils/navigatorPool";
import { TeamPoolEditor } from "./TeamPoolEditor";

interface PoolEditModalProps {
    isOpen: () => boolean;
    initialBluePool: TeamPool;
    initialRedPool: TeamPool;
    onSave: (blue: TeamPool, red: TeamPool) => void;
    onClose: () => void;
}

export const PoolEditModal: Component<PoolEditModalProps> = (props) => {
    const [blue, setBlue] = createSignal<TeamPool>(props.initialBluePool);
    const [red, setRed] = createSignal<TeamPool>(props.initialRedPool);

    // Re-seed whenever the modal opens again, since the parent may have new
    // pool data between opens (e.g., the user saved new pools earlier).
    createEffect(() => {
        if (props.isOpen()) {
            setBlue(props.initialBluePool);
            setRed(props.initialRedPool);
        }
    });

    const updateBlueDisplay = (next: RolePoolMap) => {
        setBlue((prev) => ({ ...prev, display: next }));
    };
    const updateRedDisplay = (next: RolePoolMap) => {
        setRed((prev) => ({ ...prev, display: next }));
    };

    const handleSave = () => {
        const derive = (pool: TeamPool): TeamPool => ({
            display: pool.display,
            search: Array.from(new Set(flattenDisplayPool(pool.display)))
        });
        try {
            props.onSave(derive(blue()), derive(red()));
            props.onClose();
        } catch {
            toast.error("Failed to save pools");
        }
    };

    return (
        <Dialog
            isOpen={props.isOpen}
            onCancel={props.onClose}
            body={
                <div class="flex h-[70vh] w-[min(1100px,90vw)] flex-col">
                    <div class="mb-4 flex items-start justify-between">
                        <div>
                            <h2 class="text-lg font-semibold text-slate-100">
                                Edit Pools
                            </h2>
                            <p class="mt-1 text-xs text-slate-400">
                                Changes apply to all future games in this series.
                                Past games remain frozen.
                            </p>
                        </div>
                    </div>

                    <div class="grid flex-1 gap-6 overflow-y-auto lg:grid-cols-2">
                        <TeamPoolEditor
                            teamColor="blue"
                            teamLabel="Blue Team"
                            displayPool={() => blue().display}
                            onDisplayPoolChange={updateBlueDisplay}
                        />
                        <TeamPoolEditor
                            teamColor="red"
                            teamLabel="Red Team"
                            displayPool={() => red().display}
                            onDisplayPoolChange={updateRedDisplay}
                        />
                    </div>

                    <div class="mt-4 flex justify-end gap-3 border-t border-slate-700/50 pt-4">
                        <button
                            type="button"
                            onClick={props.onClose}
                            class="rounded-md bg-slate-700 px-4 py-2 text-sm font-medium text-slate-200 hover:bg-slate-600"
                        >
                            Cancel
                        </button>
                        <button
                            type="button"
                            onClick={handleSave}
                            class="rounded-md bg-blue-500 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-400"
                        >
                            Save Pools
                        </button>
                    </div>
                </div>
            }
        />
    );
};
