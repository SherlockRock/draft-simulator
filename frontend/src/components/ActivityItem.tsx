import { Component, createSignal, Show, createEffect } from "solid-js";
import { useNavigate } from "@solidjs/router";
import { useQuery, useQueryClient, useMutation } from "@tanstack/solid-query";
import { Settings, Share2, Pencil, Loader2, Check, Copy, Plus } from "lucide-solid";
import {
    generateShareLink,
    generateVersusShareLink,
    generateCanvasShareLink,
    editDraft,
    updateCanvasName,
    fetchCanvasUsers,
    updateCanvasUserPermission,
    removeUserFromCanvas,
    editVersusDraft,
    deleteCanvas
} from "../utils/actions";
import { Activity } from "../utils/schemas";
import toast from "solid-toast";
import { Dialog } from "./Dialog";
import { CanvasSettingsDialog } from "./CanvasSettingsDialog";
import { IconPicker } from "./IconPicker";
import { IconDisplay } from "./IconDisplay";
import { champions } from "../utils/constants";
import { SelectTheme } from "../utils/selectTheme";

interface ActivityItemProps {
    activity: Activity;
}

const getThemeFromActivity = (activity: Activity): SelectTheme => {
    if (activity.resource_type === "versus") return "orange";
    if (activity.resource_type === "canvas") return "purple";
    return "teal";
};

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
    const [editIcon, setEditIcon] = createSignal("");
    const [showIconPicker, setShowIconPicker] = createSignal(false);
    const [editBlueTeamName, setEditBlueTeamName] = createSignal("");
    const [editRedTeamName, setEditRedTeamName] = createSignal("");
    const [editCompetitive, setEditCompetitive] = createSignal(false);

    let sharePopupRef: HTMLDivElement | undefined;
    let shareButtonRef: HTMLDivElement | undefined;

    // For drafts and versus - single share link
    const shareLinkQuery = useQuery(() => ({
        queryKey: ["shareLink", props.activity.resource_type, props.activity.resource_id],
        queryFn: () => {
            if (props.activity.resource_type === "draft") {
                return generateShareLink(props.activity.resource_id);
            } else if (props.activity.resource_type === "versus") {
                return generateVersusShareLink(props.activity.resource_id);
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

    createEffect(() => {
        if (isEditOpen()) {
            setEditName(props.activity.resource_name);
            setEditDescription(props.activity.description || "");
            setEditIcon(props.activity.icon || "");
            if (props.activity.resource_type === "versus") {
                setEditBlueTeamName(props.activity.blueTeamName || "Team 1");
                setEditRedTeamName(props.activity.redTeamName || "Team 2");
                setEditCompetitive(props.activity.competitive || false);
            }
            if (props.activity.resource_type === "draft") {
                setEditPublic(props.activity.public || false);
            }
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
        mutationFn: (data: {
            name: string;
            description?: string;
            public: boolean;
            icon?: string;
        }) => editDraft(props.activity.resource_id, data),
        onSuccess: () => {
            setIsEditOpen(false);
            toast.success("Draft updated successfully");
            queryClient.invalidateQueries({ queryKey: ["recentActivity"] });
        },
        onError: () => {
            toast.error("Failed to update");
        }
    }));

    const editCanvasMutation = useMutation(() => ({
        mutationFn: (data: { name: string; description?: string; icon?: string }) =>
            updateCanvasName({
                canvasId: props.activity.resource_id,
                name: data.name,
                description: data.description,
                icon: data.icon
            }),
        onSuccess: () => {
            setIsEditOpen(false);
            toast.success("Canvas updated successfully");
            queryClient.invalidateQueries({ queryKey: ["recentActivity"] });
        },
        onError: () => {
            toast.error("Failed to update");
        }
    }));

    const editVersusMutation = useMutation(() => ({
        mutationFn: (data: {
            name: string;
            description: string;
            blueTeamName: string;
            redTeamName: string;
            competitive: boolean;
            icon: string;
        }) => editVersusDraft(props.activity.resource_id, data),
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ["recentActivity"] });
            toast.success("Versus draft updated");
            setIsEditOpen(false);
        },
        onError: () => {
            toast.error("Failed to update versus draft");
        }
    }));

    const deleteCanvasMutation = useMutation(() => ({
        mutationFn: () => deleteCanvas(props.activity.resource_id),
        onSuccess: () => {
            toast.success("Canvas deleted");
            setIsManageUsersOpen(false);
            queryClient.invalidateQueries({ queryKey: ["activity"] });
            queryClient.invalidateQueries({ queryKey: ["canvasList"] });
        },
        onError: (error: Error) => {
            toast.error(`Failed to delete canvas: ${error.message}`);
        }
    }));

    const getDefaultIcon = () => {
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
                    badge: "bg-blue-500/20 text-blue-300",
                    text: "text-blue-400",
                    accent: "bg-blue-500",
                    gradient: "from-blue-500/5 to-transparent"
                };
            case "canvas":
                return {
                    badge: "bg-purple-500/20 text-purple-300",
                    text: "text-purple-400",
                    accent: "bg-purple-500",
                    gradient: "from-purple-500/5 to-transparent"
                };
            case "versus":
                return {
                    badge: "bg-orange-500/20 text-orange-300",
                    text: "text-orange-400",
                    accent: "bg-orange-500",
                    gradient: "from-orange-500/5 to-transparent"
                };
            default:
                return {
                    badge: "bg-blue-500/20 text-blue-300",
                    text: "text-slate-400",
                    accent: "bg-teal-500",
                    gradient: "from-teal-500/5 to-transparent"
                };
        }
    };

    const formatTimestamp = (timestamp: string) => {
        const date = new Date(timestamp);
        const now = new Date();
        const diffMs = now.getTime() - date.getTime();
        const diffMsFinal = diffMs < 0 ? 0 : diffMs;
        const diffMins = Math.floor(diffMsFinal / 60000);
        const diffHours = Math.floor(diffMsFinal / 3600000);
        const diffDays = Math.floor(diffMsFinal / 86400000);

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
        if (props.activity.resource_type === "canvas") {
            return; // Canvas uses CanvasSettingsDialog
        }
        setEditName(props.activity.resource_name);
        setEditDescription(props.activity.description || "");
        setEditPublic(props.activity.public ?? false);
        setEditIcon(props.activity.icon || "");
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
                public: editPublic(),
                icon: editIcon()
            });
        } else if (props.activity.resource_type === "canvas") {
            editCanvasMutation.mutate({
                name: editName(),
                description: editDescription(),
                icon: editIcon()
            });
        } else if (props.activity.resource_type === "versus") {
            editVersusMutation.mutate({
                name: editName(),
                description: editDescription(),
                blueTeamName: editBlueTeamName(),
                redTeamName: editRedTeamName(),
                competitive: editCompetitive(),
                icon: editIcon()
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
            class="relative flex cursor-pointer overflow-hidden rounded-lg border border-slate-700/50 bg-slate-800 transition-all hover:bg-slate-700/80"
        >
            {/* Subtle gradient overlay */}
            <div
                class={`pointer-events-none absolute inset-0 bg-gradient-to-r ${colors.gradient}`}
            />

            {/* Side accent stripe */}
            <div class={`w-1.5 flex-shrink-0 ${colors.accent}`} />

            {/* Content wrapper */}
            <div class="relative flex flex-1 flex-col">
                {/* Header section: icon spans title + team names rows */}
                <div class="flex gap-3 p-4 pb-2">
                    <IconDisplay
                        icon={props.activity.icon ?? undefined}
                        defaultIcon={getDefaultIcon()}
                        size="md"
                    />
                    {/* Right side: title row + team names row */}
                    <div class="flex min-w-0 flex-1 flex-col gap-1">
                        {/* Title row: title + actions */}
                        <div class="flex items-center gap-2">
                            <span
                                class={`min-w-0 flex-1 truncate text-lg font-semibold ${colors.text}`}
                            >
                                {props.activity.resource_name}
                            </span>
                            {/* Actions/badge */}
                            <Show
                                when={props.activity.is_owner}
                                fallback={
                                    <span
                                        class={`shrink-0 rounded px-2 py-1 text-center text-xs ${colors.badge}`}
                                    >
                                        Shared
                                    </span>
                                }
                            >
                                <div
                                    ref={shareButtonRef}
                                    class="relative shrink-0"
                                    onFocusOut={handleShareFocusOut}
                                >
                                    <div class="flex items-center gap-2">
                                        <Show
                                            when={
                                                props.activity.resource_type ===
                                                    "canvas" && props.activity.is_owner
                                            }
                                        >
                                            <button
                                                onClick={handleManageUsers}
                                                class={`${colors.text} transition-opacity hover:opacity-70`}
                                                title="Canvas Settings"
                                            >
                                                <Settings size={20} />
                                            </button>
                                        </Show>
                                        <button
                                            onClick={handleShare}
                                            class={`${colors.text} transition-opacity hover:opacity-70`}
                                            title="Share"
                                        >
                                            {/* TODO: DRA-40 - Review: was filled icon */}
                                            <Share2 size={20} />
                                        </button>
                                        <Show
                                            when={
                                                props.activity.resource_type !== "canvas"
                                            }
                                        >
                                            <button
                                                onClick={handleEdit}
                                                class={`${colors.text} transition-opacity hover:opacity-70`}
                                                title="Edit"
                                            >
                                                <Pencil size={20} />
                                            </button>
                                        </Show>
                                    </div>
                                </div>
                            </Show>
                        </div>
                        {/* Team names row (versus only) */}
                        <Show when={props.activity.resource_type === "versus"}>
                            <div class="flex flex-wrap items-center gap-x-2 text-sm">
                                <span class="text-blue-400">
                                    {props.activity.blueTeamName}
                                </span>
                                <span class="text-slate-500">vs</span>
                                <span class="text-red-400">
                                    {props.activity.redTeamName}
                                </span>
                            </div>
                        </Show>
                    </div>
                </div>

                {/* Description - full width from left edge */}
                <Show when={props.activity.description}>
                    <p class="line-clamp-2 px-4 text-sm text-slate-300">
                        {props.activity.description}
                    </p>
                </Show>

                {/* Spacer to push footer to bottom */}
                <div class="flex-1" />

                {/* Footer row: timestamp left, badges right */}
                <div class="flex items-center justify-between px-4 pb-3 pt-2">
                    <span class="text-sm text-slate-400">
                        {formatTimestamp(props.activity.timestamp)}
                    </span>
                    <Show when={props.activity.resource_type === "versus"}>
                        <div class="flex items-center gap-2">
                            <span
                                class="rounded px-2 py-0.5 text-xs"
                                classList={{
                                    "bg-indigo-500/20 text-indigo-300":
                                        props.activity.length === 1,
                                    "bg-teal-500/20 text-teal-300":
                                        props.activity.length === 3,
                                    "bg-emerald-500/20 text-emerald-300":
                                        props.activity.length === 5,
                                    "bg-pink-500/20 text-pink-300":
                                        props.activity.length === 7
                                }}
                            >
                                Bo{props.activity.length}
                            </span>
                            <Show
                                when={props.activity.competitive}
                                fallback={
                                    <span class="rounded bg-sky-500/20 px-2 py-0.5 text-xs text-sky-300">
                                        Scrim
                                    </span>
                                }
                            >
                                <span class="rounded bg-amber-500/20 px-2 py-0.5 text-xs text-amber-300">
                                    Competitive
                                </span>
                            </Show>
                            <Show when={props.activity.type}>
                                <span
                                    class="rounded px-2 py-0.5 text-xs"
                                    classList={{
                                        "bg-cyan-500/20 text-cyan-300":
                                            props.activity.type === "standard",
                                        "bg-fuchsia-500/20 text-fuchsia-300":
                                            props.activity.type === "fearless",
                                        "bg-lime-500/20 text-lime-300":
                                            props.activity.type === "ironman"
                                    }}
                                >
                                    {(
                                        props.activity.type?.charAt(0) ?? ""
                                    ).toUpperCase() +
                                        (props.activity.type?.slice(1) ?? "")}
                                </span>
                            </Show>
                        </div>
                    </Show>
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
                                    <Loader2
                                        size={20}
                                        class="animate-spin text-teal-400"
                                    />
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
                                            <>
                                                {/* TODO: DRA-40 - Review: was filled icon */}
                                                <Check size={16} />
                                            </>
                                        }
                                    >
                                        <Copy size={16} />
                                    </Show>
                                </button>
                            </div>
                        </Show>
                    </Show>
                </div>
            </Show>

            {/* Edit Dialog */}
            <Dialog
                isOpen={isEditOpen}
                onCancel={() => setIsEditOpen(false)}
                body={
                    <div class="w-[28rem]">
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
                        <div class="mb-4">
                            <label class="mb-2 block text-sm font-medium text-slate-200">
                                Icon (optional)
                            </label>
                            <button
                                type="button"
                                onClick={() => setShowIconPicker(true)}
                                class="flex h-16 w-full items-center gap-3 rounded border border-slate-600 bg-slate-700 px-3 py-2 text-slate-50 hover:bg-slate-600"
                            >
                                <Show
                                    when={editIcon()}
                                    fallback={
                                        <div class="flex h-12 w-12 items-center justify-center rounded bg-slate-800">
                                            <Plus size={24} class="text-slate-400" />
                                        </div>
                                    }
                                >
                                    <div class="flex h-12 w-12 items-center justify-center overflow-hidden rounded">
                                        <Show
                                            when={!isNaN(parseInt(editIcon()!))}
                                            fallback={
                                                <span class="text-3xl">{editIcon()}</span>
                                            }
                                        >
                                            <img
                                                src={champions[parseInt(editIcon()!)].img}
                                                alt={
                                                    champions[parseInt(editIcon()!)].name
                                                }
                                                class="h-full w-full object-cover"
                                            />
                                        </Show>
                                    </div>
                                </Show>
                                <span class="text-sm text-slate-300">
                                    {editIcon() ? "Change icon" : "Select an icon"}
                                </span>
                            </button>
                        </div>
                        <Show when={props.activity.resource_type === "versus"}>
                            <div class="mb-4 grid grid-cols-2 gap-4">
                                <div>
                                    <label class="mb-2 block text-sm font-medium text-slate-200">
                                        Team 1
                                    </label>
                                    <input
                                        type="text"
                                        value={editBlueTeamName()}
                                        onInput={(e) =>
                                            setEditBlueTeamName(e.currentTarget.value)
                                        }
                                        class="w-full rounded-md border border-slate-600 bg-slate-700 px-3 py-2 text-blue-400 focus:outline-none focus:ring-2 focus:ring-blue-500"
                                    />
                                </div>
                                <div>
                                    <label class="mb-2 block text-sm font-medium text-slate-200">
                                        Team 2
                                    </label>
                                    <input
                                        type="text"
                                        value={editRedTeamName()}
                                        onInput={(e) =>
                                            setEditRedTeamName(e.currentTarget.value)
                                        }
                                        class="w-full rounded-md border border-slate-600 bg-slate-700 px-3 py-2 text-red-400 focus:outline-none focus:ring-2 focus:ring-red-500"
                                    />
                                </div>
                            </div>
                            <div class="mb-4">
                                <label class="flex items-center gap-2 text-sm font-medium text-slate-200">
                                    <input
                                        type="checkbox"
                                        checked={editCompetitive()}
                                        onChange={(e) =>
                                            setEditCompetitive(e.currentTarget.checked)
                                        }
                                        class="h-4 w-4 rounded border-slate-600 bg-slate-700 accent-orange-500 focus:ring-2 focus:ring-teal-500"
                                    />
                                    Competitive Mode
                                </label>
                                <p class="mt-1 text-xs text-slate-400">
                                    Pauses and pick changes require approval from both
                                    teams
                                </p>
                            </div>
                        </Show>
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
                }
            />

            {/* Icon Picker */}
            <IconPicker
                isOpen={showIconPicker}
                onClose={() => setShowIconPicker(false)}
                onSelect={(selectedIcon) => setEditIcon(selectedIcon)}
                currentIcon={editIcon()}
                theme={getThemeFromActivity(props.activity)}
            />

            {/* Canvas Settings Dialog */}
            <CanvasSettingsDialog
                isOpen={isManageUsersOpen}
                canvas={{
                    id: props.activity.resource_id,
                    name: props.activity.resource_name,
                    description: props.activity.description,
                    icon: props.activity.icon
                }}
                usersQuery={usersQuery}
                onPermissionChange={handlePermissionChange}
                onRemoveUser={handleRemoveUser}
                onUpdateCanvas={(data) =>
                    editCanvasMutation.mutateAsync({
                        name: data.name,
                        description: data.description,
                        icon: data.icon
                    })
                }
                onDeleteCanvas={() => deleteCanvasMutation.mutate()}
                onClose={() => setIsManageUsersOpen(false)}
                isDeleting={() => deleteCanvasMutation.isPending}
            />
        </div>
    );
};

export default ActivityItem;
