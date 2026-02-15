import { Show, createSignal, createMemo, createEffect, Accessor, JSX } from "solid-js";
import { CanvasDraft, CanvasGroup, Viewport, AnchorType } from "../utils/schemas";

type CustomGroupContainerProps = {
    group: CanvasGroup;
    drafts: CanvasDraft[];
    viewport: Accessor<Viewport>;
    onGroupMouseDown: (groupId: string, e: MouseEvent) => void;
    onDeleteGroup: (groupId: string) => void;
    onRenameGroup: (groupId: string, newName: string) => void;
    onResizeGroup: (groupId: string, width: number, height: number) => void;
    onResizeEnd: (groupId: string, width: number, height: number) => void;
    canEdit: () => boolean;
    isConnectionMode: boolean;
    isDragTarget: boolean;
    isExitingSource: boolean;
    contentMinWidth: number;
    contentMinHeight: number;
    onSelectAnchor?: (groupId: string, anchorType: AnchorType) => void;
    isGroupSelected?: boolean;
    sourceAnchor?: { type: AnchorType } | null;
    editingGroupId?: Accessor<string | null>;
    onContextMenu?: (group: CanvasGroup, e: MouseEvent) => void;
    onEditingComplete?: () => void;
    children: JSX.Element;
};

const MIN_WIDTH = 200;
const MIN_HEIGHT = 150;
export const CUSTOM_GROUP_HEADER_HEIGHT = 48;
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

    const handleResizeMouseDown = (e: MouseEvent) => {
        if (!props.canEdit()) return;
        e.preventDefault();
        e.stopPropagation();

        const startX = e.clientX;
        const startY = e.clientY;
        const startWidth = groupWidth();
        const startHeight = groupHeight();
        const zoom = props.viewport().zoom;

        const handleMouseMove = (moveEvent: MouseEvent) => {
            const deltaX = (moveEvent.clientX - startX) / zoom;
            const deltaY = (moveEvent.clientY - startY) / zoom;
            const rawWidth = startWidth + deltaX;
            const rawHeight = startHeight + deltaY;
            const minW = effectiveMinWidth();
            const minH = effectiveMinHeight();
            const newWidth = Math.max(minW, rawWidth);
            const newHeight = Math.max(minH, rawHeight);
            setIsResizeClamped(rawWidth < minW || rawHeight < minH);
            setLocalWidth(newWidth);
            setLocalHeight(newHeight);
            props.onResizeGroup(props.group.id, newWidth, newHeight);
        };

        const handleMouseUp = () => {
            const finalWidth = groupWidth();
            const finalHeight = groupHeight();
            setIsResizeClamped(false);
            setLocalWidth(null);
            setLocalHeight(null);
            props.onResizeEnd(props.group.id, finalWidth, finalHeight);
            window.removeEventListener("mousemove", handleMouseMove);
            window.removeEventListener("mouseup", handleMouseUp);
        };

        window.addEventListener("mousemove", handleMouseMove);
        window.addEventListener("mouseup", handleMouseUp);
    };

    const draftCount = createMemo(() => props.drafts.length);

    return (
        <div
            class="absolute z-20 rounded-lg border-2 bg-slate-700 shadow-xl"
            classList={{
                "border-slate-500":
                    !props.isDragTarget && !props.isExitingSource && !isResizeClamped(),
                "border-red-500 ring-2 ring-red-500/30": isResizeClamped(),
                "border-teal-400 ring-2 ring-teal-400/50": props.isDragTarget,
                "border-slate-600 opacity-75": props.isExitingSource,
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
            onMouseDown={(e) => e.stopPropagation()}
        >
            {/* Header */}
            <div
                class="flex items-center justify-between rounded-t-lg bg-slate-800 px-3"
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
                                class="cursor-text truncate font-semibold text-slate-50"
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
                            class="w-full rounded border border-slate-500 bg-slate-700 px-1 font-semibold text-slate-50 outline-none focus:border-teal-400"
                            autofocus
                        />
                    </Show>
                    <span class="flex-shrink-0 text-xs text-slate-400">
                        {draftCount()} draft{draftCount() !== 1 ? "s" : ""}
                    </span>
                </div>

                <Show when={props.canEdit()}>
                    <button
                        onClick={(e) => {
                            e.stopPropagation();
                            props.onDeleteGroup(props.group.id);
                        }}
                        class="rounded p-1 text-slate-400 hover:bg-slate-700 hover:text-red-400"
                        title="Delete group"
                    >
                        <svg
                            class="h-4 w-4"
                            fill="none"
                            stroke="currentColor"
                            viewBox="0 0 24 24"
                        >
                            <path
                                stroke-linecap="round"
                                stroke-linejoin="round"
                                stroke-width="2"
                                d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
                            />
                        </svg>
                    </button>
                </Show>
            </div>

            {/* Content area */}
            <div
                class="relative"
                style={{
                    height: `${groupHeight() - HEADER_HEIGHT}px`,
                    padding: `${PADDING}px`
                }}
            >
                <Show
                    when={draftCount() > 0}
                    fallback={
                        <div class="flex h-full items-center justify-center text-sm text-slate-500">
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

            {/* Resize handle */}
            <Show when={props.canEdit()}>
                <div
                    class="absolute bottom-0 right-0 h-4 w-4 cursor-se-resize"
                    onMouseDown={handleResizeMouseDown}
                >
                    <svg
                        class="absolute bottom-1 right-1 h-3 w-3 text-slate-500"
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

const GroupAnchorPoints = (props: {
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
        `pointer-events-auto absolute -translate-x-1/2 -translate-y-1/2 cursor-pointer rounded-full ${
            props.isSelected && props.sourceAnchor?.type === type
                ? "bg-purple-400 hover:bg-purple-600"
                : "bg-orange-400 hover:bg-orange-500"
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
