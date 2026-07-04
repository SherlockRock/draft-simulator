import {
    Show,
    For,
    createSignal,
    createMemo,
    createEffect,
    Accessor,
    JSX
} from "solid-js";
import { Trash2, Settings } from "lucide-solid";
import { CanvasDraft, CanvasGroup, Viewport, AnchorType } from "../utils/schemas";
import {
    GRID_HEADER_HEIGHT,
    GRID_PADDING,
    GRID_CELL_GAP,
    GridCell,
    isGridGroup,
    gridColsOf,
    cellToPosition,
    positionToCell
} from "../utils/gridLayout";
import { cardWidth, cardHeight } from "../utils/helpers";
import type { CardLayout } from "../utils/canvasCardLayout";

type CustomGroupContainerProps = {
    group: CanvasGroup;
    drafts: CanvasDraft[];
    viewport: Accessor<Viewport>;
    isPanning: boolean;
    onGroupMouseDown: (groupId: string, e: MouseEvent) => void;
    onBodyMouseDown: (e: MouseEvent) => void;
    onDeleteGroup: (groupId: string) => void;
    onEditDisabledChampions: (groupId: string) => void;
    onRenameGroup: (groupId: string, newName: string) => void;
    onResizeGroup: (
        groupId: string,
        width: number,
        height: number,
        positionX?: number,
        leftEdgeDelta?: number
    ) => void;
    onResizeEnd: (
        groupId: string,
        width: number,
        height: number,
        positionX?: number,
        leftEdgeDelta?: number
    ) => void;
    canEdit: () => boolean;
    isConnectionMode: boolean;
    isDragTarget: boolean;
    // A member of this group is being dragged (intra-group drag) — the
    // grid hints should show even though the group isn't the drag target.
    isDragSource: boolean;
    // Cell the dragged card would land in, or null when none applies.
    highlightCell: GridCell | null;
    isExitingSource: boolean;
    contentMinWidth: number;
    contentMinHeight: number;
    maxLeftEdgeDelta: number;
    onSelectAnchor?: (groupId: string, anchorType: AnchorType) => void;
    isGroupSelected?: boolean;
    sourceAnchor?: { type: AnchorType } | null;
    editingGroupId?: Accessor<string | null>;
    onContextMenu?: (group: CanvasGroup, e: MouseEvent) => void;
    onEditingComplete?: () => void;
    cardLayout: () => CardLayout;
    children: JSX.Element;
};

const MIN_WIDTH = 200;
const MIN_HEIGHT = 150;
export const CUSTOM_GROUP_HEADER_HEIGHT = GRID_HEADER_HEIGHT;
const HEADER_HEIGHT = CUSTOM_GROUP_HEADER_HEIGHT;
const PADDING = 16;

export const CustomGroupContainer = (props: CustomGroupContainerProps) => {
    const [isEditing, setIsEditing] = createSignal(false);
    const [editName, setEditName] = createSignal(props.group.name);
    const [localWidth, setLocalWidth] = createSignal<number | null>(null);
    const [localHeight, setLocalHeight] = createSignal<number | null>(null);
    const [isResizeClamped, setIsResizeClamped] = createSignal(false);

    createEffect(() => {
        if (props.editingGroupId?.() === props.group.id) {
            setEditName(props.group.name);
            setIsEditing(true);
        }
    });

    const worldToScreen = (worldX: number, worldY: number) => {
        const vp = props.viewport();
        return {
            x: (worldX - vp.x) * vp.zoom,
            y: (worldY - vp.y) * vp.zoom
        };
    };

    const screenPos = () => worldToScreen(props.group.positionX, props.group.positionY);

    const groupWidth = () => localWidth() ?? props.group.width ?? 400;
    const groupHeight = () => localHeight() ?? props.group.height ?? 200;

    const handleNameClick = () => {
        if (!props.canEdit()) return;
        setEditName(props.group.name);
        setIsEditing(true);
    };

    const handleNameBlur = () => {
        const newName = editName().trim();
        if (newName && newName !== props.group.name) {
            props.onRenameGroup(props.group.id, newName);
        }
        setIsEditing(false);
        props.onEditingComplete?.();
    };

    const handleNameKeyDown = (e: KeyboardEvent) => {
        if (e.key === "Enter") {
            (e.target as HTMLInputElement).blur();
        } else if (e.key === "Escape") {
            setEditName(props.group.name);
            setIsEditing(false);
            props.onEditingComplete?.();
        }
    };

    const effectiveMinWidth = () => Math.max(MIN_WIDTH, props.contentMinWidth);
    const effectiveMinHeight = () => Math.max(MIN_HEIGHT, props.contentMinHeight);

    const handleResizeMouseDown = (e: MouseEvent, edge: "left" | "right") => {
        if (!props.canEdit()) return;
        e.preventDefault();
        e.stopPropagation();

        const startX = e.clientX;
        const startY = e.clientY;
        const startWidth = groupWidth();
        const startHeight = groupHeight();
        const startPositionX = props.group.positionX;
        const startMaxLeftEdgeDelta = props.maxLeftEdgeDelta;
        const zoom = props.viewport().zoom;

        const handleMouseMove = (moveEvent: MouseEvent) => {
            const deltaX = (moveEvent.clientX - startX) / zoom;
            const deltaY = (moveEvent.clientY - startY) / zoom;
            const rawWidth = edge === "left" ? startWidth - deltaX : startWidth + deltaX;
            const rawHeight = startHeight + deltaY;
            const minW =
                edge === "left"
                    ? Math.max(MIN_WIDTH, startWidth - startMaxLeftEdgeDelta)
                    : effectiveMinWidth();
            const minH = effectiveMinHeight();
            const newWidth = Math.max(minW, rawWidth);
            const newHeight = Math.max(minH, rawHeight);
            const widthDelta = startWidth - newWidth;
            const newPositionX =
                edge === "left" ? startPositionX + widthDelta : undefined;
            const leftEdgeDelta = edge === "left" ? widthDelta : undefined;
            setIsResizeClamped(rawWidth < minW || rawHeight < minH);
            setLocalWidth(newWidth);
            setLocalHeight(newHeight);
            props.onResizeGroup(
                props.group.id,
                newWidth,
                newHeight,
                newPositionX,
                leftEdgeDelta
            );
        };

        const handleMouseUp = () => {
            const finalWidth = groupWidth();
            const finalHeight = groupHeight();
            const finalPositionX =
                edge === "left" ? startPositionX + (startWidth - finalWidth) : undefined;
            const finalLeftEdgeDelta =
                edge === "left" ? startWidth - finalWidth : undefined;
            setIsResizeClamped(false);
            setLocalWidth(null);
            setLocalHeight(null);
            props.onResizeEnd(
                props.group.id,
                finalWidth,
                finalHeight,
                finalPositionX,
                finalLeftEdgeDelta
            );
            window.removeEventListener("mousemove", handleMouseMove);
            window.removeEventListener("mouseup", handleMouseUp);
        };

        window.addEventListener("mousemove", handleMouseMove);
        window.addEventListener("mouseup", handleMouseUp);
    };

    const draftCount = createMemo(() => props.drafts.length);

    const isGrid = () => isGridGroup(props.group);

    // Cells covering every row the group currently shows: enough for the
    // occupied rows plus a growth row, and enough to fill the group's height
    // when the user has resized it taller (so empty rows read as drop targets).
    const hintCells = createMemo<GridCell[]>(() => {
        if (!isGrid()) return [];
        const cols = gridColsOf(props.group);
        const layout = props.cardLayout();
        let maxRow = 0;
        for (const d of props.drafts) {
            maxRow = Math.max(
                maxRow,
                positionToCell(d.positionX, d.positionY, layout, cols).row
            );
        }
        const cellH = cardHeight(layout) + GRID_CELL_GAP;
        const availH = groupHeight() - GRID_HEADER_HEIGHT - 2 * GRID_PADDING + GRID_CELL_GAP;
        const rowsFromHeight = Math.max(1, Math.floor(availH / cellH));
        const totalRows = Math.max(maxRow + 2, rowsFromHeight);
        const cells: GridCell[] = [];
        for (let row = 0; row < totalRows; row++) {
            for (let col = 0; col < cols; col++) {
                cells.push({ row, col });
            }
        }
        return cells;
    });

    return (
        <div
            class="group-container absolute z-20 rounded-xl border-2 bg-darius-card/90 shadow-xl backdrop-blur-sm"
            classList={{
                "border-darius-border":
                    !props.isDragTarget && !props.isExitingSource && !isResizeClamped(),
                "border-red-500 ring-2 ring-red-500/30": isResizeClamped(),
                "border-darius-purple-bright ring-2 ring-darius-purple-bright/30":
                    props.isDragTarget,
                "border-darius-border opacity-75": props.isExitingSource,
                "border-dashed": draftCount() === 0
            }}
            style={{
                left: `${screenPos().x}px`,
                top: `${screenPos().y}px`,
                width: `${groupWidth()}px`,
                height: `${groupHeight()}px`,
                transform: `scale(${props.viewport().zoom})`,
                "transform-origin": "top left"
            }}
        >
            {/* Header */}
            <div
                class="flex items-center justify-between rounded-t-xl border-b border-darius-border/80 bg-darius-bg/70 px-3"
                style={{
                    height: `${HEADER_HEIGHT}px`,
                    cursor: props.canEdit() ? "move" : "default"
                }}
                onMouseDown={(e) => {
                    if (!isEditing()) {
                        props.onGroupMouseDown(props.group.id, e);
                    }
                }}
                onContextMenu={(e) => {
                    if (props.canEdit() && props.onContextMenu) {
                        e.preventDefault();
                        props.onContextMenu(props.group, e);
                    }
                }}
            >
                <div class="flex min-w-0 flex-1 items-center gap-2">
                    <Show
                        when={isEditing()}
                        fallback={
                            <span
                                class="cursor-text truncate font-semibold text-darius-text-primary"
                                onClick={handleNameClick}
                            >
                                {props.group.name}
                            </span>
                        }
                    >
                        <input
                            type="text"
                            value={editName()}
                            onInput={(e) => setEditName(e.currentTarget.value)}
                            onBlur={handleNameBlur}
                            onKeyDown={handleNameKeyDown}
                            class="w-full rounded border border-darius-border bg-darius-card px-1 font-semibold text-darius-text-primary outline-none focus:border-darius-purple-bright"
                            autofocus
                        />
                    </Show>
                    <span class="flex-shrink-0 text-xs text-darius-text-secondary">
                        {draftCount()} draft{draftCount() !== 1 ? "s" : ""}
                    </span>
                </div>

                <Show when={props.canEdit()}>
                    <div class="flex items-center gap-1">
                        <button
                            onClick={(e) => {
                                e.stopPropagation();
                                props.onEditDisabledChampions(props.group.id);
                            }}
                            class="rounded p-1 text-darius-purple-bright transition-colors hover:bg-darius-card-hover hover:text-darius-text-primary"
                            title="Disabled champions"
                        >
                            <Settings size={16} />
                        </button>
                        <button
                            onClick={(e) => {
                                e.stopPropagation();
                                props.onDeleteGroup(props.group.id);
                            }}
                            class="rounded p-1 text-darius-text-secondary transition-colors hover:bg-darius-card-hover hover:text-darius-crimson"
                            title="Delete group"
                        >
                            <Trash2 size={16} />
                        </button>
                    </div>
                </Show>
            </div>

            {/* Drag-time grid cell hints */}
            <Show when={isGrid() && (props.isDragTarget || props.isDragSource)}>
                <div class="pointer-events-none absolute inset-0">
                    <For each={hintCells()}>
                        {(cell) => {
                            const pos = cellToPosition(cell, props.cardLayout());
                            const isHighlighted = () =>
                                props.highlightCell?.row === cell.row &&
                                props.highlightCell?.col === cell.col;
                            return (
                                <div
                                    class="absolute rounded-lg border-2"
                                    classList={{
                                        "border-dashed border-darius-border/40":
                                            !isHighlighted(),
                                        "border-darius-purple-bright bg-darius-purple-bright/10":
                                            isHighlighted()
                                    }}
                                    style={{
                                        left: `${pos.x}px`,
                                        top: `${pos.y}px`,
                                        width: `${cardWidth(props.cardLayout())}px`,
                                        height: `${cardHeight(props.cardLayout())}px`
                                    }}
                                />
                            );
                        }}
                    </For>
                </div>
            </Show>

            {/* Row / column labels rendered just outside the container edges */}
            <Show when={isGrid()}>
                <For each={props.group.metadata.colLabels ?? []}>
                    {(label, i) => (
                        <Show when={label.trim().length > 0}>
                            <div
                                class="pointer-events-none absolute -top-6 truncate text-center text-xs font-semibold text-darius-text-secondary"
                                style={{
                                    left: `${cellToPosition({ row: 0, col: i() }, props.cardLayout()).x}px`,
                                    width: `${cardWidth(props.cardLayout())}px`
                                }}
                            >
                                {label}
                            </div>
                        </Show>
                    )}
                </For>
                <For each={props.group.metadata.rowLabels ?? []}>
                    {(label, i) => (
                        <Show when={label.trim().length > 0}>
                            <div
                                class="pointer-events-none absolute -ml-2 max-w-32 -translate-x-full truncate text-right text-xs font-semibold text-darius-text-secondary"
                                style={{
                                    left: "0px",
                                    top: `${
                                        cellToPosition({ row: i(), col: 0 }, props.cardLayout()).y +
                                        cardHeight(props.cardLayout()) / 2
                                    }px`
                                }}
                            >
                                {label}
                            </div>
                        </Show>
                    )}
                </For>
            </Show>

            {/* Content area */}
            <div
                class="relative"
                classList={{
                    "cursor-grab": !props.isPanning,
                    "cursor-grabbing": props.isPanning
                }}
                style={{
                    height: `${groupHeight() - HEADER_HEIGHT}px`,
                    padding: `${PADDING}px`
                }}
                onMouseDown={(e) => {
                    const target = e.target;
                    if (
                        !(target instanceof Element) ||
                        !target.closest(
                            '[data-canvas-select-root="true"], [data-canvas-drag-root="true"], input, button, select, textarea'
                        )
                    ) {
                        props.onBodyMouseDown(e);
                    }
                }}
                onContextMenu={(e) => {
                    // Right-clicking empty group space opens the group menu.
                    // Cards handle their own context menu, so ignore those.
                    const target = e.target;
                    if (target instanceof Element && target.closest(".canvas-card")) {
                        return;
                    }
                    if (props.canEdit() && props.onContextMenu) {
                        e.preventDefault();
                        e.stopPropagation();
                        props.onContextMenu(props.group, e);
                    }
                }}
            >
                <Show
                    when={draftCount() > 0}
                    fallback={
                        <div class="flex h-full items-center justify-center text-sm text-darius-text-secondary">
                            Drag drafts here
                        </div>
                    }
                >
                    {props.children}
                </Show>
            </div>

            {/* Group anchor points for connections */}
            <Show when={props.isConnectionMode && props.onSelectAnchor}>
                <GroupAnchorPoints
                    groupId={props.group.id}
                    width={groupWidth()}
                    height={groupHeight()}
                    zoom={props.viewport().zoom}
                    onSelectAnchor={props.onSelectAnchor!}
                    isSelected={props.isGroupSelected ?? false}
                    sourceAnchor={props.sourceAnchor ?? null}
                />
            </Show>

            {/* Resize handle — in grid mode, resizing taller exposes empty rows */}
            <Show when={props.canEdit()}>
                <div
                    class="absolute bottom-0 left-0 h-4 w-4 cursor-sw-resize"
                    onMouseDown={(e) => handleResizeMouseDown(e, "left")}
                >
                    <svg
                        class="absolute bottom-1 left-1 h-3 w-3 text-darius-text-secondary"
                        fill="currentColor"
                        viewBox="0 0 10 10"
                    >
                        <path
                            d="M1 1L9 9M1 5L5 9M1 9L1 9"
                            stroke="currentColor"
                            stroke-width="1.5"
                            fill="none"
                        />
                    </svg>
                </div>
                <div
                    class="absolute bottom-0 right-0 h-4 w-4 cursor-se-resize"
                    onMouseDown={(e) => handleResizeMouseDown(e, "right")}
                >
                    <svg
                        class="absolute bottom-1 right-1 h-3 w-3 text-darius-text-secondary"
                        fill="currentColor"
                        viewBox="0 0 10 10"
                    >
                        <path
                            d="M9 1L1 9M9 5L5 9M9 9L9 9"
                            stroke="currentColor"
                            stroke-width="1.5"
                            fill="none"
                        />
                    </svg>
                </div>
            </Show>
        </div>
    );
};

export const GroupAnchorPoints = (props: {
    groupId: string;
    width: number;
    height: number;
    zoom: number;
    onSelectAnchor: (groupId: string, anchorType: AnchorType) => void;
    isSelected: boolean;
    sourceAnchor: { type: AnchorType } | null;
}) => {
    const anchorSize = () => Math.max(8, 10 / props.zoom);

    const anchorClass = (type: AnchorType) =>
        `pointer-events-auto absolute -translate-x-1/2 -translate-y-1/2 cursor-pointer rounded-full border border-darius-border/70 shadow-[0_0_0_1px_rgba(26,16,24,0.55)] ${
            props.isSelected && props.sourceAnchor?.type === type
                ? "bg-darius-purple-bright"
                : "bg-darius-ember hover:bg-darius-crimson"
        }`;

    return (
        <div class="pointer-events-none absolute inset-0">
            {/* Top */}
            <div
                class={anchorClass("top")}
                style={{
                    width: `${anchorSize()}px`,
                    height: `${anchorSize()}px`,
                    left: `${props.width / 2}px`,
                    top: "0px"
                }}
                onMouseDown={(e) => {
                    e.stopPropagation();
                    props.onSelectAnchor(props.groupId, "top");
                }}
            />
            {/* Bottom */}
            <div
                class={anchorClass("bottom")}
                style={{
                    width: `${anchorSize()}px`,
                    height: `${anchorSize()}px`,
                    left: `${props.width / 2}px`,
                    top: `${props.height}px`
                }}
                onMouseDown={(e) => {
                    e.stopPropagation();
                    props.onSelectAnchor(props.groupId, "bottom");
                }}
            />
            {/* Left */}
            <div
                class={anchorClass("left")}
                style={{
                    width: `${anchorSize()}px`,
                    height: `${anchorSize()}px`,
                    left: "0px",
                    top: `${props.height / 2}px`
                }}
                onMouseDown={(e) => {
                    e.stopPropagation();
                    props.onSelectAnchor(props.groupId, "left");
                }}
            />
            {/* Right */}
            <div
                class={anchorClass("right")}
                style={{
                    width: `${anchorSize()}px`,
                    height: `${anchorSize()}px`,
                    left: `${props.width}px`,
                    top: `${props.height / 2}px`
                }}
                onMouseDown={(e) => {
                    e.stopPropagation();
                    props.onSelectAnchor(props.groupId, "right");
                }}
            />
        </div>
    );
};
