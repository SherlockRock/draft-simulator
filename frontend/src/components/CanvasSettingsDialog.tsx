import { Component, createSignal, createEffect, Show } from "solid-js";
import { Plus } from "lucide-solid";
import { Dialog, EscapeKeyHint, ReturnKeyHint } from "./Dialog";
import { IconPicker } from "./IconPicker";
import { IconDisplay } from "./IconDisplay";

// User management lives in the unified Share popover (SharePopover.tsx);
// this dialog covers only the canvas itself: name, description, icon, delete.
type TabType = "details" | "delete";

interface CanvasSettingsDialogProps {
    canvas: {
        id: string;
        name: string;
        description?: string | null;
        icon?: string | null;
    };
    onUpdateCanvas: (data: {
        name: string;
        description?: string;
        icon?: string;
    }) => Promise<{ name: string; id: string }>;
    onDeleteCanvas: () => void;
    onClose: () => void;
    isOpen: () => boolean;
    /** Optional: pass mutation.isPending for accurate loading state */
    isDeleting?: () => boolean;
}

export const CanvasSettingsDialog: Component<CanvasSettingsDialogProps> = (props) => {
    // Tab state
    const [activeTab, setActiveTab] = createSignal<TabType>("details");

    // Form state
    const [name, setName] = createSignal("");
    const [description, setDescription] = createSignal("");
    const [icon, setIcon] = createSignal("");

    // UI state
    const [showIconPicker, setShowIconPicker] = createSignal(false);
    const [showDeleteConfirm, setShowDeleteConfirm] = createSignal(false);
    const [isSaving, setIsSaving] = createSignal(false);
    const [internalIsDeleting, setInternalIsDeleting] = createSignal(false);
    const [errors, setErrors] = createSignal<Record<string, string>>({});

    // Use prop if provided, otherwise use internal state
    const isDeleting = () => props.isDeleting?.() ?? internalIsDeleting();

    // Initialize form values when dialog opens or canvas changes
    createEffect(() => {
        if (props.isOpen()) {
            setName(props.canvas.name);
            setDescription(props.canvas.description ?? "");
            setIcon(props.canvas.icon ?? "");
            setActiveTab("details");
            setShowDeleteConfirm(false);
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

    const handleSave = async () => {
        if (!validateForm()) return;

        setIsSaving(true);
        try {
            await props.onUpdateCanvas({
                name: name().trim(),
                description: description().trim() || undefined,
                icon: icon() || undefined
            });
            props.onClose();
        } catch {
            // Error handling is done by the mutation's onError callback
        } finally {
            setIsSaving(false);
        }
    };

    const handleDelete = () => {
        // Set internal state as fallback if parent doesn't provide isDeleting prop
        setInternalIsDeleting(true);
        props.onDeleteCanvas();
        // Note: onDeleteCanvas should handle closing the dialog and navigation
        // If parent provides isDeleting prop, it reflects actual mutation state
    };

    const hasChanges = () => {
        return (
            name().trim() !== props.canvas.name ||
            (description().trim() || "") !== (props.canvas.description ?? "") ||
            (icon() || "") !== (props.canvas.icon ?? "")
        );
    };

    const handleDialogConfirm = () => {
        if (showIconPicker()) return;
        if (activeTab() === "details" && hasChanges() && !isSaving()) {
            void handleSave();
        } else if (activeTab() === "delete" && showDeleteConfirm() && !isDeleting()) {
            handleDelete();
        }
    };

    const tabClasses = (tab: TabType) => {
        const base = "px-4 py-2 text-sm font-medium transition-colors";
        if (activeTab() === tab) {
            return `${base} border-b-2 border-darius-purple-bright text-darius-purple-bright`;
        }
        return `${base} text-darius-text-secondary hover:text-darius-text-primary`;
    };

    return (
        <Dialog
            isOpen={props.isOpen}
            onCancel={props.onClose}
            onConfirm={handleDialogConfirm}
            shouldConfirmOnTarget={(target) => target instanceof HTMLInputElement}
            body={
                <div class="flex h-[490px] w-[500px] flex-col text-darius-text-primary">
                    <h2 class="mb-4 text-xl font-bold text-darius-text-primary">
                        Canvas Settings
                    </h2>

                    {/* Tab Bar */}
                    <div class="flex gap-2 border-b border-darius-border">
                        <button
                            type="button"
                            class={tabClasses("details")}
                            onClick={() => setActiveTab("details")}
                        >
                            Details
                        </button>
                        <button
                            type="button"
                            class={tabClasses("delete")}
                            onClick={() => setActiveTab("delete")}
                        >
                            Delete
                        </button>
                    </div>

                    {/* Tab Content Area - fixed height, each tab fills this */}
                    <div class="mt-6 flex min-h-0 flex-1 flex-col">
                        {/* Details Tab */}
                        <Show when={activeTab() === "details"}>
                            <div class="flex flex-1 flex-col space-y-4">
                                <div>
                                    <label
                                        class="mb-2 block text-sm font-medium text-darius-text-secondary"
                                        for="settings-canvas-name"
                                    >
                                        Canvas Name
                                    </label>
                                    <input
                                        id="settings-canvas-name"
                                        type="text"
                                        value={name()}
                                        onInput={(e) => {
                                            setName(e.currentTarget.value);
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
                                        <p class="mt-1 text-sm text-red-400">
                                            {errors().name}
                                        </p>
                                    )}
                                </div>

                                <div>
                                    <label
                                        class="mb-2 block text-sm font-medium text-darius-text-secondary"
                                        for="settings-canvas-description"
                                    >
                                        Description (optional)
                                    </label>
                                    <textarea
                                        id="settings-canvas-description"
                                        value={description()}
                                        onInput={(e) => {
                                            setDescription(e.currentTarget.value);
                                            if (errors().description) {
                                                setErrors({
                                                    ...errors(),
                                                    description: ""
                                                });
                                            }
                                        }}
                                        onBlur={() => {
                                            const error =
                                                validateDescription(description());
                                            if (error) {
                                                setErrors({
                                                    ...errors(),
                                                    description: error
                                                });
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

                                <div>
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
                                            <IconDisplay
                                                icon={icon()}
                                                size="md"
                                                class="rounded"
                                            />
                                        </Show>
                                        <span class="text-sm text-darius-text-secondary">
                                            {icon() ? "Change icon" : "Select an icon"}
                                        </span>
                                    </button>
                                </div>

                                <div class="mt-auto flex items-center justify-end gap-2 border-t border-darius-border pt-4">
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
                                        onClick={handleSave}
                                        disabled={isSaving() || !hasChanges()}
                                        class="flex items-center gap-2 rounded-md bg-darius-purple px-4 py-2 text-sm font-medium text-darius-text-primary transition-colors hover:bg-darius-purple-bright disabled:cursor-not-allowed disabled:opacity-50"
                                    >
                                        <span>{isSaving() ? "Saving..." : "Save"}</span>
                                        <Show when={!isSaving() && hasChanges()}>
                                            <ReturnKeyHint />
                                        </Show>
                                    </button>
                                </div>
                            </div>

                            <IconPicker
                                isOpen={showIconPicker}
                                onClose={() => setShowIconPicker(false)}
                                onSelect={(selectedIcon) => setIcon(selectedIcon)}
                                currentIcon={icon()}
                                theme="purple"
                            />
                        </Show>

                        {/* Delete Tab */}
                        <Show when={activeTab() === "delete"}>
                            <div class="flex flex-1 flex-col">
                                <div class="rounded-lg border border-red-500/30 bg-red-500/10 p-4">
                                    <h3 class="mb-2 text-lg font-semibold text-red-400">
                                        Danger Zone
                                    </h3>
                                    <p class="mb-4 text-sm text-darius-text-secondary">
                                        Deleting this canvas is permanent and cannot be
                                        undone. All drafts, connections, and shared access
                                        will be removed.
                                    </p>

                                    <Show
                                        when={showDeleteConfirm()}
                                        fallback={
                                            <button
                                                type="button"
                                                onClick={() => setShowDeleteConfirm(true)}
                                                class="rounded-md bg-red-500 px-4 py-2 text-sm font-medium text-white hover:bg-red-400"
                                            >
                                                Delete Canvas
                                            </button>
                                        }
                                    >
                                        <div class="space-y-3">
                                            <p class="text-sm font-medium text-red-300">
                                                This will permanently delete "
                                                {props.canvas.name}".
                                            </p>
                                            <div class="flex gap-2">
                                                <button
                                                    type="button"
                                                    onClick={() =>
                                                        setShowDeleteConfirm(false)
                                                    }
                                                    disabled={isDeleting()}
                                                    class="rounded-md bg-darius-ember px-4 py-2 text-sm font-medium text-darius-text-primary transition-[filter] hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50"
                                                >
                                                    Cancel
                                                </button>
                                                <button
                                                    type="button"
                                                    onClick={handleDelete}
                                                    disabled={isDeleting()}
                                                    class="flex items-center gap-2 rounded-md bg-red-500 px-4 py-2 text-sm font-medium text-white hover:bg-red-400 disabled:cursor-not-allowed disabled:opacity-50"
                                                >
                                                    <span>
                                                        {isDeleting()
                                                            ? "Deleting..."
                                                            : "Delete Canvas"}
                                                    </span>
                                                    <Show when={!isDeleting()}>
                                                        <ReturnKeyHint />
                                                    </Show>
                                                </button>
                                            </div>
                                        </div>
                                    </Show>
                                </div>

                                <div class="mt-auto flex justify-end border-t border-darius-border pt-4">
                                    <button
                                        type="button"
                                        onClick={props.onClose}
                                        class="flex items-center gap-2 rounded-md bg-darius-card px-4 py-2 text-sm font-medium text-darius-text-primary transition-colors hover:bg-darius-card-hover"
                                    >
                                        <span>Close</span>
                                        <EscapeKeyHint />
                                    </button>
                                </div>
                            </div>
                        </Show>
                    </div>
                </div>
            }
        />
    );
};
