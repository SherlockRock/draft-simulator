import { For, createEffect, createSignal, Show } from "solid-js";
import {
    fetchCanvas,
    postNewDraft,
    fetchCanvasUsers,
    updateCanvasUserPermission,
    removeUserFromCanvas,
    generateCanvasShareLink
} from "../utils/actions";
import NavBar from "../NavBar";
import CanvasComponent from "../Canvas";
import ConnectionBanner from "../ConnectionBanner";
import { A, useNavigate, useParams } from "@solidjs/router";
import { VersionFooter } from "../components/VersionFooter";
import { useMutation, useQuery, useQueryClient } from "@tanstack/solid-query";
import { Viewport } from "../utils/types";
import toast from "solid-toast";
import { Dialog } from "../components/Dialog";
import { AuthGuard } from "../components/AuthGaurd";
import { cardHeight, cardWidth } from "../utils/helpers";

const CanvasWorkflow = () => {
    const params = useParams();
    const navigate = useNavigate();
    const queryClient = useQueryClient();
    const [viewport, setViewport] = createSignal<Viewport>({ x: 0, y: 0, zoom: 1 });
    const [layoutToggle, setLayoutToggle] = createSignal(false);
    const [isManageUsersOpen, setIsManageUsersOpen] = createSignal(false);
    const [isSharePopperOpen, setIsSharePopperOpen] = createSignal(false);
    const [copied, setCopied] = createSignal("");
    let canvasContainerRef: HTMLDivElement | undefined;

    const canvasQuery = useQuery(() => ({
        queryKey: ["canvas", params.id],
        enabled: !!params.id,
        queryFn: () => fetchCanvas(params.id),
        retry: (failureCount, error) => {
            if (error && typeof error === "object" && "status" in error) {
                if (error.status === 401 || error.status === 403) {
                    return false;
                }
            }
            return failureCount < 3;
        }
    }));

    createEffect(() => {
        const error = canvasQuery.error;
        if (error && typeof error === "object" && "status" in error) {
            if (error.status === 401 || error.status === 403) {
                toast.error("You do not have permission to view this canvas.");
                navigate("/");
            }
        }
    });

    const usersQuery = useQuery(() => ({
        queryKey: ["canvasUsers", params.id],
        enabled: isManageUsersOpen() && !!params.id,
        queryFn: () => fetchCanvasUsers(params.id)
    }));

    const hasAdminPermissions = () => canvasQuery.data?.userPermissions === "admin";

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

    const newDraftMutation = useMutation(() => ({
        mutationFn: (data: {
            name: string;
            picks: string[];
            public: boolean;
            canvas_id: string;
            positionX: number;
            positionY: number;
        }) => {
            return postNewDraft(data);
        },
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ["canvas", params.id] });
            toast.success("Successfully created new draft!");
        },
        onError: (error) => {
            toast.error(`Error creating new draft: ${error.message}`);
        }
    }));

    const createNewDraft = () => {
        if (canvasContainerRef) {
            const vp = viewport();
            const canvasRect = canvasContainerRef.getBoundingClientRect();
            const currentHeight = cardHeight(layoutToggle());
            const currentWidth = cardWidth(layoutToggle());
            const centerWorldX = vp.x + canvasRect.width / 2 / vp.zoom;
            const centerWorldY = vp.y + canvasRect.height / 2 / vp.zoom;

            const positionX = centerWorldX - currentWidth / 2;
            const positionY = centerWorldY - currentHeight / 2;

            newDraftMutation.mutate({
                name: "New Draft",
                picks: Array(20).fill(""),
                public: false,
                canvas_id: params.id,
                positionX: positionX,
                positionY: positionY
            });
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

    const ManageUsersContent = (
        <div class="w-[500px] text-slate-200">
            <h2 class="mb-4 text-xl font-bold">Manage Users</h2>
            <div class="max-h-[400px] space-y-3 overflow-y-auto">
                <For each={usersQuery.data}>
                    {(user) => (
                        <div class="flex items-center justify-between rounded bg-slate-800 p-2">
                            <div class="flex items-center gap-2">
                                {user.picture && (
                                    <img
                                        src={user.picture}
                                        class="h-8 w-8 rounded-full"
                                        alt={user.name}
                                    />
                                )}
                                <div>
                                    <p class="text-sm font-medium">
                                        {user.name || "Unknown"}
                                    </p>
                                    <p class="text-xs text-slate-400">{user.email}</p>
                                </div>
                            </div>
                            <div class="flex items-center gap-2">
                                <select
                                    class="rounded bg-slate-700 p-1 text-sm text-slate-200 focus:outline-none focus:ring-2 focus:ring-teal-500"
                                    value={user.permissions}
                                    onChange={(e) =>
                                        updatePermissionMutation.mutate({
                                            userId: user.id,
                                            permissions: e.currentTarget.value
                                        })
                                    }
                                >
                                    <option value="view">View</option>
                                    <option value="edit">Edit</option>
                                    <option value="admin">Admin</option>
                                </select>
                                <button
                                    class="rounded p-1 text-red-400 hover:bg-slate-700 hover:text-red-300"
                                    onClick={() => {
                                        if (
                                            confirm(
                                                "Are you sure you want to remove this user?"
                                            )
                                        ) {
                                            removeUserMutation.mutate(user.id);
                                        }
                                    }}
                                    title="Remove User"
                                >
                                    <svg
                                        xmlns="http://www.w3.org/2000/svg"
                                        class="h-5 w-5"
                                        viewBox="0 0 20 20"
                                        fill="currentColor"
                                    >
                                        <path
                                            fill-rule="evenodd"
                                            d="M9 2a1 1 0 00-.894.553L7.382 4H4a1 1 0 000 2v10a2 2 0 002 2h8a2 2 0 002-2V6a1 1 0 100-2h-3.382l-.724-1.447A1 1 0 0011 2H9zM7 8a1 1 0 012 0v6a1 1 0 11-2 0V8zm5-1a1 1 0 00-1 1v6a1 1 0 102 0V8a1 1 0 00-1-1z"
                                            clip-rule="evenodd"
                                        />
                                    </svg>
                                </button>
                            </div>
                        </div>
                    )}
                </For>
                {usersQuery.data?.length === 0 && (
                    <p class="text-center text-slate-400">No users found.</p>
                )}
            </div>
            <div class="mt-6 flex justify-end">
                <button
                    class="rounded bg-slate-600 px-4 py-2 text-sm font-medium text-slate-200 hover:bg-slate-500"
                    onClick={() => setIsManageUsersOpen(false)}
                >
                    Close
                </button>
            </div>
        </div>
    );

    return (
        <AuthGuard requireAuth={true}>
            <div class="flex h-full">
                <Dialog
                    isOpen={isManageUsersOpen}
                    onCancel={() => setIsManageUsersOpen(false)}
                    body={ManageUsersContent}
                />
                <NavBar handleLogOut={() => navigate("/", { replace: true })}>
                    <A href="/" class="text-slate-50 underline hover:text-teal-400">
                        <span class="flex items-center gap-1">
                            <svg
                                xmlns="http://www.w3.org/2000/svg"
                                class="mt-1 h-4 w-4"
                                viewBox="0 0 24 24"
                                fill="none"
                                stroke="currentColor"
                                stroke-width="2"
                                stroke-linecap="round"
                                stroke-linejoin="round"
                            >
                                <line x1="19" y1="12" x2="5" y2="12" />
                                <polyline points="12 19 5 12 12 5" />
                            </svg>
                            <p>Back to Drafts</p>
                        </span>
                    </A>
                    <div class="flex gap-2">
                        <div class="grid grid-cols-2 gap-2">
                            <button
                                class="rounded-md bg-teal-700 px-3 py-2 text-center font-medium text-slate-200 hover:bg-teal-400"
                                onClick={() => setLayoutToggle((prev) => !prev)}
                            >
                                Swap Draft Orientation
                            </button>
                            <button
                                class="rounded-md bg-teal-700 px-3 py-2 text-center font-medium text-slate-200 hover:bg-teal-400"
                                onClick={createNewDraft}
                            >
                                Create Blank Draft
                            </button>
                            <Show when={hasAdminPermissions()}>
                                <button
                                    class="rounded-md bg-teal-700 px-3 py-2 text-center font-medium text-slate-200 hover:bg-teal-400"
                                    onClick={() => setIsManageUsersOpen(true)}
                                >
                                    Manage Users
                                </button>
                            </Show>
                            <Show when={hasAdminPermissions()}>
                                <div
                                    class="relative h-full w-full"
                                    onFocusOut={handleShareFocusOut}
                                >
                                    <button
                                        onClick={handleShareCanvas}
                                        class="h-full w-full rounded-md bg-teal-700 px-3 py-2 text-center font-medium text-slate-200 hover:bg-teal-400"
                                    >
                                        Share
                                    </button>
                                    {isSharePopperOpen() && (
                                        <div class="absolute right-0 top-full z-10 mt-2 w-auto min-w-max rounded-md bg-slate-600 p-3 shadow-lg">
                                            <div class="space-y-3">
                                                <div>
                                                    <p class="mb-1 text-xs font-medium text-slate-300">
                                                        View Only Access
                                                    </p>
                                                    <Show
                                                        when={
                                                            !viewShareLinkQuery.isPending
                                                        }
                                                        fallback={
                                                            <div class="flex items-center gap-2">
                                                                <svg
                                                                    class="h-4 w-4 animate-spin text-teal-400"
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
                                                                <span class="text-xs text-slate-400">
                                                                    Loading...
                                                                </span>
                                                            </div>
                                                        }
                                                    >
                                                        <div class="flex items-center gap-2">
                                                            <input
                                                                type="text"
                                                                readOnly
                                                                value={
                                                                    viewShareLinkQuery.data ||
                                                                    ""
                                                                }
                                                                class="w-40 rounded-md border border-gray-700 bg-gray-900 px-2 py-1 text-sm text-slate-50"
                                                            />
                                                            <button
                                                                onClick={
                                                                    handleCopyViewLink
                                                                }
                                                                class="rounded-md bg-teal-400 p-2 text-slate-50 hover:bg-teal-700 disabled:opacity-50"
                                                                disabled={
                                                                    !viewShareLinkQuery.data
                                                                }
                                                            >
                                                                {copied() === "view" ? (
                                                                    <svg
                                                                        xmlns="http://www.w3.org/2000/svg"
                                                                        class="h-5 w-5"
                                                                        viewBox="0 0 20 20"
                                                                        fill="currentColor"
                                                                    >
                                                                        <path
                                                                            fill-rule="evenodd"
                                                                            d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z"
                                                                            clip-rule="evenodd"
                                                                        />
                                                                    </svg>
                                                                ) : (
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
                                                                            d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"
                                                                        />
                                                                    </svg>
                                                                )}
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
                                                            <div class="flex items-center gap-2">
                                                                <svg
                                                                    class="h-4 w-4 animate-spin text-teal-400"
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
                                                                <span class="text-xs text-slate-400">
                                                                    Loading...
                                                                </span>
                                                            </div>
                                                        }
                                                    >
                                                        <div class="flex items-center gap-2">
                                                            <input
                                                                type="text"
                                                                readOnly
                                                                value={
                                                                    editShareLinkQuery.data ||
                                                                    ""
                                                                }
                                                                class="w-40 rounded-md border border-gray-700 bg-gray-900 px-2 py-1 text-sm text-slate-50"
                                                            />
                                                            <button
                                                                onClick={
                                                                    handleCopyEditLink
                                                                }
                                                                class="rounded-md bg-teal-400 p-2 text-slate-50 hover:bg-teal-700 disabled:opacity-50"
                                                                disabled={
                                                                    !editShareLinkQuery.data
                                                                }
                                                            >
                                                                {copied() === "edit" ? (
                                                                    <svg
                                                                        xmlns="http://www.w3.org/2000/svg"
                                                                        class="h-5 w-5"
                                                                        viewBox="0 0 20 20"
                                                                        fill="currentColor"
                                                                    >
                                                                        <path
                                                                            fill-rule="evenodd"
                                                                            d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z"
                                                                            clip-rule="evenodd"
                                                                        />
                                                                    </svg>
                                                                ) : (
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
                                                                            d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"
                                                                        />
                                                                    </svg>
                                                                )}
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
                    </div>
                    <div class="custom-scrollbar max-h-1/4 overflow-y-scroll rounded-md border-slate-500 bg-slate-700 p-2">
                        <h3 class="mb-2 text-slate-200">Drafts</h3>
                        <ul class="space-y-2">
                            <For each={canvasQuery.data?.drafts || []}>
                                {(draft) => (
                                    <li
                                        class="flex cursor-pointer items-center justify-between rounded-md bg-slate-800 p-2 text-slate-50 hover:bg-slate-600"
                                        onClick={() => {
                                            if (canvasContainerRef) {
                                                const container =
                                                    canvasContainerRef.getBoundingClientRect();
                                                const currentWidth =
                                                    cardWidth(layoutToggle());
                                                const currentHeight =
                                                    cardHeight(layoutToggle());
                                                setViewport((prev) => ({
                                                    ...prev,
                                                    x:
                                                        draft.positionX -
                                                        container.width / 2 / prev.zoom +
                                                        currentWidth / 2 / prev.zoom,
                                                    y:
                                                        draft.positionY -
                                                        container.height / 2 / prev.zoom +
                                                        currentHeight / 2 / prev.zoom
                                                }));
                                            }
                                        }}
                                    >
                                        <p class="mr-2 truncate">{draft.Draft.name}</p>
                                        <button
                                            onClick={() => {}}
                                            class="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded bg-teal-700 hover:bg-teal-400"
                                        >
                                            <svg
                                                xmlns="http://www.w3.org/2000/svg"
                                                class="h-4 w-4"
                                                viewBox="0 0 24 24"
                                                fill="none"
                                                stroke="currentColor"
                                                stroke-width="2"
                                            >
                                                <circle
                                                    cx="12"
                                                    cy="12"
                                                    r="1"
                                                    fill="currentColor"
                                                />
                                                <circle
                                                    cx="5"
                                                    cy="12"
                                                    r="1"
                                                    fill="currentColor"
                                                />
                                                <circle
                                                    cx="19"
                                                    cy="12"
                                                    r="1"
                                                    fill="currentColor"
                                                />
                                            </svg>
                                        </button>
                                    </li>
                                )}
                            </For>
                        </ul>
                    </div>
                    <div class="flex-1 flex-shrink" />
                    <VersionFooter />
                </NavBar>
                <div ref={canvasContainerRef} class="flex-1 overflow-y-auto">
                    <ConnectionBanner />
                    <CanvasComponent
                        canvasData={canvasQuery.data}
                        isLoading={canvasQuery.isPending}
                        isError={canvasQuery.isError}
                        error={canvasQuery.error}
                        refetch={canvasQuery.refetch}
                        isFetching={canvasQuery.isFetching}
                        layoutToggle={layoutToggle}
                        setLayoutToggle={setLayoutToggle}
                        viewport={viewport}
                        setViewport={setViewport}
                    />
                </div>
            </div>
        </AuthGuard>
    );
};

export default CanvasWorkflow;
