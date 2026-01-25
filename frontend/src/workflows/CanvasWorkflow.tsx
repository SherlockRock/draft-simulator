import {
    Component,
    createResource,
    createEffect,
    createContext,
    useContext,
    Setter,
    Resource,
    createSignal,
    Accessor,
    Show,
    For
} from "solid-js";
import { useParams, RouteSectionProps } from "@solidjs/router";
import { useQueryClient, useMutation, useQuery } from "@tanstack/solid-query";
import { useUser } from "../userProvider";
import {
    fetchCanvasList,
    fetchCanvas,
    fetchCanvasUsers,
    updateCanvasUserPermission,
    removeUserFromCanvas,
    generateCanvasShareLink
} from "../utils/actions";
import FlowPanel from "../components/FlowPanel";
import { VersionFooter } from "../components/VersionFooter";
import CanvasSelector from "../components/CanvasSelector";
import { Dialog } from "../components/Dialog";
import { ManageUsersDialog } from "../components/ManageUsersDialog";
import toast from "solid-toast";

// Create context for sharing canvas state with children
type CanvasContextType = {
    canvas: Resource<any>;
    mutateCanvas: Setter<any>;
    canvasList: Resource<any>;
    mutateCanvasList: Setter<any>;
    layoutToggle: Accessor<boolean>;
    setLayoutToggle: Setter<boolean>;
    createDraftCallback: Accessor<(() => void) | null>;
    setCreateDraftCallback: Setter<(() => void) | null>;
    navigateToDraftCallback: Accessor<
        ((positionX: number, positionY: number) => void) | null
    >;
    setNavigateToDraftCallback: Setter<
        ((positionX: number, positionY: number) => void) | null
    >;
};

const CanvasContext = createContext<CanvasContextType>();

export const useCanvasContext = () => {
    const context = useContext(CanvasContext);
    if (!context) {
        throw new Error("useCanvasContext must be used within CanvasWorkflow");
    }
    return context;
};

const CanvasWorkflow: Component<RouteSectionProps> = (props) => {
    const params = useParams();
    const queryClient = useQueryClient();
    const accessor = useUser();
    const [user] = accessor();

    const [canvasList, { mutate: mutateCanvasList, refetch: refetchCanvasList }] =
        createResource<any[]>(fetchCanvasList);

    const [canvas, { mutate: mutateCanvas, refetch: refetchCanvas }] = createResource(
        () => (params.id !== undefined ? String(params.id) : null),
        fetchCanvas
    );

    const [layoutToggle, setLayoutToggle] = createSignal(false);
    const [createDraftCallback, setCreateDraftCallback] = createSignal<
        (() => void) | null
    >(null);
    const [navigateToDraftCallback, setNavigateToDraftCallback] = createSignal<
        ((positionX: number, positionY: number) => void) | null
    >(null);
    const [isManageUsersOpen, setIsManageUsersOpen] = createSignal(false);
    const [isSharePopperOpen, setIsSharePopperOpen] = createSignal(false);
    const [copied, setCopied] = createSignal("");

    let previousUser = user();

    createEffect(() => {
        const currentUser = user();
        if (currentUser === undefined) {
            mutateCanvasList([]);
            mutateCanvas(undefined);
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

    // Check if we're on a detail view (has an id param)
    const isDetailView = () => !!params.id;

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
                canvasList,
                mutateCanvasList,
                layoutToggle,
                setLayoutToggle,
                createDraftCallback,
                setCreateDraftCallback,
                navigateToDraftCallback,
                setNavigateToDraftCallback
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
                            {/* Canvas Selector */}
                            <CanvasSelector selectedId={params.id} />

                            {/* Control buttons when canvas is selected */}
                            <Show when={isDetailView()}>
                                <div class="flex flex-col gap-2">
                                    <button
                                        class="rounded-md bg-teal-700 px-3 py-2 text-center text-sm font-medium text-slate-200 hover:bg-teal-400"
                                        onClick={() => setLayoutToggle((prev) => !prev)}
                                    >
                                        Swap Orientation
                                    </button>
                                    <Show when={hasEditPermissions()}>
                                        <button
                                            class="rounded-md bg-teal-700 px-3 py-2 text-center text-sm font-medium text-slate-200 hover:bg-teal-400"
                                            onClick={() => {
                                                const callback = createDraftCallback();
                                                if (callback) callback();
                                            }}
                                        >
                                            Create Draft
                                        </button>
                                    </Show>
                                    <Show when={hasAdminPermissions()}>
                                        <button
                                            class="rounded-md bg-teal-700 px-3 py-2 text-center text-sm font-medium text-slate-200 hover:bg-teal-400"
                                            onClick={() => setIsManageUsersOpen(true)}
                                        >
                                            Manage Users
                                        </button>
                                        <div
                                            class="relative"
                                            onFocusOut={handleShareFocusOut}
                                        >
                                            <button
                                                onClick={handleShareCanvas}
                                                class="w-full rounded-md bg-teal-700 px-3 py-2 text-center text-sm font-medium text-slate-200 hover:bg-teal-400"
                                            >
                                                Share
                                            </button>
                                            {isSharePopperOpen() && (
                                                <div class="absolute left-0 top-full z-10 mt-2 w-full rounded-md bg-slate-600 p-3 shadow-lg">
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
                                                                        class="rounded-md bg-teal-400 px-2 py-1 text-xs text-slate-50 hover:bg-teal-700 disabled:opacity-50"
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
                                                                        class="rounded-md bg-teal-400 px-2 py-1 text-xs text-slate-50 hover:bg-teal-700 disabled:opacity-50"
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
                                    </Show>
                                </div>
                            </Show>

                            {/* Draft list when canvas is selected */}
                            <Show when={isDetailView() && canvas()?.drafts}>
                                <div class="mt-4 flex flex-col gap-2 px-2">
                                    <h3 class="text-sm font-semibold text-slate-300">
                                        Drafts in Canvas
                                    </h3>
                                    <div class="flex flex-col gap-1">
                                        <For each={canvas()?.drafts}>
                                            {(canvasDraft) => (
                                                <div
                                                    class="cursor-pointer rounded-md bg-slate-700 px-3 py-2 text-sm text-slate-200 hover:bg-slate-600"
                                                    onClick={() => {
                                                        const callback =
                                                            navigateToDraftCallback();
                                                        if (callback) {
                                                            callback(
                                                                canvasDraft.positionX,
                                                                canvasDraft.positionY
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
                            </Show>
                            <div class="flex-1" />
                            <VersionFooter />
                        </div>
                    </FlowPanel>
                </Show>
                {/* Child routes (dashboard or detail view) render here */}
                {props.children}
            </div>
        </CanvasContext.Provider>
    );
};

export default CanvasWorkflow;
