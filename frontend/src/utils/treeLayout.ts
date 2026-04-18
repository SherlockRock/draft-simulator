import { hierarchy, tree, type HierarchyNode } from "d3-hierarchy";

export interface LayoutNode {
    championIds: string[];
    actionType: "ban" | "pick";
    phase: "ban1" | "pick1" | "ban2" | "pick2";
    side: "blue" | "red" | null;
    slots: number[];
    userInjected: boolean;
    scores: {
        composite: number;
        compStrength: number;
        informationValue: number;
        flexRetention: number;
        revealCost: number;
    };
    children: LayoutNode[];
    x?: number;
    y?: number;
    depth?: number;
}

export interface LayoutLink<T extends LayoutNode = LayoutNode> {
    source: { x: number; y: number; data: T };
    target: { x: number; y: number; data: T };
}

export interface LayoutResult<T extends LayoutNode = LayoutNode> {
    nodes: Array<{ x: number; y: number; data: T; depth: number }>;
    links: LayoutLink<T>[];
    width: number;
    height: number;
}

export type LayoutFn = <T extends LayoutNode>(
    treeData: T,
    nodeWidth: number,
    nodeHeight: number
) => LayoutResult<T>;

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function normalizeLayout<T extends LayoutNode>(
    rawNodes: Array<{ x: number; y: number; data: T; depth: number }>,
    rawLinks: Array<{
        source: { x: number; y: number; data: T };
        target: { x: number; y: number; data: T };
    }>,
    paddingX: number,
    paddingY: number
): LayoutResult<T> {
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;

    for (const node of rawNodes) {
        minX = Math.min(minX, node.x);
        maxX = Math.max(maxX, node.x);
        minY = Math.min(minY, node.y);
        maxY = Math.max(maxY, node.y);
    }

    const offsetX = -minX + paddingX;
    const offsetY = -minY + paddingY;

    return {
        nodes: rawNodes.map((n) => ({
            x: n.x + offsetX,
            y: n.y + offsetY,
            data: n.data,
            depth: n.depth
        })),
        links: rawLinks.map((l) => ({
            source: { x: l.source.x + offsetX, y: l.source.y + offsetY, data: l.source.data },
            target: { x: l.target.x + offsetX, y: l.target.y + offsetY, data: l.target.data }
        })),
        width: maxX - minX + paddingX * 2,
        height: maxY - minY + paddingY * 2
    };
}

function d3NodesAndLinks<T extends LayoutNode>(root: HierarchyNode<T>) {
    const descendants = root.descendants();
    const descendantLinks = root.links();

    // After tree()(root), x and y are always assigned by d3
    const rawNodes = descendants.map((node) => ({
        x: node.x ?? 0,
        y: node.y ?? 0,
        data: node.data,
        depth: node.depth
    }));

    const rawLinks = descendantLinks.map((link) => ({
        source: { x: link.source.x ?? 0, y: link.source.y ?? 0, data: link.source.data },
        target: { x: link.target.x ?? 0, y: link.target.y ?? 0, data: link.target.data }
    }));

    return { rawNodes, rawLinks };
}

// ---------------------------------------------------------------------------
// Variant A — Naive recursive (center parent between first & last child)
// ---------------------------------------------------------------------------

export const naiveRecursiveLayout: LayoutFn = <T extends LayoutNode>(
    treeData: T,
    nodeWidth: number,
    nodeHeight: number
): LayoutResult<T> => {
    const hGap = nodeWidth + 36;
    const vGap = nodeHeight + 96;
    const paddingX = nodeWidth * 2;
    const paddingY = nodeHeight * 2;

    const rawNodes: Array<{ x: number; y: number; data: T; depth: number }> = [];
    const rawLinks: Array<{
        source: { x: number; y: number; data: T };
        target: { x: number; y: number; data: T };
    }> = [];

    let nextLeafY = 0;

    function layout(node: T, depth: number): { x: number; y: number } {
        const x = depth * vGap;

        if (node.children.length === 0) {
            const y = nextLeafY;
            nextLeafY += hGap;
            rawNodes.push({ x, y, data: node, depth });
            return { x, y };
        }

        const childPositions = node.children.map((child, _i) => {
            const pos = layout(child as T, depth + 1);
            return pos;
        });

        const firstChild = childPositions[0];
        const lastChild = childPositions[childPositions.length - 1];
        const y = (firstChild.y + lastChild.y) / 2;

        rawNodes.push({ x, y, data: node, depth });

        for (let i = 0; i < node.children.length; i++) {
            rawLinks.push({
                source: { x, y, data: node },
                target: {
                    x: childPositions[i].x,
                    y: childPositions[i].y,
                    data: node.children[i] as T
                }
            });
        }

        return { x, y };
    }

    layout(treeData, 0);
    return normalizeLayout(rawNodes, rawLinks, paddingX, paddingY);
};

// ---------------------------------------------------------------------------
// Variant B — d3-hierarchy Reingold-Tilford (current default)
// ---------------------------------------------------------------------------

export const reingoldTilfordLayout: LayoutFn = <T extends LayoutNode>(
    treeData: T,
    nodeWidth: number,
    nodeHeight: number
): LayoutResult<T> => {
    const hGap = nodeWidth + 36;
    const vGap = nodeHeight + 96;
    const paddingX = nodeWidth * 2;
    const paddingY = nodeHeight * 2;

    const root = hierarchy<T>(treeData, (node) => node.children as T[]);
    const treeLayout = tree<T>().nodeSize([hGap, vGap]);
    const laidOutRoot = treeLayout(root);
    const { rawNodes, rawLinks } = d3NodesAndLinks(laidOutRoot);

    return normalizeLayout(rawNodes, rawLinks, paddingX, paddingY);
};

// ---------------------------------------------------------------------------
// Variant C — Weighted spacing (vertical space proportional to leaf count)
// ---------------------------------------------------------------------------

function countLeaves(node: LayoutNode): number {
    if (node.children.length === 0) return 1;
    return node.children.reduce((sum, child) => sum + countLeaves(child), 0);
}

export const weightedSpacingLayout: LayoutFn = <T extends LayoutNode>(
    treeData: T,
    nodeWidth: number,
    nodeHeight: number
): LayoutResult<T> => {
    const hGap = nodeWidth + 36;
    const vGap = nodeHeight + 96;
    const paddingX = nodeWidth * 2;
    const paddingY = nodeHeight * 2;

    const rawNodes: Array<{ x: number; y: number; data: T; depth: number }> = [];
    const rawLinks: Array<{
        source: { x: number; y: number; data: T };
        target: { x: number; y: number; data: T };
    }> = [];

    function layout(node: T, depth: number, yStart: number, yEnd: number): { x: number; y: number } {
        const x = depth * vGap;

        if (node.children.length === 0) {
            const y = (yStart + yEnd) / 2;
            rawNodes.push({ x, y, data: node, depth });
            return { x, y };
        }

        const totalLeaves = countLeaves(node);
        const totalSpace = yEnd - yStart;
        let currentY = yStart;

        const childPositions: Array<{ x: number; y: number }> = [];

        for (const child of node.children) {
            const childLeaves = countLeaves(child);
            const childSpace = (childLeaves / totalLeaves) * totalSpace;
            const childEnd = currentY + Math.max(childSpace, hGap);

            const pos = layout(child as T, depth + 1, currentY, childEnd);
            childPositions.push(pos);
            currentY = childEnd;
        }

        const firstChild = childPositions[0];
        const lastChild = childPositions[childPositions.length - 1];
        const y = (firstChild.y + lastChild.y) / 2;

        rawNodes.push({ x, y, data: node, depth });

        for (let i = 0; i < node.children.length; i++) {
            rawLinks.push({
                source: { x, y, data: node },
                target: {
                    x: childPositions[i].x,
                    y: childPositions[i].y,
                    data: node.children[i] as T
                }
            });
        }

        return { x, y };
    }

    const totalLeafCount = countLeaves(treeData);
    const totalHeight = totalLeafCount * hGap;
    layout(treeData, 0, 0, totalHeight);

    return normalizeLayout(rawNodes, rawLinks, paddingX, paddingY);
};

// ---------------------------------------------------------------------------
// Variant D — d3-hierarchy compact (tighter spacing + custom separation)
// ---------------------------------------------------------------------------

export const compactD3Layout: LayoutFn = <T extends LayoutNode>(
    treeData: T,
    nodeWidth: number,
    nodeHeight: number
): LayoutResult<T> => {
    const hGap = nodeWidth + 16;
    const vGap = nodeHeight + 64;
    const paddingX = nodeWidth * 2;
    const paddingY = nodeHeight * 2;

    const root = hierarchy<T>(treeData, (node) => node.children as T[]);
    const treeLayout = tree<T>()
        .nodeSize([hGap, vGap])
        .separation((a, b) => (a.parent === b.parent ? 1 : 1.5));
    const laidOutRoot = treeLayout(root);
    const { rawNodes, rawLinks } = d3NodesAndLinks(laidOutRoot);

    return normalizeLayout(rawNodes, rawLinks, paddingX, paddingY);
};

// ---------------------------------------------------------------------------
// Variant E — Radial tree (Reingold-Tilford mapped to polar coordinates)
// ---------------------------------------------------------------------------

export const radialTreeLayout: LayoutFn = <T extends LayoutNode>(
    treeData: T,
    nodeWidth: number,
    nodeHeight: number
): LayoutResult<T> => {
    const nodeRadius = Math.max(nodeWidth, nodeHeight) / 2;
    const ringSpacing = nodeRadius * 4 + 40;
    const padding = nodeRadius * 2;

    const root = hierarchy<T>(treeData, (node) => node.children as T[]);
    const maxDepth = root.height;
    const totalRadius = maxDepth * ringSpacing;

    // Use tree().size() with full circle angle and total radius
    const treeLayout = tree<T>()
        .size([2 * Math.PI, totalRadius])
        .separation((a, b) => (a.parent === b.parent ? 1 : 2) / a.depth);
    const laidOutRoot = treeLayout(root);

    const descendants = laidOutRoot.descendants();
    const descendantLinks = laidOutRoot.links();

    // Convert polar (angle, radius) → cartesian (x, y)
    // d3 assigns: node.x = angle, node.y = radius
    const rawNodes = descendants.map((node) => {
        const angle = node.x ?? 0;
        const radius = node.y ?? 0;
        return {
            x: radius * Math.cos(angle - Math.PI / 2),
            y: radius * Math.sin(angle - Math.PI / 2),
            data: node.data,
            depth: node.depth
        };
    });

    const rawLinks = descendantLinks.map((link) => {
        const sAngle = link.source.x ?? 0;
        const sRadius = link.source.y ?? 0;
        const tAngle = link.target.x ?? 0;
        const tRadius = link.target.y ?? 0;
        return {
            source: {
                x: sRadius * Math.cos(sAngle - Math.PI / 2),
                y: sRadius * Math.sin(sAngle - Math.PI / 2),
                data: link.source.data
            },
            target: {
                x: tRadius * Math.cos(tAngle - Math.PI / 2),
                y: tRadius * Math.sin(tAngle - Math.PI / 2),
                data: link.target.data
            }
        };
    });

    return normalizeLayout(rawNodes, rawLinks, padding, padding);
};

// ---------------------------------------------------------------------------
// Variant F — Radial compact (tighter rings, smaller separation)
// ---------------------------------------------------------------------------

export const radialCompactLayout: LayoutFn = <T extends LayoutNode>(
    treeData: T,
    nodeWidth: number,
    nodeHeight: number
): LayoutResult<T> => {
    const nodeRadius = Math.max(nodeWidth, nodeHeight) / 2;
    const ringSpacing = nodeRadius * 3 + 20;
    const padding = nodeRadius * 2;

    const root = hierarchy<T>(treeData, (node) => node.children as T[]);
    const maxDepth = root.height;
    const totalRadius = maxDepth * ringSpacing;

    const treeLayout = tree<T>()
        .size([2 * Math.PI, totalRadius])
        .separation((a, b) => (a.parent === b.parent ? 1 : 1.5) / a.depth);
    const laidOutRoot = treeLayout(root);

    const descendants = laidOutRoot.descendants();
    const descendantLinks = laidOutRoot.links();

    const rawNodes = descendants.map((node) => {
        const angle = node.x ?? 0;
        const radius = node.y ?? 0;
        return {
            x: radius * Math.cos(angle - Math.PI / 2),
            y: radius * Math.sin(angle - Math.PI / 2),
            data: node.data,
            depth: node.depth
        };
    });

    const rawLinks = descendantLinks.map((link) => {
        const sAngle = link.source.x ?? 0;
        const sRadius = link.source.y ?? 0;
        const tAngle = link.target.x ?? 0;
        const tRadius = link.target.y ?? 0;
        return {
            source: {
                x: sRadius * Math.cos(sAngle - Math.PI / 2),
                y: sRadius * Math.sin(sAngle - Math.PI / 2),
                data: link.source.data
            },
            target: {
                x: tRadius * Math.cos(tAngle - Math.PI / 2),
                y: tRadius * Math.sin(tAngle - Math.PI / 2),
                data: link.target.data
            }
        };
    });

    return normalizeLayout(rawNodes, rawLinks, padding, padding);
};

// ---------------------------------------------------------------------------
// Registry for test harness
// ---------------------------------------------------------------------------

export interface LayoutVariant {
    id: string;
    name: string;
    description: string;
    fn: LayoutFn;
}

export const layoutVariants: LayoutVariant[] = [
    {
        id: "naive",
        name: "Naive Recursive",
        description: "Center parent between first and last child",
        fn: naiveRecursiveLayout
    },
    {
        id: "reingold-tilford",
        name: "Reingold-Tilford",
        description: "d3-hierarchy tidy tree algorithm",
        fn: reingoldTilfordLayout
    },
    {
        id: "weighted",
        name: "Weighted Spacing",
        description: "Space proportional to subtree leaf count",
        fn: weightedSpacingLayout
    },
    {
        id: "compact",
        name: "Compact D3",
        description: "Tighter spacing with custom sibling/non-sibling separation",
        fn: compactD3Layout
    },
    {
        id: "radial",
        name: "Radial Tree",
        description: "Root at center, children radiate outward in a circle",
        fn: radialTreeLayout
    },
    {
        id: "radial-compact",
        name: "Radial Compact",
        description: "Tighter radial with reduced ring spacing",
        fn: radialCompactLayout
    }
];

// ---------------------------------------------------------------------------
// Default export — backwards compatible (Reingold-Tilford)
// ---------------------------------------------------------------------------

export function computeTreeLayout<T extends LayoutNode>(
    treeData: T,
    nodeWidth: number,
    nodeHeight: number
): LayoutResult<T> {
    return reingoldTilfordLayout(treeData, nodeWidth, nodeHeight);
}
