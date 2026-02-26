import { Component, createSignal, createEffect, For, Show } from "solid-js";
import { Trash2, Plus } from "lucide-solid";
import { UseQueryResult } from "@tanstack/solid-query";
import { CanvasUser } from "../utils/schemas";
import { Dialog } from "./Dialog";
import { StyledSelect } from "./StyledSelect";
import { IconPicker } from "./IconPicker";
import { IconDisplay } from "./IconDisplay";

type TabType = "details" | "users" | "delete";

interface CanvasSettingsDialogProps {
    canvas: {
        id: string;
        name: string;
        description?: string | null;
        icon?: string | null;
    };
    usersQuery: UseQueryResult<CanvasUser[], Error>;
    onPermissionChange: (userId: string, permission: string) => void;
    onRemoveUser: (userId: string) => void;
    onUpdateCanvas: (data: { name: string; description?: string; icon?: string }) => void;
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
            props.onUpdateCanvas({
                name: name().trim(),
                description: description().trim() || undefined,
                icon: icon() || undefined
            });
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

    const tabClasses = (tab: TabType) => {
        const base = "px-4 py-2 text-sm font-medium transition-colors";
        if (activeTab() === tab) {
            return `${base} border-b-2 border-purple-500 text-purple-400`;
        }
        return `${base} text-slate-400 hover:text-slate-200`;
    };

    return (
        <Dialog
            isOpen={props.isOpen}
            onCancel={props.onClose}
            body={
                <div class="w-[500px] text-slate-200">
                    <h2 class="mb-4 text-xl font-bold text-slate-50">Canvas Settings</h2>

                    {/* Tab Bar */}
                    <div class="mb-6 flex gap-2 border-b border-slate-600">
                        <button
                            type="button"
                            class={tabClasses("details")}
                            onClick={() => setActiveTab("details")}
                        >
                            Details
                        </button>
                        <button
                            type="button"
                            class={tabClasses("users")}
                            onClick={() => setActiveTab("users")}
                        >
                            Users
                        </button>
                        <button
                            type="button"
                            class={tabClasses("delete")}
                            onClick={() => setActiveTab("delete")}
                        >
                            Delete
                        </button>
                    </div>

                    {/* Details Tab */}
                    <Show when={activeTab() === "details"}>
                        <div class="space-y-4">
                            <div>
                                <label
                                    class="mb-2 block text-sm font-medium text-slate-300"
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
                                    class="w-full appearance-none rounded border border-slate-500 bg-slate-600 px-3 py-2 leading-tight text-slate-50 shadow focus:outline-none focus:ring-2 focus:ring-purple-500"
                                />
                                {errors().name && (
                                    <p class="mt-1 text-sm text-red-400">{errors().name}</p>
                                )}
                            </div>

                            <div>
                                <label
                                    class="mb-2 block text-sm font-medium text-slate-300"
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
                                    class="w-full appearance-none rounded border border-slate-500 bg-slate-600 px-3 py-2 leading-tight text-slate-50 shadow focus:outline-none focus:ring-2 focus:ring-purple-500"
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

                            <div>
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
                                                <Plus size={24} class="text-slate-400" />
                                            </div>
                                        }
                                    >
                                        <IconDisplay
                                            icon={icon()}
                                            size="md"
                                            className="rounded"
                                        />
                                    </Show>
                                    <span class="text-sm text-slate-300">
                                        {icon() ? "Change icon" : "Select an icon"}
                                    </span>
                                </button>
                            </div>

                            <div class="flex items-center justify-end gap-2 border-t border-slate-600 pt-4">
                                <button
                                    type="button"
                                    onClick={props.onClose}
                                    class="rounded-md bg-slate-600 px-4 py-2 text-sm font-medium text-slate-200 hover:bg-slate-500"
                                >
                                    Cancel
                                </button>
                                <button
                                    type="button"
                                    onClick={handleSave}
                                    disabled={isSaving() || !hasChanges()}
                                    class="rounded-md bg-purple-500 px-4 py-2 text-sm font-medium text-slate-50 hover:bg-purple-400 disabled:cursor-not-allowed disabled:opacity-50"
                                >
                                    {isSaving() ? "Saving..." : "Save Changes"}
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

                    {/* Users Tab */}
                    <Show when={activeTab() === "users"}>
                        <div class="max-h-[50vh] space-y-3 overflow-y-auto pr-2">
                            <Show when={props.usersQuery.isLoading}>
                                <div class="text-center text-slate-400">Loading users...</div>
                            </Show>
                            <Show when={props.usersQuery.isError}>
                                <div class="text-center text-red-400">Failed to load users</div>
                            </Show>
                            <For each={props.usersQuery.data}>
                                {(user) => (
                                    <div class="flex items-center justify-between rounded bg-slate-700 p-2">
                                        <div class="flex items-center gap-2">
                                            {user.picture && (
                                                <img
                                                    src={user.picture}
                                                    class="h-8 w-8 rounded-full"
                                                    alt={user.name}
                                                />
                                            )}
                                            <div>
                                                <div class="text-sm font-medium">{user.name}</div>
                                                <div class="text-xs text-slate-400">{user.email}</div>
                                            </div>
                                        </div>
                                        <div class="flex items-center gap-2">
                                            <StyledSelect
                                                value={user.permissions}
                                                onChange={(val) =>
                                                    props.onPermissionChange(user.id, val)
                                                }
                                                theme="purple"
                                                options={[
                                                    { value: "view", label: "View" },
                                                    { value: "edit", label: "Edit" },
                                                    { value: "admin", label: "Admin" }
                                                ]}
                                                class="w-28"
                                            />
                                            <button
                                                onClick={() => props.onRemoveUser(user.id)}
                                                class="text-red-400 hover:text-red-300"
                                                title="Remove user"
                                            >
                                                <Trash2 size={20} />
                                            </button>
                                        </div>
                                    </div>
                                )}
                            </For>
                            <Show when={props.usersQuery.data?.length === 0}>
                                <p class="text-center text-slate-400">No users found.</p>
                            </Show>
                        </div>
                        <div class="mt-4 flex justify-end border-t border-slate-600 pt-4">
                            <button
                                type="button"
                                onClick={props.onClose}
                                class="rounded-md bg-slate-600 px-4 py-2 text-sm font-medium text-slate-200 hover:bg-slate-500"
                            >
                                Close
                            </button>
                        </div>
                    </Show>

                    {/* Delete Tab */}
                    <Show when={activeTab() === "delete"}>
                        <div class="space-y-4">
                            <div class="rounded-lg border border-red-500/30 bg-red-500/10 p-4">
                                <h3 class="mb-2 text-lg font-semibold text-red-400">
                                    Danger Zone
                                </h3>
                                <p class="mb-4 text-sm text-slate-300">
                                    Deleting this canvas is permanent and cannot be undone.
                                    All drafts, connections, and shared access will be removed.
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
                                            Are you sure you want to delete "{props.canvas.name}"?
                                        </p>
                                        <div class="flex gap-2">
                                            <button
                                                type="button"
                                                onClick={() => setShowDeleteConfirm(false)}
                                                disabled={isDeleting()}
                                                class="rounded-md bg-slate-600 px-4 py-2 text-sm font-medium text-slate-200 hover:bg-slate-500 disabled:cursor-not-allowed disabled:opacity-50"
                                            >
                                                Cancel
                                            </button>
                                            <button
                                                type="button"
                                                onClick={handleDelete}
                                                disabled={isDeleting()}
                                                class="rounded-md bg-red-500 px-4 py-2 text-sm font-medium text-white hover:bg-red-400 disabled:cursor-not-allowed disabled:opacity-50"
                                            >
                                                {isDeleting() ? "Deleting..." : "Yes, Delete"}
                                            </button>
                                        </div>
                                    </div>
                                </Show>
                            </div>

                            <div class="flex justify-end border-t border-slate-600 pt-4">
                                <button
                                    type="button"
                                    onClick={props.onClose}
                                    class="rounded-md bg-slate-600 px-4 py-2 text-sm font-medium text-slate-200 hover:bg-slate-500"
                                >
                                    Close
                                </button>
                            </div>
                        </div>
                    </Show>
                </div>
            }
        />
    );
};
