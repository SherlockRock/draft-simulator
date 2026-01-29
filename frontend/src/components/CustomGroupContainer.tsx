import { Show, createSignal, createMemo, Accessor, JSX } from "solid-js";
import { CanvasDraft, CanvasGroup, Viewport } from "../utils/types";

type CustomGroupContainerProps = {
    group: CanvasGroup;
    drafts: CanvasDraft[];
    viewport: Accessor<Viewport>;
    onGroupMouseDown: (groupId: string, e: MouseEvent) => void;
    onDeleteGroup: (groupId: string) => void;
    onRenameGroup: (groupId: string, newName: string) => void;
    onResizeGroup: (groupId: string, width: number, height: number) => void;
    canEdit: boolean;
    isConnectionMode: boolean;
    isDragTarget: boolean;
    isExitingSource: boolean;
    children: JSX.Element;
};

const MIN_WIDTH = 200;
const MIN_HEIGHT = 150;
const HEADER_HEIGHT = 48;
const PADDING = 16;

export const CustomGroupContainer = (props: CustomGroupContainerProps) => {
    const [isEditing, setIsEditing] = createSignal(false);
    const [editName, setEditName] = createSignal(props.group.name);
    const [isResizing, setIsResizing] = createSignal(false);

    const worldToScreen = (worldX: number, worldY: number) => {
        const vp = props.viewport();
        return {
            x: (worldX - vp.x) * vp.zoom,
            y: (worldY - vp.y) * vp.zoom
        };
    };

    const screenPos = () => worldToScreen(props.group.positionX, props.group.positionY);

    const groupWidth = () => props.group.width ?? 400;
    const groupHeight = () => props.group.height ?? 200;

    const handleNameClick = () => {
        if (!props.canEdit) return;
        setEditName(props.group.name);
        setIsEditing(true);
    };

    const handleNameBlur = () => {
        const newName = editName().trim();
        if (newName && newName !== props.group.name) {
            props.onRenameGroup(props.group.id, newName);
        }
        setIsEditing(false);
    };

    const handleNameKeyDown = (e: KeyboardEvent) => {
        if (e.key === "Enter") {
            (e.target as HTMLInputElement).blur();
        } else if (e.key === "Escape") {
            setEditName(props.group.name);
            setIsEditing(false);
        }
    };

    const handleResizeMouseDown = (e: MouseEvent) => {
        if (!props.canEdit) return;
        e.preventDefault();
        e.stopPropagation();
        setIsResizing(true);

        const startX = e.clientX;
        const startY = e.clientY;
        const startWidth = groupWidth();
        const startHeight = groupHeight();
        const zoom = props.viewport().zoom;

        const handleMouseMove = (moveEvent: MouseEvent) => {
            const deltaX = (moveEvent.clientX - startX) / zoom;
            const deltaY = (moveEvent.clientY - startY) / zoom;
            const newWidth = Math.max(MIN_WIDTH, startWidth + deltaX);
            const newHeight = Math.max(MIN_HEIGHT, startHeight + deltaY);
            props.onResizeGroup(props.group.id, newWidth, newHeight);
        };

        const handleMouseUp = () => {
            setIsResizing(false);
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
                "border-slate-500": !props.isDragTarget && !props.isExitingSource,
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
                    cursor: props.canEdit ? "move" : "default"
                }}
                onMouseDown={(e) => {
                    if (!isEditing()) {
                        props.onGroupMouseDown(props.group.id, e);
                    }
                }}
            >
                <div class="flex items-center gap-2 min-w-0 flex-1">
                    <Show
                        when={isEditing()}
                        fallback={
                            <span
                                class="font-semibold text-slate-50 cursor-text truncate"
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
                            class="bg-slate-700 text-slate-50 font-semibold px-1 rounded border border-slate-500 outline-none focus:border-teal-400 w-full"
                            autofocus
                        />
                    </Show>
                    <span class="text-xs text-slate-400 flex-shrink-0">
                        {draftCount()} draft{draftCount() !== 1 ? "s" : ""}
                    </span>
                </div>

                <Show when={props.canEdit}>
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
                        <div class="flex h-full items-center justify-center text-slate-500 text-sm">
                            Drag drafts here
                        </div>
                    }
                >
                    {props.children}
                </Show>
            </div>

            {/* Resize handle */}
            <Show when={props.canEdit}>
                <div
                    class="absolute bottom-0 right-0 w-4 h-4 cursor-se-resize"
                    onMouseDown={handleResizeMouseDown}
                >
                    <svg
                        class="w-3 h-3 text-slate-500 absolute bottom-1 right-1"
                        fill="currentColor"
                        viewBox="0 0 10 10"
                    >
                        <path d="M9 1L1 9M9 5L5 9M9 9L9 9" stroke="currentColor" stroke-width="1.5" fill="none" />
                    </svg>
                </div>
            </Show>
        </div>
    );
};
