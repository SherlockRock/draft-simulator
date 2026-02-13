import {
    For,
    Index,
    onMount,
    onCleanup,
    createSignal,
    createEffect,
    Show,
    createMemo,
    Setter,
    Accessor
} from "solid-js";
import { createStore } from "solid-js/store";
import {
    champions,
    indexToShorthandHorizontal,
    indexToShorthandVertical
} from "./utils/constants";
import { useMutation, useQueryClient } from "@tanstack/solid-query";
import {
    postNewDraft,
    updateCanvasDraftPosition,
    deleteDraftFromCanvas,
    copyDraftInCanvas,
    updateCanvasViewport,
    CanvasResposnse,
    updateCanvasName,
    createConnection,
    updateConnection,
    deleteConnection,
    createVertex,
    updateVertex,
    deleteVertex,
    editDraft,
    deleteCanvasGroup,
    updateCanvasGroupPosition,
    createCanvasGroup,
    updateCanvasGroup,
    updateCanvasDraft
} from "./utils/actions";
import { useNavigate, useParams } from "@solidjs/router";
import { toast } from "solid-toast";
import { useUser } from "./userProvider";
import { CanvasDraft, draft, Viewport, Connection, CanvasGroup } from "./utils/types";
import { CanvasSelect } from "./components/CanvasSelect";
import { Dialog } from "./components/Dialog";
import { ImportToCanvasDialog } from "./components/ImportToCanvasDialog";
import {
    ConnectionComponent,
    ConnectionPreview,
    GroupConnectionPreview
} from "./components/Connections";
import { AnchorPoints } from "./components/AnchorPoints";
import { AnchorType } from "./utils/types";
import { useCanvasContext } from "./workflows/CanvasWorkflow";
import { cardHeight, cardWidth } from "./utils/helpers";
import {
    localUpdateCanvasName,
    localNewDraft,
    localEditDraft,
    localUpdateDraftPosition,
    localDeleteDraft,
    localCopyDraft,
    localUpdateViewport,
    localCreateConnection,
    localUpdateConnection,
    localDeleteConnection,
    localCreateVertex,
    localUpdateVertex,
    localDeleteVertex,
    localCreateGroup,
    localUpdateGroupPosition,
    localUpdateGroup,
    localDeleteGroup,
    localUpdateDraftGroup
} from "./utils/useLocalCanvasMutations";
import { getLocalCanvas, saveLocalCanvas } from "./utils/localCanvasStore";
import { handleLogin } from "./utils/actions";
import { SeriesGroupContainer } from "./components/SeriesGroupContainer";
import {
    CustomGroupContainer,
    CUSTOM_GROUP_HEADER_HEIGHT
} from "./components/CustomGroupContainer";
import { DeleteGroupDialog } from "./components/DeleteGroupDialog";
import { DraftContextMenu } from "./components/DraftContextMenu";
import { GroupContextMenu } from "./components/GroupContextMenu";

type cardProps = {
    canvasId: string;
    canvasDraft: CanvasDraft;
    addBox: (fromBox: CanvasDraft) => void;
    deleteBox: (draftId: string) => void;
    handleNameChange: (draftId: string, newName: string) => void;
    handlePickChange: (draftId: string, pickIndex: number, championName: string) => void;
    onBoxMouseDown: (draftId: string, e: MouseEvent) => void;
    onContextMenu: (draft: CanvasDraft, e: MouseEvent) => void;
    layoutToggle: () => boolean;
    setLayoutToggle: (val: boolean) => void;
    viewport: () => Viewport;
    isConnectionMode: boolean;
    onAnchorClick: (draftId: string, anchorType: AnchorType) => void;
    connectionSource: () => string | null;
    sourceAnchor: () => { type: AnchorType } | null;
    focusedDraftId: () => string | null;
    focusedSelectIndex: () => number;
    onSelectFocus: (draftId: string, selectIndex: number) => void;
    onSelectNext: () => void;
    onSelectPrevious: () => void;
    canEdit: () => boolean;
    // Props for grouped mode
    isGrouped?: boolean;
    groupType?: "series" | "custom";
};

const CanvasCard = (props: cardProps) => {
    const navigate = useNavigate();
    const [nameSignal, setNameSignal] = createSignal(props.canvasDraft.Draft.name);
    const handleViewClick = () => {
        navigate(`/canvas/${props.canvasId}/draft/${props.canvasDraft.Draft.id}`);
    };

    const worldToScreen = (worldX: number, worldY: number) => {
        const vp = props.viewport();
        return {
            x: (worldX - vp.x) * vp.zoom,
            y: (worldY - vp.y) * vp.zoom
        };
    };
    const screenPos = () =>
        worldToScreen(props.canvasDraft.positionX, props.canvasDraft.positionY);

    const draftArrayMemo = createMemo(() =>
        props.layoutToggle()
            ? [
                  ...props.canvasDraft.Draft.picks.slice(0, 5),
                  ...props.canvasDraft.Draft.picks.slice(10, 20),
                  ...props.canvasDraft.Draft.picks.slice(5, 10)
              ]
            : [
                  ...props.canvasDraft.Draft.picks.slice(0, 5),
                  ...props.canvasDraft.Draft.picks.slice(10, 15),
                  ...props.canvasDraft.Draft.picks.slice(5, 10),
                  ...props.canvasDraft.Draft.picks.slice(15, 20)
              ]
    );

    const indexToShorthand = createMemo(() =>
        props.layoutToggle() ? indexToShorthandHorizontal : indexToShorthandVertical
    );

    const selected = createMemo(
        () => props.connectionSource() === props.canvasDraft.Draft.id
    );

    return (
        <div
            class="canvas-card flex flex-col rounded-md border border-slate-500 bg-slate-600 shadow-lg"
            classList={{
                "absolute z-30": !props.isGrouped || props.groupType === "custom",
                "ring-4 ring-blue-400": props.isConnectionMode && !selected(),
                "ring-4 ring-green-400": selected(),
                "flex-shrink-0": props.isGrouped && props.groupType === "series"
            }}
            style={{
                ...(props.isGrouped && props.groupType === "custom"
                    ? {
                          left: `${props.canvasDraft.positionX}px`,
                          top: `${props.canvasDraft.positionY - CUSTOM_GROUP_HEADER_HEIGHT}px`
                      }
                    : props.isGrouped
                      ? {}
                      : {
                            left: `${screenPos().x}px`,
                            top: `${screenPos().y}px`,
                            transform: `scale(${props.viewport().zoom})`,
                            "transform-origin": "top left"
                        }),
                width: props.layoutToggle() ? "700px" : "350px",
                cursor:
                    props.isConnectionMode ||
                    !props.canEdit() ||
                    (props.isGrouped && props.groupType === "series")
                        ? "default"
                        : "move"
            }}
            onMouseDown={(e) => {
                if (
                    !props.isConnectionMode &&
                    (!props.isGrouped || props.groupType === "custom")
                ) {
                    props.onBoxMouseDown(props.canvasDraft.Draft.id, e);
                }
            }}
            onContextMenu={(e) => {
                if (props.canEdit()) {
                    e.preventDefault();
                    e.stopPropagation();
                    props.onContextMenu(props.canvasDraft, e);
                }
            }}
        >
            <Show when={props.isConnectionMode}>
                <AnchorPoints
                    onSelectAnchor={(anchorType) => {
                        props.onAnchorClick(props.canvasDraft.Draft.id, anchorType);
                    }}
                    layoutToggle={props.layoutToggle}
                    zoom={props.viewport().zoom}
                    selected={selected}
                    sourceAnchor={props.sourceAnchor}
                />
            </Show>
            <div class="flex flex-col gap-1 p-1">
                <div class="flex items-center justify-between">
                    <div class="flex min-w-0 flex-1 flex-col gap-1">
                        <input
                            type="text"
                            placeholder="Enter Draft Name"
                            value={nameSignal()}
                            onInput={(e) => setNameSignal(e.currentTarget.value)}
                            onKeyDown={(e) => {
                                if (e.key === "Enter" || e.key === "Escape") {
                                    e.currentTarget.blur();
                                }
                            }}
                            onBlur={() =>
                                props.handleNameChange(
                                    props.canvasDraft.Draft.id,
                                    nameSignal()
                                )
                            }
                            class="bg-transparent font-bold text-slate-50"
                            disabled={
                                props.isConnectionMode ||
                                !props.canEdit() ||
                                !!props.canvasDraft.is_locked
                            }
                        />
                        <div class="flex items-center gap-1">
                            <span
                                class="rounded px-2 py-0.5 text-xs"
                                classList={{
                                    "bg-blue-500/20 text-blue-300 border border-blue-400/30":
                                        props.canvasDraft.Draft.type === "canvas",
                                    "bg-purple-500/20 text-purple-300 border border-purple-400/30":
                                        props.canvasDraft.Draft.type === "standalone",
                                    "bg-green-500/20 text-green-300 border border-green-400/30":
                                        props.canvasDraft.Draft.type === "versus"
                                }}
                            >
                                {props.canvasDraft.Draft.type === "canvas"
                                    ? "Canvas Only Draft"
                                    : props.canvasDraft.Draft.type === "standalone"
                                      ? "Stand Alone Draft"
                                      : "Versus Draft"}
                            </span>
                            <Show when={props.canvasDraft.is_locked}>
                                <span
                                    class="cursor-help rounded bg-slate-500/30 px-1.5 py-0.5 text-xs text-slate-300"
                                    title={
                                        props.canvasDraft.Draft.versus_draft_id
                                            ? `Game ${(props.canvasDraft.Draft.seriesIndex ?? 0) + 1} of imported series. Cannot be edited.`
                                            : "Imported from versus series. Cannot be edited."
                                    }
                                >
                                    Locked
                                </span>
                            </Show>
                        </div>
                    </div>
                    <div class="flex gap-1">
                        <div class="group relative">
                            <button
                                onClick={handleViewClick}
                                class="mr-1 flex size-7 items-center justify-center rounded bg-cyan-400"
                                classList={{
                                    "opacity-50 cursor-not-allowed":
                                        props.isConnectionMode,
                                    "cursor-pointer hover:bg-opacity-80":
                                        !props.isConnectionMode
                                }}
                                disabled={props.isConnectionMode}
                            >
                                <svg
                                    xmlns="http://www.w3.org/2000/svg"
                                    class="h-4 w-4"
                                    viewBox="0 0 24 24"
                                    fill="none"
                                    stroke="currentColor"
                                    stroke-width="2"
                                    stroke-linecap="round"
                                    stroke-linejoin="round"
                                >
                                    <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                                    <circle cx="12" cy="12" r="3" />
                                </svg>
                            </button>
                            <span class="pointer-events-none absolute -top-8 left-1/2 z-50 -translate-x-1/2 whitespace-nowrap rounded bg-slate-800 px-2 py-1 text-xs text-white opacity-0 transition-opacity group-hover:opacity-100">
                                View Full Screen
                            </span>
                        </div>
                        <div class="group relative">
                            <button
                                onClick={() => props.addBox(props.canvasDraft)}
                                class="mr-1 flex size-7 items-center justify-center rounded bg-green-400"
                                classList={{
                                    "opacity-50 cursor-not-allowed":
                                        props.isConnectionMode || !props.canEdit(),
                                    "cursor-pointer hover:bg-green-700":
                                        !props.isConnectionMode && props.canEdit()
                                }}
                                disabled={props.isConnectionMode || !props.canEdit()}
                            >
                                <svg
                                    xmlns="http://www.w3.org/2000/svg"
                                    class="h-4 w-4"
                                    viewBox="0 0 24 24"
                                    fill="none"
                                    stroke="currentColor"
                                    stroke-width="2"
                                    stroke-linecap="round"
                                    stroke-linejoin="round"
                                >
                                    <line x1="12" y1="5" x2="12" y2="19" />
                                    <line x1="5" y1="12" x2="19" y2="12" />
                                </svg>
                            </button>
                            <span class="pointer-events-none absolute -top-8 left-1/2 z-50 -translate-x-1/2 whitespace-nowrap rounded bg-slate-800 px-2 py-1 text-xs text-white opacity-0 transition-opacity group-hover:opacity-100">
                                Copy Draft
                            </span>
                        </div>
                        <Show
                            when={
                                !(
                                    props.canvasDraft.is_locked &&
                                    props.groupType === "series"
                                )
                            }
                        >
                            <div class="group relative">
                                <button
                                    onClick={() =>
                                        props.deleteBox(props.canvasDraft.Draft.id)
                                    }
                                    class="flex size-7 items-center justify-center rounded bg-red-400"
                                    classList={{
                                        "opacity-50 cursor-not-allowed":
                                            props.isConnectionMode || !props.canEdit(),
                                        "cursor-pointer hover:bg-red-600":
                                            !props.isConnectionMode && props.canEdit()
                                    }}
                                    disabled={props.isConnectionMode || !props.canEdit()}
                                >
                                    <svg
                                        xmlns="http://www.w3.org/2000/svg"
                                        class="h-4 w-4"
                                        viewBox="0 0 24 24"
                                        fill="none"
                                        stroke="currentColor"
                                        stroke-width="2"
                                        stroke-linecap="round"
                                        stroke-linejoin="round"
                                    >
                                        <line x1="18" y1="6" x2="6" y2="18" />
                                        <line x1="6" y1="6" x2="18" y2="18" />
                                    </svg>
                                </button>
                                <span class="pointer-events-none absolute -top-8 left-1/2 z-50 -translate-x-1/2 whitespace-nowrap rounded bg-slate-800 px-2 py-1 text-xs text-white opacity-0 transition-opacity group-hover:opacity-100">
                                    Delete Draft
                                </span>
                            </div>
                        </Show>
                    </div>
                </div>
            </div>
            <div class="mb-2 grid grid-cols-2 gap-1">
                <div class="text-center font-semibold text-blue-400">Blue</div>
                <div class="text-center font-semibold text-red-400">Red</div>
            </div>
            <div
                class={
                    props.layoutToggle()
                        ? "grid grid-flow-col grid-cols-4 grid-rows-5 gap-2 p-2"
                        : "grid grid-flow-col grid-cols-2 grid-rows-10 gap-2 p-2"
                }
            >
                <Index each={draftArrayMemo()}>
                    {(pick, index) => (
                        <CanvasSelect
                            index={() => index}
                            pick={pick()}
                            handlePickChange={props.handlePickChange}
                            draft={props.canvasDraft.Draft}
                            indexToShorthand={indexToShorthand()}
                            layoutToggle={props.layoutToggle}
                            disabled={
                                props.isConnectionMode ||
                                !props.canEdit() ||
                                !!props.canvasDraft.is_locked
                            }
                            focusedDraftId={props.focusedDraftId}
                            focusedSelectIndex={props.focusedSelectIndex}
                            onFocus={() =>
                                props.onSelectFocus(props.canvasDraft.Draft.id, index)
                            }
                            onSelectNext={props.onSelectNext}
                            onSelectPrevious={props.onSelectPrevious}
                        />
                    )}
                </Index>
            </div>
        </div>
    );
};

const debounce = (func: (...args: any[]) => void, limit: number) => {
    let inDebounce: boolean;
    return function (...args: any[]) {
        if (!inDebounce) {
            func(...args);
            inDebounce = true;
            setTimeout(() => (inDebounce = false), limit);
        }
    };
};

type CanvasComponentProps = {
    canvasData: CanvasResposnse | undefined;
    isLoading: boolean;
    isError: boolean;
    error: Error | null;
    isFetching: boolean;
    refetch: () => void;
    layoutToggle: () => boolean;
    setLayoutToggle: (val: boolean) => void;
    viewport: Accessor<Viewport>;
    setViewport: Setter<Viewport>;
};

const CanvasComponent = (props: CanvasComponentProps) => {
    const params = useParams();
    const navigate = useNavigate();
    const queryClient = useQueryClient();
    const accessor = useUser();
    const socketAccessor = accessor()[2];
    const canvasContext = useCanvasContext();

    // Reactive permission check - reads directly from context resource
    // This ensures permissions update when navigating between canvases
    const hasEditPermissions = () => {
        const perms = canvasContext.canvas()?.userPermissions;
        return perms === "edit" || perms === "admin";
    };

    const isLocalMode = () => params.id === "local";

    // Helper to refresh canvas data from localStorage after a local mutation
    const refreshFromLocal = () => {
        const local = getLocalCanvas();
        if (local) {
            setCanvasDrafts(local.drafts);
            setConnections(local.connections);
            setCanvasGroups(local.groups);
        }
    };

    const [canvasDrafts, setCanvasDrafts] = createStore<CanvasDraft[]>([]);
    const [connections, setConnections] = createStore<Connection[]>([]);
    const [canvasGroups, setCanvasGroups] = createStore<CanvasGroup[]>([]);
    const [isDeleteDialogOpen, setIsDeleteDialogOpen] = createSignal(false);
    const [draftToDelete, setDraftToDelete] = createSignal<CanvasDraft | null>(null);
    const [loadedCanvasId, setLoadedCanvasId] = createSignal<string | null>(null);
    const [isConnectionMode, setIsConnectionMode] = createSignal(false);
    const [connectionSource, setConnectionSource] = createSignal<string | null>(null);
    const [groupConnectionSource, setGroupConnectionSource] = createSignal<string | null>(
        null
    );
    const [sourceAnchor, setSourceAnchor] = createSignal<{
        type: AnchorType;
    } | null>(null);
    const [selectedVertexForConnection, setSelectedVertexForConnection] = createSignal<{
        connectionId: string;
        vertexId: string;
    } | null>(null);
    const [previewMousePos, setPreviewMousePos] = createSignal<{
        x: number;
        y: number;
    } | null>(null);
    const [dragState, setDragState] = createSignal<{
        activeBoxId: string | null;
        offsetX: number;
        offsetY: number;
        dragGroupId: string | null;
        isPanning: boolean;
        panStartX: number;
        panStartY: number;
        viewportStartX: number;
        viewportStartY: number;
    }>({
        activeBoxId: null,
        offsetX: 0,
        offsetY: 0,
        dragGroupId: null,
        isPanning: false,
        panStartX: 0,
        panStartY: 0,
        viewportStartX: 0,
        viewportStartY: 0
    });
    const [vertexDragState, setVertexDragState] = createSignal<{
        connectionId: string | null;
        vertexId: string | null;
        offsetX: number;
        offsetY: number;
    }>({
        connectionId: null,
        vertexId: null,
        offsetX: 0,
        offsetY: 0
    });
    const [groupDragState, setGroupDragState] = createSignal<{
        activeGroupId: string | null;
        offsetX: number;
        offsetY: number;
    }>({
        activeGroupId: null,
        offsetX: 0,
        offsetY: 0
    });
    const [focusedDraftId, setFocusedDraftId] = createSignal<string | null>(null);
    const [focusedSelectIndex, setFocusedSelectIndex] = createSignal<number>(-1);
    const [isImportDialogOpen, setIsImportDialogOpen] = createSignal(false);
    const [importPosition, setImportPosition] = createSignal({ x: 0, y: 0 });
    const [isDeleteGroupDialogOpen, setIsDeleteGroupDialogOpen] = createSignal(false);
    const [groupToDelete, setGroupToDelete] = createSignal<CanvasGroup | null>(null);
    const [createGroupPosition, setCreateGroupPosition] = createSignal({ x: 0, y: 0 });
    const [dragOverGroupId, setDragOverGroupId] = createSignal<string | null>(null);
    const [exitingGroupId, setExitingGroupId] = createSignal<string | null>(null);
    const [contextMenuPosition, setContextMenuPosition] = createSignal<{
        x: number;
        y: number;
    } | null>(null);
    const [contextMenuWorldPosition, setContextMenuWorldPosition] = createSignal({
        x: 0,
        y: 0
    });
    const [draftContextMenu, setDraftContextMenu] = createSignal<{
        draft: CanvasDraft;
        position: { x: number; y: number };
    } | null>(null);

    const [groupContextMenu, setGroupContextMenu] = createSignal<{
        group: CanvasGroup;
        position: { x: number; y: number };
    } | null>(null);

    const [editingGroupId, setEditingGroupId] = createSignal<string | null>(null);

    const ungroupedDrafts = createMemo(() => canvasDrafts.filter((cd) => !cd.group_id));

    const getDraftsForGroup = (groupId: string) =>
        canvasDrafts.filter((cd) => cd.group_id === groupId);

    let canvasContainerRef: HTMLDivElement | undefined;
    let svgRef: SVGSVGElement | undefined;

    // Function to navigate viewport to a draft's position
    const navigateToDraft = (positionX: number, positionY: number) => {
        if (canvasContainerRef) {
            const container = canvasContainerRef.getBoundingClientRect();
            const currentWidth = cardWidth(props.layoutToggle());
            const currentHeight = cardHeight(props.layoutToggle());
            props.setViewport((prev) => ({
                ...prev,
                x:
                    positionX -
                    container.width / 2 / prev.zoom +
                    currentWidth / 2 / prev.zoom,
                y:
                    positionY -
                    container.height / 2 / prev.zoom +
                    currentHeight / 2 / prev.zoom
            }));
        }
    };

    // Set the navigation callback in the context
    createEffect(() => {
        canvasContext.setNavigateToDraftCallback(() => navigateToDraft);

        onCleanup(() => {
            canvasContext.setNavigateToDraftCallback(null);
        });
    });

    // Set the import callback in the context
    createEffect(() => {
        canvasContext.setImportCallback(() => () => {
            // Calculate center of viewport
            const vp = props.viewport();
            const centerX = vp.x + window.innerWidth / 2 / vp.zoom;
            const centerY = vp.y + window.innerHeight / 2 / vp.zoom;
            setImportPosition({ x: centerX, y: centerY });
            setIsImportDialogOpen(true);
        });

        onCleanup(() => {
            canvasContext.setImportCallback(null);
        });
    });

    // Set the create group callback in the context
    createEffect(() => {
        canvasContext.setCreateGroupCallback(
            () => (positionX: number, positionY: number) => {
                const vp = props.viewport();
                const centerX = positionX || vp.x + window.innerWidth / 2 / vp.zoom;
                const centerY = positionY || vp.y + window.innerHeight / 2 / vp.zoom;
                setCreateGroupPosition({ x: centerX, y: centerY });
                handleCreateGroup();
            }
        );

        onCleanup(() => {
            canvasContext.setCreateGroupCallback(null);
        });
    });

    const updateCanvasNameMutation = useMutation(() => ({
        mutationFn: updateCanvasName,
        onSuccess: (data: { name: string; id: string }) => {
            queryClient.invalidateQueries({ queryKey: ["canvas", params.id] });
            toast.success("Canvas name updated");
            queryClient.setQueryData(["canvas", params.id], (oldData: any) => {
                return { ...oldData, name: data.name };
            });
        },
        onError: (error: Error) => {
            toast.error(`Failed to update canvas name: ${error.message}`);
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
            toast.success("Successfully created new draft!");
        },
        onError: (error) => {
            toast.error(`Error creating new draft: ${error.message}`);
        }
    }));

    const editDraftMutation = useMutation(() => ({
        mutationFn: (data: { id: string; name: string; public: boolean }) => {
            return editDraft(data.id, data);
        },
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ["canvas", params.id] });
            toast.success("Successfully edited draft!");
        },
        onError: (error) => {
            toast.error(`Error creating new draft: ${error.message}`);
        }
    }));

    const updatePositionMutation = useMutation(() => ({
        mutationFn: updateCanvasDraftPosition,
        onError: (error: Error) => {
            toast.error(`Failed to save position: ${error.message}`);
            queryClient.invalidateQueries({ queryKey: ["canvas", params.id] });
        }
    }));

    const deleteDraftMutation = useMutation(() => ({
        mutationFn: deleteDraftFromCanvas,
        onSuccess: () => {
            setIsDeleteDialogOpen(false);
            setDraftToDelete(null);
            toast.success("Successfully deleted draft");
        },
        onError: (error: Error) => {
            toast.error(`Error deleting draft: ${error.message}`);
        }
    }));

    const copyDraftMutation = useMutation(() => ({
        mutationFn: copyDraftInCanvas,
        onSuccess: () => {
            toast.success("Draft copied successfully");
        },
        onError: (error: Error) => {
            toast.error(`Error copying draft: ${error.message}`);
        }
    }));

    const updateViewportMutation = useMutation(() => ({
        mutationFn: updateCanvasViewport,
        onError: (error: Error) => {
            toast.error(`Error updating view: ${error.message}`);
        }
    }));

    const createConnectionMutation = useMutation(() => ({
        mutationFn: createConnection,
        onSuccess: () => {
            toast.success("Connection created!");
            queryClient.invalidateQueries({ queryKey: ["canvas", params.id] });
        },
        onError: (error: Error) => {
            toast.error(`Failed to create connection: ${error.message}`);
        }
    }));

    const updateConnectionMutation = useMutation(() => ({
        mutationFn: updateConnection,
        onSuccess: () => {
            toast.success("Connection updated!");
            queryClient.invalidateQueries({ queryKey: ["canvas", params.id] });
            setSelectedVertexForConnection(null);
        },
        onError: (error: Error) => {
            toast.error(`Failed to update connection: ${error.message}`);
        }
    }));

    const deleteConnectionMutation = useMutation(() => ({
        mutationFn: deleteConnection,
        onSuccess: () => {
            toast.success("Connection deleted!");
            queryClient.invalidateQueries({ queryKey: ["canvas", params.id] });
        },
        onError: (error: Error) => {
            toast.error(`Failed to delete connection: ${error.message}`);
        }
    }));

    const createVertexMutation = useMutation(() => ({
        mutationFn: createVertex,
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ["canvas", params.id] });
        },
        onError: (error: Error) => {
            toast.error(`Failed to create vertex: ${error.message}`);
        }
    }));

    const updateVertexMutation = useMutation(() => ({
        mutationFn: updateVertex,
        onError: (error: Error) => {
            toast.error(`Failed to update vertex: ${error.message}`);
            queryClient.invalidateQueries({ queryKey: ["canvas", params.id] });
        }
    }));

    const deleteVertexMutation = useMutation(() => ({
        mutationFn: deleteVertex,
        onSuccess: () => {
            toast.success("Vertex deleted!");
            queryClient.invalidateQueries({ queryKey: ["canvas", params.id] });
        },
        onError: (error: Error) => {
            toast.error(`Failed to delete vertex: ${error.message}`);
        }
    }));

    const updateGroupPositionMutation = useMutation(() => ({
        mutationFn: updateCanvasGroupPosition,
        onError: (error: Error) => {
            toast.error(`Failed to save group position: ${error.message}`);
            queryClient.invalidateQueries({ queryKey: ["canvas", params.id] });
        }
    }));

    const deleteGroupMutation = useMutation(() => ({
        mutationFn: deleteCanvasGroup,
        onSuccess: () => {
            const deletedGroupId = groupToDelete()?.id;
            setIsDeleteGroupDialogOpen(false);
            setGroupToDelete(null);
            if (deletedGroupId) {
                setCanvasGroups(canvasGroups.filter((g) => g.id !== deletedGroupId));
                setCanvasDrafts(
                    canvasDrafts.filter((cd) => cd.group_id !== deletedGroupId)
                );
            }
            toast.success("Group removed from canvas");
            canvasContext.refetchCanvas();
        },
        onError: (error: Error) => {
            toast.error(`Error removing group: ${error.message}`);
        }
    }));

    const createGroupMutation = useMutation(() => ({
        mutationFn: createCanvasGroup,
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ["canvas", params.id] });
            toast.success("Group created");
        },
        onError: (error: Error) => {
            toast.error(`Failed to create group: ${error.message}`);
        }
    }));

    const updateGroupMutation = useMutation(() => ({
        mutationFn: updateCanvasGroup,
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ["canvas", params.id] });
        },
        onError: (error: Error) => {
            toast.error(`Failed to update group: ${error.message}`);
        }
    }));

    const updateDraftGroupMutation = useMutation(() => ({
        mutationFn: updateCanvasDraft,
        onSuccess: (_data, variables) => {
            canvasContext.mutateCanvas((prev: CanvasResposnse | undefined) => {
                if (!prev) return prev;
                return {
                    ...prev,
                    drafts: prev.drafts.map((d) =>
                        d.Draft.id === variables.draftId
                            ? {
                                  ...d,
                                  group_id: variables.group_id ?? null,
                                  positionX: variables.positionX ?? d.positionX,
                                  positionY: variables.positionY ?? d.positionY
                              }
                            : d
                    )
                };
            });
        },
        onError: (error: Error) => {
            toast.error(`Failed to update draft: ${error.message}`);
        }
    }));

    const emitMove = (draftId: string, positionX: number, positionY: number) => {
        if (isLocalMode()) return;
        socketAccessor().emit("canvasObjectMove", {
            canvasId: params.id,
            draftId,
            positionX,
            positionY
        });
    };

    const debouncedEmitMove = debounce(emitMove, 25);

    const emitVertexMove = (
        connectionId: string,
        vertexId: string,
        x: number,
        y: number
    ) => {
        if (isLocalMode()) return;
        socketAccessor().emit("vertexMove", {
            canvasId: params.id,
            connectionId,
            vertexId,
            x,
            y
        });
    };

    const debouncedEmitVertexMove = debounce(emitVertexMove, 25);

    const emitGroupMove = (groupId: string, positionX: number, positionY: number) => {
        if (isLocalMode()) return;
        socketAccessor().emit("groupMove", {
            canvasId: params.id,
            groupId,
            positionX,
            positionY
        });
    };

    const debouncedEmitGroupMove = debounce(emitGroupMove, 25);

    const emitGroupResize = (groupId: string, width: number, height: number) => {
        if (isLocalMode()) return;
        socketAccessor().emit("groupResize", {
            canvasId: params.id,
            groupId,
            width,
            height
        });
    };

    const debouncedEmitGroupResize = debounce(emitGroupResize, 25);

    createEffect(() => {
        const currentId = params.id;
        const data = props.canvasData;
        if (!data || props.isLoading || currentId === loadedCanvasId()) return;

        // Leave old socket rooms if switching canvases
        const prevId = loadedCanvasId();
        if (prevId && !isLocalMode()) {
            socketAccessor().emit("leaveRoom", prevId);
            canvasDrafts.forEach((cd: CanvasDraft) => {
                socketAccessor().emit("leaveRoom", cd.Draft.id);
            });
        }

        // Reset stores with new canvas data
        setCanvasDrafts(data.drafts ?? []);
        setConnections(data.connections ?? []);
        setCanvasGroups(data.groups ?? []);

        // Reset viewport for the new canvas
        props.setViewport(data.lastViewport ?? { x: 0, y: 0, zoom: 1 });

        // Reset UI state
        setIsConnectionMode(false);
        setConnectionSource(null);
        setGroupConnectionSource(null);
        setSourceAnchor(null);
        setSelectedVertexForConnection(null);
        setContextMenuPosition(null);
        setIsDeleteDialogOpen(false);
        setDraftToDelete(null);

        // Join new socket rooms
        if (!isLocalMode()) {
            socketAccessor().emit("joinRoom", currentId);
            (data.drafts ?? []).forEach((draft: CanvasDraft) => {
                socketAccessor().emit("joinRoom", draft.Draft.id);
            });
        }

        setLoadedCanvasId(currentId);
    });

    // Leave socket rooms on component unmount
    onCleanup(() => {
        const prevId = loadedCanvasId();
        if (prevId && !isLocalMode()) {
            socketAccessor().emit("leaveRoom", prevId);
            canvasDrafts.forEach((cd: CanvasDraft) => {
                socketAccessor().emit("leaveRoom", cd.Draft.id);
            });
        }
    });

    createEffect(() => {
        if (isLocalMode()) return;
        socketAccessor().on(
            "canvasUpdate",
            (data: {
                canvas: { id: string; name: string };
                drafts: CanvasDraft[];
                connections: Connection[];
                groups?: CanvasGroup[];
            }) => {
                setCanvasDrafts(data.drafts);
                setConnections(data.connections);
                setCanvasGroups(data.groups ?? []);
                canvasContext.mutateCanvas((prev: CanvasResposnse | undefined) => {
                    if (!prev) return prev;
                    return {
                        ...prev,
                        name: data.canvas.name,
                        drafts: data.drafts,
                        groups: data.groups ?? prev.groups
                    };
                });
            }
        );
        socketAccessor().on(
            "draftUpdate",
            (data: { picks: string[]; id: string } | draft) => {
                setCanvasDrafts((cd) => cd.Draft.id === data.id, "Draft", "picks", [
                    ...data.picks
                ]);
            }
        );
        socketAccessor().on(
            "canvasObjectMoved",
            (data: { draftId: string; positionX: number; positionY: number }) => {
                if (dragState().activeBoxId !== data.draftId) {
                    setCanvasDrafts((cd) => cd.Draft.id === data.draftId, {
                        positionX: data.positionX,
                        positionY: data.positionY
                    });
                }
            }
        );
        socketAccessor().on(
            "connectionCreated",
            (data: { connection: Connection; allConnections: Connection[] }) => {
                setConnections(data.allConnections);
            }
        );
        socketAccessor().on(
            "connectionUpdated",
            (data: { connection: Connection; allConnections: Connection[] }) => {
                setConnections(data.allConnections);
            }
        );
        socketAccessor().on(
            "connectionDeleted",
            (data: { connectionId: string; allConnections: Connection[] }) => {
                setConnections(data.allConnections);
            }
        );
        socketAccessor().on(
            "vertexCreated",
            (data: {
                connectionId: string;
                vertex: any;
                allConnections: Connection[];
            }) => {
                setConnections(data.allConnections);
            }
        );
        socketAccessor().on(
            "vertexMoved",
            (data: { connectionId: string; vertexId: string; x: number; y: number }) => {
                const vState = vertexDragState();
                // Don't update if we're the one dragging this vertex
                if (
                    vState.connectionId !== data.connectionId ||
                    vState.vertexId !== data.vertexId
                ) {
                    setConnections(
                        (conn) => conn.id === data.connectionId,
                        "vertices",
                        (v) => v.id === data.vertexId,
                        { x: data.x, y: data.y }
                    );
                }
            }
        );
        socketAccessor().on(
            "vertexUpdated",
            (data: { connectionId: string; vertexId: string; x: number; y: number }) => {
                const vState = vertexDragState();
                // Don't update if we're the one dragging this vertex
                if (
                    vState.connectionId !== data.connectionId ||
                    vState.vertexId !== data.vertexId
                ) {
                    setConnections(
                        (conn) => conn.id === data.connectionId,
                        "vertices",
                        (v) => v.id === data.vertexId,
                        { x: data.x, y: data.y }
                    );
                }
            }
        );
        socketAccessor().on(
            "vertexDeleted",
            (data: {
                connectionId: string;
                vertexId: string;
                connection: Connection;
            }) => {
                setConnections(
                    (conn) => conn.id === data.connectionId,
                    (conn) => ({
                        ...conn,
                        vertices: conn.vertices.filter((v) => v.id !== data.vertexId)
                    })
                );
            }
        );
        socketAccessor().on(
            "groupMoved",
            (data: { groupId: string; positionX: number; positionY: number }) => {
                const gState = groupDragState();
                if (gState.activeGroupId !== data.groupId) {
                    setCanvasGroups((g) => g.id === data.groupId, {
                        positionX: data.positionX,
                        positionY: data.positionY
                    });
                }
            }
        );
        socketAccessor().on(
            "groupResized",
            (data: { groupId: string; width: number; height: number }) => {
                setCanvasGroups((g) => g.id === data.groupId, {
                    width: data.width,
                    height: data.height
                });
            }
        );
        onCleanup(() => {
            socketAccessor().off("canvasUpdate");
            socketAccessor().off("draftUpdate");
            socketAccessor().off("canvasObjectMoved");
            socketAccessor().off("connectionCreated");
            socketAccessor().off("connectionUpdated");
            socketAccessor().off("connectionDeleted");
            socketAccessor().off("vertexCreated");
            socketAccessor().off("vertexMoved");
            socketAccessor().off("vertexUpdated");
            socketAccessor().off("vertexDeleted");
            socketAccessor().off("groupMoved");
            socketAccessor().off("groupResized");
        });
    });

    const handleCanvasNameChange = (newName: string) => {
        if (newName.trim() && newName !== props.canvasData?.name) {
            if (isLocalMode()) {
                localUpdateCanvasName({ name: newName });
                toast.success("Canvas name updated");
            } else {
                updateCanvasNameMutation.mutate({
                    canvasId: params.id,
                    name: newName
                });
            }
        }
    };

    const addBox = (fromBox: CanvasDraft) => {
        if (!hasEditPermissions()) return;
        if (isLocalMode()) {
            localNewDraft({
                name: fromBox.Draft.name,
                picks: fromBox.Draft.picks,
                positionX: fromBox.positionX + 100,
                positionY: fromBox.positionY + 100
            });
            refreshFromLocal();
            toast.success("Successfully created new draft!");
        } else {
            newDraftMutation.mutate({
                name: fromBox.Draft.name,
                picks: fromBox.Draft.picks,
                public: false,
                canvas_id: params.id,
                positionX: fromBox.positionX + 100,
                positionY: fromBox.positionY + 100
            });
        }
    };

    const deleteBox = (draftId: string) => {
        if (!hasEditPermissions()) return;
        const draft = canvasDrafts.find((d) => d.Draft.id === draftId);
        if (draft) {
            setDraftToDelete(draft);
            setIsDeleteDialogOpen(true);
        }
    };

    const handlePickChange = (
        draftId: string,
        pickIndex: number,
        championName: string
    ) => {
        if (!hasEditPermissions()) return;
        const champIndex = champions.findIndex((value) => value.name === championName);
        setCanvasDrafts(
            (cd) => cd.Draft.id === draftId,
            "Draft",
            (Draft) => {
                const holdPicks = [...Draft.picks];
                holdPicks[pickIndex] = champIndex !== -1 ? String(champIndex) : "";
                if (!isLocalMode()) {
                    socketAccessor().emit("newDraft", {
                        picks: holdPicks,
                        id: draftId
                    });
                }
                return { ...Draft, picks: holdPicks };
            }
        );

        // Persist to localStorage in local mode
        if (isLocalMode()) {
            const local = getLocalCanvas();
            if (local) {
                const draft = local.drafts.find((d) => d.Draft.id === draftId);
                if (draft) {
                    const holdPicks = [...draft.Draft.picks];
                    holdPicks[pickIndex] = champIndex !== -1 ? String(champIndex) : "";
                    draft.Draft.picks = holdPicks;
                    saveLocalCanvas(local);
                }
            }
        }
    };

    const handleNameChange = (draftId: string, newName: string) => {
        if (!hasEditPermissions()) return;
        if (isLocalMode()) {
            localEditDraft(draftId, { name: newName });
            refreshFromLocal();
            toast.success("Successfully edited draft!");
        } else {
            editDraftMutation.mutate({
                id: draftId,
                name: newName,
                public: false
            });
        }
    };

    const clearConnectionSelection = () => {
        setConnectionSource(null);
        setGroupConnectionSource(null);
        setSourceAnchor(null);
        setPreviewMousePos(null);
    };

    const onAnchorClick = (draftId: string, anchorType: AnchorType) => {
        if (!isConnectionMode()) return;

        const selectedVertex = selectedVertexForConnection();
        const source = connectionSource();
        const groupSource = groupConnectionSource();

        // If a vertex is selected, add this draft as target
        if (selectedVertex) {
            if (isLocalMode()) {
                localUpdateConnection({
                    connectionId: selectedVertex.connectionId,
                    addTarget: { draftId, anchorType }
                });
                refreshFromLocal();
                toast.success("Connection updated!");
            } else {
                updateConnectionMutation.mutate({
                    canvasId: params.id,
                    connectionId: selectedVertex.connectionId,
                    addTarget: { draftId, anchorType }
                });
            }
            setSelectedVertexForConnection(null);
            return;
        }

        // If a group is the source, create group-to-draft connection
        if (groupSource) {
            const srcAnchor = sourceAnchor();
            if (isLocalMode()) {
                localCreateConnection({
                    sourceDraftIds: [
                        { groupId: groupSource, anchorType: srcAnchor?.type }
                    ],
                    targetDraftIds: [{ draftId, anchorType }]
                });
                refreshFromLocal();
                toast.success("Connection created!");
            } else {
                createConnectionMutation.mutate({
                    canvasId: params.id,
                    sourceDraftIds: [
                        { groupId: groupSource, anchorType: srcAnchor?.type }
                    ],
                    targetDraftIds: [{ draftId, anchorType }]
                });
            }
            clearConnectionSelection();
            return;
        }

        // If no anchor selected yet, select this anchor
        if (!source) {
            setConnectionSource(draftId);
            setSourceAnchor({ type: anchorType });
            setPreviewMousePos(null);
        } else if (source !== draftId) {
            // Different draft clicked - create new connection
            const srcAnchor = sourceAnchor();
            if (isLocalMode()) {
                localCreateConnection({
                    sourceDraftIds: [{ draftId: source, anchorType: srcAnchor?.type }],
                    targetDraftIds: [{ draftId, anchorType }]
                });
                refreshFromLocal();
                toast.success("Connection created!");
            } else {
                createConnectionMutation.mutate({
                    canvasId: params.id,
                    sourceDraftIds: [{ draftId: source, anchorType: srcAnchor?.type }],
                    targetDraftIds: [{ draftId, anchorType }]
                });
            }
            clearConnectionSelection();
        } else if (source === draftId) {
            clearConnectionSelection();
        }
    };

    const onGroupAnchorClick = (groupId: string, anchorType: AnchorType) => {
        if (!isConnectionMode()) return;

        const selectedVertex = selectedVertexForConnection();
        const source = connectionSource();
        const groupSource = groupConnectionSource();

        // If a vertex is selected, add this group as target
        if (selectedVertex) {
            if (isLocalMode()) {
                localUpdateConnection({
                    connectionId: selectedVertex.connectionId,
                    addTarget: { groupId, anchorType }
                });
                refreshFromLocal();
                toast.success("Connection updated!");
            } else {
                updateConnectionMutation.mutate({
                    canvasId: params.id,
                    connectionId: selectedVertex.connectionId,
                    addTarget: { groupId, anchorType }
                });
            }
            setSelectedVertexForConnection(null);
            return;
        }

        // If a draft source is selected, create draft-to-group connection
        if (source) {
            const srcAnchor = sourceAnchor();
            if (isLocalMode()) {
                localCreateConnection({
                    sourceDraftIds: [{ draftId: source, anchorType: srcAnchor?.type }],
                    targetDraftIds: [{ groupId, anchorType }]
                });
                refreshFromLocal();
                toast.success("Connection created!");
            } else {
                createConnectionMutation.mutate({
                    canvasId: params.id,
                    sourceDraftIds: [{ draftId: source, anchorType: srcAnchor?.type }],
                    targetDraftIds: [{ groupId, anchorType }]
                });
            }
            clearConnectionSelection();
            return;
        }

        // If a group source is selected
        if (groupSource) {
            if (groupSource !== groupId) {
                // Different group - create group-to-group connection
                const srcAnchor = sourceAnchor();
                if (isLocalMode()) {
                    localCreateConnection({
                        sourceDraftIds: [
                            { groupId: groupSource, anchorType: srcAnchor?.type }
                        ],
                        targetDraftIds: [{ groupId, anchorType }]
                    });
                    refreshFromLocal();
                    toast.success("Connection created!");
                } else {
                    createConnectionMutation.mutate({
                        canvasId: params.id,
                        sourceDraftIds: [
                            { groupId: groupSource, anchorType: srcAnchor?.type }
                        ],
                        targetDraftIds: [{ groupId, anchorType }]
                    });
                }
            }
            clearConnectionSelection();
            return;
        }

        // No source selected yet - select this group as source
        setGroupConnectionSource(groupId);
        setConnectionSource(null);
        setSourceAnchor({ type: anchorType });
        setPreviewMousePos(null);
    };

    const handleDeleteConnection = (connectionId: string) => {
        if (isLocalMode()) {
            localDeleteConnection(connectionId);
            refreshFromLocal();
            toast.success("Connection deleted!");
        } else {
            deleteConnectionMutation.mutate({
                canvasId: params.id,
                connectionId
            });
        }
    };

    const toggleConnectionMode = () => {
        setIsConnectionMode(!isConnectionMode());
        clearConnectionSelection();
        setSelectedVertexForConnection(null);
    };

    const handleConnectionClick = (connectionId: string) => {
        if (!isConnectionMode()) return;

        const source = connectionSource();
        const groupSource = groupConnectionSource();
        const srcAnchor = sourceAnchor();

        if (source && srcAnchor) {
            if (isLocalMode()) {
                localUpdateConnection({
                    connectionId,
                    addSource: { draftId: source, anchorType: srcAnchor.type }
                });
                refreshFromLocal();
                toast.success("Connection updated!");
            } else {
                updateConnectionMutation.mutate({
                    canvasId: params.id,
                    connectionId,
                    addSource: { draftId: source, anchorType: srcAnchor.type }
                });
            }
            clearConnectionSelection();
        } else if (groupSource && srcAnchor) {
            if (isLocalMode()) {
                localUpdateConnection({
                    connectionId,
                    addSource: { groupId: groupSource, anchorType: srcAnchor.type }
                });
                refreshFromLocal();
                toast.success("Connection updated!");
            } else {
                updateConnectionMutation.mutate({
                    canvasId: params.id,
                    connectionId,
                    addSource: { groupId: groupSource, anchorType: srcAnchor.type }
                });
            }
            clearConnectionSelection();
        }
    };

    const handleVertexClick = (connectionId: string, vertexId: string) => {
        if (!isConnectionMode()) return;

        const source = connectionSource();
        const groupSource = groupConnectionSource();
        const srcAnchor = sourceAnchor();

        if (source && srcAnchor) {
            if (isLocalMode()) {
                localUpdateConnection({
                    connectionId,
                    addSource: { draftId: source, anchorType: srcAnchor.type }
                });
                refreshFromLocal();
                toast.success("Connection updated!");
            } else {
                updateConnectionMutation.mutate({
                    canvasId: params.id,
                    connectionId,
                    addSource: { draftId: source, anchorType: srcAnchor.type }
                });
            }
            clearConnectionSelection();
            return;
        }

        if (groupSource && srcAnchor) {
            if (isLocalMode()) {
                localUpdateConnection({
                    connectionId,
                    addSource: { groupId: groupSource, anchorType: srcAnchor.type }
                });
                refreshFromLocal();
                toast.success("Connection updated!");
            } else {
                updateConnectionMutation.mutate({
                    canvasId: params.id,
                    connectionId,
                    addSource: { groupId: groupSource, anchorType: srcAnchor.type }
                });
            }
            clearConnectionSelection();
            return;
        }

        // Otherwise, select the vertex (for adding targets)
        setSelectedVertexForConnection({ connectionId, vertexId });
    };

    const screenToWorld = (screenX: number, screenY: number) => {
        const vp = props.viewport();
        const rect = canvasContainerRef?.getBoundingClientRect();
        const canvasX = rect ? screenX - rect.left : screenX;
        const canvasY = rect ? screenY - rect.top : screenY;
        return {
            x: canvasX / vp.zoom + vp.x,
            y: canvasY / vp.zoom + vp.y
        };
    };

    const isPointInGroup = (x: number, y: number, group: CanvasGroup): boolean => {
        const width = group.width ?? 400;
        const height = group.height ?? 200;
        return (
            x >= group.positionX &&
            x <= group.positionX + width &&
            y >= group.positionY &&
            y <= group.positionY + height
        );
    };

    const findGroupAtPosition = (x: number, y: number): CanvasGroup | null => {
        return (
            canvasGroups.find((g) => g.type === "custom" && isPointInGroup(x, y, g)) ??
            null
        );
    };

    const onBoxMouseDown = (draftId: string, e: MouseEvent) => {
        if (isConnectionMode()) return;
        if (!hasEditPermissions()) return;

        const target = e.target as HTMLElement;
        if (target.closest("select, button, input")) {
            return;
        }
        e.preventDefault();
        const cd = canvasDrafts.find((b) => b.Draft.id === draftId);
        if (cd) {
            const worldCoords = screenToWorld(e.clientX, e.clientY);

            // For custom-grouped drafts, compute offset using world position
            const customGroup = cd.group_id
                ? canvasGroups.find((g) => g.id === cd.group_id && g.type === "custom")
                : null;
            const worldX = customGroup
                ? customGroup.positionX + cd.positionX
                : cd.positionX;
            const worldY = customGroup
                ? customGroup.positionY + cd.positionY
                : cd.positionY;

            setDragState({
                activeBoxId: draftId,
                offsetX: worldCoords.x - worldX,
                offsetY: worldCoords.y - worldY,
                dragGroupId: customGroup ? customGroup.id : null,
                isPanning: false,
                panStartX: 0,
                panStartY: 0,
                viewportStartX: 0,
                viewportStartY: 0
            });
        }
    };

    const onBackgroundMouseDown = (e: MouseEvent) => {
        if (isConnectionMode()) {
            clearConnectionSelection();
        }

        const target = e.target as HTMLElement;
        if (target === canvasContainerRef || canvasContainerRef?.contains(target)) {
            const vp = props.viewport();
            setDragState({
                activeBoxId: null,
                offsetX: 0,
                offsetY: 0,
                dragGroupId: null,
                isPanning: true,
                panStartX: e.clientX,
                panStartY: e.clientY,
                viewportStartX: vp.x,
                viewportStartY: vp.y
            });
        }
    };

    const onBackgroundDoubleClick = (e: MouseEvent) => {
        if (isConnectionMode()) return;
        if (!hasEditPermissions()) return;

        const target = e.target as HTMLElement;
        if (target === canvasContainerRef || canvasContainerRef?.contains(target)) {
            e.preventDefault();

            const canvasRect = target.getBoundingClientRect();
            const canvasRelativeX = e.clientX - canvasRect.left;
            const canvasRelativeY = e.clientY - canvasRect.top;
            const vp = props.viewport();
            const worldX = canvasRelativeX / vp.zoom + vp.x;
            const worldY = canvasRelativeY / vp.zoom + vp.y;

            if (isLocalMode()) {
                localNewDraft({
                    name: "New Draft",
                    picks: Array(20).fill(""),
                    positionX: worldX,
                    positionY: worldY
                });
                refreshFromLocal();
                toast.success("Successfully created new draft!");
            } else {
                newDraftMutation.mutate({
                    name: "New Draft",
                    picks: Array(20).fill(""),
                    public: false,
                    canvas_id: params.id,
                    positionX: worldX,
                    positionY: worldY
                });
            }
        }
    };

    const debouncedSaveViewport = debounce((viewport: Viewport) => {
        if (isLocalMode()) {
            localUpdateViewport(viewport);
        } else {
            updateViewportMutation.mutate({
                canvasId: params.id,
                viewport
            });
        }
    }, 1000);

    const onVertexDragStart = (
        connectionId: string,
        vertexId: string,
        positionX: number,
        positionY: number,
        e: MouseEvent
    ) => {
        e.stopPropagation();
        const worldCoords = screenToWorld(e.clientX, e.clientY);
        setVertexDragState({
            connectionId,
            vertexId,
            offsetX: worldCoords.x - positionX,
            offsetY: worldCoords.y - positionY
        });
    };

    const handleCreateVertex = (connectionId: string, x: number, y: number) => {
        if (isLocalMode()) {
            localCreateVertex({ connectionId, x, y });
            refreshFromLocal();
        } else {
            createVertexMutation.mutate({
                canvasId: params.id,
                connectionId,
                x,
                y
            });
        }
    };

    const handleDeleteVertex = (connectionId: string, vertexId: string) => {
        if (isLocalMode()) {
            localDeleteVertex({ connectionId, vertexId });
            refreshFromLocal();
            toast.success("Vertex deleted!");
        } else {
            deleteVertexMutation.mutate({
                canvasId: params.id,
                connectionId,
                vertexId
            });
        }
    };

    const onSelectFocus = (draftId: string, selectIndex: number) => {
        setFocusedDraftId(draftId);
        setFocusedSelectIndex(selectIndex);
    };

    const onSelectNext = () => {
        const holdSelectIndex = focusedSelectIndex();
        setFocusedSelectIndex(holdSelectIndex === 19 ? -1 : holdSelectIndex + 1);
    };

    const onSelectPrevious = () => {
        const holdSelectIndex = focusedSelectIndex();
        setFocusedSelectIndex(holdSelectIndex === 0 ? 19 : holdSelectIndex - 1);
    };

    const onGroupMouseDown = (groupId: string, e: MouseEvent) => {
        if (isConnectionMode()) return;
        if (!hasEditPermissions()) return;

        const target = e.target as HTMLElement;
        if (target.closest("button")) return;

        e.preventDefault();
        const group = canvasGroups.find((g) => g.id === groupId);
        if (group) {
            const worldCoords = screenToWorld(e.clientX, e.clientY);
            setGroupDragState({
                activeGroupId: groupId,
                offsetX: worldCoords.x - group.positionX,
                offsetY: worldCoords.y - group.positionY
            });
        }
    };

    const handleDeleteGroup = (groupId: string) => {
        if (!hasEditPermissions()) return;
        const group = canvasGroups.find((g) => g.id === groupId);
        if (group) {
            setGroupToDelete(group);
            setIsDeleteGroupDialogOpen(true);
        }
    };

    const handleDeleteGroupWithChoice = (keepDrafts: boolean) => {
        const group = groupToDelete();
        if (group) {
            if (isLocalMode()) {
                localDeleteGroup(group.id, keepDrafts);
                setIsDeleteGroupDialogOpen(false);
                setGroupToDelete(null);
                refreshFromLocal();
                toast.success("Group removed from canvas");
            } else {
                deleteGroupMutation.mutate({
                    canvasId: params.id,
                    groupId: group.id,
                    keepDrafts
                });
            }
        }
    };

    const onDeleteGroupCancel = () => {
        setIsDeleteGroupDialogOpen(false);
        setGroupToDelete(null);
    };

    const handleCreateGroup = () => {
        const pos = createGroupPosition();
        if (isLocalMode()) {
            localCreateGroup({
                positionX: pos.x,
                positionY: pos.y
            });
            refreshFromLocal();
            toast.success("Group created");
        } else {
            createGroupMutation.mutate({
                canvasId: params.id,
                positionX: pos.x,
                positionY: pos.y
            });
        }
    };

    const handleRenameGroup = (groupId: string, newName: string) => {
        if (!hasEditPermissions()) return;
        if (isLocalMode()) {
            localUpdateGroup({ groupId, name: newName });
            refreshFromLocal();
        } else {
            updateGroupMutation.mutate({
                canvasId: params.id,
                groupId,
                name: newName
            });
        }
    };

    const handleResizeGroup = (groupId: string, width: number, height: number) => {
        if (!hasEditPermissions()) return;
        setCanvasGroups((g) => g.id === groupId, { width, height });
        debouncedEmitGroupResize(groupId, width, height);
    };

    const handleResizeEnd = (groupId: string, width: number, height: number) => {
        if (!hasEditPermissions()) return;
        if (isLocalMode()) {
            localUpdateGroup({ groupId, width, height });
            refreshFromLocal();
        } else {
            updateGroupMutation.mutate({
                canvasId: params.id,
                groupId,
                width,
                height
            });
        }
    };

    const GROUP_PADDING = 16;

    const computeMinGroupSize = (groupId: string) => {
        const drafts = getDraftsForGroup(groupId);
        if (drafts.length === 0) return { minWidth: 0, minHeight: 0 };

        const cw = cardWidth(props.layoutToggle());
        const ch = cardHeight(props.layoutToggle());

        let maxRight = 0;
        let maxBottom = 0;
        for (const d of drafts) {
            maxRight = Math.max(maxRight, d.positionX + cw + GROUP_PADDING);
            maxBottom = Math.max(maxBottom, d.positionY + ch + GROUP_PADDING);
        }

        return { minWidth: maxRight, minHeight: maxBottom };
    };

    const maybeExpandGroup = (
        group: CanvasGroup,
        draftRelX: number,
        draftRelY: number
    ) => {
        const cw = cardWidth(props.layoutToggle());
        const ch = cardHeight(props.layoutToggle());
        const currentWidth = group.width ?? 400;
        const currentHeight = group.height ?? 200;

        const neededWidth = draftRelX + cw + GROUP_PADDING;
        const neededHeight = draftRelY + ch + GROUP_PADDING;

        if (neededWidth > currentWidth || neededHeight > currentHeight) {
            const newWidth = Math.max(currentWidth, neededWidth);
            const newHeight = Math.max(currentHeight, neededHeight);
            setCanvasGroups((g) => g.id === group.id, {
                width: newWidth,
                height: newHeight
            });
            if (isLocalMode()) {
                localUpdateGroup({
                    groupId: group.id,
                    width: newWidth,
                    height: newHeight
                });
            } else {
                updateGroupMutation.mutate({
                    canvasId: params.id,
                    groupId: group.id,
                    width: newWidth,
                    height: newHeight
                });
            }
        }
    };

    const handleCanvasContextMenu = (e: MouseEvent) => {
        const target = e.target as HTMLElement;
        if (target.closest(".canvas-card") || target.closest(".group-container")) {
            return;
        }

        e.preventDefault();

        if (!hasEditPermissions()) return;

        const worldPos = screenToWorld(e.clientX, e.clientY);
        setContextMenuWorldPosition(worldPos);
        setContextMenuPosition({ x: e.clientX, y: e.clientY });
    };

    const closeContextMenu = (e?: MouseEvent) => {
        if (e && (e.target as HTMLElement).closest(".canvas-context-menu")) return;
        setContextMenuPosition(null);
    };

    const handleDraftContextMenu = (draft: CanvasDraft, e: MouseEvent) => {
        setDraftContextMenu({
            draft,
            position: { x: e.clientX, y: e.clientY }
        });
    };

    const closeDraftContextMenu = () => {
        setDraftContextMenu(null);
    };

    const handleGroupContextMenu = (group: CanvasGroup, e: MouseEvent) => {
        if (!hasEditPermissions()) return;
        e.preventDefault();
        setGroupContextMenu({
            group,
            position: { x: e.clientX, y: e.clientY }
        });
    };

    const closeGroupContextMenu = () => {
        setGroupContextMenu(null);
    };

    const handleDraftView = (draft: CanvasDraft) => {
        navigate(`/canvas/${params.id}/draft/${draft.Draft.id}`);
    };

    const handleDraftGoTo = (draft: CanvasDraft) => {
        // For grouped drafts, calculate actual position
        const group = draft.group_id
            ? canvasGroups.find((g) => g.id === draft.group_id)
            : null;
        if (group && group.type === "custom") {
            navigateToDraft(
                group.positionX + draft.positionX,
                group.positionY + draft.positionY
            );
        } else if (group && group.type === "series") {
            // Series groups position drafts horizontally
            const groupDrafts = canvasDrafts.filter((cd) => cd.group_id === group.id);
            const sortedDrafts = [...groupDrafts].sort(
                (a, b) => (a.Draft.seriesIndex ?? 0) - (b.Draft.seriesIndex ?? 0)
            );
            const draftIndex = sortedDrafts.findIndex(
                (cd) => cd.Draft.id === draft.Draft.id
            );
            const PADDING = 20;
            const CARD_GAP = 24;
            const cw = props.layoutToggle() ? 700 : 350;
            const offsetX = PADDING + draftIndex * (cw + CARD_GAP);
            navigateToDraft(group.positionX + offsetX, group.positionY);
        } else {
            navigateToDraft(draft.positionX, draft.positionY);
        }
    };

    const handleDraftCopy = (draft: CanvasDraft) => {
        if (isLocalMode()) {
            localCopyDraft(draft.Draft.id);
            refreshFromLocal();
            toast.success("Draft copied successfully");
        } else {
            copyDraftMutation.mutate({
                canvasId: params.id,
                draftId: draft.Draft.id
            });
        }
    };

    const handleDraftDelete = (draft: CanvasDraft) => {
        setDraftToDelete(draft);
        setIsDeleteDialogOpen(true);
    };

    const tabOrder = [
        0, 10, 1, 11, 2, 12, 3, 13, 4, 14, 5, 15, 6, 16, 7, 17, 8, 18, 9, 19
    ];

    const moveToNextSelect = () => {
        const currentDraftId = focusedDraftId();
        const currentIndex = focusedSelectIndex();

        if (currentDraftId === null || currentIndex === -1) return;

        const currentPosition = tabOrder.indexOf(currentIndex);
        if (currentPosition === -1) return;

        const nextPosition = (currentPosition + 1) % tabOrder.length;
        const nextIndex = tabOrder[nextPosition];
        setFocusedSelectIndex(nextIndex);
    };

    const moveToPreviousSelect = () => {
        const currentDraftId = focusedDraftId();
        const currentIndex = focusedSelectIndex();

        if (currentDraftId === null || currentIndex === -1) return;

        const currentPosition = tabOrder.indexOf(currentIndex);
        if (currentPosition === -1) return;

        const prevPosition = (currentPosition - 1 + tabOrder.length) % tabOrder.length;
        const prevIndex = tabOrder[prevPosition];

        setFocusedSelectIndex(prevIndex);
    };

    onMount(() => {
        const onKeyDown = (e: KeyboardEvent) => {
            if (e.key === "Tab" && focusedDraftId() !== null) {
                e.preventDefault();
                if (e.shiftKey) {
                    moveToPreviousSelect();
                } else {
                    moveToNextSelect();
                }
                return;
            }

            if (e.key === "Escape" && isConnectionMode()) {
                e.preventDefault();
                if (
                    connectionSource() ||
                    groupConnectionSource() ||
                    selectedVertexForConnection()
                ) {
                    // First escape: clear any selections
                    clearConnectionSelection();
                    setSelectedVertexForConnection(null);
                } else {
                    // Second escape: exit connection mode
                    setIsConnectionMode(false);
                }
            } else if (e.key === "Enter" && isConnectionMode()) {
                e.preventDefault();
                setIsConnectionMode(false);
                clearConnectionSelection();
                setSelectedVertexForConnection(null);
            }
        };

        const onWindowMouseMove = (e: MouseEvent) => {
            if (
                isConnectionMode() &&
                (connectionSource() || groupConnectionSource()) &&
                canvasContainerRef
            ) {
                const canvasRect = canvasContainerRef.getBoundingClientRect();
                const canvasRelativeX = e.clientX - canvasRect.left;
                const canvasRelativeY = e.clientY - canvasRect.top;
                setPreviewMousePos({ x: canvasRelativeX, y: canvasRelativeY });
            }

            const vState = vertexDragState();
            if (vState.connectionId && vState.vertexId) {
                const worldCoords = screenToWorld(e.clientX, e.clientY);
                const newX = worldCoords.x - vState.offsetX;
                const newY = worldCoords.y - vState.offsetY;

                // Optimistic update
                setConnections(
                    (conn) => conn.id === vState.connectionId,
                    "vertices",
                    (v) => v.id === vState.vertexId,
                    { x: newX, y: newY }
                );

                // Emit socket update for live collaboration
                debouncedEmitVertexMove(vState.connectionId, vState.vertexId, newX, newY);
                return;
            }

            const gState = groupDragState();
            if (gState.activeGroupId) {
                const worldCoords = screenToWorld(e.clientX, e.clientY);
                const newX = worldCoords.x - gState.offsetX;
                const newY = worldCoords.y - gState.offsetY;
                setCanvasGroups((g) => g.id === gState.activeGroupId, {
                    positionX: newX,
                    positionY: newY
                });
                debouncedEmitGroupMove(gState.activeGroupId, newX, newY);
                return;
            }

            const state = dragState();

            if (state.isPanning) {
                const deltaX = e.clientX - state.panStartX;
                const deltaY = e.clientY - state.panStartY;
                const vp = props.viewport();
                const holdViewport = {
                    ...vp,
                    x: state.viewportStartX - deltaX / vp.zoom,
                    y: state.viewportStartY - deltaY / vp.zoom
                };
                props.setViewport(holdViewport);
                debouncedSaveViewport(holdViewport);
            } else if (state.activeBoxId !== null) {
                const worldCoords = screenToWorld(e.clientX, e.clientY);
                const newWorldX = worldCoords.x - state.offsetX;
                const newWorldY = worldCoords.y - state.offsetY;

                if (state.dragGroupId) {
                    // Dragging within a custom group — store group-relative position
                    const group = canvasGroups.find((g) => g.id === state.dragGroupId);
                    if (group) {
                        setCanvasDrafts((cd) => cd.Draft.id === state.activeBoxId, {
                            positionX: newWorldX - group.positionX,
                            positionY: newWorldY - group.positionY
                        });
                    }
                } else {
                    setCanvasDrafts((cd) => cd.Draft.id === state.activeBoxId, {
                        positionX: newWorldX,
                        positionY: newWorldY
                    });
                    debouncedEmitMove(state.activeBoxId, newWorldX, newWorldY);
                }

                // Check for group hover during draft drag (always in world coords)
                const hoverGroup = findGroupAtPosition(newWorldX, newWorldY);
                const currentGroupId =
                    state.dragGroupId ||
                    canvasDrafts.find((cd) => cd.Draft.id === state.activeBoxId)
                        ?.group_id;

                if (hoverGroup && hoverGroup.id !== currentGroupId) {
                    setDragOverGroupId(hoverGroup.id);
                    if (currentGroupId) {
                        setExitingGroupId(currentGroupId);
                    }
                } else {
                    setDragOverGroupId(null);
                    if (!hoverGroup && currentGroupId) {
                        setExitingGroupId(currentGroupId);
                    } else {
                        setExitingGroupId(null);
                    }
                }
            }
        };

        const onWindowMouseUp = () => {
            const vertexDrag = vertexDragState();
            if (vertexDrag.connectionId && vertexDrag.vertexId) {
                const connection = connections.find(
                    (c) => c.id === vertexDrag.connectionId
                );
                const vertex = connection?.vertices.find(
                    (v) => v.id === vertexDrag.vertexId
                );

                if (connection && vertex) {
                    if (isLocalMode()) {
                        localUpdateVertex({
                            connectionId: vertexDrag.connectionId,
                            vertexId: vertexDrag.vertexId,
                            x: vertex.x,
                            y: vertex.y
                        });
                    } else {
                        updateVertexMutation.mutate({
                            canvasId: params.id,
                            connectionId: vertexDrag.connectionId,
                            vertexId: vertexDrag.vertexId,
                            x: vertex.x,
                            y: vertex.y
                        });
                    }
                }

                setVertexDragState({
                    connectionId: null,
                    vertexId: null,
                    offsetX: 0,
                    offsetY: 0
                });
                return;
            }

            const gState = groupDragState();
            if (gState.activeGroupId) {
                const group = canvasGroups.find((g) => g.id === gState.activeGroupId);
                if (group) {
                    if (isLocalMode()) {
                        localUpdateGroupPosition({
                            groupId: gState.activeGroupId,
                            positionX: group.positionX,
                            positionY: group.positionY
                        });
                    } else {
                        updateGroupPositionMutation.mutate({
                            canvasId: params.id,
                            groupId: gState.activeGroupId,
                            positionX: group.positionX,
                            positionY: group.positionY
                        });
                    }
                }
                setGroupDragState({
                    activeGroupId: null,
                    offsetX: 0,
                    offsetY: 0
                });
                return;
            }

            const state = dragState();
            if (state.activeBoxId) {
                const finalDraft = canvasDrafts.find(
                    (cd) => cd.Draft.id === state.activeBoxId
                );
                if (finalDraft) {
                    // Convert to world coords for group detection
                    let worldX: number, worldY: number;
                    if (state.dragGroupId) {
                        const sourceGroup = canvasGroups.find(
                            (g) => g.id === state.dragGroupId
                        );
                        worldX = sourceGroup
                            ? sourceGroup.positionX + finalDraft.positionX
                            : finalDraft.positionX;
                        worldY = sourceGroup
                            ? sourceGroup.positionY + finalDraft.positionY
                            : finalDraft.positionY;
                    } else {
                        worldX = finalDraft.positionX;
                        worldY = finalDraft.positionY;
                    }

                    const dropGroup = findGroupAtPosition(worldX, worldY);

                    if (dropGroup && dropGroup.id !== finalDraft.group_id) {
                        // Moving to a different group
                        const relativeX = worldX - dropGroup.positionX;
                        const relativeY = worldY - dropGroup.positionY;

                        setCanvasDrafts((cd) => cd.Draft.id === state.activeBoxId, {
                            positionX: relativeX,
                            positionY: relativeY,
                            group_id: dropGroup.id
                        });

                        if (isLocalMode()) {
                            localUpdateDraftGroup({
                                draftId: finalDraft.Draft.id,
                                positionX: relativeX,
                                positionY: relativeY,
                                group_id: dropGroup.id
                            });
                        } else {
                            updateDraftGroupMutation.mutate({
                                canvasId: params.id,
                                draftId: finalDraft.Draft.id,
                                positionX: relativeX,
                                positionY: relativeY,
                                group_id: dropGroup.id
                            });
                        }

                        maybeExpandGroup(dropGroup, relativeX, relativeY);
                    } else if (!dropGroup && finalDraft.group_id) {
                        // Dropped outside all groups - ungroup if in a custom group
                        const currentGroup = canvasGroups.find(
                            (g) => g.id === finalDraft.group_id
                        );
                        if (currentGroup && currentGroup.type === "custom") {
                            // Store world-absolute position and clear group
                            setCanvasDrafts((cd) => cd.Draft.id === state.activeBoxId, {
                                positionX: worldX,
                                positionY: worldY,
                                group_id: null
                            });

                            if (isLocalMode()) {
                                localUpdateDraftGroup({
                                    draftId: finalDraft.Draft.id,
                                    positionX: worldX,
                                    positionY: worldY,
                                    group_id: null
                                });
                            } else {
                                updateDraftGroupMutation.mutate({
                                    canvasId: params.id,
                                    draftId: finalDraft.Draft.id,
                                    positionX: worldX,
                                    positionY: worldY,
                                    group_id: null
                                });
                            }
                        }
                    } else {
                        // Same group or ungrouped — save position
                        if (isLocalMode()) {
                            localUpdateDraftPosition({
                                draftId: state.activeBoxId,
                                positionX: finalDraft.positionX,
                                positionY: finalDraft.positionY
                            });
                        } else {
                            updatePositionMutation.mutate({
                                canvasId: params.id,
                                draftId: state.activeBoxId,
                                positionX: finalDraft.positionX,
                                positionY: finalDraft.positionY
                            });
                        }

                        // Auto-expand if repositioned within a custom group
                        if (state.dragGroupId && dropGroup) {
                            maybeExpandGroup(
                                dropGroup,
                                finalDraft.positionX,
                                finalDraft.positionY
                            );
                        }
                    }
                }
            }

            // Clear drag visual states
            setDragOverGroupId(null);
            setExitingGroupId(null);

            setDragState({
                activeBoxId: null,
                offsetX: 0,
                offsetY: 0,
                dragGroupId: null,
                isPanning: false,
                panStartX: 0,
                panStartY: 0,
                viewportStartX: 0,
                viewportStartY: 0
            });
        };

        const onWindowWheel = (e: WheelEvent) => {
            const target = e.target as HTMLElement;
            if (target === canvasContainerRef || canvasContainerRef?.contains(target)) {
                e.preventDefault();
                const vp = props.viewport();
                const zoomFactor = e.deltaY > 0 ? 0.9 : 1.1;
                const newZoom = Math.max(0.1, Math.min(5, vp.zoom * zoomFactor));

                const mouseWorldBefore = screenToWorld(e.clientX, e.clientY);
                const mouseWorldAfter = screenToWorld(e.clientX, e.clientY);

                props.setViewport({
                    zoom: newZoom,
                    x: vp.x - (mouseWorldAfter.x - mouseWorldBefore.x),
                    y: vp.y - (mouseWorldAfter.y - mouseWorldBefore.y)
                });
            }
        };

        window.addEventListener("keydown", onKeyDown);
        window.addEventListener("mousemove", onWindowMouseMove);
        window.addEventListener("mouseup", onWindowMouseUp);
        window.addEventListener("wheel", onWindowWheel, { passive: false });
        window.addEventListener("mousedown", closeContextMenu);

        onCleanup(() => {
            window.removeEventListener("keydown", onKeyDown);
            window.removeEventListener("mousemove", onWindowMouseMove);
            window.removeEventListener("mouseup", onWindowMouseUp);
            window.removeEventListener("wheel", onWindowWheel);
            window.removeEventListener("mousedown", closeContextMenu);
        });
    });

    const resetViewport = () => {
        props.setViewport({ x: 0, y: 0, zoom: 1 });
    };

    const onDelete = () => {
        if (draftToDelete()) {
            if (isLocalMode()) {
                localDeleteDraft(draftToDelete()?.Draft?.id ?? "");
                setIsDeleteDialogOpen(false);
                setDraftToDelete(null);
                refreshFromLocal();
                toast.success("Successfully deleted draft");
            } else {
                deleteDraftMutation.mutate({
                    canvas: params.id,
                    draft: draftToDelete()?.Draft?.id ?? ""
                });
            }
        }
    };

    const onCancel = () => {
        setIsDeleteDialogOpen(false);
        setDraftToDelete(null);
    };

    return (
        <Show
            when={!props.isLoading && !props.isError}
            fallback={
                <Show
                    when={props.isError}
                    fallback={
                        <div class="flex h-full w-full items-center justify-center">
                            <div class="text-lg">Loading canvas...</div>
                        </div>
                    }
                >
                    <div class="flex h-full w-full flex-col items-center justify-center gap-4">
                        <div class="text-lg text-red-600">
                            Error loading canvas: {props.error?.message}
                        </div>
                        <button
                            onClick={() => props.refetch()}
                            class="rounded bg-blue-500 px-4 py-2 text-white hover:bg-blue-600"
                        >
                            Retry
                        </button>
                    </div>
                </Show>
            }
        >
            <div
                class="relative h-full w-full overflow-hidden"
                ref={canvasContainerRef}
                onContextMenu={handleCanvasContextMenu}
            >
                <div class="absolute left-4 top-4 z-40 flex gap-2">
                    <input
                        type="text"
                        value={props.canvasData?.name || ""}
                        onInput={(e) => e.currentTarget.value}
                        onBlur={(e) => handleCanvasNameChange(e.currentTarget.value)}
                        onKeyDown={(e) => {
                            if (e.key === "Enter" || e.key === "Escape") {
                                e.currentTarget.blur();
                            }
                        }}
                        class="rounded border border-slate-500 bg-slate-600 px-3 py-1.5 text-slate-50 shadow focus:border-purple-400 focus:outline-none"
                        placeholder="Canvas Name"
                        disabled={isConnectionMode() || !hasEditPermissions()}
                    />
                    <Show when={hasEditPermissions()}>
                        <button
                            onClick={toggleConnectionMode}
                            class="rounded px-4 py-2 font-semibold text-white shadow transition-colors"
                            classList={{
                                "bg-purple-600 hover:bg-purple-700": !isConnectionMode(),
                                "bg-green-600 hover:bg-green-700": isConnectionMode()
                            }}
                        >
                            {isConnectionMode() ? "✓ Connection Mode" : "Connection Mode"}
                        </button>
                    </Show>
                    <div class="rounded border border-slate-500 bg-slate-600 px-3 py-1.5 text-center text-slate-50 shadow">
                        Zoom: {Math.round(props.viewport().zoom * 100)}%
                    </div>
                    <button
                        onClick={resetViewport}
                        class="rounded-md bg-purple-600 px-3 py-2 text-center text-sm font-medium text-slate-200 hover:bg-purple-500"
                    >
                        Reset View
                    </button>
                </div>
                <Show when={isLocalMode()}>
                    <div class="absolute right-4 top-4 z-40 flex items-center gap-2 rounded-lg border border-yellow-600/30 bg-yellow-900/40 px-3 py-1.5 text-xs text-yellow-300 shadow-lg backdrop-blur-sm">
                        <span>Local only</span>
                        <span class="text-yellow-500">&mdash;</span>
                        <button
                            onClick={() => handleLogin()}
                            class="font-medium text-yellow-200 underline underline-offset-2 hover:text-yellow-100"
                        >
                            Sign in to save
                        </button>
                    </div>
                </Show>
                <Show when={props.isFetching}>
                    <div class="rounded border bg-blue-100 px-3 py-1 text-sm text-blue-800 shadow">
                        Syncing...
                    </div>
                </Show>
                <div
                    class="canvas-background absolute inset-0 cursor-move bg-slate-700"
                    onMouseDown={onBackgroundMouseDown}
                    onDblClick={onBackgroundDoubleClick}
                >
                    <svg
                        ref={svgRef}
                        class="pointer-events-none absolute inset-0 z-30 h-full w-full"
                    >
                        <For each={connections}>
                            {(connection) => (
                                <ConnectionComponent
                                    connection={connection}
                                    drafts={canvasDrafts}
                                    groups={canvasGroups}
                                    viewport={props.viewport}
                                    onDeleteConnection={handleDeleteConnection}
                                    onCreateVertex={handleCreateVertex}
                                    onDeleteVertex={handleDeleteVertex}
                                    onVertexDragStart={onVertexDragStart}
                                    isConnectionMode={isConnectionMode()}
                                    onConnectionClick={handleConnectionClick}
                                    onVertexClick={handleVertexClick}
                                    selectedVertexId={
                                        selectedVertexForConnection()?.vertexId || null
                                    }
                                    layoutToggle={props.layoutToggle}
                                />
                            )}
                        </For>
                        <Show when={connectionSource()}>
                            <ConnectionPreview
                                startDraft={
                                    canvasDrafts.find(
                                        (d) => d.Draft.id === connectionSource()!
                                    )!
                                }
                                startGroup={(() => {
                                    const draft = canvasDrafts.find(
                                        (d) => d.Draft.id === connectionSource()!
                                    );
                                    if (!draft?.group_id) return null;
                                    return (
                                        canvasGroups.find(
                                            (g) => g.id === draft.group_id
                                        ) ?? null
                                    );
                                })()}
                                sourceAnchor={sourceAnchor()}
                                mousePos={previewMousePos()}
                                viewport={props.viewport}
                                layoutToggle={props.layoutToggle}
                            />
                        </Show>
                        <Show when={groupConnectionSource()}>
                            <GroupConnectionPreview
                                startGroup={
                                    canvasGroups.find(
                                        (g) => g.id === groupConnectionSource()!
                                    )!
                                }
                                sourceAnchor={sourceAnchor()}
                                mousePos={previewMousePos()}
                                viewport={props.viewport}
                            />
                        </Show>
                    </svg>
                </div>
                {/* Render Groups */}
                <For each={canvasGroups}>
                    {(group) => (
                        <Show
                            when={group.type === "series"}
                            fallback={
                                <CustomGroupContainer
                                    group={group}
                                    drafts={getDraftsForGroup(group.id)}
                                    viewport={props.viewport}
                                    onGroupMouseDown={onGroupMouseDown}
                                    onDeleteGroup={handleDeleteGroup}
                                    onRenameGroup={handleRenameGroup}
                                    onResizeGroup={handleResizeGroup}
                                    onResizeEnd={handleResizeEnd}
                                    canEdit={hasEditPermissions}
                                    isConnectionMode={isConnectionMode()}
                                    isDragTarget={dragOverGroupId() === group.id}
                                    isExitingSource={exitingGroupId() === group.id}
                                    contentMinWidth={
                                        computeMinGroupSize(group.id).minWidth
                                    }
                                    contentMinHeight={
                                        computeMinGroupSize(group.id).minHeight
                                    }
                                    onSelectAnchor={onGroupAnchorClick}
                                    isGroupSelected={groupConnectionSource() === group.id}
                                    sourceAnchor={sourceAnchor()}
                                    onContextMenu={handleGroupContextMenu}
                                    editingGroupId={editingGroupId}
                                >
                                    <For each={getDraftsForGroup(group.id)}>
                                        {(cd) => (
                                            <CanvasCard
                                                canvasId={params.id}
                                                canvasDraft={cd}
                                                addBox={addBox}
                                                deleteBox={deleteBox}
                                                handleNameChange={handleNameChange}
                                                handlePickChange={handlePickChange}
                                                viewport={props.viewport}
                                                onBoxMouseDown={onBoxMouseDown}
                                                onContextMenu={handleDraftContextMenu}
                                                layoutToggle={props.layoutToggle}
                                                setLayoutToggle={props.setLayoutToggle}
                                                isConnectionMode={isConnectionMode()}
                                                onAnchorClick={onAnchorClick}
                                                connectionSource={connectionSource}
                                                sourceAnchor={sourceAnchor}
                                                focusedDraftId={focusedDraftId}
                                                focusedSelectIndex={focusedSelectIndex}
                                                onSelectFocus={onSelectFocus}
                                                onSelectNext={onSelectNext}
                                                onSelectPrevious={onSelectPrevious}
                                                canEdit={hasEditPermissions}
                                                isGrouped={true}
                                                groupType="custom"
                                            />
                                        )}
                                    </For>
                                </CustomGroupContainer>
                            }
                        >
                            <SeriesGroupContainer
                                group={group}
                                drafts={getDraftsForGroup(group.id)}
                                viewport={props.viewport}
                                onGroupMouseDown={onGroupMouseDown}
                                onDeleteGroup={handleDeleteGroup}
                                canEdit={hasEditPermissions}
                                isConnectionMode={isConnectionMode()}
                                renderDraftCard={(cd) => (
                                    <CanvasCard
                                        canvasId={params.id}
                                        canvasDraft={cd}
                                        addBox={addBox}
                                        deleteBox={deleteBox}
                                        handleNameChange={handleNameChange}
                                        handlePickChange={handlePickChange}
                                        viewport={props.viewport}
                                        onBoxMouseDown={onBoxMouseDown}
                                        onContextMenu={handleDraftContextMenu}
                                        layoutToggle={props.layoutToggle}
                                        setLayoutToggle={props.setLayoutToggle}
                                        isConnectionMode={isConnectionMode()}
                                        onAnchorClick={onAnchorClick}
                                        connectionSource={connectionSource}
                                        sourceAnchor={sourceAnchor}
                                        focusedDraftId={focusedDraftId}
                                        focusedSelectIndex={focusedSelectIndex}
                                        onSelectFocus={onSelectFocus}
                                        onSelectNext={onSelectNext}
                                        onSelectPrevious={onSelectPrevious}
                                        canEdit={hasEditPermissions}
                                        isGrouped={true}
                                        groupType="series"
                                    />
                                )}
                            />
                        </Show>
                    )}
                </For>

                {/* Render Ungrouped Drafts */}
                <For each={ungroupedDrafts()}>
                    {(cd) => (
                        <CanvasCard
                            canvasId={params.id}
                            canvasDraft={cd}
                            addBox={addBox}
                            deleteBox={deleteBox}
                            handleNameChange={handleNameChange}
                            handlePickChange={handlePickChange}
                            viewport={props.viewport}
                            onBoxMouseDown={onBoxMouseDown}
                            onContextMenu={handleDraftContextMenu}
                            layoutToggle={props.layoutToggle}
                            setLayoutToggle={props.setLayoutToggle}
                            isConnectionMode={isConnectionMode()}
                            onAnchorClick={onAnchorClick}
                            connectionSource={connectionSource}
                            sourceAnchor={sourceAnchor}
                            focusedDraftId={focusedDraftId}
                            focusedSelectIndex={focusedSelectIndex}
                            onSelectFocus={onSelectFocus}
                            onSelectNext={onSelectNext}
                            onSelectPrevious={onSelectPrevious}
                            canEdit={hasEditPermissions}
                        />
                    )}
                </For>
                <Dialog
                    isOpen={isDeleteDialogOpen}
                    onCancel={onCancel}
                    body={
                        <>
                            <h3 class="mb-4 text-lg font-bold text-slate-50">
                                Confirm Deletion
                            </h3>
                            <p class="mb-6 text-slate-200">
                                Are you sure you want to delete the draft "
                                {draftToDelete()?.Draft.name}
                                "?
                            </p>
                            <div class="flex justify-end gap-4">
                                <button
                                    onClick={onCancel}
                                    class="rounded bg-purple-600 px-4 py-2 text-slate-50 hover:bg-purple-500"
                                >
                                    Cancel
                                </button>
                                <button
                                    onClick={onDelete}
                                    class="rounded bg-red-400 px-4 py-2 text-slate-50 hover:bg-red-600"
                                >
                                    Delete
                                </button>
                            </div>
                        </>
                    }
                />
                <Dialog
                    isOpen={isImportDialogOpen}
                    onCancel={() => setIsImportDialogOpen(false)}
                    body={
                        <ImportToCanvasDialog
                            canvasId={params.id}
                            positionX={importPosition().x}
                            positionY={importPosition().y}
                            onClose={() => setIsImportDialogOpen(false)}
                            onSuccess={() => {
                                canvasContext.refetchCanvas();
                            }}
                        />
                    }
                />
                <Dialog
                    isOpen={isDeleteGroupDialogOpen}
                    onCancel={onDeleteGroupCancel}
                    body={
                        <Show when={groupToDelete()}>
                            {(group) => (
                                <Show
                                    when={group().type === "custom"}
                                    fallback={
                                        <>
                                            <h3 class="mb-4 text-lg font-bold text-slate-50">
                                                Remove Series from Canvas?
                                            </h3>
                                            <p class="mb-4 text-slate-200">
                                                This will remove "{group().name}" and all
                                                its games from this canvas.
                                            </p>
                                            <p class="mb-6 text-sm text-slate-400">
                                                The original series data will not be
                                                deleted - you can re-import it later.
                                            </p>
                                            <div class="flex justify-end gap-4">
                                                <button
                                                    onClick={onDeleteGroupCancel}
                                                    class="rounded bg-purple-600 px-4 py-2 text-slate-50 hover:bg-purple-500"
                                                >
                                                    Cancel
                                                </button>
                                                <button
                                                    onClick={() =>
                                                        handleDeleteGroupWithChoice(false)
                                                    }
                                                    class="rounded bg-red-400 px-4 py-2 text-slate-50 hover:bg-red-600"
                                                >
                                                    Remove
                                                </button>
                                            </div>
                                        </>
                                    }
                                >
                                    <DeleteGroupDialog
                                        group={group()}
                                        draftCount={getDraftsForGroup(group().id).length}
                                        onKeepDrafts={() =>
                                            handleDeleteGroupWithChoice(true)
                                        }
                                        onDeleteAll={() =>
                                            handleDeleteGroupWithChoice(false)
                                        }
                                        onCancel={onDeleteGroupCancel}
                                    />
                                </Show>
                            )}
                        </Show>
                    }
                />
                {/* Context Menu */}
                <Show when={contextMenuPosition()}>
                    <div
                        class="canvas-context-menu fixed z-50 rounded-md border border-slate-500 bg-slate-700 py-1 shadow-lg"
                        style={{
                            left: `${contextMenuPosition()?.x ?? 0}px`,
                            top: `${contextMenuPosition()?.y ?? 0}px`
                        }}
                    >
                        <button
                            class="w-full px-4 py-2 text-left text-sm text-slate-200 hover:bg-slate-600"
                            onClick={() => {
                                const pos = contextMenuWorldPosition();
                                if (isLocalMode()) {
                                    localNewDraft({
                                        name: "New Draft",
                                        picks: Array(20).fill(""),
                                        positionX: pos.x,
                                        positionY: pos.y
                                    });
                                    refreshFromLocal();
                                    toast.success("Successfully created new draft!");
                                } else {
                                    newDraftMutation.mutate({
                                        name: "New Draft",
                                        picks: Array(20).fill(""),
                                        public: false,
                                        canvas_id: params.id,
                                        positionX: pos.x,
                                        positionY: pos.y
                                    });
                                }
                                closeContextMenu();
                            }}
                        >
                            Create Draft
                        </button>
                        <button
                            class="w-full px-4 py-2 text-left text-sm text-slate-200 hover:bg-slate-600"
                            onClick={() => {
                                const pos = contextMenuWorldPosition();
                                setCreateGroupPosition(pos);
                                handleCreateGroup();
                                closeContextMenu();
                            }}
                        >
                            Create Group
                        </button>
                    </div>
                </Show>
                {/* Draft Context Menu */}
                <Show when={draftContextMenu()}>
                    {(menu) => (
                        <DraftContextMenu
                            position={menu().position}
                            draft={menu().draft}
                            onView={() => handleDraftView(menu().draft)}
                            onGoTo={() => handleDraftGoTo(menu().draft)}
                            onCopy={() => handleDraftCopy(menu().draft)}
                            onDelete={() => handleDraftDelete(menu().draft)}
                            onClose={closeDraftContextMenu}
                        />
                    )}
                </Show>
            </div>
        </Show>
    );
};

export default CanvasComponent;
