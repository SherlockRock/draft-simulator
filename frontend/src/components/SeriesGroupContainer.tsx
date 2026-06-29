import { For, Show, createMemo, createSignal, Accessor, JSX } from "solid-js";
import { useNavigate } from "@solidjs/router";
import {
    ArrowLeftRight,
    Crown,
    ExternalLink,
    Check,
    Trash2,
    Settings,
    Trophy
} from "lucide-solid";
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
    onUpdateDraftMetadata: (
        draftId: string,
        metadata: {
            winner?: "blue" | "red" | null;
            blueSideTeam?: 1 | 2;
            firstPick?: "blue" | "red";
        }
    ) => void;
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
        return [...props.drafts].sort((a, b) => {
            const aIndex = a.Draft.seriesIndex;
            const bIndex = b.Draft.seriesIndex;
            if (aIndex === null || aIndex === undefined) {
                return bIndex === null || bIndex === undefined ? 0 : 1;
            }
            if (bIndex === null || bIndex === undefined) return -1;
            return aIndex - bIndex;
        });
    });

    const groupDimensions = createMemo(() =>
        getSeriesGroupDimensions(props.drafts.length, props.cardLayout())
    );

    const seriesDrafts = createMemo(() =>
        props.drafts.filter(
            (d) => d.Draft.seriesIndex !== undefined && d.Draft.seriesIndex !== null
        )
    );

    const teamScore = createMemo(() => {
        let team1Wins = 0;
        let team2Wins = 0;
        seriesDrafts().forEach((d) => {
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
        const drafts = seriesDrafts();
        return drafts.length > 0 && drafts.every((d) => d.Draft.completed);
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

    const supportsLiveSeries = createMemo(
        () => props.group.versus_draft_id && props.group.metadata.origin !== "manual"
    );
    const isManualSeries = createMemo(() => props.group.metadata.origin === "manual");
    const teamOneName = () => props.group.metadata.blueTeamName ?? "Team 1";
    const teamTwoName = () => props.group.metadata.redTeamName ?? "Team 2";
    const teamNameForTeam = (team: 1 | 2) => (team === 1 ? teamOneName() : teamTwoName());
    const otherSide = (side: "blue" | "red"): "blue" | "red" =>
        side === "blue" ? "red" : "blue";
    // Which side a team currently sits on.
    const teamSide = (draft: CanvasDraft, team: 1 | 2): "blue" | "red" =>
        (draft.Draft.blueSideTeam ?? 1) === team ? "blue" : "red";
    const firstPickTeam = (draft: CanvasDraft): 1 | 2 =>
        (draft.Draft.firstPick ?? "blue") === teamSide(draft, 1) ? 1 : 2;
    const winnerTeam = (draft: CanvasDraft): 1 | 2 | null => {
        if (!draft.Draft.winner) return null;
        return draft.Draft.winner === teamSide(draft, 1) ? 1 : 2;
    };
    // firstPick and winner are stored as sides, so swapping which team is on
    // blue must flip them too to keep them pinned to the same team.
    const handleSwapSides = (draft: CanvasDraft) => {
        if (!props.canEdit()) return;
        const metadata: {
            blueSideTeam: 1 | 2;
            firstPick: "blue" | "red";
            winner?: "blue" | "red";
        } = {
            blueSideTeam: (draft.Draft.blueSideTeam ?? 1) === 1 ? 2 : 1,
            firstPick: otherSide(draft.Draft.firstPick ?? "blue")
        };
        if (draft.Draft.winner) metadata.winner = otherSide(draft.Draft.winner);
        props.onUpdateDraftMetadata(draft.Draft.id, metadata);
    };
    const handleSetFirstPick = (draft: CanvasDraft, team: 1 | 2) => {
        if (!props.canEdit()) return;
        props.onUpdateDraftMetadata(draft.Draft.id, {
            firstPick: teamSide(draft, team)
        });
    };
    const handleToggleWinner = (draft: CanvasDraft, team: 1 | 2) => {
        if (!props.canEdit()) return;
        const winner = teamSide(draft, team);
        props.onUpdateDraftMetadata(draft.Draft.id, {
            winner: draft.Draft.winner === winner ? null : winner
        });
    };

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
                    <Show when={supportsLiveSeries()}>
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
                    <Show when={!isManualSeries()}>
                        <Show
                            when={props.group.metadata.competitive}
                            fallback={
                                <span class="rounded bg-darius-card-hover px-2 py-0.5 text-xs text-darius-text-secondary">
                                    Scrim
                                </span>
                            }
                        >
                            <span class="rounded bg-darius-ember/20 px-2 py-0.5 text-xs text-darius-ember">
                                Competitive
                            </span>
                        </Show>
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
                <For each={sortedDrafts()}>
                    {(draft) => {
                        const [isSwapHovered, setIsSwapHovered] = createSignal(false);
                        // One tinted team panel (blue/red follows current side),
                        // owning that team's first-pick + winner toggles.
                        const panel = (team: 1 | 2) => {
                            const isBlue = () => teamSide(draft, team) === "blue";
                            const hasFirstPick = () => firstPickTeam(draft) === team;
                            const isWinner = () => winnerTeam(draft) === team;
                            return (
                                // Reorder via CSS `order` (blue-side left, red-side
                                // right) so the panels are never recreated on swap —
                                // recreating DOM under the cursor leaves the swap
                                // button's :hover/cursor stale until the next move.
                                <div
                                    class={`flex min-w-0 flex-1 flex-col gap-1.5 rounded-lg border p-2 transition-colors ${
                                        isBlue()
                                            ? "order-1 border-blue-500/40 bg-blue-500/10"
                                            : "order-3 border-red-500/40 bg-red-500/10"
                                    }`}
                                >
                                    <div class="flex items-center justify-between gap-1">
                                        <span
                                            class={`min-w-0 truncate text-xs font-bold ${
                                                isBlue()
                                                    ? "text-blue-200"
                                                    : "text-red-200"
                                            }`}
                                        >
                                            {teamNameForTeam(team)}
                                        </span>
                                        <Show when={isWinner()}>
                                            <Crown
                                                size={13}
                                                class="shrink-0 text-darius-ember"
                                            />
                                        </Show>
                                    </div>
                                    <span
                                        class={`text-[9px] font-semibold uppercase tracking-wider ${
                                            isBlue()
                                                ? "text-blue-400/80"
                                                : "text-red-400/80"
                                        }`}
                                    >
                                        {isBlue() ? "Blue side" : "Red side"}
                                    </span>
                                    <div class="mt-0.5 flex gap-1">
                                        <button
                                            type="button"
                                            disabled={!props.canEdit()}
                                            onClick={() =>
                                                handleSetFirstPick(draft, team)
                                            }
                                            onMouseDown={(e) => e.stopPropagation()}
                                            class={`flex flex-1 items-center justify-center gap-1 rounded border px-1.5 py-1 text-[10px] font-semibold transition-colors disabled:cursor-not-allowed ${
                                                hasFirstPick()
                                                    ? "border-darius-crimson/70 bg-darius-crimson/15 text-darius-text-primary"
                                                    : "border-darius-border bg-darius-card/60 text-darius-text-secondary enabled:hover:border-darius-crimson/40"
                                            }`}
                                            title={`${teamNameForTeam(team)} first pick`}
                                        >
                                            1st pick
                                        </button>
                                        <button
                                            type="button"
                                            disabled={!props.canEdit()}
                                            onClick={() =>
                                                handleToggleWinner(draft, team)
                                            }
                                            onMouseDown={(e) => e.stopPropagation()}
                                            class={`flex flex-1 items-center justify-center gap-1 rounded border px-1.5 py-1 text-[10px] font-semibold transition-colors disabled:cursor-not-allowed ${
                                                isWinner()
                                                    ? "border-darius-ember/70 bg-darius-ember/20 text-darius-ember"
                                                    : "border-darius-border bg-darius-card/60 text-darius-text-secondary enabled:hover:border-darius-ember/40"
                                            }`}
                                            title={`Set ${teamNameForTeam(team)} as winner`}
                                        >
                                            <Trophy size={11} />
                                            Won
                                        </button>
                                    </div>
                                </div>
                            );
                        };
                        return (
                            <div class="flex flex-col gap-2">
                                <div
                                    class="flex items-stretch gap-1.5"
                                    onMouseDown={(e) => e.stopPropagation()}
                                >
                                    {panel(1)}
                                    <div class="order-2 flex shrink-0 items-center">
                                        <button
                                            type="button"
                                            disabled={!props.canEdit()}
                                            onClick={() => {
                                                setIsSwapHovered(false);
                                                handleSwapSides(draft);
                                            }}
                                            onMouseDown={(e) => {
                                                e.stopPropagation();
                                                // Don't let the click focus the button —
                                                // keeps it from sticking highlighted.
                                                e.preventDefault();
                                            }}
                                            onPointerEnter={() =>
                                                setIsSwapHovered(props.canEdit())
                                            }
                                            onPointerMove={() =>
                                                setIsSwapHovered(props.canEdit())
                                            }
                                            onPointerDown={() => setIsSwapHovered(false)}
                                            onPointerUp={() => setIsSwapHovered(false)}
                                            onPointerLeave={() => setIsSwapHovered(false)}
                                            onPointerCancel={() =>
                                                setIsSwapHovered(false)
                                            }
                                            class="cursor-pointer rounded-full border border-darius-border bg-darius-card p-1.5 text-darius-text-secondary transition-colors focus:outline-none focus-visible:border-darius-ember/60 focus-visible:text-darius-ember disabled:cursor-not-allowed disabled:opacity-50"
                                            classList={{
                                                "border-darius-ember/60 text-darius-ember":
                                                    isSwapHovered() && props.canEdit()
                                            }}
                                            title="Swap sides"
                                        >
                                            <ArrowLeftRight size={14} />
                                        </button>
                                    </div>
                                    {panel(2)}
                                </div>
                                {props.renderDraftCard(draft)}
                            </div>
                        );
                    }}
                </For>
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
