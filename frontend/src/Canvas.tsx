import {
    For,
    batch,
    onMount,
    onCleanup,
    createSignal,
    createEffect,
    Show,
    createMemo,
    untrack,
    Setter,
    Accessor,
    JSX
} from "solid-js";
import { createStore, produce, reconcile } from "solid-js/store";
import { championById, resolveChampionId } from "./utils/constants";
import { AnnotationChampionPicker } from "./components/AnnotationChampionPicker";
import { useMutation, useQuery, useQueryClient } from "@tanstack/solid-query";
import {
    postNewDraft,
    updateCanvasDraftPosition,
    deleteDraftFromCanvas,
    copyDraftInCanvas,
    updateCanvasViewport,
    CanvasResposnse,
    createConnection,
    updateConnection,
    deleteConnection,
    createVertex,
    updateVertex,
    deleteVertex,
    editDraft,
    deleteCanvasGroup,
    createCanvasGroup,
    updateCanvasGroup,
    updateCanvasDraft,
    updateCanvasDraftPositions,
    convertGroupToSeries,
    fetchTeams,
    createAnnotation,
    updateAnnotation,
    deleteAnnotation,
    copyAnnotation,
    createCanvasPool,
    updateCanvasPool,
    deleteCanvasPool
} from "./utils/actions";
import { useNavigate, useParams } from "@solidjs/router";
import { toast } from "solid-toast";
import {
    CanvasDraft,
    Viewport,
    Connection,
    CanvasGroup,
    CanvasGroupMetadataUpdate,
    Vertex,
    AnchorType,
    CanvasObjectMovedSchema,
    VertexMovedSchema,
    GroupMovedSchema,
    GroupResizedSchema,
    CanvasDraftUpdateSchema,
    AnnotationMovedSchema,
    AnnotationResizedSchema,
    CanvasAnnotation,
    AnnotationFontSize,
    CanvasPoolPlacement,
    PoolUpdateSchema,
    PoolMovedSchema
} from "./utils/schemas";
import type { PoolChampionOp } from "@draft-sim/shared-types";
import { mergePoolBroadcast, mergePoolSnapshotRow } from "./utils/poolBroadcastMerge";
import { validateSocketEvent } from "./utils/socketValidation";
import { CanvasCard } from "./components/CanvasCard";
import { CanvasPoolCard } from "./components/CanvasPoolCard";
import { NewPoolFromSavedDialog } from "./components/NewPoolFromSavedDialog";
import { CanvasSearchPanel } from "./components/CanvasSearchPanel";
import {
    computeMatchupScopeHint,
    computeSearchResults,
    getOpponentNameOptions,
    getTeamNameOptions,
    sortDraftMatches,
    type DraftMatch,
    type ScopeHint,
    type SearchBucket,
    type SearchResults,
    type SlotPhase
} from "./utils/canvasSearch";
import { buildSearchRowModel, type SearchRowModel } from "./utils/searchRowModel";
import type { SearchScope } from "./utils/gameClassification";
import {
    CanvasChampionPicker,
    type PickerTarget
} from "./components/CanvasChampionPicker";
import { Dialog, EscapeKeyHint, ReturnKeyHint } from "./components/Dialog";
import { ImportToCanvasDialog } from "./components/ImportToCanvasDialog";
import {
    AnnotationConnectionPreview,
    ConnectionComponent,
    ConnectionPreview,
    GroupConnectionPreview
} from "./components/Connections";
import { cardHeight, cardWidth } from "./utils/helpers";
import { getDraftWorldPosition as draftWorldPosition } from "./utils/canvasWorldPosition";
import {
    childCardsOf,
    childAnnotationsOf,
    childGroupsOf,
    footprintOf,
    gridItemsOf,
    insetOf,
    maxChildSpanCols,
    nodeSize,
    renderOrder,
    spanFor,
    type CanvasTree,
    type TreeNode
} from "./utils/canvasTree";
import { findDropContainer } from "./utils/canvasHitTest";
import { groupDragResyncTargets, resizeChainOf } from "./utils/containerResizeChain";
import { splitGridPlacements, type GridWrites } from "./utils/gridPersistence";
import {
    subtreeMoveWrites,
    subtreeRows,
    type GroupPositionWrite
} from "./utils/groupSubtreeMove";
import { parentageRejection } from "./utils/groupParentage";
import { resolveGroupDrop, type GroupDropResolution } from "./utils/groupDropResolver";
import { freeGroupLeftRebaseWrites } from "./utils/freeGroupLeftRebase";
import {
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
    localUpdateGroup,
    localConvertGroupToSeries,
    localDeleteGroup,
    localUpdateDraftGroup,
    localUpdateDraftPositions,
    localUpdateDraftMetadata,
    localCreateAnnotation,
    localUpdateAnnotation,
    localDeleteAnnotation,
    localCopyAnnotation,
    localCreatePool,
    localRenamePool,
    localMovePool,
    localDeletePool
} from "./utils/useLocalCanvasMutations";
import { getLocalCanvas, saveLocalCanvas } from "./utils/localCanvasStore";
import { handleLogin } from "./utils/actions";
import { SeriesGroupContainer } from "./components/SeriesGroupContainer";
import { CustomGroupContainer } from "./components/CustomGroupContainer";
import { DeleteGroupDialog } from "./components/DeleteGroupDialog";
import { GroupSettingsDialog } from "./components/GroupDisabledChampionsDialog";
import { ContextMenu } from "./components/ContextMenu";
import { DraftContextMenu } from "./components/DraftContextMenu";
import { GroupContextMenu } from "./components/GroupContextMenu";
import { AnnotationContextMenu } from "./components/AnnotationContextMenu";
import CanvasAnnotationItem from "./components/CanvasAnnotation";
import { GridDropHighlight, type GridDropTarget } from "./components/GridDropHighlight";
import { useCanvasContext, type ShareAnchor } from "./contexts/CanvasContext";
import { useCanvasSocket } from "./providers/CanvasSocketProvider";
import { useUser } from "./userProvider";
import {
    createCursorThrottle,
    createTrailingThrottle,
    presenceSnapshotSchema
} from "./utils/presence";
import {
    clampZoom,
    nextLegibleState,
    nextLodState,
    worldTransform,
    zoomAt
} from "./utils/viewport";
import { ANNOTATION_FONT_PX } from "./utils/annotationStyle";
import { createRemoteCursorTracker } from "./utils/remoteCursors";
import { createLaserTrailTracker } from "./utils/laserTrails";
import { createLaserKeyTracker } from "./utils/laserKey";
import { resolveTeamNames } from "./utils/teamNames";
import {
    endpointInputFor,
    resolveAnchorClick,
    type ConnectionEndpointRef,
    type ConnectionSelection
} from "./utils/connectionSelection";
import { CursorOverlay } from "./components/CursorOverlay";
import { LaserOverlay } from "./components/LaserOverlay";
import CanvasSidebar from "./components/CanvasSidebar";
import { PresenceStack } from "./components/PresenceStack";
import { getRestrictedChampionsForGroup } from "./utils/draftRestrictions";
import {
    isGridGroup,
    gridColsOf,
    gridRowsOf,
    gridMetadataEquals,
    configuredColsAfterDrop,
    configuredRowsAfterDrop,
    resolveGridDrop,
    arrangeGrid,
    cellAt,
    materializeGrid,
    rowsOfItems,
    effectiveGridCols,
    resolveGridDims,
    resolveContainerDims,
    contentBoundsOf,
    annotationContentRectsOf,
    DEFAULT_GROUP_WIDTH,
    DEFAULT_GROUP_HEIGHT,
    GROUP_BORDER_WIDTH,
    resolveGridSave,
    resolveResizeGridSettings,
    gridDimensions,
    MIN_GROUP_WIDTH,
    MIN_GROUP_HEIGHT,
    arrangedRowCount,
    CARD_FOOTPRINT,
    cellToPosition,
    footprintPixelWidth,
    GRID_CELL_GAP,
    type GridFootprint,
    type GridItem,
    type GridSettingsInput,
    type GridAssignment,
    type GridCell,
    type GridMetadata
} from "./utils/gridLayout";
import {
    NEW_GROUP_DRAFT_MODE,
    newGroupDimensions,
    resolveNewGroupMetadata
} from "./utils/groupCreation";
import {
    gridContentHeightForRows,
    rowMetricsAt,
    snapHeightToRows,
    type RowMetrics
} from "./utils/gridRows";
import { seriesGrowthReflow } from "./utils/seriesGrowthReflow";
import { resolveCopyPlacement, type CopyPlacement } from "./utils/copyPlacement";
import { GroupTeamNamesDialog } from "./components/GroupTeamNamesDialog";
import {
    DraftPositionsUpdatedSchema,
    type DraftMode,
    type DraftPositionUpdate,
    type GameType,
    type GroupPositionUpdate
} from "@draft-sim/shared-types";
import { type CardLayout } from "./utils/canvasCardLayout";
import { isCanvasWorldElement } from "./utils/canvasWorldTarget";
import {
    annotationConnectionRect,
    annotationRenderSize,
    annotationFloor,
    autoFitHeight,
    defaultAnnotationSize,
    snapWidthToCells,
    type AnnotationRenderSize
} from "./utils/annotationSize";
import { annotationKeyboardShortcut } from "./utils/annotationKeyboardShortcut";
import {
    commitPoolDrag,
    commitPoolRename,
    poolDragPosition,
    poolGrabOffset
} from "./utils/poolCard";

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
    cardLayout: () => CardLayout;
    setCardLayout: (val: CardLayout) => void;
    viewport: Accessor<Viewport>;
    setViewport: Setter<Viewport>;
    // Settings (admin only) / unified Share popover controls. The popover
    // has two anchors — the sidebar Share button and the presence stack —
    // showing the same workflow-owned content.
    onSettings?: () => void;
    shareAnchor?: ShareAnchor | null;
    onOpenShare?: (anchor: ShareAnchor) => void;
    onCloseShare?: () => void;
    sharePopperContent?: JSX.Element;
};

type DraftNameUpdatedData = {
    draftId: string;
    name: string;
};

const CanvasComponent = (props: CanvasComponentProps) => {
    const params = useParams();
    const navigate = useNavigate();
    const queryClient = useQueryClient();
    const {
        socket: socketAccessor,
        connectionStatus,
        justReconnected,
        clearReconnected,
        presenceUsers,
        annotationLockOf
    } = useCanvasSocket();
    const canvasContext = useCanvasContext();

    // Route parameter accessor with type narrowing
    // Returns empty string during route transitions/cleanup when params.id is undefined
    const canvasId = (): string => {
        return params.id ?? "";
    };

    // Reactive permission checks - read directly from context resource
    // This ensures permissions update when navigating between canvases
    const hasEditPermissions = () => {
        const perms = canvasContext.canvas()?.userPermissions;
        return perms === "edit" || perms === "admin";
    };

    const hasAdminPermissions = () => {
        const perms = canvasContext.canvas()?.userPermissions;
        return perms === "admin";
    };

    const isLocalMode = () => canvasId() === "local";

    // Combined edit check: must have permissions AND be connected (except local mode)
    const canEdit = () => {
        if (isLocalMode()) return hasEditPermissions();
        return hasEditPermissions() && connectionStatus() === "connected";
    };

    // Helper to refresh canvas data from localStorage after a local mutation
    const refreshFromLocal = () => {
        const local = getLocalCanvas();
        if (local) {
            setCanvasDrafts(local.drafts);
            setConnections(local.connections);
            setCanvasGroups(local.groups);
            setAnnotations(local.annotations);
            setCanvasPools(local.pools);
        }
    };

    const [canvasDrafts, setCanvasDrafts] = createStore<CanvasDraft[]>([]);
    const [connections, setConnections] = createStore<Connection[]>([]);
    const [canvasGroups, setCanvasGroups] = createStore<CanvasGroup[]>([]);
    const [annotations, setAnnotations] = createStore<CanvasAnnotation[]>([]);
    const [canvasPools, setCanvasPools] = createStore<CanvasPoolPlacement[]>([]);
    // Read by CanvasPoolCard's isSelected prop below.
    const [selectedPoolId, setSelectedPoolId] = createSignal<string | null>(null);
    // Set by createPoolMutation.onSuccess so a freshly created pool opens
    // straight into its name field; read by CanvasPoolCard's isRenaming prop,
    // which mounts the rename input.
    const [renamingPoolId, setRenamingPoolId] = createSignal<string | null>(null);
    const [poolDragState, setPoolDragState] = createSignal<{
        activePoolId: string | null;
        offsetX: number;
        offsetY: number;
    }>({ activePoolId: null, offsetX: 0, offsetY: 0 });
    const draggedPoolId = () => poolDragState().activePoolId;
    // Plain, NON-reactive map: this client's emitted champion ops that the
    // server has not yet echoed back. The sender is excluded from its own op
    // broadcasts, so a foreign full payload arriving mid-flight would
    // otherwise silently drop them (design §4.3).
    const pendingPoolOps = new Map<string, PoolChampionOp[]>();
    // World position the "New Pool from Saved…" background-menu entry was
    // opened at; non-null drives NewPoolFromSavedDialog's isOpen.
    const [newPoolFromSavedAt, setNewPoolFromSavedAt] = createSignal<{
        x: number;
        y: number;
    } | null>(null);
    // Pending pool delete, mirroring draftToDelete below — the Dialog's
    // isOpen is derived from this being non-null rather than a second
    // boolean signal, since there is nothing else that can open this dialog.
    const [poolPendingDelete, setPoolPendingDelete] =
        createSignal<CanvasPoolPlacement | null>(null);
    const [isDeleteDialogOpen, setIsDeleteDialogOpen] = createSignal(false);
    const [draftToDelete, setDraftToDelete] = createSignal<CanvasDraft | null>(null);
    const [loadedCanvasId, setLoadedCanvasId] = createSignal<string | null>(null);
    const [isConnectionMode, setIsConnectionMode] = createSignal(false);
    const [connectionSource, setConnectionSource] =
        createSignal<ConnectionSelection | null>(null);
    const draftConnectionSource = createMemo(() => {
        const source = connectionSource();
        return source?.ref.kind === "draft" ? source.ref.id : null;
    });
    const groupConnectionSource = createMemo(() => {
        const source = connectionSource();
        return source?.ref.kind === "group" ? source.ref.id : null;
    });
    const annotationConnectionSource = createMemo(() => {
        const source = connectionSource();
        return source?.ref.kind === "annotation" ? source.ref.id : null;
    });
    const sourceAnchor = createMemo(() => {
        const source = connectionSource();
        return source ? { type: source.anchor } : null;
    });
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
        dragOriginX: number;
        dragOriginY: number;
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
        dragOriginX: 0,
        dragOriginY: 0,
        isPanning: false,
        panStartX: 0,
        panStartY: 0,
        viewportStartX: 0,
        viewportStartY: 0
    });
    const [annotationDragState, setAnnotationDragState] = createSignal<{
        activeAnnotationId: string | null;
        offsetX: number;
        offsetY: number;
        dragGroupId: string | null;
        originX: number;
        originY: number;
        frozenSize: AnnotationRenderSize | null;
    }>({
        activeAnnotationId: null,
        offsetX: 0,
        offsetY: 0,
        dragGroupId: null,
        originX: 0,
        originY: 0,
        frozenSize: null
    });
    const draggedAnnotationId = () => annotationDragState().activeAnnotationId;
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
    // `originX/originY` are the container's position at MOUSEDOWN, and they are
    // what makes rollback possible at all (plan A1). `onMutate` runs at
    // mouse-up, after the live drag has already written the final position to
    // the store on every mousemove — so a snapshot taken there restores the
    // failed drag to itself. It has been a no-op on `main` for flat canvases;
    // nesting only makes it visible, subtree-sized.
    const [groupDragState, setGroupDragState] = createSignal<{
        activeGroupId: string | null;
        offsetX: number;
        offsetY: number;
        originX: number;
        originY: number;
    }>({
        activeGroupId: null,
        offsetX: 0,
        offsetY: 0,
        originX: 0,
        originY: 0
    });
    const [pickerTarget, setPickerTarget] = createSignal<PickerTarget | null>(null);
    const [pickerAnchorSession, setPickerAnchorSession] = createSignal(0);
    const openPicker = (draftId: string, pickIndex: number) => {
        setPickerTarget({ draftId, pickIndex });
        setPickerAnchorSession((n) => n + 1);
    };
    const closePicker = () => setPickerTarget(null);
    const [insertPickerAnnotationId, setInsertPickerAnnotationId] = createSignal<
        string | null
    >(null);
    const [insertPickerAnchorSession, setInsertPickerAnchorSession] = createSignal(0);
    // The champion the picker handed back, for the note component to splice at
    // its captured caret. Session-keyed so the same champion twice still fires.
    const [insertedChampion, setInsertedChampion] = createSignal<{
        annotationId: string;
        championName: string;
        session: number;
    } | null>(null);
    const openInsertPicker = (annotationId: string) => {
        setInsertPickerAnnotationId(annotationId);
        setInsertPickerAnchorSession((n) => n + 1);
    };
    const closeInsertPicker = () => setInsertPickerAnnotationId(null);
    const [isImportDialogOpen, setIsImportDialogOpen] = createSignal(false);
    const [importPosition, setImportPosition] = createSignal({ x: 0, y: 0 });
    const [isDeleteGroupDialogOpen, setIsDeleteGroupDialogOpen] = createSignal(false);
    const [groupToDelete, setGroupToDelete] = createSignal<CanvasGroup | null>(null);
    const [disabledChampionsGroupId, setDisabledChampionsGroupId] = createSignal<
        string | null
    >(null);
    const settingsGroup = createMemo(() =>
        canvasGroups.find((g) => g.id === disabledChampionsGroupId())
    );
    const toDraftMode = (value: unknown): DraftMode => {
        return value === "fearless" || value === "ironman" || value === "standard"
            ? value
            : "standard";
    };
    const [createGroupPosition, setCreateGroupPosition] = createSignal({ x: 0, y: 0 });
    // Where a context-menu "Create Group" will place the new Group, and which
    // container it lands in — resolved at menu time by the same deepest-first
    // hit test the drop paths use (§9.1c).
    const [pendingGroupSettingsPosition, setPendingGroupSettingsPosition] = createSignal<{
        x: number;
        y: number;
        parentId: string | null;
    } | null>(null);
    const [dragOverGroupId, setDragOverGroupId] = createSignal<string | null>(null);
    const [exitingGroupId, setExitingGroupId] = createSignal<string | null>(null);
    // Where the dragged node would land, mirroring the drop math in
    // onWindowMouseUp. When the target is occupied the drop swaps, so the
    // displaced card's destination rides along for the swap preview.
    //
    // A RECTANGLE, not a bare cell: 5a-4 drops nodes with `2×4` footprints, and
    // building this overlay around 1×1 cells would only mean rebuilding it.
    const [gridDropCell, setGridDropCell] = createSignal<GridDropTarget | null>(null);
    // Resolved once, at the world level — the overlay cannot live inside the
    // target container any more (see GridDropHighlight).
    const gridDropHighlight = createMemo(() => {
        const target = gridDropCell();
        if (!target) return null;
        const group = canvasGroups.find((g) => g.id === target.groupId);
        return group ? { group, target } : null;
    });
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
    // Selection is annotation-local and deliberately NOT a general selection
    // model: D2 puts multi-select in Grid Layout slice 2, and building an
    // annotation-flavoured one here would guarantee two selection models meet
    // badly later. One id, cleared on background mousedown.
    const [selectedAnnotationId, setSelectedAnnotationId] = createSignal<string | null>(
        null
    );
    const [editingAnnotationId, setEditingAnnotationId] = createSignal<string | null>(
        null
    );

    /**
     * The advisory edit lock's client half (design D12): claim the note while
     * this client is editing it, refresh well inside the server's 60s
     * inactivity timeout, and release on the way out.
     *
     * `editingAnnotationId` is the right signal because the textarea only
     * mounts once it is set, and `commitText` clears it AFTER committing — so
     * the release below already lands after the write with no ordering to
     * arrange.
     *
     * ⚠️ `connectionStatus()` is read BEFORE the socket checks so it is always
     * a dependency. Written as `!sock || !sock.connected || status !== ...`,
     * the short-circuit skips the signal read whenever the socket is missing or
     * down, and the effect then never re-runs on reconnect — a note the user
     * started editing while briefly disconnected would go unclaimed for the
     * whole session. `sock.connected` is a plain property and tracks nothing.
     */
    createEffect(() => {
        const annotationId = editingAnnotationId();
        const status = connectionStatus();
        if (!annotationId || isLocalMode()) return;
        const sock = socketAccessor();
        if (!sock || !sock.connected || status !== "connected") return;

        const payload = { canvasId: canvasId(), annotationId };
        sock.emit("annotationEditStart", payload);
        const refresh = setInterval(() => {
            if (sock.connected) sock.emit("annotationEditStart", payload);
        }, 20_000);

        onCleanup(() => {
            clearInterval(refresh);
            if (sock.connected) sock.emit("annotationEditEnd", payload);
        });
    });

    // Why a toast and not silence: a note held by someone else declines to open
    // its editor, and without this that is indistinguishable from a
    // double-click that missed. The `annotationLockDenied` toast cannot cover
    // it — the component returns before we emit the `annotationEditStart` the
    // server would have refused.
    const toastAnnotationLocked = (holderName: string) => {
        toast.error(`${holderName} is editing this note`);
    };

    const annotationLockedByName = (annotationId: string): string | null => {
        const holderId = annotationLockOf(annotationId);
        if (!holderId) return null;
        return (
            presenceUsers().find((presenceUser) => presenceUser.userId === holderId)
                ?.displayName ?? "Someone else"
        );
    };
    const [annotationContextMenu, setAnnotationContextMenu] = createSignal<{
        annotation: CanvasAnnotation;
        position: { x: number; y: number };
    } | null>(null);

    const [poolContextMenu, setPoolContextMenu] = createSignal<{
        placement: CanvasPoolPlacement;
        position: { x: number; y: number };
    } | null>(null);

    const [groupContextMenu, setGroupContextMenu] = createSignal<{
        group: CanvasGroup;
        position: { x: number; y: number };
    } | null>(null);

    // Connection/vertex menu state lives here (not in ConnectionComponent) so
    // the canvas-level mouse-up dispatcher can open it from the mousedown
    // target's data-connection-id / data-vertex-id tags.
    const [connectionContextMenu, setConnectionContextMenu] = createSignal<{
        connectionId: string;
        type: "connection" | "vertex";
        vertexId?: string;
        position: { x: number; y: number };
    } | null>(null);

    const [editingGroupId, setEditingGroupId] = createSignal<string | null>(null);
    const [teamNamesGroup, setTeamNamesGroup] = createSignal<CanvasGroup | null>(null);
    const [editingDraftId, setEditingDraftId] = createSignal<string | null>(null);

    // Layout switches resize every card and re-map slot geometry, so the
    // picker closes (design D3).
    let previousCardLayout: CardLayout | undefined;
    createEffect(() => {
        const currentCardLayout = props.cardLayout();
        if (
            previousCardLayout !== undefined &&
            currentCardLayout !== previousCardLayout
        ) {
            closePicker();
        }
        previousCardLayout = currentCardLayout;
    });

    // Close when the target draft disappears, locks, loses editability, or
    // connection mode starts.
    createEffect(() => {
        const target = pickerTarget();
        if (!target) return;
        const canvasDraft = canvasDrafts.find((cd) => cd.Draft.id === target.draftId);
        if (!canvasDraft || canvasDraft.is_locked || !canEdit() || isConnectionMode()) {
            closePicker();
        }
    });

    // Closes the picker whenever its session stops being legitimate. Note the
    // deletion case is handled HERE, not by the popover: CanvasPickerPopover
    // only fires onClose when anchor RESOLUTION fails — a null annotation
    // accessor merely unmounts it visually and would leave this signal stale.
    // The lock case matters doubly: the component defers its blur-commit while
    // an insert session is open, so a picker left open under a lock would
    // strand typed text uncommitted (the no-silent-loss discipline, D12).
    createEffect(() => {
        const annotationId = insertPickerAnnotationId();
        if (!annotationId) return;
        if (
            !canEdit() ||
            isConnectionMode() ||
            annotationLockedByName(annotationId) ||
            !annotations.some((a) => a.id === annotationId)
        ) {
            closeInsertPicker();
        }
    });

    const ungroupedDrafts = createMemo(() => canvasDrafts.filter((cd) => !cd.group_id));

    // ONE zoom accessor for every inverse-scale decoration on the canvas.
    // Reading props.viewport().zoom inside a card subscribes that card to the
    // whole viewport object, so a pan invalidates all ~50 of them. This memo
    // recomputes once per pan frame, returns an unchanged number, and
    // createMemo's default === equality stops the propagation there.
    // Deliberately NOT one memo per card — that keeps the O(cards) recompute.
    const viewportZoom = createMemo(() => props.viewport().zoom);

    // Low-zoom level of detail, shared by every card and the dot grid. A memo rather
    // than a signal+effect because the hysteresis needs the PREVIOUS state, which
    // createMemo hands back as the first argument — so this stays pure, needs no
    // untrack, and cannot re-enter itself. Like viewportZoom above, a pan recomputes
    // it to an unchanged boolean and `===` equality stops the propagation there.
    const lodActive = createMemo(
        (previous: boolean) => nextLodState(previous, viewportZoom()),
        false
    );

    /**
     * Note-text legibility collapse — ONE state machine per FONT PRESET, not one
     * per note (design §4).
     *
     * §4 flagged the per-annotation memo as "acceptable in principle, measure
     * before shipping", because it reintroduces the O(annotations) reactive
     * recompute per zoom step that `lodActive` above exists to avoid. The
     * measurement is unnecessary here BY CONSTRUCTION: `nextLegibleState` reads
     * only `(previous, fontSizePx, zoom)`, and `fontSizePx` has exactly FOUR
     * values, so every note sharing a preset has an identical trajectory and
     * they can share one machine. This is the plan's own named alternative (a).
     * Sixty notes cost four memos, and six hundred still cost four.
     *
     * Four separate boolean memos rather than one memo over a record, so each
     * preset gets `createMemo`'s `===` equality independently: a zoom step that
     * flips `sm` must not invalidate the notes reading `xl`. A record would
     * allocate a fresh object per zoom step and propagate to every note.
     *
     * Each is bound to its own const before going into the record because
     * `solid/reactivity` cannot analyse a `createMemo` written inline in an
     * object literal, and warns on all four.
     */
    const collapsedTextSm = createMemo(
        (p: boolean) => nextLegibleState(p, ANNOTATION_FONT_PX.sm, viewportZoom()),
        false
    );
    const collapsedTextMd = createMemo(
        (p: boolean) => nextLegibleState(p, ANNOTATION_FONT_PX.md, viewportZoom()),
        false
    );
    const collapsedTextLg = createMemo(
        (p: boolean) => nextLegibleState(p, ANNOTATION_FONT_PX.lg, viewportZoom()),
        false
    );
    const collapsedTextXl = createMemo(
        (p: boolean) => nextLegibleState(p, ANNOTATION_FONT_PX.xl, viewportZoom()),
        false
    );
    const collapsedTextByFontSize: Record<AnnotationFontSize, () => boolean> = {
        sm: collapsedTextSm,
        md: collapsedTextMd,
        lg: collapsedTextLg,
        xl: collapsedTextXl
    };

    // Screen-space pitch of the dot grid. Zoom-only: during a pan this recomputes to
    // the same number, so Solid's `===` equality suppresses the style write. That
    // matters because `background-size` is the expensive half — changing it
    // re-rasterizes the gradient tile.
    const gridPitch = createMemo(() => 32 * props.viewport().zoom);

    const gridSizeStyle = createMemo(() => {
        const size = gridPitch();
        return `${size}px ${size}px`;
    });

    // The grid plane is oversized on every side so a translation of up to one pitch can
    // never expose an edge. The extra 1px absorbs device-pixel snapping below, which can
    // round the offset up by half a device pixel and would otherwise leave a hairline
    // sliver of undotted background at the top/left edge.
    const gridInsetStyle = createMemo(() => `${-(gridPitch() + 1)}px`);

    // A repeating pattern is translation-invariant modulo its period, and here the
    // period IS `background-size` — so translating by `offset mod pitch` is visually
    // identical to translating by `offset`. Exact, not an approximation.
    //
    // This replaces a per-frame `background-position` write on a viewport-sized
    // element, which invalidated and re-rastered the whole pane every pan frame. A
    // transform on a composited layer does not invalidate.
    const gridTransformStyle = createMemo(() => {
        const vp = props.viewport();
        const pitch = gridPitch();
        const dpr = window.devicePixelRatio || 1;
        // Recomputed from the viewport each frame rather than accumulated, so there
        // is no float drift however long the pan runs.
        const wrap = (value: number) => ((value % pitch) + pitch) % pitch;
        // Snap to device pixels. A fractional translate makes the compositor resample
        // the layer bilinearly, and that softness persists after the pan stops. The
        // resulting sub-pixel offset against world coordinates is invisible, and
        // nothing in the canvas snaps to the dot grid.
        const snap = (value: number) => Math.round(value * dpr) / dpr;
        const x = snap(wrap(-vp.x * vp.zoom));
        const y = snap(wrap(-vp.y * vp.zoom));
        return `translate3d(${x}px, ${y}px, 0)`;
    });

    // The two stores as one tree. Read inside the tracking scope of whoever
    // calls it, so the child queries below stay reactive.
    const canvasTree = (): CanvasTree => ({
        groups: canvasGroups,
        drafts: canvasDrafts,
        annotations
    });

    const getDraftsForGroup = (groupId: string) => childCardsOf(canvasTree(), groupId);

    const draftConnectionPreview = createMemo(() => {
        const source = connectionSource();
        if (source?.ref.kind !== "draft") return null;
        const draft = canvasDrafts.find((item) => item.Draft.id === source.ref.id);
        if (!draft) return null;
        const group = draft.group_id
            ? (canvasGroups.find((item) => item.id === draft.group_id) ?? null)
            : null;
        const seriesDraftIndex =
            group?.type === "series"
                ? getDraftsForGroup(group.id).findIndex(
                      (item) => item.Draft.id === draft.Draft.id
                  )
                : undefined;
        return { draft, group, seriesDraftIndex };
    });

    const groupConnectionPreview = createMemo(() => {
        const source = connectionSource();
        if (source?.ref.kind !== "group") return null;
        const group = canvasGroups.find((item) => item.id === source.ref.id);
        if (!group) return null;
        const seriesDraftCount =
            group.type === "series" ? getDraftsForGroup(group.id).length : undefined;
        return { group, seriesDraftCount };
    });

    // Columns a grid Group actually offers as drop targets. Everything that
    // paints or resolves a grid cell must come through here, or the hint
    // overlay ends up offering columns the resolver won't use.
    const gridColsFor = (group: CanvasGroup): number => {
        const layout = props.cardLayout();
        return effectiveGridCols(
            group,
            layout,
            maxChildSpanCols(canvasTree(), group.id, layout)
        );
    };

    // Children of a grid Group as footprint stamps. The order matters and is
    // not negotiable: footprints -> maxChildSpanCols -> effective cols -> cells
    // (canvasTree.ts, step-2 amendment 3). Deriving the span from the items
    // would be circular, since an item's cell is clamped by the column count.
    /**
     * Containers whose membership the CURRENT gesture already resolved, and
     * which must therefore not be rematerialized behind it.
     *
     * `resyncGroupSize(dropGroup.id)` runs immediately after `commitGridDrop`,
     * which already wrote a coherent layout through the EXACT path. Re-deriving
     * it a tick later runs the INFERENTIAL path (`rowsOf` over stored pixels)
     * over the exact path's own output; if they ever disagreed the just-dropped
     * card would visibly snap.
     */
    const settledByGesture = new Set<string>();

    /**
     * The §6.1 growth path's entry point: `assignments` name DISPLACED siblings
     * only, and an empty list means nothing was displaced, which is a genuine
     * no-op rather than a request to rematerialize the container.
     */
    const commitReflowPlacements = (parentId: string, assignments: GridAssignment[]) => {
        if (assignments.length === 0) return;
        commitGridMaterialization(parentId, assignments);
    };

    /**
     * Nodes whose stored position is being rewritten every mousemove, keyed by
     * placement id, valued with the timestamp of the last relayed frame.
     *
     * §6.0a made this necessary and nothing before it did. A row INDEX is now a
     * collective property (`gridItemsOf`), so a node sitting at an arbitrary
     * mid-gesture y forms a row bucket of its own; if it hovers above the first
     * real row, every OTHER member's `cell.row` shifts by one while the
     * targeting rows still index from 0. The two memberships then disagree,
     * `resolveGridDrop` finds no collision where there is one, and no swap or
     * relocation happens.
     *
     * The LOCAL drag is covered by `dragState().activeBoxId` and
     * `gState.activeGroupId`. A REMOTE drag was not covered by anything: an
     * observer learns about it only through `canvasObjectMoved`/`groupMoved`,
     * which write straight into the stores with no in-flight marker and no
     * drag-end event. Worse, if that observer's `resyncGroupSize` fires for an
     * unrelated reason, it would persist the mid-gesture layout.
     *
     * Entries are cleared by the commit broadcast that ends the drag
     * (`draftPositionsUpdated` / `canvasGroupUpdated`) and expire on a timer, so
     * a dropped connection cannot pin a node in-flight forever.
     */
    const [relayedDrags, setRelayedDrags] = createStore<Record<string, number>>({});
    const RELAYED_DRAG_TTL_MS = 2000;
    const markRelayedDrag = (id: string) => setRelayedDrags(id, Date.now());
    const clearRelayedDrag = (id: string) =>
        setRelayedDrags(
            produce((drags) => {
                delete drags[id];
            })
        );

    const inFlightIds = createMemo<ReadonlySet<string>>(() => {
        const ids = new Set<string>();
        const localCard = dragState().activeBoxId;
        if (localCard !== null) ids.add(localCard);
        const localGroup = groupDragState().activeGroupId;
        if (localGroup !== null) ids.add(localGroup);
        const localAnnotation = draggedAnnotationId();
        if (localAnnotation !== null) ids.add(localAnnotation);
        const now = Date.now();
        for (const [id, at] of Object.entries(relayedDrags)) {
            if (at !== undefined && now - at < RELAYED_DRAG_TTL_MS) ids.add(id);
        }
        return ids;
    });

    /**
     * The geometry `commitGridDrop` needs for a dragged node: its column span
     * plus the two §6.0a terms. Extracted so no call site hand-rolls the
     * chrome — a Card that reported a container's inset would be aligned on the
     * wrong baseline, and one that reported a Card's height would size its row
     * too short.
     */
    const draggedCardGeometry = (draftId: string, layout: CardLayout) => ({
        id: draftId,
        kind: "card" as const,
        footprint: CARD_FOOTPRINT,
        inset: GROUP_BORDER_WIDTH,
        height: cardHeight(layout)
    });

    /**
     * The geometry `commitGridDrop` needs for a dragged annotation.
     *
     * Extracted for the same reason as `draggedCardGeometry`: a node that
     * reported a Card's height would size its row wrong, and one that reported
     * a container's inset would be aligned on the wrong baseline. `nodeSize`
     * reads the STORED size (D5) — never the snapped render size, which is an
     * output of the row this call is helping to compute.
     */
    const draggedAnnotationGeometry = (
        annotation: CanvasAnnotation,
        layout: CardLayout
    ): {
        id: string;
        kind: "annotation";
        footprint: GridFootprint;
        inset: number;
        height: number;
    } => {
        const node: TreeNode = {
            kind: "annotation",
            id: annotation.id,
            annotation
        };
        return {
            id: annotation.id,
            kind: "annotation",
            footprint: footprintOf(canvasTree(), node, layout),
            inset: insetOf(canvasTree(), node, layout),
            height: nodeSize(canvasTree(), node, layout).height
        };
    };

    /**
     * The settled row model of every grid Group, built ONCE per change.
     *
     * ⚠️ This memo is a MEASURED fix, not a defensive one. `snappedAnnotationSizeFor`
     * used to call `rowsOfItems(gridItemsFor(group))` — a full row-model rebuild —
     * once per annotation, inside the `<For>` that renders them, so a drag frame
     * cost O(notes x items) and every note in the container paid for the same
     * rebuild.
     *
     * Measured in Chrome, one note dragged 60 steps, gesture and machine held
     * fixed, median of 3 reps:
     *
     *   notes in the grid    10      30      60     100
     *   drag wall time     1143ms  2175ms  5247ms  14331ms
     *   frame mean         16.7ms  17.1ms  39.0ms  106.6ms
     *
     * and the control that attributes it — the SAME 100 notes, same DOM, but
     * UNGROUPED, where this path never runs — came in at 1012ms / 16.7ms. So the
     * cost was the rebuild, not the note count on screen.
     *
     * Keyed by group id rather than memoised per note: the rows depend on the
     * container's items, not on which note is asking, so N notes need one
     * rebuild rather than N identical ones.
     */
    const settledRowsByGroup = createMemo(() => {
        const layout = props.cardLayout();
        const inFlight = inFlightIds();
        const rows = new Map<string, ReturnType<typeof rowsOfItems>>();
        for (const group of canvasGroups) {
            if (!isGridGroup(group)) continue;
            rows.set(
                group.id,
                rowsOfItems(
                    gridItemsFor(group).filter((item) => !inFlight.has(item.id)),
                    layout
                )
            );
        }
        return rows;
    });

    /**
     * The render size for a grouped annotation inside a grid (D5a).
     *
     * Returns null outside a grid — the note then paints at its stored size,
     * which is the whole point of snapping at render rather than at commit.
     */
    const snappedAnnotationSizeFor = (
        group: CanvasGroup,
        annotation: CanvasAnnotation
    ): { width: number; height: number } | null => {
        const layout = props.cardLayout();
        const drag = annotationDragState();
        if (drag.activeAnnotationId === annotation.id && drag.frozenSize !== null) {
            return annotationRenderSize({
                annotation,
                activeAnnotationId: drag.activeAnnotationId,
                frozenSize: drag.frozenSize,
                settledRows: [],
                layout
            });
        }
        // `?? []` matches what the old per-note rebuild produced for a group
        // with no grid rows, so a miss degrades to the stored size rather than
        // to a crash.
        const rows = settledRowsByGroup().get(group.id) ?? [];
        return annotationRenderSize({
            annotation,
            activeAnnotationId: drag.activeAnnotationId,
            frozenSize: drag.frozenSize,
            settledRows: rows,
            layout
        });
    };

    const annotationRenderRect = (
        annotation: CanvasAnnotation
    ): { width: number; height: number } => {
        const group = annotation.group_id
            ? (canvasGroups.find((entry) => entry.id === annotation.group_id) ?? null)
            : null;
        const snapped =
            group && isGridGroup(group)
                ? snappedAnnotationSizeFor(group, annotation)
                : null;
        return annotationConnectionRect(annotation, snapped);
    };

    const annotationConnectionPreview = createMemo(() => {
        const source = connectionSource();
        if (source?.ref.kind !== "annotation") return null;
        const annotation = annotations.find((entry) => entry.id === source.ref.id);
        if (!annotation) return null;
        const group = annotation.group_id
            ? (canvasGroups.find((entry) => entry.id === annotation.group_id) ?? null)
            : null;
        return {
            annotation,
            group,
            renderSize: annotationRenderRect(annotation),
            anchor: source.anchor
        };
    });

    /**
     * The item set a materialization must see: the container's current members,
     * plus the dragged node when it is joining from OUTSIDE, carrying its real
     * inset and height.
     *
     * `materializeGrid` throws on an assignment with no item rather than
     * guessing an entering node's chrome, so every one of the three call sites
     * — the commit and both drop previews — owes it this. Extracted once
     * because writing it three times is how one of them ends up defaulting an
     * incoming nested container to a Card's geometry.
     */
    const projectIntoGrid = (
        items: GridItem[],
        dragged: {
            id: string;
            kind: GridItem["kind"];
            footprint: GridFootprint;
            inset: number;
            height: number;
        },
        cell: GridCell,
        position: { x: number; y: number }
    ): GridItem[] =>
        items.some((i) => i.id === dragged.id)
            ? items
            : [...items, { ...dragged, position, cell }];

    /**
     * The row band a node will occupy once the drop completes — the LANDING
     * metrics the highlight is drawn from, never the targeting ones.
     *
     * Falls back to `rowMetricsAt` for a node the materializer did not place,
     * which is the growth-row case: total by construction, so the highlight
     * always has a rectangle to draw.
     */
    const landingBandOf = (
        rows: RowMetrics[],
        id: string,
        cell: GridCell,
        layout: CardLayout
    ): RowMetrics =>
        rows.find((row) => row.ids.includes(id)) ?? rowMetricsAt(rows, cell.row, layout);

    const draggedGroupGeometry = (
        groupId: string,
        group: CanvasGroup,
        layout: CardLayout
    ) => {
        const node: TreeNode = { kind: "group", id: groupId, group };
        return {
            id: groupId,
            kind: "group" as const,
            footprint: footprintOf(canvasTree(), node, layout),
            inset: insetOf(canvasTree(), node, layout),
            height: nodeSize(canvasTree(), node, layout).height
        };
    };

    const gridItemsFor = (group: CanvasGroup): GridItem[] =>
        gridItemsOf(
            canvasTree(),
            group.id,
            props.cardLayout(),
            gridColsFor(group),
            inFlightIds()
        );

    const groupForCard = (cd: CanvasDraft): CanvasGroup | undefined =>
        cd.group_id ? canvasGroups.find((g) => g.id === cd.group_id) : undefined;

    const upsertCanvasGroup = (group: CanvasGroup) => {
        setCanvasGroups((groups) => {
            const exists = groups.some((g) => g.id === group.id);
            return exists
                ? groups.map((g) => (g.id === group.id ? group : g))
                : [...groups, group];
        });
        canvasContext.mutateCanvas((prev: CanvasResposnse | undefined) => {
            if (!prev) return prev;
            const exists = prev.groups.some((g) => g.id === group.id);
            return {
                ...prev,
                groups: exists
                    ? prev.groups.map((g) => (g.id === group.id ? group : g))
                    : [...prev.groups, group]
            };
        });
    };

    const upsertCanvasDrafts = (drafts: CanvasDraft[]) => {
        if (drafts.length === 0) return;
        const returnedIds = new Set(drafts.map((d) => d.Draft.id));
        setCanvasDrafts([
            ...canvasDrafts.filter((d) => !returnedIds.has(d.Draft.id)),
            ...drafts
        ]);
        canvasContext.mutateCanvas((prev: CanvasResposnse | undefined) => {
            if (!prev) return prev;
            return {
                ...prev,
                drafts: [
                    ...prev.drafts.filter((d) => !returnedIds.has(d.Draft.id)),
                    ...drafts
                ]
            };
        });
    };

    let canvasContainerRef: HTMLDivElement | undefined;

    // Function to navigate viewport to a draft's position
    const navigateToDraft = (positionX: number, positionY: number) => {
        if (canvasContainerRef) {
            const container = canvasContainerRef.getBoundingClientRect();
            const currentWidth = cardWidth(props.cardLayout());
            const currentHeight = cardHeight(props.cardLayout());
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

    const getDraftWorldPosition = (draft: CanvasDraft): { x: number; y: number } => {
        const group = draft.group_id
            ? canvasGroups.find((g) => g.id === draft.group_id)
            : null;
        return draftWorldPosition(
            draft,
            group,
            group ? canvasDrafts.filter((cd) => cd.group_id === group.id) : [],
            props.cardLayout()
        );
    };

    const [searchOpen, setSearchOpen] = createSignal(false);
    const [searchChampionId, setSearchChampionId] = createSignal<string | null>(null);
    const [searchTeamName, setSearchTeamName] = createSignal<string | null>(null);
    const [searchBucket, setSearchBucket] = createSignal<SearchBucket | null>(null);
    const [searchScope, setSearchScope] = createSignal<SearchScope>("all");
    const [searchFocusNonce, setSearchFocusNonce] = createSignal(0);
    const [searchOpponentName, setSearchOpponentName] = createSignal<string | null>(null);
    const [searchPinnedIds, setSearchPinnedIds] = createSignal<ReadonlySet<string>>(
        new Set<string>()
    );
    const [searchSelectedDraftId, setSearchSelectedDraftId] = createSignal<string | null>(
        null
    );
    const [searchReturnViewport, setSearchReturnViewport] = createSignal<Viewport | null>(
        null
    );

    const searchResults = createMemo<SearchResults | null>(() => {
        if (!searchOpen()) return null;
        const championId = searchChampionId();
        const teamName = searchTeamName();
        if (championId === null && teamName === null) return null;
        return computeSearchResults(
            canvasDrafts,
            canvasGroups,
            {
                championId,
                teamName,
                opponentTeamName: searchOpponentName(),
                bucket: searchBucket(),
                scope: searchScope()
            },
            resolveChampionId
        );
    });
    // Scope-aware: only offer teams the current scope would actually search,
    // so picking one can never hand back an empty record with no explanation.
    const searchTeamOptions = createMemo(() =>
        getTeamNameOptions(canvasGroups, searchScope())
    );
    const searchMatchByDraftId = createMemo(() => {
        const map = new Map<string, DraftMatch>();
        for (const match of searchResults()?.matches ?? []) map.set(match.draftId, match);
        return map;
    });
    const searchSlotPhasesByDraft = createMemo(() => {
        const map = new Map<string, Map<number, SlotPhase>>();
        for (const match of searchResults()?.matches ?? []) {
            map.set(
                match.draftId,
                new Map(match.slots.map((slot) => [slot.index, slot.phase]))
            );
        }
        return map;
    });
    const searchActive = createMemo(() => searchResults() !== null);
    const searchSlotPhaseFor = (draftId: string, pickIndex: number): SlotPhase | null =>
        searchSlotPhasesByDraft().get(draftId)?.get(pickIndex) ?? null;

    const searchDraftById = createMemo(
        () => new Map(canvasDrafts.map((cd) => [cd.Draft.id, cd]))
    );
    // Map, not per-row .find(): the row-model memos below recompute on every
    // live store change — O(matches × groups) scans there are exactly the cost
    // class the R10 perf gate exists to catch.
    const searchGroupById = createMemo(
        () => new Map(canvasGroups.map((group) => [group.id, group]))
    );
    const searchGroupFor = (cd: CanvasDraft): CanvasGroup | undefined =>
        cd.group_id ? searchGroupById().get(cd.group_id) : undefined;

    const sortedSearchMatches = createMemo(() =>
        sortDraftMatches(searchResults()?.matches ?? [], canvasDrafts, canvasGroups)
    );

    const searchOpponentOptions = createMemo(() => {
        const teamName = searchTeamName();
        if (teamName === null) return [];
        return getOpponentNameOptions(canvasGroups, searchScope(), teamName);
    });

    // Pinned rows read the live store: an edited pin updates in place, a deleted
    // pin drops out (R6). Rings only when the CURRENT query matches the pin.
    const searchPinnedRowModels = createMemo<SearchRowModel[]>(() => {
        if (!searchOpen()) return [];
        const byId = searchDraftById();
        const matchById = searchMatchByDraftId();
        const rows: SearchRowModel[] = [];
        for (const draftId of searchPinnedIds()) {
            const cd = byId.get(draftId);
            if (!cd) continue;
            rows.push(
                buildSearchRowModel(
                    cd,
                    searchGroupFor(cd),
                    matchById.get(draftId) ?? null
                )
            );
        }
        return rows;
    });

    // A pinned row renders only in the pinned section — excluded here (Plan Decision 3).
    const searchResultRowModels = createMemo<SearchRowModel[]>(() => {
        const byId = searchDraftById();
        const pinned = searchPinnedIds();
        const rows: SearchRowModel[] = [];
        for (const match of sortedSearchMatches()) {
            if (pinned.has(match.draftId)) continue;
            const cd = byId.get(match.draftId);
            if (!cd) continue;
            rows.push(buildSearchRowModel(cd, searchGroupFor(cd), match));
        }
        return rows;
    });

    const searchRowOrder = createMemo(() => [
        ...searchPinnedRowModels().map((row) => row.draftId),
        ...searchResultRowModels().map((row) => row.draftId)
    ]);

    // Selection tracks visible rows: a row that leaves the set deselects.
    createEffect(() => {
        const selected = searchSelectedDraftId();
        if (selected !== null && !searchRowOrder().includes(selected)) {
            setSearchSelectedDraftId(null);
        }
    });

    // R5: computed ONLY when the primary matchup result is empty.
    const searchScopeHints = createMemo<ScopeHint[]>(() => {
        const results = searchResults();
        if (results === null || results.matches.length > 0) return [];
        const teamName = searchTeamName();
        const opponentTeamName = searchOpponentName();
        if (teamName === null || opponentTeamName === null) return [];
        return computeMatchupScopeHint(
            canvasDrafts,
            canvasGroups,
            {
                championId: searchChampionId(),
                teamName,
                opponentTeamName,
                bucket: searchBucket(),
                scope: searchScope()
            },
            resolveChampionId
        );
    });

    // R7: snapshot the pre-jump viewport (ONE snapshot, overwritten per jump);
    // jumps don't persist the viewport — same as the old walk.
    const jumpToSearchDraft = (draftId: string) => {
        const cd = searchDraftById().get(draftId);
        if (!cd) return;
        setSearchSelectedDraftId(draftId);
        setSearchReturnViewport(props.viewport());
        const target = getDraftWorldPosition(cd);
        navigateToDraft(target.x, target.y);
    };

    const returnFromSearchJump = () => {
        const snapshot = searchReturnViewport();
        if (snapshot === null) return;
        props.setViewport(snapshot);
        setSearchReturnViewport(null);
    };

    const moveSearchSelection = (direction: 1 | -1) => {
        const order = searchRowOrder();
        if (order.length === 0) return;
        const selected = searchSelectedDraftId();
        const index = selected === null ? -1 : order.indexOf(selected);
        const next =
            index === -1
                ? direction === 1
                    ? 0
                    : order.length - 1
                : Math.min(Math.max(index + direction, 0), order.length - 1);
        setSearchSelectedDraftId(order[next] ?? null);
    };

    const toggleSearchPin = (draftId: string) => {
        setSearchPinnedIds((prev) => {
            const next = new Set(prev);
            if (next.has(draftId)) next.delete(draftId);
            else next.add(draftId);
            return next;
        });
    };

    const setSearchQueryChampion = (championId: string | null) => {
        setSearchChampionId(championId);
    };
    const setSearchQueryTeam = (teamName: string | null) => {
        setSearchTeamName(teamName);
        setSearchBucket(null);
        // Scope is deliberately NOT reset here. It used to be, to avoid sticky
        // hidden state back when the scope row only appeared under a team
        // filter. Now scope decides which teams the dropdown offers, so
        // resetting it would drop the scope the instant you picked one of the
        // teams only that scope could surface.
        const opponent = searchOpponentName();
        // Invariant: opponent ⇒ team, and opponent ≠ team (case-insensitive).
        if (
            teamName === null ||
            (opponent !== null &&
                teamName.trim().toLowerCase() === opponent.trim().toLowerCase())
        ) {
            setSearchOpponentName(null);
        }
    };
    const setSearchQueryOpponent = (teamName: string | null) => {
        setSearchOpponentName(teamName);
    };
    const setSearchQueryScope = (scope: SearchScope) => {
        setSearchScope(scope);
    };
    const setSearchQueryBucket = (bucket: SearchBucket | null) => {
        setSearchBucket(bucket);
    };
    // Pins are session-only, cleared on panel close (R6); selection and the
    // back-chip snapshot die with the panel too.
    const closeSearch = () => {
        setSearchOpen(false);
        setSearchSelectedDraftId(null);
        setSearchReturnViewport(null);
        setSearchPinnedIds(new Set<string>());
    };

    // Canvas-to-canvas navigation keeps this component MOUNTED (see the
    // cursorEmitter effect above) — search state must not leak to another
    // canvas's corpus: stale pinned ids could bind to same-ID drafts there and
    // the return snapshot is the previous canvas's coordinates. Keyed on the
    // canvas identity; cleanup fires on the switch (and, harmlessly, on unmount).
    createEffect(() => {
        canvasId();
        onCleanup(() => closeSearch());
    });

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

    const newDraftMutation = useMutation(() => ({
        mutationFn: (data: {
            name: string;
            picks: string[];
            public: boolean;
            canvas_id: string;
            positionX: number;
            positionY: number;
            group_id?: string;
        }) => {
            return postNewDraft(data);
        },
        onMutate: (variables) => {
            const tempId = `temp-${Date.now()}`;
            const tempDraft: CanvasDraft = {
                draft_id: tempId,
                positionX: variables.positionX,
                positionY: variables.positionY,
                group_id: variables.group_id ?? null,
                Draft: {
                    name: variables.name,
                    id: tempId,
                    picks: variables.picks,
                    type: "canvas"
                }
            };
            setCanvasDrafts([...canvasDrafts, tempDraft]);
            return { tempId };
        },
        onSuccess: () => {
            toast.success("Successfully created new draft!");
        },
        onError: (error, _vars, context) => {
            if (context?.tempId) {
                setCanvasDrafts(
                    canvasDrafts.filter((d) => d.Draft.id !== context.tempId)
                );
            }
            toast.error(`Error creating new draft: ${error.message}`);
        }
    }));

    const editDraftMutation = useMutation(() => ({
        // Deliberately no `public` field. Sending `public: false` on a rename
        // silently un-published any public draft, and it also made the server
        // treat the edit as more-than-a-rename, so it broadcast a whole
        // canvasUpdate instead of the narrow draftNameUpdated event.
        mutationFn: (data: { id: string; name: string }) => {
            return editDraft(data.id, data, canvasId());
        },
        onSuccess: () => {
            toast.success("Successfully edited draft!");
        },
        onError: (error) => {
            // handleNameChange wrote the new name into the store optimistically,
            // so a failure has to put the old one back.
            toast.error(`Error editing draft: ${error.message}`);
            canvasContext.refetchCanvas();
        }
    }));

    const updatePositionMutation = useMutation(() => ({
        mutationFn: updateCanvasDraftPosition,
        onMutate: (variables) => {
            const draft = canvasDrafts.find((d) => d.Draft.id === variables.draftId);
            return { prevX: draft?.positionX, prevY: draft?.positionY };
        },
        onError: (error: Error, variables, context) => {
            const prevX = context?.prevX;
            const prevY = context?.prevY;
            if (prevX != null && prevY != null) {
                setCanvasDrafts(
                    canvasDrafts.map((d) =>
                        d.Draft.id === variables.draftId
                            ? { ...d, positionX: prevX, positionY: prevY }
                            : d
                    )
                );
            }
            toast.error(`Failed to save position: ${error.message}`);
        }
    }));

    const updateDraftPositionsMutation = useMutation(() => ({
        mutationFn: updateCanvasDraftPositions,
        onError: (error: Error) => {
            toast.error(`Failed to save grid positions: ${error.message}`);
        }
    }));

    /**
     * Apply Group position writes to the store — the optimistic half of every
     * Group move.
     *
     * Always fed by `subtreeMoveWrites` (via `splitGridPlacements` or the drag),
     * never by a bare row: the server fans a container's delta out over its
     * descendants, so a client that writes only the container makes its own
     * subtree lag until the broadcast lands.
     */
    const applyGroupPositionWrites = (writes: GroupPositionWrite[]) => {
        if (writes.length === 0) return;
        batch(() => {
            for (const write of writes) {
                setCanvasGroups((g) => g.id === write.id, {
                    positionX: write.positionX,
                    positionY: write.positionY
                });
            }
        });
    };

    /**
     * Swap a grid payload's `groups` for the whole moved subtree, for the local
     * path only.
     *
     * `localUpdateDraftPositions` applies entries verbatim and fans NOTHING
     * out, while the server derives `dy` and fans it over `descendantGroupsOf`.
     * So the direct placements that are exactly right on the wire strand a
     * moved container's grandchildren on reload in a local canvas. The
     * container-drag path already worked around this; these seams never got the
     * same treatment.
     */
    const withLocalSubtree = <T,>(
        payload: T,
        writes: GridWrites
    ): T & { groups?: GroupPositionUpdate[] } => ({
        ...payload,
        ...(writes.groupStoreWrites.length > 0 ? { groups: writes.groupStoreWrites } : {})
    });

    /**
     * Snap/swap commit for a drop inside a grid-mode custom group, for a Card or
     * a nested Group alike. Applies optimistic store updates, then persists
     * positions + parentage + derived container dimensions in one atomic
     * request (or the local-storage equivalent).
     *
     * `dragged.id` is the node's PLACEMENT identity — a Card's `draft_id`, a
     * Group's `id` — which is what `canvasTree`'s items and the store's keyed
     * reconcile both use.
     *
     * `relX/relY` and `origin` are CONTAINER-relative. For a Group the caller
     * has to rebase them from absolute world (ADR-0006) BEFORE calling: the
     * resolver's swap and relocation math runs on those numbers, so rebasing
     * the output would be too late.
     */
    const commitGridDrop = (args: {
        group: CanvasGroup;
        /**
         * `inset` and `height` ride along with the footprint because the node
         * may be entering from OUTSIDE the container, and §6.0a's row geometry
         * needs both to project it into the landing membership. One object
         * rather than two loose numbers: a positional `number, number` pair is
         * the shape a later edit transposes.
         */
        dragged: {
            id: string;
            kind: GridItem["kind"];
            footprint: GridFootprint;
            inset: number;
            height: number;
        };
        relX: number;
        relY: number;
        origin: { x: number; y: number } | null;
        /** The drop changes membership into `group`. */
        joinsContainer: boolean;
    }) => {
        const { group, dragged, relX, relY, origin, joinsContainer } = args;
        const layout = props.cardLayout();
        // This container's layout is about to be written by the EXACT path.
        // `resyncGroupSize(group.id)` runs immediately after, in the same
        // handler, and must resize without re-deriving — see `settledByGesture`.
        settledByGesture.add(group.id);
        queueMicrotask(() => settledByGesture.delete(group.id));
        const items = gridItemsFor(group);
        // THREE counts, and conflating any two of them is a bug this path has
        // had at least one of (round 2, V4):
        //
        //  - `layoutCols` is the lattice everything on the drop path runs on —
        //    the items, the target cell, the resolver, the row count. They used
        //    to run on two different counts, so the overlay offered a column
        //    the resolver refused. A node entering from OUTSIDE is not among
        //    the container's children yet, so its own footprint has to widen
        //    this explicitly or the resolver runs with too few columns.
        //  - `configuredCols` is the floor PERSISTED to metadata. Never the
        //    layout count: that one carries the growth column, and persisting it
        //    would widen the grid by a column on every drop.
        //  - `sizeCols` is what the container's SIZE comes from — configured
        //    plus the must-fit terms, and no growth column, or the container
        //    grows a column wider than it needs.
        const layoutCols = Math.max(gridColsFor(group), dragged.footprint.cols);
        // TARGETING membership (§6.0a, three memberships): the dragged node is
        // EXCLUDED. Including it lets a hovering Bo3 raise its own target row's
        // baseline, shifting that row's offset, changing which row the point
        // falls in — frame after frame.
        const targetingRows = rowsOfItems(
            items.filter((i) => i.id !== dragged.id),
            layout
        );
        const targetCell = cellAt(targetingRows, relX, relY, layout, layoutCols);
        const assignments = resolveGridDrop({
            items,
            rows: targetingRows,
            dragged,
            draggedOrigin: origin,
            dropX: relX,
            dropY: relY,
            layout,
            cols: layoutCols
        });
        // Measured from where the node actually LANDED, not from the raw drop
        // point: a wide node is clamped to `lastStartCol`, and a collision can
        // relocate it to a lower column. Bumping the user's configured count
        // for a landing that never happened is the same class of mistake as
        // sizing the container from the layout count.
        const landing = assignments.find((a) => a.id === dragged.id);
        const landingCell = landing ? landing.cell : targetCell;
        const configuredCols = configuredColsAfterDrop(
            group,
            landingCell,
            dragged.footprint
        );
        // The row axis, by the same rule and from the same landing. Without it
        // a drop into the growth row was accepted and the container grew, but
        // the count stayed put — so the row lasted only as long as something
        // occupied it, and moving that member away collapsed the container.
        const configuredRows = configuredRowsAfterDrop(
            group,
            landingCell,
            dragged.footprint
        );
        const sizeCols = Math.max(
            configuredCols,
            maxChildSpanCols(canvasTree(), group.id, layout),
            dragged.footprint.cols
        );
        const projected = projectIntoGrid(items, dragged, landingCell, {
            x: relX,
            y: relY
        });
        // LANDING membership: everything that moves, including row-mates the
        // user never touched and every row below a row that changed height.
        const { placements, rows: landedRows } = materializeGrid({
            items: projected,
            assignments,
            layout
        });
        const writes = splitGridPlacements({
            tree: canvasTree(),
            parent: group,
            placements
        });
        const updates = writes.positions;
        if (joinsContainer && dragged.kind === "card") {
            const entry = updates.find((u) => u.draft_id === dragged.id);
            if (entry) entry.group_id = group.id;
        }
        if (joinsContainer && dragged.kind === "annotation") {
            const entry = writes.annotations.find((a) => a.id === dragged.id);
            if (entry) entry.group_id = group.id;
        }
        if (dragged.kind === "group") {
            // Rebasing the placement says where it sits; it does not say that
            // it is a MEMBER. `parentId` is the only thing that does, and key
            // presence is the protocol — absent leaves parentage alone.
            const entry = writes.groups.find((g) => g.id === dragged.id);
            if (entry && joinsContainer) entry.parentId = group.id;
        }
        // `configuredRows`, not the STORED count — this is the write that
        // raises it, so reading the group would size the container to the floor
        // it is leaving behind.
        const dims = resolveGridDims(
            group,
            gridContentHeightForRows(landedRows, configuredRows, layout),
            sizeCols,
            layout
        );
        const gridChanges = {
            ...(configuredCols !== gridColsOf(group) ? { gridCols: configuredCols } : {}),
            ...(configuredRows !== gridRowsOf(group) ? { gridRows: configuredRows } : {})
        };
        const metadata = Object.keys(gridChanges).length > 0 ? gridChanges : undefined;

        for (const u of updates) {
            setCanvasDrafts((cd) => cd.draft_id === u.draft_id, {
                positionX: u.positionX,
                positionY: u.positionY,
                ...(u.group_id !== undefined ? { group_id: u.group_id } : {})
            });
        }
        for (const entry of writes.annotations) {
            setAnnotations((a) => a.id === entry.id, {
                positionX: entry.positionX,
                positionY: entry.positionY,
                ...(Object.prototype.hasOwnProperty.call(entry, "group_id")
                    ? { group_id: entry.group_id }
                    : {})
            });
        }
        applyGroupPositionWrites(writes.groupStoreWrites);
        if (joinsContainer && dragged.kind === "group") {
            setCanvasGroups((g) => g.id === dragged.id, {
                parent_group_id: group.id
            });
        }
        setCanvasGroups((g) => g.id === group.id, {
            width: dims.width,
            height: dims.height,
            ...(metadata ? { metadata: { ...group.metadata, ...metadata } } : {})
        });

        const payload = {
            positions: updates,
            ...(writes.annotations.length > 0 ? { annotations: writes.annotations } : {}),
            ...(writes.groups.length > 0 ? { groups: writes.groups } : {}),
            group: { id: group.id, width: dims.width, height: dims.height, metadata }
        };
        if (isLocalMode()) {
            localUpdateDraftPositions(withLocalSubtree(payload, writes));
        } else {
            updateDraftPositionsMutation.mutate({ canvasId: canvasId(), ...payload });
        }
    };

    // Quantize all member cards to cells and flip the group into grid mode,
    // atomically (positions + metadata + dimensions in one request).
    const arrangeGroupAsGrid = (group: CanvasGroup, metadata: GridMetadata) => {
        const layout = props.cardLayout();
        // The configured count is a floor, not a ceiling: a child wider than it
        // still has to fit, exactly as effectiveGridCols re-derives on read.
        const cols = Math.max(
            metadata.gridCols,
            maxChildSpanCols(canvasTree(), group.id, layout)
        );
        const items = gridItemsOf(canvasTree(), group.id, layout, cols);
        const assignments = arrangeGrid(items, cols);
        // `arrangeGrid` assigns cells to child GROUPS as well as Cards, and
        // `toPositionUpdates` used to drop that half on the floor — so a nested
        // Group kept its old position while Cards were written around the cells
        // it had been assigned, and the container was sized from a layout that
        // never happened. One menu click, a persisted write.
        const { placements, rows } = materializeGrid({ items, assignments, layout });
        const writes = splitGridPlacements({
            tree: canvasTree(),
            parent: group,
            placements
        });
        const updates = writes.positions;
        // The metadata being APPLIED, not the stored row count — this is the
        // path a row-count change takes, so reading the group would size it to
        // the count it is leaving behind.
        //
        // Derived WITHOUT the manual floor, and recorded AS the new floor, for
        // the reason `gridDimsFor` gives: the counts and the floor are two
        // views of one thing, so a stale floor must not veto a column change
        // the user just made. `gridContentHeightForRows` and `cols` have both
        // already taken the max over what the members need.
        const raw = gridDimensions(
            gridContentHeightForRows(rows, metadata.gridRows, layout),
            cols,
            layout
        );
        const dims = {
            width: Math.max(MIN_GROUP_WIDTH, raw.width),
            height: Math.max(MIN_GROUP_HEIGHT, raw.height)
        };
        const sizedMetadata = {
            ...metadata,
            manualWidth: dims.width,
            manualHeight: dims.height
        };

        for (const u of updates) {
            setCanvasDrafts((cd) => cd.draft_id === u.draft_id, {
                positionX: u.positionX,
                positionY: u.positionY
            });
        }
        for (const entry of writes.annotations) {
            setAnnotations((a) => a.id === entry.id, {
                positionX: entry.positionX,
                positionY: entry.positionY,
                ...(Object.prototype.hasOwnProperty.call(entry, "group_id")
                    ? { group_id: entry.group_id }
                    : {})
            });
        }
        applyGroupPositionWrites(writes.groupStoreWrites);
        setCanvasGroups((g) => g.id === group.id, {
            width: dims.width,
            height: dims.height,
            metadata: { ...group.metadata, ...sizedMetadata }
        });

        const payload = {
            positions: updates,
            ...(writes.annotations.length > 0 ? { annotations: writes.annotations } : {}),
            ...(writes.groups.length > 0 ? { groups: writes.groups } : {}),
            group: {
                id: group.id,
                width: dims.width,
                height: dims.height,
                metadata: sizedMetadata
            }
        };
        if (isLocalMode()) {
            localUpdateDraftPositions(withLocalSubtree(payload, writes));
        } else {
            updateDraftPositionsMutation.mutate({ canvasId: canvasId(), ...payload });
        }
    };

    /**
     * Persist a reflow's displaced siblings — the third caller of
     * `splitGridPlacements`, alongside `commitGridDrop` and
     * `arrangeGroupAsGrid`, and the one its docblock already anticipated.
     *
     * Unlike those two this writes no container dimensions: the caller decides
     * how the parent resizes (the series-growth seam uses `resyncGroupSize`,
     * which re-derives the grid's own lattice).
     *
     * The local branch goes through `withLocalSubtree` for the same reason the
     * other two seams do. It deliberately does NOT call `refreshFromLocal`: the
     * optimistic Card, annotation, and Group writes above already cover the UI,
     * and that helper replaces
     * the group store wholesale, which recreates the `<For>` DOM and strands
     * `:hover`. `persistGroupDimensions` sets the same precedent.
     */
    const commitGridMaterialization = (
        parentId: string,
        assignments: GridAssignment[]
    ) => {
        const parent = canvasGroups.find((g) => g.id === parentId);
        if (!parent) return;

        // Materialized HERE and only here, so there is exactly one point where
        // a cell becomes a pixel on this path. The assignments name displaced
        // siblings only; `materializeGrid` sees the whole membership, which is
        // what lets a baseline change move row-mates nobody displaced.
        const layout = props.cardLayout();
        const { placements } = materializeGrid({
            items: gridItemsFor(parent),
            assignments,
            layout
        });
        if (placements.length === 0) return;

        const writes = splitGridPlacements({
            tree: canvasTree(),
            parent,
            placements
        });

        for (const u of writes.positions) {
            setCanvasDrafts((cd) => cd.draft_id === u.draft_id, {
                positionX: u.positionX,
                positionY: u.positionY
            });
        }
        for (const entry of writes.annotations) {
            setAnnotations((a) => a.id === entry.id, {
                positionX: entry.positionX,
                positionY: entry.positionY,
                ...(Object.prototype.hasOwnProperty.call(entry, "group_id")
                    ? { group_id: entry.group_id }
                    : {})
            });
        }
        applyGroupPositionWrites(writes.groupStoreWrites);

        if (isLocalMode()) {
            localUpdateDraftPositions(
                withLocalSubtree(
                    {
                        positions: writes.positions,
                        ...(writes.annotations.length > 0
                            ? { annotations: writes.annotations }
                            : {})
                    },
                    writes
                )
            );
        } else {
            updateDraftPositionsMutation.mutate({
                canvasId: canvasId(),
                positions: writes.positions,
                ...(writes.annotations.length > 0
                    ? { annotations: writes.annotations }
                    : {}),
                ...(writes.groups.length > 0 ? { groups: writes.groups } : {})
            });
        }
    };

    /**
     * A manual series' game count just changed, so its column span changed with
     * it. Displace whatever the wider span now covers, then resize the parent.
     *
     * `resyncGroupSize` must be called on the PARENT grid, not the series: it
     * returns early for `type !== "custom"`, so calling it on a series id is a
     * silent no-op (§6.2 gap 2).
     */
    const reflowAfterSeriesGrowth = (seriesId: string) => {
        const reflow = seriesGrowthReflow({
            tree: canvasTree(),
            seriesId,
            layout: props.cardLayout()
        });
        if (reflow) {
            commitReflowPlacements(reflow.parentId, reflow.placements);
        }
        // The wider span raises effectiveGridCols' must-fit term, so the
        // container has to grow with it — even when nothing was displaced.
        const parentId = canvasGroups.find((g) => g.id === seriesId)?.parent_group_id;
        if (parentId) resyncGroupSize(parentId);
    };

    const gridRowCount = (group: CanvasGroup, cols: number): number => {
        const layout = props.cardLayout();
        return arrangedRowCount(gridItemsOf(canvasTree(), group.id, layout, cols), cols);
    };

    /**
     * What the settings dialog's layout section asks of a CUSTOM Group, or
     * `null` when it asks for nothing it does not already have.
     *
     * That null is the point: a rename or a classification change on a group
     * whose grid nobody touched stays ONE request. Folding the layout keys into
     * that same request — rather than firing a second write — also removes a
     * race, since two partial metadata merges can otherwise have their
     * responses arrive out of order and the loser replaces the row.
     *
     * A `reflow` is the one case that cannot be folded: re-arranging members
     * writes positions, which only the draft-positions route carries.
     */
    const resolveLayoutChange = (
        group: CanvasGroup,
        settings: GridSettingsInput | null
    ):
        | { reflow: false; metadata: CanvasGroupMetadataUpdate }
        | { reflow: true; metadata: GridMetadata }
        | null => {
        if (!settings) {
            // Lossless: positions are already real floats; only the flag flips.
            return isGridGroup(group)
                ? { reflow: false, metadata: { layout: "free" } }
                : null;
        }
        const { metadata, reflow } = resolveGridSave(group.metadata, settings);
        if (reflow) return { reflow: true, metadata };
        return gridMetadataEquals(group.metadata, metadata)
            ? null
            : { reflow: false, metadata };
    };

    /**
     * The row bands a grid container currently presents — its own configured
     * columns raised by any child too wide for them, exactly as the sizing
     * paths read it.
     */
    const gridRowsFor = (group: CanvasGroup): RowMetrics[] => {
        const layout = props.cardLayout();
        const cols = Math.max(
            gridColsOf(group),
            maxChildSpanCols(canvasTree(), group.id, layout)
        );
        return rowsOfItems(gridItemsOf(canvasTree(), group.id, layout, cols), layout);
    };

    /**
     * The size a grid container should be for `metadata`, without re-arranging
     * anything — the row count is a height floor, not an arrangement input, so
     * changing it resizes the frame and moves nothing.
     *
     * **Deliberately NOT `resolveGridDims`** (2026-08-11). That takes
     * `max(manualFloor, derived)`, so once `handleResizeEnd` had written a
     * floor, every later count change in the dialog was vetoed by it and the
     * dialog silently did nothing. The counts and the manual floor are two
     * views of one thing now — a resize writes the counts, and a count change
     * writes the floor, which is what `handleSaveGroupSettings` does with this
     * result. Content still fits without the floor's help: both terms below
     * already take the max over what the members need.
     */
    const gridDimsFor = (group: CanvasGroup, metadata: GridMetadata) => {
        const layout = props.cardLayout();
        const cols = Math.max(
            metadata.gridCols,
            maxChildSpanCols(canvasTree(), group.id, layout)
        );
        const items = gridItemsOf(canvasTree(), group.id, layout, cols);
        const dims = gridDimensions(
            gridContentHeightForRows(
                rowsOfItems(items, layout),
                metadata.gridRows,
                layout
            ),
            cols,
            layout
        );
        return {
            width: Math.max(MIN_GROUP_WIDTH, dims.width),
            height: Math.max(MIN_GROUP_HEIGHT, dims.height)
        };
    };

    const handleSetGroupTeamNames = (metadata: {
        blueTeamName: string;
        redTeamName: string;
    }) => {
        const group = teamNamesGroup();
        if (!group || !canEdit()) return;
        if (isLocalMode()) {
            localUpdateGroup({ groupId: group.id, metadata });
            refreshFromLocal();
        } else {
            updateGroupMutation.mutate({
                canvasId: canvasId(),
                groupId: group.id,
                metadata
            });
        }
    };

    /**
     * `metadata` rides along in the SAME request rather than firing a second
     * one — two partial metadata merges can have their responses arrive out of
     * order and the loser replaces the row, which is the race
     * `resolveLayoutChange` exists to avoid on the settings path.
     */
    const persistGroupDimensions = (
        group: CanvasGroup,
        dims: { width: number; height: number },
        // Narrower than `CanvasGroupMetadataUpdate` on purpose: that permits the
        // D3 clear protocol's `null`, which the STORED metadata shape does not
        // accept, so a general type here could not be merged into the store
        // without an assertion.
        metadata?: CopyPlacement["groupMetadata"]
    ) => {
        setCanvasGroups(
            (g) => g.id === group.id,
            (g) => ({
                ...g,
                width: dims.width,
                height: dims.height,
                ...(metadata ? { metadata: { ...g.metadata, ...metadata } } : {})
            })
        );
        if (isLocalMode()) {
            localUpdateGroup({
                groupId: group.id,
                width: dims.width,
                height: dims.height,
                ...(metadata ? { metadata } : {})
            });
        } else {
            updateGroupMutation.mutate({
                canvasId: canvasId(),
                groupId: group.id,
                width: dims.width,
                height: dims.height,
                ...(metadata ? { metadata } : {})
            });
        }
    };

    const deleteDraftMutation = useMutation(() => ({
        mutationFn: deleteDraftFromCanvas,
        onMutate: (variables) => {
            const removedDraft = canvasDrafts.find((d) => d.Draft.id === variables.draft);
            setCanvasDrafts(canvasDrafts.filter((d) => d.Draft.id !== variables.draft));
            setIsDeleteDialogOpen(false);
            setDraftToDelete(null);
            // After the store write, so the container is measured without it.
            if (removedDraft?.group_id) resyncGroupSize(removedDraft.group_id);
            return { removedDraft };
        },
        onSuccess: () => {
            toast.success("Successfully deleted draft");
        },
        onError: (error, _vars, context) => {
            if (context?.removedDraft) {
                setCanvasDrafts([...canvasDrafts, context.removedDraft]);
            }
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

    const updateAnnotationMutation = useMutation(() => ({
        mutationFn: updateAnnotation,
        onError: (error: Error) => toast.error(`Failed to update note: ${error.message}`)
    }));

    const createAnnotationMutation = useMutation(() => ({
        mutationFn: createAnnotation,
        onSuccess: (data) => {
            setAnnotations([...annotations, data.annotation]);
            // Symmetric with the local branch: select and open the new note.
            setSelectedAnnotationId(data.annotation.id);
            setEditingAnnotationId(data.annotation.id);
        },
        onError: (error: Error) => toast.error(`Failed to create note: ${error.message}`)
    }));

    const deleteAnnotationMutation = useMutation(() => ({
        mutationFn: deleteAnnotation,
        onMutate: (variables) => {
            const removed = annotations.find((a) => a.id === variables.annotationId);
            setAnnotations(annotations.filter((a) => a.id !== variables.annotationId));
            return { removed };
        },
        onError: (error: Error, _variables, context) => {
            // An annotation is the only AUTHORED PROSE on the canvas — a Card's
            // content is picks, which are re-enterable; a paragraph is not, and
            // there is no undo, no panel row and no search hit to notice it went
            // missing (D11). A failed delete must put it back.
            if (context?.removed) setAnnotations([...annotations, context.removed]);
            toast.error(`Failed to delete note: ${error.message}`);
        }
    }));

    const copyAnnotationMutation = useMutation(() => ({
        mutationFn: copyAnnotation,
        onSuccess: (data) => setAnnotations([...annotations, data.annotation]),
        onError: (error: Error) =>
            toast.error(`Failed to duplicate note: ${error.message}`)
    }));

    const createPoolMutation = useMutation(() => ({
        mutationFn: createCanvasPool,
        onSuccess: (data, variables) => {
            // Guarded append: the route's own canvasUpdate broadcast can land
            // before the HTTP response and reconcile the row in first.
            if (!canvasPools.some((p) => p.id === data.pool.id)) {
                setCanvasPools([...canvasPools, data.pool]);
            }
            setSelectedPoolId(data.pool.id);
            // Only the empty "New Champion Pool" background-menu entry omits
            // `name` — that pool has nothing to show but a placeholder, so its
            // first act is naming it (mirrors note create opening the
            // editor). "New Pool from Saved…" always passes a name (copied
            // from the saved pool), so it should just select, not force a
            // rename the user didn't ask for.
            if (variables.name === undefined) {
                setRenamingPoolId(data.pool.id);
            }
        },
        onError: (error: Error) => toast.error(`Failed to create pool: ${error.message}`)
    }));

    const updatePoolMutation = useMutation(() => ({
        mutationFn: updateCanvasPool,
        onError: (error: Error) => toast.error(`Failed to update pool: ${error.message}`)
    }));

    const deletePoolMutation = useMutation(() => ({
        mutationFn: deleteCanvasPool,
        onMutate: (variables) => {
            const removed = canvasPools.find((p) => p.id === variables.placementId);
            setCanvasPools(canvasPools.filter((p) => p.id !== variables.placementId));
            return { removed };
        },
        onError: (error: Error, _variables, context) => {
            // A pool is authored work-product with no undo and no panel row to
            // notice it went missing — same D11 reasoning as notes. A failed
            // delete must put it back.
            if (context?.removed) setCanvasPools([...canvasPools, context.removed]);
            toast.error(`Failed to delete pool: ${error.message}`);
        }
    }));

    // Guard + optimistic write + dispatch live in `commitPoolRename`
    // (utils/poolCard.ts) so the branch logic is unit-testable without
    // mounting the canvas — see its doc for the guard/ordering rationale.
    const handlePoolRename = (placementId: string, rawName: string) => {
        commitPoolRename({
            pools: canvasPools,
            placementId,
            rawName,
            setName: (id, name) =>
                setCanvasPools((p) => p.id === id, "Pool", "name", name),
            isLocalMode,
            mutate: ({ placementId: id, name }) =>
                updatePoolMutation.mutate({
                    canvasId: canvasId(),
                    placementId: id,
                    name
                }),
            localRename: ({ placementId: id, name }) =>
                localRenamePool({ placementId: id, name }),
            refreshFromLocal
        });
    };

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
        },
        onError: (error: Error) => {
            toast.error(`Failed to create connection: ${error.message}`);
        }
    }));

    const updateConnectionMutation = useMutation(() => ({
        mutationFn: updateConnection,
        onSuccess: () => {
            toast.success("Connection updated!");
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
        },
        onError: (error: Error) => {
            toast.error(`Failed to delete connection: ${error.message}`);
        }
    }));

    const createVertexMutation = useMutation(() => ({
        mutationFn: createVertex,
        onError: (error: Error) => {
            toast.error(`Failed to create vertex: ${error.message}`);
        }
    }));

    const updateVertexMutation = useMutation(() => ({
        mutationFn: updateVertex,
        onMutate: () => {
            // Vertex positions are updated via socket canvasUpdate; store snapshot for rollback
            return { needsRefetch: true };
        },
        onError: (error: Error, _vars, context) => {
            if (context?.needsRefetch) {
                canvasContext.refetchCanvas();
            }
            toast.error(`Failed to update vertex: ${error.message}`);
        }
    }));

    const deleteVertexMutation = useMutation(() => ({
        mutationFn: deleteVertex,
        onSuccess: () => {
            toast.success("Vertex deleted!");
        },
        onError: (error: Error) => {
            toast.error(`Failed to delete vertex: ${error.message}`);
        }
    }));

    /**
     * A container drag, committed through the batch endpoint so the server can
     * fan the delta out over the subtree (step-4 amendment 9). `PUT
     * /group/:groupId` never learns to do that — it is the resize route.
     *
     * `rollback` carries the TOTAL delta since mousedown, because the failure
     * this has to undo is the whole drag. The old `onMutate` snapshot ran at
     * mouse-up, after the live drag had already written the final position, so
     * it restored the failed drag to itself (A1).
     */
    const updateGroupSubtreeMutation = useMutation(() => ({
        mutationFn: (variables: {
            canvasId: string;
            positions: DraftPositionUpdate[];
            groups: GroupPositionUpdate[];
            rollback: { groupId: string; dx: number; dy: number };
        }) =>
            updateCanvasDraftPositions({
                canvasId: variables.canvasId,
                positions: variables.positions,
                groups: variables.groups
            }),
        onError: (error: Error, variables) => {
            const { groupId, dx, dy } = variables.rollback;
            applyGroupPositionWrites(subtreeMoveWrites(canvasTree(), groupId, -dx, -dy));
            toast.error(`Failed to save group position: ${error.message}`);
        }
    }));

    const deleteGroupMutation = useMutation(() => ({
        mutationFn: deleteCanvasGroup,
        onMutate: () => {
            const deletedGroupId = groupToDelete()?.id;
            const removedGroup = deletedGroupId
                ? canvasGroups.find((g) => g.id === deletedGroupId)
                : undefined;
            const removedDrafts = deletedGroupId
                ? canvasDrafts.filter((cd) => cd.group_id === deletedGroupId)
                : [];
            // Direct child Groups are PROMOTED, not dropped, mirroring the
            // route (design §8.2.0). `renderOrder` tolerates the orphan this
            // would otherwise leave for a round trip — but the promotion is
            // where they are going anyway, so showing it now avoids a visible
            // flash into and back out of the top-level paint stratum.
            const promotedChildren = deletedGroupId
                ? canvasGroups
                      .filter((g) => g.parent_group_id === deletedGroupId)
                      .map((g) => g.id)
                : [];
            if (deletedGroupId) {
                const promoteTo = removedGroup?.parent_group_id ?? null;
                setCanvasGroups(
                    (g) => g.parent_group_id === deletedGroupId,
                    "parent_group_id",
                    promoteTo
                );
                setCanvasGroups(canvasGroups.filter((g) => g.id !== deletedGroupId));
                setCanvasDrafts(
                    canvasDrafts.filter((cd) => cd.group_id !== deletedGroupId)
                );
            }
            setIsDeleteGroupDialogOpen(false);
            setGroupToDelete(null);
            return { removedGroup, removedDrafts, promotedChildren };
        },
        onSuccess: () => {
            toast.success("Group removed from canvas");
        },
        onError: (error, _vars, context) => {
            if (context?.removedGroup) {
                setCanvasGroups([...canvasGroups, context.removedGroup]);
                // Un-promote too, or a failed delete leaves the children at top
                // level with their container back around them.
                for (const childId of context.promotedChildren ?? []) {
                    setCanvasGroups((g) => g.id === childId, {
                        parent_group_id: context.removedGroup?.id ?? null
                    });
                }
            }
            if (context?.removedDrafts?.length) {
                setCanvasDrafts([...canvasDrafts, ...context.removedDrafts]);
            }
            toast.error(`Error removing group: ${error.message}`);
        }
    }));

    const updateGroupMutation = useMutation(() => ({
        mutationFn: updateCanvasGroup,
        onSuccess: (data, variables) => {
            setCanvasGroups((g) => g.id === variables.groupId, data.group);
            // A manual series' length change returns its Cards (5a-6). Absorb
            // them BEFORE reflowing: footprintOf derives a series' span from the
            // Cards in the store, so reflowing first would use the old count.
            // The key is present only on a real length change, which is also
            // what elects this client the single writer.
            if (data.group.CanvasDrafts?.length) {
                const returnedDrafts = data.group.CanvasDrafts;
                const returnedIds = new Set(returnedDrafts.map((d) => d.Draft.id));
                setCanvasDrafts([
                    ...canvasDrafts.filter((d) => !returnedIds.has(d.Draft.id)),
                    ...returnedDrafts
                ]);
                reflowAfterSeriesGrowth(variables.groupId);
            }
            canvasContext.mutateCanvas((prev: CanvasResposnse | undefined) => {
                if (!prev) return prev;
                return {
                    ...prev,
                    groups: prev.groups.map((group) =>
                        group.id === variables.groupId ? data.group : group
                    )
                };
            });
        },
        onError: (error: Error) => {
            toast.error(`Failed to update group: ${error.message}`);
        }
    }));

    const convertGroupToSeriesMutation = useMutation(() => ({
        mutationFn: convertGroupToSeries,
        onSuccess: (data, variables) => {
            setCanvasGroups((g) => g.id === variables.groupId, data.group);
            if (data.group.CanvasDrafts?.length) {
                const returnedDrafts = data.group.CanvasDrafts;
                const returnedIds = new Set(returnedDrafts.map((d) => d.Draft.id));
                setCanvasDrafts([
                    ...canvasDrafts.filter((d) => !returnedIds.has(d.Draft.id)),
                    ...returnedDrafts
                ]);
            }
            canvasContext.mutateCanvas((prev: CanvasResposnse | undefined) => {
                if (!prev) return prev;
                const returnedDrafts = data.group.CanvasDrafts ?? [];
                const returnedIds = new Set(returnedDrafts.map((d) => d.Draft.id));
                return {
                    ...prev,
                    groups: prev.groups.map((group) =>
                        group.id === variables.groupId ? data.group : group
                    ),
                    drafts:
                        returnedDrafts.length > 0
                            ? [
                                  ...prev.drafts.filter(
                                      (d) => !returnedIds.has(d.Draft.id)
                                  ),
                                  ...returnedDrafts
                              ]
                            : prev.drafts
                };
            });
            toast.success("Series enabled");
        },
        onError: (error: Error) => {
            toast.error(`Failed to enable series: ${error.message}`);
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

    // Mirrors the Card relay. A drag path that does not broadcast is a
    // special-cased drag path, which D2 forbids.
    const emitAnnotationMove = (
        annotationId: string,
        positionX: number,
        positionY: number
    ) => {
        if (isLocalMode()) return;
        const socket = socketAccessor();
        if (!socket) return;
        socket.emit("annotationMove", {
            canvasId: canvasId(),
            annotationId,
            positionX,
            positionY
        });
    };
    const debouncedEmitAnnotationMove = debounce(emitAnnotationMove, 25);

    // Mirrors the annotation relay. Paint-only: `updatePoolMutation`'s
    // `canvasUpdate` snapshot at mouseup is the durable write.
    const emitPoolMove = (placementId: string, positionX: number, positionY: number) => {
        if (isLocalMode()) return;
        const socket = socketAccessor();
        if (!socket) return;
        socket.emit("poolMove", {
            canvasId: canvasId(),
            placementId,
            positionX,
            positionY
        });
    };
    const debouncedEmitPoolMove = debounce(emitPoolMove, 25);

    // Mirrors the GROUP resize relay, not the annotation MOVE relay beside it:
    // the server excludes this socket, because there is no "am I resizing this
    // one" guard to discard an echo with the way `annotationMoved` has
    // `draggedAnnotationId()`. See `relayAnnotationResize`.
    const emitAnnotationResize = (
        annotationId: string,
        positionX: number,
        width: number,
        height: number
    ) => {
        if (isLocalMode()) return;
        const socket = socketAccessor();
        if (!socket) return;
        socket.emit("annotationResize", {
            canvasId: canvasId(),
            annotationId,
            positionX,
            width,
            height
        });
    };
    const debouncedEmitAnnotationResize = debounce(emitAnnotationResize, 25);

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

    const emitGroupResize = (
        groupId: string,
        width: number,
        height: number,
        positionX?: number
    ) => {
        if (isLocalMode()) return;
        const socket = socketAccessor();
        if (!socket) return;
        socket.emit("groupResize", {
            canvasId: canvasId(),
            groupId,
            width,
            height,
            positionX
        });
    };

    const debouncedEmitGroupResize = debounce(emitGroupResize, 25);

    createEffect(() => {
        const currentId = canvasId();
        const data = props.canvasData;
        if (!data || props.isLoading || currentId === loadedCanvasId()) return;

        // Reset stores with new canvas data
        setCanvasDrafts(data.drafts ?? []);
        setConnections(data.connections ?? []);
        setCanvasGroups(data.groups ?? []);
        setAnnotations(data.annotations ?? []);
        setCanvasPools(data.pools ?? []);
        // A fresh authoritative fetch supersedes anything still in flight. A
        // never-committed optimistic op is legitimately dropped on
        // reload/switch, matching how optimistic draft picks behave.
        pendingPoolOps.clear();

        // Reset viewport for the new canvas
        props.setViewport(data.lastViewport ?? { x: 0, y: 0, zoom: 1 });

        // Reset UI state
        setIsConnectionMode(false);
        setConnectionSource(null);
        setSelectedVertexForConnection(null);
        setSelectedAnnotationId(null);
        setEditingAnnotationId(null);
        setSelectedPoolId(null);
        setRenamingPoolId(null);
        setPoolDragState({ activePoolId: null, offsetX: 0, offsetY: 0 });
        setAnnotationContextMenu(null);
        setPoolContextMenu(null);
        setNewPoolFromSavedAt(null);
        setPoolPendingDelete(null);
        setContextMenuPosition(null);
        setIsDeleteDialogOpen(false);
        setDraftToDelete(null);

        // Canvas room membership (gated joinCanvas) is handled by
        // CanvasSocketProvider so presence survives the draft view.
        setLoadedCanvasId(currentId);
    });

    // Sync canvas state after reconnection
    createEffect(() => {
        if (isLocalMode()) return;
        if (justReconnected()) {
            // Reset loadedCanvasId so the data-loading effect will re-apply the fresh data
            setLoadedCanvasId(null);
            canvasContext.refetchCanvas();
            clearReconnected();
        }
    });

    // Live remote cursors (slice 2). Listener lives here, not in the
    // provider: only the canvas view renders cursors, so the draft view
    // never pays for 30Hz store updates. World coordinates on the wire;
    // idle cursors fade after CURSOR_IDLE_MS and reappear on movement.
    // State machine lives in createRemoteCursorTracker (unit-tested).
    const userAccessor = useUser();
    const [currentUser] = userAccessor();
    const cursorTracker = createRemoteCursorTracker(() => currentUser()?.id);
    // Pool creation entries (background menu) and "Save to My Pools" (card
    // menu) are D7 server features — gate off the accessor already pulled in
    // above for remote cursors, never a second useUser() call.
    const isAuthenticated = () => Boolean(currentUser());

    // Owned teams for autocomplete linking in group settings. Unavailable on
    // local/anonymous canvases (no account) — string fallback covers those.
    const teamsEnabled = () => !isLocalMode() && !!currentUser();
    const teamsQuery = useQuery(() => ({
        queryKey: ["teams"],
        queryFn: fetchTeams,
        enabled: teamsEnabled()
    }));
    const ownedTeams = () => teamsQuery.data ?? [];
    const handleTeamCreated = () => {
        void queryClient.invalidateQueries({ queryKey: ["teams"] });
    };

    createEffect(() => {
        if (isLocalMode()) return;
        const socket = socketAccessor();
        // Keyed on the active canvas: canvas-to-canvas navigation keeps this
        // component mounted, so the effect must re-run — and reset cursors
        // and idle timers — when the route param changes.
        const id = canvasId();
        if (!socket || !id) return;

        const onCursorMove = (rawData: unknown) =>
            cursorTracker.handleCursorMove(rawData, id);
        // The provider owns the loud validation of presenceLeave; this
        // second listener only prunes the departed user's cursor.
        // cursorLeave (same payload shape) prunes through the same path:
        // it fires when a user leaves the canvas *view* while staying in
        // the room, e.g. drilling into a child draft.
        const onCursorPresenceLeave = (rawData: unknown) =>
            cursorTracker.handlePresenceLeave(rawData, id);

        socket.on("cursorMove", onCursorMove);
        socket.on("presenceLeave", onCursorPresenceLeave);
        socket.on("cursorLeave", onCursorPresenceLeave);
        onCleanup(() => {
            socket.off("cursorMove", onCursorMove);
            socket.off("presenceLeave", onCursorPresenceLeave);
            socket.off("cursorLeave", onCursorPresenceLeave);
            cursorTracker.reset();
        });
    });

    // Laser trails (slice 5). Same shape as the cursor listener: keyed on
    // the active canvas, quiet validation inside the tracker, reset on
    // canvas-to-canvas navigation. A sender's own leave emits laserEnd
    // through its cleanup, so only full departures need pruning here.
    const laserTracker = createLaserTrailTracker(() => currentUser()?.id);

    createEffect(() => {
        if (isLocalMode()) return;
        const socket = socketAccessor();
        const id = canvasId();
        if (!socket || !id) return;

        const onLaserPoint = (rawData: unknown) =>
            laserTracker.handleLaserPoint(rawData, id);
        const onLaserEnd = (rawData: unknown) => laserTracker.handleLaserEnd(rawData, id);
        const onLaserPresenceLeave = (rawData: unknown) =>
            laserTracker.handlePresenceLeave(rawData, id);

        socket.on("laserPoint", onLaserPoint);
        socket.on("laserEnd", onLaserEnd);
        socket.on("presenceLeave", onLaserPresenceLeave);
        onCleanup(() => {
            socket.off("laserPoint", onLaserPoint);
            socket.off("laserEnd", onLaserEnd);
            socket.off("presenceLeave", onLaserPresenceLeave);
            laserTracker.reset();
        });
    });

    createEffect(() => {
        if (isLocalMode()) return;
        const socket = socketAccessor();
        if (!socket) return;
        socket.on(
            "canvasUpdate",
            (data: {
                canvas: {
                    id: string;
                    name: string;
                    description?: string | null;
                    icon?: string | null;
                    cardLayout?: CardLayout;
                };
                drafts: CanvasDraft[];
                connections: Connection[];
                groups?: CanvasGroup[];
                annotations?: CanvasAnnotation[];
                pools?: CanvasPoolPlacement[];
            }) => {
                // Reconcile (merge in place) instead of replacing the arrays
                // wholesale. A wholesale replace hands `<For>` brand-new object
                // references for every draft/group, so it destroys and recreates
                // every series row + container — including the swap button that
                // may be under the cursor — which leaves its :hover/cursor stale
                // until the next real mousemove. Both arrays key on a stable
                // top-level id: `draft_id` for Cards, `id` for Groups. Keying
                // Cards positionally used to bind the wrong Card to retained DOM
                // whenever the server returned them in a different order — the
                // payload has no ORDER BY, so any drag's UPDATE can reorder it.
                setCanvasDrafts(reconcile(data.drafts, { key: "draft_id" }));
                setConnections(data.connections);
                setCanvasGroups(reconcile(data.groups ?? [], { key: "id" }));
                // Reconcile, never a wholesale replace — a wholesale replace
                // hands `<For>` new object references for every note, which
                // destroys and recreates the DOM under the cursor and strands
                // :hover until the next real mousemove.
                setAnnotations(reconcile(data.annotations ?? [], { key: "id" }));
                // A snapshot is built BEFORE any concurrent champion op
                // commits, so it must not overwrite newer champion state:
                // guard per row on the champions revision, and replay this
                // client's still-unacknowledged ops on top (design §4.3).
                // Per-row version guard + pending-ops replay lives in
                // mergePoolSnapshotRow (unit-tested); it unwraps the live
                // store row it is handed, so nothing proxied reaches reconcile.
                const mergedPools = (data.pools ?? []).map((incoming) => {
                    const { row, remaining } = mergePoolSnapshotRow(
                        incoming,
                        canvasPools.find((p) => p.id === incoming.id),
                        pendingPoolOps.get(incoming.id) ?? [],
                        // A canvasUpdate snapshot arriving mid-drag must not
                        // snap the actively-dragged card back to the
                        // position it had when the snapshot was built.
                        draggedPoolId() === incoming.id
                    );
                    pendingPoolOps.set(incoming.id, remaining);
                    return row;
                });
                setCanvasPools(reconcile(mergedPools, { key: "id" }));
                canvasContext.mutateCanvas((prev: CanvasResposnse | undefined) => {
                    if (!prev) return prev;
                    return {
                        ...prev,
                        name: data.canvas.name,
                        description: data.canvas.description ?? prev.description,
                        icon: data.canvas.icon ?? prev.icon,
                        cardLayout: data.canvas.cardLayout ?? prev.cardLayout,
                        drafts: data.drafts,
                        connections: data.connections,
                        groups: data.groups ?? prev.groups,
                        annotations: data.annotations ?? prev.annotations,
                        // The SAME merged array the store received, never the
                        // raw payload: the cache re-seeds the stores on a
                        // canvas switch-away-and-back, so a stale snapshot
                        // written here would resurface after the pending queue
                        // has been cleared.
                        pools: data.pools ? mergedPools : prev.pools
                    };
                });
            }
        );
        socket.on("draftNameUpdated", (data: DraftNameUpdatedData) => {
            setCanvasDrafts(
                (cd) => cd.Draft.id === data.draftId,
                "Draft",
                "name",
                data.name
            );
            canvasContext.mutateCanvas((prev: CanvasResposnse | undefined) => {
                if (!prev) return prev;
                return {
                    ...prev,
                    drafts: prev.drafts.map((draft) =>
                        draft.Draft.id === data.draftId
                            ? {
                                  ...draft,
                                  Draft: {
                                      ...draft.Draft,
                                      name: data.name
                                  }
                              }
                            : draft
                    )
                };
            });
        });
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
                // A live mid-drag frame from another client. Mark it in-flight
                // BEFORE the store write, so no row derivation this tick sees
                // the arbitrary y as a settled row.
                markRelayedDrag(data.draftId);
                setCanvasDrafts((cd) => cd.Draft.id === data.draftId, {
                    positionX: data.positionX,
                    positionY: data.positionY
                });
            }
        });
        socket.on("annotationMoved", (rawData: unknown) => {
            const data = validateSocketEvent(
                "annotationMoved",
                rawData,
                AnnotationMovedSchema
            );
            if (!data) return;
            if (draggedAnnotationId() !== data.annotationId) {
                // Mark in-flight BEFORE the store write, so no row derivation
                // this tick sees the arbitrary mid-gesture y as a settled row.
                markRelayedDrag(data.annotationId);
                setAnnotations((a) => a.id === data.annotationId, {
                    positionX: data.positionX,
                    positionY: data.positionY
                });
            }
        });
        socket.on("annotationResized", (rawData: unknown) => {
            const data = validateSocketEvent(
                "annotationResized",
                rawData,
                AnnotationResizedSchema
            );
            if (!data) return;
            // No `markRelayedDrag` and no `clearRelayedDrag`, unlike the two
            // relays either side of this one.
            //
            // ⚠️ The original reason was "a resize does not move the note", and
            // the bottom-LEFT grip made that false — it anchors the right edge,
            // so `positionX` travels with the width. The conclusion survives on
            // a NARROWER reason: it moves the note on the X AXIS ONLY, and the
            // row model buckets on `y + inset`, so no mid-gesture x can be
            // mistaken for a settled row. Marking it in-flight would still drop
            // it from the settled rows and change the size it paints at on THIS
            // client only. Nor is a live frame a commit, which is what
            // `groupResized` clears on.
            //
            // KNOWN AND ACCEPTED: an observer who is themselves dragging this
            // note now gets its x written under them by a resize frame. It
            // needed two users on one note and no edit lock — the same class of
            // conflict concurrent moves already have, and the edit lock is its
            // own slice.
            setAnnotations((a) => a.id === data.annotationId, {
                positionX: data.positionX,
                width: data.width,
                height: data.height
            });
        });
        socket.on("poolUpdate", (rawData: unknown) => {
            const data = validateSocketEvent("poolUpdate", rawData, PoolUpdateSchema);
            if (!data) return;
            // Version guard (design §4.3): post-commit emits can interleave — a
            // stale full payload must not roll champions back.
            const current = canvasPools.find((p) => p.id === data.placementId);
            if (!current || data.pool.version <= current.Pool.version) return;
            // Pending-ops replay (design §4.3): a foreign editor's full payload
            // can interleave BEFORE this client's optimistic op commits
            // server-side; the sender is excluded from its own broadcast, so
            // without the replay the optimistic op would be silently lost. Ops
            // are idempotent + commutative, so replaying unacked local ops over
            // any incoming map converges.
            const { pool, remaining } = mergePoolBroadcast(
                data.pool,
                pendingPoolOps.get(data.placementId) ?? []
            );
            pendingPoolOps.set(data.placementId, remaining);
            setCanvasPools((p) => p.id === data.placementId, "Pool", reconcile(pool));
        });
        socket.on("poolMoved", (rawData: unknown) => {
            const data = validateSocketEvent("poolMoved", rawData, PoolMovedSchema);
            if (!data) return;
            if (draggedPoolId() !== data.placementId) {
                setCanvasPools((p) => p.id === data.placementId, {
                    positionX: data.positionX,
                    positionY: data.positionY
                });
            }
        });
        socket.on(
            "canvasMutationError",
            (data: { event: string; code: string; message: string }) => {
                if (
                    data.event === "poolAddChampion" ||
                    data.event === "poolRemoveChampion" ||
                    data.event === "poolReplace"
                ) {
                    // The payload carries no placementId, so clear ALL pending
                    // queues — the refetch re-seeds authoritative state anyway.
                    // The sender is excluded from op broadcasts; without this a
                    // failed op leaves its optimistic state silently diverged.
                    pendingPoolOps.clear();
                    // POOLS-SCOPED recovery (design §4.3/§6.3): refetch, then
                    // reconcile ONLY canvasPools from the fresh result.
                    // Deliberately NOT setLoadedCanvasId(null) — that re-runs
                    // the whole seeding effect, resetting the viewport and
                    // closing open editors: acceptable for a rare reconnect,
                    // hostile for a foreground rejected op.
                    void Promise.resolve(canvasContext.refetchCanvas()).then((fresh) => {
                        const pools = fresh?.pools;
                        if (pools) setCanvasPools(reconcile(pools, { key: "id" }));
                    });
                    toast.error(`Pool edit failed: ${data.message}`);
                }
            }
        );
        socket.on("draftPositionsUpdated", (rawData: unknown) => {
            const data = validateSocketEvent(
                "draftPositionsUpdated",
                rawData,
                DraftPositionsUpdatedSchema
            );
            if (!data) return;
            for (const p of data.positions) {
                // The commit that ends the drag: this node is settled again.
                clearRelayedDrag(p.draft_id);
                // `draft_id` names the CanvasDraft row (the Card's placement),
                // not the Draft — the two hold the same value today but only
                // one of them is what the server sent.
                setCanvasDrafts((cd) => cd.draft_id === p.draft_id, {
                    positionX: p.positionX,
                    positionY: p.positionY,
                    ...(p.group_id !== undefined ? { group_id: p.group_id } : {})
                });
            }
            for (const entry of data.annotations) {
                // The commit that ends the drag: this node is settled again.
                clearRelayedDrag(entry.id);
                setAnnotations((a) => a.id === entry.id, {
                    positionX: entry.positionX,
                    positionY: entry.positionY,
                    ...(Object.prototype.hasOwnProperty.call(entry, "group_id")
                        ? { group_id: entry.group_id ?? null }
                        : {})
                });
            }
            const group = data.group;
            if (group) {
                // A container carried on a commit is settled by definition —
                // this is the write that ENDS a drag, not one during it.
                clearRelayedDrag(group.id);
                setCanvasGroups((g) => g.id === group.id, group);
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
                // A live mid-drag frame from another client — see relayedDrags.
                markRelayedDrag(data.groupId);
                // LIVE events only (A3 revised). `subtree` is set by
                // `relayGroupMove` and by nothing else: a commit broadcast is a
                // complete set of absolute row-setters, one per written row, and
                // fanning out on those would move an explicitly-listed child a
                // second time — the child's event is emitted BEFORE its parent's
                // for a multi-entry payload, so nothing would correct it.
                //
                // The guard is "the Group I am dragging", deliberately not
                // extended to descendants: a remote user's concurrent move of a
                // descendant is legitimate, and A8's per-frame increments
                // preserve it. The cost is a receiver actively dragging a child
                // seeing it jitter for one frame while a remote user drags the
                // parent.
                if (data.subtree) {
                    const stored = canvasGroups.find((g) => g.id === data.groupId);
                    if (stored) {
                        applyGroupPositionWrites(
                            subtreeMoveWrites(
                                canvasTree(),
                                data.groupId,
                                data.positionX - stored.positionX,
                                data.positionY - stored.positionY
                            )
                        );
                    }
                }
                setCanvasGroups((g) => g.id === data.groupId, {
                    positionX: data.positionX,
                    positionY: data.positionY,
                    // Key PRESENCE, never `=== undefined`: Zod's optional leaves
                    // the key present with value `undefined`, and this shallow
                    // merge would then clobber `parent_group_id` with undefined
                    // on every ordinary move. The server puts `parentId` on the
                    // payload only when parentage actually changed.
                    ...(Object.prototype.hasOwnProperty.call(data, "parentId")
                        ? { parent_group_id: data.parentId ?? null }
                        : {})
                });
            }
        });
        socket.on("groupResized", (rawData: unknown) => {
            const data = validateSocketEvent("groupResized", rawData, GroupResizedSchema);
            if (!data) return;
            // A resize broadcast is a commit, so whatever was in flight is not.
            clearRelayedDrag(data.groupId);
            const group = canvasGroups.find((g) => g.id === data.groupId);
            const draftPositionDelta =
                group?.type === "custom" && data.positionX !== undefined
                    ? data.positionX - group.positionX
                    : undefined;

            setCanvasGroups((g) => g.id === data.groupId, {
                ...(data.positionX === undefined ? {} : { positionX: data.positionX }),
                width: data.width,
                height: data.height
            });
            if (draftPositionDelta !== undefined && draftPositionDelta !== 0) {
                // CARDS ONLY, and that is correct under nesting — do not "fix"
                // this by widening it to child Groups. A Card's coordinates are
                // relative to its container, so a left-edge move has to rebase
                // them; a Group's are absolute world at every depth (ADR-0006),
                // so a child Group must NOT move when its parent's edge does.
                setCanvasDrafts(
                    (draft) => draft.group_id === data.groupId,
                    (draft) => ({
                        ...draft,
                        positionX: draft.positionX - draftPositionDelta
                    })
                );
            }
        });
        onCleanup(() => {
            socket.off("canvasUpdate");
            socket.off("draftNameUpdated");
            socket.off("draftUpdate");
            socket.off("canvasObjectMoved");
            socket.off("annotationMoved");
            socket.off("annotationResized");
            socket.off("poolUpdate");
            socket.off("poolMoved");
            socket.off("canvasMutationError");
            socket.off("draftPositionsUpdated");
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

    const addBox = (fromBox: CanvasDraft) => {
        if (!canEdit()) return;
        handleDraftCopy(fromBox);
    };

    const deleteBox = (draftId: string) => {
        if (!canEdit()) return;
        const draft = canvasDrafts.find((d) => d.Draft.id === draftId);
        if (draft) {
            setDraftToDelete(draft);
            setIsDeleteDialogOpen(true);
        }
    };

    const handlePickChange = (draftId: string, pickIndex: number, championId: string) => {
        if (!canEdit()) return;
        setCanvasDrafts(
            (cd) => cd.Draft.id === draftId,
            "Draft",
            (Draft) => {
                const holdPicks = [...Draft.picks];
                holdPicks[pickIndex] = championId;
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
                    holdPicks[pickIndex] = championId;
                    draft.Draft.picks = holdPicks;
                    saveLocalCanvas(local);
                }
            }
        }
    };

    const getRestrictedChampionsForDraft = (canvasDraft: CanvasDraft): string[] => {
        if (!canvasDraft.group_id) return [];

        const group = canvasGroups.find((g) => g.id === canvasDraft.group_id);
        if (!group) return [];

        const siblingDrafts = canvasDrafts
            .filter((cd) => cd.group_id === group.id)
            .map((cd) => ({
                id: cd.Draft.id,
                name: cd.Draft.name,
                picks: cd.Draft.picks,
                seriesIndex: cd.Draft.seriesIndex
            }));

        return getRestrictedChampionsForGroup({
            group,
            drafts: siblingDrafts,
            currentDraftId: canvasDraft.Draft.id
        });
    };

    // Slice 1 tile states: everything unavailable is uniformly grey — picked in
    // this draft, fearless-restricted from siblings, or group-disabled.
    const getUnavailableChampionIds = (draftId: string): Set<string> => {
        const ids = new Set<string>();
        const canvasDraft = canvasDrafts.find((cd) => cd.Draft.id === draftId);
        if (!canvasDraft) return ids;
        for (const pick of canvasDraft.Draft.picks) {
            if (pick !== "") ids.add(resolveChampionId(pick));
        }
        for (const restricted of getRestrictedChampionsForDraft(canvasDraft)) {
            ids.add(resolveChampionId(restricted));
        }
        const group = canvasGroups.find((g) => g.id === canvasDraft.group_id);
        for (const disabled of group?.metadata.disabledChampions ?? []) {
            ids.add(resolveChampionId(disabled));
        }
        return ids;
    };

    const handleNameChange = (draftId: string, newName: string) => {
        if (!canEdit()) return;
        const currentDraft = canvasDrafts.find((cd) => cd.Draft.id === draftId);
        if (!currentDraft) return;
        if (currentDraft.Draft.name === newName) return;
        // Optimistic, like every other canvas mutation. Rename was the only one
        // without it: the card's name input resyncs from the store the moment it
        // loses focus, so it snapped back to the old name and sat there until the
        // socket echo returned. Targeted leaf path, so the card keeps its store
        // proxy identity and <For> does not rebuild its DOM.
        setCanvasDrafts((cd) => cd.Draft.id === draftId, "Draft", "name", newName);
        if (isLocalMode()) {
            localEditDraft(draftId, { name: newName });
            refreshFromLocal();
            toast.success("Successfully edited draft!");
        } else {
            editDraftMutation.mutate({
                id: draftId,
                name: newName
            });
        }
    };

    const clearConnectionSelection = () => {
        setConnectionSource(null);
        setPreviewMousePos(null);
    };

    const onAnchorSelect = (ref: ConnectionEndpointRef, anchorType: AnchorType) => {
        if (!isConnectionMode() || !canEdit()) return;

        const selectedVertex = selectedVertexForConnection();
        const clicked = { ref, anchor: anchorType };

        // If a vertex is selected, add this endpoint as target
        if (selectedVertex) {
            if (isLocalMode()) {
                localUpdateConnection({
                    connectionId: selectedVertex.connectionId,
                    addTarget: endpointInputFor(ref, anchorType)
                });
                refreshFromLocal();
                toast.success("Connection updated!");
            } else {
                updateConnectionMutation.mutate({
                    canvasId: canvasId(),
                    connectionId: selectedVertex.connectionId,
                    addTarget: endpointInputFor(ref, anchorType)
                });
            }
            setSelectedVertexForConnection(null);
            return;
        }

        const action = resolveAnchorClick(connectionSource(), clicked);
        switch (action.kind) {
            case "select":
                setConnectionSource(action.selection);
                setPreviewMousePos(null);
                break;
            case "create":
                if (isLocalMode()) {
                    localCreateConnection({
                        sourceDraftIds: [
                            endpointInputFor(action.source.ref, action.source.anchor)
                        ],
                        targetDraftIds: [
                            endpointInputFor(action.target.ref, action.target.anchor)
                        ]
                    });
                    refreshFromLocal();
                    toast.success("Connection created!");
                } else {
                    createConnectionMutation.mutate({
                        canvasId: canvasId(),
                        sourceDraftIds: [
                            endpointInputFor(action.source.ref, action.source.anchor)
                        ],
                        targetDraftIds: [
                            endpointInputFor(action.target.ref, action.target.anchor)
                        ]
                    });
                }
                clearConnectionSelection();
                break;
            case "clear":
                clearConnectionSelection();
                break;
        }
    };

    const onAnchorClick = (draftId: string, anchorType: AnchorType) =>
        onAnchorSelect({ kind: "draft", id: draftId }, anchorType);

    const onGroupAnchorClick = (groupId: string, anchorType: AnchorType) =>
        onAnchorSelect({ kind: "group", id: groupId }, anchorType);

    const onAnnotationAnchorClick = (annotationId: string, anchorType: AnchorType) =>
        onAnchorSelect({ kind: "annotation", id: annotationId }, anchorType);

    const handleDeleteConnection = (connectionId: string) => {
        if (!canEdit()) return;
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
        if (!isConnectionMode() || !canEdit()) return;

        const source = connectionSource();

        if (source) {
            if (isLocalMode()) {
                localUpdateConnection({
                    connectionId,
                    addSource: endpointInputFor(source.ref, source.anchor)
                });
                refreshFromLocal();
                toast.success("Connection updated!");
            } else {
                updateConnectionMutation.mutate({
                    canvasId: canvasId(),
                    connectionId,
                    addSource: endpointInputFor(source.ref, source.anchor)
                });
            }
            clearConnectionSelection();
        }
    };

    const handleVertexClick = (connectionId: string, vertexId: string) => {
        if (!isConnectionMode() || !canEdit()) return;

        const source = connectionSource();

        if (source) {
            if (isLocalMode()) {
                localUpdateConnection({
                    connectionId,
                    addSource: endpointInputFor(source.ref, source.anchor)
                });
                refreshFromLocal();
                toast.success("Connection updated!");
            } else {
                updateConnectionMutation.mutate({
                    canvasId: canvasId(),
                    connectionId,
                    addSource: endpointInputFor(source.ref, source.anchor)
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

    // Broadcast this client's cursor in world coordinates, throttled with a
    // trailing send so the remote cursor lands on the final resting position.
    const cursorEmitter = createCursorThrottle((x, y) => {
        const socket = socketAccessor();
        if (!socket || connectionStatus() !== "connected") return;
        socket.emit("cursorMove", { canvasId: canvasId(), x, y });
    });

    createEffect(() => {
        // A trailing send queued on the previous canvas must not fire tagged
        // with the next canvas's id (navigation keeps this component mounted
        // and the emitter reads canvasId() at fire time).
        const id = canvasId();
        onCleanup(() => {
            cursorEmitter.cancel();
            // Leaving the canvas view while staying in the canvas room
            // (draft drilldown, canvas-to-canvas nav): tell receivers to
            // prune this cursor now instead of waiting out the idle fade.
            const socket = socketAccessor();
            if (id && socket && connectionStatus() === "connected") {
                socket.emit("cursorLeave", { canvasId: id });
            }
        });
    });

    // Laser pointer (slice 5): hold Tab to draw. The stroke is tagged with
    // the canvas where it STARTED (laserCanvasId, captured on activation) —
    // canvas-to-canvas navigation keeps this component mounted, and both the
    // trailing throttled point and the laserEnd must go to the stroke's own
    // canvas, not whichever one canvasId() resolves to at fire time.
    let laserCanvasId: string | null = null;

    const laserEmitter = createTrailingThrottle<{ x: number; y: number }>(({ x, y }) => {
        const socket = socketAccessor();
        if (!socket || connectionStatus() !== "connected" || !laserCanvasId) return;
        socket.emit("laserPoint", { canvasId: laserCanvasId, x, y });
    });

    // Tab only starts drawing when nothing interactive is focused, so
    // tabbing through inputs, dialogs and the sidebar keeps working. After
    // a plain canvas click document.activeElement is the body (the canvas
    // container is not focusable), which is exactly the idle state.
    const canStartLaser = () => {
        if (isLocalMode()) return false;
        const active = document.activeElement;
        return (
            !active ||
            active === document.body ||
            active === document.documentElement ||
            active === canvasContainerRef
        );
    };

    const laserKey = createLaserKeyTracker({
        canActivate: canStartLaser,
        onActivate: () => {
            laserCanvasId = canvasId();
        },
        onDeactivate: () => {
            // Cancel before ending: a queued trailing point must not append
            // to a stroke the receivers just closed.
            laserEmitter.cancel();
            const socket = socketAccessor();
            if (laserCanvasId && socket && connectionStatus() === "connected") {
                socket.emit("laserEnd", { canvasId: laserCanvasId });
            }
            laserCanvasId = null;
            laserTracker.endLocalStroke();
        }
    });

    onMount(() => {
        const onLaserKeyDown = (e: KeyboardEvent) => laserKey.handleKeyDown(e);
        const onLaserKeyUp = (e: KeyboardEvent) => laserKey.handleKeyUp(e);
        // Missed-keyup protection: alt-tab and tab-switch swallow the Tab
        // keyup, so window blur and visibility loss both end the hold.
        const onLaserBlur = () => laserKey.deactivate();
        const onLaserVisibility = () => {
            if (document.visibilityState === "hidden") laserKey.deactivate();
        };

        window.addEventListener("keydown", onLaserKeyDown);
        window.addEventListener("keyup", onLaserKeyUp);
        window.addEventListener("blur", onLaserBlur);
        document.addEventListener("visibilitychange", onLaserVisibility);
        onCleanup(() => {
            window.removeEventListener("keydown", onLaserKeyDown);
            window.removeEventListener("keyup", onLaserKeyUp);
            window.removeEventListener("blur", onLaserBlur);
            document.removeEventListener("visibilitychange", onLaserVisibility);
        });
    });

    // Leaving the canvas view (draft drilldown, canvas-to-canvas nav) ends
    // an in-flight stroke: deactivate() no-ops when idle, and otherwise
    // emits laserEnd to the stroke's own canvas via laserCanvasId. The
    // extra cancel is unconditional (mirroring the cursor emitter) so no
    // queued trailing send can outlive the navigation even if one is ever
    // queued outside an active hold.
    createEffect(() => {
        canvasId();
        onCleanup(() => {
            laserKey.deactivate();
            laserEmitter.cancel();
        });
    });

    const onCursorMouseMove = (e: MouseEvent) => {
        if (isLocalMode()) return;
        const world = screenToWorld(e.clientX, e.clientY);
        cursorEmitter.send(world.x, world.y);
        if (laserKey.active()) {
            // Local echo is unthrottled (the drawer sees a smooth line);
            // only the network emit coalesces through the throttle.
            laserTracker.addLocalPoint(world.x, world.y);
            laserEmitter.send({ x: world.x, y: world.y });
        }
    };

    // See the `<For>` that consumes this for why it is cheap during a drag.
    const groupsInPaintOrder = createMemo(() => renderOrder(canvasTree()));

    // Deepest-first by PAINT ORDER (3.1b; `canvasHitTest.findDropContainer`).
    // All three callers — card hover, card drop, context-menu Create — change
    // behaviour once containers can nest, and that is the point: they resolve
    // the container the user can actually see under the cursor.
    const findGroupAtPosition = (x: number, y: number): CanvasGroup | null =>
        findDropContainer(canvasTree(), { x, y }, { paintOrder: groupsInPaintOrder() });

    const getCardCenterPoint = (worldX: number, worldY: number) => {
        const cw = cardWidth(props.cardLayout());
        const ch = cardHeight(props.cardLayout());
        return {
            x: worldX + cw / 2,
            y: worldY + ch / 2
        };
    };

    /**
     * An annotation's own centre. `getCardCenterPoint` is hardcoded to
     * cardWidth/cardHeight and is wrong for a 56x40 bare-icon note by up to
     * 350x216px — enough to resolve a container the note is not in.
     */
    const annotationCenterPoint = (
        worldX: number,
        worldY: number,
        annotation: CanvasAnnotation,
        frozenSize: AnnotationRenderSize | null
    ) => ({
        x: worldX + (frozenSize?.width ?? annotation.width) / 2,
        y: worldY + (frozenSize?.height ?? annotation.height) / 2
    });

    const isInteractiveCardTarget = (target: EventTarget | null) => {
        return (
            target instanceof HTMLElement &&
            !!target.closest(
                '[data-canvas-slot-root="true"], input, button, select, textarea, [contenteditable="true"]'
            )
        );
    };

    const onBoxMouseDown = (draftId: string, e: MouseEvent) => {
        if (e.button !== 0) return;
        canvasContext.closeSharePopper();
        if (isConnectionMode()) return;
        if (!canEdit()) return;

        if (isInteractiveCardTarget(e.target)) {
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
                dragOriginX: cd.positionX,
                dragOriginY: cd.positionY,
                isPanning: false,
                panStartX: 0,
                panStartY: 0,
                viewportStartX: 0,
                viewportStartY: 0
            });
        }
    };

    const onAnnotationMouseDown = (e: MouseEvent, annotation: CanvasAnnotation) => {
        if (e.button !== 0) return;
        canvasContext.closeSharePopper();
        if (isConnectionMode() || !canEdit()) return;
        if (isInteractiveCardTarget(e.target)) return;
        e.preventDefault();
        e.stopPropagation();
        setSelectedAnnotationId(annotation.id);
        const worldCoords = screenToWorld(e.clientX, e.clientY);
        const group = annotation.group_id
            ? canvasGroups.find((entry) => entry.id === annotation.group_id)
            : undefined;
        const worldX = group
            ? group.positionX + annotation.positionX
            : annotation.positionX;
        const worldY = group
            ? group.positionY + annotation.positionY
            : annotation.positionY;
        const frozenSize =
            group && isGridGroup(group)
                ? snappedAnnotationSizeFor(group, annotation)
                : null;
        setAnnotationDragState({
            activeAnnotationId: annotation.id,
            offsetX: worldCoords.x - worldX,
            offsetY: worldCoords.y - worldY,
            dragGroupId: group?.id ?? null,
            originX: annotation.positionX,
            originY: annotation.positionY,
            frozenSize
        });
    };

    // Gate mirrors onAnnotationMouseDown's (~3695) — pool selection is
    // pool-local like annotation selection (design §6.3). Pools carry no
    // `group_id`, so the grab offset is plain world-space math (no
    // group-relative conversion to fold in) — see `poolGrabOffset`.
    const onPoolMouseDown = (e: MouseEvent, placement: CanvasPoolPlacement) => {
        if (e.button !== 0) return;
        canvasContext.closeSharePopper();
        if (isConnectionMode() || !canEdit()) return;
        if (isInteractiveCardTarget(e.target)) return;
        e.preventDefault();
        e.stopPropagation();
        setSelectedPoolId(placement.id);
        const worldCoords = screenToWorld(e.clientX, e.clientY);
        const { offsetX, offsetY } = poolGrabOffset(
            placement,
            worldCoords.x,
            worldCoords.y
        );
        setPoolDragState({ activePoolId: placement.id, offsetX, offsetY });
    };

    const onBackgroundMouseDown = (e: MouseEvent) => {
        if (e.button !== 0) return;
        canvasContext.closeSharePopper();
        setSelectedAnnotationId(null);
        setEditingAnnotationId(null);
        setSelectedPoolId(null);

        if (isConnectionMode()) {
            clearConnectionSelection();
        }

        const target = e.target instanceof HTMLElement ? e.target : null;
        if (
            target &&
            (target === canvasContainerRef || canvasContainerRef?.contains(target))
        ) {
            const vp = props.viewport();
            setDragState({
                activeBoxId: null,
                offsetX: 0,
                offsetY: 0,
                dragGroupId: null,
                dragOriginX: 0,
                dragOriginY: 0,
                isPanning: true,
                panStartX: e.clientX,
                panStartY: e.clientY,
                viewportStartX: vp.x,
                viewportStartY: vp.y
            });
        }
    };

    // Viewport persistence. The old `debounce` helper here was a LEADING-edge
    // throttle that drops every call inside its window, so a pan persisted the
    // viewport it STARTED at and discarded where the user actually released.
    // createTrailingThrottle is leading + trailing, so the resting viewport
    // always lands. Discrete events (zoom buttons, pan end) persist directly.
    const persistViewportNow = (viewport: Viewport) => {
        if (isLocalMode()) {
            localUpdateViewport(viewport);
        } else {
            updateViewportMutation.mutate({ canvasId: canvasId(), viewport });
        }
    };

    const viewportSaver = createTrailingThrottle<Viewport>(persistViewportNow, 1000);

    onCleanup(() => viewportSaver.cancel());

    // Viewport broadcast (presence slice 4): announce this client's viewport
    // on the presence channel, throttled with a trailing send so receivers
    // land on the final resting viewport.
    const viewportEmitter = createTrailingThrottle<Viewport>((viewport) => {
        const socket = socketAccessor();
        if (!socket || connectionStatus() !== "connected") return;
        socket.emit("viewportMove", { canvasId: canvasId(), ...viewport });
    });

    // Emit on every viewport change (pan, zoom, jump) while the canvas view
    // is live. untrack keeps the effect keyed on the viewport alone — the
    // emitter reads socket/connection/canvasId at fire time.
    createEffect(() => {
        if (isLocalMode()) return;
        const viewport = props.viewport();
        untrack(() => viewportEmitter.send(viewport));
    });

    // The emit above can race the async joinCanvas ACL check server-side
    // (room membership silently rejects it), leaving our last-known viewport
    // null for everyone until we next pan. The presence snapshot is sent
    // only after room entry is confirmed, so re-announce on receiving it —
    // that covers mount, reconnect and canvas-to-canvas navigation.
    createEffect(() => {
        if (isLocalMode()) return;
        const socket = socketAccessor();
        const id = canvasId();
        if (!socket || !id) return;

        const onSnapshot = (rawData: unknown) => {
            const result = presenceSnapshotSchema.safeParse(rawData);
            if (!result.success || result.data.canvasId !== id) return;
            viewportEmitter.send(props.viewport());
        };

        socket.on("presenceSnapshot", onSnapshot);
        onCleanup(() => {
            socket.off("presenceSnapshot", onSnapshot);
        });
    });

    // One-shot jump to another user's last-known viewport: a short eased
    // pan+zoom animation. Real user input (pointerdown/wheel) interrupts it
    // mid-flight — the user always wins the viewport.
    let viewportJumpFrame: number | null = null;
    let removeViewportJumpInterrupts: (() => void) | null = null;

    const stopViewportJump = () => {
        if (viewportJumpFrame !== null) {
            cancelAnimationFrame(viewportJumpFrame);
            viewportJumpFrame = null;
        }
        removeViewportJumpInterrupts?.();
        removeViewportJumpInterrupts = null;
    };

    const VIEWPORT_JUMP_MS = 450;

    const jumpToViewport = (target: Viewport) => {
        stopViewportJump();
        const from = props.viewport();
        const start = performance.now();
        const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3);

        const step = (now: number) => {
            const t = Math.min((now - start) / VIEWPORT_JUMP_MS, 1);
            const eased = easeOutCubic(t);
            props.setViewport({
                x: from.x + (target.x - from.x) * eased,
                y: from.y + (target.y - from.y) * eased,
                zoom: from.zoom + (target.zoom - from.zoom) * eased
            });
            if (t < 1) {
                viewportJumpFrame = requestAnimationFrame(step);
            } else {
                stopViewportJump();
                // Persist directly rather than through the throttle: a jump
                // right after a pan must still save, and a completed jump is
                // a single discrete event, so there is nothing to throttle.
                persistViewportNow(target);
            }
        };

        const interrupt = () => stopViewportJump();
        window.addEventListener("pointerdown", interrupt, { capture: true });
        window.addEventListener("wheel", interrupt, { capture: true, passive: true });
        removeViewportJumpInterrupts = () => {
            window.removeEventListener("pointerdown", interrupt, { capture: true });
            window.removeEventListener("wheel", interrupt, { capture: true });
        };
        viewportJumpFrame = requestAnimationFrame(step);
    };

    onCleanup(stopViewportJump);

    createEffect(() => {
        canvasContext.setJumpToViewportCallback(() => jumpToViewport);
        onCleanup(() => {
            canvasContext.setJumpToViewportCallback(null);
        });
    });

    // Keyed cleanup mirroring the cursor emitter: a trailing send queued on
    // the previous canvas must not fire tagged with the next canvas's id,
    // and leaving the canvas view (draft drilldown, canvas-to-canvas nav)
    // clears our last-known viewport server-side so remote popovers stop
    // offering a dead jump target.
    createEffect(() => {
        const id = canvasId();
        onCleanup(() => {
            stopViewportJump();
            viewportEmitter.cancel();
            const socket = socketAccessor();
            if (id && socket && connectionStatus() === "connected") {
                socket.emit("viewportLeave", { canvasId: id });
            }
        });
    });

    const onVertexDragStart = (
        connectionId: string,
        vertexId: string,
        positionX: number,
        positionY: number,
        e: MouseEvent
    ) => {
        if (e.button !== 0) return;
        e.stopPropagation();
        if (!canEdit()) return;
        const worldCoords = screenToWorld(e.clientX, e.clientY);
        setVertexDragState({
            connectionId,
            vertexId,
            offsetX: worldCoords.x - positionX,
            offsetY: worldCoords.y - positionY
        });
    };

    const handleCreateVertex = (connectionId: string, x: number, y: number) => {
        if (!canEdit()) return;
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

    const onGroupMouseDown = (groupId: string, e: MouseEvent) => {
        if (e.button !== 0) return;
        canvasContext.closeSharePopper();
        if (isConnectionMode()) return;
        if (!canEdit()) return;

        const target = e.target as HTMLElement;
        if (target.closest("button")) return;

        e.preventDefault();
        const group = canvasGroups.find((g) => g.id === groupId);
        if (group) {
            const worldCoords = screenToWorld(e.clientX, e.clientY);
            setGroupDragState({
                activeGroupId: groupId,
                offsetX: worldCoords.x - group.positionX,
                offsetY: worldCoords.y - group.positionY,
                originX: group.positionX,
                originY: group.positionY
            });
        }
    };

    const handleEditDisabledChampions = (groupId: string) => {
        if (!canEdit()) return;
        setDisabledChampionsGroupId(groupId);
    };

    const handleSaveGroupSettings = (data: {
        name: string;
        disabledChampions: string[];
        draftMode: DraftMode;
        convertToSeries: boolean;
        blueTeamName: string;
        redTeamName: string;
        team1_id: string | null;
        team2_id: string | null;
        length: number;
        gameType: GameType | null;
        grid: GridSettingsInput | null;
    }) => {
        // A classification set while CREATING a group is otherwise dropped, so
        // all eight write paths below carry it. `null` clears (D3); on the
        // conversion routes only a real value is sent, since there is nothing
        // stored yet to clear.
        const pendingPosition = pendingGroupSettingsPosition();
        if (pendingPosition) {
            const groupName = data.name || "Custom Series";
            // The whole of what a new Group is born as, resolved in one pure
            // place (§10). The CUSTOM branch writes it on the create itself, so
            // the Group is never briefly `free`; the SERIES branch leaves it to
            // `convertGroupToSeries`, which owns a series' metadata.
            const newMetadata = resolveNewGroupMetadata({
                isSeries: data.convertToSeries,
                disabledChampions: data.disabledChampions,
                draftMode: data.draftMode,
                gameType: data.gameType,
                // NOT defaulted: `null` is the dialog's "Grid layout off", and
                // defaulting it here made the toggle inert — every new custom
                // group was born a grid.
                grid: data.grid
            });
            // A grid container is born at the size its configured rows and
            // columns need, rather than at a flat 400x200 it only grows out of
            // on the first drop. `null` for a series and for free layout, whose
            // sizes the server's defaults already describe.
            const newDims = newGroupDimensions({
                isSeries: data.convertToSeries,
                grid: data.grid,
                layout: props.cardLayout()
            });
            if (isLocalMode()) {
                // The local mutations enforce parentage and the series-leaf
                // invariant themselves — there is no server here to do it — and
                // report a rejection by throwing the server's own wording. The
                // container was resolved when the menu opened, so the tree can
                // have changed since.
                let result;
                try {
                    result = localCreateGroup({
                        positionX: pendingPosition.x,
                        positionY: pendingPosition.y,
                        parentId: pendingPosition.parentId,
                        name: groupName,
                        // A series' metadata is written by the conversion
                        // below, which owns it; a custom Group is born with
                        // everything the dialog decided.
                        ...(data.convertToSeries ? {} : { metadata: newMetadata }),
                        ...(newDims
                            ? { width: newDims.width, height: newDims.height }
                            : {})
                    });
                } catch (error) {
                    toast.error(
                        error instanceof Error ? error.message : "Failed to create group"
                    );
                    setPendingGroupSettingsPosition(null);
                    return;
                }
                if (data.convertToSeries) {
                    localConvertGroupToSeries({
                        groupId: result.group.id,
                        name: groupName,
                        blueTeamName: data.blueTeamName,
                        redTeamName: data.redTeamName,
                        length: data.length,
                        draftMode: data.draftMode,
                        disabledChampions: data.disabledChampions,
                        gameType: data.gameType
                    });
                }
                refreshFromLocal();
                toast.success(data.convertToSeries ? "Series created" : "Group created");
            } else {
                createCanvasGroup({
                    canvasId: canvasId(),
                    name: groupName,
                    positionX: pendingPosition.x,
                    positionY: pendingPosition.y,
                    parentId: pendingPosition.parentId,
                    // See the local branch: the create carries the metadata, so
                    // a custom Group is never briefly `free` and a failed
                    // follow-up can no longer leave one that way.
                    ...(data.convertToSeries ? {} : { metadata: newMetadata }),
                    ...(newDims ? { width: newDims.width, height: newDims.height } : {})
                })
                    .then((result) => {
                        if (!data.convertToSeries) return result;
                        return convertGroupToSeries({
                            canvasId: canvasId(),
                            groupId: result.group.id,
                            name: groupName,
                            blueTeamName: data.blueTeamName,
                            redTeamName: data.redTeamName,
                            length: data.length,
                            type: data.draftMode,
                            disabledChampions: data.disabledChampions,
                            team1_id: data.team1_id,
                            team2_id: data.team2_id,
                            ...(data.gameType !== null ? { gameType: data.gameType } : {})
                        });
                    })
                    .then((result) => {
                        upsertCanvasGroup(result.group);
                        upsertCanvasDrafts(result.group.CanvasDrafts ?? []);
                        toast.success(
                            data.convertToSeries ? "Series created" : "Group created"
                        );
                    })
                    .catch((error: Error) => {
                        toast.error(`Failed to create group: ${error.message}`);
                    });
            }
            setPendingGroupSettingsPosition(null);
            return;
        }

        const groupId = disabledChampionsGroupId();
        if (!groupId) return;

        // The series-leaf invariant is enforced on TYPE writes as well as on
        // parentage writes (plan A13). The server and the local mutation both
        // refuse this; the client check exists so the user reads the reason
        // instead of a "Failed to..." wrapper, and so the dialog stays open.
        if (data.convertToSeries && childGroupsOf(canvasTree(), groupId).length > 0) {
            toast.error("Can't convert a group that contains groups");
            return;
        }

        const editing = canvasGroups.find((g) => g.id === groupId);
        const staysSeries = data.convertToSeries || editing?.type === "series";
        // Layout belongs to CUSTOM groups. A series' interior is computed from
        // its length (§5.1), so the dialog does not offer it one.
        const layoutChange =
            !staysSeries && editing ? resolveLayoutChange(editing, data.grid) : null;
        const layoutDims =
            editing && layoutChange && !layoutChange.reflow && data.grid
                ? gridDimsFor(editing, {
                      layout: "grid",
                      gridCols: data.grid.gridCols,
                      gridRows: data.grid.gridRows,
                      rowLabels: data.grid.rowLabels,
                      colLabels: data.grid.colLabels
                  })
                : null;
        /**
         * Draft mode is a SERIES setting. It does function on a custom group —
         * `draftRestrictions` runs those symmetrically and the backend gate
         * reads the same key — so saving a custom group CLEARS any stored mode
         * rather than leaving one the dialog no longer shows and the user can
         * no longer reach. `null` is the D3 clear protocol; `undefined` would
         * just drop out of the request.
         */
        const editedMetadata: CanvasGroupMetadataUpdate = {
            disabledChampions: data.disabledChampions,
            gameType: data.gameType,
            draftMode: staysSeries ? data.draftMode : null,
            // The counts and the manual floor are two views of one thing: a
            // resize writes the counts, and a count change re-writes the floor.
            // Without this half, a container that had ever been resized could
            // never be made SMALLER from the dialog — the stale floor won.
            ...(layoutDims
                ? { manualWidth: layoutDims.width, manualHeight: layoutDims.height }
                : {}),
            ...(layoutChange && !layoutChange.reflow ? layoutChange.metadata : {})
        };

        if (isLocalMode()) {
            const group = editing;
            if (group) {
                if (staysSeries) {
                    localConvertGroupToSeries({
                        groupId,
                        name: data.name || group.name,
                        blueTeamName: data.blueTeamName,
                        redTeamName: data.redTeamName,
                        length: data.length,
                        draftMode: data.draftMode,
                        disabledChampions: data.disabledChampions,
                        gameType: data.gameType
                    });
                } else {
                    localUpdateGroup({
                        groupId,
                        name: data.name || undefined,
                        metadata: editedMetadata,
                        ...(layoutDims
                            ? { width: layoutDims.width, height: layoutDims.height }
                            : {})
                    });
                }
                refreshFromLocal();
                if (layoutChange?.reflow) {
                    const fresh = canvasGroups.find((g) => g.id === groupId);
                    if (fresh) arrangeGroupAsGrid(fresh, layoutChange.metadata);
                }
                // Local needs no writer election: localConvertGroupToSeries
                // pushes the new Cards synchronously and refreshFromLocal has
                // just landed them, so the count is already current. It never
                // reaches updateGroupMutation, which is where the server path
                // wires the same call.
                if (data.convertToSeries || group.type === "series") {
                    reflowAfterSeriesGrowth(groupId);
                }
            }
        } else if (data.convertToSeries) {
            convertGroupToSeriesMutation.mutate({
                canvasId: canvasId(),
                groupId,
                name: data.name || "Custom Series",
                blueTeamName: data.blueTeamName,
                redTeamName: data.redTeamName,
                length: data.length,
                type: data.draftMode,
                disabledChampions: data.disabledChampions,
                team1_id: data.team1_id,
                team2_id: data.team2_id,
                ...(data.gameType !== null ? { gameType: data.gameType } : {})
            });
        } else {
            const isManualSeries =
                editing?.type === "series" && editing.metadata.origin === "manual";
            updateGroupMutation.mutate({
                canvasId: canvasId(),
                groupId,
                name: data.name || undefined,
                metadata: {
                    ...editedMetadata,
                    ...(isManualSeries
                        ? {
                              blueTeamName: data.blueTeamName,
                              redTeamName: data.redTeamName,
                              length: data.length,
                              seriesType: data.draftMode
                          }
                        : {})
                },
                ...(layoutDims
                    ? { width: layoutDims.width, height: layoutDims.height }
                    : {}),
                // Team linking persists on manual series groups only.
                ...(isManualSeries
                    ? { team1_id: data.team1_id, team2_id: data.team2_id }
                    : {})
            });
            // The one layout change that cannot ride along: re-arranging
            // members writes POSITIONS, which only the draft-positions route
            // carries. `editing` is the pre-save row, which is what
            // `arrangeGroupAsGrid` wants — it re-derives everything else.
            if (editing && layoutChange?.reflow) {
                arrangeGroupAsGrid(editing, layoutChange.metadata);
            }
        }
    };

    const handleDeleteGroup = (groupId: string) => {
        if (!canEdit()) return;
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

    /**
     * Which container a Group created at `point` belongs to, or null.
     *
     * Returns `undefined` when the resolved container would refuse it — the
     * caller has already been told why — so a rejected create is distinguishable
     * from a legal top-level one.
     */
    const resolveCreateParent = (point: {
        x: number;
        y: number;
    }): string | null | undefined => {
        const container = findGroupAtPosition(point.x, point.y);
        if (!container) return null;
        const rejection = parentageRejection(canvasTree(), "__new__", container.id);
        if (rejection) {
            toast.error(rejection);
            return undefined;
        }
        return container.id;
    };

    /**
     * BOTH creation paths — the toolbar button and the canvas context menu —
     * defer the create and open the merged settings dialog (§10, confirmed
     * 2026-08-10; this REVERSED the design's earlier lean to keep the toolbar
     * as a no-dialog fast path). One creation flow, so a new Group is never a
     * surprise about what it turned out to be.
     */
    const handleCreateGroup = () => {
        const pos = createGroupPosition();
        const parentId = resolveCreateParent(pos);
        if (parentId === undefined) return;
        setPendingGroupSettingsPosition({ x: pos.x, y: pos.y, parentId });
    };

    /**
     * Commit a container drag.
     *
     * ONE entry on the wire, whatever the subtree's size: the server derives
     * `dx` from the locked stored row and fans it out over descendants itself
     * (design 3.1c). The client has already written the same subtree
     * optimistically, per frame.
     *
     * The rollback delta comes from the drag ORIGIN captured at mousedown, not
     * from a snapshot taken in `onMutate` — see `groupDragState` (A1).
     */
    const commitGroupDrag = (gState: {
        activeGroupId: string | null;
        originX: number;
        originY: number;
    }) => {
        const groupId = gState.activeGroupId;
        if (!groupId) return;
        const group = canvasGroups.find((g) => g.id === groupId);
        if (!group) return;

        // A click is not a drop. Without this, mousedown+mouseup on a top-level
        // Group whose corner happens to overlap a container would adopt it.
        const moved =
            group.positionX !== gState.originX || group.positionY !== gState.originY;
        // The SAME resolver the hover preview ran, on the same point.
        const resolution: GroupDropResolution = moved
            ? resolveGroupDrop(canvasTree(), {
                  groupId,
                  point: { x: group.positionX, y: group.positionY }
              })
            : { nextParentId: group.parent_group_id ?? null };
        if (resolution.rejection) toast.error(resolution.rejection);
        const currentParentId = group.parent_group_id ?? null;
        // Key PRESENCE is the protocol: an absent `parentId` leaves parentage
        // alone, `null` moves to top level. A rejected drop commits the
        // position only, so the Group stays where the user let go rather than
        // snapping back with no explanation.
        const parentageChanged =
            !resolution.rejection && resolution.nextParentId !== currentParentId;
        const entry = {
            id: groupId,
            positionX: group.positionX,
            positionY: group.positionY,
            ...(parentageChanged ? { parentId: resolution.nextParentId } : {})
        };
        // Every container whose contents this drag changed — the one it left
        // and the one it landed in, including the SAME container on a plain
        // reposition. The Card path has always refitted all of these; the Group
        // path refitted only a newly-gained parent, so a series moved further
        // up inside its free parent never shrank it.
        const resyncTargets = groupDragResyncTargets({
            previousParentId: currentParentId,
            nextParentId: resolution.nextParentId ?? null,
            rejected: Boolean(resolution.rejection)
        });

        // A GRID container lays its children out; it does not accept them
        // wherever they were released. Route the drop — including a same-parent
        // reposition — through the same resolver Cards use, with the dragged
        // Group's real footprint. Without this the Group never snaps and no
        // rectangular preview ever appears, however rectangular the overlay is
        // (round 2, V5).
        const nextParent = resolution.nextParentId
            ? canvasGroups.find((g) => g.id === resolution.nextParentId)
            : undefined;
        if (!resolution.rejection && nextParent && isGridGroup(nextParent)) {
            // Container-relative BEFORE the resolver, both of them: a Group's
            // stored origin is absolute world at every depth (ADR-0006), and
            // the swap/relocation math runs on these numbers.
            commitGridDrop({
                group: nextParent,
                dragged: draggedGroupGeometry(groupId, group, props.cardLayout()),
                relX: group.positionX - nextParent.positionX,
                relY: group.positionY - nextParent.positionY,
                origin: parentageChanged
                    ? null
                    : {
                          x: gState.originX - nextParent.positionX,
                          y: gState.originY - nextParent.positionY
                      },
                joinsContainer: parentageChanged
            });
            // `commitGridDrop` sizes the destination itself from the layout it
            // just materialized, so only the container the Group LEFT is still
            // owed a refit — which it never got before.
            for (const id of resyncTargets) {
                if (id !== nextParent.id) resyncGroupSize(id);
            }
            return;
        }

        if (parentageChanged) {
            setCanvasGroups((g) => g.id === groupId, {
                parent_group_id: resolution.nextParentId ?? null
            });
        }
        // AFTER the parentage write above, so a container losing this Group is
        // measured over a membership that no longer includes it. §9.1a's locked
        // rule survives: it forbids growing MID-DRAG to chase a leaving child,
        // and every call here runs once the drag has committed.
        for (const id of resyncTargets) resyncGroupSize(id);

        if (isLocalMode()) {
            // Local has nothing to fan the delta out for it and the live drag
            // only touched the in-memory store, so it gets every row — with the
            // parentage change riding on the dragged Group's own row.
            const rows = subtreeRows(canvasTree(), groupId).map((row) =>
                row.id === groupId ? { ...row, ...entry } : row
            );
            localUpdateDraftPositions({ positions: [], groups: rows });
            refreshFromLocal();
            return;
        }
        updateGroupSubtreeMutation.mutate({
            canvasId: canvasId(),
            positions: [],
            groups: [entry],
            rollback: {
                groupId,
                dx: group.positionX - gState.originX,
                dy: group.positionY - gState.originY
            }
        });
    };

    /**
     * The un-nest action (design decision 9). Reparenting writes NO coordinates
     * — a Group's stored position is absolute world at every depth (ADR-0006),
     * so a Group that leaves its parent stays exactly where it is on screen.
     */
    const handleMoveGroupToTopLevel = (groupId: string) => {
        if (!canEdit()) return;
        const group = canvasGroups.find((g) => g.id === groupId);
        if (!group || !group.parent_group_id) return;
        const entry = {
            id: groupId,
            positionX: group.positionX,
            positionY: group.positionY,
            parentId: null
        };
        setCanvasGroups((g) => g.id === groupId, { parent_group_id: null });
        if (isLocalMode()) {
            localUpdateDraftPositions({ positions: [], groups: [entry] });
            refreshFromLocal();
        } else {
            updateDraftPositionsMutation.mutate({
                canvasId: canvasId(),
                positions: [],
                groups: [entry]
            });
        }
    };

    const closeGroupSettingsDialog = () => {
        setDisabledChampionsGroupId(null);
        setPendingGroupSettingsPosition(null);
    };

    const handleUpdateDraftMetadata = (
        draftId: string,
        metadata: {
            winner?: "blue" | "red" | null;
            blueSideTeam?: 1 | 2;
            firstPick?: "blue" | "red";
            team1Name?: string;
            team2Name?: string;
        }
    ) => {
        if (!canEdit()) return;

        const { team1Name, team2Name, ...draftMetadata } = metadata;
        const matches = (cd: CanvasDraft) => cd.Draft.id === draftId;

        if (Object.keys(draftMetadata).length > 0) {
            setCanvasDrafts(matches, "Draft", (draft) => ({
                ...draft,
                ...draftMetadata,
                ...(draftMetadata.winner !== undefined
                    ? { completed: draftMetadata.winner !== null }
                    : {})
            }));
        }

        // Empty string means inherit — mirror the server's normalisation.
        if (team1Name !== undefined) {
            setCanvasDrafts(matches, "team1Name", team1Name.trim() || null);
        }
        if (team2Name !== undefined) {
            setCanvasDrafts(matches, "team2Name", team2Name.trim() || null);
        }

        if (isLocalMode()) {
            localUpdateDraftMetadata({ draftId, ...metadata });
            refreshFromLocal();
        } else {
            updateCanvasDraft({
                canvasId: canvasId(),
                draftId,
                ...metadata
            }).catch((error: Error) => {
                toast.error(`Failed to update game metadata: ${error.message}`);
                canvasContext.refetchCanvas();
            });
        }
    };

    const handleRenameGroup = (groupId: string, newName: string) => {
        if (!canEdit()) return;
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

    const handleResizeGroup = (
        groupId: string,
        width: number,
        height: number,
        positionX?: number,
        leftEdgeDelta?: number
    ) => {
        if (!canEdit()) return;
        const group = canvasGroups.find((g) => g.id === groupId);
        const draftPositionDelta =
            group?.type === "custom" &&
            positionX !== undefined &&
            leftEdgeDelta !== undefined
                ? positionX - group.positionX
                : undefined;

        setCanvasGroups((g) => g.id === groupId, {
            width,
            height,
            ...(positionX === undefined ? {} : { positionX })
        });
        if (draftPositionDelta !== undefined && draftPositionDelta !== 0) {
            setCanvasDrafts(
                (draft) => draft.group_id === groupId,
                (draft) => ({
                    ...draft,
                    positionX: draft.positionX - draftPositionDelta
                })
            );
        }
        if (positionX !== undefined && group && leftEdgeDelta === undefined) {
            debouncedEmitGroupMove(groupId, positionX, group.positionY);
        }
        debouncedEmitGroupResize(groupId, width, height, positionX);
    };

    const handleResizeEnd = (
        groupId: string,
        width: number,
        height: number,
        positionX?: number,
        leftEdgeDelta?: number
    ) => {
        if (!canEdit()) return;
        const group = canvasGroups.find((g) => g.id === groupId);
        const shouldPersistDraftPositions =
            group?.type === "custom" &&
            positionX !== undefined &&
            leftEdgeDelta !== undefined &&
            leftEdgeDelta !== 0;
        const groupedDrafts = shouldPersistDraftPositions
            ? canvasDrafts.filter((draft) => draft.group_id === groupId)
            : [];

        // The ONLY writer of the manual floor (5a-0). Every other sizing path
        // derives `width`/`height` as max(floor, content), so if any of them
        // also wrote the floor, an auto-grow would be indistinguishable from a
        // deliberate resize and the ratchet would come straight back.
        //
        // On a GRID it also writes the counts that size describes (2026-08-11).
        // The floor alone left `gridCols`/`gridRows` free to disagree with the
        // width the user dragged, and since every derivation computes width from
        // `gridCols` while never reading the current width, the next one
        // reconciled it — a row-count edit moved the frame sideways. The counts
        // are floored, so the size they imply never exceeds the dragged size and
        // the floor above still wins.
        const metadata = {
            manualWidth: width,
            manualHeight: height,
            ...(group && isGridGroup(group)
                ? resolveResizeGridSettings({
                      width,
                      height,
                      rows: gridRowsFor(group),
                      layout: props.cardLayout()
                  })
                : {})
        };
        setCanvasGroups(
            (g) => g.id === groupId,
            (g) => ({
                ...g,
                metadata: { ...g.metadata, ...metadata }
            })
        );

        if (isLocalMode()) {
            localUpdateGroup({ groupId, width, height, positionX, metadata });
            for (const draft of groupedDrafts) {
                localUpdateDraftPosition({
                    draftId: draft.Draft.id,
                    positionX: draft.positionX,
                    positionY: draft.positionY
                });
            }
            refreshFromLocal();
        } else {
            updateGroupMutation.mutate({
                canvasId: canvasId(),
                groupId,
                positionX,
                width,
                height,
                metadata
            });
            for (const draft of groupedDrafts) {
                updateDraftGroupMutation.mutate({
                    canvasId: canvasId(),
                    draftId: draft.Draft.id,
                    positionX: draft.positionX,
                    positionY: draft.positionY
                });
            }
        }
    };

    /**
     * Content bounds for every container on the canvas, in ONE pass (plan A10).
     *
     * The obvious shape — a `createMemo` per Group inside the `<For>` — does not
     * help: each one reads the whole `canvasDrafts` array, so every Group's memo
     * invalidates on every Card write. This is O(cards + annotations + groups) per
     * invalidation instead of O(groups × cards) per render.
     *
     * Unlike the paint-order memo, this one reads POSITIONS and therefore does
     * re-run on every drag frame. That is part of the drag cost, not exempt from
     * it (A10, round 1) — count it in 5a-2's perf gate.
     */
    const contentBounds = createMemo(() => {
        const layout = props.cardLayout();
        const cw = cardWidth(layout);
        const ch = cardHeight(layout);
        // Annotations are container CONTENTS and must resist the resize the
        // same way Cards do. Without this a note in a free Group could be
        // shrunk out of view with nothing pushing back — and on a
        // champion-pool Group (zero Cards, all notes) the container's content
        // floor would be zero, so the frame could collapse over every note in
        // it (design §3, D13).
        //
        // STORED width/height, per D5: the layout engine never derives them.
        const rects = annotationContentRectsOf(annotations);
        const add = (
            groupId: string,
            rect: { x: number; y: number; width: number; height: number }
        ) => {
            const list = rects.get(groupId);
            if (list) list.push(rect);
            else rects.set(groupId, [rect]);
        };

        for (const draft of canvasDrafts) {
            if (draft.group_id) {
                add(draft.group_id, {
                    x: draft.positionX,
                    y: draft.positionY,
                    width: cw,
                    height: ch
                });
            }
        }

        const tree = canvasTree();
        const byId = new Map(canvasGroups.map((g) => [g.id, g]));
        for (const child of canvasGroups) {
            const parent = child.parent_group_id
                ? byId.get(child.parent_group_id)
                : undefined;
            if (!parent) continue;
            // ADR-0006: a Group's stored position is ABSOLUTE at every depth, so
            // it has to be rebased into the parent's frame before it can be
            // unioned with container-relative Card rects. `nodeSize` rather than
            // `width ?? 400`, because a series' stored size is meaningless.
            const size = nodeSize(
                tree,
                { kind: "group", id: child.id, group: child },
                layout
            );
            const rect = {
                x: child.positionX - parent.positionX,
                y: child.positionY - parent.positionY,
                width: size.width,
                height: size.height
            };
            // A child dragged clear of its parent must not dictate the parent's
            // minimum size: `maxLeftEdgeDelta` goes to 0 the moment any child
            // sits at negative relative x, which would lock the parent's left
            // edge from off-screen. Only children still overlapping the frame
            // count (5a-1 boundary note, round 1).
            const pw = parent.width ?? DEFAULT_GROUP_WIDTH;
            const ph = parent.height ?? DEFAULT_GROUP_HEIGHT;
            const overlaps =
                rect.x < pw &&
                rect.y < ph &&
                rect.x + rect.width > 0 &&
                rect.y + rect.height > 0;
            if (!overlaps) continue;
            add(parent.id, rect);
        }

        const out = new Map<string, ReturnType<typeof contentBoundsOf>>();
        for (const [groupId, list] of rects) out.set(groupId, contentBoundsOf(list));
        return out;
    });

    const EMPTY_CONTENT_BOUNDS = contentBoundsOf([]);
    const groupContentBounds = (groupId: string) =>
        contentBounds().get(groupId) ?? EMPTY_CONTENT_BOUNDS;

    /**
     * Re-derive a container's size from its contents and its manual floor, in
     * BOTH directions, and pull its left edge out over any child that sits past
     * it (rebasing the children by the same amount, since a Card's coordinates
     * are relative to its container).
     *
     * This replaces `maybeExpandGroup`, which could only ever grow: every
     * sizing path ran while something was being *added*, and every one of them
     * was `Math.max(current, content)` — so nothing recomputed a container after
     * a child left, and it could not have shrunk it if it had. Call it whenever
     * a container's contents change, in either direction.
     *
     * §9.1a's locked rule ("never grow to chase a child that is leaving") is a
     * rule about the CALL SITES, and it holds here by construction: a child
     * leaving can only raise `minLeft`, so the removal calls never expand left.
     */
    /**
     * Rewrite a grid's members to the layout its CURRENT membership implies.
     *
     * Needed whenever membership changes without a drop resolving it — a child
     * moved to another container, reparented, or deleted. **This is a
     * normal-user correctness bug without it, not an edge case.** Row 0 holds a
     * series (inset ~172) and a Card (inset 2, stored ~171px lower). Drag the
     * series out: `resyncGroupSize` recomputes the container's DIMENSIONS only,
     * so the Card stays painted 171px down while the new Card-only row puts it
     * at the top — and `gridContentHeight` shrinks the frame as though it had
     * moved, leaving the Card outside it.
     *
     * It is also the repair path for a concurrent split: it re-derives the
     * whole container from whatever pixels are stored and materializes a
     * coherent layout, so any later commit makes a torn one consistent again.
     * It cannot recover that the split members previously SHARED a row — that
     * information is gone — so this makes tearing visible and coherent, not
     * undone.
     *
     * Idempotent by construction: `materializeGrid` emits only members whose
     * position actually changed, so a settled container produces no writes and
     * this can be called freely.
     */
    const rematerializeGrid = (group: CanvasGroup) => {
        if (!isGridGroup(group)) return;
        // NO assignments, deliberately. `materializeGrid` then recomputes every
        // member's Y from the row model and leaves every X exactly as stored —
        // which is the whole job here. Assigning each member its own cell would
        // additionally re-snap x through `colAt`'s round-and-clamp under
        // `gridItemsFor`'s growth-column count, dragging members left for a
        // reason that has nothing to do with a member leaving a row.
        commitGridMaterialization(group.id, []);
    };

    const resyncOneGroupSize = (groupId: string) => {
        const group = canvasGroups.find((g) => g.id === groupId);
        if (!group || group.type !== "custom") return;
        const layout = props.cardLayout();

        if (isGridGroup(group)) {
            // A member LEAVING lowers its row's baseline, so every row-mate
            // rises and every row below moves up. Nothing else in the app would
            // ever write those rows. Skipped for a container this gesture just
            // committed — see `settledByGesture`.
            if (!settledByGesture.has(groupId)) rematerializeGrid(group);
            // Cells are non-negative by construction, so a grid never expands
            // left; its content bounds are just its lattice.
            const cols = Math.max(
                gridColsOf(group),
                maxChildSpanCols(canvasTree(), group.id, layout)
            );
            // Re-read AFTER rematerializing, or the container is sized from the
            // pre-materialization set and is one gesture behind.
            const items = gridItemsOf(canvasTree(), group.id, layout, cols);
            const dims = resolveGridDims(
                group,
                gridContentHeightForRows(
                    rowsOfItems(items, layout),
                    gridRowsOf(group),
                    layout
                ),
                cols,
                layout
            );
            if (dims.width === group.width && dims.height === group.height) return;
            persistGroupDimensions(group, dims);
            return;
        }

        const currentWidth = group.width ?? DEFAULT_GROUP_WIDTH;
        const currentHeight = group.height ?? DEFAULT_GROUP_HEIGHT;
        // A dropped Card is already in the store by the time this runs, so the
        // union below includes it. A left expansion shifts every child by
        // `expandLeft`, and the right edge travels with them.
        const content = groupContentBounds(groupId);
        const expandLeft = content.expandLeft;
        const resolved = resolveContainerDims(group, {
            width: content.width + expandLeft,
            height: content.height
        });

        if (
            expandLeft > 0 ||
            resolved.width !== currentWidth ||
            resolved.height !== currentHeight
        ) {
            const newWidth = resolved.width;
            const newHeight = resolved.height;
            const newPositionX = group.positionX - expandLeft;
            const rebaseWrites =
                expandLeft > 0
                    ? freeGroupLeftRebaseWrites(canvasTree(), group.id, expandLeft)
                    : [];

            setCanvasGroups((g) => g.id === group.id, {
                positionX: newPositionX,
                width: newWidth,
                height: newHeight
            });
            for (const write of rebaseWrites) {
                if (write.kind === "card") {
                    setCanvasDrafts((draft) => draft.Draft.id === write.draftId, {
                        positionX: write.positionX
                    });
                } else {
                    setAnnotations((annotation) => annotation.id === write.annotationId, {
                        positionX: write.positionX
                    });
                }
            }
            if (isLocalMode()) {
                localUpdateGroup({
                    groupId: group.id,
                    positionX: newPositionX,
                    width: newWidth,
                    height: newHeight
                });
                for (const write of rebaseWrites) {
                    if (write.kind === "card") {
                        localUpdateDraftPosition({
                            draftId: write.draftId,
                            positionX: write.positionX,
                            positionY: write.positionY
                        });
                    } else {
                        localUpdateAnnotation({
                            annotationId: write.annotationId,
                            positionX: write.positionX,
                            positionY: write.positionY
                        });
                    }
                }
            } else {
                updateGroupMutation.mutate({
                    canvasId: canvasId(),
                    groupId: group.id,
                    positionX: newPositionX,
                    width: newWidth,
                    height: newHeight
                });
                for (const write of rebaseWrites) {
                    if (write.kind === "card") {
                        updatePositionMutation.mutate({
                            canvasId: canvasId(),
                            draftId: write.draftId,
                            positionX: write.positionX,
                            positionY: write.positionY
                        });
                    } else {
                        updateAnnotationMutation.mutate({
                            canvasId: canvasId(),
                            annotationId: write.annotationId,
                            positionX: write.positionX,
                            positionY: write.positionY
                        });
                    }
                }
            }
        }
    };

    /**
     * Resize a container and every ancestor it sits in, innermost first.
     *
     * §6.2 gap 1, pulled into scope by §6.0a. Before this branch a nested
     * container's height only reached its parent through `spanFor`'s ceil,
     * which absorbed anything under a whole cell. Rule 2 makes the parent's row
     * height a CONTINUOUS function of the child's height, so every pixel a
     * nested container gains must now reach the root — the gap went from
     * rarely-visible to visible on almost every nested edit, and stopped being
     * separable.
     *
     * The order is not optional: a child's new size is what its parent's row
     * height is measured from. Only `resyncOneGroupSize` on the container whose
     * MEMBERSHIP changed rematerializes; ancestors need resizing, not
     * rematerializing, which is what keeps one drop in a depth-3 nest from
     * emitting four separate non-atomic layout requests.
     *
     * The name is deliberately unchanged, so all ten existing call sites now
     * mean "and its ancestors" — which is what every one of them wants.
     */
    const resyncGroupSize = (groupId: string) => {
        for (const id of resizeChainOf(canvasTree(), groupId)) resyncOneGroupSize(id);
    };

    const persistAnnotationPlacement = (
        annotationId: string,
        placement: { positionX: number; positionY: number; group_id?: string | null }
    ) => {
        setAnnotations((a) => a.id === annotationId, {
            positionX: placement.positionX,
            positionY: placement.positionY,
            ...(placement.group_id !== undefined ? { group_id: placement.group_id } : {})
        });
        if (isLocalMode()) {
            localUpdateAnnotation({ annotationId, ...placement });
        } else {
            updateAnnotationMutation.mutate({
                canvasId: canvasId(),
                annotationId,
                ...placement
            });
        }
    };

    /**
     * The width a resize gesture is allowed to leave a note at.
     *
     * Whole columns inside a grid, untouched outside one — the same membership
     * test that decides whether the note paints snapped at all, so the handle
     * and the render agree about which world the note is in.
     *
     * Both axes now. Height's lattice is the row model rather than a uniform
     * cell, so its snap needs the rows and the note's own starting row — but the
     * rule is the same one width uses: whole units, nearest rather than ceil.
     */
    const resizeWidthFor = (annotationId: string, width: number): number => {
        const annotation = annotations.find((a) => a.id === annotationId);
        if (!annotation?.group_id) return width;
        const group = canvasGroups.find((g) => g.id === annotation.group_id);
        if (!group || !isGridGroup(group)) return width;
        return snapWidthToCells(width, props.cardLayout());
    };

    /**
     * Snap a left-edge resize to the grid while preserving its right boundary.
     * The width joins the result because clamping the left column at zero must
     * also stop growth; otherwise the supposedly anchored right edge would move.
     */
    const resizeLeftFor = (
        annotationId: string,
        positionX: number,
        width: number
    ): { positionX: number; width: number } => {
        const annotation = annotations.find((a) => a.id === annotationId);
        if (!annotation?.group_id) return { positionX, width };
        const group = canvasGroups.find((g) => g.id === annotation.group_id);
        if (!group || !isGridGroup(group)) return { positionX, width };
        const item = gridItemsFor(group).find(
            (candidate) => candidate.id === annotationId
        );
        if (!item) return { positionX, width };

        const layout = props.cardLayout();
        const rightBoundaryCol = item.cell.col + item.footprint.cols;
        const requestedCols = spanFor(width, cardWidth(layout), GRID_CELL_GAP);
        const clampedCols = Math.min(requestedCols, rightBoundaryCol);
        const leftCol = Math.max(0, rightBoundaryCol - clampedCols);
        return {
            positionX: cellToPosition({ row: item.cell.row, col: leftCol }, layout).x,
            width: footprintPixelWidth({ cols: clampedCols, rows: 1 }, layout)
        };
    };

    /**
     * The height a resize gesture is allowed to leave a note at: whole rows
     * inside a grid, untouched outside one.
     *
     * The row model is read from SETTLED membership, the same exclusion every
     * other row derivation on this path uses. It is stable across the gesture
     * even though the note's stored height is changing under it, because a note
     * does not SIZE its row — only the rows it covers change, and every covered
     * row measures the same `cardHeight(layout)` whichever one it is.
     */
    const resizeHeightFor = (annotationId: string, height: number): number => {
        const annotation = annotations.find((a) => a.id === annotationId);
        if (!annotation?.group_id) return height;
        const group = canvasGroups.find((g) => g.id === annotation.group_id);
        if (!group || !isGridGroup(group)) return height;
        const layout = props.cardLayout();
        const rows = rowsOfItems(
            gridItemsFor(group).filter((item) => !inFlightIds().has(item.id)),
            layout
        );
        const row = rows.find((entry) => entry.ids.includes(annotationId));
        if (!row) return height;
        return snapHeightToRows(height, row.index, rows, layout);
    };

    /** Live resize: paint only. No persistence and no floor write. */
    const handleAnnotationResize = (
        annotationId: string,
        positionX: number,
        width: number,
        height: number,
        isLeftEdge: boolean
    ) => {
        const snappedWidth = resizeWidthFor(annotationId, width);
        const snappedHeight = resizeHeightFor(annotationId, height);
        // ⚠️ `isLeftEdge` is PASSED, never inferred from the numbers. An earlier
        // draft derived it as `positionX !== annotation.positionX`, which is
        // wrong in both directions: a RIGHT-edge drag reads as a left-edge one
        // the moment anything else moves the note mid-gesture, and a left-edge
        // drag reads as a right-edge one exactly when the user drags back to
        // where they started.
        const horizontal = isLeftEdge
            ? resizeLeftFor(annotationId, positionX, snappedWidth)
            : { positionX, width: snappedWidth };
        setAnnotations((a) => a.id === annotationId, {
            positionX: horizontal.positionX,
            width: horizontal.width,
            height: snappedHeight
        });
        debouncedEmitAnnotationResize(
            annotationId,
            horizontal.positionX,
            horizontal.width,
            snappedHeight
        );
    };

    /** Resize commit writes both the rendered size and the manual floor (D7). */
    const handleAnnotationResizeEnd = (
        annotationId: string,
        positionX: number,
        width: number,
        height: number,
        isLeftEdge: boolean
    ) => {
        // The D7 floor is the SIZE only. `positionX` is committed as a plain
        // position, and only when this corner actually moved it — a right-edge
        // resize must not write an x at all, or it persists a value it never
        // owned.
        const fields = isLeftEdge
            ? { positionX, width, height, manualWidth: width, manualHeight: height }
            : { width, height, manualWidth: width, manualHeight: height };
        setAnnotations((a) => a.id === annotationId, fields);
        if (isLocalMode()) localUpdateAnnotation({ annotationId, ...fields });
        else {
            updateAnnotationMutation.mutate({
                canvasId: canvasId(),
                annotationId,
                ...fields
            });
        }
        const annotation = annotations.find((a) => a.id === annotationId);
        if (annotation?.group_id) resyncGroupSize(annotation.group_id);
    };

    /**
     * Commit prose and its bidirectional auto-fit in one write. The floor is
     * manualHeight, never the rendered height, so typed growth can shrink.
     */
    const handleAnnotationTextCommit = (
        annotationId: string,
        text: string,
        measured: number
    ) => {
        const annotation = annotations.find((a) => a.id === annotationId);
        if (!annotation) return;
        const height = autoFitHeight({
            measured,
            floor: annotationFloor(annotation).height
        });
        if (text === annotation.text && height === annotation.height) return;
        setAnnotations((a) => a.id === annotationId, { text, height });
        if (isLocalMode()) localUpdateAnnotation({ annotationId, text, height });
        else {
            updateAnnotationMutation.mutate({
                canvasId: canvasId(),
                annotationId,
                text,
                height
            });
        }
        if (annotation.group_id) resyncGroupSize(annotation.group_id);
    };

    const handleAnnotationDuplicate = (annotation: CanvasAnnotation) => {
        const group = annotation.group_id
            ? canvasGroups.find((g) => g.id === annotation.group_id)
            : undefined;
        const tree = canvasTree();
        const node: TreeNode = { kind: "annotation", id: annotation.id, annotation };
        const placement = resolveCopyPlacement({
            subject: {
                id: annotation.id,
                kind: "annotation",
                positionX: annotation.positionX,
                positionY: annotation.positionY,
                ...nodeSize(tree, node, props.cardLayout()),
                inset: insetOf(tree, node, props.cardLayout())
            },
            group,
            tree,
            layout: props.cardLayout()
        });

        if (group && (placement.groupDims || placement.groupMetadata)) {
            persistGroupDimensions(
                group,
                placement.groupDims ?? {
                    width: group.width ?? DEFAULT_GROUP_WIDTH,
                    height: group.height ?? DEFAULT_GROUP_HEIGHT
                },
                placement.groupMetadata
            );
        }

        const annotationPlacement = {
            positionX: placement.positionX,
            positionY: placement.positionY,
            group_id: placement.group_id
        };
        if (isLocalMode()) {
            localCopyAnnotation(annotation.id, annotationPlacement);
            refreshFromLocal();
        } else {
            copyAnnotationMutation.mutate({
                canvasId: canvasId(),
                annotationId: annotation.id,
                ...annotationPlacement
            });
        }
    };

    const updateAnnotationAppearance = (
        annotationId: string,
        fields: {
            color?: CanvasAnnotation["color"];
            fontSize?: CanvasAnnotation["fontSize"];
        }
    ) => {
        setAnnotations((a) => a.id === annotationId, fields);
        if (isLocalMode()) localUpdateAnnotation({ annotationId, ...fields });
        else {
            updateAnnotationMutation.mutate({
                canvasId: canvasId(),
                annotationId,
                ...fields
            });
        }
    };

    // Right/middle-drag pan + mouse-up context menu dispatch. A right or
    // middle press anywhere on the canvas world starts a pan candidate;
    // movement past the threshold commits the pan, and a right release under
    // it opens the menu resolved from the *mousedown* target at the mousedown
    // position. Menus dispatch on mouse-up rather than the native contextmenu
    // event because that event fires on mousedown on Linux/X11 but on mouseup
    // on Windows/macOS — mouse-up dispatch is timing-independent.
    const PAN_DRAG_THRESHOLD_PX = 5;
    let auxPanCandidate: {
        button: number;
        startX: number;
        startY: number;
        target: EventTarget | null;
    } | null = null;
    // Set on right mousedown, telling the contextmenu handler the event is
    // mouse-originated (suppress it — the mouse-up dispatcher decides) rather
    // than touch long-press / keyboard menu key (dispatch immediately).
    let contextMenuFromMouse = false;

    // Focused inputs keep native right/middle-click behavior (paste menu,
    // spellcheck, X11 middle-click paste). mousedown fires before the same
    // click moves focus, so an unfocused input is ordinary canvas surface.
    const isFocusedInteractiveTarget = (target: EventTarget | null) => {
        if (!(target instanceof Element)) return false;
        const interactive = target.closest(
            'input, textarea, select, [contenteditable="true"]'
        );
        return interactive !== null && interactive === document.activeElement;
    };

    // Canvas world surfaces: background, the transformed world layer (including
    // the connections SVG), groups, cards and annotations. UI chrome (sidebar,
    // dialogs, menus, pickers) keeps its current behavior.
    const isCanvasWorldTarget = (target: EventTarget | null) =>
        target instanceof Element && isCanvasWorldElement(target);

    const onAuxMouseDown = (e: MouseEvent) => {
        if (e.button !== 1 && e.button !== 2) return;
        // Right-click belongs to the annotation editor's surfaces while one is
        // mounted — FOCUSED OR NOT. `isFocusedInteractiveTarget` below cannot
        // cover the mid-insert-session case where focus sits on the picker's
        // search box, and this listener is registered CAPTURE-phase on the canvas
        // container, so an element-level stopPropagation can never preempt it.
        if (
            e.target instanceof Element &&
            e.target.closest(".annotation-editor-surface")
        ) {
            return;
        }
        if (isFocusedInteractiveTarget(e.target)) return;
        if (!isCanvasWorldTarget(e.target)) return;
        if (
            dragState().activeBoxId !== null ||
            dragState().isPanning ||
            groupDragState().activeGroupId !== null ||
            vertexDragState().connectionId !== null
        ) {
            return;
        }
        if (e.button === 2) contextMenuFromMouse = true;
        // Middle mousedown would otherwise start browser autoscroll.
        if (e.button === 1) e.preventDefault();
        auxPanCandidate = {
            button: e.button,
            startX: e.clientX,
            startY: e.clientY,
            target: e.target
        };
    };

    // Single menu-resolution table for all five surfaces, shared by the
    // right mouse-up dispatcher and the touch/keyboard contextmenu fallback.
    const dispatchContextMenu = (target: EventTarget | null, x: number, y: number) => {
        const el = target instanceof Element ? target : null;

        const card = el?.closest(".canvas-card");
        if (card) {
            const draftId = card.getAttribute("data-draft-id");
            const draft = canvasDrafts.find((cd) => cd.Draft.id === draftId);
            if (draft) {
                closeAllContextMenus();
                setDraftContextMenu({ draft, position: { x, y } });
            }
            return;
        }

        const vertexEl = el?.closest("[data-vertex-id]");
        if (vertexEl) {
            const connectionId = vertexEl.getAttribute("data-connection-id");
            const vertexId = vertexEl.getAttribute("data-vertex-id");
            if (connectionId && vertexId) {
                closeAllContextMenus();
                setConnectionContextMenu({
                    connectionId,
                    type: "vertex",
                    vertexId,
                    position: { x, y }
                });
            }
            return;
        }

        const connectionEl = el?.closest("[data-connection-id]");
        if (connectionEl) {
            const connectionId = connectionEl.getAttribute("data-connection-id");
            if (connectionId) {
                closeAllContextMenus();
                setConnectionContextMenu({
                    connectionId,
                    type: "connection",
                    position: { x, y }
                });
            }
            return;
        }

        const annotationEl = el?.closest(".canvas-annotation");
        if (annotationEl) {
            if (!canEdit()) return;
            const annotation = annotations.find(
                (entry) => entry.id === annotationEl.getAttribute("data-annotation-id")
            );
            if (annotation) {
                closeAllContextMenus();
                setSelectedAnnotationId(annotation.id);
                setAnnotationContextMenu({ annotation, position: { x, y } });
            }
            return;
        }

        const groupEl = el?.closest(".group-container");
        if (groupEl) {
            if (!canEdit()) return;
            const group = canvasGroups.find(
                (g) => g.id === groupEl.getAttribute("data-group-id")
            );
            // Series groups have no canvas-side menu.
            if (group && group.type === "custom") {
                closeAllContextMenus();
                setGroupContextMenu({ group, position: { x, y } });
            }
            return;
        }

        const poolEl = el?.closest(".canvas-pool-card");
        if (poolEl) {
            if (!canEdit()) return;
            const placement = canvasPools.find(
                (p) => p.id === poolEl.getAttribute("data-pool-id")
            );
            if (placement) {
                closeAllContextMenus();
                setSelectedPoolId(placement.id);
                setPoolContextMenu({ placement, position: { x, y } });
            }
            return;
        }

        if (!canEdit()) return;
        closeAllContextMenus();
        setContextMenuWorldPosition(screenToWorld(x, y));
        setContextMenuPosition({ x, y });
    };

    const handleCanvasContextMenu = (e: MouseEvent) => {
        if (contextMenuFromMouse) {
            // Mouse-originated: the mousedown already made the exempt/ordinary
            // call (an exempt press never sets the flag), so suppress without
            // re-checking focus — the browser focuses an unfocused input on
            // right mousedown itself, which would wrongly exempt it here.
            contextMenuFromMouse = false;
            e.preventDefault();
            return;
        }
        // Touch long-press or keyboard menu key. Canvas chrome (sidebar,
        // badges, popovers) keeps the native menu instead of falling through
        // to the background Create-Draft menu.
        if (isFocusedInteractiveTarget(e.target)) return;
        if (!isCanvasWorldTarget(e.target)) return;
        e.preventDefault();
        dispatchContextMenu(e.target, e.clientX, e.clientY);
    };

    const closeContextMenu = () => {
        setContextMenuPosition(null);
    };

    const closeAllContextMenus = () => {
        setContextMenuPosition(null);
        setDraftContextMenu(null);
        setAnnotationContextMenu(null);
        setPoolContextMenu(null);
        setGroupContextMenu(null);
        setConnectionContextMenu(null);
    };

    const closeDraftContextMenu = () => {
        setDraftContextMenu(null);
    };

    const closeGroupContextMenu = () => {
        setGroupContextMenu(null);
    };

    const handleDraftView = (draft: CanvasDraft) => {
        navigate(`/canvas/${canvasId()}/draft/${draft.Draft.id}`);
    };

    const handleDraftGoTo = (draft: CanvasDraft) => {
        const pos = getDraftWorldPosition(draft);
        navigateToDraft(pos.x, pos.y);
    };

    const handleDraftCopy = (draft: CanvasDraft) => {
        const sourceGroup = draft.group_id
            ? canvasGroups.find((g) => g.id === draft.group_id)
            : undefined;

        const placement = resolveCopyPlacement({
            subject: {
                id: draft.draft_id,
                kind: "card",
                positionX: draft.positionX,
                positionY: draft.positionY,
                width: cardWidth(props.cardLayout()),
                height: cardHeight(props.cardLayout()),
                inset: GROUP_BORDER_WIDTH
            },
            group: sourceGroup,
            tree: canvasTree(),
            layout: props.cardLayout()
        });

        // Either half can be present alone: a copy can push the grid onto a new
        // row without changing the container's size, when a manual floor
        // already made it tall enough to hold it.
        if (sourceGroup && (placement.groupDims || placement.groupMetadata)) {
            persistGroupDimensions(
                sourceGroup,
                placement.groupDims ?? {
                    width: sourceGroup.width ?? DEFAULT_GROUP_WIDTH,
                    height: sourceGroup.height ?? DEFAULT_GROUP_HEIGHT
                },
                placement.groupMetadata
            );
        }

        if (isLocalMode()) {
            localCopyDraft(draft.Draft.id, {
                positionX: placement.positionX,
                positionY: placement.positionY,
                group_id: placement.group_id
            });
            refreshFromLocal();
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

    const handleDraftDelete = (draft: CanvasDraft) => {
        setDraftToDelete(draft);
        setIsDeleteDialogOpen(true);
    };

    // Pan input is coalesced to one viewport commit per animation frame. A
    // high-polling-rate mouse fires several mousemoves per frame and each one
    // used to commit a viewport. There is exactly ONE flush path so a queued
    // frame can never land after mouseup and overwrite the final position.
    let pendingPanPointer: { x: number; y: number } | null = null;
    let panFrame: number | null = null;

    const commitPan = (pointer: { x: number; y: number }): Viewport | null => {
        const state = dragState();
        if (!state.isPanning) return null;
        const vp = props.viewport();
        const next = {
            ...vp,
            x: state.viewportStartX - (pointer.x - state.panStartX) / vp.zoom,
            y: state.viewportStartY - (pointer.y - state.panStartY) / vp.zoom
        };
        props.setViewport(next);
        return next;
    };

    const flushPan = () => {
        panFrame = null;
        const pointer = pendingPanPointer;
        pendingPanPointer = null;
        if (!pointer) return;
        const next = commitPan(pointer);
        if (next) viewportSaver.send(next);
    };

    const schedulePan = (pointer: { x: number; y: number }) => {
        pendingPanPointer = pointer;
        if (panFrame === null) panFrame = requestAnimationFrame(flushPan);
    };

    // Must run BEFORE dragState is reset to isPanning: false — commitPan reads
    // it. Consumes the pending pointer exactly once so the pan ends on the
    // pixel the user released at, then persists that position directly.
    const endPan = () => {
        if (panFrame !== null) {
            cancelAnimationFrame(panFrame);
            panFrame = null;
        }
        const pointer = pendingPanPointer;
        pendingPanPointer = null;
        const next = pointer ? commitPan(pointer) : null;
        persistViewportNow(next ?? props.viewport());
    };

    onCleanup(() => {
        if (panFrame !== null) cancelAnimationFrame(panFrame);
        panFrame = null;
        pendingPanPointer = null;
    });

    onMount(() => {
        canvasContext.setSetEditingGroupIdCallback(() => setEditingGroupId);
        canvasContext.setDeleteGroupCallback(() => (id: string) => handleDeleteGroup(id));
        canvasContext.setSetEditingDraftIdCallback(() => setEditingDraftId);

        const onKeyDown = (e: KeyboardEvent) => {
            if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f") {
                const isSearchPanelTarget =
                    e.target instanceof Element &&
                    e.target.closest('[data-canvas-search-panel="true"]') !== null;
                if (isFocusedInteractiveTarget(e.target) && !isSearchPanelTarget) return;
                e.preventDefault();
                if (searchOpen()) setSearchFocusNonce((n) => n + 1);
                else setSearchOpen(true);
                return;
            }
            if (searchOpen() && e.key === "Escape") {
                closeSearch();
                return;
            }
            if (searchOpen() && !isFocusedInteractiveTarget(e.target)) {
                if (e.key === "Enter" && !isConnectionMode()) {
                    e.preventDefault();
                    const selected = searchSelectedDraftId();
                    if (selected !== null) jumpToSearchDraft(selected);
                    return;
                }
                if (e.key === "ArrowDown") {
                    e.preventDefault();
                    moveSearchSelection(1);
                    return;
                }
                if (e.key === "ArrowUp") {
                    e.preventDefault();
                    moveSearchSelection(-1);
                    return;
                }
            }
            const annotationShortcut = annotationKeyboardShortcut({
                key: e.key,
                isConnectionMode: isConnectionMode(),
                selectedAnnotationId: selectedAnnotationId(),
                editingAnnotationId: editingAnnotationId(),
                isInteractiveTarget: isFocusedInteractiveTarget(e.target),
                isModalOpen:
                    document.querySelector('[data-modal-overlay="true"]') !== null
            });
            if (annotationShortcut === "start-editing") {
                e.preventDefault();
                setEditingAnnotationId(selectedAnnotationId());
                return;
            }
            if (annotationShortcut === "stop-editing") {
                setEditingAnnotationId(null);
                e.preventDefault();
                return;
            }
            if (annotationShortcut === "clear-selection") {
                setSelectedAnnotationId(null);
                e.preventDefault();
                return;
            }
            if (e.key === "Escape" && isConnectionMode()) {
                e.preventDefault();
                if (connectionSource() || selectedVertexForConnection()) {
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
            const candidate = auxPanCandidate;
            if (candidate) {
                // Button released outside the window: the mouseup never
                // reached us, so a later buttonless move would spuriously
                // commit a pan. Drop the candidate and the suppression flag.
                const buttonBit = candidate.button === 2 ? 2 : 4;
                if ((e.buttons & buttonBit) === 0) {
                    auxPanCandidate = null;
                    contextMenuFromMouse = false;
                } else {
                    const dx = e.clientX - candidate.startX;
                    const dy = e.clientY - candidate.startY;
                    if (
                        dx * dx + dy * dy >=
                        PAN_DRAG_THRESHOLD_PX * PAN_DRAG_THRESHOLD_PX
                    ) {
                        // Threshold crossed: commit the pan. Anchoring panStart at
                        // the mousedown position makes the isPanning branch below
                        // apply the accumulated delta on this same move.
                        auxPanCandidate = null;
                        const vp = props.viewport();
                        setDragState({
                            activeBoxId: null,
                            offsetX: 0,
                            offsetY: 0,
                            dragGroupId: null,
                            dragOriginX: 0,
                            dragOriginY: 0,
                            isPanning: true,
                            panStartX: candidate.startX,
                            panStartY: candidate.startY,
                            viewportStartX: vp.x,
                            viewportStartY: vp.y
                        });
                    }
                }
            }

            if (isConnectionMode() && connectionSource() && canvasContainerRef) {
                // World coords: the preview line is drawn inside the world layer
                setPreviewMousePos(screenToWorld(e.clientX, e.clientY));
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
                const dragged = canvasGroups.find((g) => g.id === gState.activeGroupId);
                if (dragged) {
                    // PER-FRAME increment, never cumulative-from-origin (A8).
                    // Recomputing descendants as `origin + total` would destroy a
                    // concurrent remote move of a descendant on the next
                    // mousemove — the exact failure the derived-delta mechanism
                    // exists to prevent, reproduced locally. It also agrees with
                    // what the server computes at commit (`stored + dx`).
                    applyGroupPositionWrites(
                        subtreeMoveWrites(
                            canvasTree(),
                            gState.activeGroupId,
                            newX - dragged.positionX,
                            newY - dragged.positionY
                        )
                    );
                }
                // The preview runs the REAL resolver, at the real drop point —
                // the dragged Group's top-left corner — so the accept highlight
                // cannot promise a landing the drop refuses.
                const resolution = resolveGroupDrop(canvasTree(), {
                    groupId: gState.activeGroupId,
                    point: { x: newX, y: newY }
                });
                setDragOverGroupId(
                    resolution.nextParentId &&
                        resolution.nextParentId !== dragged?.parent_group_id
                        ? resolution.nextParentId
                        : null
                );
                // Rectangular landing preview when the target is a grid. Runs
                // the SAME resolver on the SAME container-relative numbers the
                // commit will use, so what the user sees is where it lands.
                const previewParent = resolution.nextParentId
                    ? canvasGroups.find((g) => g.id === resolution.nextParentId)
                    : undefined;
                if (dragged && previewParent && isGridGroup(previewParent)) {
                    const layout = props.cardLayout();
                    const draggedGeometry = draggedGroupGeometry(
                        gState.activeGroupId,
                        dragged,
                        layout
                    );
                    const footprint = draggedGeometry.footprint;
                    const cols = Math.max(gridColsFor(previewParent), footprint.cols);
                    const relX = newX - previewParent.positionX;
                    const relY = newY - previewParent.positionY;
                    const joins = previewParent.id !== (dragged.parent_group_id ?? null);
                    const items = gridItemsFor(previewParent);
                    // TARGETING rows exclude the dragged node; LANDING rows,
                    // below, include it. Dragging a nested container into a
                    // grid is exactly the gesture whose point is that the row
                    // grows to fit it, so a preview drawn from the targeting
                    // membership would mispromise the thing being shipped.
                    const previewRows = rowsOfItems(
                        items.filter((i) => i.id !== gState.activeGroupId),
                        layout
                    );
                    const assignments = resolveGridDrop({
                        items,
                        rows: previewRows,
                        dragged: draggedGeometry,
                        draggedOrigin: joins
                            ? null
                            : {
                                  x: gState.originX - previewParent.positionX,
                                  y: gState.originY - previewParent.positionY
                              },
                        dropX: relX,
                        dropY: relY,
                        layout,
                        cols
                    });
                    const landing = assignments.find(
                        (a) => a.id === gState.activeGroupId
                    );
                    // LANDING membership: the dragged Group is projected IN,
                    // with its real inset and height, so the highlight is drawn
                    // at the height the row will actually grow to. This is the
                    // gesture whose whole point is that growth.
                    const { rows: landedRows } = landing
                        ? materializeGrid({
                              items: projectIntoGrid(
                                  items,
                                  draggedGeometry,
                                  landing.cell,
                                  { x: relX, y: relY }
                              ),
                              assignments,
                              layout
                          })
                        : { rows: [] };
                    setGridDropCell(
                        landing
                            ? {
                                  groupId: previewParent.id,
                                  landing: {
                                      cell: landing.cell,
                                      footprint,
                                      rows: landedRows,
                                      rowMetrics: landingBandOf(
                                          landedRows,
                                          gState.activeGroupId,
                                          landing.cell,
                                          layout
                                      )
                                  },
                                  // A Group never swaps (decision 7, amended):
                                  // both sides must be Cards.
                                  isSwap: false,
                                  displaced: null
                              }
                            : null
                    );
                } else {
                    setGridDropCell(null);
                }
                // One absolute event for the dragged Group only; receivers
                // derive their own delta and fan out (3.1c).
                debouncedEmitGroupMove(gState.activeGroupId, newX, newY);
                return;
            }

            const annotationState = annotationDragState();
            if (annotationState.activeAnnotationId) {
                const annotation = annotations.find(
                    (entry) => entry.id === annotationState.activeAnnotationId
                );
                if (!annotation) return;
                const worldCoords = screenToWorld(e.clientX, e.clientY);
                const newWorldX = worldCoords.x - annotationState.offsetX;
                const newWorldY = worldCoords.y - annotationState.offsetY;
                const sourceGroup = annotationState.dragGroupId
                    ? canvasGroups.find((g) => g.id === annotationState.dragGroupId)
                    : undefined;
                const positionX = sourceGroup
                    ? newWorldX - sourceGroup.positionX
                    : newWorldX;
                const positionY = sourceGroup
                    ? newWorldY - sourceGroup.positionY
                    : newWorldY;
                setAnnotations((entry) => entry.id === annotation.id, {
                    positionX,
                    positionY
                });
                debouncedEmitAnnotationMove(annotation.id, positionX, positionY);

                const hoverPoint = annotationCenterPoint(
                    newWorldX,
                    newWorldY,
                    annotation,
                    annotationState.frozenSize
                );
                const hoverGroup = findGroupAtPosition(hoverPoint.x, hoverPoint.y);
                const currentGroupId = annotationState.dragGroupId ?? annotation.group_id;
                if (hoverGroup && hoverGroup.id !== currentGroupId) {
                    setDragOverGroupId(hoverGroup.id);
                    setExitingGroupId(currentGroupId ?? null);
                } else {
                    setDragOverGroupId(null);
                    setExitingGroupId(!hoverGroup ? (currentGroupId ?? null) : null);
                }
                const gridHoverGroup =
                    hoverGroup &&
                    isGridGroup(hoverGroup) &&
                    (hoverGroup.id !== currentGroupId ||
                        hoverGroup.id === annotationState.dragGroupId)
                        ? hoverGroup
                        : null;
                if (gridHoverGroup) {
                    const layout = props.cardLayout();
                    const relX = newWorldX - gridHoverGroup.positionX;
                    const relY = newWorldY - gridHoverGroup.positionY;
                    const draggedGeometry = draggedAnnotationGeometry(annotation, layout);
                    const footprint = draggedGeometry.footprint;
                    const cols = Math.max(gridColsFor(gridHoverGroup), footprint.cols);
                    const items = gridItemsFor(gridHoverGroup);
                    const isIntraGroup =
                        gridHoverGroup.id === annotationState.dragGroupId;
                    const previewRows = rowsOfItems(
                        items.filter((i) => i.id !== annotation.id),
                        layout
                    );
                    const targetCell = cellAt(previewRows, relX, relY, layout, cols);
                    const assignments = resolveGridDrop({
                        items,
                        rows: previewRows,
                        dragged: draggedGeometry,
                        draggedOrigin: isIntraGroup
                            ? {
                                  x: annotationState.originX,
                                  y: annotationState.originY
                              }
                            : null,
                        dropX: relX,
                        dropY: relY,
                        layout,
                        cols
                    });
                    const landing = assignments[0];
                    const displaced = assignments.length > 1 ? assignments[1] : null;
                    const occupantFootprint = displaced
                        ? (items.find((i) => i.id === displaced.id)?.footprint ??
                          CARD_FOOTPRINT)
                        : CARD_FOOTPRINT;
                    const landingCell = landing ? landing.cell : targetCell;
                    const { rows: landedRows } = materializeGrid({
                        items: projectIntoGrid(items, draggedGeometry, landingCell, {
                            x: relX,
                            y: relY
                        }),
                        assignments,
                        layout
                    });
                    setGridDropCell({
                        groupId: gridHoverGroup.id,
                        landing: {
                            cell: landingCell,
                            footprint,
                            rows: landedRows,
                            rowMetrics: landingBandOf(
                                landedRows,
                                annotation.id,
                                landingCell,
                                layout
                            )
                        },
                        isSwap: displaced !== null,
                        displaced: displaced
                            ? {
                                  cell: displaced.cell,
                                  footprint: occupantFootprint,
                                  rows: landedRows,
                                  rowMetrics: landingBandOf(
                                      landedRows,
                                      displaced.id,
                                      displaced.cell,
                                      layout
                                  )
                              }
                            : null
                    });
                } else {
                    setGridDropCell(null);
                }
                return;
            }

            const poolState = poolDragState();
            if (poolState.activePoolId) {
                const placement = canvasPools.find(
                    (p) => p.id === poolState.activePoolId
                );
                if (placement) {
                    const worldCoords = screenToWorld(e.clientX, e.clientY);
                    const { positionX, positionY } = poolDragPosition(
                        worldCoords.x,
                        worldCoords.y,
                        poolState.offsetX,
                        poolState.offsetY
                    );
                    // Optimistic paint. Pools carry no group_id — no
                    // grid-drop / hover-group bookkeeping to mirror here.
                    setCanvasPools((p) => p.id === placement.id, {
                        positionX,
                        positionY
                    });
                    debouncedEmitPoolMove(placement.id, positionX, positionY);
                }
                return;
            }

            const state = dragState();

            if (state.isPanning) {
                schedulePan({ x: e.clientX, y: e.clientY });
            } else if (state.activeBoxId !== null) {
                const worldCoords = screenToWorld(e.clientX, e.clientY);
                const newWorldX = worldCoords.x - state.offsetX;
                const newWorldY = worldCoords.y - state.offsetY;

                if (state.dragGroupId) {
                    // Dragging within a custom group — store group-relative position.
                    // Emit the same relative coords: receivers apply positionX/Y raw
                    // and render grouped drafts at group.position + cd.position.
                    const group = canvasGroups.find((g) => g.id === state.dragGroupId);
                    if (group) {
                        const relativeX = newWorldX - group.positionX;
                        const relativeY = newWorldY - group.positionY;
                        setCanvasDrafts((cd) => cd.Draft.id === state.activeBoxId, {
                            positionX: relativeX,
                            positionY: relativeY
                        });
                        debouncedEmitMove(state.activeBoxId, relativeX, relativeY);
                    }
                } else {
                    setCanvasDrafts((cd) => cd.Draft.id === state.activeBoxId, {
                        positionX: newWorldX,
                        positionY: newWorldY
                    });
                    debouncedEmitMove(state.activeBoxId, newWorldX, newWorldY);
                }

                // Check for group hover during draft drag (always in world coords)
                const hoverPoint = getCardCenterPoint(newWorldX, newWorldY);
                const hoverGroup = findGroupAtPosition(hoverPoint.x, hoverPoint.y);
                const draggedCard = canvasDrafts.find(
                    (cd) => cd.Draft.id === state.activeBoxId
                );
                const currentGroupId = state.dragGroupId || draggedCard?.group_id;

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

                // Grid drop-cell highlight: incoming (hovering a different grid
                // group) or intra-group (hovering the grid group the card came
                // from). Runs the same resolveGridDrop the drop handlers use,
                // so the highlight — including the swap preview — matches
                // where the cards actually land.
                const gridHoverGroup =
                    hoverGroup &&
                    isGridGroup(hoverGroup) &&
                    (hoverGroup.id !== currentGroupId ||
                        hoverGroup.id === state.dragGroupId)
                        ? hoverGroup
                        : null;
                if (gridHoverGroup && draggedCard) {
                    const layout = props.cardLayout();
                    const relX = newWorldX - gridHoverGroup.positionX;
                    const relY = newWorldY - gridHoverGroup.positionY;
                    // The SAME lattice the commit will use — the preview and
                    // the drop have to agree about which columns exist, or the
                    // overlay offers one the resolver refuses (round 2, V4).
                    const cols = gridColsFor(gridHoverGroup);
                    const items = gridItemsFor(gridHoverGroup);
                    const isIntraGroup = gridHoverGroup.id === state.dragGroupId;
                    const draggedGeometry = draggedCardGeometry(
                        draggedCard.draft_id,
                        layout
                    );
                    // TARGETING rows: the dragged Card is excluded, so hovering
                    // it cannot move the row it is trying to land in.
                    const previewRows = rowsOfItems(
                        items.filter((i) => i.id !== draggedCard.draft_id),
                        layout
                    );
                    const targetCell = cellAt(previewRows, relX, relY, layout, cols);
                    const assignments = resolveGridDrop({
                        items,
                        rows: previewRows,
                        // The layout engine keys on draft_id (the Card's
                        // PLACEMENT identity); activeBoxId is a Draft.id. Same
                        // value today, different meanings — see step-1's
                        // identity split.
                        dragged: draggedGeometry,
                        draggedOrigin: isIntraGroup
                            ? { x: state.dragOriginX, y: state.dragOriginY }
                            : null,
                        dropX: relX,
                        dropY: relY,
                        layout,
                        cols
                    });
                    const landing = assignments[0];
                    const displaced = assignments.length > 1 ? assignments[1] : null;
                    const occupantFootprint = displaced
                        ? (items.find((i) => i.id === displaced.id)?.footprint ??
                          CARD_FOOTPRINT)
                        : CARD_FOOTPRINT;
                    // Read from the assignment, not from targetCell: a
                    // footprint that collides without being able to swap lands
                    // on the nearest free rect instead, and the overlay has to
                    // point at where it will actually go.
                    const landingCell = landing ? landing.cell : targetCell;
                    // LANDING membership — the dragged Card projected IN, so
                    // both rects are drawn against the post-drop rows. A Card
                    // joining a row a series already owns sits at that row's
                    // baseline, not at its top edge.
                    const { rows: landedRows } = materializeGrid({
                        items: projectIntoGrid(items, draggedGeometry, landingCell, {
                            x: relX,
                            y: relY
                        }),
                        assignments,
                        layout
                    });
                    setGridDropCell({
                        groupId: gridHoverGroup.id,
                        landing: {
                            cell: landingCell,
                            footprint: CARD_FOOTPRINT,
                            rows: landedRows,
                            rowMetrics: landingBandOf(
                                landedRows,
                                draggedCard.draft_id,
                                landingCell,
                                layout
                            )
                        },
                        isSwap: displaced !== null,
                        displaced: displaced
                            ? {
                                  cell: displaced.cell,
                                  footprint: occupantFootprint,
                                  rows: landedRows,
                                  rowMetrics: landingBandOf(
                                      landedRows,
                                      displaced.id,
                                      displaced.cell,
                                      layout
                                  )
                              }
                            : null
                    });
                } else {
                    setGridDropCell(null);
                }
            }
        };

        const onWindowMouseUp = (e: MouseEvent) => {
            if (e.button === 2) {
                // The contextmenu event consumes the flag (it fires after
                // mouseup on Windows/macOS); this deferred clear only covers
                // releases where no contextmenu event follows at all.
                setTimeout(() => {
                    contextMenuFromMouse = false;
                }, 0);
            }
            const candidate = auxPanCandidate;
            if (candidate && e.button === candidate.button) {
                // Released under the drag threshold: no pan happened. A right
                // release opens the menu resolved from the mousedown target at
                // the mousedown position; a middle release does nothing.
                auxPanCandidate = null;
                if (candidate.button === 2) {
                    dispatchContextMenu(
                        candidate.target,
                        candidate.startX,
                        candidate.startY
                    );
                }
                return;
            }

            const annotationState = annotationDragState();
            if (annotationState.activeAnnotationId) {
                const annotation = annotations.find(
                    (entry) => entry.id === annotationState.activeAnnotationId
                );
                if (annotation) {
                    const sourceGroup = annotationState.dragGroupId
                        ? canvasGroups.find((g) => g.id === annotationState.dragGroupId)
                        : undefined;
                    const worldX = sourceGroup
                        ? sourceGroup.positionX + annotation.positionX
                        : annotation.positionX;
                    const worldY = sourceGroup
                        ? sourceGroup.positionY + annotation.positionY
                        : annotation.positionY;
                    const dropPoint = annotationCenterPoint(
                        worldX,
                        worldY,
                        annotation,
                        annotationState.frozenSize
                    );
                    const dropGroup = findGroupAtPosition(dropPoint.x, dropPoint.y);
                    const sourceGroupId = annotationState.dragGroupId;
                    if (dropGroup && dropGroup.id !== annotation.group_id) {
                        const relativeX = worldX - dropGroup.positionX;
                        const relativeY = worldY - dropGroup.positionY;
                        if (isGridGroup(dropGroup)) {
                            commitGridDrop({
                                group: dropGroup,
                                dragged: draggedAnnotationGeometry(
                                    annotation,
                                    props.cardLayout()
                                ),
                                relX: relativeX,
                                relY: relativeY,
                                origin: null,
                                joinsContainer: true
                            });
                        } else {
                            persistAnnotationPlacement(annotation.id, {
                                positionX: relativeX,
                                positionY: relativeY,
                                group_id: dropGroup.id
                            });
                            resyncGroupSize(dropGroup.id);
                        }
                        if (sourceGroupId) resyncGroupSize(sourceGroupId);
                    } else if (!dropGroup && annotation.group_id) {
                        persistAnnotationPlacement(annotation.id, {
                            positionX: worldX,
                            positionY: worldY,
                            group_id: null
                        });
                        if (sourceGroupId) resyncGroupSize(sourceGroupId);
                    } else {
                        const sameGroup = annotationState.dragGroupId
                            ? canvasGroups.find(
                                  (g) => g.id === annotationState.dragGroupId
                              )
                            : null;
                        if (sameGroup && isGridGroup(sameGroup)) {
                            commitGridDrop({
                                group: sameGroup,
                                dragged: draggedAnnotationGeometry(
                                    annotation,
                                    props.cardLayout()
                                ),
                                relX: annotation.positionX,
                                relY: annotation.positionY,
                                origin: {
                                    x: annotationState.originX,
                                    y: annotationState.originY
                                },
                                joinsContainer: false
                            });
                        } else {
                            persistAnnotationPlacement(annotation.id, {
                                positionX: annotation.positionX,
                                positionY: annotation.positionY
                            });
                            if (annotationState.dragGroupId && dropGroup) {
                                resyncGroupSize(dropGroup.id);
                            }
                        }
                    }
                }
                setAnnotationDragState({
                    activeAnnotationId: null,
                    offsetX: 0,
                    offsetY: 0,
                    dragGroupId: null,
                    originX: 0,
                    originY: 0,
                    frozenSize: null
                });
                setDragOverGroupId(null);
                setExitingGroupId(null);
                setGridDropCell(null);
                return;
            }

            const poolState = poolDragState();
            if (poolState.activePoolId) {
                const placement = canvasPools.find(
                    (p) => p.id === poolState.activePoolId
                );
                setPoolDragState({ activePoolId: null, offsetX: 0, offsetY: 0 });
                if (placement) {
                    // The optimistic store write already landed during
                    // mousemove — this is the durable commit. Own-echo
                    // discard on `poolMoved`/`canvasUpdate` keys off
                    // `draggedPoolId()`, which is now cleared, so any
                    // in-flight relay echo lands as a no-op equal write.
                    commitPoolDrag({
                        placementId: placement.id,
                        positionX: placement.positionX,
                        positionY: placement.positionY,
                        isLocalMode,
                        mutate: (args) =>
                            updatePoolMutation.mutate({
                                canvasId: canvasId(),
                                ...args
                            }),
                        localMove: (args) => localMovePool(args),
                        refreshFromLocal
                    });
                }
                return;
            }

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
                commitGroupDrag(gState);
                setDragOverGroupId(null);
                setGridDropCell(null);
                setGroupDragState({
                    activeGroupId: null,
                    offsetX: 0,
                    offsetY: 0,
                    originX: 0,
                    originY: 0
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

                    const dropPoint = getCardCenterPoint(worldX, worldY);
                    const dropGroup = findGroupAtPosition(dropPoint.x, dropPoint.y);
                    // Captured before the store write below clears it: a Card
                    // leaving is the gesture that lets its old container shrink
                    // back to the user's manual floor (5a-0).
                    const sourceGroupId = finalDraft.group_id;

                    if (dropGroup && dropGroup.id !== finalDraft.group_id) {
                        // Moving to a different group
                        const relativeX = worldX - dropGroup.positionX;
                        const relativeY = worldY - dropGroup.positionY;

                        if (isGridGroup(dropGroup)) {
                            // Grid destination: snap/swap and derive dimensions.
                            commitGridDrop({
                                group: dropGroup,
                                dragged: draggedCardGeometry(
                                    finalDraft.draft_id,
                                    props.cardLayout()
                                ),
                                relX: relativeX,
                                relY: relativeY,
                                origin: null,
                                joinsContainer: true
                            });
                        } else {
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

                            resyncGroupSize(dropGroup.id);
                        }
                        if (sourceGroupId) resyncGroupSize(sourceGroupId);
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
                            if (sourceGroupId) resyncGroupSize(sourceGroupId);
                        }
                    } else {
                        // Same group or ungrouped — save position
                        const sameGroup = state.dragGroupId
                            ? canvasGroups.find((g) => g.id === state.dragGroupId)
                            : null;
                        if (sameGroup && isGridGroup(sameGroup)) {
                            // Repositioning within a grid group: snap/swap
                            // relative to where the card started.
                            commitGridDrop({
                                group: sameGroup,
                                dragged: draggedCardGeometry(
                                    finalDraft.draft_id,
                                    props.cardLayout()
                                ),
                                relX: finalDraft.positionX,
                                relY: finalDraft.positionY,
                                origin: { x: state.dragOriginX, y: state.dragOriginY },
                                joinsContainer: false
                            });
                        } else {
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

                            // Re-fit the container after a reposition inside it
                            // — which since 5a-0 can shrink it as well as grow.
                            if (state.dragGroupId && dropGroup) {
                                resyncGroupSize(dropGroup.id);
                            }
                        }
                    }
                }
            }

            // Clear drag visual states
            setDragOverGroupId(null);
            setExitingGroupId(null);
            setGridDropCell(null);

            if (dragState().isPanning) endPan();

            setDragState({
                activeBoxId: null,
                offsetX: 0,
                offsetY: 0,
                dragGroupId: null,
                dragOriginX: 0,
                dragOriginY: 0,
                isPanning: false,
                panStartX: 0,
                panStartY: 0,
                viewportStartX: 0,
                viewportStartY: 0
            });
        };

        const onWindowWheel = (e: WheelEvent) => {
            const target = e.target instanceof Node ? e.target : null;
            if (target !== canvasContainerRef && !canvasContainerRef?.contains(target)) {
                return;
            }
            e.preventDefault();
            const vp = props.viewport();
            const rect = canvasContainerRef?.getBoundingClientRect();
            const next = zoomAt(vp, clampZoom(vp.zoom * (e.deltaY > 0 ? 0.9 : 1.1)), {
                x: e.clientX - (rect?.left ?? 0),
                y: e.clientY - (rect?.top ?? 0)
            });
            if (next === vp) return;
            props.setViewport(next);
            viewportSaver.send(next);
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

    // Anchored on the container centre so the button zooms where the user is
    // looking. Uses the container rect, not window.innerWidth/Height — the
    // canvas does not start at the viewport origin.
    const zoomByFactor = (factor: number) => {
        const vp = props.viewport();
        const rect = canvasContainerRef?.getBoundingClientRect();
        const next = zoomAt(vp, clampZoom(vp.zoom * factor), {
            x: (rect?.width ?? 0) / 2,
            y: (rect?.height ?? 0) / 2
        });
        if (next === vp) return;
        props.setViewport(next);
        persistViewportNow(next);
    };

    const zoomIn = () => zoomByFactor(1.2);
    const zoomOut = () => zoomByFactor(1 / 1.2);

    const onDelete = () => {
        if (draftToDelete()) {
            if (isLocalMode()) {
                const sourceGroupId = draftToDelete()?.group_id ?? null;
                localDeleteDraft(draftToDelete()?.Draft?.id ?? "");
                setIsDeleteDialogOpen(false);
                setDraftToDelete(null);
                refreshFromLocal();
                if (sourceGroupId) resyncGroupSize(sourceGroupId);
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

    const onPoolDeleteConfirm = () => {
        const pool = poolPendingDelete();
        if (!pool) return;
        if (isLocalMode()) {
            localDeletePool(pool.id);
            refreshFromLocal();
        } else {
            deletePoolMutation.mutate({ canvasId: canvasId(), placementId: pool.id });
        }
        if (selectedPoolId() === pool.id) setSelectedPoolId(null);
        setPoolPendingDelete(null);
    };

    const onPoolDeleteCancel = () => {
        setPoolPendingDelete(null);
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
                            class="rounded bg-darius-purple px-4 py-2 text-darius-text-primary transition-colors hover:bg-darius-purple-bright"
                        >
                            Retry
                        </button>
                    </div>
                </Show>
            }
        >
            <div
                class="relative h-full w-full select-none overflow-hidden"
                ref={(el) => {
                    canvasContainerRef = el;
                    // Capture phase so right/middle presses start a pan
                    // candidate from anywhere on the canvas — some nested
                    // surfaces (vertices, anchors) stop mousedown propagation
                    // in the bubble phase. The listener dies with the element.
                    el.addEventListener("mousedown", onAuxMouseDown, true);
                }}
                onContextMenu={handleCanvasContextMenu}
                onMouseMove={onCursorMouseMove}
            >
                <CanvasSidebar
                    icon={props.canvasData?.icon}
                    name={props.canvasData?.name}
                    description={props.canvasData?.description}
                    onZoomIn={zoomIn}
                    onZoomOut={zoomOut}
                    cardLayout={props.cardLayout()}
                    onSelectCardLayout={props.setCardLayout}
                    onImport={() => setIsImportDialogOpen(true)}
                    isConnectionMode={isConnectionMode()}
                    onToggleConnectionMode={toggleConnectionMode}
                    hasEditPermissions={canEdit()}
                    hasAdminPermissions={hasAdminPermissions() && !isLocalMode()}
                    onSettings={props.onSettings}
                    isShareOpen={props.shareAnchor === "sidebar"}
                    onOpenShare={
                        props.onOpenShare && !isLocalMode()
                            ? () => props.onOpenShare?.("sidebar")
                            : undefined
                    }
                    onCloseShare={props.onCloseShare}
                    sharePopperContent={props.sharePopperContent}
                />
                <Show when={!isLocalMode()}>
                    {/* Before CursorOverlay/PresenceStack in source order so
                        cursors and the (equal z-40) presence popover paint
                        above the laser trails. */}
                    <LaserOverlay tracker={laserTracker} viewport={props.viewport} />
                    {/* Before PresenceStack in source order so the (equal
                        z-40) presence popover paints above cursors. */}
                    <CursorOverlay
                        cursors={cursorTracker.cursors}
                        users={presenceUsers()}
                        viewport={props.viewport}
                    />
                    <PresenceStack
                        users={presenceUsers()}
                        isShareOpen={props.shareAnchor === "stack"}
                        onOpenShare={
                            props.onOpenShare
                                ? () => props.onOpenShare?.("stack")
                                : undefined
                        }
                        onCloseShare={props.onCloseShare}
                        shareContent={props.sharePopperContent}
                    />
                </Show>
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
                    <div class="absolute right-4 top-16 z-40 rounded border border-darius-purple-bright/40 bg-darius-card px-3 py-1 text-sm text-darius-purple-bright shadow">
                        Syncing...
                    </div>
                </Show>
                <div
                    class="canvas-background absolute inset-0 bg-darius-card-hover"
                    classList={{
                        "cursor-grab": !dragState().isPanning,
                        "cursor-grabbing": dragState().isPanning
                    }}
                    onMouseDown={onBackgroundMouseDown}
                >
                    {/*
                      The dot grid gets its own plane so that panning is a compositor
                      transform instead of a `background-position` rewrite that
                      invalidated this whole viewport-sized element every frame.

                      The transform MUST stay on this child and never move onto
                      `.canvas-background`. A transform there would make it a stacking
                      context and a containing block for `position: fixed`
                      descendants, and would re-invalidate a viewport-sized element on
                      every pan — the cost this plane exists to avoid. (Before slice 2
                      it would also have trapped the connection SVG below the world
                      layers; the SVG now lives inside `.canvas-world`, so that
                      particular bug is no longer reachable from here.)

                      Paint order is unchanged: this plane is positioned with
                      `z-index: auto`, so it paints at the z-0 level, below the world
                      layer and everything in it.
                    */}
                    <div
                        class="canvas-grid pointer-events-none absolute bg-[radial-gradient(circle,rgba(184,168,176,0.08)_1px,transparent_1px)]"
                        // Grid LOD. A repeating background-image on this translating
                        // plane costs ~33fps at low zoom, and the cost is the TILED
                        // REPEAT itself: a coarser pitch, an opaque layer and a
                        // pre-rasterised bitmap tile each measured at zero, while a flat
                        // fill recovered 26fps and removing it entirely recovered 33.
                        // Below the threshold the dots are 1px marks ~9.6px apart, so
                        // dropping them is most of the way to the vsync budget for
                        // almost no visual loss. `!` is needed to beat the
                        // `bg-[radial-gradient(...)]` class above.
                        classList={{ "!bg-none": lodActive() }}
                        style={{
                            inset: gridInsetStyle(),
                            "background-size": gridSizeStyle(),
                            transform: gridTransformStyle(),
                            "will-change": "transform"
                        }}
                    />
                </div>
                {/*
                  The world layer. Everything positioned in world coordinates
                  lives in this ONE element and NOTHING else does — a transformed
                  ancestor makes position:fixed descendants resolve against the
                  layer instead of the viewport, so screen-space UI must stay
                  outside it or portal.

                  Panning is a single style write on this element, O(1) in card
                  count. Nothing inside may read the viewport per-frame.

                  Sizing: zero-size with visible overflow, so the layer has no hit
                  area and clicks on empty space fall through to
                  .canvas-background beneath, which owns onBackgroundMouseDown.

                  Stacking — why the child order matters. A transform creates a
                  stacking context, so the z-indices below are resolved against
                  each other inside this layer rather than against the page. The
                  order groups (z-20) -> connection SVG (z-30) -> cards (z-30,
                  later in DOM) reproduces the pre-slice-2 root-level paint order
                  exactly: connections draw over group containers and under
                  ungrouped cards. Grouped cards are z-30 but nested inside their
                  z-20 group container, which is itself a stacking context, so
                  they stay under the connections as before.

                  a1ff629 split this in two because the SVG was still a
                  screen-space sibling outside the layer, and a single layer
                  buried every connection behind the group containers (measured:
                  522 connection px on main, 0 with one layer). Slice 2 moved the
                  SVG in here in world coordinates, which is what allows the merge.
                */}
                <div
                    class="canvas-world absolute left-0 top-0 z-30 h-0 w-0"
                    style={{
                        transform: worldTransform(props.viewport()),
                        "transform-origin": "0 0"
                    }}
                >
                    {/* Render Groups, parent-then-subtree (decision 12).

                        Pre-order DFS, NOT a depth sort: a depth sort paints
                        every depth-1 node above every depth-0 node, so a child
                        of container A would float above unrelated container B
                        and a dragged top-level container would be pinned
                        beneath every nested Group on the canvas.

                        This memo is cheap during a drag, and deliberately so
                        (plan A9): `renderOrder` reads only `id` and
                        `parent_group_id`, and Solid stores track per property —
                        so a position write, including the O(descendants)
                        subtree fan-out on every mousemove, does NOT invalidate
                        it. Do not widen what it reads. */}
                    <For each={groupsInPaintOrder()}>
                        {(group) => (
                            <Show
                                when={group.type === "series"}
                                fallback={
                                    <CustomGroupContainer
                                        group={group}
                                        drafts={getDraftsForGroup(group.id)}
                                        // Reads only `parent_group_id`, like
                                        // `renderOrder` above — so a position
                                        // write during a drag does not
                                        // invalidate it for every container.
                                        childGroupCount={
                                            childGroupsOf(canvasTree(), group.id).length
                                        }
                                        childAnnotationCount={
                                            childAnnotationsOf(canvasTree(), group.id)
                                                .length
                                        }
                                        zoom={viewportZoom}
                                        isPanning={dragState().isPanning}
                                        onGroupMouseDown={onGroupMouseDown}
                                        onBodyMouseDown={onBackgroundMouseDown}
                                        onDeleteGroup={handleDeleteGroup}
                                        onEditDisabledChampions={
                                            handleEditDisabledChampions
                                        }
                                        onRenameGroup={handleRenameGroup}
                                        onResizeGroup={handleResizeGroup}
                                        onResizeEnd={handleResizeEnd}
                                        canEdit={canEdit}
                                        isConnectionMode={isConnectionMode()}
                                        isDragTarget={dragOverGroupId() === group.id}
                                        isDragSource={
                                            dragState().activeBoxId !== null &&
                                            dragState().dragGroupId === group.id
                                        }
                                        isExitingSource={exitingGroupId() === group.id}
                                        gridItems={
                                            isGridGroup(group) ? gridItemsFor(group) : []
                                        }
                                        gridCols={gridColsFor(group)}
                                        contentMinWidth={
                                            groupContentBounds(group.id).width
                                        }
                                        contentMinHeight={
                                            groupContentBounds(group.id).height
                                        }
                                        maxLeftEdgeDelta={
                                            groupContentBounds(group.id).maxLeftEdgeDelta
                                        }
                                        onSelectAnchor={onGroupAnchorClick}
                                        isGroupSelected={
                                            groupConnectionSource() === group.id
                                        }
                                        sourceAnchor={sourceAnchor()}
                                        editingGroupId={editingGroupId}
                                        onEditingComplete={() => setEditingGroupId(null)}
                                        cardLayout={props.cardLayout}
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
                                                    zoom={viewportZoom}
                                                    lodActive={lodActive}
                                                    onBoxMouseDown={onBoxMouseDown}
                                                    cardLayout={props.cardLayout}
                                                    isConnectionMode={isConnectionMode()}
                                                    onAnchorClick={onAnchorClick}
                                                    connectionSource={
                                                        draftConnectionSource
                                                    }
                                                    sourceAnchor={sourceAnchor}
                                                    pickerTarget={pickerTarget}
                                                    onSlotOpen={openPicker}
                                                    canEdit={canEdit}
                                                    isGrouped={true}
                                                    groupType="custom"
                                                    editingDraftId={editingDraftId}
                                                    onEditingComplete={() =>
                                                        setEditingDraftId(null)
                                                    }
                                                    blueTeamName={
                                                        resolveTeamNames(cd, group).left
                                                    }
                                                    redTeamName={
                                                        resolveTeamNames(cd, group).right
                                                    }
                                                    team1NameRaw={cd.team1Name}
                                                    team2NameRaw={cd.team2Name}
                                                    onTeamNameChange={(
                                                        draftId,
                                                        field,
                                                        value
                                                    ) =>
                                                        handleUpdateDraftMetadata(
                                                            draftId,
                                                            {
                                                                [field]: value
                                                            }
                                                        )
                                                    }
                                                    restrictedChampions={() =>
                                                        getRestrictedChampionsForDraft(cd)
                                                    }
                                                    searchDimmed={() =>
                                                        searchActive() &&
                                                        !searchMatchByDraftId().has(
                                                            cd.Draft.id
                                                        )
                                                    }
                                                    searchSlotPhase={(pickIndex) =>
                                                        searchSlotPhaseFor(
                                                            cd.Draft.id,
                                                            pickIndex
                                                        )
                                                    }
                                                    searchSelected={() =>
                                                        searchSelectedDraftId() ===
                                                        cd.Draft.id
                                                    }
                                                    searchInProgress={() =>
                                                        searchMatchByDraftId().get(
                                                            cd.Draft.id
                                                        )?.inProgress ?? false
                                                    }
                                                    disabledChampions={
                                                        group.metadata.disabledChampions
                                                    }
                                                />
                                            )}
                                        </For>
                                        <For
                                            each={childAnnotationsOf(
                                                canvasTree(),
                                                group.id
                                            )}
                                        >
                                            {(annotation) => (
                                                <CanvasAnnotationItem
                                                    annotation={annotation}
                                                    isGrouped={true}
                                                    zoom={viewportZoom}
                                                    canEdit={canEdit}
                                                    isConnectionMode={isConnectionMode()}
                                                    onAnchorClick={
                                                        onAnnotationAnchorClick
                                                    }
                                                    connectionSource={
                                                        annotationConnectionSource
                                                    }
                                                    sourceAnchor={sourceAnchor}
                                                    snappedSize={() =>
                                                        isGridGroup(group)
                                                            ? snappedAnnotationSizeFor(
                                                                  group,
                                                                  annotation
                                                              )
                                                            : null
                                                    }
                                                    isSelected={() =>
                                                        selectedAnnotationId() ===
                                                        annotation.id
                                                    }
                                                    editingAnnotationId={
                                                        editingAnnotationId
                                                    }
                                                    lockedByName={() =>
                                                        annotationLockedByName(
                                                            annotation.id
                                                        )
                                                    }
                                                    onBlockedByLock={
                                                        toastAnnotationLocked
                                                    }
                                                    onEditingComplete={() =>
                                                        setEditingAnnotationId(null)
                                                    }
                                                    onStartEditing={
                                                        setEditingAnnotationId
                                                    }
                                                    onMouseDown={onAnnotationMouseDown}
                                                    isTextCollapsed={() =>
                                                        collapsedTextByFontSize[
                                                            annotation.fontSize
                                                        ]()
                                                    }
                                                    onOpenInsertPicker={openInsertPicker}
                                                    onCloseInsertPicker={
                                                        closeInsertPicker
                                                    }
                                                    insertPickerOpenFor={
                                                        insertPickerAnnotationId
                                                    }
                                                    insertedChampion={insertedChampion}
                                                    onCommitText={
                                                        handleAnnotationTextCommit
                                                    }
                                                    onResize={handleAnnotationResize}
                                                    onResizeEnd={
                                                        handleAnnotationResizeEnd
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
                                    zoom={viewportZoom}
                                    isPanning={dragState().isPanning}
                                    onGroupMouseDown={onGroupMouseDown}
                                    onBodyMouseDown={onBackgroundMouseDown}
                                    onDeleteGroup={handleDeleteGroup}
                                    onEditDisabledChampions={handleEditDisabledChampions}
                                    canEdit={canEdit}
                                    isConnectionMode={isConnectionMode()}
                                    cardLayout={props.cardLayout}
                                    onSelectAnchor={onGroupAnchorClick}
                                    isGroupSelected={groupConnectionSource() === group.id}
                                    sourceAnchor={sourceAnchor()}
                                    onUpdateDraftMetadata={handleUpdateDraftMetadata}
                                    renderDraftCard={(cd) => {
                                        return (
                                            <CanvasCard
                                                canvasId={canvasId()}
                                                canvasDraft={cd}
                                                addBox={addBox}
                                                deleteBox={deleteBox}
                                                handleNameChange={handleNameChange}
                                                handlePickChange={handlePickChange}
                                                zoom={viewportZoom}
                                                lodActive={lodActive}
                                                onBoxMouseDown={onBoxMouseDown}
                                                cardLayout={props.cardLayout}
                                                isConnectionMode={isConnectionMode()}
                                                onAnchorClick={onAnchorClick}
                                                connectionSource={draftConnectionSource}
                                                sourceAnchor={sourceAnchor}
                                                pickerTarget={pickerTarget}
                                                onSlotOpen={openPicker}
                                                canEdit={canEdit}
                                                isGrouped={true}
                                                groupType="series"
                                                editingDraftId={editingDraftId}
                                                onEditingComplete={() =>
                                                    setEditingDraftId(null)
                                                }
                                                blueTeamName={
                                                    resolveTeamNames(cd, group).left
                                                }
                                                redTeamName={
                                                    resolveTeamNames(cd, group).right
                                                }
                                                team1NameRaw={cd.team1Name}
                                                team2NameRaw={cd.team2Name}
                                                onTeamNameChange={(
                                                    draftId,
                                                    field,
                                                    value
                                                ) =>
                                                    handleUpdateDraftMetadata(draftId, {
                                                        [field]: value
                                                    })
                                                }
                                                restrictedChampions={() =>
                                                    getRestrictedChampionsForDraft(cd)
                                                }
                                                searchDimmed={() =>
                                                    searchActive() &&
                                                    !searchMatchByDraftId().has(
                                                        cd.Draft.id
                                                    )
                                                }
                                                searchSlotPhase={(pickIndex) =>
                                                    searchSlotPhaseFor(
                                                        cd.Draft.id,
                                                        pickIndex
                                                    )
                                                }
                                                searchSelected={() =>
                                                    searchSelectedDraftId() ===
                                                    cd.Draft.id
                                                }
                                                searchInProgress={() =>
                                                    searchMatchByDraftId().get(
                                                        cd.Draft.id
                                                    )?.inProgress ?? false
                                                }
                                                disabledChampions={
                                                    group.metadata.disabledChampions
                                                }
                                            />
                                        );
                                    }}
                                />
                            </Show>
                        )}
                    </For>

                    {/* Grid drop affordance — see GridDropHighlight for why it
                        lives here rather than inside the target container. */}
                    <Show when={gridDropHighlight()}>
                        {(highlight) => (
                            <GridDropHighlight
                                group={highlight().group}
                                target={highlight().target}
                                cardLayout={props.cardLayout}
                            />
                        )}
                    </Show>

                    {/*
                      Connection layer, in world coordinates. Nominal 1x1 with
                      `overflow: visible` (Tailwind's author-level rule beats the
                      UA's `svg:not(:root){overflow:hidden}`) so it paints across
                      the whole world without claiming a hit area of its own —
                      `pointer-events-none` here, `pointer-events-auto` on each
                      connection's <g>.

                      No viewBox: user units are then CSS px of the untransformed
                      layer, i.e. exactly world coordinates, with the origin at
                      world (0, 0).
                    */}
                    <svg class="pointer-events-none absolute left-0 top-0 z-30 h-px w-px overflow-visible">
                        <For each={connections}>
                            {(connection) => (
                                <ConnectionComponent
                                    connection={connection}
                                    annotations={annotations}
                                    drafts={canvasDrafts}
                                    groups={canvasGroups}
                                    annotationRect={annotationRenderRect}
                                    zoom={viewportZoom}
                                    screenToWorld={screenToWorld}
                                    onCreateVertex={handleCreateVertex}
                                    onVertexDragStart={onVertexDragStart}
                                    isConnectionMode={isConnectionMode()}
                                    onConnectionClick={handleConnectionClick}
                                    onVertexClick={handleVertexClick}
                                    selectedVertexId={
                                        selectedVertexForConnection()?.vertexId || null
                                    }
                                    cardLayout={props.cardLayout}
                                />
                            )}
                        </For>
                        <Show when={draftConnectionPreview()}>
                            {(preview) => (
                                <ConnectionPreview
                                    startDraft={preview().draft}
                                    startGroup={preview().group}
                                    seriesDraftIndex={preview().seriesDraftIndex}
                                    sourceAnchor={sourceAnchor()}
                                    mousePos={previewMousePos()}
                                    zoom={viewportZoom}
                                    cardLayout={props.cardLayout}
                                />
                            )}
                        </Show>
                        <Show when={groupConnectionPreview()}>
                            {(preview) => (
                                <GroupConnectionPreview
                                    startGroup={preview().group}
                                    sourceAnchor={sourceAnchor()}
                                    mousePos={previewMousePos()}
                                    zoom={viewportZoom}
                                    seriesDraftCount={preview().seriesDraftCount}
                                    cardLayout={props.cardLayout}
                                />
                            )}
                        </Show>
                        <Show when={annotationConnectionPreview()}>
                            {(preview) => (
                                <AnnotationConnectionPreview
                                    annotation={preview().annotation}
                                    group={preview().group}
                                    renderSize={preview().renderSize}
                                    anchor={preview().anchor}
                                    mousePos={previewMousePos()}
                                    zoom={viewportZoom}
                                />
                            )}
                        </Show>
                    </svg>

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
                                zoom={viewportZoom}
                                lodActive={lodActive}
                                onBoxMouseDown={onBoxMouseDown}
                                cardLayout={props.cardLayout}
                                isConnectionMode={isConnectionMode()}
                                onAnchorClick={onAnchorClick}
                                connectionSource={draftConnectionSource}
                                sourceAnchor={sourceAnchor}
                                pickerTarget={pickerTarget}
                                onSlotOpen={openPicker}
                                canEdit={canEdit}
                                editingDraftId={editingDraftId}
                                onEditingComplete={() => setEditingDraftId(null)}
                                blueTeamName={resolveTeamNames(cd, groupForCard(cd)).left}
                                redTeamName={resolveTeamNames(cd, groupForCard(cd)).right}
                                team1NameRaw={cd.team1Name}
                                team2NameRaw={cd.team2Name}
                                onTeamNameChange={(draftId, field, value) =>
                                    handleUpdateDraftMetadata(draftId, {
                                        [field]: value
                                    })
                                }
                                restrictedChampions={() =>
                                    getRestrictedChampionsForDraft(cd)
                                }
                                searchDimmed={() =>
                                    searchActive() &&
                                    !searchMatchByDraftId().has(cd.Draft.id)
                                }
                                searchSlotPhase={(pickIndex) =>
                                    searchSlotPhaseFor(cd.Draft.id, pickIndex)
                                }
                                searchSelected={() =>
                                    searchSelectedDraftId() === cd.Draft.id
                                }
                                searchInProgress={() =>
                                    searchMatchByDraftId().get(cd.Draft.id)?.inProgress ??
                                    false
                                }
                            />
                        )}
                    </For>
                    {/* Notes deliberately paint above connection lines (ruling
                        2026-08-14). Their anchors are edge midpoints, so a
                        connected line ends at the visible border and is barely
                        occluded. Only an unrelated pass-through line is hidden;
                        obstacle routing is a separate deferred design. */}
                    <For each={childAnnotationsOf(canvasTree(), null)}>
                        {(annotation) => (
                            <CanvasAnnotationItem
                                annotation={annotation}
                                isGrouped={false}
                                zoom={viewportZoom}
                                canEdit={canEdit}
                                isConnectionMode={isConnectionMode()}
                                onAnchorClick={onAnnotationAnchorClick}
                                connectionSource={annotationConnectionSource}
                                sourceAnchor={sourceAnchor}
                                snappedSize={() => null}
                                isSelected={() =>
                                    selectedAnnotationId() === annotation.id
                                }
                                editingAnnotationId={editingAnnotationId}
                                lockedByName={() => annotationLockedByName(annotation.id)}
                                onBlockedByLock={toastAnnotationLocked}
                                onEditingComplete={() => setEditingAnnotationId(null)}
                                onStartEditing={setEditingAnnotationId}
                                onMouseDown={onAnnotationMouseDown}
                                isTextCollapsed={() =>
                                    collapsedTextByFontSize[annotation.fontSize]()
                                }
                                onOpenInsertPicker={openInsertPicker}
                                onCloseInsertPicker={closeInsertPicker}
                                insertPickerOpenFor={insertPickerAnnotationId}
                                insertedChampion={insertedChampion}
                                onCommitText={handleAnnotationTextCommit}
                                onResize={handleAnnotationResize}
                                onResizeEnd={handleAnnotationResizeEnd}
                            />
                        )}
                    </For>
                    {/* Pool cards: pure world-space, no zoom/LOD prop by
                        design (Task 8). onStartRename sets renamingPoolId,
                        which mounts CanvasPoolCard's rename input (Task 10).
                        The op callbacks are still no-op stubs until Tasks
                        14-15 land. */}
                    <For each={canvasPools}>
                        {(pool) => (
                            <CanvasPoolCard
                                placement={pool}
                                canEdit={canEdit}
                                isSelected={() => selectedPoolId() === pool.id}
                                isRenaming={() => renamingPoolId() === pool.id}
                                onStartRename={(placementId) =>
                                    setRenamingPoolId(placementId)
                                }
                                onCommitRename={handlePoolRename}
                                onCancelRename={() => setRenamingPoolId(null)}
                                onMouseDown={onPoolMouseDown}
                                onOpenRolePicker={() => {}}
                                onRemoveChampion={() => {}}
                            />
                        )}
                    </For>
                </div>
                <Show when={searchOpen()}>
                    <CanvasSearchPanel
                        championId={searchChampionId}
                        onChampionChange={setSearchQueryChampion}
                        teamName={searchTeamName}
                        onTeamChange={setSearchQueryTeam}
                        opponentTeamName={searchOpponentName}
                        onOpponentChange={setSearchQueryOpponent}
                        teamOptions={searchTeamOptions}
                        opponentOptions={searchOpponentOptions}
                        activeBucket={searchBucket}
                        onBucketChange={setSearchQueryBucket}
                        scope={searchScope}
                        onScopeChange={setSearchQueryScope}
                        results={searchResults}
                        pinnedRows={searchPinnedRowModels}
                        resultRows={searchResultRowModels}
                        scopeHints={searchScopeHints}
                        selectedDraftId={searchSelectedDraftId}
                        onJumpToDraft={jumpToSearchDraft}
                        onTogglePin={toggleSearchPin}
                        canReturn={() => searchReturnViewport() !== null}
                        onReturn={returnFromSearchJump}
                        onClose={closeSearch}
                        focusNonce={searchFocusNonce}
                    />
                </Show>
                <Dialog
                    isOpen={isDeleteDialogOpen}
                    onCancel={onCancel}
                    onConfirm={onDelete}
                    body={
                        <>
                            <h3 class="mb-4 text-lg font-bold text-darius-text-primary">
                                Remove Draft from Canvas?
                            </h3>
                            <p class="mb-6 text-darius-text-primary">
                                This will remove "{draftToDelete()?.Draft.name}" from this
                                canvas.
                            </p>
                            <div class="flex justify-end gap-4">
                                <button
                                    onClick={onCancel}
                                    class="flex items-center gap-2 rounded bg-darius-ember px-4 py-2 text-darius-text-primary transition-[filter] hover:brightness-110"
                                >
                                    <span>Cancel</span>
                                    <EscapeKeyHint />
                                </button>
                                <button
                                    onClick={onDelete}
                                    class="flex items-center gap-2 rounded bg-darius-crimson px-4 py-2 text-darius-text-primary transition-colors hover:bg-darius-ember"
                                >
                                    <span>Remove from Canvas</span>
                                    <ReturnKeyHint />
                                </button>
                            </div>
                        </>
                    }
                />
                {/* Pools are deliverables, not disposable notes — confirm
                    before destroy (unlike annotation delete's silent
                    optimistic + rollback). Mirrors the draft-delete dialog
                    immediately above; isOpen is derived from
                    poolPendingDelete being non-null rather than a second
                    boolean signal. */}
                <Dialog
                    isOpen={() => poolPendingDelete() !== null}
                    onCancel={onPoolDeleteCancel}
                    onConfirm={onPoolDeleteConfirm}
                    body={
                        <>
                            <h3 class="mb-4 text-lg font-bold text-darius-text-primary">
                                Delete Champion Pool?
                            </h3>
                            <p class="mb-6 text-darius-text-primary">
                                This will permanently delete "
                                {poolPendingDelete()?.Pool.name}" from this canvas.
                            </p>
                            <div class="flex justify-end gap-4">
                                <button
                                    onClick={onPoolDeleteCancel}
                                    class="flex items-center gap-2 rounded bg-darius-ember px-4 py-2 text-darius-text-primary transition-[filter] hover:brightness-110"
                                >
                                    <span>Cancel</span>
                                    <EscapeKeyHint />
                                </button>
                                <button
                                    onClick={onPoolDeleteConfirm}
                                    class="flex items-center gap-2 rounded bg-darius-crimson px-4 py-2 text-darius-text-primary transition-colors hover:bg-darius-ember"
                                >
                                    <span>Delete Pool</span>
                                    <ReturnKeyHint />
                                </button>
                            </div>
                        </>
                    }
                />
                <NewPoolFromSavedDialog
                    isOpen={() => newPoolFromSavedAt() !== null}
                    onClose={() => setNewPoolFromSavedAt(null)}
                    onCreate={(payload) => {
                        const pos = newPoolFromSavedAt();
                        if (!pos) return;
                        createPoolMutation.mutate({
                            canvasId: canvasId(),
                            positionX: pos.x,
                            positionY: pos.y,
                            name: payload.name,
                            champions: payload.champions
                        });
                        setNewPoolFromSavedAt(null);
                    }}
                />
                <Dialog
                    isOpen={isImportDialogOpen}
                    onCancel={() => setIsImportDialogOpen(false)}
                    body={
                        <ImportToCanvasDialog
                            canvasId={canvasId()}
                            positionX={importPosition().x}
                            positionY={importPosition().y}
                            existingDraftNames={canvasDrafts.map((cd) => cd.Draft.name)}
                            existingGroupNames={canvasGroups.map((g) => g.name)}
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
                    onConfirm={() => {
                        const group = groupToDelete();
                        if (!group) return;
                        handleDeleteGroupWithChoice(group.type === "custom");
                    }}
                    body={
                        <Show when={groupToDelete()}>
                            {(group) => (
                                <Show
                                    when={group().type === "custom"}
                                    fallback={
                                        <>
                                            <h3 class="mb-4 text-lg font-bold text-darius-text-primary">
                                                Remove Series from Canvas?
                                            </h3>
                                            <p class="mb-4 text-darius-text-primary">
                                                This will remove "{group().name}" from
                                                this canvas.
                                            </p>
                                            <p class="mb-6 text-sm text-darius-text-secondary">
                                                Its games will leave this canvas. The
                                                original series data will not be deleted,
                                                and you can re-import it later.
                                            </p>
                                            <div class="flex justify-end gap-4">
                                                <button
                                                    onClick={onDeleteGroupCancel}
                                                    class="flex items-center gap-2 rounded bg-darius-ember px-4 py-2 text-darius-text-primary transition-[filter] hover:brightness-110"
                                                >
                                                    <span>Cancel</span>
                                                    <EscapeKeyHint />
                                                </button>
                                                <button
                                                    onClick={() =>
                                                        handleDeleteGroupWithChoice(false)
                                                    }
                                                    class="flex items-center gap-2 rounded bg-darius-crimson px-4 py-2 text-darius-text-primary transition-colors hover:bg-darius-ember"
                                                >
                                                    <span>Remove from Canvas</span>
                                                    <ReturnKeyHint />
                                                </button>
                                            </div>
                                        </>
                                    }
                                >
                                    <DeleteGroupDialog
                                        group={group()}
                                        contents={{
                                            drafts: getDraftsForGroup(group().id).length,
                                            groups: childGroupsOf(
                                                canvasTree(),
                                                group().id
                                            ).length,
                                            annotations: childAnnotationsOf(
                                                canvasTree(),
                                                group().id
                                            ).length
                                        }}
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
                {/* Group Settings Modal */}
                <GroupSettingsDialog
                    isOpen={() =>
                        disabledChampionsGroupId() !== null ||
                        pendingGroupSettingsPosition() !== null
                    }
                    onClose={closeGroupSettingsDialog}
                    defaultSeriesEnabled={pendingGroupSettingsPosition() !== null}
                    primaryLabel={
                        pendingGroupSettingsPosition() !== null ? "Create" : "Save"
                    }
                    initialName={settingsGroup()?.name ?? "Custom Series"}
                    initialChampions={settingsGroup()?.metadata.disabledChampions ?? []}
                    // ⚠️ The new default is applied on the NEW-GROUP branch
                    // only. `toDraftMode`'s `standard` fallback below is shared
                    // with every existing Group, and a legacy series with no
                    // stored `draftMode` must keep reading as `standard` —
                    // moving the fallback would silently reinterpret stored
                    // data on every canvas.
                    initialDraftMode={
                        pendingGroupSettingsPosition() !== null
                            ? NEW_GROUP_DRAFT_MODE
                            : toDraftMode(
                                  settingsGroup()?.metadata.draftMode ??
                                      settingsGroup()?.metadata.seriesType
                              )
                    }
                    isSeries={settingsGroup()?.type === "series"}
                    canEditSeriesSettings={
                        settingsGroup()?.type !== "series" ||
                        settingsGroup()?.metadata.origin === "manual"
                    }
                    initialBlueTeamName={
                        settingsGroup()?.Team1?.name ??
                        settingsGroup()?.metadata.blueTeamName ??
                        "Team 1"
                    }
                    initialRedTeamName={
                        settingsGroup()?.Team2?.name ??
                        settingsGroup()?.metadata.redTeamName ??
                        "Team 2"
                    }
                    initialTeam1Id={settingsGroup()?.team1_id ?? null}
                    initialTeam2Id={settingsGroup()?.team2_id ?? null}
                    teams={ownedTeams()}
                    teamsEnabled={teamsEnabled()}
                    onTeamCreated={handleTeamCreated}
                    initialLength={settingsGroup()?.metadata.length ?? 3}
                    initialGameType={settingsGroup()?.metadata.gameType}
                    isNewGroup={pendingGroupSettingsPosition() !== null}
                    initialLayout={settingsGroup()?.metadata.layout}
                    initialGrid={settingsGroup()?.metadata}
                    contentRowCount={(cols) => {
                        const group = settingsGroup();
                        return group ? gridRowCount(group, cols) : 0;
                    }}
                    onSave={handleSaveGroupSettings}
                />
                <GroupTeamNamesDialog
                    group={teamNamesGroup}
                    isOpen={() => teamNamesGroup() !== null}
                    onClose={() => setTeamNamesGroup(null)}
                    onSave={handleSetGroupTeamNames}
                />
                {/* Context Menu */}
                <Show when={contextMenuPosition()}>
                    {(pos) => (
                        <ContextMenu
                            class="canvas-context-menu"
                            position={pos()}
                            actions={[
                                {
                                    label: "Create Draft",
                                    action: () => {
                                        const worldPos = contextMenuWorldPosition();
                                        const group = findGroupAtPosition(
                                            worldPos.x,
                                            worldPos.y
                                        );
                                        const draftX = group
                                            ? worldPos.x - group.positionX
                                            : worldPos.x;
                                        const draftY = group
                                            ? worldPos.y - group.positionY
                                            : worldPos.y;
                                        if (isLocalMode()) {
                                            localNewDraft({
                                                name: "New Draft",
                                                picks: Array(20).fill(""),
                                                positionX: draftX,
                                                positionY: draftY,
                                                group_id: group?.id ?? null
                                            });
                                            refreshFromLocal();
                                            toast.success(
                                                "Successfully created new draft!"
                                            );
                                        } else {
                                            newDraftMutation.mutate({
                                                name: "New Draft",
                                                picks: Array(20).fill(""),
                                                public: false,
                                                canvas_id: canvasId(),
                                                positionX: draftX,
                                                positionY: draftY,
                                                group_id: group?.id ?? undefined
                                            });
                                        }
                                    }
                                },
                                {
                                    label: "Create Group",
                                    action: () => {
                                        setCreateGroupPosition(
                                            contextMenuWorldPosition()
                                        );
                                        handleCreateGroup();
                                    }
                                },
                                {
                                    label: "Create Note",
                                    action: () => {
                                        const worldPos = contextMenuWorldPosition();
                                        const group = findGroupAtPosition(
                                            worldPos.x,
                                            worldPos.y
                                        );
                                        const size = defaultAnnotationSize(
                                            props.cardLayout()
                                        );
                                        const placement = {
                                            positionX: group
                                                ? worldPos.x - group.positionX
                                                : worldPos.x,
                                            positionY: group
                                                ? worldPos.y - group.positionY
                                                : worldPos.y,
                                            width: size.width,
                                            height: size.height,
                                            group_id: group?.id ?? null
                                        };
                                        if (isLocalMode()) {
                                            const created =
                                                localCreateAnnotation(placement);
                                            refreshFromLocal();
                                            setSelectedAnnotationId(
                                                created.annotation.id
                                            );
                                            setEditingAnnotationId(created.annotation.id);
                                        } else {
                                            createAnnotationMutation.mutate({
                                                canvasId: canvasId(),
                                                ...placement
                                            });
                                        }
                                    }
                                },
                                // Free-floating v1: unlike drafts/notes there is no
                                // findGroupAtPosition branch here — a pool created
                                // over a group still lands at absolute world
                                // coordinates. "New Pool from Saved…" stays HIDDEN
                                // in local mode — it always needs auth + server
                                // (D7) — but "New Champion Pool" now works locally
                                // via localCreatePool.
                                {
                                    label: "New Champion Pool",
                                    action: () => {
                                        const worldPos = contextMenuWorldPosition();
                                        if (isLocalMode()) {
                                            const { placement } = localCreatePool({
                                                positionX: worldPos.x,
                                                positionY: worldPos.y
                                            });
                                            refreshFromLocal();
                                            setSelectedPoolId(placement.id);
                                            setRenamingPoolId(placement.id);
                                        } else {
                                            createPoolMutation.mutate({
                                                canvasId: canvasId(),
                                                positionX: worldPos.x,
                                                positionY: worldPos.y
                                            });
                                        }
                                    }
                                },
                                ...(!isLocalMode() && isAuthenticated()
                                    ? [
                                          {
                                              label: "New Pool from Saved…",
                                              action: () =>
                                                  setNewPoolFromSavedAt(
                                                      contextMenuWorldPosition()
                                                  )
                                          }
                                      ]
                                    : [])
                            ]}
                            onClose={closeContextMenu}
                        />
                    )}
                </Show>
                {/* Draft Context Menu */}
                <Show when={draftContextMenu()}>
                    {(menu) => (
                        <DraftContextMenu
                            position={menu().position}
                            draft={menu().draft}
                            onRename={
                                !canEdit() || menu().draft.is_locked
                                    ? undefined
                                    : () => {
                                          setEditingDraftId(menu().draft.Draft.id);
                                          closeDraftContextMenu();
                                      }
                            }
                            onView={() => handleDraftView(menu().draft)}
                            onGoTo={() => handleDraftGoTo(menu().draft)}
                            onCopy={
                                canEdit()
                                    ? () => handleDraftCopy(menu().draft)
                                    : undefined
                            }
                            onDelete={
                                !canEdit() ||
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
                {/* Annotation Context Menu */}
                <Show when={annotationContextMenu()}>
                    {(menu) => (
                        <AnnotationContextMenu
                            position={menu().position}
                            annotation={menu().annotation}
                            onEditText={() => {
                                setEditingAnnotationId(menu().annotation.id);
                                setAnnotationContextMenu(null);
                            }}
                            onSetColor={(color) =>
                                updateAnnotationAppearance(menu().annotation.id, {
                                    color
                                })
                            }
                            onSetFontSize={(fontSize) => {
                                updateAnnotationAppearance(menu().annotation.id, {
                                    fontSize
                                });
                                setEditingAnnotationId(menu().annotation.id);
                            }}
                            onDuplicate={() =>
                                handleAnnotationDuplicate(menu().annotation)
                            }
                            onDelete={() => {
                                const annotation = menu().annotation;
                                if (isLocalMode()) {
                                    localDeleteAnnotation(annotation.id);
                                    refreshFromLocal();
                                } else {
                                    deleteAnnotationMutation.mutate({
                                        canvasId: canvasId(),
                                        annotationId: annotation.id
                                    });
                                }
                                setSelectedAnnotationId(null);
                                setEditingAnnotationId(null);
                                if (annotation.group_id) {
                                    resyncGroupSize(annotation.group_id);
                                }
                            }}
                            onClose={() => setAnnotationContextMenu(null)}
                        />
                    )}
                </Show>
                {/* Pool Context Menu */}
                <Show when={poolContextMenu()}>
                    {(menu) => (
                        <ContextMenu
                            class="pool-context-menu"
                            header={menu().placement.Pool.name}
                            position={menu().position}
                            actions={[
                                {
                                    label: "Rename",
                                    action: () => setRenamingPoolId(menu().placement.id)
                                },
                                // "Save to My Pools" (D7, auth+server) is
                                // stubbed until Task 17 wires it to
                                // createSavedPool — omitted rather than shown
                                // disabled: ContextMenuAction has no
                                // disabled-row rendering, and a dead entry
                                // would just confuse.
                                {
                                    label: "Delete",
                                    action: () => setPoolPendingDelete(menu().placement),
                                    destructive: true
                                }
                            ]}
                            onClose={() => setPoolContextMenu(null)}
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
                                if (
                                    group.versus_draft_id &&
                                    group.metadata.origin !== "manual"
                                ) {
                                    navigate(`/versus/${group.versus_draft_id}`);
                                }
                                closeGroupContextMenu();
                            }}
                            onSetTeamNames={() => setTeamNamesGroup(menu().group)}
                            onMoveToTopLevel={() => {
                                handleMoveGroupToTopLevel(menu().group.id);
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
                {/* Connection / Vertex Context Menu */}
                <Show when={connectionContextMenu()}>
                    {(menu) => (
                        <ContextMenu
                            position={menu().position}
                            actions={
                                menu().type === "vertex"
                                    ? [
                                          {
                                              label: "Delete Vertex",
                                              destructive: true,
                                              action: () => {
                                                  handleDeleteVertex(
                                                      menu().connectionId,
                                                      menu().vertexId ?? ""
                                                  );
                                                  setConnectionContextMenu(null);
                                              }
                                          },
                                          {
                                              label: "Delete Connection",
                                              destructive: true,
                                              action: () => {
                                                  handleDeleteConnection(
                                                      menu().connectionId
                                                  );
                                                  setConnectionContextMenu(null);
                                              }
                                          }
                                      ]
                                    : [
                                          {
                                              label: "Create Vertex",
                                              action: () => {
                                                  const pos = screenToWorld(
                                                      menu().position.x,
                                                      menu().position.y
                                                  );
                                                  handleCreateVertex(
                                                      menu().connectionId,
                                                      pos.x,
                                                      pos.y
                                                  );
                                                  setConnectionContextMenu(null);
                                              }
                                          },
                                          {
                                              label: "Delete Connection",
                                              destructive: true,
                                              action: () => {
                                                  handleDeleteConnection(
                                                      menu().connectionId
                                                  );
                                                  setConnectionContextMenu(null);
                                              }
                                          }
                                      ]
                            }
                            onClose={() => setConnectionContextMenu(null)}
                        />
                    )}
                </Show>

                <CanvasChampionPicker
                    target={pickerTarget}
                    anchorSession={pickerAnchorSession}
                    onRetarget={setPickerTarget}
                    onClose={closePicker}
                    handlePickChange={handlePickChange}
                    getDraft={(draftId) =>
                        canvasDrafts.find((cd) => cd.Draft.id === draftId)
                    }
                    getUnavailableChampionIds={getUnavailableChampionIds}
                    cardLayout={props.cardLayout}
                    viewport={props.viewport}
                />
                <AnnotationChampionPicker
                    annotation={() =>
                        annotations.find((a) => a.id === insertPickerAnnotationId()) ??
                        null
                    }
                    anchorSession={insertPickerAnchorSession}
                    viewport={props.viewport}
                    onPick={(championId) => {
                        const annotationId = insertPickerAnnotationId();
                        const champion = championById.get(championId);
                        if (annotationId && champion) {
                            setInsertedChampion({
                                annotationId,
                                championName: champion.name,
                                session: insertPickerAnchorSession()
                            });
                        }
                        closeInsertPicker();
                    }}
                    onClose={closeInsertPicker}
                />
            </div>
        </Show>
    );
};

export default CanvasComponent;
