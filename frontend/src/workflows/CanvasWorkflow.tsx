import {
    Component,
    createResource,
    createEffect,
    createSignal,
    createMemo,
    Show
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
    updateCanvasCardLayout,
    updateCanvasGroup
} from "../utils/actions";
import { getLocalCanvas, hasLocalCanvas } from "../utils/localCanvasStore";
import FlowPanel from "../components/FlowPanel";
import { VersionFooter } from "../components/VersionFooter";
import CanvasSelector from "../components/CanvasSelector";
import { Dialog } from "../components/Dialog";
import { CanvasSettingsDialog } from "../components/CanvasSettingsDialog";
import { SharePopoverContent } from "../components/SharePopover";
import { FlowBackLink } from "../components/FlowBackLink";
import toast from "solid-toast";
import { CanvasGroup, CanvasDraft, Viewport } from "../utils/schemas";
import { CanvasAccessDenied, AccessErrorType } from "../components/CanvasAccessDenied";
import { CanvasPanelTree } from "../components/CanvasPanelTree";
import {
    NO_COLLAPSE_CHOICES,
    isCollapsedAtDepth,
    toggledCollapse,
    type CollapseChoices
} from "../utils/panelCollapse";
import { DraftContextMenu } from "../components/DraftContextMenu";
import { GroupContextMenu } from "../components/GroupContextMenu";
import {
    localCopyDraft,
    localDeleteDraft,
    localUpdateCardLayout,
    localUpdateGroup
} from "../utils/useLocalCanvasMutations";
import { CanvasContext, type ShareAnchor } from "../contexts/CanvasContext";
import { CanvasSocketProvider } from "../providers/CanvasSocketProvider";
import type { CardLayout } from "../utils/canvasCardLayout";
import { getRestrictedChampionsByGame } from "../utils/seriesRestrictions";
import {
    getGroupRestrictedChampionsByDraft,
    parseDraftMode
} from "../utils/groupRestrictions";
import type { RestrictionGroup } from "../components/ChampionPanel";
import { getDraftWorldPosition } from "../utils/canvasWorldPosition";
import { resolveCopyPlacement } from "../utils/copyPlacement";
import { DEFAULT_GROUP_WIDTH, DEFAULT_GROUP_HEIGHT } from "../utils/gridLayout";

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

    /**
     * Panel collapse — per-user, EPHEMERAL view state (decision 8 as amended),
     * so it is never persisted and never broadcast. It lives here rather than
     * in the panel because `CanvasWorkflow` wraps both `/:id` and
     * `/:id/draft/:draftId`, so a collapse survives opening a draft and coming
     * back. The rule itself is in `panelCollapse.ts`, where it has tests.
     */
    const [collapseChoices, setCollapseChoices] =
        createSignal<CollapseChoices>(NO_COLLAPSE_CHOICES);
    const isGroupCollapsed = (group: CanvasGroup, depth: number) =>
        isCollapsedAtDepth(collapseChoices(), group.id, depth);
    const toggleGroupCollapsed = (group: CanvasGroup, depth: number) =>
        setCollapseChoices(toggledCollapse(collapseChoices(), group.id, depth));

    const [createDraftCallback, setCreateDraftCallback] = createSignal<
        (() => void) | null
    >(null);
    const [navigateToDraftCallback, setNavigateToDraftCallback] = createSignal<
        ((positionX: number, positionY: number) => void) | null
    >(null);
    const [jumpToViewportCallback, setJumpToViewportCallback] = createSignal<
        ((viewport: Viewport) => void) | null
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
    const [shareAnchor, setShareAnchor] = createSignal<ShareAnchor | null>(null);
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

    // The Share popover is per-canvas UI: navigating to another canvas keeps
    // this workflow mounted, so close it instead of carrying it over.
    let previousShareCanvasId = params.id;
    createEffect(() => {
        if (params.id !== previousShareCanvasId) {
            setShareAnchor(null);
        }
        previousShareCanvasId = params.id;
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

    const isLocalMode = () => canvasId() === "local";

    // The unified Share popover shows the access list to everyone with
    // canvas access; share links are admin-only, so those queries stay
    // gated on hasAdminPermissions.
    const usersQuery = useQuery(() => ({
        queryKey: ["canvasUsers", params.id],
        enabled: shareAnchor() !== null && !!params.id && !isLocalMode(),
        queryFn: () => fetchCanvasUsers(canvasId())
    }));

    const viewShareLinkQuery = useQuery(() => ({
        queryKey: ["canvasShareLink", params.id, "view"],
        queryFn: () => generateCanvasShareLink(canvasId(), "view"),
        enabled:
            shareAnchor() !== null &&
            !!params.id &&
            !isLocalMode() &&
            hasAdminPermissions(),
        staleTime: 5 * 60 * 1000,
        retry: false
    }));

    const editShareLinkQuery = useQuery(() => ({
        queryKey: ["canvasShareLink", params.id, "edit"],
        queryFn: () => generateCanvasShareLink(canvasId(), "edit"),
        enabled:
            shareAnchor() !== null &&
            !!params.id &&
            !isLocalMode() &&
            hasAdminPermissions(),
        staleTime: 5 * 60 * 1000,
        retry: false
    }));

    createEffect(() => {
        const hasError = viewShareLinkQuery.isError || editShareLinkQuery.isError;
        if (hasError && shareAnchor() !== null) {
            toast.error("Failed to generate share links. Only admins can share.");
            setShareAnchor(null);
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

    const updateGroupMutation = useMutation(() => ({
        mutationFn: updateCanvasGroup,
        onSuccess: () => {
            refetchCanvas();
        },
        onError: (error: Error) => {
            toast.error(`Failed to update group: ${error.message}`);
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

        const target = getDraftWorldPosition(
            draft,
            group,
            group ? drafts.filter((cd) => cd.group_id === group.id) : [],
            cardLayout()
        );
        callback(target.x, target.y);
    };

    const handleSidebarDraftCopy = (draft: CanvasDraft) => {
        const localCanvas = isLocalMode() ? getLocalCanvas() : null;
        const groups = isLocalMode()
            ? (localCanvas?.groups ?? [])
            : (canvas()?.groups ?? []);
        const drafts = isLocalMode()
            ? (localCanvas?.drafts ?? [])
            : (canvas()?.drafts ?? []);
        const sourceGroup = draft.group_id
            ? groups.find((group) => group.id === draft.group_id)
            : undefined;
        const placement = resolveCopyPlacement({
            draft,
            group: sourceGroup,
            tree: { groups, drafts },
            layout: cardLayout()
        });

        // Either half can be present alone: a copy can push the grid onto a new
        // row without changing the container's size, when a manual floor
        // already made it tall enough to hold it. The metadata rides in the
        // same request, never a second one.
        if (sourceGroup && (placement.groupDims || placement.groupMetadata)) {
            const dims = placement.groupDims ?? {
                width: sourceGroup.width ?? DEFAULT_GROUP_WIDTH,
                height: sourceGroup.height ?? DEFAULT_GROUP_HEIGHT
            };
            const metadata = placement.groupMetadata;
            if (isLocalMode()) {
                localUpdateGroup({
                    groupId: sourceGroup.id,
                    width: dims.width,
                    height: dims.height,
                    ...(metadata ? { metadata } : {})
                });
            } else {
                updateGroupMutation.mutate({
                    canvasId: canvasId(),
                    groupId: sourceGroup.id,
                    width: dims.width,
                    height: dims.height,
                    ...(metadata ? { metadata } : {})
                });
            }
        }

        if (isLocalMode()) {
            localCopyDraft(draft.Draft.id, {
                positionX: placement.positionX,
                positionY: placement.positionY,
                group_id: placement.group_id
            });
            refetchCanvas();
            toast.success("Draft copied successfully");
        } else {
            copyDraftMutation.mutate({
                canvasId: canvasId(),
                draftId: draft.Draft.id,
                positionX: placement.positionX,
                positionY: placement.positionY,
                group_id: placement.group_id
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

    const closeSharePopper = () => {
        setShareAnchor(null);
    };

    const openSharePopper = (anchor: ShareAnchor) => {
        setShareAnchor(anchor);
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
                    jumpToViewportCallback,
                    setJumpToViewportCallback,
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
                    shareAnchor: shareAnchor,
                    openShare: openSharePopper,
                    closeSharePopper: closeSharePopper,
                    sharePopperContent: () =>
                        shareAnchor() !== null ? (
                            <SharePopoverContent
                                isAdmin={hasAdminPermissions()}
                                usersQuery={usersQuery}
                                viewShareLinkQuery={viewShareLinkQuery}
                                editShareLinkQuery={editShareLinkQuery}
                                currentUserId={user()?.id}
                                onPermissionChange={(userId, permission) =>
                                    updatePermissionMutation.mutate({
                                        userId,
                                        permissions: permission
                                    })
                                }
                                onRemoveUser={(userId) =>
                                    removeUserMutation.mutate(userId)
                                }
                            />
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
                                                        <CanvasPanelTree
                                                            tree={() => ({
                                                                groups: groups(),
                                                                drafts: drafts()
                                                            })}
                                                            isCollapsed={isGroupCollapsed}
                                                            onToggleCollapsed={
                                                                toggleGroupCollapsed
                                                            }
                                                            isDraftView={isDraftView}
                                                            activeGroup={activeGroup}
                                                            activeDraftId={() =>
                                                                params.draftId
                                                            }
                                                            activeRestrictionLabel={
                                                                activeRestrictionLabel
                                                            }
                                                            activeDisabledChampions={
                                                                activeDisabledChampions
                                                            }
                                                            activeRestrictionGroups={
                                                                activeRestrictionGroups
                                                            }
                                                            showRestrictionBans={
                                                                showRestrictionBans
                                                            }
                                                            cardLayout={cardLayout}
                                                            canEdit={hasEditPermissions}
                                                            onOpenDraft={(draftId) =>
                                                                navigate(
                                                                    `/canvas/${canvasId()}/draft/${draftId}`
                                                                )
                                                            }
                                                            onPanTo={(x, y) =>
                                                                navigateToDraftCallback()?.(
                                                                    x,
                                                                    y
                                                                )
                                                            }
                                                            onGroupContextMenu={
                                                                handleSidebarGroupContextMenu
                                                            }
                                                            onCardContextMenu={
                                                                handleSidebarDraftContextMenu
                                                            }
                                                        />
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
