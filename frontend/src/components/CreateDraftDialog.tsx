import { createSignal, createEffect, Show } from "solid-js";
import { Dialog } from "./Dialog";
import { createDraft } from "../utils/actions";
import toast from "solid-toast";
import { IconPicker } from "./IconPicker";
import { champions } from "../utils/constants";

interface CreateDraftDialogProps {
    isOpen: () => boolean;
    onClose: () => void;
    onSuccess?: (draftId: string) => void;
}

export const CreateDraftDialog = (props: CreateDraftDialogProps) => {
    const [name, setName] = createSignal("");
    const [description, setDescription] = createSignal("");
    const [isPublic, setIsPublic] = createSignal(true);
    const [icon, setIcon] = createSignal("");
    const [showIconPicker, setShowIconPicker] = createSignal(false);
    const [isSubmitting, setIsSubmitting] = createSignal(false);
    const [errors, setErrors] = createSignal<Record<string, string>>({});

    // Reset form when dialog opens
    createEffect(() => {
        if (props.isOpen()) {
            setName("");
            setDescription("");
            setIsPublic(true);
            setIcon("");
            setErrors({});
        }
    });

    const validateName = (value: string): string | null => {
        if (!value || value.trim().length === 0) {
            return "Name is required";
        }
        if (value.length > 255) {
            return "Name must be less than 255 characters";
        }
        return null;
    };

    const validateDescription = (value: string): string | null => {
        if (value && value.length > 1000) {
            return "Description must be less than 1000 characters";
        }
        return null;
    };

    const validateForm = (): boolean => {
        const newErrors: Record<string, string> = {};

        const nameError = validateName(name());
        if (nameError) newErrors.name = nameError;

        const descError = validateDescription(description());
        if (descError) newErrors.description = descError;

        setErrors(newErrors);
        return Object.keys(newErrors).length === 0;
    };

    const handleSubmit = async (e: Event) => {
        e.preventDefault();

        if (!validateForm()) return;

        setIsSubmitting(true);
        try {
            const result = await createDraft({
                name: name().trim(),
                description: description().trim() || undefined,
                public: isPublic(),
                icon: icon()
            });

            toast.success("Draft created successfully!");
            props.onSuccess?.(result.id);
        } catch (error) {
            toast.error("Failed to create draft");
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
                <div class="w-96">
                    <h2 class="mb-4 text-xl font-bold text-slate-50">Create New Draft</h2>
                    <form onSubmit={handleSubmit}>
                        <div class="mb-4">
                            <label
                                class="mb-2 block text-sm font-medium text-slate-300"
                                for="draft-name"
                            >
                                Draft Name
                            </label>
                            <input
                                id="draft-name"
                                type="text"
                                value={name()}
                                onInput={(e) => {
                                    setName(e.currentTarget.value);
                                    // Clear error on input
                                    if (errors().name) {
                                        setErrors({ ...errors(), name: "" });
                                    }
                                }}
                                onBlur={() => {
                                    const error = validateName(name());
                                    if (error) {
                                        setErrors({ ...errors(), name: error });
                                    }
                                }}
                                class="w-full appearance-none rounded border border-slate-500 bg-slate-600 px-3 py-2 leading-tight text-slate-50 shadow focus:outline-none focus:ring-2 focus:ring-teal-500"
                            />
                            {errors().name && (
                                <p class="mt-1 text-sm text-red-400">{errors().name}</p>
                            )}
                        </div>

                        <div class="mb-4">
                            <label
                                class="mb-2 block text-sm font-medium text-slate-300"
                                for="draft-description"
                            >
                                Description (optional)
                            </label>
                            <textarea
                                id="draft-description"
                                value={description()}
                                onInput={(e) => {
                                    setDescription(e.currentTarget.value);
                                    // Clear error on input
                                    if (errors().description) {
                                        setErrors({ ...errors(), description: "" });
                                    }
                                }}
                                onBlur={() => {
                                    const error = validateDescription(description());
                                    if (error) {
                                        setErrors({ ...errors(), description: error });
                                    }
                                }}
                                rows={3}
                                class="w-full appearance-none rounded border border-slate-500 bg-slate-600 px-3 py-2 leading-tight text-slate-50 shadow focus:outline-none focus:ring-2 focus:ring-teal-500"
                            />
                            <div class="mt-1 flex items-center justify-between">
                                {errors().description ? (
                                    <p class="text-sm text-red-400">
                                        {errors().description}
                                    </p>
                                ) : (
                                    <p class="text-xs text-slate-400">
                                        {description().length}/1000 characters
                                    </p>
                                )}
                            </div>
                        </div>

                        <div class="mb-4">
                            <label class="mb-2 block text-sm font-medium text-slate-300">
                                Icon (optional)
                            </label>
                            <button
                                type="button"
                                onClick={() => setShowIconPicker(true)}
                                class="flex h-16 w-full items-center gap-3 rounded border border-slate-500 bg-slate-600 px-3 py-2 text-slate-50 hover:bg-slate-500"
                            >
                                <Show
                                    when={icon()}
                                    fallback={
                                        <div class="flex h-12 w-12 items-center justify-center rounded bg-slate-700">
                                            <svg
                                                xmlns="http://www.w3.org/2000/svg"
                                                class="h-6 w-6 text-slate-400"
                                                fill="none"
                                                viewBox="0 0 24 24"
                                                stroke="currentColor"
                                                stroke-width="2"
                                            >
                                                <path
                                                    stroke-linecap="round"
                                                    stroke-linejoin="round"
                                                    d="M12 4v16m8-8H4"
                                                />
                                            </svg>
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

                        <div class="mb-6">
                            <label class="flex items-center">
                                <input
                                    type="checkbox"
                                    checked={isPublic()}
                                    onChange={(e) => setIsPublic(e.currentTarget.checked)}
                                    class="mr-2 accent-teal-700 hover:accent-teal-400"
                                />
                                <span class="text-sm text-slate-200">Public</span>
                            </label>
                        </div>

                        <div class="flex items-center justify-end gap-2">
                            <button
                                type="button"
                                onClick={props.onClose}
                                class="rounded-md bg-slate-600 px-4 py-2 text-sm font-medium text-slate-200 hover:bg-slate-500"
                            >
                                Cancel
                            </button>
                            <button
                                type="submit"
                                disabled={isSubmitting()}
                                class="rounded-md bg-teal-700 px-4 py-2 text-sm font-medium text-slate-200 hover:bg-teal-600 disabled:cursor-not-allowed disabled:opacity-50"
                            >
                                {isSubmitting() ? "Creating..." : "Create"}
                            </button>
                        </div>
                    </form>

                    <IconPicker
                        isOpen={showIconPicker}
                        onClose={() => setShowIconPicker(false)}
                        onSelect={(selectedIcon) => setIcon(selectedIcon)}
                        currentIcon={icon()}
                    />
                </div>
            }
        />
    );
};
