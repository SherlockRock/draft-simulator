import { createSignal, createEffect, Show, createMemo, Index, Accessor } from "solid-js";
import { useNavigate } from "@solidjs/router";
import { CanvasDraft, Viewport } from "../utils/types";
import { AnchorType } from "../utils/types";
import { AnchorPoints } from "./AnchorPoints";
import { CanvasSelect } from "./CanvasSelect";
import { indexToShorthandHorizontal, indexToShorthandVertical } from "../utils/constants";
import { CUSTOM_GROUP_HEADER_HEIGHT } from "./CustomGroupContainer";

export type CanvasCardProps = {
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
    // Props for external rename triggering
    editingDraftId?: Accessor<string | null>;
    onEditingComplete?: () => void;
};

export const CanvasCard = (props: CanvasCardProps) => {
    const navigate = useNavigate();
    const [nameSignal, setNameSignal] = createSignal(props.canvasDraft.Draft.name);
    let nameInputRef: HTMLInputElement | undefined;

    createEffect(() => {
        if (props.editingDraftId?.() === props.canvasDraft.Draft.id) {
            nameInputRef?.focus();
            nameInputRef?.select();
        }
    });

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
            <div class="flex flex-col p-1">
                <div class="flex items-center justify-between">
                    <input
                        ref={nameInputRef}
                        type="text"
                        placeholder="Enter Draft Name"
                        value={nameSignal()}
                        onInput={(e) => setNameSignal(e.currentTarget.value)}
                        onKeyDown={(e) => {
                            if (e.key === "Enter" || e.key === "Escape") {
                                e.currentTarget.blur();
                            }
                        }}
                        onBlur={() => {
                            props.handleNameChange(
                                props.canvasDraft.Draft.id,
                                nameSignal()
                            );
                            props.onEditingComplete?.();
                        }}
                        class="min-w-0 flex-1 bg-transparent font-bold text-slate-50"
                        disabled={
                            props.isConnectionMode ||
                            !props.canEdit() ||
                            !!props.canvasDraft.is_locked
                        }
                    />
                    <div class="mt-1 flex gap-1">
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
                            when={props.canvasDraft.is_locked}
                            fallback={
                                <div class="group relative">
                                    <button
                                        onClick={() =>
                                            props.deleteBox(props.canvasDraft.Draft.id)
                                        }
                                        class="flex size-7 items-center justify-center rounded bg-red-400"
                                        classList={{
                                            "opacity-50 cursor-not-allowed":
                                                props.isConnectionMode ||
                                                !props.canEdit(),
                                            "cursor-pointer hover:bg-red-600":
                                                !props.isConnectionMode && props.canEdit()
                                        }}
                                        disabled={
                                            props.isConnectionMode || !props.canEdit()
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
                                            <line x1="18" y1="6" x2="6" y2="18" />
                                            <line x1="6" y1="6" x2="18" y2="18" />
                                        </svg>
                                    </button>
                                    <span class="pointer-events-none absolute -top-8 left-1/2 z-50 -translate-x-1/2 whitespace-nowrap rounded bg-slate-800 px-2 py-1 text-xs text-white opacity-0 transition-opacity group-hover:opacity-100">
                                        Delete Draft
                                    </span>
                                </div>
                            }
                        >
                            <div class="group relative">
                                <div
                                    class="flex size-7 cursor-help items-center justify-center rounded bg-slate-500"
                                    title={
                                        props.canvasDraft.Draft.versus_draft_id
                                            ? `Game ${(props.canvasDraft.Draft.seriesIndex ?? 0) + 1} of imported series. Cannot be edited.`
                                            : "Imported from versus series. Cannot be edited."
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
                                        <rect
                                            x="3"
                                            y="11"
                                            width="18"
                                            height="11"
                                            rx="2"
                                            ry="2"
                                        />
                                        <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                                    </svg>
                                </div>
                                <span class="pointer-events-none absolute -top-8 left-1/2 z-50 -translate-x-1/2 whitespace-nowrap rounded bg-slate-800 px-2 py-1 text-xs text-white opacity-0 transition-opacity group-hover:opacity-100">
                                    Locked
                                </span>
                            </div>
                        </Show>
                    </div>
                </div>
                {/* Fixed-height spacer row for consistent spacing */}
                <div class="h-5" />
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
