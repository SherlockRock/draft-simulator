import { Component, createSignal, Show, createEffect } from "solid-js";
import { useNavigate } from "@solidjs/router";
import { useQuery, useQueryClient, useMutation } from "@tanstack/solid-query";
import {
    generateShareLink,
    generateCanvasShareLink,
    editDraft,
    updateCanvasName,
    fetchCanvasUsers,
    updateCanvasUserPermission,
    removeUserFromCanvas
} from "../utils/actions";
import toast from "solid-toast";
import { Dialog } from "./Dialog";
import { ManageUsersDialog } from "./ManageUsersDialog";

interface Activity {
    resource_type: "draft" | "canvas" | "versus";
    resource_id: string;
    resource_name: string;
    description?: string;
    public?: boolean;
    timestamp: string;
    created_at: string;
    is_owner: boolean;
    draft_type?: "standalone" | "canvas" | "versus";
}

interface ActivityItemProps {
    activity: Activity;
}

const ActivityItem: Component<ActivityItemProps> = (props) => {
    const navigate = useNavigate();
    const queryClient = useQueryClient();
    const [isShareOpen, setIsShareOpen] = createSignal(false);
    const [isEditOpen, setIsEditOpen] = createSignal(false);
    const [isManageUsersOpen, setIsManageUsersOpen] = createSignal(false);
    const [copied, setCopied] = createSignal("");
    const [editName, setEditName] = createSignal(props.activity.resource_name);
    const [editDescription, setEditDescription] = createSignal(
        props.activity.description || ""
    );
    const [editPublic, setEditPublic] = createSignal(false);

    let sharePopupRef: HTMLDivElement | undefined;
    let shareButtonRef: HTMLDivElement | undefined;

    // For drafts and versus - single share link
    const shareLinkQuery = useQuery(() => ({
        queryKey: ["shareLink", props.activity.resource_type, props.activity.resource_id],
        queryFn: () => {
            if (
                props.activity.resource_type === "draft" ||
                props.activity.resource_type === "versus"
            ) {
                return generateShareLink(props.activity.resource_id);
            }
            return Promise.resolve("");
        },
        enabled:
            isShareOpen() &&
            props.activity.is_owner &&
            props.activity.resource_type !== "canvas",
        staleTime: 5 * 60 * 1000,
        retry: false
    }));

    // For canvas - separate view and edit links
    const viewShareLinkQuery = useQuery(() => ({
        queryKey: ["canvasShareLink", props.activity.resource_id, "view"],
        queryFn: () => generateCanvasShareLink(props.activity.resource_id, "view"),
        enabled:
            isShareOpen() &&
            props.activity.is_owner &&
            props.activity.resource_type === "canvas",
        staleTime: 5 * 60 * 1000,
        retry: false
    }));

    const editShareLinkQuery = useQuery(() => ({
        queryKey: ["canvasShareLink", props.activity.resource_id, "edit"],
        queryFn: () => generateCanvasShareLink(props.activity.resource_id, "edit"),
        enabled:
            isShareOpen() &&
            props.activity.is_owner &&
            props.activity.resource_type === "canvas",
        staleTime: 5 * 60 * 1000,
        retry: false
    }));

    createEffect(() => {
        const hasError =
            shareLinkQuery.isError ||
            viewShareLinkQuery.isError ||
            editShareLinkQuery.isError;
        if (hasError && isShareOpen()) {
            toast.error("Failed to generate share link");
            setIsShareOpen(false);
        }
    });

    const usersQuery = useQuery(() => ({
        queryKey: ["users", props.activity.resource_type, props.activity.resource_id],
        queryFn: () => {
            if (props.activity.resource_type === "canvas") {
                return fetchCanvasUsers(props.activity.resource_id);
            }
            // For drafts, return empty array for now (no endpoint available)
            return Promise.resolve([]);
        },
        enabled: isManageUsersOpen() && props.activity.is_owner
    }));

    const updatePermissionMutation = useMutation(() => ({
        mutationFn: (data: { userId: string; permission: string }) =>
            updateCanvasUserPermission(
                props.activity.resource_id,
                data.userId,
                data.permission
            ),
        onSuccess: () => {
            queryClient.invalidateQueries({
                queryKey: [
                    "users",
                    props.activity.resource_type,
                    props.activity.resource_id
                ]
            });
            toast.success("Permission updated");
        },
        onError: () => {
            toast.error("Failed to update permission");
        }
    }));

    const removeUserMutation = useMutation(() => ({
        mutationFn: (userId: string) =>
            removeUserFromCanvas(props.activity.resource_id, userId),
        onSuccess: () => {
            queryClient.invalidateQueries({
                queryKey: [
                    "users",
                    props.activity.resource_type,
                    props.activity.resource_id
                ]
            });
            toast.success("User removed");
        },
        onError: () => {
            toast.error("Failed to remove user");
        }
    }));

    const editDraftMutation = useMutation(() => ({
        mutationFn: (data: { name: string; description?: string; public: boolean }) =>
            editDraft(props.activity.resource_id, data),
        onSuccess: () => {
            setIsEditOpen(false);
            toast.success("Draft updated successfully");
            // Optionally invalidate activity queries here
        },
        onError: () => {
            toast.error("Failed to update");
        }
    }));

    const editCanvasMutation = useMutation(() => ({
        mutationFn: (data: { name: string; description?: string }) =>
            updateCanvasName({
                canvasId: props.activity.resource_id,
                name: data.name,
                description: data.description
            }),
        onSuccess: () => {
            setIsEditOpen(false);
            toast.success("Canvas updated successfully");
            // Optionally invalidate activity queries here
        },
        onError: () => {
            toast.error("Failed to update");
        }
    }));

    const getIcon = () => {
        switch (props.activity.resource_type) {
            case "draft":
                return "📄";
            case "canvas":
                return "🎨";
            case "versus":
                return "⚔️";
            default:
                return "📄";
        }
    };

    const getColorClasses = () => {
        switch (props.activity.resource_type) {
            case "draft":
                return {
                    border: "border-blue-600/50 hover:border-blue-500",
                    bg: "bg-slate-800 hover:bg-slate-700",
                    badge: "bg-blue-500/20 text-blue-300",
                    text: "text-blue-400"
                };
            case "canvas":
                return {
                    border: "border-purple-600/50 hover:border-purple-500",
                    bg: "bg-slate-800 hover:bg-slate-700",
                    badge: "bg-purple-500/20 text-purple-300",
                    text: "text-purple-400"
                };
            case "versus":
                return {
                    border: "border-orange-600/50 hover:border-orange-500",
                    bg: "bg-slate-800 hover:bg-slate-700",
                    badge: "bg-orange-500/20 text-orange-300",
                    text: "text-orange-400"
                };
            default:
                return {
                    border: "border-slate-700 hover:border-slate-600",
                    bg: "bg-slate-800 hover:bg-slate-700",
                    badge: "bg-blue-500/20 text-blue-300",
                    text: "text-slate-400"
                };
        }
    };

    const formatTimestamp = (timestamp: string) => {
        const date = new Date(timestamp);
        const now = new Date();
        const diffMs = now.getTime() - date.getTime();
        const diffMins = Math.floor(diffMs / 60000);
        const diffHours = Math.floor(diffMs / 3600000);
        const diffDays = Math.floor(diffMs / 86400000);

        if (diffMins < 60) {
            return `${diffMins} min${diffMins !== 1 ? "s" : ""} ago`;
        } else if (diffHours < 24) {
            return `${diffHours} hour${diffHours !== 1 ? "s" : ""} ago`;
        } else if (diffDays < 7) {
            return `${diffDays} day${diffDays !== 1 ? "s" : ""} ago`;
        } else {
            return date.toLocaleDateString();
        }
    };

    const handleClick = (e: MouseEvent) => {
        // Don't navigate if clicking on buttons
        if ((e.target as HTMLElement).closest("button")) {
            return;
        }
        navigate(`/${props.activity.resource_type}/${props.activity.resource_id}`);
    };

    const handleShare = (e: MouseEvent) => {
        e.stopPropagation();
        setIsShareOpen((prev) => !prev);
    };

    const handleEdit = (e: MouseEvent) => {
        e.stopPropagation();
        setEditName(props.activity.resource_name);
        setEditDescription(props.activity.description || "");
        setEditPublic(props.activity.public ?? false);
        setIsEditOpen(true);
    };

    const handleShareFocusOut = (e: FocusEvent) => {
        const relatedTarget = e.relatedTarget as Node | null;

        // Don't close if focusing within the share button container or the popup
        if (relatedTarget === null) {
            setIsShareOpen(false);
            return;
        }

        const isInButtonContainer = shareButtonRef?.contains(relatedTarget);
        const isInPopup = sharePopupRef?.contains(relatedTarget);

        if (!isInButtonContainer && !isInPopup) {
            setIsShareOpen(false);
        }
    };

    const handleCopy = () => {
        if (shareLinkQuery.data) {
            navigator.clipboard.writeText(shareLinkQuery.data);
            setCopied("single");
            setTimeout(() => setCopied(""), 2000);
        }
    };

    const handleCopyViewLink = () => {
        if (viewShareLinkQuery.data) {
            navigator.clipboard.writeText(viewShareLinkQuery.data);
            setCopied("view");
            setTimeout(() => setCopied(""), 2000);
        }
    };

    const handleCopyEditLink = () => {
        if (editShareLinkQuery.data) {
            navigator.clipboard.writeText(editShareLinkQuery.data);
            setCopied("edit");
            setTimeout(() => setCopied(""), 2000);
        }
    };

    const handleSaveEdit = () => {
        if (props.activity.resource_type === "draft") {
            editDraftMutation.mutate({
                name: editName(),
                description: editDescription(),
                public: editPublic()
            });
        } else if (props.activity.resource_type === "canvas") {
            editCanvasMutation.mutate({
                name: editName(),
                description: editDescription()
            });
        }
    };

    const handleManageUsers = (e: MouseEvent) => {
        e.stopPropagation();
        setIsManageUsersOpen(true);
    };

    const handlePermissionChange = (userId: string, permission: string) => {
        if (props.activity.resource_type === "canvas") {
            updatePermissionMutation.mutate({ userId, permission });
        }
    };

    const handleRemoveUser = (userId: string) => {
        if (props.activity.resource_type === "canvas") {
            removeUserMutation.mutate(userId);
        }
    };

    const colors = getColorClasses();

    return (
        <div
            onClick={handleClick}
            class={`relative flex cursor-pointer flex-col gap-4 rounded-lg border-2 transition-all ${colors.border} ${colors.bg}`}
        >
            <div class="flex items-center justify-between">
                <div class="flex items-center gap-4 overflow-hidden overflow-ellipsis p-4">
                    <div class="flex flex-col gap-3">
                        <span class="text-center text-5xl">{getIcon()}</span>
                        <Show
                            when={props.activity.is_owner}
                            fallback={
                                <span
                                    class={`rounded px-2 py-1 text-center text-xs ${colors.badge}`}
                                >
                                    Shared
                                </span>
                            }
                        >
                            <div
                                ref={shareButtonRef}
                                class="relative"
                                onFocusOut={handleShareFocusOut}
                            >
                                <div class="flex justify-center gap-2">
                                    <Show
                                        when={props.activity.resource_type === "canvas"}
                                    >
                                        <button
                                            onClick={handleManageUsers}
                                            class={`${colors.text} transition-opacity hover:opacity-70`}
                                            title="Manage Users"
                                        >
                                            <svg
                                                xmlns="http://www.w3.org/2000/svg"
                                                class="h-5 w-5"
                                                fill="none"
                                                viewBox="0 0 24 24"
                                                stroke="currentColor"
                                                stroke-width="2"
                                            >
                                                <path
                                                    stroke-linecap="round"
                                                    stroke-linejoin="round"
                                                    d="M12 4.354a4 4 0 110 5.292M15 21H3v-1a6 6 0 0112 0v1zm0 0h6v-1a6 6 0 00-9-5.197M13 7a4 4 0 11-8 0 4 4 0 018 0z"
                                                />
                                            </svg>
                                        </button>
                                    </Show>
                                    <button
                                        onClick={handleShare}
                                        class={`${colors.text} transition-opacity hover:opacity-70`}
                                        title="Share"
                                    >
                                        <svg
                                            xmlns="http://www.w3.org/2000/svg"
                                            class="h-5 w-5"
                                            viewBox="0 0 20 20"
                                            fill="currentColor"
                                        >
                                            <path d="M15 8a3 3 0 10-2.977-2.63l-4.94 2.47a3 3 0 100 4.319l4.94 2.47a3 3 0 10.895-1.789l-4.94-2.47a3.027 3.027 0 000-.74l4.94-2.47C13.456 7.68 14.19 8 15 8z" />
                                        </svg>
                                    </button>
                                    <button
                                        onClick={handleEdit}
                                        class={`${colors.text} transition-opacity hover:opacity-70`}
                                        title="Edit"
                                    >
                                        <svg
                                            xmlns="http://www.w3.org/2000/svg"
                                            class="h-5 w-5"
                                            fill="none"
                                            viewBox="0 0 24 24"
                                            stroke="currentColor"
                                            stroke-width="2"
                                        >
                                            <path
                                                stroke-linecap="round"
                                                stroke-linejoin="round"
                                                d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.586a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"
                                            />
                                        </svg>
                                    </button>
                                </div>
                            </div>
                        </Show>
                    </div>
                    <div class="flex max-w-full flex-col gap-2">
                        <div class="flex items-center gap-2">
                            <span
                                class={`text-lg font-semibold ${colors.text} max-w-full overflow-hidden`}
                            >
                                {props.activity.resource_name}
                            </span>
                        </div>
                        <span class="text-sm text-slate-400">
                            {formatTimestamp(props.activity.timestamp)}
                        </span>
                        <Show when={props.activity.description}>
                            <p class="line-clamp-2 text-sm text-slate-300">
                                {props.activity.description}
                            </p>
                        </Show>
                    </div>
                </div>
            </div>

            {/* Share Popup - positioned at card level to avoid overflow clipping */}
            <Show when={isShareOpen()}>
                <div
                    ref={sharePopupRef}
                    class="absolute left-4 top-20 z-10 rounded-md bg-slate-600 p-3 shadow-lg"
                    onClick={(e) => e.stopPropagation()}
                    onFocusOut={handleShareFocusOut}
                >
                    {/* For Canvas - show both View and Edit access */}
                    <Show when={props.activity.resource_type === "canvas"}>
                        <div class="space-y-3">
                            <div>
                                <p class="mb-1 text-xs font-medium text-slate-300">
                                    View Access
                                </p>
                                <Show
                                    when={!viewShareLinkQuery.isPending}
                                    fallback={
                                        <div class="text-xs text-slate-400">
                                            Loading...
                                        </div>
                                    }
                                >
                                    <div class="flex flex-col gap-2">
                                        <input
                                            type="text"
                                            readOnly
                                            value={viewShareLinkQuery.data || ""}
                                            class="w-48 rounded-md border border-gray-700 bg-gray-900 px-2 py-1 text-xs text-slate-50"
                                        />
                                        <button
                                            onClick={handleCopyViewLink}
                                            class="rounded-md bg-teal-400 px-2 py-1 text-xs text-slate-50 hover:bg-teal-700 disabled:opacity-50"
                                            disabled={!viewShareLinkQuery.data}
                                        >
                                            {copied() === "view" ? "✓ Copied" : "Copy"}
                                        </button>
                                    </div>
                                </Show>
                            </div>
                            <div>
                                <p class="mb-1 text-xs font-medium text-slate-300">
                                    Edit Access
                                </p>
                                <Show
                                    when={!editShareLinkQuery.isPending}
                                    fallback={
                                        <div class="text-xs text-slate-400">
                                            Loading...
                                        </div>
                                    }
                                >
                                    <div class="flex flex-col gap-2">
                                        <input
                                            type="text"
                                            readOnly
                                            value={editShareLinkQuery.data || ""}
                                            class="w-48 rounded-md border border-gray-700 bg-gray-900 px-2 py-1 text-xs text-slate-50"
                                        />
                                        <button
                                            onClick={handleCopyEditLink}
                                            class="rounded-md bg-teal-400 px-2 py-1 text-xs text-slate-50 hover:bg-teal-700 disabled:opacity-50"
                                            disabled={!editShareLinkQuery.data}
                                        >
                                            {copied() === "edit" ? "✓ Copied" : "Copy"}
                                        </button>
                                    </div>
                                </Show>
                            </div>
                        </div>
                    </Show>

                    {/* For Draft/Versus - show single share link */}
                    <Show when={props.activity.resource_type !== "canvas"}>
                        <Show
                            when={!shareLinkQuery.isPending}
                            fallback={
                                <div class="flex items-center gap-2 px-2 py-1">
                                    <svg
                                        class="h-5 w-5 animate-spin text-teal-400"
                                        xmlns="http://www.w3.org/2000/svg"
                                        fill="none"
                                        viewBox="0 0 24 24"
                                    >
                                        <circle
                                            class="opacity-25"
                                            cx="12"
                                            cy="12"
                                            r="10"
                                            stroke="currentColor"
                                            stroke-width="4"
                                        />
                                        <path
                                            class="opacity-75"
                                            fill="currentColor"
                                            d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                                        />
                                    </svg>
                                    <span class="text-sm text-slate-300">
                                        Generating...
                                    </span>
                                </div>
                            }
                        >
                            <p class="mb-2 text-xs font-medium text-slate-300">
                                Share Link
                            </p>
                            <div class="flex items-center gap-2">
                                <input
                                    type="text"
                                    readOnly
                                    value={shareLinkQuery.data || ""}
                                    class="w-48 rounded-md border border-gray-700 bg-gray-900 px-2 py-1 text-sm text-slate-50"
                                />
                                <button
                                    onClick={handleCopy}
                                    class="rounded-md bg-teal-400 p-2 text-slate-50 hover:bg-teal-700"
                                    disabled={!shareLinkQuery.data}
                                >
                                    <Show
                                        when={copied() !== "single"}
                                        fallback={
                                            <svg
                                                xmlns="http://www.w3.org/2000/svg"
                                                class="h-4 w-4"
                                                viewBox="0 0 20 20"
                                                fill="currentColor"
                                            >
                                                <path
                                                    fill-rule="evenodd"
                                                    d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z"
                                                    clip-rule="evenodd"
                                                />
                                            </svg>
                                        }
                                    >
                                        <svg
                                            xmlns="http://www.w3.org/2000/svg"
                                            class="h-4 w-4"
                                            fill="none"
                                            viewBox="0 0 24 24"
                                            stroke="currentColor"
                                            stroke-width="2"
                                        >
                                            <path
                                                stroke-linecap="round"
                                                stroke-linejoin="round"
                                                d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"
                                            />
                                        </svg>
                                    </Show>
                                </button>
                            </div>
                        </Show>
                    </Show>
                </div>
            </Show>

            {/* Edit Dialog */}
            <Show when={isEditOpen()}>
                <div
                    class="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
                    onClick={() => setIsEditOpen(false)}
                >
                    <div
                        class="w-full max-w-md rounded-lg bg-slate-800 p-6 shadow-xl"
                        onClick={(e) => e.stopPropagation()}
                    >
                        <h3 class="mb-4 text-xl font-bold text-slate-50">
                            Edit {props.activity.resource_type}
                        </h3>
                        <div class="mb-4">
                            <label class="mb-2 block text-sm font-medium text-slate-200">
                                Name
                            </label>
                            <input
                                type="text"
                                value={editName()}
                                onInput={(e) => setEditName(e.currentTarget.value)}
                                class="w-full rounded-md border border-slate-600 bg-slate-700 px-3 py-2 text-slate-50 focus:outline-none focus:ring-2 focus:ring-teal-500"
                            />
                        </div>
                        <div class="mb-4">
                            <label class="mb-2 block text-sm font-medium text-slate-200">
                                Description (optional)
                            </label>
                            <textarea
                                value={editDescription()}
                                onInput={(e) => setEditDescription(e.currentTarget.value)}
                                rows={3}
                                class="w-full rounded-md border border-slate-600 bg-slate-700 px-3 py-2 text-slate-50 focus:outline-none focus:ring-2 focus:ring-teal-500"
                            />
                            <p class="mt-1 text-xs text-slate-400">
                                {editDescription().length}/1000 characters
                            </p>
                        </div>
                        <Show when={props.activity.resource_type === "draft"}>
                            <div class="mb-4">
                                <label class="flex items-center gap-2 text-sm font-medium text-slate-200">
                                    <input
                                        type="checkbox"
                                        checked={editPublic()}
                                        onChange={(e) =>
                                            setEditPublic(e.currentTarget.checked)
                                        }
                                        class="h-4 w-4 rounded border-slate-600 bg-slate-700 text-teal-500 focus:ring-2 focus:ring-teal-500"
                                    />
                                    Public
                                </label>
                            </div>
                        </Show>
                        <div class="flex justify-end gap-2">
                            <button
                                onClick={() => setIsEditOpen(false)}
                                class="rounded-md bg-slate-600 px-4 py-2 text-slate-50 hover:bg-slate-500"
                            >
                                Cancel
                            </button>
                            <button
                                onClick={handleSaveEdit}
                                class="rounded-md bg-teal-600 px-4 py-2 text-slate-50 hover:bg-teal-500"
                            >
                                Save
                            </button>
                        </div>
                    </div>
                </div>
            </Show>

            {/* Manage Users Dialog */}
            <Dialog
                isOpen={isManageUsersOpen}
                onCancel={() => setIsManageUsersOpen(false)}
                body={
                    <ManageUsersDialog
                        usersQuery={usersQuery}
                        onPermissionChange={handlePermissionChange}
                        onRemoveUser={handleRemoveUser}
                        onClose={() => setIsManageUsersOpen(false)}
                    />
                }
            />
        </div>
    );
};

export default ActivityItem;
