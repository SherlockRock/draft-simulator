import { Component, createSignal, Show, createEffect, onCleanup } from "solid-js";
import { useNavigate } from "@solidjs/router";
import { useQuery, useQueryClient, useMutation } from "@tanstack/solid-query";
import {
    Share2,
    Pencil,
    Loader2,
    Check,
    Copy,
    Plus,
    X,
    ChevronDown,
    ChevronUp,
    LayoutDashboard,
    Swords,
    FileText
} from "lucide-solid";
import {
    generateVersusShareLink,
    generateCanvasShareLink,
    updateCanvasName,
    fetchCanvasUsers,
    updateCanvasUserPermission,
    removeUserFromCanvas,
    editVersusDraft,
    deleteCanvas
} from "../utils/actions";
import { Activity } from "../utils/schemas";
import { track } from "../utils/analytics";
import toast from "solid-toast";
import { Dialog } from "./Dialog";
import { CanvasSettingsDialog } from "./CanvasSettingsDialog";
import { IconPicker } from "./IconPicker";
import { IconDisplay } from "./IconDisplay";
import { ChampionToggleGrid } from "./ChampionToggleGrid";
import { champions } from "../utils/constants";
import { DisabledChampionsReadOnly } from "./DisabledChampionsReadOnly";
import { SelectTheme } from "../utils/selectTheme";

interface ActivityItemProps {
    activity: Activity;
}

const getThemeFromActivity = (activity: Activity): SelectTheme => {
    if (activity.resource_type === "versus") return "crimson";
    return "purple";
};

const ActivityItem: Component<ActivityItemProps> = (props) => {
    const navigate = useNavigate();
    const queryClient = useQueryClient();
    const versus = () =>
        props.activity.resource_type === "versus" ? props.activity : undefined;
    const [isShareOpen, setIsShareOpen] = createSignal(false);
    const [isEditOpen, setIsEditOpen] = createSignal(false);
    const [isManageUsersOpen, setIsManageUsersOpen] = createSignal(false);
    const [copied, setCopied] = createSignal("");
    const [editName, setEditName] = createSignal(props.activity.resource_name);
    const [editDescription, setEditDescription] = createSignal(
        props.activity.description || ""
    );
    const [editIcon, setEditIcon] = createSignal("");
    const [showIconPicker, setShowIconPicker] = createSignal(false);
    const [editBlueTeamName, setEditBlueTeamName] = createSignal("");
    const [editRedTeamName, setEditRedTeamName] = createSignal("");
    const [editCompetitive, setEditCompetitive] = createSignal(false);
    const [editDisabledChampions, setEditDisabledChampions] = createSignal<string[]>([]);
    const [disabledExpanded, setDisabledExpanded] = createSignal(false);

    let shareButtonRef: HTMLDivElement | undefined;
    let cardRef: HTMLDivElement | undefined;
    let autoCloseTimer: ReturnType<typeof setTimeout> | undefined;
    const AUTO_CLOSE_MS = 10000;

    // For versus - single share link
    const shareLinkQuery = useQuery(() => ({
        queryKey: ["shareLink", props.activity.resource_type, props.activity.resource_id],
        queryFn: () => generateVersusShareLink(props.activity.resource_id),
        enabled:
            isShareOpen() &&
            props.activity.is_owner &&
            props.activity.resource_type === "versus",
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
            const v = versus();
            if (v) {
                setEditBlueTeamName(v.blueTeamName || "Team 1");
                setEditRedTeamName(v.redTeamName || "Team 2");
                setEditCompetitive(v.competitive || false);
                setEditDisabledChampions([...(v.disabledChampions ?? [])]);
                setDisabledExpanded(false);
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
            disabledChampions: string[];
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
            case "canvas":
                return <LayoutDashboard size={24} class="text-darius-purple-bright" />;
            case "versus":
                return <Swords size={24} class="text-darius-crimson" />;
            default:
                return <FileText size={24} class="text-darius-ember" />;
        }
    };

    const getColorClasses = () => {
        switch (props.activity.resource_type) {
            case "canvas":
                return {
                    title: "text-darius-purple-bright",
                    icon: "text-darius-purple-bright",
                    iconBg: "bg-darius-purple-bright/25",
                    iconRing: "ring-2 ring-inset ring-darius-purple-bright/50",
                    badge: "bg-darius-purple/15 text-darius-purple-bright",
                    action: "text-darius-purple-bright"
                };
            case "versus":
                return {
                    title: "text-darius-crimson",
                    icon: "text-darius-crimson",
                    iconBg: "bg-darius-crimson/25",
                    iconRing: "ring-2 ring-inset ring-darius-crimson/50",
                    badge: "bg-darius-crimson/15 text-darius-crimson",
                    action: "text-darius-crimson"
                };
            default:
                return {
                    title: "text-darius-ember",
                    icon: "text-darius-ember",
                    iconBg: "bg-darius-ember/25",
                    iconRing: "ring-2 ring-inset ring-darius-ember/50",
                    badge: "bg-darius-ember/15 text-darius-ember",
                    action: "text-darius-ember"
                };
        }
    };

    const isChampionIcon = () => {
        if (!props.activity.icon) return false;
        const num = parseInt(props.activity.icon);
        return !isNaN(num) && num >= 0;
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

    const closeShare = () => {
        setIsShareOpen(false);
        clearTimeout(autoCloseTimer);
    };

    const handleShare = (e: MouseEvent) => {
        e.stopPropagation();
        if (isShareOpen()) {
            closeShare();
        } else {
            setIsShareOpen(true);
            autoCloseTimer = setTimeout(closeShare, AUTO_CLOSE_MS);
        }
    };

    // Click-outside to close share view
    createEffect(() => {
        if (isShareOpen()) {
            const handler = (e: MouseEvent) => {
                if (cardRef && !cardRef.contains(e.target as Node)) {
                    closeShare();
                }
            };
            document.addEventListener("mousedown", handler);
            onCleanup(() => {
                document.removeEventListener("mousedown", handler);
                clearTimeout(autoCloseTimer);
            });
        }
    });

    const handleEdit = (e: MouseEvent) => {
        e.stopPropagation();
        if (props.activity.resource_type === "canvas") {
            setIsManageUsersOpen(true);
            return;
        }
        setEditName(props.activity.resource_name);
        setEditDescription(props.activity.description || "");
        setEditIcon(props.activity.icon || "");
        setIsEditOpen(true);
    };

    const handleCopy = () => {
        if (shareLinkQuery.data) {
            navigator.clipboard.writeText(shareLinkQuery.data);
            track("versus_shared");
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
        if (props.activity.resource_type === "canvas") {
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
                icon: editIcon(),
                disabledChampions: editDisabledChampions()
            });
        }
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
            ref={cardRef}
            onClick={handleClick}
            class="relative flex cursor-pointer overflow-hidden rounded-xl border border-darius-border bg-darius-card transition-colors hover:bg-darius-card-hover"
        >
            {/* Normal content — hidden when share is open */}
            <Show when={!isShareOpen()}>
                <div class="relative flex flex-1 flex-col">
                    {/* Header section: icon spans title + team names rows */}
                    <div class="flex gap-3 p-4 pb-3">
                        <IconDisplay
                            icon={props.activity.icon ?? undefined}
                            defaultIcon={getDefaultIcon()}
                            size="sm"
                            championImgClass={
                                isChampionIcon()
                                    ? "h-[38px] w-[38px] rounded-[7px] object-cover"
                                    : undefined
                            }
                            class={`h-11 w-11 shrink-0 rounded-lg ${isChampionIcon() ? colors.iconRing : colors.iconBg} ${colors.icon}`}
                        />
                        {/* Right side: title row + team names row */}
                        <div class="flex min-w-0 flex-1 flex-col gap-1">
                            {/* Title row: title + actions */}
                            <div class="flex items-center gap-2">
                                <span
                                    class={`min-w-0 flex-1 truncate text-lg font-semibold ${colors.title}`}
                                >
                                    {props.activity.resource_name}
                                </span>
                                {/* Actions/badge */}
                                <Show
                                    when={props.activity.is_owner}
                                    fallback={
                                        <span
                                            class={`shrink-0 rounded-md px-2 py-0.5 text-center text-xs font-medium ${colors.badge}`}
                                        >
                                            Shared
                                        </span>
                                    }
                                >
                                    <div ref={shareButtonRef} class="relative shrink-0">
                                        <div class="flex items-center gap-2">
                                            <button
                                                onClick={handleShare}
                                                class={`${colors.action} transition-opacity hover:opacity-70`}
                                                title="Share"
                                            >
                                                <Share2 size={20} />
                                            </button>
                                            <button
                                                onClick={handleEdit}
                                                class={`${colors.action} transition-opacity hover:opacity-70`}
                                                title="Edit"
                                            >
                                                <Pencil size={20} />
                                            </button>
                                        </div>
                                    </div>
                                </Show>
                            </div>
                            <Show when={props.activity.resource_type === "canvas"}>
                                <div class="text-xs font-medium text-darius-text-secondary">
                                    Canvas
                                </div>
                            </Show>
                            {/* Team names row (versus only) */}
                            <Show when={versus()}>
                                <div class="flex flex-wrap items-center gap-1.5 text-sm font-medium">
                                    <span class="text-darius-crimson">
                                        {versus()?.blueTeamName}
                                    </span>
                                    <span class="text-darius-text-secondary">vs</span>
                                    <span class="text-darius-ember">
                                        {versus()?.redTeamName}
                                    </span>
                                </div>
                            </Show>
                        </div>
                    </div>

                    {/* Description - full width from left edge */}
                    <Show when={props.activity.description}>
                        <p class="line-clamp-2 px-4 text-sm text-darius-text-secondary">
                            {props.activity.description}
                        </p>
                    </Show>

                    {/* Spacer to push footer to bottom */}
                    <div class="flex-1" />

                    {/* Footer row: timestamp left, badges right */}
                    <div class="flex items-center justify-between px-4 pb-3 pt-2">
                        <span class="text-sm text-darius-text-secondary">
                            {formatTimestamp(props.activity.timestamp)}
                        </span>
                        <Show when={versus()}>
                            <div class="flex items-center gap-1.5">
                                <span
                                    class={`rounded-md px-2 py-0.5 text-xs font-medium ${colors.badge}`}
                                >
                                    Bo{versus()?.length}
                                </span>
                                <Show
                                    when={versus()?.competitive}
                                    fallback={
                                        <span
                                            class={`rounded-md px-2 py-0.5 text-xs font-medium ${colors.badge}`}
                                        >
                                            Scrim
                                        </span>
                                    }
                                >
                                    <span
                                        class={`rounded-md px-2 py-0.5 text-xs font-medium ${colors.badge}`}
                                    >
                                        Competitive
                                    </span>
                                </Show>
                                <Show when={versus()?.type}>
                                    <span
                                        class={`rounded-md px-2 py-0.5 text-xs font-medium ${colors.badge}`}
                                    >
                                        {(versus()?.type?.charAt(0) ?? "").toUpperCase() +
                                            (versus()?.type?.slice(1) ?? "")}
                                    </span>
                                </Show>
                            </div>
                        </Show>
                    </div>
                </div>
            </Show>

            {/* Share view — replaces card content */}
            <Show when={isShareOpen()}>
                <div
                    class="relative flex flex-1 flex-col justify-center gap-2 px-4 py-3"
                    onClick={(e) => e.stopPropagation()}
                >
                    {/* Close button with countdown ring */}
                    <button
                        onClick={(e) => {
                            e.stopPropagation();
                            closeShare();
                        }}
                        class="absolute right-0.5 top-0.5 flex h-6 w-6 items-center justify-center text-darius-text-secondary transition-colors hover:text-darius-text-primary"
                    >
                        <svg class="absolute inset-0 -rotate-90" viewBox="0 0 24 24">
                            <circle
                                cx="12"
                                cy="12"
                                r="10"
                                fill="none"
                                stroke="currentColor"
                                stroke-width="1.5"
                                stroke-dasharray="62.83"
                                stroke-dashoffset="0"
                                stroke-linecap="round"
                                class="opacity-30"
                                style={`animation: countdown-unwind ${AUTO_CLOSE_MS}ms linear forwards`}
                            />
                        </svg>
                        <X size={12} />
                    </button>

                    {/* For Canvas - show both View and Edit access */}
                    <Show when={props.activity.resource_type === "canvas"}>
                        <div class="space-y-2">
                            <div>
                                <p class="mb-0.5 text-xs font-medium text-darius-text-secondary">
                                    View Access
                                </p>
                                <Show
                                    when={!viewShareLinkQuery.isPending}
                                    fallback={
                                        <div class="text-xs text-darius-text-secondary">
                                            Loading...
                                        </div>
                                    }
                                >
                                    <div class="flex items-center gap-2">
                                        <div class="selection-purple h-[26px] w-0 flex-grow cursor-text select-all truncate rounded-md border border-darius-border bg-darius-bg px-2 py-1 text-xs text-darius-text-primary">
                                            {viewShareLinkQuery.data || ""}
                                        </div>
                                        <button
                                            onClick={handleCopyViewLink}
                                            class="shrink-0 rounded-md bg-darius-purple p-1.5 text-white hover:bg-darius-purple-bright disabled:opacity-50"
                                            disabled={!viewShareLinkQuery.data}
                                        >
                                            <Show
                                                when={copied() !== "view"}
                                                fallback={<Check size={14} />}
                                            >
                                                <Copy size={14} />
                                            </Show>
                                        </button>
                                    </div>
                                </Show>
                            </div>
                            <div>
                                <p class="mb-0.5 text-xs font-medium text-darius-text-secondary">
                                    Edit Access
                                </p>
                                <Show
                                    when={!editShareLinkQuery.isPending}
                                    fallback={
                                        <div class="text-xs text-darius-text-secondary">
                                            Loading...
                                        </div>
                                    }
                                >
                                    <div class="flex items-center gap-2">
                                        <div class="selection-purple h-[26px] w-0 flex-grow cursor-text select-all truncate rounded-md border border-darius-border bg-darius-bg px-2 py-1 text-xs text-darius-text-primary">
                                            {editShareLinkQuery.data || ""}
                                        </div>
                                        <button
                                            onClick={handleCopyEditLink}
                                            class="shrink-0 rounded-md bg-darius-purple p-1.5 text-white hover:bg-darius-purple-bright disabled:opacity-50"
                                            disabled={!editShareLinkQuery.data}
                                        >
                                            <Show
                                                when={copied() !== "edit"}
                                                fallback={<Check size={14} />}
                                            >
                                                <Copy size={14} />
                                            </Show>
                                        </button>
                                    </div>
                                </Show>
                            </div>
                        </div>
                    </Show>

                    {/* For Versus/Draft - show single share link */}
                    <Show when={props.activity.resource_type !== "canvas"}>
                        <Show
                            when={!shareLinkQuery.isPending}
                            fallback={
                                <div class="flex items-center gap-2">
                                    <Loader2
                                        size={16}
                                        class="animate-spin text-darius-ember"
                                    />
                                    <span class="text-xs text-darius-text-secondary">
                                        Generating...
                                    </span>
                                </div>
                            }
                        >
                            <p class="mb-1 text-xs font-medium text-darius-text-secondary">
                                Share Link
                            </p>
                            <div class="flex items-center gap-2">
                                <div class="selection-crimson h-[26px] w-0 flex-grow cursor-text select-all truncate rounded-md border border-darius-border bg-darius-bg px-2 py-1 text-xs text-darius-text-primary">
                                    {shareLinkQuery.data || ""}
                                </div>
                                <button
                                    onClick={handleCopy}
                                    class="shrink-0 rounded-md bg-darius-crimson p-1.5 text-white hover:opacity-90"
                                    disabled={!shareLinkQuery.data}
                                >
                                    <Show
                                        when={copied() !== "single"}
                                        fallback={<Check size={14} />}
                                    >
                                        <Copy size={14} />
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
                        <h3 class="mb-4 text-xl font-bold text-darius-text-primary">
                            Edit {props.activity.resource_type}
                        </h3>
                        <div class="mb-4">
                            <label class="mb-2 block text-sm font-medium text-darius-text-primary">
                                Name
                            </label>
                            <input
                                type="text"
                                value={editName()}
                                onInput={(e) => setEditName(e.currentTarget.value)}
                                class="w-full rounded-md border border-darius-border bg-darius-card-hover px-3 py-2 text-darius-text-primary focus:outline-none focus:ring-2 focus:ring-darius-ember"
                            />
                        </div>
                        <div class="mb-4">
                            <label class="mb-2 block text-sm font-medium text-darius-text-primary">
                                Description (optional)
                            </label>
                            <textarea
                                value={editDescription()}
                                onInput={(e) => setEditDescription(e.currentTarget.value)}
                                rows={3}
                                class="w-full rounded-md border border-darius-border bg-darius-card-hover px-3 py-2 text-darius-text-primary focus:outline-none focus:ring-2 focus:ring-darius-ember"
                            />
                            <p class="mt-1 text-xs text-darius-text-secondary">
                                {editDescription().length}/1000 characters
                            </p>
                        </div>
                        <div class="mb-4">
                            <label class="mb-2 block text-sm font-medium text-darius-text-primary">
                                Icon (optional)
                            </label>
                            <button
                                type="button"
                                onClick={() => setShowIconPicker(true)}
                                class="flex h-16 w-full items-center gap-3 rounded border border-darius-border bg-darius-card-hover px-3 py-2 text-darius-text-primary hover:bg-darius-border"
                            >
                                <Show
                                    when={editIcon()}
                                    fallback={
                                        <div class="flex h-12 w-12 items-center justify-center rounded bg-darius-card">
                                            <Plus
                                                size={24}
                                                class="text-darius-text-secondary"
                                            />
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
                                <span class="text-sm text-darius-text-secondary">
                                    {editIcon() ? "Change icon" : "Select an icon"}
                                </span>
                            </button>
                        </div>
                        <Show when={props.activity.resource_type === "versus"}>
                            <div class="mb-4 grid grid-cols-2 gap-4">
                                <div>
                                    <label class="mb-2 block text-sm font-medium text-darius-text-primary">
                                        Team 1
                                    </label>
                                    <input
                                        type="text"
                                        value={editBlueTeamName()}
                                        onInput={(e) =>
                                            setEditBlueTeamName(e.currentTarget.value)
                                        }
                                        class="w-full rounded-md border border-darius-border bg-darius-card-hover px-3 py-2 text-darius-crimson focus:outline-none focus:ring-2 focus:ring-darius-crimson"
                                    />
                                </div>
                                <div>
                                    <label class="mb-2 block text-sm font-medium text-darius-text-primary">
                                        Team 2
                                    </label>
                                    <input
                                        type="text"
                                        value={editRedTeamName()}
                                        onInput={(e) =>
                                            setEditRedTeamName(e.currentTarget.value)
                                        }
                                        class="w-full rounded-md border border-darius-border bg-darius-card-hover px-3 py-2 text-darius-ember focus:outline-none focus:ring-2 focus:ring-darius-ember"
                                    />
                                </div>
                            </div>
                            <div class="mb-4">
                                <label class="flex items-center gap-2 text-sm font-medium text-darius-text-primary">
                                    <input
                                        type="checkbox"
                                        checked={editCompetitive()}
                                        onChange={(e) =>
                                            setEditCompetitive(e.currentTarget.checked)
                                        }
                                        class="h-4 w-4 rounded border-darius-border bg-darius-card-hover accent-darius-crimson focus:ring-2 focus:ring-darius-crimson"
                                    />
                                    Competitive Mode
                                </label>
                                <p class="mt-1 text-xs text-darius-text-secondary">
                                    Pauses and pick changes require approval from both
                                    teams
                                </p>
                            </div>
                            <Show when={!versus()?.hasStarted}>
                                <div class="mb-4 rounded-md border border-darius-border bg-darius-card-hover/50">
                                    <button
                                        type="button"
                                        onClick={() =>
                                            setDisabledExpanded(!disabledExpanded())
                                        }
                                        class="flex w-full items-center justify-between px-3 py-2 text-sm text-darius-text-secondary hover:text-darius-text-primary"
                                    >
                                        <span>
                                            Disabled Champions{" "}
                                            <span class="text-darius-text-secondary">
                                                (
                                                {editDisabledChampions().length > 0
                                                    ? `${editDisabledChampions().length} disabled`
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
                                                selectedChampions={editDisabledChampions}
                                                onToggle={(champId) => {
                                                    setEditDisabledChampions((prev) =>
                                                        prev.includes(champId)
                                                            ? prev.filter(
                                                                  (id) => id !== champId
                                                              )
                                                            : [...prev, champId]
                                                    );
                                                }}
                                                theme="crimson"
                                            />
                                        </div>
                                    </Show>
                                </div>
                            </Show>
                            <Show
                                when={
                                    versus()?.hasStarted &&
                                    (versus()?.disabledChampions ?? []).length > 0
                                }
                            >
                                <div class="mb-4">
                                    <DisabledChampionsReadOnly
                                        championIds={versus()?.disabledChampions ?? []}
                                    />
                                </div>
                            </Show>
                        </Show>
                        <div class="flex justify-end gap-2">
                            <button
                                onClick={() => setIsEditOpen(false)}
                                class="rounded-md bg-darius-card-hover px-4 py-2 text-darius-text-primary hover:bg-darius-border"
                            >
                                Cancel
                            </button>
                            <button
                                onClick={handleSaveEdit}
                                class="rounded-md bg-darius-ember px-4 py-2 text-white hover:opacity-90"
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
