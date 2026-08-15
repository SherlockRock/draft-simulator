import {
    createSignal,
    createEffect,
    Show,
    createMemo,
    For,
    Accessor,
    JSX,
    untrack
} from "solid-js";
import { useNavigate } from "@solidjs/router";
import { Eye, Plus, X, Lock } from "lucide-solid";
import { CanvasDraft, AnchorType } from "../utils/schemas";
import { AnchorPoints } from "./AnchorPoints";
import { CanvasSlot, type SlotDisplayMode } from "./CanvasSlot";
import { PickerTarget } from "./CanvasChampionPicker";
import { CUSTOM_GROUP_HEADER_HEIGHT } from "./CustomGroupContainer";
import {
    CardLayout,
    draftOrderTeam1Sections,
    draftOrderTeam2Sections,
    getIndexToShorthandForLayout
} from "../utils/canvasCardLayout";
import { cardHeight, cardWidth } from "../utils/helpers";
import type { SlotPhase } from "../utils/canvasSearch";
import { fieldForColumn } from "../utils/teamNames";
import { CanvasCardMosaic } from "./CanvasCardMosaic";
import { scaledStrokePx, screenConstantPx } from "../utils/viewport";

type CanvasCardProps = {
    canvasId: string;
    canvasDraft: CanvasDraft;
    addBox: (fromBox: CanvasDraft) => void;
    deleteBox: (draftId: string) => void;
    handleNameChange: (draftId: string, newName: string) => void;
    handlePickChange: (draftId: string, pickIndex: number, championId: string) => void;
    onBoxMouseDown: (draftId: string, e: MouseEvent) => void;
    cardLayout: () => CardLayout;
    zoom: () => number;
    /** Low-zoom level of detail: paint the flat mosaic instead of the 20 slots. */
    lodActive: () => boolean;
    isConnectionMode: boolean;
    onAnchorClick: (draftId: string, anchorType: AnchorType) => void;
    connectionSource: () => string | null;
    sourceAnchor: () => { type: AnchorType } | null;
    pickerTarget: () => PickerTarget | null;
    onSlotOpen: (draftId: string, pickIndex: number) => void;
    canEdit: () => boolean;
    isGrouped?: boolean;
    groupType?: "series" | "custom";
    editingDraftId?: Accessor<string | null>;
    onEditingComplete?: () => void;
    blueTeamName?: string;
    redTeamName?: string;
    /** Raw per-card overrides. Empty/absent means "inheriting" — distinct from
     *  blueTeamName/redTeamName, which are the RESOLVED display values. */
    team1NameRaw?: string | null;
    team2NameRaw?: string | null;
    onTeamNameChange?: (
        draftId: string,
        field: "team1Name" | "team2Name",
        value: string
    ) => void;
    restrictedChampions?: () => string[];
    disabledChampions?: string[];
    searchDimmed?: () => boolean;
    searchSlotPhase?: (pickIndex: number) => SlotPhase | null;
    searchIsCurrent?: () => boolean;
    searchInProgress?: () => boolean;
};

const blueBanIndices = [0, 1, 2, 3, 4];
const redBanIndices = [5, 6, 7, 8, 9];
const bluePickIndices = [10, 11, 12, 13, 14];
const redPickIndices = [15, 16, 17, 18, 19];
const getTeamSide = (pickIndex: number): "team1" | "team2" =>
    pickIndex < 5 || (pickIndex >= 10 && pickIndex < 15) ? "team1" : "team2";
const DRAFT_NAME_PLACEHOLDER = "Enter Draft Name";

type TeamNameInputProps = {
    column: "left" | "right";
    /** Resolved display value — used as the placeholder, never as the value. */
    resolved?: string;
    /** Raw override for THIS column — the editable value. */
    raw?: string | null;
    blueSideTeam: 1 | 2;
    disabled: boolean;
    colourClass: string;
    /** Focus underline, in this column's team colour. A literal Tailwind class,
     *  not composed at runtime, so the JIT emits it. */
    accentBorderClass: string;
    spanClass?: string;
    onCommit: (field: "team1Name" | "team2Name", value: string) => void;
};

const TeamNameInput = (props: TeamNameInputProps) => {
    const [value, setValue] = createSignal(untrack(() => props.raw ?? ""));
    const [isFocused, setIsFocused] = createSignal(false);
    // Snapshotted on focus: blueSideTeam can change mid-edit (a collaborator
    // swaps sides), and committing against the new value would write the text
    // to the opposite team.
    let targetField: "team1Name" | "team2Name" = "team1Name";
    let entryValue = "";

    createEffect(() => {
        const raw = props.raw ?? "";
        if (!isFocused() && value() !== raw) setValue(raw);
    });

    const commit = (typed: string) => {
        // Only persist a real change. Without this, focusing an INHERITED label
        // and blurring would write the inherited text back as an explicit
        // override and freeze the card against future group renames.
        if (typed === entryValue) return;
        props.onCommit(targetField, typed);
    };

    return (
        <div class={`min-w-0 px-1 ${props.spanClass ?? ""}`}>
            {/* Same active treatment as the draft-name field directly above:
                the row fills in and grows an underline on focus, so it reads as
                an editable field only while you are in it. The underline takes
                the column's team colour rather than the name field's purple.
                overflow-hidden because the sizer span is whitespace-pre and so
                has intrinsic width — without it a long override spills over the
                neighbouring column. */}
            <div
                class={`relative overflow-hidden rounded-b-sm rounded-t-md border-b-2 transition-all duration-200 ${
                    isFocused()
                        ? `bg-darius-card/60 ${props.accentBorderClass}`
                        : "border-transparent bg-transparent"
                }`}
            >
                <span
                    aria-hidden="true"
                    class="invisible block whitespace-pre px-1 text-center text-sm font-semibold"
                >
                    {value() || props.resolved || "Team"}
                </span>
                <input
                    type="text"
                    value={value()}
                    placeholder={
                        props.resolved ?? (props.column === "left" ? "Team 1" : "Team 2")
                    }
                    disabled={props.disabled}
                    class={`absolute inset-0 w-full select-text truncate bg-transparent px-1 text-center text-sm font-semibold tracking-[0.02em] outline-none disabled:cursor-not-allowed ${props.colourClass}`}
                    onFocus={() => {
                        setIsFocused(true);
                        targetField = fieldForColumn(props.column, props.blueSideTeam);
                        entryValue = value();
                    }}
                    onInput={(e) => setValue(e.currentTarget.value)}
                    onKeyDown={(e) => {
                        if (e.key === "Enter") {
                            e.currentTarget.blur();
                            return;
                        }
                        if (e.key === "Escape") {
                            // Cancel, unlike the draft-name field which commits on
                            // Escape. stopPropagation keeps this Escape from also
                            // closing canvas search.
                            e.stopPropagation();
                            setValue(entryValue);
                            setIsFocused(false);
                            e.currentTarget.blur();
                        }
                    }}
                    onBlur={() => {
                        // Read the typed value into a local BEFORE touching
                        // isFocused. Solid flushes the resync effect
                        // synchronously on that write, and while the card is
                        // still inheriting `props.raw` is null — so clearing the
                        // flag first replaced the typed text with "" and the
                        // equality guard below then correctly suppressed the
                        // send, losing the edit with no error anywhere.
                        // Snapshotting makes the commit independent of effect
                        // scheduling rather than dependent on statement order.
                        const typed = value();
                        setIsFocused(false);
                        commit(typed);
                    }}
                />
            </div>
        </div>
    );
};

export const CanvasCard = (props: CanvasCardProps) => {
    const navigate = useNavigate();
    const [nameSignal, setNameSignal] = createSignal(props.canvasDraft.Draft.name);
    const [isNameFocused, setIsNameFocused] = createSignal(false);
    let nameInputRef: HTMLInputElement | undefined;

    createEffect(() => {
        if (props.editingDraftId?.() === props.canvasDraft.Draft.id) {
            nameInputRef?.focus();
            nameInputRef?.select();
        }
    });

    createEffect(() => {
        const draftName = props.canvasDraft.Draft.name;
        if (!isNameFocused() && nameSignal() !== draftName) {
            setNameSignal(draftName);
        }
    });

    const handleViewClick = () => {
        navigate(`/canvas/${props.canvasId}/draft/${props.canvasDraft.Draft.id}`);
    };

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

    const isSlotTargeted = (pickIndex: number) => {
        const target = props.pickerTarget();
        return (
            target !== null &&
            target.draftId === props.canvasDraft.Draft.id &&
            target.pickIndex === pickIndex
        );
    };

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
            ? "absolute inset-0 w-full select-text bg-transparent px-1 py-1 text-base font-bold text-darius-text-primary outline-none disabled:cursor-not-allowed"
            : "absolute inset-0 w-full select-text bg-transparent px-1 py-1.5 text-base font-bold text-darius-text-primary outline-none disabled:cursor-not-allowed"
    );
    const titleSizerClass = createMemo(() =>
        isCompact()
            ? "invisible block whitespace-pre px-1 py-1 text-base font-bold"
            : "invisible block whitespace-pre px-1 py-1.5 text-base font-bold"
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
    const actionButtonBorderWidth = createMemo(
        () => `${screenConstantPx(1, props.zoom())}px`
    );

    // Selection wins over the connection/search highlight, matching the order
    // the two ring-4 classList entries used to resolve in.
    const highlightOutline = createMemo((): JSX.CSSProperties => {
        const color = selected()
            ? "rgb(240 104 48)" // darius-ember
            : props.isConnectionMode || (props.searchIsCurrent?.() ?? false)
              ? "rgb(155 80 192)" // darius-purple-bright
              : null;
        if (color === null) return {};
        return {
            "outline-style": "solid",
            "outline-color": color,
            "outline-width": `${scaledStrokePx(4, props.zoom())}px`
        };
    });

    // Wide slots carry full-bleed splash art, which is what makes their interiors
    // expensive enough to replace; compact's 30px icons do not need another LOD.
    const showMosaic = createMemo(
        () => props.lodActive() && (isWide() || isWideDraftOrder())
    );

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

    const renderSlot = (pickIndex: number, displayMode?: SlotDisplayMode) => (
        <CanvasSlot
            pick={props.canvasDraft.Draft.picks[pickIndex]}
            label={slotLabels()[pickIndex]}
            displayMode={displayMode}
            side={getTeamSide(pickIndex)}
            disabled={slotDisabled()}
            isPickerTarget={isSlotTargeted(pickIndex)}
            searchHighlight={props.searchSlotPhase?.(pickIndex) ?? null}
            onOpen={() => props.onSlotOpen(props.canvasDraft.Draft.id, pickIndex)}
            onClear={() =>
                props.handlePickChange(props.canvasDraft.Draft.id, pickIndex, "")
            }
        />
    );

    const renderFullSlot = (pickIndex: number) => renderSlot(pickIndex);

    const renderHorizontalColumn = (pickIndices: number[], barClass: string) =>
        renderTopRailPanel(barClass, () => (
            <For each={pickIndices}>
                {(pickIndex) => (
                    <div class="min-h-0 flex-1">{renderFullSlot(pickIndex)}</div>
                )}
            </For>
        ));

    const renderCompactBanSlot = (pickIndex: number) => renderSlot(pickIndex, "compact");

    const renderWideArtSlot = (pickIndex: number) => renderSlot(pickIndex, "wide-art");

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

    const renderTeamHeaders = () => {
        const bst = () => props.canvasDraft.Draft.blueSideTeam ?? 1;
        // The lock protects PICKS, which the versus game owns. A canvas-scoped
        // display label is not the versus game's business, so `is_locked` is
        // deliberately absent here — unlike slotDisabled(). Editing is off under
        // LOD because the header is still rendered (the mosaic only covers the
        // card BODY), and a sub-pixel input invites accidental overrides.
        const headerDisabled = () =>
            props.isConnectionMode || !props.canEdit() || props.lodActive();

        return (
            <div class={teamHeaderGridClass()}>
                <TeamNameInput
                    column="left"
                    resolved={props.blueTeamName}
                    raw={bst() === 1 ? props.team1NameRaw : props.team2NameRaw}
                    blueSideTeam={bst()}
                    disabled={headerDisabled()}
                    // The placeholder carries the INHERITED name, which is the
                    // common case — it has to look like real text, not like a
                    // greyed-out hint, or every existing series card visibly
                    // fades. Both variants are spelled out literally so Tailwind
                    // emits them.
                    colourClass="text-darius-purple-bright placeholder:text-darius-purple-bright"
                    accentBorderClass="border-darius-purple-bright"
                    spanClass={isHorizontal() ? "col-span-2" : undefined}
                    onCommit={(field, value) =>
                        props.onTeamNameChange?.(props.canvasDraft.Draft.id, field, value)
                    }
                />
                <TeamNameInput
                    column="right"
                    resolved={props.redTeamName}
                    raw={bst() === 1 ? props.team2NameRaw : props.team1NameRaw}
                    blueSideTeam={bst()}
                    disabled={headerDisabled()}
                    colourClass="text-darius-crimson placeholder:text-darius-crimson"
                    accentBorderClass="border-darius-crimson"
                    spanClass={isHorizontal() ? "col-span-2" : undefined}
                    onCommit={(field, value) =>
                        props.onTeamNameChange?.(props.canvasDraft.Draft.id, field, value)
                    }
                />
            </div>
        );
    };

    return (
        <div
            data-canvas-drag-root="true"
            data-draft-id={props.canvasDraft.Draft.id}
            class="canvas-card flex flex-col rounded-xl border border-darius-border/90 bg-darius-card-hover/95 shadow-[0_16px_40px_rgba(15,23,42,0.42)] transition-opacity duration-150"
            classList={{
                "absolute z-30": !props.isGrouped || props.groupType === "custom",
                "relative flex-shrink-0": props.isGrouped && props.groupType === "series",
                "opacity-40": props.searchDimmed?.() ?? false
            }}
            style={{
                // Drawn as an outline rather than Tailwind's ring-4: a ring is a
                // box-shadow authored in world px, so the scaled world layer
                // painted it at 4 * zoom device px and it thinned and dropped
                // out edge-by-edge below ~1px — from 0.3 zoom down, and entirely
                // at MIN_ZOOM. scaledStrokePx keeps the familiar 4px weight
                // wherever it is legible and only holds a floor below the
                // crossover. Outline rather than an inline box-shadow so it
                // composes with the card's drop shadow without restating it.
                ...highlightOutline(),
                ...(props.isGrouped && props.groupType === "custom"
                    ? {
                          left: `${props.canvasDraft.positionX}px`,
                          top: `${props.canvasDraft.positionY - CUSTOM_GROUP_HEADER_HEIGHT}px`
                      }
                    : props.isGrouped
                      ? {}
                      : {
                            // World coordinates. The .canvas-world layer applies
                            // the viewport transform for every card at once.
                            left: `${props.canvasDraft.positionX}px`,
                            top: `${props.canvasDraft.positionY}px`
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
        >
            <Show when={props.isConnectionMode}>
                <AnchorPoints
                    onSelectAnchor={(anchorType) => {
                        props.onAnchorClick(props.canvasDraft.Draft.id, anchorType);
                    }}
                    width={() => cardWidth(props.cardLayout())}
                    height={() => cardHeight(props.cardLayout())}
                    zoom={props.zoom()}
                    selected={selected}
                    sourceAnchor={props.sourceAnchor}
                />
            </Show>
            <Show when={props.searchInProgress?.()}>
                <div class="absolute -top-2.5 left-3 z-40 rounded-full border border-darius-ember/60 bg-darius-bg px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-darius-ember">
                    In progress
                </div>
            </Show>
            <div class={headerPaddingClass()}>
                <div class={`flex items-start justify-between ${inputRowGapClass()}`}>
                    <div
                        class={`relative min-w-0 overflow-hidden rounded-b-sm rounded-t-md border-b-2 transition-all duration-200 ${
                            isNameFocused()
                                ? "border-darius-purple-bright bg-darius-card/60"
                                : "border-transparent bg-transparent focus-within:border-darius-purple-bright focus-within:bg-darius-card/60"
                        }`}
                    >
                        <span aria-hidden="true" class={titleSizerClass()}>
                            {nameSignal() || DRAFT_NAME_PLACEHOLDER}
                        </span>
                        <input
                            ref={nameInputRef}
                            type="text"
                            placeholder={DRAFT_NAME_PLACEHOLDER}
                            value={nameSignal()}
                            onFocus={() => setIsNameFocused(true)}
                            onInput={(e) => setNameSignal(e.currentTarget.value)}
                            onKeyDown={(e) => {
                                if (e.key === "Enter" || e.key === "Escape") {
                                    e.currentTarget.blur();
                                }
                            }}
                            onBlur={() => {
                                // Snapshot BEFORE clearing the focus flag. Solid
                                // flushes the resync effect above synchronously
                                // on that write, and it restores the OLD store
                                // name into nameSignal — so reading the signal
                                // afterwards handed handleNameChange the name it
                                // already had, which then bailed silently at its
                                // equality check. That was the whole rename
                                // regression: no request, no toast, name reverts.
                                const typed = nameSignal();
                                setIsNameFocused(false);
                                props.handleNameChange(props.canvasDraft.Draft.id, typed);
                                props.onEditingComplete?.();
                            }}
                            class={titleInputClass()}
                            disabled={slotDisabled()}
                        />
                    </div>
                    <div class="ml-auto flex shrink-0 gap-1">
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

            <div class={`relative ${bodyPaddingClass()}`}>
                {/* The slots are HIDDEN below the LOD threshold, never unmounted.
                    Unmounting throws away the 1280x720 splash <img> elements, so zooming
                    back in re-fetches and re-decodes all 20 per card and the interiors
                    visibly load back in. Hiding costs the same per frame — the measured
                    ceiling is itself `visibility:hidden` on this subtree — and keeps them
                    decoded. Node count is higher this way, which only works because the
                    cost here is painted area, not element count. */}
                <div class="h-full min-h-0" classList={{ invisible: showMosaic() }}>
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
                                    {renderDraftOrderColumn(
                                        draftOrderTeam1Sections,
                                        false
                                    )}
                                    {renderDraftOrderColumn(
                                        draftOrderTeam2Sections,
                                        true
                                    )}
                                </div>
                            </Show>
                        }
                    >
                        <div class={classicHorizontalGridClass}>
                            {renderHorizontalColumn(
                                blueBanIndices,
                                "bg-darius-crimson/80"
                            )}
                            {renderHorizontalColumn(
                                bluePickIndices,
                                "bg-darius-ember/80"
                            )}
                            {renderHorizontalColumn(redPickIndices, "bg-darius-ember/80")}
                            {renderHorizontalColumn(
                                redBanIndices,
                                "bg-darius-crimson/80"
                            )}
                        </div>
                    </Show>
                </div>
                {/* z-10 clears the slots' own z-[3] name row and z-[4] clear button.
                    Nothing between those and the card root creates a stacking context
                    (they are all `position: relative; z-index: auto`), so at z-auto this
                    overlay would paint UNDER the slot text. That was visible for ~150ms
                    on every crossing, because `transition-all` on the slot delays the
                    inherited `visibility: hidden` — a visibility transition holds the old
                    value for its whole duration. */}
                <Show when={showMosaic()}>
                    <div class={`absolute inset-0 z-10 ${bodyPaddingClass()}`}>
                        <CanvasCardMosaic
                            picks={props.canvasDraft.Draft.picks}
                            searchSlotPhase={props.searchSlotPhase}
                            isPickerTarget={isSlotTargeted}
                        />
                    </div>
                </Show>
            </div>
        </div>
    );
};
