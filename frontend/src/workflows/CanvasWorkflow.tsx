import {
    Component,
    createResource,
    createEffect,
    createSignal,
    createMemo,
    Show,
    For
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
    deleteDraftFromCanvas
} from "../utils/actions";
import { getLocalCanvas, hasLocalCanvas } from "../utils/localCanvasStore";
import FlowPanel from "../components/FlowPanel";
import { VersionFooter } from "../components/VersionFooter";
import CanvasSelector from "../components/CanvasSelector";
import { Dialog } from "../components/Dialog";
import { ManageUsersDialog } from "../components/ManageUsersDialog";
import toast from "solid-toast";
import { CanvasGroup, CanvasDraft } from "../utils/types";
import { CanvasAccessDenied, AccessErrorType } from "../components/CanvasAccessDenied";
import { DraftContextMenu } from "../components/DraftContextMenu";
import { GroupContextMenu } from "../components/GroupContextMenu";
import { localCopyDraft, localDeleteDraft } from "../utils/useLocalCanvasMutations";
import { CanvasContext } from "../contexts/CanvasContext";

const CanvasWorkflow: Component<RouteSectionProps> = (props) => {
    const params = useParams();
    const queryClient = useQueryClient();
    const accessor = useUser();
    const [user] = accessor();

    const [canvasList, { mutate: mutateCanvasList, refetch: refetchCanvasList }] =
        createResource<any[]>(async () => {
            if (!user()) {
                if (hasLocalCanvas()) {
                    const local = getLocalCanvas()!;
                    return [
                        { id: "local", name: local.name, updatedAt: local.createdAt }
                    ];
                }
                return [];
            }
            return fetchCanvasList();
        });

    // Track canvas IDs we've already handled errors for to prevent loops
    const handledErrorCanvasIds = new Set<string>();

    const [canvas, { mutate: mutateCanvas, refetch: refetchCanvas }] = createResource(
        () => (params.id !== undefined ? String(params.id) : null),
        async (id: string) => {
            if (id === "local") {
                const local = getLocalCanvas();
                if (!local) return undefined;
                return {
                    name: local.name,
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

    const [layoutToggle, setLayoutToggle] = createSignal(false);
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

    const usersQuery = useQuery(() => ({
        queryKey: ["canvasUsers", params.id],
        enabled: isManageUsersOpen() && !!params.id,
        queryFn: () => fetchCanvasUsers(params.id)
    }));

    const viewShareLinkQuery = useQuery(() => ({
        queryKey: ["canvasShareLink", params.id, "view"],
        queryFn: () => generateCanvasShareLink(params.id, "view"),
        enabled: isSharePopperOpen() && !!params.id && hasAdminPermissions(),
        staleTime: 5 * 60 * 1000,
        retry: false
    }));

    const editShareLinkQuery = useQuery(() => ({
        queryKey: ["canvasShareLink", params.id, "edit"],
        queryFn: () => generateCanvasShareLink(params.id, "edit"),
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
            updateCanvasUserPermission(params.id, data.userId, data.permissions),
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ["canvasUsers", params.id] });
            toast.success("Permissions updated");
        },
        onError: (error) => {
            toast.error(`Error updating permissions: ${error.message}`);
        }
    }));

    const removeUserMutation = useMutation(() => ({
        mutationFn: (userId: string) => removeUserFromCanvas(params.id, userId),
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ["canvasUsers", params.id] });
            toast.success("User removed");
        },
        onError: (error) => {
            toast.error(`Error removing user: ${error.message}`);
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

    const isLocalMode = () => params.id === "local";

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
        navigate(`/canvas/${params.id}/draft/${draft.Draft.id}`);
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
            const cw = layoutToggle() ? 700 : 350;
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
                canvasId: params.id,
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
                    canvas: params.id,
                    draft: draft.Draft.id
                });
            }
        }
    };

    const handlePermissionChange = (userId: string, permission: string) => {
        updatePermissionMutation.mutate({ userId, permissions: permission });
    };

    const handleRemoveUser = (userId: string) => {
        if (confirm("Are you sure you want to remove this user?")) {
            removeUserMutation.mutate(userId);
        }
    };

    const handleShareCanvas = () => {
        setIsSharePopperOpen((prev) => !prev);
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

    const handleShareFocusOut = (e: FocusEvent) => {
        const container = e.currentTarget as HTMLDivElement;
        if (e.relatedTarget === null || !container.contains(e.relatedTarget as Node)) {
            setIsSharePopperOpen(false);
        }
    };

    return (
        <CanvasContext.Provider
            value={{
                canvas,
                mutateCanvas,
                refetchCanvas,
                canvasList,
                mutateCanvasList,
                layoutToggle,
                setLayoutToggle,
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
                setSetEditingDraftIdCallback
            }}
        >
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
            <div class="flex flex-1 overflow-hidden">
                <Show when={isDetailView()}>
                    <FlowPanel flow="canvas">
                        <div class="flex h-full flex-col gap-2 pt-4">
                            {/* Canvas Selector - hidden when viewing a draft or in local mode */}
                            <Show when={!isDraftView() && params.id !== "local"}>
                                <CanvasSelector selectedId={params.id} />
                            </Show>

                            {/* Control buttons - hidden when viewing a draft */}
                            <Show when={isDetailView() && !isDraftView()}>
                                <div class="flex flex-col gap-2">
                                    <button
                                        class="rounded-md bg-purple-600 px-3 py-2 text-center text-sm font-medium text-slate-200 hover:bg-purple-500"
                                        onClick={() => setLayoutToggle((prev) => !prev)}
                                    >
                                        Swap Orientation
                                    </button>
                                    <Show when={hasEditPermissions()}>
                                        <Show
                                            when={
                                                hasAdminPermissions() &&
                                                params.id !== "local"
                                            }
                                            fallback={
                                                <button
                                                    class="rounded-md bg-purple-600 px-3 py-2 text-center text-sm font-medium text-slate-200 hover:bg-purple-500"
                                                    onClick={() => {
                                                        const callback = importCallback();
                                                        if (callback) callback();
                                                    }}
                                                >
                                                    Import
                                                </button>
                                            }
                                        >
                                            <div class="grid grid-cols-2 gap-2">
                                                <button
                                                    class="rounded-md bg-purple-600 px-3 py-2 text-center text-sm font-medium text-slate-200 hover:bg-purple-500"
                                                    onClick={() => {
                                                        const callback = importCallback();
                                                        if (callback) callback();
                                                    }}
                                                >
                                                    Import
                                                </button>
                                                <div
                                                    class="relative"
                                                    onFocusOut={handleShareFocusOut}
                                                >
                                                    <button
                                                        onClick={handleShareCanvas}
                                                        class="w-full rounded-md bg-purple-600 px-3 py-2 text-center text-sm font-medium text-slate-200 hover:bg-purple-500"
                                                    >
                                                        Share
                                                    </button>
                                                    {isSharePopperOpen() && (
                                                        <div class="absolute left-0 top-full z-10 mt-2 min-w-[250px] rounded-md bg-slate-600 p-3 shadow-lg">
                                                            <div class="space-y-3">
                                                                <div>
                                                                    <p class="mb-1 text-xs font-medium text-slate-300">
                                                                        View Access
                                                                    </p>
                                                                    <Show
                                                                        when={
                                                                            !viewShareLinkQuery.isPending
                                                                        }
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
                                                                                value={
                                                                                    viewShareLinkQuery.data ||
                                                                                    ""
                                                                                }
                                                                                class="w-full rounded-md border border-gray-700 bg-gray-900 px-2 py-1 text-xs text-slate-50"
                                                                            />
                                                                            <button
                                                                                onClick={
                                                                                    handleCopyViewLink
                                                                                }
                                                                                class="rounded-md bg-purple-500 px-2 py-1 text-xs text-slate-50 hover:bg-purple-400 disabled:opacity-50"
                                                                                disabled={
                                                                                    !viewShareLinkQuery.data
                                                                                }
                                                                            >
                                                                                {copied() ===
                                                                                "view"
                                                                                    ? "✓"
                                                                                    : "Copy"}
                                                                            </button>
                                                                        </div>
                                                                    </Show>
                                                                </div>
                                                                <div>
                                                                    <p class="mb-1 text-xs font-medium text-slate-300">
                                                                        Edit Access
                                                                    </p>
                                                                    <Show
                                                                        when={
                                                                            !editShareLinkQuery.isPending
                                                                        }
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
                                                                                value={
                                                                                    editShareLinkQuery.data ||
                                                                                    ""
                                                                                }
                                                                                class="w-full rounded-md border border-gray-700 bg-gray-900 px-2 py-1 text-xs text-slate-50"
                                                                            />
                                                                            <button
                                                                                onClick={
                                                                                    handleCopyEditLink
                                                                                }
                                                                                class="rounded-md bg-purple-500 px-2 py-1 text-xs text-slate-50 hover:bg-purple-400 disabled:opacity-50"
                                                                                disabled={
                                                                                    !editShareLinkQuery.data
                                                                                }
                                                                            >
                                                                                {copied() ===
                                                                                "edit"
                                                                                    ? "✓"
                                                                                    : "Copy"}
                                                                            </button>
                                                                        </div>
                                                                    </Show>
                                                                </div>
                                                            </div>
                                                        </div>
                                                    )}
                                                </div>
                                            </div>
                                            <button
                                                class="rounded-md bg-purple-600 px-3 py-2 text-center text-sm font-medium text-slate-200 hover:bg-purple-500"
                                                onClick={() => setIsManageUsersOpen(true)}
                                            >
                                                Manage Users
                                            </button>
                                        </Show>
                                    </Show>
                                </div>
                            </Show>

                            {/* Back to canvas link when viewing a draft */}
                            <Show when={isDraftView()}>
                                <button
                                    onClick={() => navigate(`/canvas/${params.id}`)}
                                    class="flex items-center gap-2 rounded-md px-3 py-2 text-sm text-slate-300 hover:bg-slate-700"
                                >
                                    <span>&larr;</span>
                                    <span>Back to {canvas()?.name || "Canvas"}</span>
                                </button>
                            </Show>

                            {/* Draft list when canvas is selected */}
                            <Show when={isDetailView() && canvas()?.drafts}>
                                {(() => {
                                    const groups = createMemo(
                                        () => (canvas()?.groups ?? []) as CanvasGroup[]
                                    );
                                    const drafts = createMemo(
                                        () => (canvas()?.drafts ?? []) as CanvasDraft[]
                                    );
                                    const ungroupedDrafts = createMemo(() =>
                                        drafts().filter((d) => !d.group_id)
                                    );
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
                                        <div class="mt-4 flex min-h-0 flex-col gap-2 overflow-y-auto px-2">
                                            <h3 class="text-sm font-semibold text-slate-300">
                                                Drafts in Canvas
                                            </h3>
                                            <div class="flex flex-col gap-1">
                                                {/* Grouped drafts */}
                                                <For each={groups()}>
                                                    {(group) => (
                                                        <div class="flex flex-col gap-1">
                                                            <div
                                                                class="flex cursor-pointer items-center gap-2 rounded-md bg-slate-600 px-2 py-1.5 text-xs font-medium text-slate-300 hover:bg-slate-500"
                                                                onClick={() => {
                                                                    const callback =
                                                                        navigateToDraftCallback();
                                                                    if (callback) {
                                                                        callback(
                                                                            group.positionX,
                                                                            group.positionY
                                                                        );
                                                                    }
                                                                }}
                                                                onContextMenu={(e) =>
                                                                    handleSidebarGroupContextMenu(
                                                                        group,
                                                                        e
                                                                    )
                                                                }
                                                            >
                                                                <span class="text-slate-400">
                                                                    {group.type ===
                                                                    "series"
                                                                        ? "Series"
                                                                        : "Group"}
                                                                </span>
                                                                <span class="truncate">
                                                                    {group.name}
                                                                </span>
                                                            </div>
                                                            <For
                                                                each={getDraftsForGroup(
                                                                    group.id
                                                                )}
                                                            >
                                                                {(canvasDraft, index) => {
                                                                    const getNavPosition =
                                                                        () => {
                                                                            if (
                                                                                group.type ===
                                                                                "custom"
                                                                            ) {
                                                                                // Custom groups use free-form positions
                                                                                return {
                                                                                    x:
                                                                                        group.positionX +
                                                                                        canvasDraft.positionX,
                                                                                    y:
                                                                                        group.positionY +
                                                                                        canvasDraft.positionY
                                                                                };
                                                                            }
                                                                            // Series groups use horizontal layout
                                                                            const PADDING = 20;
                                                                            const CARD_GAP = 24;
                                                                            const cw =
                                                                                layoutToggle()
                                                                                    ? 700
                                                                                    : 350;
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

                                                                    return (
                                                                        <div
                                                                            class={`ml-3 cursor-pointer rounded-md px-3 py-2 text-sm transition-colors ${
                                                                                isDraftView() &&
                                                                                canvasDraft
                                                                                    .Draft
                                                                                    .id ===
                                                                                    params.draftId
                                                                                    ? "bg-slate-600 text-slate-50"
                                                                                    : "bg-slate-700 text-slate-200 hover:bg-slate-600"
                                                                            }`}
                                                                            onClick={() => {
                                                                                if (
                                                                                    isDraftView()
                                                                                ) {
                                                                                    navigate(
                                                                                        `/canvas/${params.id}/draft/${canvasDraft.Draft.id}`
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
                                                                    );
                                                                }}
                                                            </For>
                                                        </div>
                                                    )}
                                                </For>
                                                {/* Ungrouped drafts */}
                                                <For each={ungroupedDrafts()}>
                                                    {(canvasDraft) => (
                                                        <div
                                                            class={`cursor-pointer rounded-md px-3 py-2 text-sm transition-colors ${
                                                                isDraftView() &&
                                                                canvasDraft.Draft.id ===
                                                                    params.draftId
                                                                    ? "bg-slate-600 text-slate-50"
                                                                    : "bg-slate-700 text-slate-200 hover:bg-slate-600"
                                                            }`}
                                                            onClick={() => {
                                                                if (isDraftView()) {
                                                                    navigate(
                                                                        `/canvas/${params.id}/draft/${canvasDraft.Draft.id}`
                                                                    );
                                                                } else {
                                                                    const callback =
                                                                        navigateToDraftCallback();
                                                                    if (callback) {
                                                                        callback(
                                                                            canvasDraft.positionX,
                                                                            canvasDraft.positionY
                                                                        );
                                                                    }
                                                                }
                                                            }}
                                                            onContextMenu={(e) => {
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
                                                            {canvasDraft.Draft.name}
                                                        </div>
                                                    )}
                                                </For>
                                            </div>
                                        </div>
                                    );
                                })()}
                            </Show>
                            <div class="flex-1" />
                            <VersionFooter />
                        </div>
                    </FlowPanel>
                </Show>
                {/* Child routes (dashboard or detail view) render here */}
                <Show
                    when={!accessError()}
                    fallback={
                        <CanvasAccessDenied
                            errorType={accessError()!.type}
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
    );
};

export default CanvasWorkflow;
