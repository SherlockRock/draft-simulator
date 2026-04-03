import { createSignal, createEffect, Show, Component } from "solid-js";
import { ChevronDown, ChevronUp } from "lucide-solid";
import type { DraftMode } from "@draft-sim/shared-types";
import { Dialog } from "./Dialog";
import { ChampionToggleGrid } from "./ChampionToggleGrid";
import { StyledSelect } from "./StyledSelect";

interface GroupSettingsDialogProps {
    isOpen: () => boolean;
    onClose: () => void;
    initialName: string;
    initialChampions: string[];
    initialDraftMode: DraftMode;
    onSave: (data: {
        name: string;
        disabledChampions: string[];
        draftMode: DraftMode;
    }) => void;
}

const DRAFT_MODE_OPTIONS = [
    { value: "standard", label: "Standard" },
    { value: "fearless", label: "Fearless" },
    { value: "ironman", label: "Ironman" }
];

export const GroupSettingsDialog: Component<GroupSettingsDialogProps> = (props) => {
    const [name, setName] = createSignal("");
    const [selected, setSelected] = createSignal<string[]>([]);
    const [draftMode, setDraftMode] = createSignal<DraftMode>("standard");
    const [disabledExpanded, setDisabledExpanded] = createSignal(false);

    createEffect(() => {
        if (props.isOpen()) {
            setName(props.initialName);
            setSelected([...props.initialChampions]);
            setDraftMode(props.initialDraftMode);
            setDisabledExpanded(false);
        }
    });

    const handleToggle = (champId: string) => {
        setSelected((prev) =>
            prev.includes(champId)
                ? prev.filter((id) => id !== champId)
                : [...prev, champId]
        );
    };

    return (
        <Dialog
            isOpen={props.isOpen}
            onCancel={props.onClose}
            body={
                <div class="w-[520px]">
                    <h2 class="mb-4 text-xl font-bold text-slate-50">Group Settings</h2>

                    <div class="mb-4">
                        <label class="mb-2 block text-sm font-medium text-slate-300">
                            Group Name
                        </label>
                        <input
                            type="text"
                            value={name()}
                            onInput={(e) => setName(e.currentTarget.value)}
                            class="w-full rounded-md border border-slate-600 bg-slate-700 px-3 py-2 text-slate-50 focus:border-purple-500 focus:outline-none"
                        />
                    </div>

                    <div class="mb-4">
                        <label class="mb-2 block text-sm font-medium text-slate-300">
                            Draft Mode
                        </label>
                        <StyledSelect
                            value={draftMode()}
                            onChange={(v) => {
                                if (
                                    v === "standard" ||
                                    v === "fearless" ||
                                    v === "ironman"
                                ) {
                                    setDraftMode(v);
                                }
                            }}
                            options={DRAFT_MODE_OPTIONS}
                            theme="purple"
                        />
                        <div class="mt-1.5 min-h-[2.5rem] text-xs text-slate-400">
                            <Show when={draftMode() === "fearless"}>
                                <p>
                                    Champions picked in one draft cannot be picked in
                                    other drafts within this group.
                                </p>
                            </Show>
                            <Show when={draftMode() === "ironman"}>
                                <p>
                                    Champions picked or banned in one draft cannot be used
                                    in other drafts within this group.
                                </p>
                            </Show>
                        </div>
                    </div>

                    <div class="rounded-md border border-slate-600 bg-slate-700/50">
                        <button
                            type="button"
                            onClick={() => setDisabledExpanded(!disabledExpanded())}
                            class="flex w-full items-center justify-between px-3 py-2 text-sm text-slate-300 hover:text-slate-100"
                        >
                            <span>
                                Disabled Champions{" "}
                                <span class="text-slate-400">
                                    (
                                    {selected().length > 0
                                        ? `${selected().length} disabled`
                                        : "None"}
                                    )
                                </span>
                            </span>
                            <Show
                                when={disabledExpanded()}
                                fallback={<ChevronDown size={16} />}
                            >
                                <ChevronUp size={16} />
                            </Show>
                        </button>
                        <Show when={disabledExpanded()}>
                            <div class="border-t border-slate-600 px-3 pb-3 pt-2">
                                <ChampionToggleGrid
                                    selectedChampions={selected}
                                    onToggle={handleToggle}
                                    theme="purple"
                                />
                            </div>
                        </Show>
                    </div>

                    <div class="mt-4 flex justify-end gap-3">
                        <button
                            type="button"
                            onClick={() => {
                                (document.activeElement as HTMLElement)?.blur();
                                props.onClose();
                            }}
                            class="rounded-md bg-slate-600 px-4 py-2 text-sm font-medium text-slate-50 hover:bg-slate-500"
                        >
                            Cancel
                        </button>
                        <button
                            type="button"
                            onClick={() => {
                                (document.activeElement as HTMLElement)?.blur();
                                props.onSave({
                                    name: name().trim(),
                                    disabledChampions: selected(),
                                    draftMode: draftMode()
                                });
                                props.onClose();
                            }}
                            class="rounded-md bg-purple-600 px-4 py-2 text-sm font-medium text-white hover:bg-purple-500"
                        >
                            Save
                        </button>
                    </div>
                </div>
            }
        />
    );
};
