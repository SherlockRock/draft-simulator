import {
    Component,
    createResource,
    createEffect,
    createSignal,
    createMemo,
    onCleanup,
    Show,
    For,
    type JSX
} from "solid-js";
import { useParams, useNavigate, RouteSectionProps } from "@solidjs/router";
import { useQueryClient, useMutation, useQuery } from "@tanstack/solid-query";
import { useUser } from "../userProvider";
import {
    fetchCanvasList,
    fetchCanvas,
    fetchCanvasUsers,
    updateCanvasUserPermission,
    removeUserFromCanvas,
    generateCanvasShareLink,
    copyDraftInCanvas,
    deleteDraftFromCanvas,
    deleteCanvas,
    updateCanvasName,
    updateCanvasCardLayout
} from "../utils/actions";
import { getLocalCanvas, hasLocalCanvas } from "../utils/localCanvasStore";
import FlowPanel from "../components/FlowPanel";
import { VersionFooter } from "../components/VersionFooter";
import CanvasSelector from "../components/CanvasSelector";
import { Dialog } from "../components/Dialog";
import { CanvasSettingsDialog } from "../components/CanvasSettingsDialog";
import { FlowBackLink } from "../components/FlowBackLink";
import { Check, Copy, X } from "lucide-solid";
import toast from "solid-toast";
import { CanvasGroup, CanvasDraft } from "../utils/schemas";
import { CanvasAccessDenied, AccessErrorType } from "../components/CanvasAccessDenied";
import { DraftContextMenu } from "../components/DraftContextMenu";
import { GroupContextMenu } from "../components/GroupContextMenu";
import {
    localCopyDraft,
    localDeleteDraft,
    localUpdateCardLayout
} from "../utils/useLocalCanvasMutations";
import { CanvasContext } from "../contexts/CanvasContext";
import { CanvasSocketProvider } from "../providers/CanvasSocketProvider";
import type { CardLayout } from "../utils/canvasCardLayout";
import { champions } from "../utils/constants";
import { getRestrictedChampionsByGame } from "../utils/seriesRestrictions";
import {
    getGroupRestrictedChampionsByDraft,
    parseDraftMode
} from "../utils/groupRestrictions";
import type { RestrictionGroup } from "../components/ChampionPanel";
import { cardWidth } from "../utils/helpers";

const ChampionStrip: Component<{
    championIds: string[];
    tint?: "default" | "disabled";
}> = (props) => {
    const visibleChampionIds = createMemo(() =>
        props.championIds.filter((id) => id !== "")
    );

    return (
        <Show when={visibleChampionIds().length > 0}>
            <div class="flex flex-wrap gap-1">
                <For each={visibleChampionIds()}>
                    {(championId) => {
                        const champion = champions[parseInt(championId)];
                        if (!champion) {
                            return null;
                        }
                        return (
                            <img
                                src={champion.img}
                                alt={champion.name}
                                title={champion.name}
                                class={`h-7 w-7 rounded object-cover ${
                                    props.tint === "disabled"
                                        ? "border border-red-700/60 opacity-75"
                                        : "border border-darius-border"
                                }`}
                            />
                        );
                    }}
                </For>
            </div>
        </Show>
    );
};

const TREE_CONNECTOR_WIDTH_CLASS = "w-6";
const TREE_CONNECTOR_STROKE_CLASS = "bg-darius-purple-bright/35";
const TREE_CONNECTOR_THICKNESS_CLASS = "w-0.5";
const TREE_CONNECTOR_BRANCH_THICKNESS_CLASS = "h-0.5";
const TREE_CONNECTOR_BRANCH_OFFSET_CLASS = "left-[2px]";
const TREE_CONNECTOR_END_CAP_CLASS = "h-[calc(50%+1px)]";

const RestrictionTreeRow: Component<{
    continueAbove?: boolean;
    continueBelow?: boolean;
    branch?: boolean;
    contentClass?: string;
    children: JSX.Element;
}> = (props) => {
    return (
        <div class="flex items-stretch">
            <div class={`relative ml-[11px] shrink-0 ${TREE_CONNECTOR_WIDTH_CLASS}`}>
                <Show when={props.continueAbove}>
                    <div
                        class={`absolute left-0 ${TREE_CONNECTOR_THICKNESS_CLASS} ${TREE_CONNECTOR_STROKE_CLASS} ${
                            props.continueBelow
                                ? "bottom-0 top-0"
                                : `top-0 ${TREE_CONNECTOR_END_CAP_CLASS}`
                        }`}
                    />
                </Show>
                <Show when={props.continueBelow}>
                    <div
                        class={`absolute bottom-0 left-0 ${TREE_CONNECTOR_THICKNESS_CLASS} ${TREE_CONNECTOR_STROKE_CLASS} ${
                            props.continueAbove ? "hidden" : "h-1/2"
                        }`}
                    />
                </Show>
                <Show when={props.branch}>
                    <div
                        class={`absolute right-0 top-[calc(50%-1px)] ${TREE_CONNECTOR_BRANCH_OFFSET_CLASS} ${TREE_CONNECTOR_BRANCH_THICKNESS_CLASS} ${TREE_CONNECTOR_STROKE_CLASS}`}
                    />
                </Show>
            </div>
            <div class={`min-w-0 flex-1 ${props.contentClass ?? ""}`}>
                {props.children}
            </div>
        </div>
    );
};

const CanvasWorkflow: Component<RouteSectionProps> = (props) => {
    const params = useParams();
    const queryClient = useQueryClient();
    const accessor = useUser();
    const [user] = accessor();

    // Route parameter accessor with type narrowing
    // Returns empty string during route transitions/cleanup when params.id is undefined
    const canvasId = (): string => {
        return params.id ?? "";
    };

    const [canvasList, { mutate: mutateCanvasList, refetch: refetchCanvasList }] =
        createResource(
            // Source signal: re-run when user auth state changes
            () => user(),
            async (currentUser) => {
                if (!currentUser) {
                    if (hasLocalCanvas()) {
                        const local = getLocalCanvas()!;
                        return [
                            { id: "local", name: local.name, updatedAt: local.createdAt }
                        ];
                    }
                    return [];
                }
                return fetchCanvasList();
            }
        );

    // Track canvas IDs we've already handled errors for to prevent loops
    const handledErrorCanvasIds = new Set<string>();

    const [canvas, { mutate: mutateCanvas, refetch: refetchCanvas }] = createResource(
        () => (params.id !== undefined ? String(params.id) : null),
        async (id: string) => {
            if (id === "local") {
                const local = getLocalCanvas();
                if (!local) return undefined;
                return {
                    id: "local",
                    name: local.name,
                    description: local.description ?? null,
                    icon: local.icon ?? null,
                    cardLayout: local.cardLayout ?? "vertical",
                    drafts: local.drafts,
                    connections: local.connections,
                    groups: local.groups,
                    lastViewport: local.viewport,
                    userPermissions: "admin" as const
                };
            }

            try {
                return await fetchCanvas(id);
            } catch (err) {
                const error = err as Error & { status?: number };

                // Only handle once per canvas
                if (!handledErrorCanvasIds.has(id)) {
                    let errorType: AccessErrorType | null = null;
                    const status = error.status;

                    if (status === 401) {
                        errorType = "unauthorized";
                    } else if (status === 403) {
                        errorType = "forbidden";
                    } else if (status === 404) {
                        errorType = "notFound";
                    }

                    if (errorType) {
                        handledErrorCanvasIds.add(id);
                        setAccessError({ type: errorType, canvasId: id });
                    }
                }

                throw err; // Re-throw to keep resource in error state
            }
        }
    );

    const [createDraftCallback, setCreateDraftCallback] = createSignal<
        (() => void) | null
    >(null);
    const [navigateToDraftCallback, setNavigateToDraftCallback] = createSignal<
        ((positionX: number, positionY: number) => void) | null
    >(null);
    const [importCallback, setImportCallback] = createSignal<(() => void) | null>(null);
    const [createGroupCallback, setCreateGroupCallback] = createSignal<
        ((positionX: number, positionY: number) => void) | null
    >(null);
    const [setEditingGroupIdCallback, setSetEditingGroupIdCallback] = createSignal<
        ((id: string | null) => void) | null
    >(null);
    const [deleteGroupCallback, setDeleteGroupCallback] = createSignal<
        ((groupId: string) => void) | null
    >(null);
    const [setEditingDraftIdCallback, setSetEditingDraftIdCallback] = createSignal<
        ((id: string | null) => void) | null
    >(null);
    const [isManageUsersOpen, setIsManageUsersOpen] = createSignal(false);
    const [isSharePopperOpen, setIsSharePopperOpen] = createSignal(false);
    const [copied, setCopied] = createSignal("");
    const [accessError, setAccessError] = createSignal<{
        type: AccessErrorType;
        canvasId: string;
    } | null>(null);
    const [sidebarDraftContextMenu, setSidebarDraftContextMenu] = createSignal<{
        draft: CanvasDraft;
        position: { x: number; y: number };
    } | null>(null);

    const [sidebarGroupContextMenu, setSidebarGroupContextMenu] = createSignal<{
        group: CanvasGroup;
        position: { x: number; y: number };
    } | null>(null);

    let previousUser = user();

    createEffect(() => {
        const currentUser = user();
        if (!currentUser) {
            refetchCanvasList();
            if (params.id && params.id !== "local") {
                mutateCanvas(undefined);
            }
        } else if (currentUser !== previousUser) {
            refetchCanvasList();
            refetchCanvas();
        }
        previousUser = currentUser;
    });

    // Clear canvas when navigating away from detail view to dashboard
    createEffect(() => {
        if (!params.id) {
            mutateCanvas(undefined);
        }
    });

    const navigate = useNavigate();

    // Check if we're on a detail view (has an id param)
    const isDetailView = () => !!params.id;
    const isDraftView = () => !!params.draftId;

    const hasAdminPermissions = () => canvas()?.userPermissions === "admin";
    const hasEditPermissions = () =>
        canvas()?.userPermissions === "edit" || canvas()?.userPermissions === "admin";
    const cardLayout = createMemo<CardLayout>(() => canvas()?.cardLayout ?? "vertical");

    const setCardLayout = (layout: CardLayout) => {
        const currentCanvasId = canvasId();
        if (!currentCanvasId || layout === cardLayout()) return;

        if (currentCanvasId === "local") {
            localUpdateCardLayout(layout);
            const local = getLocalCanvas();
            mutateCanvas((prev) =>
                prev && local
                    ? {
                          ...prev,
                          cardLayout: local.cardLayout,
                          drafts: local.drafts,
                          connections: local.connections,
                          groups: local.groups
                      }
                    : prev
            );
            return;
        }

        if (!hasEditPermissions()) return;

        mutateCanvas((prev) => (prev ? { ...prev, cardLayout: layout } : prev));
        updateCanvasCardLayout({ canvasId: currentCanvasId, cardLayout: layout }).catch(
            (error: Error) => {
                refetchCanvas();
                toast.error(`Failed to update card layout: ${error.message}`);
            }
        );
    };

    const usersQuery = useQuery(() => ({
        queryKey: ["canvasUsers", params.id],
        enabled: isManageUsersOpen() && !!params.id,
        queryFn: () => fetchCanvasUsers(canvasId())
    }));

    const viewShareLinkQuery = useQuery(() => ({
        queryKey: ["canvasShareLink", params.id, "view"],
        queryFn: () => generateCanvasShareLink(canvasId(), "view"),
        enabled: isSharePopperOpen() && !!params.id && hasAdminPermissions(),
        staleTime: 5 * 60 * 1000,
        retry: false
    }));

    const editShareLinkQuery = useQuery(() => ({
        queryKey: ["canvasShareLink", params.id, "edit"],
        queryFn: () => generateCanvasShareLink(canvasId(), "edit"),
        enabled: isSharePopperOpen() && !!params.id && hasAdminPermissions(),
        staleTime: 5 * 60 * 1000,
        retry: false
    }));

    createEffect(() => {
        const hasError = viewShareLinkQuery.isError || editShareLinkQuery.isError;
        if (hasError && isSharePopperOpen()) {
            toast.error("Failed to generate share links. Only admins can share.");
            setIsSharePopperOpen(false);
        }
    });

    const updatePermissionMutation = useMutation(() => ({
        mutationFn: (data: { userId: string; permissions: string }) =>
            updateCanvasUserPermission(canvasId(), data.userId, data.permissions),
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ["canvasUsers", params.id] });
            toast.success("Permissions updated");
        },
        onError: (error) => {
            toast.error(`Error updating permissions: ${error.message}`);
        }
    }));

    const removeUserMutation = useMutation(() => ({
        mutationFn: (userId: string) => removeUserFromCanvas(canvasId(), userId),
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ["canvasUsers", params.id] });
            toast.success("User removed");
        },
        onError: (error) => {
            toast.error(`Error removing user: ${error.message}`);
        }
    }));

    const deleteCanvasMutation = useMutation(() => ({
        mutationFn: () => deleteCanvas(canvasId()),
        onSuccess: async () => {
            toast.success("Canvas deleted");
            setIsManageUsersOpen(false);
            // Navigate to most recent other canvas
            const list = await refetchCanvasList();
            const otherCanvas = list?.find((c) => c.id !== canvasId());
            if (otherCanvas) {
                navigate(`/canvas/${otherCanvas.id}`);
            } else {
                navigate("/canvas");
            }
        },
        onError: (error: Error) => {
            toast.error(`Failed to delete canvas: ${error.message}`);
        }
    }));

    const updateCanvasMutation = useMutation(() => ({
        mutationFn: (data: { name: string; description?: string; icon?: string }) =>
            updateCanvasName({ canvasId: canvasId(), ...data }),
        onSuccess: () => {
            toast.success("Canvas updated");
            refetchCanvas();
            queryClient.invalidateQueries({ queryKey: ["canvasList"] });
        },
        onError: (error: Error) => {
            toast.error(`Failed to update canvas: ${error.message}`);
        }
    }));

    const copyDraftMutation = useMutation(() => ({
        mutationFn: copyDraftInCanvas,
        onSuccess: () => {
            refetchCanvas();
            toast.success("Draft copied successfully");
        },
        onError: (error: Error) => {
            toast.error(`Error copying draft: ${error.message}`);
        }
    }));

    const deleteDraftMutation = useMutation(() => ({
        mutationFn: deleteDraftFromCanvas,
        onSuccess: () => {
            refetchCanvas();
            toast.success("Draft deleted successfully");
        },
        onError: (error: Error) => {
            toast.error(`Error deleting draft: ${error.message}`);
        }
    }));

    const isLocalMode = () => canvasId() === "local";

    const handleSidebarDraftContextMenu = (draft: CanvasDraft, e: MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
        setSidebarDraftContextMenu({
            draft,
            position: { x: e.clientX, y: e.clientY }
        });
    };

    const closeSidebarDraftContextMenu = () => {
        setSidebarDraftContextMenu(null);
    };

    const handleSidebarGroupContextMenu = (group: CanvasGroup, e: MouseEvent) => {
        e.preventDefault();
        setSidebarGroupContextMenu({
            group,
            position: { x: e.clientX, y: e.clientY }
        });
    };

    const closeSidebarGroupContextMenu = () => {
        setSidebarGroupContextMenu(null);
    };

    const handleSidebarDraftView = (draft: CanvasDraft) => {
        navigate(`/canvas/${canvasId()}/draft/${draft.Draft.id}`);
    };

    const handleSidebarDraftGoTo = (draft: CanvasDraft) => {
        const callback = navigateToDraftCallback();
        if (!callback) return;

        // Calculate actual position based on group membership
        const groups = (canvas()?.groups ?? []) as CanvasGroup[];
        const drafts = (canvas()?.drafts ?? []) as CanvasDraft[];
        const group = draft.group_id ? groups.find((g) => g.id === draft.group_id) : null;

        if (group && group.type === "custom") {
            callback(
                group.positionX + draft.positionX,
                group.positionY + draft.positionY
            );
        } else if (group && group.type === "series") {
            // Series groups position drafts horizontally
            const groupDrafts = drafts.filter((cd) => cd.group_id === group.id);
            const sortedDrafts = [...groupDrafts].sort(
                (a, b) => (a.Draft.seriesIndex ?? 0) - (b.Draft.seriesIndex ?? 0)
            );
            const draftIndex = sortedDrafts.findIndex(
                (cd) => cd.Draft.id === draft.Draft.id
            );
            const PADDING = 20;
            const CARD_GAP = 24;
            const cw = cardWidth(cardLayout());
            const offsetX = PADDING + draftIndex * (cw + CARD_GAP);
            callback(group.positionX + offsetX, group.positionY);
        } else {
            callback(draft.positionX, draft.positionY);
        }
    };

    const handleSidebarDraftCopy = (draft: CanvasDraft) => {
        if (isLocalMode()) {
            localCopyDraft(draft.Draft.id);
            refetchCanvas();
            toast.success("Draft copied successfully");
        } else {
            copyDraftMutation.mutate({
                canvasId: canvasId(),
                draftId: draft.Draft.id
            });
        }
    };

    const handleSidebarDraftDelete = (draft: CanvasDraft) => {
        if (confirm(`Are you sure you want to delete "${draft.Draft.name}"?`)) {
            if (isLocalMode()) {
                localDeleteDraft(draft.Draft.id);
                refetchCanvas();
                toast.success("Draft deleted successfully");
            } else {
                deleteDraftMutation.mutate({
                    canvas: canvasId(),
                    draft: draft.Draft.id
                });
            }
        }
    };

    let sharePopperRef: HTMLDivElement | undefined;
    let shareButtonRef: HTMLDivElement | undefined;

    const closeSharePopper = () => {
        setIsSharePopperOpen(false);
    };

    const handleShareCanvas = () => {
        if (isSharePopperOpen()) {
            closeSharePopper();
        } else {
            setIsSharePopperOpen(true);
        }
    };

    // Click-outside to close share popover
    createEffect(() => {
        if (isSharePopperOpen()) {
            const handler = (e: MouseEvent) => {
                const target = e.target as Node;
                if (
                    sharePopperRef &&
                    !sharePopperRef.contains(target) &&
                    shareButtonRef &&
                    !shareButtonRef.contains(target)
                ) {
                    closeSharePopper();
                }
            };
            document.addEventListener("mousedown", handler);
            onCleanup(() => {
                document.removeEventListener("mousedown", handler);
            });
        }
    });

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

    return (
        <CanvasSocketProvider>
            <CanvasContext.Provider
                value={{
                    canvas,
                    mutateCanvas,
                    refetchCanvas,
                    canvasList,
                    mutateCanvasList,
                    cardLayout,
                    setCardLayout,
                    createDraftCallback,
                    setCreateDraftCallback,
                    navigateToDraftCallback,
                    setNavigateToDraftCallback,
                    importCallback,
                    setImportCallback,
                    createGroupCallback,
                    setCreateGroupCallback,
                    refetchCanvasList,
                    setEditingGroupIdCallback,
                    setSetEditingGroupIdCallback,
                    deleteGroupCallback,
                    setDeleteGroupCallback,
                    setEditingDraftIdCallback,
                    setSetEditingDraftIdCallback,
                    openSettings: () => setIsManageUsersOpen(true),
                    toggleShare: handleShareCanvas,
                    closeSharePopper: closeSharePopper,
                    setSharePopperRef: (el: HTMLDivElement) => {
                        sharePopperRef = el;
                    },
                    setShareButtonRef: (el: HTMLDivElement) => {
                        shareButtonRef = el;
                    },
                    sharePopperContent: () =>
                        isSharePopperOpen() ? (
                            <div
                                ref={(el) => {
                                    sharePopperRef = el;
                                }}
                                class="absolute left-full top-1/2 z-50 ml-3 w-[220px] -translate-y-1/2 rounded-xl border border-darius-border bg-darius-card shadow-lg"
                            >
                                <button
                                    onClick={closeSharePopper}
                                    class="absolute right-0.5 top-0.5 flex h-6 w-6 items-center justify-center text-darius-text-primary text-darius-text-secondary transition-colors"
                                >
                                    <X size={12} />
                                </button>
                                <div class="relative flex flex-1 flex-col justify-center gap-2 px-4 py-3">
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
                                                        class="shrink-0 rounded-md bg-darius-purple p-1.5 text-darius-text-primary transition-colors hover:bg-darius-purple-bright disabled:opacity-50"
                                                        disabled={
                                                            !viewShareLinkQuery.data
                                                        }
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
                                                        class="shrink-0 rounded-md bg-darius-purple p-1.5 text-darius-text-primary transition-colors hover:bg-darius-purple-bright disabled:opacity-50"
                                                        disabled={
                                                            !editShareLinkQuery.data
                                                        }
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
                                </div>
                            </div>
                        ) : null
                }}
            >
                <Dialog
                    isOpen={isManageUsersOpen}
                    onCancel={() => setIsManageUsersOpen(false)}
                    body={
                        <Show when={canvas()}>
                            <CanvasSettingsDialog
                                isOpen={isManageUsersOpen}
                                canvas={{
                                    id: canvas()?.id ?? canvasId(),
                                    name: canvas()?.name ?? "",
                                    description: canvas()?.description,
                                    icon: canvas()?.icon
                                }}
                                usersQuery={usersQuery}
                                onPermissionChange={(userId, permission) =>
                                    updatePermissionMutation.mutate({
                                        userId,
                                        permissions: permission
                                    })
                                }
                                onRemoveUser={(userId) => {
                                    removeUserMutation.mutate(userId);
                                }}
                                onUpdateCanvas={(data) =>
                                    updateCanvasMutation.mutateAsync(data)
                                }
                                onDeleteCanvas={() => deleteCanvasMutation.mutate()}
                                onClose={() => setIsManageUsersOpen(false)}
                                isDeleting={() => deleteCanvasMutation.isPending}
                            />
                        </Show>
                    }
                />
                <div class="flex flex-1 overflow-hidden">
                    <Show when={isDetailView()}>
                        <FlowPanel flow="canvas">
                            <div class="flex h-full flex-col gap-3 py-3">
                                {/* Back to Canvas Dashboard */}
                                <Show when={!isDraftView() && canvasId() !== "local"}>
                                    <FlowBackLink
                                        flowType="canvas"
                                        label="Back to Canvas Dashboard"
                                        onClick={() => navigate("/canvas/dashboard")}
                                    />
                                </Show>

                                {/* Canvas Selector - hidden when viewing a draft or in local mode */}
                                <Show when={!isDraftView() && canvasId() !== "local"}>
                                    <div class="px-3">
                                        <CanvasSelector selectedId={canvasId()} />
                                    </div>
                                </Show>

                                {/* Back to canvas link when viewing a draft */}
                                <Show when={isDraftView()}>
                                    <FlowBackLink
                                        flowType="canvas"
                                        label="Back to Canvas"
                                        onClick={() => navigate(`/canvas/${canvasId()}`)}
                                    />
                                </Show>

                                {/* Draft list when canvas is selected */}
                                <Show when={isDetailView() && canvas()?.drafts}>
                                    {(() => {
                                        const groups = createMemo(
                                            () =>
                                                (canvas()?.groups ?? []) as CanvasGroup[]
                                        );
                                        const drafts = createMemo(
                                            () =>
                                                (canvas()?.drafts ?? []) as CanvasDraft[]
                                        );
                                        const ungroupedDrafts = createMemo(() =>
                                            drafts().filter((d) => !d.group_id)
                                        );
                                        const activeCanvasDraft = createMemo(() =>
                                            drafts().find(
                                                (canvasDraft) =>
                                                    canvasDraft.Draft.id ===
                                                    params.draftId
                                            )
                                        );
                                        const activeGroup = createMemo(() => {
                                            const currentDraft = activeCanvasDraft();
                                            if (!currentDraft?.group_id) {
                                                return undefined;
                                            }
                                            return groups().find(
                                                (group) =>
                                                    group.id === currentDraft.group_id
                                            );
                                        });
                                        const activeSiblingDrafts = createMemo(() => {
                                            const group = activeGroup();
                                            if (!group) return [];
                                            return drafts().filter(
                                                (canvasDraft) =>
                                                    canvasDraft.group_id === group.id
                                            );
                                        });
                                        const activeRestrictionMode = createMemo(() => {
                                            const group = activeGroup();
                                            if (!group) return undefined;
                                            if (group.type === "series") {
                                                return parseDraftMode(
                                                    group.metadata.seriesType
                                                );
                                            }
                                            return group.metadata.draftMode;
                                        });
                                        const activeRestrictionGroups = createMemo(
                                            (): RestrictionGroup[] => {
                                                const currentDraft = activeCanvasDraft();
                                                const group = activeGroup();
                                                const mode = activeRestrictionMode();
                                                if (
                                                    !currentDraft ||
                                                    !group ||
                                                    !mode ||
                                                    mode === "standard"
                                                ) {
                                                    return [];
                                                }

                                                const siblingDrafts =
                                                    activeSiblingDrafts();

                                                if (group.type === "series") {
                                                    const seriesIndex =
                                                        siblingDrafts.find(
                                                            (canvasDraft) =>
                                                                canvasDraft.Draft.id ===
                                                                currentDraft.Draft.id
                                                        )?.Draft.seriesIndex ?? 0;

                                                    return getRestrictedChampionsByGame(
                                                        mode,
                                                        siblingDrafts.map(
                                                            (canvasDraft) =>
                                                                canvasDraft.Draft
                                                        ),
                                                        seriesIndex
                                                    ).map((game) => ({
                                                        label: `Game ${game.gameNumber}`,
                                                        colorIndex: game.gameNumber,
                                                        blueBans: game.blueBans,
                                                        redBans: game.redBans,
                                                        bluePicks: game.bluePicks,
                                                        redPicks: game.redPicks
                                                    }));
                                                }

                                                return getGroupRestrictedChampionsByDraft(
                                                    mode,
                                                    siblingDrafts.map((canvasDraft) => ({
                                                        id: canvasDraft.Draft.id,
                                                        name: canvasDraft.Draft.name,
                                                        picks: canvasDraft.Draft.picks
                                                    })),
                                                    currentDraft.Draft.id
                                                ).map((draftRestriction, index) => ({
                                                    label: draftRestriction.draftName,
                                                    colorIndex: (index % 7) + 1,
                                                    blueBans: draftRestriction.blueBans,
                                                    redBans: draftRestriction.redBans,
                                                    bluePicks: draftRestriction.bluePicks,
                                                    redPicks: draftRestriction.redPicks
                                                }));
                                            }
                                        );
                                        const activeDisabledChampions = createMemo(
                                            () =>
                                                activeGroup()?.metadata
                                                    .disabledChampions ?? []
                                        );
                                        const showRestrictionBans = createMemo(
                                            () => activeRestrictionMode() === "ironman"
                                        );
                                        const activeRestrictionLabel = createMemo(() => {
                                            const mode = activeRestrictionMode();
                                            if (
                                                mode === "fearless" ||
                                                mode === "ironman"
                                            ) {
                                                return mode;
                                            }
                                            return null;
                                        });
                                        const getDraftsForGroup = (groupId: string) => {
                                            const group = groups().find(
                                                (g) => g.id === groupId
                                            );
                                            const groupDrafts = drafts().filter(
                                                (d) => d.group_id === groupId
                                            );
                                            // Sort by seriesIndex if it's a series group
                                            if (group?.type === "series") {
                                                return [...groupDrafts].sort(
                                                    (a, b) =>
                                                        (a.Draft.seriesIndex ?? 0) -
                                                        (b.Draft.seriesIndex ?? 0)
                                                );
                                            }
                                            return groupDrafts;
                                        };

                                        return (
                                            <div class="flex min-h-0 flex-1 flex-col p-3">
                                                {/* Inset container */}
                                                <div class="flex min-h-0 flex-1 flex-col border border-darius-purple-bright/20 bg-darius-bg/40">
                                                    {/* Section header - outside scroll area */}
                                                    <div class="flex items-center border-b border-darius-purple-bright/20 px-3 py-2.5">
                                                        <span class="text-[11px] font-semibold uppercase leading-none tracking-wider text-darius-text-primary">
                                                            Drafts & Groups
                                                        </span>
                                                    </div>

                                                    {/* Scrollable content */}
                                                    <div class="custom-scrollbar flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-2">
                                                        {/* Grouped drafts */}
                                                        <For each={groups()}>
                                                            {(group) => (
                                                                <div
                                                                    class={`flex flex-shrink-0 flex-col rounded ${
                                                                        isDraftView() &&
                                                                        group.id ===
                                                                            activeGroup()
                                                                                ?.id
                                                                            ? "border border-darius-purple-bright/35 bg-darius-purple/10 p-1.5"
                                                                            : ""
                                                                    }`}
                                                                >
                                                                    <div
                                                                        class={`flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm transition-colors ${
                                                                            isDraftView() &&
                                                                            group.id ===
                                                                                activeGroup()
                                                                                    ?.id
                                                                                ? "bg-darius-purple/20 text-darius-text-primary hover:bg-darius-purple/25"
                                                                                : "bg-darius-card-hover/50 text-darius-text-secondary hover:bg-darius-card-hover hover:text-darius-text-primary"
                                                                        }`}
                                                                        onClick={() => {
                                                                            const callback =
                                                                                navigateToDraftCallback();
                                                                            if (
                                                                                callback
                                                                            ) {
                                                                                callback(
                                                                                    group.positionX,
                                                                                    group.positionY
                                                                                );
                                                                            }
                                                                        }}
                                                                        onContextMenu={(
                                                                            e
                                                                        ) =>
                                                                            handleSidebarGroupContextMenu(
                                                                                group,
                                                                                e
                                                                            )
                                                                        }
                                                                    >
                                                                        <span class="flex h-4 w-4 items-center justify-center">
                                                                            <span
                                                                                class={`block h-1.5 w-1.5 rounded-full ${
                                                                                    group.type ===
                                                                                    "series"
                                                                                        ? "bg-darius-crimson"
                                                                                        : "bg-darius-purple-bright"
                                                                                }`}
                                                                            />
                                                                        </span>
                                                                        <span class="truncate text-darius-text-primary">
                                                                            {group.name}
                                                                        </span>
                                                                        <Show
                                                                            when={
                                                                                group.id ===
                                                                                    activeGroup()
                                                                                        ?.id &&
                                                                                activeRestrictionLabel()
                                                                            }
                                                                        >
                                                                            <span class="ml-auto rounded bg-darius-purple/20 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-darius-purple-bright">
                                                                                {activeRestrictionLabel()}
                                                                            </span>
                                                                        </Show>
                                                                    </div>
                                                                    <div>
                                                                        <For
                                                                            each={getDraftsForGroup(
                                                                                group.id
                                                                            )}
                                                                        >
                                                                            {(
                                                                                canvasDraft,
                                                                                index
                                                                            ) => {
                                                                                const getNavPosition =
                                                                                    () => {
                                                                                        if (
                                                                                            group.type ===
                                                                                            "custom"
                                                                                        ) {
                                                                                            return {
                                                                                                x:
                                                                                                    group.positionX +
                                                                                                    canvasDraft.positionX,
                                                                                                y:
                                                                                                    group.positionY +
                                                                                                    canvasDraft.positionY
                                                                                            };
                                                                                        }
                                                                                        const PADDING = 20;
                                                                                        const CARD_GAP = 24;
                                                                                        const cw =
                                                                                            cardWidth(
                                                                                                cardLayout()
                                                                                            );
                                                                                        const offsetX =
                                                                                            PADDING +
                                                                                            index() *
                                                                                                (cw +
                                                                                                    CARD_GAP);
                                                                                        return {
                                                                                            x:
                                                                                                group.positionX +
                                                                                                offsetX,
                                                                                            y: group.positionY
                                                                                        };
                                                                                    };

                                                                                const isLast =
                                                                                    () =>
                                                                                        index() ===
                                                                                        getDraftsForGroup(
                                                                                            group.id
                                                                                        )
                                                                                            .length -
                                                                                            1;
                                                                                const showDisabledRow =
                                                                                    () =>
                                                                                        isDraftView() &&
                                                                                        group.id ===
                                                                                            activeGroup()
                                                                                                ?.id &&
                                                                                        activeDisabledChampions()
                                                                                            .length >
                                                                                            0;
                                                                                const isCurrentRestrictionSource =
                                                                                    () =>
                                                                                        isDraftView() &&
                                                                                        group.id ===
                                                                                            activeGroup()
                                                                                                ?.id &&
                                                                                        canvasDraft
                                                                                            .Draft
                                                                                            .id !==
                                                                                            activeCanvasDraft()
                                                                                                ?.Draft
                                                                                                .id;
                                                                                const isActiveDraftRow =
                                                                                    () =>
                                                                                        isDraftView() &&
                                                                                        canvasDraft
                                                                                            .Draft
                                                                                            .id ===
                                                                                            activeCanvasDraft()
                                                                                                ?.Draft
                                                                                                .id;
                                                                                const restrictionSource =
                                                                                    createMemo(
                                                                                        () =>
                                                                                            activeRestrictionGroups().find(
                                                                                                (
                                                                                                    restrictionGroup
                                                                                                ) =>
                                                                                                    restrictionGroup.label ===
                                                                                                    (group.type ===
                                                                                                    "series"
                                                                                                        ? `Game ${(canvasDraft.Draft.seriesIndex ?? 0) + 1}`
                                                                                                        : canvasDraft
                                                                                                              .Draft
                                                                                                              .name)
                                                                                            )
                                                                                    );
                                                                                const rowChampionIds =
                                                                                    createMemo(
                                                                                        () => {
                                                                                            const source =
                                                                                                restrictionSource();
                                                                                            if (
                                                                                                !source
                                                                                            ) {
                                                                                                return [];
                                                                                            }

                                                                                            const ids =
                                                                                                showRestrictionBans()
                                                                                                    ? [
                                                                                                          ...source.blueBans,
                                                                                                          ...source.redBans,
                                                                                                          ...source.bluePicks,
                                                                                                          ...source.redPicks
                                                                                                      ]
                                                                                                    : [
                                                                                                          ...source.bluePicks,
                                                                                                          ...source.redPicks
                                                                                                      ];

                                                                                            return ids.filter(
                                                                                                (
                                                                                                    id
                                                                                                ) =>
                                                                                                    id !==
                                                                                                    ""
                                                                                            );
                                                                                        }
                                                                                    );
                                                                                const currentDraftChampionIds =
                                                                                    createMemo(
                                                                                        () => {
                                                                                            if (
                                                                                                !isActiveDraftRow()
                                                                                            ) {
                                                                                                return [];
                                                                                            }

                                                                                            const picks =
                                                                                                canvasDraft
                                                                                                    .Draft
                                                                                                    .picks ??
                                                                                                [];
                                                                                            const ids =
                                                                                                showRestrictionBans()
                                                                                                    ? picks
                                                                                                    : picks.slice(
                                                                                                          10,
                                                                                                          20
                                                                                                      );

                                                                                            return ids.filter(
                                                                                                (
                                                                                                    id
                                                                                                ) =>
                                                                                                    id !==
                                                                                                    ""
                                                                                            );
                                                                                        }
                                                                                    );
                                                                                const displayChampionIds =
                                                                                    createMemo(
                                                                                        () =>
                                                                                            isActiveDraftRow()
                                                                                                ? currentDraftChampionIds()
                                                                                                : rowChampionIds()
                                                                                    );
                                                                                const hasChampionStrip =
                                                                                    createMemo(
                                                                                        () =>
                                                                                            (isCurrentRestrictionSource() ||
                                                                                                isActiveDraftRow()) &&
                                                                                            displayChampionIds()
                                                                                                .length >
                                                                                                0
                                                                                    );

                                                                                return (
                                                                                    <>
                                                                                        <RestrictionTreeRow
                                                                                            continueAbove
                                                                                            continueBelow={
                                                                                                hasChampionStrip() ||
                                                                                                !isLast() ||
                                                                                                showDisabledRow()
                                                                                            }
                                                                                            branch
                                                                                            contentClass={
                                                                                                index() ===
                                                                                                0
                                                                                                    ? "pt-2"
                                                                                                    : "pt-2"
                                                                                            }
                                                                                        >
                                                                                            <div
                                                                                                class={`cursor-pointer truncate rounded px-2 py-1.5 text-sm transition-colors ${
                                                                                                    isDraftView() &&
                                                                                                    canvasDraft
                                                                                                        .Draft
                                                                                                        .id ===
                                                                                                        params.draftId
                                                                                                        ? "bg-darius-purple/30 text-darius-text-primary hover:bg-darius-purple/35"
                                                                                                        : "bg-darius-card-hover/50 text-darius-text-primary hover:bg-darius-card-hover"
                                                                                                }`}
                                                                                                onClick={() => {
                                                                                                    if (
                                                                                                        isDraftView()
                                                                                                    ) {
                                                                                                        navigate(
                                                                                                            `/canvas/${canvasId()}/draft/${canvasDraft.Draft.id}`
                                                                                                        );
                                                                                                    } else {
                                                                                                        const callback =
                                                                                                            navigateToDraftCallback();
                                                                                                        if (
                                                                                                            callback
                                                                                                        ) {
                                                                                                            const pos =
                                                                                                                getNavPosition();
                                                                                                            callback(
                                                                                                                pos.x,
                                                                                                                pos.y
                                                                                                            );
                                                                                                        }
                                                                                                    }
                                                                                                }}
                                                                                                onContextMenu={(
                                                                                                    e
                                                                                                ) => {
                                                                                                    if (
                                                                                                        hasEditPermissions()
                                                                                                    ) {
                                                                                                        handleSidebarDraftContextMenu(
                                                                                                            canvasDraft,
                                                                                                            e
                                                                                                        );
                                                                                                    }
                                                                                                }}
                                                                                            >
                                                                                                {
                                                                                                    canvasDraft
                                                                                                        .Draft
                                                                                                        .name
                                                                                                }
                                                                                            </div>
                                                                                        </RestrictionTreeRow>
                                                                                        <Show
                                                                                            when={hasChampionStrip()}
                                                                                        >
                                                                                            <RestrictionTreeRow
                                                                                                continueAbove
                                                                                                continueBelow={
                                                                                                    !isLast() ||
                                                                                                    showDisabledRow()
                                                                                                }
                                                                                                contentClass="pb-2 pt-1"
                                                                                            >
                                                                                                <div class="px-2">
                                                                                                    <ChampionStrip
                                                                                                        championIds={displayChampionIds()}
                                                                                                    />
                                                                                                </div>
                                                                                            </RestrictionTreeRow>
                                                                                        </Show>
                                                                                    </>
                                                                                );
                                                                            }}
                                                                        </For>
                                                                        <Show
                                                                            when={
                                                                                isDraftView() &&
                                                                                group.id ===
                                                                                    activeGroup()
                                                                                        ?.id &&
                                                                                activeDisabledChampions()
                                                                                    .length >
                                                                                    0
                                                                            }
                                                                        >
                                                                            <>
                                                                                <RestrictionTreeRow
                                                                                    continueAbove
                                                                                    continueBelow
                                                                                >
                                                                                    <div class="px-2 pt-1 text-[10px] font-semibold uppercase tracking-wider text-darius-crimson">
                                                                                        Disabled
                                                                                    </div>
                                                                                </RestrictionTreeRow>
                                                                                <RestrictionTreeRow
                                                                                    continueAbove
                                                                                    branch
                                                                                    contentClass="pb-2 pt-1"
                                                                                >
                                                                                    <div class="px-2">
                                                                                        <ChampionStrip
                                                                                            championIds={activeDisabledChampions()}
                                                                                            tint="disabled"
                                                                                        />
                                                                                    </div>
                                                                                </RestrictionTreeRow>
                                                                            </>
                                                                        </Show>
                                                                    </div>
                                                                </div>
                                                            )}
                                                        </For>

                                                        {/* Ungrouped drafts */}
                                                        <For each={ungroupedDrafts()}>
                                                            {(canvasDraft) => (
                                                                <div
                                                                    class={`flex-shrink-0 cursor-pointer truncate rounded px-2 py-1.5 text-sm transition-colors ${
                                                                        isDraftView() &&
                                                                        canvasDraft.Draft
                                                                            .id ===
                                                                            params.draftId
                                                                            ? "bg-darius-purple/30 text-darius-text-primary hover:bg-darius-purple/35"
                                                                            : "bg-darius-card-hover/50 text-darius-text-primary hover:bg-darius-card-hover"
                                                                    }`}
                                                                    onClick={() => {
                                                                        if (
                                                                            isDraftView()
                                                                        ) {
                                                                            navigate(
                                                                                `/canvas/${canvasId()}/draft/${canvasDraft.Draft.id}`
                                                                            );
                                                                        } else {
                                                                            const callback =
                                                                                navigateToDraftCallback();
                                                                            if (
                                                                                callback
                                                                            ) {
                                                                                callback(
                                                                                    canvasDraft.positionX,
                                                                                    canvasDraft.positionY
                                                                                );
                                                                            }
                                                                        }
                                                                    }}
                                                                    onContextMenu={(
                                                                        e
                                                                    ) => {
                                                                        if (
                                                                            hasEditPermissions()
                                                                        ) {
                                                                            handleSidebarDraftContextMenu(
                                                                                canvasDraft,
                                                                                e
                                                                            );
                                                                        }
                                                                    }}
                                                                >
                                                                    {
                                                                        canvasDraft.Draft
                                                                            .name
                                                                    }
                                                                </div>
                                                            )}
                                                        </For>
                                                    </div>
                                                </div>
                                            </div>
                                        );
                                    })()}
                                </Show>
                                <VersionFooter />
                            </div>
                        </FlowPanel>
                    </Show>
                    {/* Child routes (dashboard or detail view) render here */}
                    <Show
                        when={!accessError()}
                        fallback={
                            <CanvasAccessDenied
                                errorType={accessError()?.type ?? "notFound"}
                                onNavigateToCanvases={() => {
                                    // Navigate first, then clear error
                                    // This order is important: clearing accessError causes the
                                    // Show to switch immediately, so we must navigate before that
                                    navigate("/canvas");
                                    const err = accessError();
                                    if (err) {
                                        handledErrorCanvasIds.delete(err.canvasId);
                                    }
                                    setAccessError(null);
                                }}
                            />
                        }
                    >
                        {props.children}
                    </Show>
                    {/* Sidebar Draft Context Menu */}
                    <Show when={sidebarDraftContextMenu()}>
                        {(menu) => (
                            <DraftContextMenu
                                position={menu().position}
                                draft={menu().draft}
                                onRename={
                                    menu().draft.is_locked
                                        ? undefined
                                        : () => {
                                              handleSidebarDraftGoTo(menu().draft);
                                              setEditingDraftIdCallback()?.(
                                                  menu().draft.Draft.id
                                              );
                                              closeSidebarDraftContextMenu();
                                          }
                                }
                                onView={() => handleSidebarDraftView(menu().draft)}
                                onGoTo={() => handleSidebarDraftGoTo(menu().draft)}
                                onCopy={() => handleSidebarDraftCopy(menu().draft)}
                                onDelete={
                                    ((canvas()?.groups ?? []) as CanvasGroup[]).find(
                                        (g) =>
                                            g.id === menu().draft.group_id &&
                                            g.type === "series"
                                    )
                                        ? undefined
                                        : () => handleSidebarDraftDelete(menu().draft)
                                }
                                onClose={closeSidebarDraftContextMenu}
                            />
                        )}
                    </Show>
                    {/* Sidebar Group Context Menu */}
                    <Show when={sidebarGroupContextMenu()}>
                        {(menu) => (
                            <GroupContextMenu
                                position={menu().position}
                                group={menu().group}
                                onRename={() => {
                                    const callback = navigateToDraftCallback();
                                    if (callback) {
                                        callback(
                                            menu().group.positionX,
                                            menu().group.positionY
                                        );
                                    }
                                    setEditingGroupIdCallback()?.(menu().group.id);
                                    closeSidebarGroupContextMenu();
                                }}
                                onViewSeries={() => {
                                    const group = menu().group;
                                    if (group.versus_draft_id) {
                                        navigate(`/versus/${group.versus_draft_id}`);
                                    }
                                    closeSidebarGroupContextMenu();
                                }}
                                onGoTo={() => {
                                    const callback = navigateToDraftCallback();
                                    if (callback) {
                                        callback(
                                            menu().group.positionX,
                                            menu().group.positionY
                                        );
                                    }
                                    closeSidebarGroupContextMenu();
                                }}
                                onDelete={() => {
                                    deleteGroupCallback()?.(menu().group.id);
                                    closeSidebarGroupContextMenu();
                                }}
                                onClose={closeSidebarGroupContextMenu}
                            />
                        )}
                    </Show>
                </div>
            </CanvasContext.Provider>
        </CanvasSocketProvider>
    );
};

export default CanvasWorkflow;
