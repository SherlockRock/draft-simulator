import { createSignal, createEffect, createMemo, Show } from "solid-js";
import { Dialog } from "./Dialog";
import toast from "solid-toast";
import { Plus } from "lucide-solid";
import { IconPicker } from "./IconPicker";
import { champions } from "../utils/constants";
import { VersusDraft } from "../utils/schemas";
import { StyledSelect } from "./StyledSelect";

interface EditVersusDraftDialogProps {
    isOpen: () => boolean;
    onClose: () => void;
    versusDraft: VersusDraft;
    onSuccess?: () => void;
}

export const EditVersusDraftDialog = (props: EditVersusDraftDialogProps) => {
    const [name, setName] = createSignal("");
    const [blueTeamName, setBlueTeamName] = createSignal("");
    const [redTeamName, setRedTeamName] = createSignal("");
    const [description, setDescription] = createSignal("");
    const [competitive, setCompetitive] = createSignal(false);
    const [icon, setIcon] = createSignal("");
    const [showIconPicker, setShowIconPicker] = createSignal(false);
    const [type, setType] = createSignal("standard");
    const [length, setLength] = createSignal(1);
    const [isSubmitting, setIsSubmitting] = createSignal(false);
    const [errors, setErrors] = createSignal<Record<string, string>>({});

    const hasStarted = createMemo(() => {
        const drafts = props.versusDraft.Drafts || [];
        if (drafts.length === 0) return false;
        const firstDraft = drafts[0];
        return (
            firstDraft.picks && firstDraft.picks.some((p: string | null) => p && p !== "")
        );
    });

    createEffect(() => {
        if (props.isOpen()) {
            setName(props.versusDraft.name || "");
            setBlueTeamName(props.versusDraft.blueTeamName || "Team 1");
            setRedTeamName(props.versusDraft.redTeamName || "Team 2");
            setDescription(props.versusDraft.description || "");
            setCompetitive(props.versusDraft.competitive || false);
            setIcon(props.versusDraft.icon || "");
            setType(props.versusDraft.type || "standard");
            setLength(props.versusDraft.length || 1);
            setErrors({});
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

    const handleSubmit = async (e: Event) => {
        e.preventDefault();

        if (!validateForm()) return;

        setIsSubmitting(true);
        try {
            const response = await fetch(
                `${import.meta.env.VITE_API_URL}/api/versus-drafts/${props.versusDraft.id}`,
                {
                    method: "PUT",
                    headers: { "Content-Type": "application/json" },
                    credentials: "include",
                    body: JSON.stringify({
                        name: name().trim(),
                        blueTeamName: blueTeamName().trim(),
                        redTeamName: redTeamName().trim(),
                        description: description().trim() || undefined,
                        competitive: competitive(),
                        icon: icon(),
                        type: type(),
                        length: length()
                    })
                }
            );

            if (!response.ok) throw new Error("Failed to update versus draft");

            toast.success("Versus draft updated successfully!");
            props.onSuccess?.();
            props.onClose();
        } catch (error) {
            toast.error("Failed to update versus draft");
            console.error(error);
        } finally {
            setIsSubmitting(false);
        }
    };

    return (
        <Dialog
            isOpen={props.isOpen}
            onCancel={props.onClose}
            body={
                <div class="w-[500px]">
                    <h2 class="mb-4 text-xl font-bold text-slate-50">
                        Edit Versus Draft
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

                        <Show when={!hasStarted()}>
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
                        </Show>

                        <Show when={!hasStarted()}>
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
                        </Show>

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

                        <div class="flex justify-end space-x-3 pt-4">
                            <button
                                type="button"
                                onClick={props.onClose}
                                class="rounded-md bg-slate-600 px-4 py-2 text-sm font-medium text-slate-50 hover:bg-slate-500"
                                disabled={isSubmitting()}
                            >
                                Cancel
                            </button>
                            <button
                                type="submit"
                                class="rounded-md bg-orange-600 px-4 py-2 text-sm font-medium text-white hover:bg-orange-500 disabled:opacity-50"
                                disabled={isSubmitting()}
                            >
                                {isSubmitting() ? "Saving..." : "Save Changes"}
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
