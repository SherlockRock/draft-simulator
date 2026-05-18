import {
    Accessor,
    Component,
    For,
    Show,
    createEffect,
    createMemo,
    createSignal,
    createUniqueId,
    on,
    onCleanup,
    onMount,
    untrack
} from "solid-js";
import createPanZoom, { type PanZoom } from "panzoom";
import { ContextMenu } from "../ContextMenu";
import { useNavigatorContext } from "../../contexts/NavigatorContext";
import toast from "solid-toast";
import { resolveChampion } from "../../utils/constants";
import { ContextMenuAction } from "../../utils/types";
import {
    collectNodeKeyPaths,
    nodeKey,
    nodeKeyPath,
    pathIndicesToNodeKeyPath
} from "../../utils/treeReconcile";
import {
    DEFAULT_RADIAL_CONFIG,
    LayoutNode,
    RadialLayoutConfig,
    layoutVariants,
    makeRadialTreeLayout
} from "../../utils/treeLayout";
import LayoutKnobPanel, { loadStoredState } from "./LayoutKnobPanel";
import { actionsForNode, backgroundActions } from "./treeNodeActions";

export type ScenarioPathTier = "selected" | "unselected";

export interface TieredScenarioPath {
    path: number[];
    tier: ScenarioPathTier;
}

interface DecisionTreeProps {
    treeData: LayoutNode | null;
    isComputing: boolean;
    /** Phase 7b T15: true while an MCTS streaming session is iterating.
     *  Gates the Stop button (which only makes sense when there is a
     *  cooperative-cancel-capable session in flight). */
    isSessionActive?: boolean;
    /** Phase 7b T15: optimistic "Stopping…" state. Swaps the button /
     *  label copy after the user clicks Stop, until the final lands. */
    isStopping?: boolean;
    /** Phase 7b T15: meta block driving the iter / elapsed readout.
     *  Iter is sourced from `meta.mctsMeta.iterations` (MCTS-only);
     *  elapsed is `meta.computeTimeMs`. Null/missing fields render
     *  no readout. */
    indicatorMeta?: {
        mctsMeta?: { iterations: number } | null;
        computeTimeMs?: number | null;
    } | null;
    /** Phase 7b T15: invoked when the user clicks the Stop button. */
    onStop?: () => void;
    /** Phase 7c T13: true when the session is paused — drives the Resume button visibility. */
    hasPausedSession?: boolean;
    /** Phase 7c T13: invoked when the user clicks the Resume button. */
    onResume?: () => void;
    highlightedPath: number[] | null;
    scenarioPaths: TieredScenarioPath[];
    panRequest: { path: number[] } | null;
    onNodeClick: (nodeIndex: number[]) => void;
    confirmedDepth: number;
    onPromoteToScenario?: (path: number[]) => void;
    onConfirmProjectedPick?: (path: number[]) => void;
    onOpenSwap?: (path: number[]) => void;
    onOpenBranch?: (path: number[]) => void;
}

interface TreeNodeWithPath extends LayoutNode {
    path: number[];
    children: TreeNodeWithPath[];
    /** True when the original node had children but they were pruned */
    collapsedChildCount: number;
}

interface PositionedNode {
    x: number;
    y: number;
    depth: number;
    data: TreeNodeWithPath;
}

interface PositionedLink {
    source: { x: number; y: number; data: TreeNodeWithPath };
    target: { x: number; y: number; data: TreeNodeWithPath };
}

interface ViewportSize {
    width: number;
    height: number;
}

interface DragState {
    keyPath: string;
    startPageX: number;
    startPageY: number;
    startedDragging: boolean;
}

interface FitTransform {
    x: number;
    y: number;
    scale: number;
}

interface TreeContextMenuState {
    x: number;
    y: number;
    target: { path: number[] } | "background";
}

const NODE_RADIUS = 20;
const PAIR_NODE_WIDTH = NODE_RADIUS * 2.9;
const PAIR_NODE_HEIGHT = NODE_RADIUS * 2.2;
const PAIR_SLASH_OFFSET = 7;
const PAIR_IMAGE_INSET = 2;
const BAN_RADIUS = NODE_RADIUS * 0.8;
const TREE_PADDING = 56;
const BLUE_HEX = "#3b82f6";
const RED_HEX = "#ef4444";
const MUTED_OPACITY = 0.6;

function sideColor(side: "blue" | "red" | null, muted: boolean): string {
    if (side === "blue") {
        return muted ? `rgba(59, 130, 246, ${MUTED_OPACITY})` : BLUE_HEX;
    }

    if (side === "red") {
        return muted ? `rgba(239, 68, 68, ${MUTED_OPACITY})` : RED_HEX;
    }

    return "#94a3b8";
}

function getPairClipRadius() {
    return PAIR_NODE_HEIGHT / 2 - PAIR_IMAGE_INSET;
}

function getPairLeftClipPath() {
    const halfWidth = PAIR_NODE_WIDTH / 2 - PAIR_IMAGE_INSET;
    const halfHeight = PAIR_NODE_HEIGHT / 2 - PAIR_IMAGE_INSET;
    const radius = getPairClipRadius();

    return [
        `M ${-halfWidth + radius} ${-halfHeight}`,
        `L ${PAIR_SLASH_OFFSET} ${-halfHeight}`,
        `L ${-PAIR_SLASH_OFFSET} ${halfHeight}`,
        `L ${-halfWidth + radius} ${halfHeight}`,
        `Q ${-halfWidth} ${halfHeight} ${-halfWidth} ${halfHeight - radius}`,
        `L ${-halfWidth} ${-halfHeight + radius}`,
        `Q ${-halfWidth} ${-halfHeight} ${-halfWidth + radius} ${-halfHeight}`,
        "Z"
    ].join(" ");
}

function getPairRightClipPath() {
    const halfWidth = PAIR_NODE_WIDTH / 2 - PAIR_IMAGE_INSET;
    const halfHeight = PAIR_NODE_HEIGHT / 2 - PAIR_IMAGE_INSET;
    const radius = getPairClipRadius();

    return [
        `M ${PAIR_SLASH_OFFSET} ${-halfHeight}`,
        `L ${halfWidth - radius} ${-halfHeight}`,
        `Q ${halfWidth} ${-halfHeight} ${halfWidth} ${-halfHeight + radius}`,
        `L ${halfWidth} ${halfHeight - radius}`,
        `Q ${halfWidth} ${halfHeight} ${halfWidth - radius} ${halfHeight}`,
        `L ${-PAIR_SLASH_OFFSET} ${halfHeight}`,
        "Z"
    ].join(" ");
}

function withPaths(node: LayoutNode, path: number[] = []): TreeNodeWithPath {
    return {
        ...node,
        path,
        collapsedChildCount: 0,
        children: node.children.map((child, index) => withPaths(child, [...path, index]))
    };
}

function pruneTree(
    node: TreeNodeWithPath,
    expandedPaths: ReadonlySet<string>,
    manualExpansions: ReadonlySet<string>
): TreeNodeWithPath {
    void manualExpansions;
    const key = pathKey(node.path);
    const isExpanded = node.path.length === 0 || expandedPaths.has(key);

    if (!isExpanded || node.children.length === 0) {
        return {
            ...node,
            collapsedChildCount: node.children.length,
            children: []
        };
    }

    return {
        ...node,
        collapsedChildCount: 0,
        children: node.children.map((child) =>
            pruneTree(child, expandedPaths, manualExpansions)
        )
    };
}

function expandForPaths(scenarioPaths: TieredScenarioPath[]): Set<string> {
    const expanded = new Set<string>();
    // Root is always expanded
    expanded.add("root");

    for (const { path } of scenarioPaths) {
        // Expand every node along this path so the full lane is visible
        for (let i = 1; i <= path.length; i++) {
            expanded.add(pathKey(path.slice(0, i)));
        }
    }

    return expanded;
}

function pathKey(path: number[]): string {
    return path.length === 0 ? "root" : path.join("-");
}

function isPathHighlighted(path: number[], highlightedPath: number[] | null): boolean {
    if (!highlightedPath || path.length > highlightedPath.length) {
        return false;
    }

    return path.every((segment, index) => highlightedPath[index] === segment);
}

function radialLinkPath(
    sourceX: number,
    sourceY: number,
    targetX: number,
    targetY: number
) {
    return `M ${sourceX},${sourceY} L ${targetX},${targetY}`;
}

function getPhaseLabel(phase: LayoutNode["phase"]): string {
    if (phase === "ban1") return "Ban 1";
    if (phase === "pick1") return "Pick 1";
    if (phase === "ban2") return "Ban 2";
    return "Pick 2";
}

function getDepthRingLabel(node: TreeNodeWithPath): string {
    if (node.actionType === "pick" && node.championIds.length === 2) {
        if (node.side === "blue") {
            return "BB Pick";
        }

        if (node.side === "red") {
            return "RR Pick";
        }
    }

    return getPhaseLabel(node.phase);
}

function roundScale(value: number) {
    return Math.round(value * 100) / 100;
}

function getNodeAtPath(node: TreeNodeWithPath, path: number[]): TreeNodeWithPath | null {
    let current: TreeNodeWithPath | null = node;

    for (const index of path) {
        current = current?.children[index] ?? null;
    }

    return current;
}

function getFitTransform(
    layoutWidth: number,
    layoutHeight: number,
    viewport: ViewportSize
): FitTransform {
    const availableWidth = Math.max(viewport.width - TREE_PADDING * 2, 120);
    const availableHeight = Math.max(viewport.height - TREE_PADDING * 2, 120);
    const widthScale = availableWidth / Math.max(layoutWidth, 1);
    const heightScale = availableHeight / Math.max(layoutHeight, 1);
    const scale = Math.max(Math.min(widthScale, heightScale), 0.05);

    return {
        scale,
        x: (viewport.width - layoutWidth * scale) / 2,
        y: (viewport.height - layoutHeight * scale) / 2
    };
}

function isElementWithinNode(target: EventTarget | null): boolean {
    return (
        target instanceof Element && target.closest("[data-tree-node='true']") !== null
    );
}

function isPrefix(shorter: number[], longer: number[]): boolean {
    if (shorter.length > longer.length) return false;
    for (let i = 0; i < shorter.length; i++) {
        if (shorter[i] !== longer[i]) return false;
    }
    return true;
}

function applyEngagementOverrides(
    tree: LayoutNode,
    expanded: Set<string>,
    expansionKeys: ReadonlySet<string>,
    collapseKeys: ReadonlySet<string>
): void {
    for (let i = 0; i < tree.children.length; i++) {
        walkEngagement(
            tree.children[i],
            [i],
            [nodeKey(tree.children[i])],
            expanded,
            expansionKeys,
            collapseKeys
        );
    }
}

function walkEngagement(
    node: LayoutNode,
    indexPath: number[],
    keyArray: string[],
    expanded: Set<string>,
    expansionKeys: ReadonlySet<string>,
    collapseKeys: ReadonlySet<string>
): void {
    const indexKey = pathKey(indexPath);
    const keyPathString = nodeKeyPath(keyArray);
    if (expansionKeys.has(keyPathString)) expanded.add(indexKey);
    if (collapseKeys.has(keyPathString)) expanded.delete(indexKey);
    for (let i = 0; i < node.children.length; i++) {
        const child = node.children[i];
        walkEngagement(
            child,
            [...indexPath, i],
            [...keyArray, nodeKey(child)],
            expanded,
            expansionKeys,
            collapseKeys
        );
    }
}

const TreeLink: Component<{
    link: PositionedLink;
    highlightedPath: number[] | null;
    isLineageHover: boolean;
}> = (props) => {
    const highlighted = createMemo(() =>
        isPathHighlighted(props.link.target.data.path, props.highlightedPath)
    );
    const strokeOpacity = createMemo(() =>
        props.isLineageHover ? 1 : highlighted() ? 0.95 : 0.8
    );
    const strokeWidth = createMemo(() =>
        props.isLineageHover ? 3 : highlighted() ? 3 : 1.75
    );
    const stroke = createMemo(() =>
        props.isLineageHover ? "#22d3ee" : highlighted() ? "#60a5fa" : "#334155"
    );

    return (
        <path
            class="transition-[d] duration-200 ease-out"
            d={radialLinkPath(
                props.link.source.x,
                props.link.source.y,
                props.link.target.x,
                props.link.target.y
            )}
            fill="none"
            stroke={stroke()}
            stroke-width={strokeWidth()}
            stroke-linecap="round"
            opacity={strokeOpacity()}
        />
    );
};

const TreeNodeComponent: Component<{
    node: PositionedNode;
    highlightedPath: number[] | null;
    glowFilterId: string;
    latestGlowFilterId: string;
    onClick: (path: number[]) => void;
    onPointerDown: (event: PointerEvent, indexPath: number[]) => void;
    onToggleExpand: (path: number[]) => void;
    isConfirmed: boolean;
    isLatestConfirmed: boolean;
    justDragged: Accessor<boolean>;
    isLineageHover: boolean;
    onHover: (path: number[] | null) => void;
    onContextMenu: (event: MouseEvent, path: number[]) => void;
}> = (props) => {
    const clipSeed = createUniqueId();
    const championIds = createMemo(() => props.node.data.championIds);
    const champions = createMemo(() =>
        championIds()
            .map((championId) => resolveChampion(championId))
            .filter(
                (champion): champion is NonNullable<ReturnType<typeof resolveChampion>> =>
                    champion !== undefined
            )
    );
    const confirmedChampionIds = createMemo(
        () => props.node.data.confirmedChampionIds ?? []
    );

    const isChampionConfirmed = (championId: string | undefined): boolean => {
        if (!championId) return false;
        return confirmedChampionIds().includes(championId);
    };

    const isRoot = createMemo(() => props.node.data.path.length === 0);
    const isPair = createMemo(() => championIds().length === 2);
    const isBan = createMemo(() => props.node.data.actionType === "ban");
    const nodeRadius = createMemo(() => (isBan() ? BAN_RADIUS : NODE_RADIUS));
    const pairClipLeftId = createMemo(
        () => `node-clip-left-${clipSeed}-${pathKey(props.node.data.path)}`
    );
    const pairClipRightId = createMemo(
        () => `node-clip-right-${clipSeed}-${pathKey(props.node.data.path)}`
    );
    const singleClipId = createMemo(
        () => `node-clip-${clipSeed}-${pathKey(props.node.data.path)}`
    );
    const imageDiameter = createMemo(() => (nodeRadius() - 2) * 2);
    const nodeWidth = createMemo(() => (isPair() ? PAIR_NODE_WIDTH : nodeRadius() * 2));
    const nodeHeight = createMemo(() => (isPair() ? PAIR_NODE_HEIGHT : nodeRadius() * 2));
    const badgeOffsetY = createMemo(() => nodeHeight() / 2 + 12);
    const badgeOffsetX = createMemo(() => nodeWidth() / 2 - 5);
    const userBadgeX = createMemo(() => nodeWidth() / 2 - 5);
    const championLabel = createMemo(() => {
        const names = champions().map((champion) => champion.name);
        return names.length > 0 ? names.join(" + ") : "Draft root";
    });
    const highlighted = createMemo(() =>
        isPathHighlighted(props.node.data.path, props.highlightedPath)
    );
    const isBanAction = createMemo(
        () => props.node.data.actionType === "ban" && !isRoot()
    );
    const effectiveStroke = createMemo(() => {
        if (props.isLineageHover) {
            return "#22d3ee";
        }
        if (isRoot()) {
            return "#94a3b8";
        }

        return sideColor(props.node.data.side, isBanAction());
    });
    const strokeWidth = createMemo(() => {
        if (highlighted()) {
            return 3;
        }

        return props.isConfirmed ? 3 : 1.75;
    });
    const strokeOpacity = createMemo(() => (props.isConfirmed ? 1 : 0.8));
    const fillColor = createMemo(() => (props.isConfirmed ? "#0f172a" : "#0b1220"));
    const isCollapsed = createMemo(() => props.node.data.collapsedChildCount > 0);

    const handleNodeClick = () => {
        if (props.justDragged()) return;
        // If collapsed, expand to reveal children
        if (isCollapsed()) {
            props.onToggleExpand(props.node.data.path);
        }
        // Always fire selection callback
        props.onClick(props.node.data.path);
    };

    return (
        <g
            data-tree-node="true"
            // Phase 7b T16: `group` enables the nested reroot-button's
            // `group-hover:opacity-100` to reveal on parent hover. Tailwind's
            // group/group-hover utilities work on SVG <g> with the standard
            // v3 config used by the project.
            class="group transition-transform duration-200 ease-out"
            transform={`translate(${props.node.x} ${props.node.y})`}
            opacity={strokeOpacity()}
            onPointerDown={(e) => {
                props.onPointerDown(e, props.node.data.path);
            }}
            onMouseEnter={() => props.onHover(props.node.data.path)}
            onMouseLeave={() => props.onHover(null)}
            onContextMenu={(e) => {
                e.preventDefault();
                e.stopPropagation();
                props.onContextMenu(e, props.node.data.path);
            }}
        >
            <title>{championLabel()}</title>
            <defs>
                <clipPath id={singleClipId()}>
                    <circle cx="0" cy="0" r={nodeRadius() - 2} />
                </clipPath>
                <Show when={isPair()}>
                    <>
                        <clipPath id={pairClipLeftId()}>
                            <path d={getPairLeftClipPath()} />
                        </clipPath>
                        <clipPath id={pairClipRightId()}>
                            <path d={getPairRightClipPath()} />
                        </clipPath>
                    </>
                </Show>
            </defs>
            <g class="cursor-pointer" onClick={handleNodeClick}>
                <Show when={props.isLatestConfirmed}>
                    <circle
                        cx="0"
                        cy="0"
                        r={nodeRadius() + 3}
                        fill="none"
                        stroke="#7dd3fc"
                        stroke-width="1.5"
                        opacity="0.75"
                        class="transition-[r,opacity] duration-200 ease-out"
                        filter={`url(#${props.latestGlowFilterId})`}
                    />
                </Show>
                <Show
                    when={isPair()}
                    fallback={
                        <>
                            <circle
                                cx="0"
                                cy="0"
                                r={nodeRadius() + 6}
                                fill={
                                    highlighted()
                                        ? "rgba(96, 165, 250, 0.16)"
                                        : "transparent"
                                }
                            />
                            <circle
                                cx="0"
                                cy="0"
                                r={nodeRadius()}
                                fill={fillColor()}
                                stroke={
                                    highlighted()
                                        ? "#93c5fd"
                                        : props.isLineageHover
                                          ? "#22d3ee"
                                          : effectiveStroke()
                                }
                                stroke-width={strokeWidth()}
                                stroke-dasharray={
                                    props.node.data.userInjected ? "4 3" : undefined
                                }
                                filter={
                                    highlighted()
                                        ? `url(#${props.glowFilterId})`
                                        : undefined
                                }
                            />
                            <Show
                                when={champions()[0]}
                                fallback={
                                    <text
                                        x="0"
                                        y="5"
                                        text-anchor="middle"
                                        font-size="10"
                                        font-weight="600"
                                        fill="#e2e8f0"
                                        class="pointer-events-none"
                                    >
                                        Start
                                    </text>
                                }
                            >
                                {(resolvedChampion) => (
                                    <image
                                        href={resolvedChampion().img}
                                        x={-nodeRadius() + 2}
                                        y={-nodeRadius() + 2}
                                        width={imageDiameter()}
                                        height={imageDiameter()}
                                        preserveAspectRatio="xMidYMid slice"
                                        clip-path={`url(#${singleClipId()})`}
                                        class="pointer-events-none"
                                        style={{
                                            "-webkit-user-drag": "none",
                                            "user-select": "none"
                                        }}
                                    />
                                )}
                            </Show>
                        </>
                    }
                >
                    <>
                        <rect
                            x={-PAIR_NODE_WIDTH / 2 - 6}
                            y={-PAIR_NODE_HEIGHT / 2 - 6}
                            width={PAIR_NODE_WIDTH + 12}
                            height={PAIR_NODE_HEIGHT + 12}
                            rx={PAIR_NODE_HEIGHT / 2 + 6}
                            fill={
                                highlighted() ? "rgba(96, 165, 250, 0.16)" : "transparent"
                            }
                        />
                        <rect
                            x={-PAIR_NODE_WIDTH / 2}
                            y={-PAIR_NODE_HEIGHT / 2}
                            width={PAIR_NODE_WIDTH}
                            height={PAIR_NODE_HEIGHT}
                            rx={PAIR_NODE_HEIGHT / 2}
                            fill={fillColor()}
                            stroke={
                                highlighted()
                                    ? "#93c5fd"
                                    : props.isLineageHover
                                      ? "#22d3ee"
                                      : effectiveStroke()
                            }
                            stroke-width={strokeWidth()}
                            stroke-dasharray={
                                props.node.data.userInjected ? "4 3" : undefined
                            }
                            filter={
                                highlighted() ? `url(#${props.glowFilterId})` : undefined
                            }
                        />
                        <Show when={champions()[0]}>
                            {(resolvedChampion) => {
                                const confirmed = isChampionConfirmed(championIds()[0]);
                                const hasAnyConfirmed = confirmedChampionIds().length > 0;
                                const halfOpacity =
                                    !hasAnyConfirmed || confirmed ? 1 : 0.55;
                                return (
                                    <image
                                        href={resolvedChampion().img}
                                        x={-PAIR_NODE_WIDTH / 2}
                                        y={-PAIR_NODE_HEIGHT / 2}
                                        width={PAIR_NODE_WIDTH / 2 + PAIR_SLASH_OFFSET}
                                        height={PAIR_NODE_HEIGHT}
                                        preserveAspectRatio="xMidYMid slice"
                                        clip-path={`url(#${pairClipLeftId()})`}
                                        opacity={halfOpacity}
                                        class="pointer-events-none transition-opacity duration-150"
                                        style={{
                                            "-webkit-user-drag": "none",
                                            "user-select": "none"
                                        }}
                                    />
                                );
                            }}
                        </Show>
                        <Show when={champions()[1]}>
                            {(resolvedChampion) => {
                                const confirmed = isChampionConfirmed(championIds()[1]);
                                const hasAnyConfirmed = confirmedChampionIds().length > 0;
                                const halfOpacity =
                                    !hasAnyConfirmed || confirmed ? 1 : 0.55;
                                return (
                                    <image
                                        href={resolvedChampion().img}
                                        x={-PAIR_SLASH_OFFSET}
                                        y={-PAIR_NODE_HEIGHT / 2}
                                        width={PAIR_NODE_WIDTH / 2 + PAIR_SLASH_OFFSET}
                                        height={PAIR_NODE_HEIGHT}
                                        preserveAspectRatio="xMidYMid slice"
                                        clip-path={`url(#${pairClipRightId()})`}
                                        opacity={halfOpacity}
                                        class="pointer-events-none transition-opacity duration-150"
                                        style={{
                                            "-webkit-user-drag": "none",
                                            "user-select": "none"
                                        }}
                                    />
                                );
                            }}
                        </Show>
                        <line
                            x1={PAIR_SLASH_OFFSET}
                            y1={-PAIR_NODE_HEIGHT / 2 + PAIR_IMAGE_INSET}
                            x2={-PAIR_SLASH_OFFSET}
                            y2={PAIR_NODE_HEIGHT / 2 - PAIR_IMAGE_INSET}
                            stroke="#0f172a"
                            stroke-width="2"
                            class="pointer-events-none"
                        />
                    </>
                </Show>
                <Show when={isBan() && !isRoot()}>
                    <g class="pointer-events-none">
                        <path
                            d={`M ${-nodeWidth() / 2 + 4} ${-nodeHeight() / 2 + 4} L ${nodeWidth() / 2 - 4} ${nodeHeight() / 2 - 4}`}
                            stroke="#e2e8f0"
                            stroke-width="2"
                            stroke-linecap="round"
                            opacity={props.isConfirmed ? 0.9 : 0.65}
                        />
                    </g>
                </Show>
            </g>
            <Show when={props.node.data.userInjected}>
                <g
                    transform={`translate(${userBadgeX()} -15)`}
                    class="pointer-events-none"
                >
                    <circle
                        cx="0"
                        cy="0"
                        r="6"
                        fill="#0f172a"
                        stroke="#f8fafc"
                        stroke-width="1"
                    />
                    <circle cx="0" cy="-2" r="1.5" fill="#f8fafc" />
                    <path
                        d="M 0 -0.5 L 0 3.5 M -1.5 1.5 L 1.5 1.5"
                        stroke="#f8fafc"
                        stroke-width="1"
                        stroke-linecap="round"
                    />
                </g>
            </Show>
            {/* v5 phase 4: MCTS visit-share badge. Renders below the node when
                the engine attached visit metadata. Color-coded purple to match
                the engine-toggle and banner. Only shown on non-root nodes. */}
            <Show when={!isRoot() && props.node.data.mctsExtras !== undefined}>
                <g
                    transform={`translate(0 ${badgeOffsetY() + 14})`}
                    class="pointer-events-none"
                >
                    <rect
                        x="-22"
                        y="-8"
                        width="44"
                        height="16"
                        rx="8"
                        ry="8"
                        fill="#0f172a"
                        stroke="#a855f7"
                        stroke-width="1"
                        opacity="0.9"
                    />
                    <text
                        x="0"
                        y="3"
                        text-anchor="middle"
                        font-size="9"
                        font-weight="700"
                        fill="#e9d5ff"
                    >
                        {(() => {
                            const x = props.node.data.mctsExtras;
                            if (!x) return "";
                            const pct = Math.round(x.visitShare * 100);
                            return `${pct}% · ${x.visits}`;
                        })()}
                    </text>
                </g>
            </Show>
            {/* v5 phase 7a: Pareto frontier marker. Renders when this node
                lies on its sibling Pareto frontier across (wr, coverage, flex).
                Anchored to the right of the visit-share badge in the same
                transform group (y-offset badgeOffsetY() + 14).
                Stubs receive paretoOnFrontier: false so this never fires for them. */}
            <Show
                when={!isRoot() && props.node.data.mctsExtras?.paretoOnFrontier === true}
            >
                <g
                    transform={`translate(28 ${badgeOffsetY() + 14})`}
                    class="pointer-events-none"
                >
                    <circle
                        cx="0"
                        cy="0"
                        r="6"
                        fill="#fde68a"
                        stroke="#fbbf24"
                        stroke-width="1"
                    />
                    <text
                        x="0"
                        y="2.2"
                        text-anchor="middle"
                        font-size="8"
                        font-weight="700"
                        fill="#92400e"
                    >
                        ★
                    </text>
                </g>
            </Show>
            {/* Expand/collapse badge */}
            <Show when={isCollapsed()}>
                <g
                    transform={`translate(${badgeOffsetX()} ${badgeOffsetY()})`}
                    class="cursor-pointer"
                    onClick={(e) => {
                        e.stopPropagation();
                        props.onToggleExpand(props.node.data.path);
                    }}
                >
                    <circle
                        cx="0"
                        cy="0"
                        r="10"
                        fill="#1e293b"
                        stroke="#475569"
                        stroke-width="1.5"
                    />
                    <text
                        x="0"
                        y="4"
                        text-anchor="middle"
                        font-size="11"
                        font-weight="700"
                        fill="#94a3b8"
                    >
                        +{props.node.data.collapsedChildCount}
                    </text>
                </g>
            </Show>
        </g>
    );
};

const DecisionTree: Component<DecisionTreeProps> = (props) => {
    const {
        manualExpansionKeys,
        manualCollapseKeys,
        setManualExpansionKeys,
        setManualCollapseKeys,
        layoutOverrides,
        setLayoutOverride,
        clearAllLayoutOverrides
    } = useNavigatorContext();
    const svgId = createUniqueId();
    let containerRef: HTMLDivElement | undefined;
    let svgRef: SVGSVGElement | undefined;
    let svgGroupRef: SVGGElement | undefined;
    let panzoomInstance: PanZoom | null = null;
    let resizeObserver: ResizeObserver | null = null;
    const [viewportSize, setViewportSize] = createSignal<ViewportSize>({
        width: 0,
        height: 0
    });
    const [zoomPercent, setZoomPercent] = createSignal(100);

    const storedDevState = import.meta.env.DEV ? loadStoredState() : null;
    const [layoutConfig, setLayoutConfig] = createSignal<RadialLayoutConfig>(
        storedDevState?.config ?? DEFAULT_RADIAL_CONFIG
    );
    const [layoutVariantId, setLayoutVariantId] = createSignal<string>(
        storedDevState?.variantId ?? "radial"
    );
    const [treeFrozen, setTreeFrozen] = createSignal(false);
    const [frozenTree, setFrozenTree] = createSignal<LayoutNode | null>(null);
    const [viewportLocked, setViewportLocked] = createSignal(import.meta.env.DEV);
    const [dragState, setDragState] = createSignal<DragState | null>(null);
    const [justDragged, setJustDragged] = createSignal(false);
    const [hoveredPath, setHoveredPath] = createSignal<number[] | null>(null);
    const [contextMenuState, setContextMenuState] =
        createSignal<TreeContextMenuState | null>(null);
    const DRAG_THRESHOLD_PX = 5;

    const closeContextMenu = () => setContextMenuState(null);

    const handleNodeContextMenu = (event: MouseEvent, path: number[]) => {
        setContextMenuState({
            x: event.pageX,
            y: event.pageY,
            target: { path }
        });
    };

    const effectiveTreeData = createMemo<LayoutNode | null>(() => {
        if (import.meta.env.DEV && treeFrozen()) {
            return frozenTree();
        }
        return props.treeData;
    });

    // Drop manual overrides and layout overrides whose node-key paths no longer exist in the tree.
    createEffect(() => {
        const tree = effectiveTreeData();
        if (!tree) return;
        const validPaths = collectNodeKeyPaths(tree);
        setManualExpansionKeys(
            (prev) => new Set([...prev].filter((k) => validPaths.has(k)))
        );
        setManualCollapseKeys(
            (prev) => new Set([...prev].filter((k) => validPaths.has(k)))
        );
        const overrides = layoutOverrides();
        for (const key of overrides.keys()) {
            if (!validPaths.has(key)) {
                setLayoutOverride(key, null);
            }
        }
    });

    // Scenario paths drive default expansion; manual toggles override
    const expandedPaths = createMemo<ReadonlySet<string>>(() => {
        const base = expandForPaths(props.scenarioPaths);
        const expanded = new Set(base);

        const tree = effectiveTreeData();
        if (tree) {
            applyEngagementOverrides(
                tree,
                expanded,
                manualExpansionKeys(),
                manualCollapseKeys()
            );
        }

        return expanded;
    });
    const toggleExpand = (path: number[]) => {
        const tree = effectiveTreeData();
        if (!tree) return;

        const indexKey = pathKey(path);
        const keyPathString = pathIndicesToNodeKeyPath(tree, path);
        if (!keyPathString) return;

        const annotated = annotatedTree();
        const node = annotated ? getNodeAtPath(annotated, path) : null;
        const currentlyExpanded =
            expandedPaths().has(indexKey) &&
            (node === null ||
                node.actionType !== "ban" ||
                manualExpansionKeys().has(keyPathString));

        if (currentlyExpanded) {
            setManualCollapseKeys((prev) => {
                const next = new Set(prev);
                next.add(keyPathString);
                return next;
            });
            setManualExpansionKeys((prev) => {
                const next = new Set(prev);
                next.delete(keyPathString);
                return next;
            });
        } else {
            setManualExpansionKeys((prev) => {
                const next = new Set(prev);
                next.add(keyPathString);
                return next;
            });
            setManualCollapseKeys((prev) => {
                const next = new Set(prev);
                next.delete(keyPathString);
                return next;
            });
        }
    };

    const annotatedTree = createMemo(() => {
        const treeData = effectiveTreeData();
        if (!treeData) return null;
        return withPaths(treeData);
    });
    const hoveredPathKeys = createMemo<ReadonlySet<string>>(() => {
        const path = hoveredPath();
        if (!path) return new Set();
        const keys = new Set<string>();
        keys.add(pathKey(path));
        if (path.length > 0) {
            keys.add(pathKey(path.slice(0, -1)));
        }
        const tree = annotatedTree();
        if (tree) {
            const node = getNodeAtPath(tree, path);
            if (node) {
                for (let i = 0; i < node.children.length; i++) {
                    keys.add(pathKey([...path, i]));
                }
            }
        }
        return keys;
    });

    const manualExpansionIndexKeys = createMemo<ReadonlySet<string>>(() => {
        const result = new Set<string>();
        const tree = effectiveTreeData();
        if (!tree) return result;

        const collected: Array<{ indexPath: number[]; keyArray: string[] }> = [];
        function walk(node: LayoutNode, indexPath: number[], keyArray: string[]) {
            for (let i = 0; i < node.children.length; i++) {
                const child = node.children[i];
                const nextIndex = [...indexPath, i];
                const nextKeys = [...keyArray, nodeKey(child)];
                collected.push({ indexPath: nextIndex, keyArray: nextKeys });
                walk(child, nextIndex, nextKeys);
            }
        }
        walk(tree, [], []);

        const expansionKeys = manualExpansionKeys();
        for (const { indexPath, keyArray } of collected) {
            if (expansionKeys.has(nodeKeyPath(keyArray))) {
                result.add(pathKey(indexPath));
            }
        }
        return result;
    });

    const getNodeAt = (path: number[]): TreeNodeWithPath | null => {
        const tree = annotatedTree();
        if (!tree) return null;
        return getNodeAtPath(tree, path);
    };

    const collapseSubtree = (path: number[]) => {
        const tree = effectiveTreeData();
        if (!tree) return;
        const keyPathString = pathIndicesToNodeKeyPath(tree, path);
        if (!keyPathString) return;
        setManualCollapseKeys((prev) => {
            const next = new Set(prev);
            next.add(keyPathString);
            return next;
        });
        setManualExpansionKeys((prev) => {
            const next = new Set(prev);
            next.delete(keyPathString);
            return next;
        });
    };

    const copyChampionName = (path: number[]) => {
        const node = getNodeAt(path);
        if (!node) return;
        const names = node.championIds
            .map((id) => resolveChampion(id)?.name)
            .filter((name): name is string => !!name);
        if (names.length === 0) return;
        const text = names.join(" + ");
        void navigator.clipboard
            ?.writeText(text)
            .then(() => toast.success(`Copied "${text}"`))
            .catch(() => toast.error("Failed to copy to clipboard"));
    };

    const resetNodeLayout = (path: number[]) => {
        const tree = effectiveTreeData();
        if (!tree) return;
        const keyPathString = pathIndicesToNodeKeyPath(tree, path);
        if (!keyPathString) return;
        setLayoutOverride(keyPathString, null);
    };

    const currentActions = createMemo<ContextMenuAction[]>(() => {
        const state = contextMenuState();
        if (!state) return [];

        if (state.target === "background") {
            return backgroundActions(layoutOverrides().size > 0, () => {
                clearAllLayoutOverrides();
                closeContextMenu();
            });
        }

        const path = state.target.path;
        const node = getNodeAt(path);
        if (!node) return [];

        const isConfirmed = path.length < props.confirmedDepth;
        const isDepthOneProjected = !isConfirmed && path.length === props.confirmedDepth;
        const tree = effectiveTreeData();
        const nodeKeyPathString = tree ? pathIndicesToNodeKeyPath(tree, path) : null;
        const hasLayoutOverride =
            nodeKeyPathString !== null &&
            nodeKeyPathString !== "" &&
            layoutOverrides().has(nodeKeyPathString);

        return actionsForNode({
            isConfirmed,
            isDepthOneProjected,
            hasLayoutOverride,
            onConfirmPick: () => {
                props.onConfirmProjectedPick?.(path);
                closeContextMenu();
            },
            onCollapseSubtree: () => {
                collapseSubtree(path);
                closeContextMenu();
            },
            onPromoteToScenario: () => {
                props.onPromoteToScenario?.(path);
                closeContextMenu();
            },
            onSwapChampion: () => {
                props.onOpenSwap?.(path);
                closeContextMenu();
            },
            onCreateBranch: () => {
                props.onOpenBranch?.(path);
                closeContextMenu();
            },
            onCopyChampionName: () => {
                copyChampionName(path);
                closeContextMenu();
            },
            onResetNodeLayout: () => {
                resetNodeLayout(path);
                closeContextMenu();
            }
        });
    });

    const prunedTree = createMemo(() => {
        const tree = annotatedTree();
        if (!tree) return null;
        return pruneTree(tree, expandedPaths(), manualExpansionIndexKeys());
    });

    const getOverrideAngle = (keyPath: string): number | undefined => {
        return layoutOverrides().get(keyPath)?.angle;
    };

    const layoutFn = createMemo(() => {
        // Track reactive dep on overrides so layout recomputes when they change.
        layoutOverrides();
        const variantId = layoutVariantId();
        if (variantId === "radial") {
            return makeRadialTreeLayout(layoutConfig(), getOverrideAngle);
        }
        const variant = layoutVariants.find((v) => v.id === variantId);
        return variant?.fn ?? makeRadialTreeLayout(layoutConfig(), getOverrideAngle);
    });

    const layout = createMemo(() => {
        const tree = prunedTree();
        if (!tree) return null;
        return layoutFn()(tree, 20, 20);
    });

    const nodes = createMemo<PositionedNode[]>(() => layout()?.nodes ?? []);
    const links = createMemo<PositionedLink[]>(() => layout()?.links ?? []);
    const latestConfirmedPath = createMemo<number[]>(() =>
        Array.from({ length: props.confirmedDepth - 1 }, () => 0)
    );

    // Compute concentric ring data from positioned nodes
    const depthRings = createMemo(() => {
        const positioned = nodes();
        if (positioned.length === 0) return [];

        // Find center (root node at depth 0)
        const root = positioned.find((n) => n.depth === 0);
        if (!root) return [];

        const cx = root.x;
        const cy = root.y;

        // Group nodes by depth, compute radius as distance from root
        const depthMap = new Map<number, { radius: number; label: string }>();
        for (const node of positioned) {
            if (node.depth === 0) continue;
            const dist = Math.sqrt((node.x - cx) ** 2 + (node.y - cy) ** 2);
            const existing = depthMap.get(node.depth);
            const label = getDepthRingLabel(node.data);

            if (existing === undefined) {
                depthMap.set(node.depth, { radius: dist, label });
            } else {
                depthMap.set(node.depth, {
                    radius: (existing.radius + dist) / 2,
                    label: existing.label
                });
            }
        }

        return Array.from(depthMap.entries())
            .sort((a, b) => a[0] - b[0])
            .map(([depth, ring]) => ({
                depth,
                radius: ring.radius,
                label: ring.label,
                cx,
                cy,
                isLatestConfirmed: depth === props.confirmedDepth - 1
            }));
    });
    const fitTransform = createMemo<FitTransform | null>(() => {
        const nextLayout = layout();
        const viewport = viewportSize();

        if (!nextLayout || viewport.width <= 0 || viewport.height <= 0) {
            return null;
        }

        return getFitTransform(nextLayout.width, nextLayout.height, viewport);
    });

    const applyTransform = (transform: FitTransform) => {
        if (!panzoomInstance) {
            return;
        }

        panzoomInstance.moveTo(transform.x, transform.y);
        panzoomInstance.zoomAbs(0, 0, transform.scale);
        setZoomPercent(Math.round(transform.scale * 100));
    };

    const fitTreeToViewport = () => {
        const transform = fitTransform();

        if (!transform) {
            return;
        }

        applyTransform(transform);
    };

    const zoomBy = (scaleMultiplier: number) => {
        if (!panzoomInstance || !svgRef) {
            return;
        }

        const rect = svgRef.getBoundingClientRect();
        panzoomInstance.smoothZoom(rect.width / 2, rect.height / 2, scaleMultiplier);
    };

    function getCursorAngleFromRoot(pageX: number, pageY: number): number | null {
        if (!svgGroupRef || !svgRef) return null;
        const rootPositioned = nodes().find((n) => n.depth === 0);
        if (!rootPositioned) return null;
        const transform = panzoomInstance?.getTransform();
        if (!transform) return null;
        const svgRect = svgRef.getBoundingClientRect();
        const relX = pageX - svgRect.left;
        const relY = pageY - svgRect.top;
        const groupX = (relX - transform.x) / transform.scale;
        const groupY = (relY - transform.y) / transform.scale;
        const dx = groupX - rootPositioned.x;
        const dy = groupY - rootPositioned.y;
        if (dx === 0 && dy === 0) return null;
        return Math.atan2(dy, dx) + Math.PI / 2;
    }

    const handleNodePointerDown = (event: PointerEvent, indexPath: number[]) => {
        if (event.button !== 0) return;
        const tree = effectiveTreeData();
        if (!tree) return;
        const keyPath = pathIndicesToNodeKeyPath(tree, indexPath);
        if (keyPath === null || keyPath === "") return;
        setDragState({
            keyPath,
            startPageX: event.pageX,
            startPageY: event.pageY,
            startedDragging: false
        });

        const handleMove = (moveEvent: PointerEvent) => {
            const current = dragState();
            if (!current) return;
            const dx = moveEvent.pageX - current.startPageX;
            const dy = moveEvent.pageY - current.startPageY;
            const dist2 = dx * dx + dy * dy;
            if (
                !current.startedDragging &&
                dist2 < DRAG_THRESHOLD_PX * DRAG_THRESHOLD_PX
            ) {
                return;
            }
            if (!current.startedDragging) {
                setDragState({ ...current, startedDragging: true });
            }
            const angle = getCursorAngleFromRoot(moveEvent.pageX, moveEvent.pageY);
            if (angle === null) return;
            setLayoutOverride(current.keyPath, { angle });
        };

        const handleUp = () => {
            window.removeEventListener("pointermove", handleMove);
            window.removeEventListener("pointerup", handleUp);
            const state = dragState();
            if (state?.startedDragging) {
                setJustDragged(true);
                queueMicrotask(() => setJustDragged(false));
            }
            setDragState(null);
        };

        window.addEventListener("pointermove", handleMove);
        window.addEventListener("pointerup", handleUp);
    };

    onMount(() => {
        const updateViewportSize = () => {
            if (!containerRef) {
                return;
            }

            setViewportSize({
                width: containerRef.clientWidth,
                height: containerRef.clientHeight
            });
        };

        updateViewportSize();

        if (containerRef) {
            resizeObserver = new ResizeObserver(() => updateViewportSize());
            resizeObserver.observe(containerRef);
        }

        if (svgGroupRef) {
            panzoomInstance = createPanZoom(svgGroupRef, {
                smoothScroll: false,
                zoomSpeed: 0.12,
                bounds: true,
                boundsPadding: 0.2,
                maxZoom: 12,
                minZoom: 0.05,
                filterKey: () => true,
                disableKeyboardInteraction: true,
                beforeMouseDown: (event) => isElementWithinNode(event.target)
            });

            panzoomInstance.on("transform", () => {
                if (!panzoomInstance) {
                    return;
                }

                setZoomPercent(Math.round(panzoomInstance.getTransform().scale * 100));
            });
        }

        onCleanup(() => {
            panzoomInstance?.dispose();
            panzoomInstance = null;
            resizeObserver?.disconnect();
            resizeObserver = null;
        });
    });

    createEffect(() => {
        const transform = fitTransform();
        if (!transform || !panzoomInstance) {
            return;
        }

        panzoomInstance.setMinZoom(Math.max(roundScale(transform.scale * 0.6), 0.05));
        panzoomInstance.setMaxZoom(Math.max(roundScale(transform.scale * 16), 8));

        if (viewportLocked()) {
            return;
        }

        const current = panzoomInstance.getTransform();
        const requiredScale = transform.scale;

        if (current.scale > requiredScale + 1e-4) {
            panzoomInstance.smoothMoveTo(transform.x, transform.y);
            panzoomInstance.smoothZoom(0, 0, transform.scale / current.scale);
        }
    });

    // Pan (no zoom change) to bring a requested path into view. This should
    // only run when a new panRequest object arrives; later layout changes from
    // local expand/collapse should not re-center the viewport.
    createEffect(
        on(
            () => props.panRequest,
            (request) => {
                if (!request || !panzoomInstance) return;

                const currentLayout = untrack(layout);
                const viewport = untrack(viewportSize);
                if (!currentLayout || viewport.width <= 0 || viewport.height <= 0) return;

                const targetNodes = currentLayout.nodes.filter((node) =>
                    isPrefix(node.data.path, request.path)
                );
                if (targetNodes.length === 0) return;

                const xs = targetNodes.map((n) => n.x);
                const ys = targetNodes.map((n) => n.y);
                const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
                const cy = (Math.min(...ys) + Math.max(...ys)) / 2;

                const currentTransform = panzoomInstance.getTransform();
                const nextX = viewport.width / 2 - cx * currentTransform.scale;
                const nextY = viewport.height / 2 - cy * currentTransform.scale;
                panzoomInstance.moveTo(nextX, nextY);
            },
            { defer: true }
        )
    );

    return (
        <div
            ref={containerRef}
            class="relative h-full w-full overflow-hidden"
            onContextMenu={(e) => {
                if (
                    e.target instanceof Element &&
                    e.target.closest("[data-tree-node='true']")
                ) {
                    return;
                }
                e.preventDefault();
                setContextMenuState({ x: e.pageX, y: e.pageY, target: "background" });
            }}
        >
            <Show when={props.isComputing || props.isSessionActive || props.hasPausedSession}>
                {/* Phase 7b T15: indicator wrapper drops `pointer-events-none`
                    so the embedded Stop button is clickable. The button itself
                    is gated on `isSessionActive` — αβ never sets that flag, so
                    αβ users see the original badge with no button. */}
                <div
                    class="absolute right-3 top-3 z-10 flex items-center gap-2 rounded-full border border-slate-700/50 bg-slate-900/80 px-3 py-1 text-xs text-slate-300 backdrop-blur"
                    role="status"
                    aria-live="polite"
                >
                    <Show
                        when={!props.hasPausedSession}
                        fallback={
                            <span
                                class="h-3 w-3 rounded-full bg-slate-500"
                                aria-hidden="true"
                            />
                        }
                    >
                        <span
                            class="h-3 w-3 animate-spin rounded-full border-2 border-slate-600 border-t-sky-300"
                            aria-hidden="true"
                        />
                    </Show>
                    <span>
                        {props.isStopping
                            ? "Stopping…"
                            : props.hasPausedSession
                            ? "Paused"
                            : "Computing…"}
                    </span>
                    <Show when={props.indicatorMeta}>
                        {(metaAcc) => {
                            const m = metaAcc();
                            const iters = m.mctsMeta?.iterations ?? null;
                            const elapsedMs = m.computeTimeMs ?? null;
                            // Only render the readout when at least one
                            // counter is present — keeps αβ snapshots (no
                            // mctsMeta, no computeTimeMs while streaming)
                            // from showing a noisy "Iter 0 · 0.0s".
                            if (iters === null && elapsedMs === null) {
                                return null;
                            }
                            const itersStr =
                                iters !== null ? iters.toLocaleString() : "—";
                            const elapsedStr =
                                elapsedMs !== null
                                    ? `${(elapsedMs / 1000).toFixed(1)}s`
                                    : "—";
                            return (
                                <span class="text-slate-400">
                                    Iter {itersStr} · {elapsedStr}
                                </span>
                            );
                        }}
                    </Show>
                    {/* Plan §"Task 15": Stop button gated on isSessionActive
                        (NOT partialSnapshot — Opus R1-#21) so users can stop
                        during the latency_budget_ms floor before the first
                        partial arrives. */}
                    <Show when={props.isSessionActive && props.onStop}>
                        <button
                            type="button"
                            onClick={(e) => {
                                e.stopPropagation();
                                props.onStop?.();
                            }}
                            disabled={props.isStopping}
                            class="rounded-full border border-slate-600 bg-slate-800/80 px-2.5 py-0.5 text-[11px] font-medium text-slate-200 transition-colors hover:border-slate-500 hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-60"
                        >
                            {props.isStopping ? "Stopping…" : "Stop"}
                        </button>
                    </Show>
                    {/* Phase 7c T13: Resume button. Mutually exclusive with Stop via
                        hasPausedSession's !isSessionActive term. Same styling as Stop. */}
                    <Show when={props.hasPausedSession && props.onResume}>
                        <button
                            type="button"
                            onClick={(e) => {
                                e.stopPropagation();
                                props.onResume?.();
                            }}
                            disabled={props.isStopping}
                            class="rounded-full border border-slate-600 bg-slate-800/80 px-2.5 py-0.5 text-[11px] font-medium text-slate-200 transition-colors hover:border-slate-500 hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-60"
                        >
                            Resume
                        </button>
                    </Show>
                </div>
            </Show>
            <Show when={import.meta.env.DEV}>
                <LayoutKnobPanel
                    config={layoutConfig()}
                    onConfigChange={setLayoutConfig}
                    variantId={layoutVariantId()}
                    onVariantChange={setLayoutVariantId}
                    frozen={treeFrozen()}
                    onFreezeChange={setTreeFrozen}
                    viewportLocked={viewportLocked()}
                    onViewportLockChange={setViewportLocked}
                    liveTree={props.treeData}
                    frozenTree={frozenTree()}
                    onFrozenTreeChange={setFrozenTree}
                />
            </Show>
            <div class="absolute left-4 top-4 z-10 flex items-center gap-2">
                <div class="rounded-full border border-slate-700/80 bg-slate-950/85 px-3 py-1 text-[11px] font-medium uppercase tracking-[0.14em] text-slate-300 shadow-lg shadow-slate-950/30">
                    {zoomPercent()}%
                </div>
                <div class="flex items-center gap-1 rounded-full border border-slate-700/80 bg-slate-950/85 p-1 shadow-lg shadow-slate-950/30">
                    <button
                        type="button"
                        class="rounded-full px-2.5 py-1 text-sm font-medium text-slate-200 transition-colors hover:bg-slate-800"
                        onClick={() => zoomBy(1.25)}
                    >
                        +
                    </button>
                    <button
                        type="button"
                        class="rounded-full px-2.5 py-1 text-sm font-medium text-slate-200 transition-colors hover:bg-slate-800"
                        onClick={() => zoomBy(0.8)}
                    >
                        -
                    </button>
                    <button
                        type="button"
                        class="rounded-full px-3 py-1 text-xs font-medium text-slate-200 transition-colors hover:bg-slate-800"
                        onClick={fitTreeToViewport}
                    >
                        Fit
                    </button>
                </div>
            </div>

            <svg ref={svgRef} class="h-full w-full" style={{ background: "transparent" }}>
                <defs>
                    <filter
                        id={`tree-glow-${svgId}`}
                        x="-50%"
                        y="-50%"
                        width="200%"
                        height="200%"
                    >
                        <feDropShadow
                            dx="0"
                            dy="0"
                            stdDeviation="3"
                            flood-color="#60a5fa"
                            flood-opacity="0.75"
                        />
                    </filter>
                    <filter
                        id={`latest-glow-${svgId}`}
                        x="-50%"
                        y="-50%"
                        width="200%"
                        height="200%"
                    >
                        <feDropShadow
                            dx="0"
                            dy="0"
                            stdDeviation="4"
                            flood-color="#7dd3fc"
                            flood-opacity="0.8"
                        />
                    </filter>
                </defs>
                <g ref={svgGroupRef}>
                    {/* Depth rings — concentric circles indicating pick order */}
                    <For each={depthRings()}>
                        {(ring) => (
                            <g>
                                <circle
                                    cx={ring.cx}
                                    cy={ring.cy}
                                    r={ring.radius}
                                    fill="none"
                                    stroke={
                                        ring.isLatestConfirmed ? "#7dd3fc" : "#475569"
                                    }
                                    stroke-width={ring.isLatestConfirmed ? 1.25 : 1}
                                    stroke-dasharray="6 4"
                                    opacity={ring.isLatestConfirmed ? 0.8 : 0.5}
                                    class="transition-[stroke,opacity] duration-200 ease-out"
                                />
                                <text
                                    x={ring.cx}
                                    y={ring.cy - ring.radius - 6}
                                    text-anchor="middle"
                                    font-size="11"
                                    font-weight="500"
                                    fill="#64748b"
                                >
                                    {ring.label}
                                </text>
                            </g>
                        )}
                    </For>
                    <For each={links()}>
                        {(link) => {
                            const isLineage = createMemo(() => {
                                const path = hoveredPath();
                                if (!path) return false;
                                const targetKey = pathKey(link.target.data.path);
                                const sourceKey = pathKey(link.source.data.path);
                                return (
                                    hoveredPathKeys().has(targetKey) &&
                                    hoveredPathKeys().has(sourceKey)
                                );
                            });
                            return (
                                <TreeLink
                                    link={link}
                                    highlightedPath={props.highlightedPath}
                                    isLineageHover={isLineage()}
                                />
                            );
                        }}
                    </For>
                    <For each={nodes()}>
                        {(node) => (
                            <TreeNodeComponent
                                node={node}
                                highlightedPath={props.highlightedPath}
                                glowFilterId={`tree-glow-${svgId}`}
                                latestGlowFilterId={`latest-glow-${svgId}`}
                                onClick={props.onNodeClick}
                                onPointerDown={handleNodePointerDown}
                                onToggleExpand={toggleExpand}
                                isConfirmed={node.data.path.length < props.confirmedDepth}
                                isLatestConfirmed={
                                    pathKey(node.data.path) ===
                                    pathKey(latestConfirmedPath())
                                }
                                justDragged={justDragged}
                                isLineageHover={hoveredPathKeys().has(
                                    pathKey(node.data.path)
                                )}
                                onHover={setHoveredPath}
                                onContextMenu={handleNodeContextMenu}
                            />
                        )}
                    </For>
                </g>
                <Show when={!props.treeData}>
                    <text
                        x="50%"
                        y="50%"
                        text-anchor="middle"
                        fill="#94a3b8"
                        font-size="16"
                    >
                        Waiting for engine output
                    </text>
                </Show>
            </svg>
            <Show when={contextMenuState()}>
                {(state) => (
                    <ContextMenu
                        position={{ x: state().x, y: state().y }}
                        actions={currentActions()}
                        onClose={closeContextMenu}
                    />
                )}
            </Show>
        </div>
    );
};

export default DecisionTree;
