import { For, Show, createMemo, Accessor, JSX } from "solid-js";
import { CanvasDraft, CanvasGroup, Viewport } from "../utils/types";

type SeriesGroupContainerProps = {
    group: CanvasGroup;
    drafts: CanvasDraft[];
    viewport: Accessor<Viewport>;
    onGroupMouseDown: (groupId: string, e: MouseEvent) => void;
    onDeleteGroup: (groupId: string) => void;
    canEdit: boolean;
    isConnectionMode: boolean;
    // Pass-through for CanvasCard rendering
    renderDraftCard: (draft: CanvasDraft) => JSX.Element;
};

// Constants for layout
const HEADER_HEIGHT = 56;
const PADDING = 20;
const CARD_GAP = 24;

export const SeriesGroupContainer = (props: SeriesGroupContainerProps) => {
    const worldToScreen = (worldX: number, worldY: number) => {
        const vp = props.viewport();
        return {
            x: (worldX - vp.x) * vp.zoom,
            y: (worldY - vp.y) * vp.zoom
        };
    };

    const screenPos = () => worldToScreen(props.group.positionX, props.group.positionY);

    const sortedDrafts = createMemo(() => {
        return [...props.drafts].sort(
            (a, b) => (a.Draft.seriesIndex ?? 0) - (b.Draft.seriesIndex ?? 0)
        );
    });

    const teamScore = createMemo(() => {
        let blueWins = 0;
        let redWins = 0;
        props.drafts.forEach((d) => {
            if (d.Draft.winner === "blue") blueWins++;
            if (d.Draft.winner === "red") redWins++;
        });
        return { blue: blueWins, red: redWins };
    });

    const isCompleted = createMemo(() => {
        return props.drafts.length > 0 && props.drafts.every((d) => d.Draft.completed);
    });

    const seriesLengthLabel = createMemo(() => {
        const len = props.group.metadata.length ?? props.drafts.length;
        return `Bo${len}`;
    });

    const versusTypeLabel = createMemo(() => {
        const type = props.group.metadata.seriesType;
        if (!type) return null;
        // Capitalize first letter
        return type.charAt(0).toUpperCase() + type.slice(1);
    });

    return (
        <div
            class="absolute z-20 rounded-lg border-2 border-slate-500 bg-slate-700 shadow-xl"
            style={{
                left: `${screenPos().x}px`,
                top: `${screenPos().y}px`,
                transform: `scale(${props.viewport().zoom})`,
                "transform-origin": "top left"
            }}
            onMouseDown={(e) => e.stopPropagation()}
        >
            {/* Header */}
            <div
                class="flex items-center justify-between rounded-t-lg bg-slate-800 px-4"
                style={{
                    height: `${HEADER_HEIGHT}px`,
                    cursor: props.canEdit ? "move" : "default"
                }}
                onMouseDown={(e) => props.onGroupMouseDown(props.group.id, e)}
            >
                <div class="flex items-center gap-3">
                    <span class="font-semibold text-slate-50">{props.group.name}</span>

                    {/* Team Score */}
                    <div class="flex items-center gap-2 text-sm">
                        <span class="text-blue-400">
                            {props.group.metadata.blueTeamName ?? "Blue Team"}
                        </span>
                        <span class="font-bold text-slate-50">
                            {teamScore().blue} - {teamScore().red}
                        </span>
                        <span class="text-red-400">
                            {props.group.metadata.redTeamName ?? "Red Team"}
                        </span>
                    </div>
                </div>

                <div class="flex items-center gap-2">
                    {/* Series Length Badge */}
                    <span class="rounded bg-slate-600 px-2 py-0.5 text-xs text-slate-300">
                        {seriesLengthLabel()}
                    </span>

                    {/* Versus Type Badge */}
                    <Show when={versusTypeLabel()}>
                        <span
                            class="rounded px-2 py-0.5 text-xs"
                            classList={{
                                "bg-blue-600/30 text-blue-300":
                                    props.group.metadata.seriesType === "standard",
                                "bg-purple-600/30 text-purple-300":
                                    props.group.metadata.seriesType === "fearless",
                                "bg-red-600/30 text-red-300":
                                    props.group.metadata.seriesType === "ironman"
                            }}
                        >
                            {versusTypeLabel()}
                        </span>
                    </Show>

                    {/* Competitive Badge */}
                    <Show when={props.group.metadata.competitive}>
                        <span class="rounded bg-amber-600/30 px-2 py-0.5 text-xs text-amber-300">
                            Competitive
                        </span>
                    </Show>
                    <Show when={!props.group.metadata.competitive}>
                        <span class="rounded bg-slate-600 px-2 py-0.5 text-xs text-slate-400">
                            Casual
                        </span>
                    </Show>

                    {/* Status Indicator */}
                    <Show
                        when={isCompleted()}
                        fallback={
                            <span class="flex items-center gap-1 text-xs text-yellow-400">
                                <span class="h-2 w-2 rounded-full bg-yellow-400" />
                                In Progress
                            </span>
                        }
                    >
                        <span class="flex items-center gap-1 text-xs text-green-400">
                            <svg class="h-3 w-3" fill="currentColor" viewBox="0 0 20 20">
                                <path
                                    fill-rule="evenodd"
                                    d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z"
                                    clip-rule="evenodd"
                                />
                            </svg>
                            Completed
                        </span>
                    </Show>

                    {/* Delete Button */}
                    <Show when={props.canEdit}>
                        <button
                            onClick={(e) => {
                                e.stopPropagation();
                                props.onDeleteGroup(props.group.id);
                            }}
                            class="rounded p-1 text-slate-400 hover:bg-slate-700 hover:text-red-400"
                            title="Remove series from canvas"
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
            </div>

            {/* Draft Cards Container - uses flexbox for layout */}
            <div
                class="flex items-start"
                style={{
                    padding: `${PADDING}px`,
                    gap: `${CARD_GAP}px`
                }}
            >
                <For each={sortedDrafts()}>{(draft) => props.renderDraftCard(draft)}</For>
            </div>
        </div>
    );
};
