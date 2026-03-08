import { createSignal, createEffect, Show } from "solid-js";
import { useMutation } from "@tanstack/solid-query";
import { Dialog } from "./Dialog";
import toast from "solid-toast";
import { useNavigate } from "@solidjs/router";
import { Plus, ChevronDown, ChevronUp } from "lucide-solid";
import { IconPicker } from "./IconPicker";
import { ChampionToggleGrid } from "./ChampionToggleGrid";
import { champions } from "../utils/constants";
import { StyledSelect } from "./StyledSelect";
import { createVersusDraft } from "../utils/actions";
import { track } from "../utils/analytics";

interface CreateVersusDraftDialogProps {
    isOpen: () => boolean;
    onClose: () => void;
}

export const CreateVersusDraftDialog = (props: CreateVersusDraftDialogProps) => {
    const navigate = useNavigate();
    const [name, setName] = createSignal("");
    const [blueTeamName, setBlueTeamName] = createSignal("Team 1");
    const [redTeamName, setRedTeamName] = createSignal("Team 2");
    const [description, setDescription] = createSignal("");
    const [length, setLength] = createSignal(3);
    const [competitive, setCompetitive] = createSignal(false);
    const [icon, setIcon] = createSignal("");
    const [showIconPicker, setShowIconPicker] = createSignal(false);
    const [type, setType] = createSignal("standard");
    const [errors, setErrors] = createSignal<Record<string, string>>({});
    const [disabledChampions, setDisabledChampions] = createSignal<string[]>([]);
    const [disabledExpanded, setDisabledExpanded] = createSignal(false);

    const mutation = useMutation(() => ({
        mutationFn: createVersusDraft,
        onSuccess: (versusDraft) => {
            toast.success("Versus draft created successfully!");
            track("versus_created", {
                type: type(),
                length: length(),
                competitive: competitive()
            });
            props.onClose();
            navigate(`/versus/join/${versusDraft.shareLink}`);
        },
        onError: (error: Error) => {
            toast.error("Failed to create versus draft");
            console.error(error);
        }
    }));

    createEffect(() => {
        if (props.isOpen()) {
            setName("");
            setBlueTeamName("Team 1");
            setRedTeamName("Team 2");
            setDescription("");
            setLength(3);
            setCompetitive(false);
            setIcon("");
            setType("standard");
            setErrors({});
            setDisabledChampions([]);
            setDisabledExpanded(false);
        }
    });

    const validateForm = (): boolean => {
        const newErrors: Record<string, string> = {};

        if (!name().trim()) {
            newErrors.name = "Name is required";
        }
        if (!blueTeamName().trim()) {
            newErrors.blueTeamName = "Team 1 name is required";
        }
        if (!redTeamName().trim()) {
            newErrors.redTeamName = "Team 2 name is required";
        }

        setErrors(newErrors);
        return Object.keys(newErrors).length === 0;
    };

    const handleSubmit = (e: Event) => {
        e.preventDefault();

        if (!validateForm()) return;

        mutation.mutate({
            name: name().trim(),
            blueTeamName: blueTeamName().trim(),
            redTeamName: redTeamName().trim(),
            description: description().trim() || undefined,
            length: length(),
            competitive: competitive(),
            icon: icon(),
            type: type(),
            disabledChampions: disabledChampions()
        });
    };

    return (
        <Dialog
            isOpen={props.isOpen}
            onCancel={props.onClose}
            body={
                <div class="w-[500px]">
                    <h2 class="mb-4 text-xl font-bold text-slate-50">
                        Create Versus Draft
                    </h2>
                    <form onSubmit={handleSubmit} class="space-y-4">
                        <div>
                            <label class="mb-2 block text-sm font-medium text-slate-300">
                                Series Name
                            </label>
                            <input
                                type="text"
                                value={name()}
                                onInput={(e) => setName(e.currentTarget.value)}
                                class="w-full rounded-md border border-slate-600 bg-slate-700 px-3 py-2 text-slate-50 focus:border-orange-500 focus:outline-none"
                                placeholder="Enter series name"
                            />
                            {errors().name && (
                                <p class="mt-1 text-sm text-red-400">{errors().name}</p>
                            )}
                        </div>

                        <div class="grid grid-cols-2 gap-4">
                            <div>
                                <label class="mb-2 block text-sm font-medium text-slate-300">
                                    Team 1 Name
                                </label>
                                <input
                                    type="text"
                                    value={blueTeamName()}
                                    onInput={(e) =>
                                        setBlueTeamName(e.currentTarget.value)
                                    }
                                    class="w-full rounded-md border border-slate-600 bg-slate-700 px-3 py-2 text-slate-50 focus:border-blue-500 focus:outline-none"
                                />
                                {errors().blueTeamName && (
                                    <p class="mt-1 text-sm text-red-400">
                                        {errors().blueTeamName}
                                    </p>
                                )}
                            </div>

                            <div>
                                <label class="mb-2 block text-sm font-medium text-slate-300">
                                    Team 2 Name
                                </label>
                                <input
                                    type="text"
                                    value={redTeamName()}
                                    onInput={(e) => setRedTeamName(e.currentTarget.value)}
                                    class="w-full rounded-md border border-slate-600 bg-slate-700 px-3 py-2 text-slate-50 focus:border-red-500 focus:outline-none"
                                />
                                {errors().redTeamName && (
                                    <p class="mt-1 text-sm text-red-400">
                                        {errors().redTeamName}
                                    </p>
                                )}
                            </div>
                        </div>

                        <div>
                            <label class="mb-2 block text-sm font-medium text-slate-300">
                                Description (Optional)
                            </label>
                            <textarea
                                value={description()}
                                onInput={(e) => setDescription(e.currentTarget.value)}
                                class="w-full rounded-md border border-slate-600 bg-slate-700 px-3 py-2 text-slate-50 focus:border-orange-500 focus:outline-none"
                                rows="3"
                                placeholder="Add a description..."
                            />
                        </div>

                        <div>
                            <label class="mb-2 block text-sm font-medium text-slate-300">
                                Icon (Optional)
                            </label>
                            <button
                                type="button"
                                onClick={() => setShowIconPicker(true)}
                                class="flex h-16 w-full items-center gap-3 rounded border border-slate-600 bg-slate-700 px-3 py-2 text-slate-50 hover:bg-slate-600"
                            >
                                <Show
                                    when={icon()}
                                    fallback={
                                        <div class="flex h-12 w-12 items-center justify-center rounded bg-slate-600">
                                            <Plus size={24} class="text-slate-400" />
                                        </div>
                                    }
                                >
                                    <div class="flex h-12 w-12 items-center justify-center overflow-hidden rounded">
                                        <Show
                                            when={!isNaN(parseInt(icon()!))}
                                            fallback={
                                                <span class="text-3xl">{icon()}</span>
                                            }
                                        >
                                            <img
                                                src={champions[parseInt(icon()!)].img}
                                                alt={champions[parseInt(icon()!)].name}
                                                class="h-full w-full object-cover"
                                            />
                                        </Show>
                                    </div>
                                </Show>
                                <span class="text-sm text-slate-300">
                                    {icon() ? "Change icon" : "Select an icon"}
                                </span>
                            </button>
                        </div>

                        <div>
                            <label class="mb-2 block text-sm font-medium text-slate-300">
                                Draft Type
                            </label>
                            <StyledSelect
                                value={type()}
                                onChange={setType}
                                theme="orange"
                                options={[
                                    { value: "standard", label: "Standard" },
                                    { value: "fearless", label: "Fearless" },
                                    { value: "ironman", label: "Ironman" }
                                ]}
                            />
                        </div>

                        <div>
                            <label class="mb-2 block text-sm font-medium text-slate-300">
                                Series Length
                            </label>
                            <StyledSelect
                                value={String(length())}
                                onChange={(val) => setLength(parseInt(val))}
                                theme="orange"
                                options={[
                                    { value: "1", label: "Best of 1" },
                                    { value: "3", label: "Best of 3" },
                                    { value: "5", label: "Best of 5" },
                                    { value: "7", label: "Best of 7" }
                                ]}
                            />
                        </div>

                        <div>
                            <label class="flex items-center space-x-2">
                                <input
                                    type="checkbox"
                                    checked={competitive()}
                                    onChange={(e) =>
                                        setCompetitive(e.currentTarget.checked)
                                    }
                                    class="h-4 w-4 rounded border-slate-600 bg-slate-700 text-orange-500 focus:ring-orange-500"
                                />
                                <span class="text-sm text-slate-300">
                                    Competitive Mode
                                </span>
                            </label>
                            <p class="mt-1 text-xs text-slate-400">
                                In competitive mode, pauses and pick changes require
                                approval from both teams
                            </p>
                        </div>

                        {/* Disabled Champions */}
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
                                        {disabledChampions().length > 0
                                            ? `${disabledChampions().length} disabled`
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
                                        selectedChampions={disabledChampions}
                                        onToggle={(champId) => {
                                            setDisabledChampions((prev) =>
                                                prev.includes(champId)
                                                    ? prev.filter((id) => id !== champId)
                                                    : [...prev, champId]
                                            );
                                        }}
                                        theme="orange"
                                    />
                                </div>
                            </Show>
                        </div>

                        <div class="flex justify-end space-x-3 pt-4">
                            <button
                                type="button"
                                onClick={props.onClose}
                                class="rounded-md bg-slate-600 px-4 py-2 text-sm font-medium text-slate-50 hover:bg-slate-500"
                                disabled={mutation.isPending}
                            >
                                Cancel
                            </button>
                            <button
                                type="submit"
                                class="rounded-md bg-orange-600 px-4 py-2 text-sm font-medium text-white hover:bg-orange-500 disabled:opacity-50"
                                disabled={mutation.isPending}
                            >
                                {mutation.isPending ? "Creating..." : "Create Series"}
                            </button>
                        </div>
                    </form>

                    <IconPicker
                        isOpen={showIconPicker}
                        onClose={() => setShowIconPicker(false)}
                        onSelect={(selectedIcon) => setIcon(selectedIcon)}
                        currentIcon={icon()}
                        theme="orange"
                    />
                </div>
            }
        />
    );
};
