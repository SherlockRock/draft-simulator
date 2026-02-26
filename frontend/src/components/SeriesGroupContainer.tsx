import { For, Show, createMemo, Accessor, JSX } from "solid-js";
import { useNavigate } from "@solidjs/router";
import { ExternalLink, Check, Trash2 } from "lucide-solid";
import { CanvasDraft, CanvasGroup, Viewport } from "../utils/schemas";

type SeriesGroupContainerProps = {
    group: CanvasGroup;
    drafts: CanvasDraft[];
    viewport: Accessor<Viewport>;
    onGroupMouseDown: (groupId: string, e: MouseEvent) => void;
    onDeleteGroup: (groupId: string) => void;
    canEdit: () => boolean;
    isConnectionMode: boolean;
    // Pass-through for CanvasCard rendering
    renderDraftCard: (draft: CanvasDraft) => JSX.Element;
};

// Constants for layout
const HEADER_HEIGHT = 56;
const PADDING = 20;
const CARD_GAP = 24;

export const SeriesGroupContainer = (props: SeriesGroupContainerProps) => {
    const navigate = useNavigate();

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
                    cursor: props.canEdit() ? "move" : "default"
                }}
                onMouseDown={(e) => props.onGroupMouseDown(props.group.id, e)}
            >
                <div class="flex items-center gap-3">
                    <span class="font-semibold text-slate-50">{props.group.name}</span>

                    {/* Navigate to Series Overview */}
                    <Show when={props.group.versus_draft_id}>
                        <button
                            onClick={(e) => {
                                e.stopPropagation();
                                navigate(`/versus/${props.group.versus_draft_id}`);
                            }}
                            class="rounded p-1 text-slate-400 hover:bg-slate-600 hover:text-teal-400"
                            title="Go to series overview"
                        >
                            <ExternalLink size={16} />
                        </button>
                    </Show>

                    {/* Team Score */}
                    <div class="flex items-center gap-2 text-sm">
                        <span class="text-blue-400">
                            {props.group.metadata.blueTeamName ?? "Team 1"}
                        </span>
                        <span class="font-bold text-slate-50">
                            {teamScore().blue} - {teamScore().red}
                        </span>
                        <span class="text-red-400">
                            {props.group.metadata.redTeamName ?? "Team 2"}
                        </span>
                    </div>
                </div>

                <div class="flex items-center gap-2">
                    {/* Series Length Badge */}
                    <span
                        class="rounded px-2 py-0.5 text-xs"
                        classList={{
                            "bg-indigo-500/20 text-indigo-300":
                                (props.group.metadata.length ?? props.drafts.length) ===
                                1,
                            "bg-teal-500/20 text-teal-300":
                                (props.group.metadata.length ?? props.drafts.length) ===
                                3,
                            "bg-emerald-500/20 text-emerald-300":
                                (props.group.metadata.length ?? props.drafts.length) ===
                                5,
                            "bg-pink-500/20 text-pink-300":
                                (props.group.metadata.length ?? props.drafts.length) === 7
                        }}
                    >
                        {seriesLengthLabel()}
                    </span>

                    {/* Versus Type Badge */}
                    <Show when={versusTypeLabel()}>
                        <span
                            class="rounded px-2 py-0.5 text-xs"
                            classList={{
                                "bg-cyan-500/20 text-cyan-300":
                                    props.group.metadata.seriesType === "standard",
                                "bg-fuchsia-500/20 text-fuchsia-300":
                                    props.group.metadata.seriesType === "fearless",
                                "bg-lime-500/20 text-lime-300":
                                    props.group.metadata.seriesType === "ironman"
                            }}
                        >
                            {versusTypeLabel()}
                        </span>
                    </Show>

                    {/* Competitive Badge */}
                    <Show when={props.group.metadata.competitive}>
                        <span class="rounded bg-amber-500/20 px-2 py-0.5 text-xs text-amber-300">
                            Competitive
                        </span>
                    </Show>
                    <Show when={!props.group.metadata.competitive}>
                        <span class="rounded bg-sky-500/20 px-2 py-0.5 text-xs text-sky-300">
                            Scrim
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
                            {/* TODO: DRA-40 - Review: was filled icon */}
                            <Check size={12} />
                            Completed
                        </span>
                    </Show>

                    {/* Delete Button */}
                    <Show when={props.canEdit()}>
                        <button
                            onClick={(e) => {
                                e.stopPropagation();
                                props.onDeleteGroup(props.group.id);
                            }}
                            class="rounded p-1 text-slate-400 hover:bg-slate-700 hover:text-red-400"
                            title="Remove series from canvas"
                        >
                            <Trash2 size={16} />
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
