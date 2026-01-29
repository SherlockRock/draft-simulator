import {
    For,
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
    updateCanvasGroupPosition
} from "./utils/actions";
import { useNavigate, useParams } from "@solidjs/router";
import { toast } from "solid-toast";
import { useUser } from "./userProvider";
import { CanvasDraft, draft, Viewport, Connection, CanvasGroup } from "./utils/types";
import { CanvasSelect } from "./components/CanvasSelect";
import { Dialog } from "./components/Dialog";
import { ImportToCanvasDialog } from "./components/ImportToCanvasDialog";
import { ConnectionComponent, ConnectionPreview } from "./components/Connections";
import { AnchorPoints } from "./components/AnchorPoints";
import { AnchorType } from "./utils/types";
import { useCanvasContext } from "./workflows/CanvasWorkflow";
import { cardHeight, cardWidth } from "./utils/helpers";
import { SeriesGroupContainer } from "./components/SeriesGroupContainer";

type cardProps = {
    canvasDraft: CanvasDraft;
    addBox: (fromBox: CanvasDraft) => void;
    deleteBox: (draftId: string) => void;
    handleNameChange: (draftId: string, newName: string) => void;
    handlePickChange: (draftId: string, pickIndex: number, championName: string) => void;
    onBoxMouseDown: (draftId: string, e: MouseEvent) => void;
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
    canEdit: boolean;
    // Props for grouped mode
    isGrouped?: boolean;
    groupType?: "series" | "custom";
};

const CanvasCard = (props: cardProps) => {
    const navigate = useNavigate();
    const queryClient = useQueryClient();
    const params = useParams();
    const [nameSignal, setNameSignal] = createSignal(props.canvasDraft.Draft.name);
    const [isConversionDialogOpen, setIsConversionDialogOpen] = createSignal(false);

    const convertToStandaloneMutation = useMutation(() => ({
        mutationFn: (draftId: string) => {
            return editDraft(draftId, { type: "standalone" });
        },
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ["canvas", params.id] });
            toast.success("Draft converted to standalone!");
            setIsConversionDialogOpen(false);
            navigate(`/draft/${props.canvasDraft.Draft.id}`);
        },
        onError: (error: Error) => {
            toast.error(`Failed to convert draft: ${error.message}`);
        }
    }));

    const handleViewClick = () => {
        if (props.canvasDraft.Draft.type === "canvas") {
            setIsConversionDialogOpen(true);
        } else {
            navigate(`/draft/${props.canvasDraft.Draft.id}`);
        }
    };

    const handleConvertConfirm = () => {
        convertToStandaloneMutation.mutate(props.canvasDraft.Draft.id);
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
            class="flex flex-col rounded-md border border-slate-500 bg-slate-600 shadow-lg"
            classList={{
                "absolute z-30": !props.isGrouped,
                "ring-4 ring-blue-400": props.isConnectionMode && !selected(),
                "ring-4 ring-green-400": selected(),
                "flex-shrink-0": props.isGrouped
            }}
            style={{
                ...(props.isGrouped
                    ? {}
                    : {
                          left: `${screenPos().x}px`,
                          top: `${screenPos().y}px`,
                          transform: `scale(${props.viewport().zoom})`,
                          "transform-origin": "top left"
                      }),
                width: props.layoutToggle() ? "700px" : "350px",
                cursor:
                    props.isConnectionMode || !props.canEdit || props.isGrouped
                        ? "default"
                        : "move"
            }}
            onMouseDown={(e) => {
                if (!props.isConnectionMode && !props.isGrouped) {
                    props.onBoxMouseDown(props.canvasDraft.Draft.id, e);
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
                                !props.canEdit ||
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
                                            ? `Game ${(props.canvasDraft.Draft.seriesIndex ?? 0) + 1} of imported series`
                                            : "Imported from versus series"
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
                                class={`mr-1 flex size-7 items-center justify-center rounded ${props.canvasDraft.Draft.type === "canvas" ? "bg-orange-400" : "bg-cyan-400"}`}
                                classList={{
                                    "opacity-50 cursor-not-allowed":
                                        props.isConnectionMode ||
                                        (props.canvasDraft.Draft.type === "canvas" &&
                                            !props.canEdit),
                                    "cursor-pointer hover:bg-opacity-80":
                                        !props.isConnectionMode &&
                                        (props.canvasDraft.Draft.type !== "canvas" ||
                                            props.canEdit)
                                }}
                                disabled={
                                    props.isConnectionMode ||
                                    (props.canvasDraft.Draft.type === "canvas" &&
                                        !props.canEdit)
                                }
                            >
                                <Show
                                    when={props.canvasDraft.Draft.type === "canvas"}
                                    fallback={
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
                                    }
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
                                        <line x1="5" y1="12" x2="19" y2="12" />
                                        <polyline points="12 5 19 12 12 19" />
                                    </svg>
                                </Show>
                            </button>
                            <span class="pointer-events-none absolute -top-8 left-1/2 z-50 -translate-x-1/2 whitespace-nowrap rounded bg-slate-800 px-2 py-1 text-xs text-white opacity-0 transition-opacity group-hover:opacity-100">
                                {props.canvasDraft.Draft.type === "canvas"
                                    ? "Convert to Stand Alone"
                                    : "View as Stand Alone"}
                            </span>
                        </div>
                        <div class="group relative">
                            <button
                                onClick={() => props.addBox(props.canvasDraft)}
                                class="mr-1 flex size-7 items-center justify-center rounded bg-green-400"
                                classList={{
                                    "opacity-50 cursor-not-allowed":
                                        props.isConnectionMode || !props.canEdit,
                                    "cursor-pointer hover:bg-green-700":
                                        !props.isConnectionMode && props.canEdit
                                }}
                                disabled={props.isConnectionMode || !props.canEdit}
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
                                            props.isConnectionMode || !props.canEdit,
                                        "cursor-pointer hover:bg-red-600":
                                            !props.isConnectionMode && props.canEdit
                                    }}
                                    disabled={props.isConnectionMode || !props.canEdit}
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
                <For each={draftArrayMemo()}>
                    {(pick, index) => (
                        <CanvasSelect
                            index={index}
                            pick={pick}
                            handlePickChange={props.handlePickChange}
                            draft={props.canvasDraft.Draft}
                            indexToShorthand={indexToShorthand()}
                            layoutToggle={props.layoutToggle}
                            disabled={
                                props.isConnectionMode ||
                                !props.canEdit ||
                                !!props.canvasDraft.is_locked
                            }
                            focusedDraftId={props.focusedDraftId}
                            focusedSelectIndex={props.focusedSelectIndex}
                            onFocus={() =>
                                props.onSelectFocus(props.canvasDraft.Draft.id, index())
                            }
                            onSelectNext={props.onSelectNext}
                            onSelectPrevious={props.onSelectPrevious}
                        />
                    )}
                </For>
            </div>
            <Dialog
                isOpen={isConversionDialogOpen}
                onCancel={() => setIsConversionDialogOpen(false)}
                body={
                    <>
                        <h3 class="mb-4 text-lg font-bold text-slate-50">
                            Convert to Standalone Draft?
                        </h3>
                        <p class="mb-6 text-slate-200">
                            This will convert "{props.canvasDraft.Draft.name}" from a
                            canvas-only draft to a standalone draft. You'll be able to
                            view and edit it independently, and it will no longer be
                            restricted to this canvas.
                        </p>
                        <p class="mb-6 text-sm text-slate-300">
                            The draft will remain on this canvas, but you'll be able to
                            access it from your drafts list.
                        </p>
                        <div class="flex justify-end gap-4">
                            <button
                                onClick={() => setIsConversionDialogOpen(false)}
                                class="rounded bg-slate-500 px-4 py-2 text-slate-50 hover:bg-slate-600"
                            >
                                Cancel
                            </button>
                            <button
                                onClick={handleConvertConfirm}
                                class="rounded bg-orange-500 px-4 py-2 text-slate-50 hover:bg-orange-600"
                                disabled={convertToStandaloneMutation.isPending}
                            >
                                {convertToStandaloneMutation.isPending
                                    ? "Converting..."
                                    : "Convert to Standalone"}
                            </button>
                        </div>
                    </>
                }
            />
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

const hasEditPermissions = (userPermissions?: string) => {
    return userPermissions === "edit" || userPermissions === "admin";
};

const CanvasComponent = (props: CanvasComponentProps) => {
    const params = useParams();
    const queryClient = useQueryClient();
    const accessor = useUser();
    const socketAccessor = accessor()[2];
    const canvasContext = useCanvasContext();
    const [canvasDrafts, setCanvasDrafts] = createStore<CanvasDraft[]>([]);
    const [connections, setConnections] = createStore<Connection[]>([]);
    const [canvasGroups, setCanvasGroups] = createStore<CanvasGroup[]>([]);
    const [isDeleteDialogOpen, setIsDeleteDialogOpen] = createSignal(false);
    const [draftToDelete, setDraftToDelete] = createSignal<CanvasDraft | null>(null);
    const [viewportInitialized, setViewportInitialized] = createSignal(false);
    const [isConnectionMode, setIsConnectionMode] = createSignal(false);
    const [connectionSource, setConnectionSource] = createSignal<string | null>(null);
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
        isPanning: boolean;
        panStartX: number;
        panStartY: number;
        viewportStartX: number;
        viewportStartY: number;
    }>({
        activeBoxId: null,
        offsetX: 0,
        offsetY: 0,
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
            queryClient.invalidateQueries({ queryKey: ["canvas", params.id] });
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
            queryClient.invalidateQueries({ queryKey: ["canvas", params.id] });
        },
        onError: (error: Error) => {
            toast.error(`Error deleting draft: ${error.message}`);
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
            toast.success("Series removed from canvas");
            canvasContext.refetchCanvas();
        },
        onError: (error: Error) => {
            toast.error(`Error removing series: ${error.message}`);
        }
    }));

    const emitMove = (draftId: string, positionX: number, positionY: number) => {
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
        socketAccessor().emit("groupMove", {
            canvasId: params.id,
            groupId,
            positionX,
            positionY
        });
    };

    const debouncedEmitGroupMove = debounce(emitGroupMove, 25);

    createEffect(() => {
        if (props.canvasData && canvasDrafts.length === 0) {
            setCanvasDrafts(props.canvasData.drafts ?? []);
            setConnections(props.canvasData.connections ?? []);
            setCanvasGroups(props.canvasData.groups ?? []);
            if (!viewportInitialized()) {
                props.setViewport(
                    props.canvasData.lastViewport ?? { x: 0, y: 0, zoom: 1 }
                );
                setViewportInitialized(true);
            }

            // Multi-context room joins: join canvas room + all draft rooms
            socketAccessor().emit("joinRoom", params.id);
            props.canvasData.drafts.forEach((draft: CanvasDraft) => {
                socketAccessor().emit("joinRoom", draft.Draft.id);
            });
        }

        onCleanup(() => {
            if (props.canvasData && canvasDrafts.length === 0) {
                socketAccessor().emit("leaveRoom", params.id);
                props.canvasData.drafts.forEach((draft: CanvasDraft) => {
                    socketAccessor().emit("leaveRoom", draft.Draft.id);
                });
            }
        });
    });

    createEffect(() => {
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
                queryClient.setQueryData(["canvas", params.id], (oldData: any) => {
                    return { ...oldData, name: data.canvas.name };
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
        });
    });

    const handleCanvasNameChange = (newName: string) => {
        if (newName.trim() && newName !== props.canvasData?.name) {
            updateCanvasNameMutation.mutate({
                canvasId: params.id,
                name: newName
            });
        }
    };

    const addBox = (fromBox: CanvasDraft) => {
        newDraftMutation.mutate({
            name: fromBox.Draft.name,
            picks: fromBox.Draft.picks,
            public: false,
            canvas_id: params.id,
            positionX: fromBox.positionX + 100,
            positionY: fromBox.positionY + 100
        });
    };

    const deleteBox = (draftId: string) => {
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
        const champIndex = champions.findIndex((value) => value.name === championName);
        setCanvasDrafts(
            (cd) => cd.Draft.id === draftId,
            "Draft",
            (Draft) => {
                const holdPicks = [...Draft.picks];
                holdPicks[pickIndex] = champIndex !== -1 ? String(champIndex) : "";
                socketAccessor().emit("newDraft", {
                    picks: holdPicks,
                    id: draftId
                });
                return { ...Draft, picks: holdPicks };
            }
        );
    };

    const handleNameChange = (draftId: string, newName: string) => {
        editDraftMutation.mutate({
            id: draftId,
            name: newName,
            public: false
        });
    };

    const onAnchorClick = (draftId: string, anchorType: AnchorType) => {
        if (!isConnectionMode()) return;

        const selectedVertex = selectedVertexForConnection();
        const source = connectionSource();

        // If a vertex is selected, add this draft as target
        if (selectedVertex) {
            updateConnectionMutation.mutate({
                canvasId: params.id,
                connectionId: selectedVertex.connectionId,
                addTarget: { draftId, anchorType }
            });
            setSelectedVertexForConnection(null);
            return;
        }

        // If no anchor selected yet, select this anchor (for creating new connection OR adding as source)
        if (!source) {
            setConnectionSource(draftId);
            setSourceAnchor({ type: anchorType });
            setPreviewMousePos(null);
        } else if (source !== draftId) {
            // Different draft clicked - create new connection
            const srcAnchor = sourceAnchor();
            createConnectionMutation.mutate({
                canvasId: params.id,
                sourceDraftIds: [{ draftId: source, anchorType: srcAnchor?.type }],
                targetDraftIds: [{ draftId, anchorType }]
            });
            setConnectionSource(null);
            setSourceAnchor(null);
            setPreviewMousePos(null);
        } else if (source === draftId) {
            setConnectionSource(null);
            setSourceAnchor(null);
            setPreviewMousePos(null);
        }
    };

    const handleDeleteConnection = (connectionId: string) => {
        deleteConnectionMutation.mutate({
            canvasId: params.id,
            connectionId
        });
    };

    const toggleConnectionMode = () => {
        setIsConnectionMode(!isConnectionMode());
        setConnectionSource(null);
        setSourceAnchor(null);
        setPreviewMousePos(null);
        setSelectedVertexForConnection(null);
    };

    const handleConnectionClick = (connectionId: string) => {
        if (!isConnectionMode()) return;

        const source = connectionSource();
        const srcAnchor = sourceAnchor();

        // If an anchor is selected, add it as source to this connection
        if (source && srcAnchor) {
            updateConnectionMutation.mutate({
                canvasId: params.id,
                connectionId,
                addSource: { draftId: source, anchorType: srcAnchor.type }
            });
            setConnectionSource(null);
            setSourceAnchor(null);
            setPreviewMousePos(null);
        }
    };

    const handleVertexClick = (connectionId: string, vertexId: string) => {
        if (!isConnectionMode()) return;

        const source = connectionSource();
        const srcAnchor = sourceAnchor();

        // If an anchor is selected, add it as source to this connection
        if (source && srcAnchor) {
            updateConnectionMutation.mutate({
                canvasId: params.id,
                connectionId,
                addSource: { draftId: source, anchorType: srcAnchor.type }
            });
            setConnectionSource(null);
            setSourceAnchor(null);
            setPreviewMousePos(null);
            return;
        }

        // Otherwise, select the vertex (for adding targets)
        setSelectedVertexForConnection({ connectionId, vertexId });
    };

    const screenToWorld = (screenX: number, screenY: number) => {
        const vp = props.viewport();
        return {
            x: screenX / vp.zoom + vp.x,
            y: screenY / vp.zoom + vp.y
        };
    };

    const onBoxMouseDown = (draftId: string, e: MouseEvent) => {
        if (isConnectionMode()) return;
        if (!hasEditPermissions(props.canvasData?.userPermissions)) return;

        const target = e.target as HTMLElement;
        if (target.closest("select, button, input")) {
            return;
        }
        e.preventDefault();
        const cd = canvasDrafts.find((b) => b.Draft.id === draftId);
        if (cd) {
            const worldCoords = screenToWorld(e.clientX, e.clientY);
            setDragState({
                activeBoxId: draftId,
                offsetX: worldCoords.x - cd.positionX,
                offsetY: worldCoords.y - cd.positionY,
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
            setConnectionSource(null);
            setSourceAnchor(null);
            setPreviewMousePos(null);
        }

        const target = e.target as HTMLElement;
        if (target === canvasContainerRef || canvasContainerRef?.contains(target)) {
            const vp = props.viewport();
            setDragState({
                activeBoxId: null,
                offsetX: 0,
                offsetY: 0,
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
        if (!hasEditPermissions(props.canvasData?.userPermissions)) return;

        const target = e.target as HTMLElement;
        if (target === canvasContainerRef || canvasContainerRef?.contains(target)) {
            e.preventDefault();

            const canvasRect = target.getBoundingClientRect();
            const canvasRelativeX = e.clientX - canvasRect.left;
            const canvasRelativeY = e.clientY - canvasRect.top;
            const vp = props.viewport();
            const worldX = canvasRelativeX / vp.zoom + vp.x;
            const worldY = canvasRelativeY / vp.zoom + vp.y;

            newDraftMutation.mutate({
                name: "New Draft",
                picks: Array(20).fill(""),
                public: false,
                canvas_id: params.id,
                positionX: worldX,
                positionY: worldY
            });
        }
    };

    const debouncedSaveViewport = debounce((viewport: Viewport) => {
        updateViewportMutation.mutate({
            canvasId: params.id,
            viewport
        });
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
        createVertexMutation.mutate({
            canvasId: params.id,
            connectionId,
            x,
            y
        });
    };

    const handleDeleteVertex = (connectionId: string, vertexId: string) => {
        deleteVertexMutation.mutate({
            canvasId: params.id,
            connectionId,
            vertexId
        });
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
        if (!hasEditPermissions(props.canvasData?.userPermissions)) return;

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
        const group = canvasGroups.find((g) => g.id === groupId);
        if (group) {
            setGroupToDelete(group);
            setIsDeleteGroupDialogOpen(true);
        }
    };

    const onDeleteGroupConfirm = () => {
        const group = groupToDelete();
        if (group) {
            deleteGroupMutation.mutate({
                canvasId: params.id,
                groupId: group.id
            });
        }
    };

    const onDeleteGroupCancel = () => {
        setIsDeleteGroupDialogOpen(false);
        setGroupToDelete(null);
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
                if (connectionSource() || selectedVertexForConnection()) {
                    // First escape: clear any selections
                    setConnectionSource(null);
                    setSourceAnchor(null);
                    setPreviewMousePos(null);
                    setSelectedVertexForConnection(null);
                } else {
                    // Second escape: exit connection mode
                    setIsConnectionMode(false);
                }
            } else if (e.key === "Enter" && isConnectionMode()) {
                e.preventDefault();
                setIsConnectionMode(false);
                setConnectionSource(null);
                setSourceAnchor(null);
                setPreviewMousePos(null);
                setSelectedVertexForConnection(null);
            }
        };

        const onWindowMouseMove = (e: MouseEvent) => {
            if (isConnectionMode() && connectionSource() && canvasContainerRef) {
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
                const newX = worldCoords.x - state.offsetX;
                const newY = worldCoords.y - state.offsetY;
                setCanvasDrafts((cd) => cd.Draft.id === state.activeBoxId, {
                    positionX: newX,
                    positionY: newY
                });
                debouncedEmitMove(state.activeBoxId, newX, newY);
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
                    updateVertexMutation.mutate({
                        canvasId: params.id,
                        connectionId: vertexDrag.connectionId,
                        vertexId: vertexDrag.vertexId,
                        x: vertex.x,
                        y: vertex.y
                    });
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
                    updateGroupPositionMutation.mutate({
                        canvasId: params.id,
                        groupId: gState.activeGroupId,
                        positionX: group.positionX,
                        positionY: group.positionY
                    });
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
                    updatePositionMutation.mutate({
                        canvasId: params.id,
                        draftId: state.activeBoxId,
                        positionX: finalDraft.positionX,
                        positionY: finalDraft.positionY
                    });
                }
            }

            setDragState({
                activeBoxId: null,
                offsetX: 0,
                offsetY: 0,
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

        onCleanup(() => {
            window.removeEventListener("keydown", onKeyDown);
            window.removeEventListener("mousemove", onWindowMouseMove);
            window.removeEventListener("mouseup", onWindowMouseUp);
            window.removeEventListener("wheel", onWindowWheel);
        });
    });

    const resetViewport = () => {
        props.setViewport({ x: 0, y: 0, zoom: 1 });
    };

    const onDelete = () => {
        if (draftToDelete()) {
            deleteDraftMutation.mutate({
                canvas: params.id,
                draft: draftToDelete()!.Draft.id
            });
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
            <div class="relative h-full w-full overflow-hidden" ref={canvasContainerRef}>
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
                        class="rounded border border-slate-500 bg-slate-600 px-3 py-1.5 text-slate-50 shadow focus:border-teal-400 focus:outline-none"
                        placeholder="Canvas Name"
                        disabled={
                            isConnectionMode() ||
                            !hasEditPermissions(props.canvasData?.userPermissions)
                        }
                    />
                    <Show when={hasEditPermissions(props.canvasData?.userPermissions)}>
                        <button
                            onClick={toggleConnectionMode}
                            class="rounded px-4 py-2 font-semibold text-white shadow transition-colors"
                            classList={{
                                "bg-blue-600 hover:bg-blue-700": !isConnectionMode(),
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
                        class="rounded border border-slate-500 bg-teal-700 px-3 py-1.5 text-slate-50 shadow hover:bg-teal-400"
                    >
                        Reset View
                    </button>
                </div>
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
                                sourceAnchor={sourceAnchor()}
                                mousePos={previewMousePos()}
                                viewport={props.viewport}
                                layoutToggle={props.layoutToggle}
                            />
                        </Show>
                    </svg>
                </div>
                {/* Render Series Groups */}
                <For each={canvasGroups}>
                    {(group) => (
                        <SeriesGroupContainer
                            group={group}
                            drafts={getDraftsForGroup(group.id)}
                            viewport={props.viewport}
                            onGroupMouseDown={onGroupMouseDown}
                            onDeleteGroup={handleDeleteGroup}
                            canEdit={hasEditPermissions(
                                props.canvasData?.userPermissions
                            )}
                            isConnectionMode={isConnectionMode()}
                            renderDraftCard={(cd) => (
                                <CanvasCard
                                    canvasDraft={cd}
                                    addBox={addBox}
                                    deleteBox={deleteBox}
                                    handleNameChange={handleNameChange}
                                    handlePickChange={handlePickChange}
                                    viewport={props.viewport}
                                    onBoxMouseDown={onBoxMouseDown}
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
                                    canEdit={hasEditPermissions(
                                        props.canvasData?.userPermissions
                                    )}
                                    isGrouped={true}
                                    groupType={group.type}
                                />
                            )}
                        />
                    )}
                </For>

                {/* Render Ungrouped Drafts */}
                <For each={ungroupedDrafts()}>
                    {(cd) => (
                        <CanvasCard
                            canvasDraft={cd}
                            addBox={addBox}
                            deleteBox={deleteBox}
                            handleNameChange={handleNameChange}
                            handlePickChange={handlePickChange}
                            viewport={props.viewport}
                            onBoxMouseDown={onBoxMouseDown}
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
                            canEdit={hasEditPermissions(
                                props.canvasData?.userPermissions
                            )}
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
                                    class="rounded bg-teal-700 px-4 py-2 text-slate-50 hover:bg-teal-400"
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
                        <>
                            <h3 class="mb-4 text-lg font-bold text-slate-50">
                                Remove Series from Canvas?
                            </h3>
                            <p class="mb-4 text-slate-200">
                                This will remove "{groupToDelete()?.name}" and all its
                                games from this canvas.
                            </p>
                            <p class="mb-6 text-sm text-slate-400">
                                The original series data will not be deleted - you can
                                re-import it later.
                            </p>
                            <div class="flex justify-end gap-4">
                                <button
                                    onClick={onDeleteGroupCancel}
                                    class="rounded bg-teal-700 px-4 py-2 text-slate-50 hover:bg-teal-400"
                                >
                                    Cancel
                                </button>
                                <button
                                    onClick={onDeleteGroupConfirm}
                                    class="rounded bg-red-400 px-4 py-2 text-slate-50 hover:bg-red-600"
                                >
                                    Remove
                                </button>
                            </div>
                        </>
                    }
                />
            </div>
        </Show>
    );
};

export default CanvasComponent;
