import {
    Component,
    createContext,
    createMemo,
    useContext,
    For,
    Show,
    type JSX
} from "solid-js";
import { ChevronDown, ChevronRight } from "lucide-solid";
import type { CanvasDraft, CanvasGroup } from "../utils/schemas";
import type { CardLayout } from "../utils/canvasCardLayout";
import type { RestrictionGroup } from "./ChampionPanel";
import {
    childCardsOf,
    childGroupsOf,
    rootGroupsOf,
    type CanvasTree
} from "../utils/canvasTree";
import { getDraftWorldPosition } from "../utils/canvasWorldPosition";
import { resolveChampion } from "../utils/constants";

/**
 * The workflow panel's "Drafts & Groups" list, as an INDENTED TREE
 * (recursive-groups design §9).
 *
 * It used to be a flat `<For each={groups()}>` in `CanvasWorkflow.tsx`, so a
 * nested Group rendered at its parent's indent and the panel said nothing about
 * containment at all. SolidJS cannot recurse inside a `<For>` body, so the row
 * had to become a component — and the row reads ~12 ambient accessors, which is
 * why they travel in a context instead of a twelve-prop signature repeated at
 * every recursion site.
 *
 * **Collapse is part of this slice, not a follow-up.** The panel had none, and
 * rendered every Card of every Group at every depth; nesting multiplies that.
 * Per decision 8 (as amended) panel collapse is per-user, EPHEMERAL view state —
 * the same category as the viewport, exempt from "all structural state is
 * shared" — so it lives in a signal and is never persisted or broadcast.
 * Canvas frames themselves still never collapse.
 *
 * The default is depth-based: a top-level Group starts expanded, a nested one
 * starts collapsed. A flat canvas therefore looks exactly as it did before this
 * component existed, and a deep one opens one level at a time.
 */

type PanelTreeContextValue = {
    tree: () => CanvasTree;
    isCollapsed: (group: CanvasGroup, depth: number) => boolean;
    onToggleCollapsed: (group: CanvasGroup, depth: number) => void;
    isDraftView: () => boolean;
    activeGroup: () => CanvasGroup | undefined;
    activeDraftId: () => string | undefined;
    activeRestrictionLabel: () => string | null;
    activeDisabledChampions: () => string[];
    activeRestrictionGroups: () => RestrictionGroup[];
    showRestrictionBans: () => boolean;
    cardLayout: () => CardLayout;
    canEdit: () => boolean;
    onOpenDraft: (draftId: string) => void;
    onPanTo: (x: number, y: number) => void;
    onGroupContextMenu: (group: CanvasGroup, event: MouseEvent) => void;
    onCardContextMenu: (canvasDraft: CanvasDraft, event: MouseEvent) => void;
};

const PanelTreeContext = createContext<PanelTreeContextValue>();

const EMPTY_ANCESTRY: ReadonlySet<string> = new Set();

/**
 * Throws rather than returning a default: every consumer here is rendered by
 * `CanvasPanelTree` itself, so a missing provider is a wiring bug and a silent
 * fallback would show an empty panel instead of saying so.
 */
const usePanelTree = (): PanelTreeContextValue => {
    const value = useContext(PanelTreeContext);
    if (!value) throw new Error("CanvasPanelTree context is missing");
    return value;
};

const ChampionStrip: Component<{
    championIds: string[];
    tint?: "default" | "disabled";
}> = (props) => {
    const visibleChampionIds = createMemo(() =>
        props.championIds.filter((id) => id !== "")
    );

    return (
        <Show when={visibleChampionIds().length > 0}>
            <div class="flex flex-wrap gap-1">
                <For each={visibleChampionIds()}>
                    {(championId) => {
                        const champion = resolveChampion(championId);
                        if (!champion) {
                            return null;
                        }
                        return (
                            <img
                                src={champion.img}
                                alt={champion.name}
                                title={champion.name}
                                class={`h-7 w-7 rounded object-cover ${
                                    props.tint === "disabled"
                                        ? "border border-red-700/60 opacity-75"
                                        : "border border-darius-border"
                                }`}
                            />
                        );
                    }}
                </For>
            </div>
        </Show>
    );
};

const TREE_CONNECTOR_WIDTH_CLASS = "w-6";
const TREE_CONNECTOR_STROKE_CLASS = "bg-darius-purple-bright/35";
const TREE_CONNECTOR_THICKNESS_CLASS = "w-0.5";
const TREE_CONNECTOR_BRANCH_THICKNESS_CLASS = "h-0.5";
const TREE_CONNECTOR_BRANCH_OFFSET_CLASS = "left-[2px]";
const TREE_CONNECTOR_END_CAP_CLASS = "h-[calc(50%+1px)]";

const RestrictionTreeRow: Component<{
    continueAbove?: boolean;
    continueBelow?: boolean;
    branch?: boolean;
    contentClass?: string;
    children: JSX.Element;
}> = (props) => {
    return (
        <div class="flex items-stretch">
            <div class={`relative ml-[11px] shrink-0 ${TREE_CONNECTOR_WIDTH_CLASS}`}>
                <Show when={props.continueAbove}>
                    <div
                        class={`absolute left-0 ${TREE_CONNECTOR_THICKNESS_CLASS} ${TREE_CONNECTOR_STROKE_CLASS} ${
                            props.continueBelow
                                ? "bottom-0 top-0"
                                : `top-0 ${TREE_CONNECTOR_END_CAP_CLASS}`
                        }`}
                    />
                </Show>
                <Show when={props.continueBelow}>
                    <div
                        class={`absolute bottom-0 left-0 ${TREE_CONNECTOR_THICKNESS_CLASS} ${TREE_CONNECTOR_STROKE_CLASS} ${
                            props.continueAbove ? "hidden" : "h-1/2"
                        }`}
                    />
                </Show>
                <Show when={props.branch}>
                    <div
                        class={`absolute right-0 top-[calc(50%-1px)] ${TREE_CONNECTOR_BRANCH_OFFSET_CLASS} ${TREE_CONNECTOR_BRANCH_THICKNESS_CLASS} ${TREE_CONNECTOR_STROKE_CLASS}`}
                    />
                </Show>
            </div>
            <div class={`min-w-0 flex-1 ${props.contentClass ?? ""}`}>
                {props.children}
            </div>
        </div>
    );
};

/** A Card sitting loose on the canvas — no container, so no tree connector. */
const LooseCardRow: Component<{ canvasDraft: CanvasDraft }> = (props) => {
    const panel = usePanelTree();

    return (
        <div
            class={`flex-shrink-0 cursor-pointer truncate rounded px-2 py-1.5 text-sm transition-colors ${
                panel.isDraftView() &&
                props.canvasDraft.Draft.id === panel.activeDraftId()
                    ? "bg-darius-purple/30 text-darius-text-primary hover:bg-darius-purple/35"
                    : "bg-darius-card-hover/50 text-darius-text-primary hover:bg-darius-card-hover"
            }`}
            onClick={() => {
                if (panel.isDraftView()) {
                    panel.onOpenDraft(props.canvasDraft.Draft.id);
                } else {
                    panel.onPanTo(
                        props.canvasDraft.positionX,
                        props.canvasDraft.positionY
                    );
                }
            }}
            onContextMenu={(event) => {
                if (panel.canEdit()) {
                    panel.onCardContextMenu(props.canvasDraft, event);
                }
            }}
        >
            {props.canvasDraft.Draft.name}
        </div>
    );
};

/**
 * A Card inside a container, plus the restriction strip the draft view hangs
 * off it. `continueBelow` has to know about everything that renders after this
 * row, which is why the flags are computed here rather than in the parent.
 */
const GroupedCardRow: Component<{
    canvasDraft: CanvasDraft;
    group: CanvasGroup;
    siblings: CanvasDraft[];
    index: number;
    /** Set when a child-Group block or the disabled strip follows this Card. */
    somethingFollows: boolean;
}> = (props) => {
    const panel = usePanelTree();

    const isGroupActive = () =>
        panel.isDraftView() && props.group.id === panel.activeGroup()?.id;
    const isLast = () => props.index === props.siblings.length - 1;
    const showDisabledRow = () =>
        isGroupActive() && panel.activeDisabledChampions().length > 0;
    const isActiveDraftRow = () =>
        panel.isDraftView() && props.canvasDraft.Draft.id === panel.activeDraftId();
    const isCurrentRestrictionSource = () => isGroupActive() && !isActiveDraftRow();

    const restrictionSource = createMemo(() =>
        panel
            .activeRestrictionGroups()
            .find(
                (restrictionGroup) =>
                    restrictionGroup.label ===
                    (props.group.type === "series"
                        ? `Game ${(props.canvasDraft.Draft.seriesIndex ?? 0) + 1}`
                        : props.canvasDraft.Draft.name)
            )
    );

    const rowChampionIds = createMemo(() => {
        const source = restrictionSource();
        if (!source) {
            return [];
        }

        const ids = panel.showRestrictionBans()
            ? [
                  ...source.blueBans,
                  ...source.redBans,
                  ...source.bluePicks,
                  ...source.redPicks
              ]
            : [...source.bluePicks, ...source.redPicks];

        return ids.filter((id) => id !== "");
    });

    // Only SIBLING rows get a strip. The row for the draft you are viewing used
    // to show that draft's own picks, on no mode condition at all — so it fired
    // in every group, standard included, restating the board already filling the
    // screen beside it. A strip earns its space by naming what a row takes AWAY
    // from you, which is what `rowChampionIds` reads and why it is empty outside
    // fearless and ironman.
    const hasChampionStrip = createMemo(
        () => isCurrentRestrictionSource() && rowChampionIds().length > 0
    );

    return (
        <>
            <RestrictionTreeRow
                continueAbove
                continueBelow={
                    hasChampionStrip() ||
                    !isLast() ||
                    showDisabledRow() ||
                    props.somethingFollows
                }
                branch
                contentClass="pt-2"
            >
                <div
                    class={`cursor-pointer truncate rounded px-2 py-1.5 text-sm transition-colors ${
                        panel.isDraftView() &&
                        props.canvasDraft.Draft.id === panel.activeDraftId()
                            ? "bg-darius-purple/30 text-darius-text-primary hover:bg-darius-purple/35"
                            : "bg-darius-card-hover/50 text-darius-text-primary hover:bg-darius-card-hover"
                    }`}
                    onClick={() => {
                        if (panel.isDraftView()) {
                            panel.onOpenDraft(props.canvasDraft.Draft.id);
                        } else {
                            const position = getDraftWorldPosition(
                                props.canvasDraft,
                                props.group,
                                props.siblings,
                                panel.cardLayout()
                            );
                            panel.onPanTo(position.x, position.y);
                        }
                    }}
                    onContextMenu={(event) => {
                        if (panel.canEdit()) {
                            panel.onCardContextMenu(props.canvasDraft, event);
                        }
                    }}
                >
                    {props.canvasDraft.Draft.name}
                </div>
            </RestrictionTreeRow>
            <Show when={hasChampionStrip()}>
                <RestrictionTreeRow
                    continueAbove
                    continueBelow={
                        !isLast() || showDisabledRow() || props.somethingFollows
                    }
                    contentClass="pb-2 pt-1"
                >
                    <div class="px-2">
                        <ChampionStrip championIds={rowChampionIds()} />
                    </div>
                </RestrictionTreeRow>
            </Show>
        </>
    );
};

/**
 * One container and everything under it. Recursive: a child Group renders the
 * same component one level deeper.
 *
 * `ancestry` is the visited set the recursion needs to stay finite. The server
 * rejects cycles, but a local canvas has no server, and `rootGroupsOf` makes a
 * cycle REACHABLE without making it finite — so a child already on the path
 * from the root is dropped rather than recursed into.
 */
const PanelGroupNode: Component<{
    group: CanvasGroup;
    depth: number;
    ancestry: ReadonlySet<string>;
}> = (props) => {
    const panel = usePanelTree();

    const ancestryWithSelf = createMemo(
        () => new Set([...props.ancestry, props.group.id])
    );
    const childGroups = createMemo(() =>
        childGroupsOf(panel.tree(), props.group.id).filter(
            (child) => !ancestryWithSelf().has(child.id)
        )
    );
    const childCards = createMemo(() => childCardsOf(panel.tree(), props.group.id));
    const hasChildren = () => childGroups().length > 0 || childCards().length > 0;
    const collapsed = () => panel.isCollapsed(props.group, props.depth);
    const isActive = () =>
        panel.isDraftView() && props.group.id === panel.activeGroup()?.id;
    const showDisabledRow = () =>
        isActive() && panel.activeDisabledChampions().length > 0;

    return (
        <div
            class={`flex flex-shrink-0 flex-col rounded ${
                isActive()
                    ? "border border-darius-purple-bright/35 bg-darius-purple/10 p-1.5"
                    : ""
            }`}
        >
            <div
                class={`flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm transition-colors ${
                    isActive()
                        ? "bg-darius-purple/20 text-darius-text-primary hover:bg-darius-purple/25"
                        : "bg-darius-card-hover/50 text-darius-text-secondary hover:bg-darius-card-hover hover:text-darius-text-primary"
                }`}
                onClick={() =>
                    panel.onPanTo(props.group.positionX, props.group.positionY)
                }
                onContextMenu={(event) => panel.onGroupContextMenu(props.group, event)}
            >
                {/* Collapse sits in its own hit target: the rest of the header
                    still pans the canvas to the container, as it always has. */}
                <Show
                    when={hasChildren()}
                    fallback={<span class="h-4 w-4 flex-shrink-0" />}
                >
                    <button
                        type="button"
                        class="flex h-4 w-4 flex-shrink-0 items-center justify-center rounded text-darius-text-secondary transition-colors hover:bg-darius-purple/20 hover:text-darius-text-primary"
                        aria-label={
                            collapsed()
                                ? `Expand ${props.group.name}`
                                : `Collapse ${props.group.name}`
                        }
                        aria-expanded={!collapsed()}
                        onClick={(event) => {
                            event.stopPropagation();
                            panel.onToggleCollapsed(props.group, props.depth);
                        }}
                    >
                        <Show when={collapsed()} fallback={<ChevronDown size={14} />}>
                            <ChevronRight size={14} />
                        </Show>
                    </button>
                </Show>
                <span class="flex h-4 w-4 flex-shrink-0 items-center justify-center">
                    <span
                        class={`block h-1.5 w-1.5 rounded-full ${
                            props.group.type === "series"
                                ? "bg-darius-crimson"
                                : "bg-darius-purple-bright"
                        }`}
                    />
                </span>
                <span class="truncate text-darius-text-primary">{props.group.name}</span>
                <Show when={isActive() && panel.activeRestrictionLabel()}>
                    <span class="ml-auto rounded bg-darius-purple/20 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-darius-purple-bright">
                        {panel.activeRestrictionLabel()}
                    </span>
                </Show>
            </div>

            <Show when={!collapsed()}>
                <div>
                    <For each={childCards()}>
                        {(canvasDraft, index) => (
                            <GroupedCardRow
                                canvasDraft={canvasDraft}
                                group={props.group}
                                siblings={childCards()}
                                index={index()}
                                somethingFollows={childGroups().length > 0}
                            />
                        )}
                    </For>

                    {/* Child containers below the loose Cards, matching
                        `childrenOf`'s Groups-then-Cards order read bottom-up:
                        a container is a heavier row and reads better as the
                        tail of the list than wedged above its siblings. */}
                    <For each={childGroups()}>
                        {(childGroup, index) => (
                            <RestrictionTreeRow
                                continueAbove
                                continueBelow={
                                    index() < childGroups().length - 1 ||
                                    showDisabledRow()
                                }
                                branch
                                contentClass="pt-2"
                            >
                                <PanelGroupNode
                                    group={childGroup}
                                    depth={props.depth + 1}
                                    ancestry={ancestryWithSelf()}
                                />
                            </RestrictionTreeRow>
                        )}
                    </For>

                    <Show when={showDisabledRow()}>
                        <>
                            <RestrictionTreeRow continueAbove continueBelow>
                                <div class="px-2 pt-1 text-[10px] font-semibold uppercase tracking-wider text-darius-crimson">
                                    Disabled
                                </div>
                            </RestrictionTreeRow>
                            <RestrictionTreeRow
                                continueAbove
                                branch
                                contentClass="pb-2 pt-1"
                            >
                                <div class="px-2">
                                    <ChampionStrip
                                        championIds={panel.activeDisabledChampions()}
                                        tint="disabled"
                                    />
                                </div>
                            </RestrictionTreeRow>
                        </>
                    </Show>
                </div>
            </Show>
        </div>
    );
};

export const CanvasPanelTree: Component<PanelTreeContextValue> = (props) => {
    // `props` is already the context shape, but it is a Solid props object:
    // reading a field off it inside a child's render is what keeps the child
    // reactive, so it is passed through as-is rather than destructured.
    // `rootGroupsOf`, not `childGroupsOf(tree, null)`: an ORPHANED Group — one
    // whose parent the optimistic delete already removed from the store — has a
    // non-null parent id pointing at nothing, and the top-level query drops it.
    // The flat list this replaced rendered every Group unconditionally, so
    // filtering on `parent_group_id == null` would have been a regression.
    const rootGroups = createMemo(() => rootGroupsOf(props.tree()));
    const looseCards = createMemo(() => childCardsOf(props.tree(), null));

    return (
        <PanelTreeContext.Provider value={props}>
            <For each={rootGroups()}>
                {(group) => (
                    <PanelGroupNode group={group} depth={0} ancestry={EMPTY_ANCESTRY} />
                )}
            </For>
            <For each={looseCards()}>
                {(canvasDraft) => <LooseCardRow canvasDraft={canvasDraft} />}
            </For>
        </PanelTreeContext.Provider>
    );
};
