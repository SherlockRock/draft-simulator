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
import { champions } from "./utils/constants";
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
import {
    CanvasDraft,
    Viewport,
    Connection,
    CanvasGroup,
    Vertex,
    AnchorType,
    CanvasObjectMovedSchema,
    VertexMovedSchema,
    GroupMovedSchema,
    GroupResizedSchema,
    CanvasDraftUpdateSchema
} from "./utils/schemas";
import { validateSocketEvent } from "./utils/socketValidation";
import { CanvasCard } from "./components/CanvasCard";
import { Dialog } from "./components/Dialog";
import { ImportToCanvasDialog } from "./components/ImportToCanvasDialog";
import {
    ConnectionComponent,
    ConnectionPreview,
    GroupConnectionPreview
} from "./components/Connections";
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
import { CustomGroupContainer } from "./components/CustomGroupContainer";
import { DeleteGroupDialog } from "./components/DeleteGroupDialog";
import { DraftContextMenu } from "./components/DraftContextMenu";
import { GroupContextMenu } from "./components/GroupContextMenu";
import { useCanvasContext } from "./contexts/CanvasContext";
import { useCanvasSocket } from "./providers/CanvasSocketProvider";
import CanvasSidebar from "./components/CanvasSidebar";

const debounce = <T extends unknown[]>(func: (...args: T) => void, limit: number) => {
    let inDebounce: boolean;
    return function (...args: T) {
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
    const [user] = accessor();
    const { socket: socketAccessor } = useCanvasSocket();
    const canvasContext = useCanvasContext();

    // Route parameter accessor with type narrowing
    // Returns empty string during route transitions/cleanup when params.id is undefined
    const canvasId = (): string => {
        return params.id ?? "";
    };

    // Reactive permission check - reads directly from context resource
    // This ensures permissions update when navigating between canvases
    const hasEditPermissions = () => {
        const perms = canvasContext.canvas()?.userPermissions;
        return perms === "edit" || perms === "admin";
    };

    const isLocalMode = () => canvasId() === "local";

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
    const [editingDraftId, setEditingDraftId] = createSignal<string | null>(null);

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
            queryClient.invalidateQueries({ queryKey: ["canvas", canvasId()] });
            toast.success("Canvas name updated");
            queryClient.setQueryData(
                ["canvas", canvasId()],
                (oldData: CanvasResposnse | undefined) => {
                    return oldData ? { ...oldData, name: data.name } : oldData;
                }
            );
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
            return editDraft(data.id, data, canvasId());
        },
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ["canvas", canvasId()] });
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
            queryClient.invalidateQueries({ queryKey: ["canvas", canvasId()] });
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
            queryClient.invalidateQueries({ queryKey: ["canvas", canvasId()] });
        },
        onError: (error: Error) => {
            toast.error(`Failed to create connection: ${error.message}`);
        }
    }));

    const updateConnectionMutation = useMutation(() => ({
        mutationFn: updateConnection,
        onSuccess: () => {
            toast.success("Connection updated!");
            queryClient.invalidateQueries({ queryKey: ["canvas", canvasId()] });
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
            queryClient.invalidateQueries({ queryKey: ["canvas", canvasId()] });
        },
        onError: (error: Error) => {
            toast.error(`Failed to delete connection: ${error.message}`);
        }
    }));

    const createVertexMutation = useMutation(() => ({
        mutationFn: createVertex,
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ["canvas", canvasId()] });
        },
        onError: (error: Error) => {
            toast.error(`Failed to create vertex: ${error.message}`);
        }
    }));

    const updateVertexMutation = useMutation(() => ({
        mutationFn: updateVertex,
        onError: (error: Error) => {
            toast.error(`Failed to update vertex: ${error.message}`);
            queryClient.invalidateQueries({ queryKey: ["canvas", canvasId()] });
        }
    }));

    const deleteVertexMutation = useMutation(() => ({
        mutationFn: deleteVertex,
        onSuccess: () => {
            toast.success("Vertex deleted!");
            queryClient.invalidateQueries({ queryKey: ["canvas", canvasId()] });
        },
        onError: (error: Error) => {
            toast.error(`Failed to delete vertex: ${error.message}`);
        }
    }));

    const updateGroupPositionMutation = useMutation(() => ({
        mutationFn: updateCanvasGroupPosition,
        onError: (error: Error) => {
            toast.error(`Failed to save group position: ${error.message}`);
            queryClient.invalidateQueries({ queryKey: ["canvas", canvasId()] });
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
            queryClient.invalidateQueries({ queryKey: ["canvas", canvasId()] });
            toast.success("Group created");
        },
        onError: (error: Error) => {
            toast.error(`Failed to create group: ${error.message}`);
        }
    }));

    const updateGroupMutation = useMutation(() => ({
        mutationFn: updateCanvasGroup,
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ["canvas", canvasId()] });
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
        const socket = socketAccessor();
        if (!socket) return;
        socket.emit("canvasObjectMove", {
            canvasId: canvasId(),
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
        const socket = socketAccessor();
        if (!socket) return;
        socket.emit("vertexMove", {
            canvasId: canvasId(),
            connectionId,
            vertexId,
            x,
            y
        });
    };

    const debouncedEmitVertexMove = debounce(emitVertexMove, 25);

    const emitGroupMove = (groupId: string, positionX: number, positionY: number) => {
        if (isLocalMode()) return;
        const socket = socketAccessor();
        if (!socket) return;
        socket.emit("groupMove", {
            canvasId: canvasId(),
            groupId,
            positionX,
            positionY
        });
    };

    const debouncedEmitGroupMove = debounce(emitGroupMove, 25);

    const emitGroupResize = (groupId: string, width: number, height: number) => {
        if (isLocalMode()) return;
        const socket = socketAccessor();
        if (!socket) return;
        socket.emit("groupResize", {
            canvasId: canvasId(),
            groupId,
            width,
            height
        });
    };

    const debouncedEmitGroupResize = debounce(emitGroupResize, 25);

    createEffect(() => {
        const currentId = canvasId();
        const data = props.canvasData;
        if (!data || props.isLoading || currentId === loadedCanvasId()) return;

        // Leave old canvas room if switching canvases
        const prevId = loadedCanvasId();
        const socket = socketAccessor();
        if (prevId && !isLocalMode() && socket) {
            socket.emit("leaveRoom", prevId);
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

        // Join new canvas room (draft updates broadcast to canvas room)
        if (!isLocalMode() && socket) {
            socket.emit("joinRoom", currentId);
        }

        setLoadedCanvasId(currentId);
    });

    // Leave canvas room on component unmount
    onCleanup(() => {
        const prevId = loadedCanvasId();
        const socket = socketAccessor();
        if (prevId && !isLocalMode() && socket) {
            socket.emit("leaveRoom", prevId);
        }
    });

    createEffect(() => {
        if (isLocalMode()) return;
        const socket = socketAccessor();
        if (!socket) return;
        socket.on(
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
        socket.on("draftUpdate", (rawData: unknown) => {
            const data = validateSocketEvent(
                "draftUpdate",
                rawData,
                CanvasDraftUpdateSchema
            );
            if (!data) return;
            setCanvasDrafts((cd) => cd.Draft.id === data.id, "Draft", "picks", [
                ...data.picks
            ]);
        });
        socket.on("canvasObjectMoved", (rawData: unknown) => {
            const data = validateSocketEvent(
                "canvasObjectMoved",
                rawData,
                CanvasObjectMovedSchema
            );
            if (!data) return;
            if (dragState().activeBoxId !== data.draftId) {
                setCanvasDrafts((cd) => cd.Draft.id === data.draftId, {
                    positionX: data.positionX,
                    positionY: data.positionY
                });
            }
        });
        socket.on(
            "connectionCreated",
            (data: { connection: Connection; allConnections: Connection[] }) => {
                setConnections(data.allConnections);
            }
        );
        socket.on(
            "connectionUpdated",
            (data: { connection: Connection; allConnections: Connection[] }) => {
                setConnections(data.allConnections);
            }
        );
        socket.on(
            "connectionDeleted",
            (data: { connectionId: string; allConnections: Connection[] }) => {
                setConnections(data.allConnections);
            }
        );
        socket.on(
            "vertexCreated",
            (data: {
                connectionId: string;
                vertex: Vertex;
                allConnections: Connection[];
            }) => {
                setConnections(data.allConnections);
            }
        );
        socket.on("vertexMoved", (rawData: unknown) => {
            const data = validateSocketEvent("vertexMoved", rawData, VertexMovedSchema);
            if (!data) return;
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
        });
        socket.on(
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
        socket.on(
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
        socket.on("groupMoved", (rawData: unknown) => {
            const data = validateSocketEvent("groupMoved", rawData, GroupMovedSchema);
            if (!data) return;
            const gState = groupDragState();
            if (gState.activeGroupId !== data.groupId) {
                setCanvasGroups((g) => g.id === data.groupId, {
                    positionX: data.positionX,
                    positionY: data.positionY
                });
            }
        });
        socket.on("groupResized", (rawData: unknown) => {
            const data = validateSocketEvent("groupResized", rawData, GroupResizedSchema);
            if (!data) return;
            setCanvasGroups((g) => g.id === data.groupId, {
                width: data.width,
                height: data.height
            });
        });
        onCleanup(() => {
            socket.off("canvasUpdate");
            socket.off("draftUpdate");
            socket.off("canvasObjectMoved");
            socket.off("connectionCreated");
            socket.off("connectionUpdated");
            socket.off("connectionDeleted");
            socket.off("vertexCreated");
            socket.off("vertexMoved");
            socket.off("vertexUpdated");
            socket.off("vertexDeleted");
            socket.off("groupMoved");
            socket.off("groupResized");
        });
    });

    const handleCanvasNameChange = (newName: string) => {
        if (newName.trim() && newName !== props.canvasData?.name) {
            if (isLocalMode()) {
                localUpdateCanvasName({ name: newName });
                toast.success("Canvas name updated");
            } else {
                updateCanvasNameMutation.mutate({
                    canvasId: canvasId(),
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
                canvas_id: canvasId(),
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
                    socketAccessor()?.emit("newDraft", {
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
                    canvasId: canvasId(),
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
                    canvasId: canvasId(),
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
                    canvasId: canvasId(),
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
                    canvasId: canvasId(),
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
                    canvasId: canvasId(),
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
                        canvasId: canvasId(),
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
                canvasId: canvasId(),
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
                    canvasId: canvasId(),
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
                    canvasId: canvasId(),
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
                    canvasId: canvasId(),
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
                    canvasId: canvasId(),
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
                    canvas_id: canvasId(),
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
                canvasId: canvasId(),
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
                canvasId: canvasId(),
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
                canvasId: canvasId(),
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
                    canvasId: canvasId(),
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
                canvasId: canvasId(),
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
                canvasId: canvasId(),
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
                canvasId: canvasId(),
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
                    canvasId: canvasId(),
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
        navigate(`/canvas/${canvasId()}/draft/${draft.Draft.id}`);
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
                canvasId: canvasId(),
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
        canvasContext.setSetEditingGroupIdCallback(() => setEditingGroupId);
        canvasContext.setDeleteGroupCallback(() => (id: string) => handleDeleteGroup(id));
        canvasContext.setSetEditingDraftIdCallback(() => setEditingDraftId);

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
                            canvasId: canvasId(),
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
                            canvasId: canvasId(),
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
                                canvasId: canvasId(),
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
                                    canvasId: canvasId(),
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
                                canvasId: canvasId(),
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

    const zoomIn = () => {
        const vp = props.viewport();
        const newZoom = Math.min(5, vp.zoom * 1.2);
        props.setViewport({ ...vp, zoom: newZoom });
    };

    const zoomOut = () => {
        const vp = props.viewport();
        const newZoom = Math.max(0.1, vp.zoom / 1.2);
        props.setViewport({ ...vp, zoom: newZoom });
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
                    canvas: canvasId(),
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
                <CanvasSidebar
                    onZoomIn={zoomIn}
                    onZoomOut={zoomOut}
                    onFitToScreen={resetViewport}
                    onSwapOrientation={() => props.setLayoutToggle(!props.layoutToggle())}
                    onImport={() => setIsImportDialogOpen(true)}
                    isConnectionMode={isConnectionMode()}
                    onToggleConnectionMode={toggleConnectionMode}
                    hasEditPermissions={hasEditPermissions()}
                />
                <div class="absolute left-4 top-4 z-40">
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
                    class="canvas-background absolute inset-0 cursor-move bg-slate-700 bg-[radial-gradient(circle,rgba(148,163,184,0.15)_1px,transparent_1px)] bg-[length:24px_24px]"
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
                                    onEditingComplete={() => setEditingGroupId(null)}
                                >
                                    <For each={getDraftsForGroup(group.id)}>
                                        {(cd) => (
                                            <CanvasCard
                                                canvasId={canvasId()}
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
                                                editingDraftId={editingDraftId}
                                                onEditingComplete={() =>
                                                    setEditingDraftId(null)
                                                }
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
                                renderDraftCard={(cd) => {
                                    // Compute team names based on blueSideTeam
                                    const bst = cd.Draft.blueSideTeam ?? 1;
                                    const blueTeamName =
                                        bst === 1
                                            ? group.metadata.blueTeamName
                                            : group.metadata.redTeamName;
                                    const redTeamName =
                                        bst === 1
                                            ? group.metadata.redTeamName
                                            : group.metadata.blueTeamName;

                                    return (
                                        <CanvasCard
                                            canvasId={canvasId()}
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
                                            editingDraftId={editingDraftId}
                                            onEditingComplete={() =>
                                                setEditingDraftId(null)
                                            }
                                            blueTeamName={blueTeamName}
                                            redTeamName={redTeamName}
                                        />
                                    );
                                }}
                            />
                        </Show>
                    )}
                </For>

                {/* Render Ungrouped Drafts */}
                <For each={ungroupedDrafts()}>
                    {(cd) => (
                        <CanvasCard
                            canvasId={canvasId()}
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
                            editingDraftId={editingDraftId}
                            onEditingComplete={() => setEditingDraftId(null)}
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
                            canvasId={canvasId()}
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
                                        canvas_id: canvasId(),
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
                            onRename={
                                menu().draft.is_locked
                                    ? undefined
                                    : () => {
                                          setEditingDraftId(menu().draft.Draft.id);
                                          closeDraftContextMenu();
                                      }
                            }
                            onView={() => handleDraftView(menu().draft)}
                            onGoTo={() => handleDraftGoTo(menu().draft)}
                            onCopy={() => handleDraftCopy(menu().draft)}
                            onDelete={
                                canvasGroups.find(
                                    (g) =>
                                        g.id === menu().draft.group_id &&
                                        g.type === "series"
                                )
                                    ? undefined
                                    : () => handleDraftDelete(menu().draft)
                            }
                            onClose={closeDraftContextMenu}
                        />
                    )}
                </Show>
                {/* Group Context Menu */}
                <Show when={groupContextMenu()}>
                    {(menu) => (
                        <GroupContextMenu
                            position={menu().position}
                            group={menu().group}
                            onRename={() => {
                                setEditingGroupId(menu().group.id);
                                closeGroupContextMenu();
                            }}
                            onViewSeries={() => {
                                const group = menu().group;
                                if (group.versus_draft_id) {
                                    navigate(`/versus/${group.versus_draft_id}`);
                                }
                                closeGroupContextMenu();
                            }}
                            onGoTo={() => {
                                const group = menu().group;
                                props.setViewport({
                                    x:
                                        group.positionX -
                                        window.innerWidth / 2 / props.viewport().zoom,
                                    y:
                                        group.positionY -
                                        window.innerHeight / 2 / props.viewport().zoom,
                                    zoom: props.viewport().zoom
                                });
                                closeGroupContextMenu();
                            }}
                            onDelete={() => {
                                handleDeleteGroup(menu().group.id);
                                closeGroupContextMenu();
                            }}
                            onClose={closeGroupContextMenu}
                        />
                    )}
                </Show>
            </div>
        </Show>
    );
};

export default CanvasComponent;
