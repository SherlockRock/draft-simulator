import { createSignal, createEffect, Show, Component } from "solid-js";
import { ChevronDown, ChevronUp } from "lucide-solid";
import type { DraftMode } from "@draft-sim/shared-types";
import { Dialog } from "./Dialog";
import { ChampionToggleGrid } from "./ChampionToggleGrid";
import { StyledSelect } from "./StyledSelect";
import { resolveChampionId } from "../utils/constants";

interface GroupSettingsDialogProps {
    isOpen: () => boolean;
    onClose: () => void;
    initialName: string;
    initialChampions: string[];
    initialDraftMode: DraftMode;
    isSeries?: boolean;
    canEditSeriesSettings?: boolean;
    initialBlueTeamName?: string;
    initialRedTeamName?: string;
    initialLength?: number;
    onSave: (data: {
        name: string;
        disabledChampions: string[];
        draftMode: DraftMode;
        convertToSeries: boolean;
        blueTeamName: string;
        redTeamName: string;
        length: number;
    }) => void;
}

const DRAFT_MODE_OPTIONS = [
    { value: "standard", label: "Standard" },
    { value: "fearless", label: "Fearless" },
    { value: "ironman", label: "Ironman" }
];

const SERIES_LENGTH_OPTIONS = [
    { value: "1", label: "Best of 1" },
    { value: "3", label: "Best of 3" },
    { value: "5", label: "Best of 5" },
    { value: "7", label: "Best of 7" }
];

export const GroupSettingsDialog: Component<GroupSettingsDialogProps> = (props) => {
    const [name, setName] = createSignal("");
    const [selected, setSelected] = createSignal<string[]>([]);
    const [draftMode, setDraftMode] = createSignal<DraftMode>("standard");
    const [seriesEnabled, setSeriesEnabled] = createSignal(false);
    const [blueTeamName, setBlueTeamName] = createSignal("Team 1");
    const [redTeamName, setRedTeamName] = createSignal("Team 2");
    const [length, setLength] = createSignal(3);
    const [disabledExpanded, setDisabledExpanded] = createSignal(false);

    createEffect(() => {
        if (props.isOpen()) {
            setName(props.initialName);
            setSelected(props.initialChampions.map(resolveChampionId));
            setDraftMode(props.initialDraftMode);
            setSeriesEnabled(props.isSeries ?? false);
            setBlueTeamName(props.initialBlueTeamName || "Team 1");
            setRedTeamName(props.initialRedTeamName || "Team 2");
            setLength(props.initialLength || 3);
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
                <div class="w-[min(100vw-2rem,32rem)] max-w-full">
                    <h2 class="mb-4 text-xl font-bold text-darius-text-primary">
                        Group Settings
                    </h2>

                    <div class="space-y-4">
                        <label class="mb-2 block text-sm font-medium text-darius-text-secondary">
                            Group Name
                            <input
                                type="text"
                                value={name()}
                                onInput={(e) => setName(e.currentTarget.value)}
                                class="mt-2 w-full rounded-md border border-darius-border bg-darius-card-hover px-3 py-2 text-darius-text-primary focus:border-darius-purple-bright focus:outline-none"
                            />
                        </label>

                        <label class="mb-2 block text-sm font-medium text-darius-text-secondary">
                            Draft Mode
                            <div class="mt-2">
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
                            </div>
                        </label>
                        <div class="-mt-2 min-h-[2.5rem] text-xs text-darius-text-secondary">
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

                        <Show when={!props.isSeries}>
                            <label class="flex cursor-pointer items-start justify-between gap-4 rounded-md border border-darius-border bg-darius-card-hover/40 px-3 py-3 transition-colors hover:border-darius-purple-bright/60">
                                <div class="min-w-0">
                                    <div class="text-sm font-medium text-darius-text-primary">
                                        Enable Series
                                    </div>
                                    <p class="mt-1 text-xs text-darius-text-secondary">
                                        Add manual team names and a best-of length.
                                    </p>
                                </div>
                                <div class="relative mt-0.5 shrink-0">
                                    <input
                                        type="checkbox"
                                        checked={seriesEnabled()}
                                        onChange={(e) =>
                                            setSeriesEnabled(e.currentTarget.checked)
                                        }
                                        class="peer sr-only"
                                    />
                                    <span class="block h-6 w-11 rounded-full bg-darius-border transition-colors peer-checked:bg-darius-purple" />
                                    <span class="pointer-events-none absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-white transition-transform peer-checked:translate-x-5" />
                                </div>
                            </label>
                        </Show>

                        <Show
                            when={
                                seriesEnabled() &&
                                (props.canEditSeriesSettings ?? true)
                            }
                        >
                            <div class="space-y-4 rounded-md border border-darius-border bg-darius-card-hover/30 p-3">
                                <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
                                    <label class="block text-sm font-medium text-darius-text-secondary">
                                        Blue Team Name
                                        <input
                                            type="text"
                                            value={blueTeamName()}
                                            onInput={(e) =>
                                                setBlueTeamName(e.currentTarget.value)
                                            }
                                            class="mt-2 w-full rounded-md border border-darius-border bg-darius-card-hover px-3 py-2 text-darius-text-primary focus:border-darius-purple-bright focus:outline-none"
                                        />
                                    </label>
                                    <label class="block text-sm font-medium text-darius-text-secondary">
                                        Red Team Name
                                        <input
                                            type="text"
                                            value={redTeamName()}
                                            onInput={(e) =>
                                                setRedTeamName(e.currentTarget.value)
                                            }
                                            class="mt-2 w-full rounded-md border border-darius-border bg-darius-card-hover px-3 py-2 text-darius-text-primary focus:border-darius-purple-bright focus:outline-none"
                                        />
                                    </label>
                                </div>
                                <div class="grid grid-cols-1 gap-3 sm:max-w-[14rem]">
                                    <label class="block text-sm font-medium text-darius-text-secondary">
                                        Series Length
                                        <div class="mt-2">
                                            <StyledSelect
                                                value={String(length())}
                                                onChange={(value) =>
                                                    setLength(Number(value))
                                                }
                                                options={SERIES_LENGTH_OPTIONS}
                                                theme="purple"
                                            />
                                        </div>
                                    </label>
                                </div>
                            </div>
                        </Show>

                        <div class="rounded-md border border-darius-border bg-darius-card-hover/50">
                            <button
                                type="button"
                                onClick={() => setDisabledExpanded(!disabledExpanded())}
                                class="flex w-full items-center justify-between px-3 py-2 text-sm text-darius-text-secondary transition-colors hover:text-darius-text-primary"
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
                                    draftMode: draftMode(),
                                    convertToSeries:
                                        !props.isSeries && seriesEnabled(),
                                    blueTeamName: blueTeamName().trim() || "Team 1",
                                    redTeamName: redTeamName().trim() || "Team 2",
                                    length: length(),
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
