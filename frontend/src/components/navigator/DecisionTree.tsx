import { Component, For, Show, createMemo, createUniqueId, onCleanup, onMount } from "solid-js";
import { resolveChampion } from "../../utils/constants";
import panzoom from "../../utils/panzoom";
import { LayoutNode, computeTreeLayout } from "../../utils/treeLayout";

interface DecisionTreeProps {
    treeData: LayoutNode | null;
    isComputing: boolean;
    highlightedPath: number[] | null;
    onNodeClick: (nodeIndex: number[]) => void;
}

interface TreeNodeWithPath extends LayoutNode {
    path: number[];
    children: TreeNodeWithPath[];
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

const NODE_RADIUS = 20;

function withPaths(node: LayoutNode, path: number[] = []): TreeNodeWithPath {
    return {
        ...node,
        path,
        children: node.children.map((child, index) =>
            withPaths(child, [...path, index])
        )
    };
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

function linkPath(sourceX: number, sourceY: number, targetX: number, targetY: number) {
    const midX = (sourceX + targetX) / 2;
    return `M ${sourceX},${sourceY} C ${midX},${sourceY} ${midX},${targetY} ${targetX},${targetY}`;
}

const TreeLink: Component<{
    link: PositionedLink;
    highlightedPath: number[] | null;
}> = (props) => {
    const highlighted = createMemo(() =>
        isPathHighlighted(props.link.target.data.path, props.highlightedPath)
    );

    return (
        <path
            d={linkPath(
                props.link.source.x,
                props.link.source.y,
                props.link.target.x,
                props.link.target.y
            )}
            fill="none"
            stroke={highlighted() ? "#60a5fa" : "#334155"}
            stroke-width={highlighted() ? 3 : 1.75}
            stroke-linecap="round"
            opacity={highlighted() ? 0.95 : 0.8}
        />
    );
};

const TreeNodeComponent: Component<{
    node: PositionedNode;
    highlightedPath: number[] | null;
    glowFilterId: string;
    onClick: (path: number[]) => void;
}> = (props) => {
    const clipSeed = createUniqueId();
    const champion = createMemo(() => {
        const championId = props.node.data.championId;
        return championId ? resolveChampion(championId) : undefined;
    });
    const highlighted = createMemo(() =>
        isPathHighlighted(props.node.data.path, props.highlightedPath)
    );
    const clipId = createMemo(
        () => `node-clip-${clipSeed}-${pathKey(props.node.data.path)}`
    );
    const sideStroke = createMemo(() => {
        if (props.node.data.side === "blue") {
            return "#3b82f6";
        }

        if (props.node.data.side === "red") {
            return "#ef4444";
        }

        return "#94a3b8";
    });
    const label = createMemo(() => champion()?.name ?? "Draft root");

    return (
        <g
            transform={`translate(${props.node.x} ${props.node.y})`}
            class="cursor-pointer"
            onClick={() => props.onClick(props.node.data.path)}
        >
            <title>{label()}</title>
            <defs>
                <clipPath id={clipId()}>
                    <circle cx="0" cy="0" r={NODE_RADIUS - 2} />
                </clipPath>
            </defs>
            <circle
                cx="0"
                cy="0"
                r={NODE_RADIUS + 6}
                fill={highlighted() ? "rgba(96, 165, 250, 0.16)" : "transparent"}
            />
            <circle
                cx="0"
                cy="0"
                r={NODE_RADIUS}
                fill="#0f172a"
                stroke={highlighted() ? "#93c5fd" : sideStroke()}
                stroke-width={highlighted() ? 3 : 2}
                stroke-dasharray={props.node.data.userInjected ? "4 3" : undefined}
                filter={highlighted() ? `url(#${props.glowFilterId})` : undefined}
            />
            <Show
                when={champion()}
                fallback={
                    <text
                        x="0"
                        y="5"
                        text-anchor="middle"
                        font-size="10"
                        font-weight="600"
                        fill="#e2e8f0"
                    >
                        Start
                    </text>
                }
            >
                {(resolvedChampion) => (
                    <image
                        href={resolvedChampion().img}
                        x={-NODE_RADIUS + 2}
                        y={-NODE_RADIUS + 2}
                        width={(NODE_RADIUS - 2) * 2}
                        height={(NODE_RADIUS - 2) * 2}
                        preserveAspectRatio="xMidYMid slice"
                        clip-path={`url(#${clipId()})`}
                    />
                )}
            </Show>
            <Show when={props.node.data.userInjected}>
                <g transform="translate(15 -15)">
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
            <Show when={props.node.depth > 0}>
                <text
                    x="0"
                    y={NODE_RADIUS + 18}
                    text-anchor="middle"
                    font-size="10"
                    font-weight="500"
                    fill="#e2e8f0"
                >
                    {label()}
                </text>
            </Show>
        </g>
    );
};

const DecisionTree: Component<DecisionTreeProps> = (props) => {
    const svgId = createUniqueId();
    let svgGroupRef: SVGGElement | undefined;

    const layout = createMemo(() => {
        const treeData = props.treeData;

        if (!treeData) {
            return null;
        }

        const annotatedTree = withPaths(treeData);
        return computeTreeLayout<TreeNodeWithPath>(annotatedTree, 40, 40);
    });

    const nodes = createMemo<PositionedNode[]>(() => layout()?.nodes ?? []);
    const links = createMemo<PositionedLink[]>(() => layout()?.links ?? []);

    onMount(() => {
        if (svgGroupRef) {
            const instance = panzoom(svgGroupRef, {
                smoothScroll: false,
                bounds: true,
                boundsPadding: 0.1,
                maxZoom: 3,
                minZoom: 0.3
            });

            onCleanup(() => instance.dispose());
        }
    });

    return (
        <div class="relative h-full w-full overflow-hidden">
            <svg
                class="h-full w-full"
                viewBox={`0 0 ${layout()?.width ?? 800} ${layout()?.height ?? 480}`}
                style={{ background: "transparent" }}
            >
                <defs>
                    <filter id={`tree-glow-${svgId}`} x="-50%" y="-50%" width="200%" height="200%">
                        <feDropShadow dx="0" dy="0" stdDeviation="3" flood-color="#60a5fa" flood-opacity="0.75" />
                    </filter>
                </defs>
                <g ref={svgGroupRef}>
                    <For each={links()}>
                        {(link) => (
                            <TreeLink
                                link={link}
                                highlightedPath={props.highlightedPath}
                            />
                        )}
                    </For>
                    <For each={nodes()}>
                        {(node) => (
                            <TreeNodeComponent
                                node={node}
                                highlightedPath={props.highlightedPath}
                                glowFilterId={`tree-glow-${svgId}`}
                                onClick={props.onNodeClick}
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
