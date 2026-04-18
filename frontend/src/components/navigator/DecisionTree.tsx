import {
    Component,
    For,
    Show,
    createEffect,
    createMemo,
    createSignal,
    createUniqueId,
    onCleanup,
    onMount
} from "solid-js";
import createPanZoom, { type PanZoom } from "panzoom";
import { resolveChampion } from "../../utils/constants";
import { LayoutNode, radialTreeLayout } from "../../utils/treeLayout";

export type ScenarioPathTier = "selected" | "unselected";

export interface TieredScenarioPath {
    path: number[];
    tier: ScenarioPathTier;
}

interface DecisionTreeProps {
    treeData: LayoutNode | null;
    isComputing: boolean;
    highlightedPath: number[] | null;
    rootChampionId: string | null;
    scenarioPaths: TieredScenarioPath[];
    panRequest: { path: number[] } | null;
    onNodeClick: (nodeIndex: number[]) => void;
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

interface FitTransform {
    x: number;
    y: number;
    scale: number;
}

const NODE_RADIUS = 20;
const PAIR_NODE_WIDTH = NODE_RADIUS * 2.9;
const PAIR_NODE_HEIGHT = NODE_RADIUS * 2.2;
const PAIR_SLASH_OFFSET = 7;
const BAN_RADIUS = NODE_RADIUS * 0.8;
const TREE_PADDING = 56;

function getPairClipRadius() {
    return PAIR_NODE_HEIGHT / 2;
}

function getPairLeftClipPath() {
    const halfWidth = PAIR_NODE_WIDTH / 2;
    const halfHeight = PAIR_NODE_HEIGHT / 2;
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
    const halfWidth = PAIR_NODE_WIDTH / 2;
    const halfHeight = PAIR_NODE_HEIGHT / 2;
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
        children: node.children.map((child, index) =>
            withPaths(child, [...path, index])
        )
    };
}

function pruneTree(
    node: TreeNodeWithPath,
    expandedPaths: ReadonlySet<string>,
    manualExpansions: ReadonlySet<string>
): TreeNodeWithPath {
    const key = pathKey(node.path);
    const isExpanded =
        node.path.length === 0 ||
        (expandedPaths.has(key) &&
            (node.actionType !== "ban" || manualExpansions.has(key)));

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

function radialLinkPath(sourceX: number, sourceY: number, targetX: number, targetY: number) {
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
    return target instanceof Element && target.closest("[data-tree-node='true']") !== null;
}

function isPrefix(shorter: number[], longer: number[]): boolean {
    if (shorter.length > longer.length) return false;
    for (let i = 0; i < shorter.length; i++) {
        if (shorter[i] !== longer[i]) return false;
    }
    return true;
}

const TreeLink: Component<{
    link: PositionedLink;
    highlightedPath: number[] | null;
    ghosted: boolean;
}> = (props) => {
    const highlighted = createMemo(() =>
        isPathHighlighted(props.link.target.data.path, props.highlightedPath)
    );
    const strokeOpacity = createMemo(() => {
        if (highlighted()) return 0.95;
        if (props.ghosted) return 0.3;
        return 0.8;
    });
    const strokeWidth = createMemo(() => {
        if (highlighted()) return 3;
        if (props.ghosted) return 1;
        return 1.75;
    });

    return (
        <path
            d={radialLinkPath(
                props.link.source.x,
                props.link.source.y,
                props.link.target.x,
                props.link.target.y
            )}
            fill="none"
            stroke={highlighted() ? "#60a5fa" : "#334155"}
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
    rootChampionId: string | null;
    onClick: (path: number[]) => void;
    onToggleExpand: (path: number[]) => void;
    ghosted: boolean;
}> = (props) => {
    const clipSeed = createUniqueId();
    const championIds = createMemo(() => {
        if (props.node.data.path.length === 0) {
            return props.rootChampionId ? [props.rootChampionId] : props.node.data.championIds;
        }

        return props.node.data.championIds;
    });
    const champions = createMemo(() =>
        championIds()
            .map((championId) => resolveChampion(championId))
            .filter(
                (
                    champion
                ): champion is NonNullable<ReturnType<typeof resolveChampion>> =>
                    champion !== undefined
            )
    );
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
    const nodeWidth = createMemo(() =>
        isPair() ? PAIR_NODE_WIDTH : nodeRadius() * 2
    );
    const nodeHeight = createMemo(() =>
        isPair() ? PAIR_NODE_HEIGHT : nodeRadius() * 2
    );
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
    const sideStroke = createMemo(() => {
        if (isRoot()) {
            return "#94a3b8";
        }

        if (isBan()) {
            return "#64748b";
        }

        if (props.node.data.side === "blue") {
            return "#3b82f6";
        }

        if (props.node.data.side === "red") {
            return "#ef4444";
        }

        return "#94a3b8";
    });
    const isCollapsed = createMemo(() => props.node.data.collapsedChildCount > 0);

    const handleNodeClick = () => {
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
            transform={`translate(${props.node.x} ${props.node.y})`}
            opacity={props.ghosted ? 0.4 : isBan() ? 0.7 : 1}
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
                                fill="#0f172a"
                                stroke={highlighted() ? "#93c5fd" : sideStroke()}
                                stroke-width={highlighted() ? 3 : 2}
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
                                highlighted()
                                    ? "rgba(96, 165, 250, 0.16)"
                                    : "transparent"
                            }
                        />
                        <rect
                            x={-PAIR_NODE_WIDTH / 2}
                            y={-PAIR_NODE_HEIGHT / 2}
                            width={PAIR_NODE_WIDTH}
                            height={PAIR_NODE_HEIGHT}
                            rx={PAIR_NODE_HEIGHT / 2}
                            fill="#0f172a"
                            stroke={highlighted() ? "#93c5fd" : sideStroke()}
                            stroke-width={highlighted() ? 3 : 2}
                            stroke-dasharray={
                                props.node.data.userInjected ? "4 3" : undefined
                            }
                            filter={
                                highlighted()
                                    ? `url(#${props.glowFilterId})`
                                    : undefined
                            }
                        />
                        <Show when={champions()[0]}>
                            {(resolvedChampion) => (
                                <image
                                    href={resolvedChampion().img}
                                    x={-PAIR_NODE_WIDTH / 2}
                                    y={-PAIR_NODE_HEIGHT / 2}
                                    width={PAIR_NODE_WIDTH / 2 + PAIR_SLASH_OFFSET}
                                    height={PAIR_NODE_HEIGHT}
                                    preserveAspectRatio="xMidYMid slice"
                                    clip-path={`url(#${pairClipLeftId()})`}
                                    class="pointer-events-none"
                                />
                            )}
                        </Show>
                        <Show when={champions()[1]}>
                            {(resolvedChampion) => (
                                <image
                                    href={resolvedChampion().img}
                                    x={-PAIR_SLASH_OFFSET}
                                    y={-PAIR_NODE_HEIGHT / 2}
                                    width={PAIR_NODE_WIDTH / 2 + PAIR_SLASH_OFFSET}
                                    height={PAIR_NODE_HEIGHT}
                                    preserveAspectRatio="xMidYMid slice"
                                    clip-path={`url(#${pairClipRightId()})`}
                                    class="pointer-events-none"
                                />
                            )}
                        </Show>
                        <line
                            x1={PAIR_SLASH_OFFSET}
                            y1={-PAIR_NODE_HEIGHT / 2}
                            x2={-PAIR_SLASH_OFFSET}
                            y2={PAIR_NODE_HEIGHT / 2}
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
                        />
                        <path
                            d={`M ${nodeWidth() / 2 - 4} ${-nodeHeight() / 2 + 4} L ${-nodeWidth() / 2 + 4} ${nodeHeight() / 2 - 4}`}
                            stroke="#e2e8f0"
                            stroke-width="2"
                            stroke-linecap="round"
                        />
                    </g>
                </Show>
            </g>
            <Show when={props.node.data.userInjected}>
                <g
                    transform={`translate(${userBadgeX()} -15)`}
                    class="pointer-events-none"
                >
                    <circle cx="0" cy="0" r="6" fill="#0f172a" stroke="#f8fafc" stroke-width="1" />
                    <circle cx="0" cy="-2" r="1.5" fill="#f8fafc" />
                    <path
                        d="M 0 -0.5 L 0 3.5 M -1.5 1.5 L 1.5 1.5"
                        stroke="#f8fafc"
                        stroke-width="1"
                        stroke-linecap="round"
                    />
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
    const [manualExpansions, setManualExpansions] = createSignal<ReadonlySet<string>>(
        new Set<string>()
    );
    const [manualCollapses, setManualCollapses] = createSignal<ReadonlySet<string>>(
        new Set<string>()
    );

    // Reset manual overrides when tree data changes
    createEffect(() => {
        // Track treeData to reset on new engine output
        void props.treeData;
        setManualExpansions(new Set<string>());
        setManualCollapses(new Set<string>());
    });

    // Scenario paths drive default expansion; manual toggles override
    const expandedPaths = createMemo<ReadonlySet<string>>(() => {
        const base = expandForPaths(props.scenarioPaths);
        const expanded = new Set(base);

        // Apply manual expansions (user clicked + on a collapsed node)
        for (const key of manualExpansions()) {
            expanded.add(key);
        }

        // Apply manual collapses (user collapsed a previously-open node)
        for (const key of manualCollapses()) {
            expanded.delete(key);
        }

        return expanded;
    });
    const ghostedPathKeys = createMemo<ReadonlySet<string>>(() => {
        const selectedKeys = new Set<string>();
        const unselectedKeys = new Set<string>();

        for (const entry of props.scenarioPaths) {
            const target = entry.tier === "selected" ? selectedKeys : unselectedKeys;
            for (let i = 1; i <= entry.path.length; i++) {
                target.add(pathKey(entry.path.slice(0, i)));
            }
        }

        const result = new Set<string>();
        for (const key of unselectedKeys) {
            if (!selectedKeys.has(key)) result.add(key);
        }
        return result;
    });

    const toggleExpand = (path: number[]) => {
        const key = pathKey(path);
        const tree = annotatedTree();
        const node = tree ? getNodeAtPath(tree, path) : null;
        const currentlyExpanded =
            expandedPaths().has(key) &&
            (node === null ||
                node.actionType !== "ban" ||
                manualExpansions().has(key));

        if (currentlyExpanded) {
            // Collapse: add to manual collapses, remove from manual expansions
            setManualCollapses((prev) => {
                const next = new Set(prev);
                next.add(key);
                return next;
            });
            setManualExpansions((prev) => {
                const next = new Set(prev);
                next.delete(key);
                return next;
            });
        } else {
            // Expand: add to manual expansions, remove from manual collapses
            setManualExpansions((prev) => {
                const next = new Set(prev);
                next.add(key);
                return next;
            });
            setManualCollapses((prev) => {
                const next = new Set(prev);
                next.delete(key);
                return next;
            });
        }
    };

    const annotatedTree = createMemo(() => {
        const treeData = props.treeData;
        if (!treeData) return null;
        return withPaths(treeData);
    });

    const prunedTree = createMemo(() => {
        const tree = annotatedTree();
        if (!tree) return null;
        return pruneTree(tree, expandedPaths(), manualExpansions());
    });

    const layout = createMemo(() => {
        const tree = prunedTree();
        if (!tree) return null;
        return radialTreeLayout(tree, 40, 40);
    });

    const nodes = createMemo<PositionedNode[]>(() => layout()?.nodes ?? []);
    const links = createMemo<PositionedLink[]>(() => layout()?.links ?? []);

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
                cy
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

    let hasPerformedInitialFit = false;

    // Keep zoom bounds fresh as the tree grows, but only auto-fit the viewport
    // on the initial tree load. After that, user navigation is preserved —
    // node expand, scenario select, etc. don't reset the view.
    createEffect(() => {
        const transform = fitTransform();

        if (!transform || !panzoomInstance) {
            return;
        }

        panzoomInstance.setMinZoom(Math.max(roundScale(transform.scale * 0.6), 0.05));
        panzoomInstance.setMaxZoom(Math.max(roundScale(transform.scale * 16), 8));

        if (!hasPerformedInitialFit) {
            applyTransform(transform);
            hasPerformedInitialFit = true;
        }
    });

    // Pan (no zoom change) to bring a requested path into view. Fires on every
    // new panRequest object, even when the target path is the same as before.
    createEffect(() => {
        const request = props.panRequest;
        if (!request || !panzoomInstance) return;

        const currentLayout = layout();
        const viewport = viewportSize();
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
    });

    return (
        <div ref={containerRef} class="relative h-full w-full overflow-hidden">
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
                    <filter id={`tree-glow-${svgId}`} x="-50%" y="-50%" width="200%" height="200%">
                        <feDropShadow dx="0" dy="0" stdDeviation="3" flood-color="#60a5fa" flood-opacity="0.75" />
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
                                    stroke="#475569"
                                    stroke-width={1}
                                    stroke-dasharray="6 4"
                                    opacity={0.5}
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
                        {(link) => (
                            <TreeLink
                                link={link}
                                highlightedPath={props.highlightedPath}
                                ghosted={ghostedPathKeys().has(pathKey(link.target.data.path))}
                            />
                        )}
                    </For>
                    <For each={nodes()}>
                        {(node) => (
                            <TreeNodeComponent
                                node={node}
                                highlightedPath={props.highlightedPath}
                                glowFilterId={`tree-glow-${svgId}`}
                                rootChampionId={props.rootChampionId}
                                onClick={props.onNodeClick}
                                onToggleExpand={toggleExpand}
                                ghosted={ghostedPathKeys().has(pathKey(node.data.path))}
                            />
                        )}
                    </For>
                </g>
                <Show when={props.isComputing}>
                    <>
                        <rect width="100%" height="100%" fill="rgba(15, 23, 42, 0.6)" />
                        <text
                            x="50%"
                            y="50%"
                            text-anchor="middle"
                            fill="#94a3b8"
                            font-size="16"
                        >
                            Recomputing...
                        </text>
                    </>
                </Show>
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
        </div>
    );
};

export default DecisionTree;
