import {
    createSignal,
    createEffect,
    Show,
    createMemo,
    For,
    Accessor,
    JSX
} from "solid-js";
import { useNavigate } from "@solidjs/router";
import { Eye, Plus, X, Lock } from "lucide-solid";
import { CanvasDraft, Viewport, AnchorType } from "../utils/schemas";
import { AnchorPoints } from "./AnchorPoints";
import { CanvasSelect } from "./CanvasSelect";
import { CUSTOM_GROUP_HEADER_HEIGHT } from "./CustomGroupContainer";
import {
    CardLayout,
    draftOrderTeam1Sections,
    draftOrderTeam2Sections,
    getIndexToShorthandForLayout
} from "../utils/canvasCardLayout";
import { cardHeight, cardWidth } from "../utils/helpers";

type CanvasCardProps = {
    canvasId: string;
    canvasDraft: CanvasDraft;
    addBox: (fromBox: CanvasDraft) => void;
    deleteBox: (draftId: string) => void;
    handleNameChange: (draftId: string, newName: string) => void;
    handlePickChange: (draftId: string, pickIndex: number, championName: string) => void;
    onBoxMouseDown: (draftId: string, e: MouseEvent) => void;
    onContextMenu: (draft: CanvasDraft, e: MouseEvent) => void;
    cardLayout: () => CardLayout;
    viewport: () => Viewport;
    isConnectionMode: boolean;
    onAnchorClick: (draftId: string, anchorType: AnchorType) => void;
    connectionSource: () => string | null;
    sourceAnchor: () => { type: AnchorType } | null;
    focusedDraftId: () => string | null;
    focusedSelectIndex: () => number;
    onSelectFocus: (draftId: string, selectIndex: number) => void;
    onSelectBlur: () => void;
    onSelectNext: () => void;
    onSelectPrevious: () => void;
    onSelectMove: (
        axis: "horizontal" | "vertical",
        direction: "forward" | "backward"
    ) => void;
    canEdit: () => boolean;
    isGrouped?: boolean;
    groupType?: "series" | "custom";
    editingDraftId?: Accessor<string | null>;
    onEditingComplete?: () => void;
    blueTeamName?: string;
    redTeamName?: string;
    restrictedChampions?: () => string[];
    disabledChampions?: string[];
};

const blueBanIndices = [0, 1, 2, 3, 4];
const redBanIndices = [5, 6, 7, 8, 9];
const bluePickIndices = [10, 11, 12, 13, 14];
const redPickIndices = [15, 16, 17, 18, 19];
const getTeamSide = (pickIndex: number): "team1" | "team2" =>
    pickIndex < 5 || (pickIndex >= 10 && pickIndex < 15) ? "team1" : "team2";

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

    const isHorizontal = createMemo(() => props.cardLayout() === "horizontal");
    const isVertical = createMemo(() => props.cardLayout() === "vertical");
    const isWide = createMemo(() => props.cardLayout() === "wide");
    const isWideDraftOrder = createMemo(() => props.cardLayout() === "wide-draft-order");
    const isCompact = createMemo(() => props.cardLayout() === "compact");
    const isDraftOrder = createMemo(() => props.cardLayout() === "draft-order");
    const selected = createMemo(
        () => props.connectionSource() === props.canvasDraft.Draft.id
    );

    const slotDisabled = () =>
        props.isConnectionMode || !props.canEdit() || !!props.canvasDraft.is_locked;

    const sectionPanelClass =
        "rounded-xl border border-darius-border/80 bg-darius-card/70 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]";
    const slotLabels = createMemo(() => getIndexToShorthandForLayout(props.cardLayout()));
    const wideSectionClass = "grid h-full min-h-0 grid-cols-2 gap-3";
    const classicHorizontalGridClass = "grid h-full min-h-0 grid-cols-4 gap-3";
    const headerPaddingClass = createMemo(() =>
        isCompact() ? "shrink-0 px-3 pb-2 pt-2.5" : "shrink-0 px-3 pb-2.5 pt-3"
    );
    const inputRowGapClass = createMemo(() => (isCompact() ? "gap-1.5" : "gap-2"));
    const titleInputClass = createMemo(() =>
        isCompact()
            ? "min-w-0 flex-1 rounded-lg border border-transparent bg-transparent px-2 py-1 text-base font-bold text-darius-text-primary outline-none transition border-darius-border bg-darius-card/60 disabled:cursor-not-allowed"
            : "min-w-0 flex-1 rounded-lg border border-transparent bg-transparent px-2 py-1.5 text-base font-bold text-darius-text-primary outline-none transition border-darius-border bg-darius-card/60 disabled:cursor-not-allowed"
    );
    const teamHeaderGridClass = createMemo(() =>
        isHorizontal() ? "grid grid-cols-4 gap-3" : "grid grid-cols-2 gap-2.5"
    );
    const teamHeaderMarginClass = createMemo(() => (isCompact() ? "mt-2" : "mt-2.5"));
    const standardSectionGapClass = createMemo(() =>
        isCompact() ? "gap-1" : isVertical() ? "gap-1.5" : "gap-2"
    );
    const standardSlotGapClass = createMemo(() =>
        isCompact() ? "gap-0.5" : isVertical() ? "gap-1" : "gap-1.5"
    );
    const standardPanelPaddingClass = createMemo(() =>
        isCompact() ? "px-1.5 py-0.5" : isVertical() ? "px-1.5 py-1" : "px-2 py-1.5"
    );
    const standardRailInsetClass = createMemo(() =>
        isCompact()
            ? "bottom-px top-px"
            : isVertical()
              ? "bottom-px top-px"
              : "bottom-0.5 top-0.5"
    );
    const standardSlotInsetClass = createMemo(() =>
        isCompact() ? "py-0" : isVertical() ? "py-px" : "py-0.5"
    );
    const bodyPaddingClass = createMemo(() =>
        isCompact() || isVertical()
            ? "min-h-0 flex-1 px-3 pb-2.5"
            : "min-h-0 flex-1 px-3 pb-3"
    );
    const actionButtonBaseClass =
        "flex size-7 items-center justify-center rounded-lg border border-solid";
    const actionButtonBorderWidth = createMemo(() => {
        const zoom = props.viewport().zoom;
        if (!Number.isFinite(zoom) || zoom <= 0) return "1px";
        return `${1 / zoom}px`;
    });

    const getPhaseRailClass = (label: string) =>
        label === "Bans" ? "bg-darius-crimson/80" : "bg-darius-ember/80";

    const renderTopRailPanel = (
        barClass: string,
        content: () => JSX.Element,
        panelClass = "flex-1",
        paddingClass = "p-2.5"
    ) => (
        <div
            class={`${sectionPanelClass} flex min-h-0 flex-col ${paddingClass} ${panelClass}`}
        >
            <div class={`mb-2 h-1.5 rounded-full ${barClass}`} />
            <div class="flex min-h-0 flex-1 flex-col gap-2">{content()}</div>
        </div>
    );

    const renderSideRailPanel = (
        barClass: string,
        barOnRight: boolean,
        content: () => JSX.Element,
        panelClass = "",
        paddingClass = "p-2.5",
        railInsetClass = "bottom-0 top-0"
    ) => (
        <div
            class={`${sectionPanelClass} flex min-h-0 flex-col ${paddingClass} ${panelClass}`}
        >
            <div
                class="relative min-h-0 flex-1"
                classList={{
                    "pl-[8px]": !barOnRight,
                    "pr-[8px]": barOnRight
                }}
            >
                <div
                    class={`absolute w-1 rounded-full ${railInsetClass} ${barClass}`}
                    classList={{
                        "left-0": !barOnRight,
                        "right-0": barOnRight
                    }}
                />
                {content()}
            </div>
        </div>
    );

    const renderFullSlot = (pickIndex: number) => (
        <CanvasSelect
            index={() => pickIndex}
            pickIndex={pickIndex}
            pick={props.canvasDraft.Draft.picks[pickIndex]}
            handlePickChange={props.handlePickChange}
            draft={props.canvasDraft.Draft}
            indexToShorthand={slotLabels()}
            cardLayout={props.cardLayout}
            disabled={slotDisabled()}
            focusedDraftId={props.focusedDraftId}
            focusedSelectIndex={props.focusedSelectIndex}
            onFocus={() => props.onSelectFocus(props.canvasDraft.Draft.id, pickIndex)}
            onBlur={props.onSelectBlur}
            onSelectNext={props.onSelectNext}
            onSelectPrevious={props.onSelectPrevious}
            onSelectMove={props.onSelectMove}
            side={getTeamSide(pickIndex)}
            restrictedChampions={props.restrictedChampions}
            disabledChampions={props.disabledChampions}
        />
    );

    const renderHorizontalColumn = (pickIndices: number[], barClass: string) =>
        renderTopRailPanel(barClass, () => (
            <For each={pickIndices}>
                {(pickIndex) => (
                    <div class="min-h-0 flex-1">{renderFullSlot(pickIndex)}</div>
                )}
            </For>
        ));

    const renderCompactBanSlot = (pickIndex: number) => (
        <CanvasSelect
            index={() => pickIndex}
            pickIndex={pickIndex}
            pick={props.canvasDraft.Draft.picks[pickIndex]}
            handlePickChange={props.handlePickChange}
            draft={props.canvasDraft.Draft}
            indexToShorthand={slotLabels()}
            cardLayout={props.cardLayout}
            displayMode="compact"
            disabled={slotDisabled()}
            focusedDraftId={props.focusedDraftId}
            focusedSelectIndex={props.focusedSelectIndex}
            onFocus={() => props.onSelectFocus(props.canvasDraft.Draft.id, pickIndex)}
            onBlur={props.onSelectBlur}
            onSelectNext={props.onSelectNext}
            onSelectPrevious={props.onSelectPrevious}
            onSelectMove={props.onSelectMove}
            side={getTeamSide(pickIndex)}
            restrictedChampions={props.restrictedChampions}
            disabledChampions={props.disabledChampions}
        />
    );

    const renderWideArtSlot = (pickIndex: number) => (
        <CanvasSelect
            index={() => pickIndex}
            pickIndex={pickIndex}
            pick={props.canvasDraft.Draft.picks[pickIndex]}
            handlePickChange={props.handlePickChange}
            draft={props.canvasDraft.Draft}
            indexToShorthand={slotLabels()}
            cardLayout={props.cardLayout}
            displayMode="wide-art"
            disabled={slotDisabled()}
            focusedDraftId={props.focusedDraftId}
            focusedSelectIndex={props.focusedSelectIndex}
            onFocus={() => props.onSelectFocus(props.canvasDraft.Draft.id, pickIndex)}
            onBlur={props.onSelectBlur}
            onSelectNext={props.onSelectNext}
            onSelectPrevious={props.onSelectPrevious}
            onSelectMove={props.onSelectMove}
            side={getTeamSide(pickIndex)}
            restrictedChampions={props.restrictedChampions}
            disabledChampions={props.disabledChampions}
        />
    );

    const renderWideArtColumn = (pickIndices: readonly number[]) => (
        <div class="flex h-full min-h-0 flex-col gap-2.5">
            <For each={[...pickIndices]}>
                {(pickIndex) => (
                    <div class="min-h-0 flex-1">{renderWideArtSlot(pickIndex)}</div>
                )}
            </For>
        </div>
    );

    const renderWideTeamColumn = (
        banIndices: number[],
        pickIndices: number[],
        barOnRight: boolean
    ) => (
        <div class="flex h-full min-h-0 flex-col gap-3">
            {renderSideRailPanel(
                "bg-darius-crimson/80",
                barOnRight,
                () => renderWideArtColumn(banIndices),
                "flex-1"
            )}
            {renderSideRailPanel(
                "bg-darius-ember/80",
                barOnRight,
                () => renderWideArtColumn(pickIndices),
                "flex-1"
            )}
        </div>
    );

    const renderStandardTeamColumn = (
        banIndices: number[],
        pickIndices: number[],
        barOnRight: boolean
    ) => (
        <div class={`flex h-full min-h-0 flex-col ${standardSectionGapClass()}`}>
            <Show
                when={!isCompact()}
                fallback={renderTopRailPanel(
                    "bg-darius-crimson/80",
                    () => (
                        <div class="flex min-h-0 flex-1 items-center justify-center gap-1">
                            <For each={banIndices}>
                                {(pickIndex) => renderCompactBanSlot(pickIndex)}
                            </For>
                        </div>
                    ),
                    "flex-none",
                    standardPanelPaddingClass()
                )}
            >
                {renderSideRailPanel(
                    "bg-darius-crimson/80",
                    barOnRight,
                    () => (
                        <div
                            class={`flex h-full min-h-0 flex-col ${standardSlotGapClass()} ${standardSlotInsetClass()}`}
                        >
                            <For each={banIndices}>
                                {(pickIndex) => (
                                    <div class="min-h-0 flex-1">
                                        {renderFullSlot(pickIndex)}
                                    </div>
                                )}
                            </For>
                        </div>
                    ),
                    "flex-1",
                    standardPanelPaddingClass(),
                    standardRailInsetClass()
                )}
            </Show>
            {renderSideRailPanel(
                "bg-darius-ember/80",
                barOnRight,
                () => (
                    <div
                        class={`flex h-full min-h-0 flex-col ${standardSlotGapClass()} ${standardSlotInsetClass()}`}
                    >
                        <For each={pickIndices}>
                            {(pickIndex) => (
                                <div class="min-h-0 flex-1">
                                    {renderFullSlot(pickIndex)}
                                </div>
                            )}
                        </For>
                    </div>
                ),
                "flex-1",
                standardPanelPaddingClass(),
                standardRailInsetClass()
            )}
        </div>
    );

    const renderWideDraftOrderSection = (
        pickIndices: readonly number[],
        barClass: string,
        barOnRight: boolean,
        dividerClass?: string
    ) => (
        <div class={dividerClass} style={{ flex: `${pickIndices.length} 1 0%` }}>
            <div class={`${sectionPanelClass} flex h-full min-h-0 flex-col p-2.5`}>
                <div
                    class="relative min-h-0 flex-1"
                    classList={{
                        "pl-[8px]": !barOnRight,
                        "pr-[8px]": barOnRight
                    }}
                >
                    <div
                        class={`absolute bottom-0 top-0 w-1 rounded-full ${barClass}`}
                        classList={{
                            "left-0": !barOnRight,
                            "right-0": barOnRight
                        }}
                    />
                    {renderWideArtColumn(pickIndices)}
                </div>
            </div>
        </div>
    );

    const renderWideDraftOrderColumn = (
        sections: readonly { key: string; label: string; indices: readonly number[] }[],
        barOnRight: boolean
    ) => (
        <div class="flex h-full min-h-0 flex-col gap-3">
            <For each={sections}>
                {(section, index) => {
                    const phaseBarClass = getPhaseRailClass(section.label);
                    return renderWideDraftOrderSection(
                        section.indices,
                        phaseBarClass,
                        barOnRight,
                        index() === 0 ? undefined : "pt-0"
                    );
                }}
            </For>
        </div>
    );

    const renderDraftOrderSection = (
        pickIndices: readonly number[],
        barClass: string,
        barOnRight: boolean
    ) => (
        <div
            class={`${sectionPanelClass} flex min-h-0 flex-col p-2.5`}
            style={{ flex: `${pickIndices.length} 1 0%` }}
        >
            <div
                class="relative min-h-0 flex-1"
                classList={{
                    "pl-[8px]": !barOnRight,
                    "pr-[8px]": barOnRight
                }}
            >
                <div
                    class={`absolute bottom-0 top-0 w-1 rounded-full ${barClass}`}
                    classList={{
                        "left-0": !barOnRight,
                        "right-0": barOnRight
                    }}
                />
                <div class="flex h-full min-h-0 flex-col gap-2">
                    <For each={pickIndices}>
                        {(pickIndex) => (
                            <div class="min-h-0 flex-1">{renderFullSlot(pickIndex)}</div>
                        )}
                    </For>
                </div>
            </div>
        </div>
    );

    const renderDraftOrderColumn = (
        sections: readonly { key: string; label: string; indices: readonly number[] }[],
        barOnRight: boolean
    ) => (
        <div class="flex h-full min-h-0 flex-col gap-3">
            <For each={sections}>
                {(section) => {
                    const phaseBarClass = getPhaseRailClass(section.label);
                    return renderDraftOrderSection(
                        section.indices,
                        phaseBarClass,
                        barOnRight
                    );
                }}
            </For>
        </div>
    );

    const renderTeamHeaders = () => (
        <div class={teamHeaderGridClass()}>
            <div
                class="min-w-0 px-1 text-center"
                classList={{
                    "col-span-2": isHorizontal()
                }}
            >
                <div class="truncate text-sm font-semibold tracking-[0.02em] text-darius-purple-bright">
                    {props.blueTeamName?.trim() || "Team 1"}
                </div>
            </div>
            <div
                class="min-w-0 px-1 text-center"
                classList={{
                    "col-span-2": isHorizontal()
                }}
            >
                <div class="truncate text-sm font-semibold tracking-[0.02em] text-darius-crimson">
                    {props.redTeamName?.trim() || "Team 2"}
                </div>
            </div>
        </div>
    );

    return (
        <div
            class="canvas-card flex flex-col rounded-xl border border-darius-border/90 bg-darius-card-hover/95 shadow-[0_16px_40px_rgba(15,23,42,0.42)]"
            classList={{
                "absolute z-30": !props.isGrouped || props.groupType === "custom",
                "ring-4 ring-darius-purple-bright": props.isConnectionMode && !selected(),
                "ring-4 ring-darius-ember": selected(),
                "relative flex-shrink-0": props.isGrouped && props.groupType === "series"
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
                width: `${cardWidth(props.cardLayout())}px`,
                height: `${cardHeight(props.cardLayout())}px`,
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
                    cardLayout={props.cardLayout}
                    zoom={props.viewport().zoom}
                    selected={selected}
                    sourceAnchor={props.sourceAnchor}
                />
            </Show>
            <div class={headerPaddingClass()}>
                <div class={`flex items-start ${inputRowGapClass()}`}>
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
                        class={titleInputClass()}
                        disabled={slotDisabled()}
                    />
                    <div class="flex shrink-0 gap-1">
                        <div class="group relative">
                            <button
                                onClick={handleViewClick}
                                class={`${actionButtonBaseClass} border-darius-purple-bright/40 bg-darius-purple/15 text-darius-purple-bright`}
                                style={{ "border-width": actionButtonBorderWidth() }}
                                classList={{
                                    "cursor-not-allowed opacity-50":
                                        props.isConnectionMode,
                                    "cursor-pointer hover:bg-darius-purple hover:text-darius-text-primary":
                                        !props.isConnectionMode
                                }}
                                disabled={props.isConnectionMode}
                            >
                                <Eye size={16} />
                            </button>
                            <span class="pointer-events-none absolute -top-8 left-1/2 z-50 -translate-x-1/2 whitespace-nowrap rounded bg-darius-card px-2 py-1 text-xs text-darius-text-primary opacity-0 transition-opacity group-hover:opacity-100">
                                View Full Screen
                            </span>
                        </div>
                        <div class="group relative">
                            <button
                                onClick={() => props.addBox(props.canvasDraft)}
                                class={`${actionButtonBaseClass} border-darius-ember/40 bg-darius-ember/15 text-darius-ember`}
                                style={{ "border-width": actionButtonBorderWidth() }}
                                classList={{
                                    "cursor-not-allowed opacity-50":
                                        props.isConnectionMode || !props.canEdit(),
                                    "cursor-pointer hover:bg-darius-ember hover:text-darius-bg":
                                        !props.isConnectionMode && props.canEdit()
                                }}
                                disabled={props.isConnectionMode || !props.canEdit()}
                            >
                                <Plus size={16} />
                            </button>
                            <span class="pointer-events-none absolute -top-8 left-1/2 z-50 -translate-x-1/2 whitespace-nowrap rounded bg-darius-card px-2 py-1 text-xs text-darius-text-primary opacity-0 transition-opacity group-hover:opacity-100">
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
                                        class={`${actionButtonBaseClass} border-darius-crimson/40 bg-darius-crimson/15 text-darius-crimson`}
                                        style={{
                                            "border-width": actionButtonBorderWidth()
                                        }}
                                        classList={{
                                            "cursor-not-allowed opacity-50":
                                                props.isConnectionMode ||
                                                !props.canEdit(),
                                            "cursor-pointer hover:bg-darius-crimson hover:text-darius-text-primary":
                                                !props.isConnectionMode && props.canEdit()
                                        }}
                                        disabled={
                                            props.isConnectionMode || !props.canEdit()
                                        }
                                    >
                                        <X size={16} />
                                    </button>
                                    <span class="pointer-events-none absolute -top-8 left-1/2 z-50 -translate-x-1/2 whitespace-nowrap rounded bg-darius-card px-2 py-1 text-xs text-darius-text-primary opacity-0 transition-opacity group-hover:opacity-100">
                                        Delete Draft
                                    </span>
                                </div>
                            }
                        >
                            <div class="group relative">
                                <div
                                    class={`${actionButtonBaseClass} cursor-help border-darius-border bg-darius-card-hover text-darius-text-secondary`}
                                    style={{ "border-width": actionButtonBorderWidth() }}
                                    title={
                                        props.canvasDraft.Draft.versus_draft_id
                                            ? `Game ${(props.canvasDraft.Draft.seriesIndex ?? 0) + 1} of imported series. Cannot be edited.`
                                            : "Imported from versus series. Cannot be edited."
                                    }
                                >
                                    <Lock size={16} />
                                </div>
                                <span class="pointer-events-none absolute -top-8 left-1/2 z-50 -translate-x-1/2 whitespace-nowrap rounded bg-darius-card px-2 py-1 text-xs text-darius-text-primary opacity-0 transition-opacity group-hover:opacity-100">
                                    Locked
                                </span>
                            </div>
                        </Show>
                    </div>
                </div>
                <div class={teamHeaderMarginClass()}>{renderTeamHeaders()}</div>
            </div>

            <div class={bodyPaddingClass()}>
                <Show
                    when={isHorizontal()}
                    fallback={
                        <Show
                            when={isDraftOrder()}
                            fallback={
                                <Show
                                    when={isWideDraftOrder()}
                                    fallback={
                                        <Show
                                            when={isWide()}
                                            fallback={
                                                <div class="grid h-full min-h-0 grid-cols-2 gap-3">
                                                    {renderStandardTeamColumn(
                                                        blueBanIndices,
                                                        bluePickIndices,
                                                        false
                                                    )}
                                                    {renderStandardTeamColumn(
                                                        redBanIndices,
                                                        redPickIndices,
                                                        true
                                                    )}
                                                </div>
                                            }
                                        >
                                            <div class="h-full min-h-0">
                                                <div class={wideSectionClass}>
                                                    {renderWideTeamColumn(
                                                        blueBanIndices,
                                                        bluePickIndices,
                                                        false
                                                    )}
                                                    {renderWideTeamColumn(
                                                        redBanIndices,
                                                        redPickIndices,
                                                        true
                                                    )}
                                                </div>
                                            </div>
                                        </Show>
                                    }
                                >
                                    <div class="h-full min-h-0">
                                        <div class={wideSectionClass}>
                                            {renderWideDraftOrderColumn(
                                                draftOrderTeam1Sections,
                                                false
                                            )}
                                            {renderWideDraftOrderColumn(
                                                draftOrderTeam2Sections,
                                                true
                                            )}
                                        </div>
                                    </div>
                                </Show>
                            }
                        >
                            <div class="grid h-full min-h-0 grid-cols-2 gap-3">
                                {renderDraftOrderColumn(draftOrderTeam1Sections, false)}
                                {renderDraftOrderColumn(draftOrderTeam2Sections, true)}
                            </div>
                        </Show>
                    }
                >
                    <div class={classicHorizontalGridClass}>
                        {renderHorizontalColumn(blueBanIndices, "bg-darius-crimson/80")}
                        {renderHorizontalColumn(bluePickIndices, "bg-darius-ember/80")}
                        {renderHorizontalColumn(redPickIndices, "bg-darius-ember/80")}
                        {renderHorizontalColumn(redBanIndices, "bg-darius-crimson/80")}
                    </div>
                </Show>
            </div>
        </div>
    );
};
