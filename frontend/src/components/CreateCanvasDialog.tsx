import { createSignal, createEffect, Show, For } from "solid-js";
import { Dialog } from "./Dialog";
import { createCanvas } from "../utils/actions";
import toast from "solid-toast";
import { Plus } from "lucide-solid";
import { IconPicker } from "./IconPicker";
import { champions } from "../utils/constants";
import { useUser } from "../userProvider";
import { createEmptyLocalCanvas, saveLocalCanvas } from "../utils/localCanvasStore";
import { DEFAULT_CARD_LAYOUT, layoutOptions } from "../utils/canvasCardLayout";
import type { CardLayout } from "../utils/canvasCardLayout";
import { layoutIconMap } from "./LayoutIcons";

interface CreateCanvasDialogProps {
    isOpen: () => boolean;
    onClose: () => void;
    onSuccess?: (canvasId: string) => void;
}

export const CreateCanvasDialog = (props: CreateCanvasDialogProps) => {
    const accessor = useUser();
    const [user] = accessor();
    const [name, setName] = createSignal("");
    const [description, setDescription] = createSignal("");
    const [icon, setIcon] = createSignal("");
    const [cardLayout, setCardLayout] = createSignal<CardLayout>(DEFAULT_CARD_LAYOUT);
    const [showIconPicker, setShowIconPicker] = createSignal(false);
    const [isSubmitting, setIsSubmitting] = createSignal(false);
    const [errors, setErrors] = createSignal<Record<string, string>>({});

    // Reset form when dialog opens
    createEffect(() => {
        if (props.isOpen()) {
            setName("");
            setDescription("");
            setIcon("");
            setCardLayout(DEFAULT_CARD_LAYOUT);
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
            if (!user()) {
                // Anon user: create local canvas
                const local = createEmptyLocalCanvas(
                    name().trim(),
                    description().trim() || undefined,
                    icon(),
                    cardLayout()
                );
                saveLocalCanvas(local);
                toast.success("Canvas created!");
                props.onSuccess?.("local");
            } else {
                const result = await createCanvas({
                    name: name().trim(),
                    description: description().trim() || undefined,
                    icon: icon(),
                    cardLayout: cardLayout()
                });

                toast.success("Canvas created successfully!");
                props.onSuccess?.(result.canvas.id);
            }
        } catch (error) {
            toast.error("Failed to create canvas");
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
                    <h2 class="mb-4 text-xl font-bold text-darius-text-primary">
                        Create New Canvas
                    </h2>
                    <form onSubmit={handleSubmit}>
                        <div class="mb-4">
                            <label
                                class="mb-2 block text-sm font-medium text-darius-text-secondary"
                                for="canvas-name"
                            >
                                Canvas Name
                            </label>
                            <input
                                id="canvas-name"
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
                                class="w-full appearance-none rounded border border-darius-border bg-darius-card px-3 py-2 leading-tight text-darius-text-primary shadow focus:outline-none focus:ring-2 focus:ring-darius-purple-bright"
                            />
                            {errors().name && (
                                <p class="mt-1 text-sm text-red-400">{errors().name}</p>
                            )}
                        </div>

                        <div class="mb-6">
                            <label
                                class="mb-2 block text-sm font-medium text-darius-text-secondary"
                                for="canvas-description"
                            >
                                Description (optional)
                            </label>
                            <textarea
                                id="canvas-description"
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
                                class="w-full appearance-none rounded border border-darius-border bg-darius-card px-3 py-2 leading-tight text-darius-text-primary shadow focus:outline-none focus:ring-2 focus:ring-darius-purple-bright"
                            />
                            <div class="mt-1 flex items-center justify-between">
                                {errors().description ? (
                                    <p class="text-sm text-red-400">
                                        {errors().description}
                                    </p>
                                ) : (
                                    <p class="text-xs text-darius-text-secondary">
                                        {description().length}/1000 characters
                                    </p>
                                )}
                            </div>
                        </div>

                        <div class="mb-6">
                            <label class="mb-2 block text-sm font-medium text-darius-text-secondary">
                                Icon (optional)
                            </label>
                            <button
                                type="button"
                                onClick={() => setShowIconPicker(true)}
                                class="flex h-16 w-full items-center gap-3 rounded border border-darius-border bg-darius-card px-3 py-2 text-darius-text-primary transition-colors hover:bg-darius-card-hover"
                            >
                                <Show
                                    when={icon()}
                                    fallback={
                                        <div class="flex h-12 w-12 items-center justify-center rounded bg-darius-card-hover">
                                            <Plus
                                                size={24}
                                                class="text-darius-text-secondary"
                                            />
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
                                <span class="text-sm text-darius-text-secondary">
                                    {icon() ? "Change icon" : "Select an icon"}
                                </span>
                            </button>
                        </div>

                        <div class="mb-6">
                            <label class="mb-2 block text-sm font-medium text-darius-text-secondary">
                                Card Layout
                            </label>
                            <div class="grid grid-cols-2 gap-1.5">
                                <For each={layoutOptions}>
                                    {(option) => (
                                        <button
                                            type="button"
                                            onClick={() => setCardLayout(option.value)}
                                            class="flex items-center gap-2 rounded-md border px-2 py-1.5 text-left transition-colors"
                                            classList={{
                                                "border-darius-purple-bright bg-darius-purple/15":
                                                    cardLayout() === option.value,
                                                "border-darius-border bg-darius-card hover:border-darius-purple-bright/40 hover:bg-darius-card-hover":
                                                    cardLayout() !== option.value
                                            }}
                                        >
                                            <div class="flex-none">
                                                {layoutIconMap[option.value]({
                                                    size: 32
                                                })}
                                            </div>
                                            <div class="min-w-0 text-xs font-medium text-darius-text-primary">
                                                {option.label}
                                            </div>
                                        </button>
                                    )}
                                </For>
                            </div>
                        </div>

                        <div class="flex items-center justify-end gap-2">
                            <button
                                type="button"
                                onClick={props.onClose}
                                class="rounded-md bg-darius-card px-4 py-2 text-sm font-medium text-darius-text-primary transition-colors hover:bg-darius-card-hover"
                            >
                                Cancel
                            </button>
                            <button
                                type="submit"
                                disabled={isSubmitting()}
                                class="rounded-md bg-darius-ember bg-darius-ember px-4 py-2 text-sm font-medium text-darius-text-primary disabled:cursor-not-allowed disabled:opacity-50"
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
                        theme="purple"
                    />
                </div>
            }
        />
    );
};
