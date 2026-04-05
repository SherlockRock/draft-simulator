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
                    <h2 class="mb-4 text-xl font-bold text-darius-text-primary">
                        Group Settings
                    </h2>

                    <div class="mb-4">
                        <label class="mb-2 block text-sm font-medium text-darius-text-secondary">
                            Group Name
                        </label>
                        <input
                            type="text"
                            value={name()}
                            onInput={(e) => setName(e.currentTarget.value)}
                            class="w-full rounded-md border border-darius-border bg-darius-card-hover px-3 py-2 text-darius-text-primary focus:border-darius-purple-bright focus:outline-none"
                        />
                    </div>

                    <div class="mb-4">
                        <label class="mb-2 block text-sm font-medium text-darius-text-secondary">
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
                        <div class="mt-1.5 min-h-[2.5rem] text-xs text-darius-text-secondary">
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

                    <div class="rounded-md border border-darius-border bg-darius-card-hover/50">
                        <button
                            type="button"
                            onClick={() => setDisabledExpanded(!disabledExpanded())}
                            class="flex w-full items-center justify-between px-3 py-2 text-sm text-darius-text-primary text-darius-text-secondary"
                        >
                            <span>
                                Disabled Champions{" "}
                                <span class="text-darius-text-secondary">
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
                            <div class="border-t border-darius-border px-3 pb-3 pt-2">
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
                            class="rounded-md bg-darius-card-hover px-4 py-2 text-sm font-medium text-darius-text-primary transition-colors hover:bg-darius-border"
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
                            class="rounded-md bg-darius-purple bg-darius-purple px-4 py-2 text-sm font-medium text-white"
                        >
                            Save
                        </button>
                    </div>
                </div>
            }
        />
    );
};
