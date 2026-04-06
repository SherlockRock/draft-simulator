import { For, Show, createMemo, Accessor, JSX } from "solid-js";
import { useNavigate } from "@solidjs/router";
import { ExternalLink, Check, Trash2, Settings } from "lucide-solid";
import { CanvasDraft, CanvasGroup, Viewport, AnchorType } from "../utils/schemas";
import {
    getSeriesGroupDimensions,
    SERIES_CARD_GAP,
    SERIES_HEADER_HEIGHT,
    SERIES_PADDING
} from "../utils/helpers";
import { GroupAnchorPoints } from "./CustomGroupContainer";
import type { CardLayout } from "../utils/canvasCardLayout";

type SeriesGroupContainerProps = {
    group: CanvasGroup;
    drafts: CanvasDraft[];
    viewport: Accessor<Viewport>;
    isPanning: boolean;
    onGroupMouseDown: (groupId: string, e: MouseEvent) => void;
    onBodyMouseDown: (e: MouseEvent) => void;
    onDeleteGroup: (groupId: string) => void;
    onEditDisabledChampions: (groupId: string) => void;
    canEdit: () => boolean;
    isConnectionMode: boolean;
    cardLayout: () => CardLayout;
    // Pass-through for CanvasCard rendering
    renderDraftCard: (draft: CanvasDraft) => JSX.Element;
    // Connection anchor props
    onSelectAnchor?: (groupId: string, anchorType: AnchorType) => void;
    isGroupSelected?: boolean;
    sourceAnchor?: { type: AnchorType } | null;
};

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

    const groupDimensions = createMemo(() =>
        getSeriesGroupDimensions(props.drafts.length, props.cardLayout())
    );

    const teamScore = createMemo(() => {
        let team1Wins = 0;
        let team2Wins = 0;
        props.drafts.forEach((d) => {
            if (!d.Draft.winner) return;
            const bst = d.Draft.blueSideTeam || 1;
            const team1Won =
                (d.Draft.winner === "blue" && bst === 1) ||
                (d.Draft.winner === "red" && bst === 2);
            if (team1Won) team1Wins++;
            else team2Wins++;
        });
        return { blue: team1Wins, red: team2Wins };
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
            class="absolute z-20 rounded-xl border-2 border-darius-border bg-darius-card/90 shadow-xl backdrop-blur-sm"
            style={{
                left: `${screenPos().x}px`,
                top: `${screenPos().y}px`,
                transform: `scale(${props.viewport().zoom})`,
                "transform-origin": "top left"
            }}
        >
            {/* Header */}
            <div
                class="flex items-center justify-between rounded-t-xl border-b border-darius-border/80 bg-darius-bg/70 px-4"
                style={{
                    height: `${SERIES_HEADER_HEIGHT}px`,
                    cursor: props.canEdit() ? "move" : "default"
                }}
                onMouseDown={(e) => props.onGroupMouseDown(props.group.id, e)}
            >
                <div class="flex items-center gap-3">
                    <span class="font-semibold text-darius-text-primary">
                        {props.group.name}
                    </span>

                    {/* Navigate to Series Overview */}
                    <Show when={props.group.versus_draft_id}>
                        <button
                            onClick={(e) => {
                                e.stopPropagation();
                                navigate(`/versus/${props.group.versus_draft_id}`);
                            }}
                            class="rounded p-1 text-darius-ember transition-colors hover:bg-darius-card-hover hover:text-darius-text-primary"
                            title="Go to series overview"
                        >
                            <ExternalLink size={16} />
                        </button>
                    </Show>

                    {/* Team Score */}
                    <div class="flex items-center gap-2 text-sm">
                        <span class="text-darius-purple-bright">
                            {props.group.metadata.blueTeamName ?? "Team 1"}
                        </span>
                        <span class="font-bold text-darius-text-primary">
                            {teamScore().blue} - {teamScore().red}
                        </span>
                        <span class="text-darius-crimson">
                            {props.group.metadata.redTeamName ?? "Team 2"}
                        </span>
                    </div>
                </div>

                <div class="flex items-center gap-2">
                    {/* Series Length Badge */}
                    <span
                        class="rounded px-2 py-0.5 text-xs"
                        classList={{
                            "bg-darius-purple/20 text-darius-purple-bright":
                                (props.group.metadata.length ?? props.drafts.length) ===
                                1,
                            "bg-darius-ember/20 text-darius-ember":
                                (props.group.metadata.length ?? props.drafts.length) ===
                                3,
                            "bg-darius-crimson/20 text-darius-crimson":
                                (props.group.metadata.length ?? props.drafts.length) ===
                                5,
                            "bg-darius-purple-bright/20 text-darius-purple-bright":
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
                                "bg-darius-card-hover text-darius-text-secondary":
                                    props.group.metadata.seriesType === "standard",
                                "bg-darius-ember/20 text-darius-ember":
                                    props.group.metadata.seriesType === "fearless",
                                "bg-darius-crimson/20 text-darius-crimson":
                                    props.group.metadata.seriesType === "ironman"
                            }}
                        >
                            {versusTypeLabel()}
                        </span>
                    </Show>

                    {/* Competitive Badge */}
                    <Show when={props.group.metadata.competitive}>
                        <span class="rounded bg-darius-ember/20 px-2 py-0.5 text-xs text-darius-ember">
                            Competitive
                        </span>
                    </Show>
                    <Show when={!props.group.metadata.competitive}>
                        <span class="rounded bg-darius-card-hover px-2 py-0.5 text-xs text-darius-text-secondary">
                            Scrim
                        </span>
                    </Show>

                    {/* Status Indicator */}
                    <Show
                        when={isCompleted()}
                        fallback={
                            <span class="flex items-center gap-1 text-xs text-darius-ember">
                                <span class="h-2 w-2 rounded-full bg-darius-ember" />
                                In Progress
                            </span>
                        }
                    >
                        <span class="flex items-center gap-1 text-xs text-darius-purple-bright">
                            {/* TODO: DRA-40 - Review: was filled icon */}
                            <Check size={12} />
                            Completed
                        </span>
                    </Show>

                    {/* Settings + Delete Buttons */}
                    <Show when={props.canEdit()}>
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
                classList={{
                    "cursor-grab": !props.isPanning,
                    "cursor-grabbing": props.isPanning
                }}
                style={{
                    padding: `${SERIES_PADDING}px`,
                    gap: `${SERIES_CARD_GAP}px`
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
            >
                <For each={sortedDrafts()}>{(draft) => props.renderDraftCard(draft)}</For>
            </div>

            {/* Group anchor points for connections */}
            <Show when={props.isConnectionMode && props.onSelectAnchor}>
                <GroupAnchorPoints
                    groupId={props.group.id}
                    width={groupDimensions().width}
                    height={groupDimensions().height}
                    zoom={props.viewport().zoom}
                    onSelectAnchor={props.onSelectAnchor!}
                    isSelected={props.isGroupSelected ?? false}
                    sourceAnchor={props.sourceAnchor ?? null}
                />
            </Show>
        </div>
    );
};
