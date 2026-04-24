import { hierarchy, tree, type HierarchyNode } from "d3-hierarchy";
import { nodeKey, nodeKeyPath } from "./treeReconcile";

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
    confirmedChampionIds?: string[];
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
            source: {
                x: l.source.x + offsetX,
                y: l.source.y + offsetY,
                data: l.source.data
            },
            target: {
                x: l.target.x + offsetX,
                y: l.target.y + offsetY,
                data: l.target.data
            }
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

    function layout(
        node: T,
        depth: number,
        yStart: number,
        yEnd: number
    ): { x: number; y: number } {
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

export type BonusDistributionMode =
    | "proportional-to-deficit"
    | "equal"
    | "proportional-to-min";

export interface RadialLayoutConfig {
    /** Multiplier applied to nodeRadius when computing ring spacing. Final: nodeRadius * ringSpacingMultiplier + ringSpacingOffset. */
    ringSpacingMultiplier: number;
    /** Additive offset applied to ring spacing. */
    ringSpacingOffset: number;
    /** Target angular occupancy (0..1) used when computing preferred spans for deeper projected layers. */
    targetOccupancy: number;
    /** Radial depth step for single-child (spine) chains. 1.0 = normal, <1 = tighter spine. */
    spineCompressionStep: number;
    /** Extra chord padding added to a node's own footprint when computing self-span (pixels). */
    selfPadding: number;
    /** Sibling minimum-gap chord as a ratio of nodeWidth. */
    siblingMinChordRatio: number;
    /** Absolute floor on the sibling min-gap chord (pixels). */
    siblingMinChordFloor: number;
    /** Divisor used in occupancy relaxation formula: level / (level + occupancyRelaxDivisor). Higher = slower relaxation. */
    occupancyRelaxDivisor: number;
    /** How the bonus angular space (preferredSpan - minSpan) is distributed to siblings. */
    bonusDistributionMode: BonusDistributionMode;
}

export const DEFAULT_RADIAL_CONFIG: RadialLayoutConfig = {
    ringSpacingMultiplier: 6.4,
    ringSpacingOffset: 40,
    targetOccupancy: 0.78,
    spineCompressionStep: 0.4,
    selfPadding: 31,
    siblingMinChordRatio: 0.4,
    siblingMinChordFloor: 9,
    occupancyRelaxDivisor: 2,
    bonusDistributionMode: "proportional-to-deficit"
};

export function makeRadialTreeLayout(
    config: RadialLayoutConfig = DEFAULT_RADIAL_CONFIG,
    getOverrideAngle?: (keyPath: string) => number | undefined
): LayoutFn {
    return <T extends LayoutNode>(
        treeData: T,
        nodeWidth: number,
        nodeHeight: number
    ): LayoutResult<T> =>
        radialTreeLayoutWithConfig(
            treeData,
            nodeWidth,
            nodeHeight,
            config,
            getOverrideAngle
        );
}

export const radialTreeLayout: LayoutFn = <T extends LayoutNode>(
    treeData: T,
    nodeWidth: number,
    nodeHeight: number
): LayoutResult<T> =>
    radialTreeLayoutWithConfig(treeData, nodeWidth, nodeHeight, DEFAULT_RADIAL_CONFIG);

function radialTreeLayoutWithConfig<T extends LayoutNode>(
    treeData: T,
    nodeWidth: number,
    nodeHeight: number,
    config: RadialLayoutConfig,
    getOverrideAngle?: (keyPath: string) => number | undefined
): LayoutResult<T> {
    const nodeRadius = Math.max(nodeWidth, nodeHeight) / 2;
    const ringSpacing =
        nodeRadius * config.ringSpacingMultiplier + config.ringSpacingOffset;
    const padding = nodeRadius * 2;

    interface MeasuredNode {
        data: T;
        depth: number;
        radius: number;
        radialDepth: number;
        isSpine: boolean;
        selfSpan: number;
        profile: number[];
        minSpan: number;
        preferredSpan: number;
        children: MeasuredNode[];
    }

    const TARGET_OCCUPANCY = config.targetOccupancy;
    const FULL_CIRCLE = Math.PI * 2;
    const rawNodes: Array<{ x: number; y: number; data: T; depth: number }> = [];
    const rawLinks: Array<{
        source: { x: number; y: number; data: T };
        target: { x: number; y: number; data: T };
    }> = [];

    function getNodeDiameter(node: T): number {
        if (node.actionType === "ban") {
            return nodeWidth * 0.8;
        }

        if (node.championIds.length === 2) {
            return nodeWidth * 1.45;
        }

        return Math.max(nodeWidth, nodeHeight);
    }

    function chordToAngle(distance: number, radius: number): number {
        if (radius <= 0) {
            return FULL_CIRCLE;
        }

        const clamped = Math.min(distance / (2 * radius), 1);
        return 2 * Math.asin(clamped);
    }

    function getSelfSpan(node: T, radius: number): number {
        if (radius <= 0) {
            return 0;
        }

        const footprint = getNodeDiameter(node) + config.selfPadding;
        return chordToAngle(footprint, radius);
    }

    function getSiblingGap(depth: number): number {
        const radius = depth * ringSpacing;
        const minimumChord = Math.max(
            nodeWidth * config.siblingMinChordRatio,
            config.siblingMinChordFloor
        );
        return chordToAngle(minimumChord, radius);
    }

    function getRelativeOccupancy(level: number): number {
        if (level <= 0) {
            return 1;
        }

        const relaxation = level / (level + config.occupancyRelaxDivisor);
        return 1 - (1 - TARGET_OCCUPANCY) * relaxation;
    }

    function measure(
        node: T,
        depth: number,
        radialDepth: number,
        isSpine: boolean
    ): MeasuredNode {
        const nextSpine = isSpine && node.children.length === 1;
        const childRadialDepth =
            radialDepth + (nextSpine ? config.spineCompressionStep : 1);
        const children = node.children.map((child) =>
            measure(child as T, depth + 1, childRadialDepth, nextSpine)
        );
        const selfSpan = getSelfSpan(node, radialDepth * ringSpacing);

        if (children.length === 0) {
            const profile = [selfSpan];
            return {
                data: node,
                depth,
                radius: radialDepth * ringSpacing,
                radialDepth,
                isSpine,
                selfSpan,
                profile,
                minSpan: selfSpan,
                preferredSpan: selfSpan,
                children
            };
        }

        const maxChildProfileDepth = children.reduce(
            (maxDepth, child) => Math.max(maxDepth, child.profile.length),
            0
        );
        const profile = [selfSpan];

        for (let level = 1; level <= maxChildProfileDepth; level++) {
            const activeChildren = children.filter(
                (child) => child.profile[level - 1] !== undefined
            );
            if (activeChildren.length === 0) {
                continue;
            }

            const gap = getSiblingGap(depth + level);
            const demand =
                activeChildren.reduce(
                    (sum, child) => sum + (child.profile[level - 1] ?? 0),
                    0
                ) +
                gap * Math.max(activeChildren.length - 1, 0);
            profile.push(demand);
        }

        const minSpan = profile.reduce(
            (maxSpan, demand) => Math.max(maxSpan, demand),
            selfSpan
        );
        const childGap = getSiblingGap(depth + 1);
        const childrenPreferredSpan =
            children.reduce((sum, child) => sum + child.preferredSpan, 0) +
            childGap * Math.max(children.length - 1, 0);
        const preferredSpan = Math.min(
            FULL_CIRCLE,
            Math.max(
                minSpan,
                childrenPreferredSpan,
                profile.reduce((maxSpan, demand, level) => {
                    const occupancy = getRelativeOccupancy(level);
                    return Math.max(maxSpan, demand / occupancy);
                }, 0)
            )
        );

        return {
            data: node,
            depth,
            radius: radialDepth * ringSpacing,
            radialDepth,
            isSpine,
            selfSpan,
            profile,
            minSpan,
            preferredSpan,
            children
        };
    }

    function place(
        measured: MeasuredNode,
        centerAngle: number,
        availableSpan: number,
        keyPathSegments: string[]
    ): void {
        const selfKeyPath = nodeKeyPath(keyPathSegments);
        const override =
            selfKeyPath === "" ? undefined : getOverrideAngle?.(selfKeyPath);
        if (override !== undefined && measured.depth > 0) {
            centerAngle = override;
        }

        const radius = measured.radius;
        const x = radius * Math.cos(centerAngle - Math.PI / 2);
        const y = radius * Math.sin(centerAngle - Math.PI / 2);

        rawNodes.push({
            x,
            y,
            data: measured.data,
            depth: measured.depth
        });

        if (measured.children.length === 0) {
            return;
        }

        if (measured.children.length === 1) {
            const child = measured.children[0];
            const childSector = Math.min(
                availableSpan,
                Math.max(child.minSpan, child.preferredSpan)
            );
            const childKeyPath = nodeKeyPath([
                ...keyPathSegments,
                nodeKey(child.data)
            ]);
            const childOverride = getOverrideAngle?.(childKeyPath);
            const childAngle =
                childOverride !== undefined && child.depth > 0
                    ? childOverride
                    : centerAngle;
            const childRadius = child.radius;
            const childX = childRadius * Math.cos(childAngle - Math.PI / 2);
            const childY = childRadius * Math.sin(childAngle - Math.PI / 2);

            rawLinks.push({
                source: { x, y, data: measured.data },
                target: { x: childX, y: childY, data: child.data }
            });

            place(child, centerAngle, childSector, [
                ...keyPathSegments,
                nodeKey(child.data)
            ]);
            return;
        }

        const childGap = getSiblingGap(measured.depth + 1);
        const fixedGapSpan = childGap * Math.max(measured.children.length - 1, 0);
        const childrenMinSpan = measured.children.reduce(
            (sum, child) => sum + child.minSpan,
            0
        );
        const childrenPreferredSpan = measured.children.reduce(
            (sum, child) => sum + child.preferredSpan,
            0
        );
        const minimumSpan = childrenMinSpan + fixedGapSpan;
        const preferredSpan = childrenPreferredSpan + fixedGapSpan;
        const usedSpan = Math.min(
            availableSpan,
            Math.max(minimumSpan, Math.min(measured.preferredSpan, preferredSpan))
        );
        const distributableSpan = Math.max(usedSpan - fixedGapSpan, childrenMinSpan);
        const startAngle = centerAngle - usedSpan / 2;
        const extraSpan = Math.max(distributableSpan - childrenMinSpan, 0);
        const totalDeficit = measured.children.reduce(
            (sum, child) => sum + Math.max(child.preferredSpan - child.minSpan, 0),
            0
        );
        const totalMin = measured.children.reduce((sum, child) => sum + child.minSpan, 0);
        let cursor = startAngle;

        for (const child of measured.children) {
            const deficit = Math.max(child.preferredSpan - child.minSpan, 0);
            let bonus: number;
            if (config.bonusDistributionMode === "equal") {
                bonus = extraSpan / measured.children.length;
            } else if (config.bonusDistributionMode === "proportional-to-min") {
                bonus =
                    totalMin > 0
                        ? (extraSpan * child.minSpan) / totalMin
                        : extraSpan / measured.children.length;
            } else {
                bonus =
                    totalDeficit > 0
                        ? (extraSpan * deficit) / totalDeficit
                        : extraSpan / measured.children.length;
            }
            const childSector = Math.min(child.preferredSpan, child.minSpan + bonus);
            const childCenter = cursor + childSector / 2;
            const childKeyPath = nodeKeyPath([
                ...keyPathSegments,
                nodeKey(child.data)
            ]);
            const childOverride = getOverrideAngle?.(childKeyPath);
            const childAngle =
                childOverride !== undefined && child.depth > 0
                    ? childOverride
                    : childCenter;
            const childRadius = child.radius;
            const childX = childRadius * Math.cos(childAngle - Math.PI / 2);
            const childY = childRadius * Math.sin(childAngle - Math.PI / 2);

            rawLinks.push({
                source: { x, y, data: measured.data },
                target: { x: childX, y: childY, data: child.data }
            });

            place(child, childCenter, childSector, [
                ...keyPathSegments,
                nodeKey(child.data)
            ]);
            cursor += childSector + childGap;
        }
    }

    const measuredRoot = measure(treeData, 0, 0, true);
    place(measuredRoot, 0, FULL_CIRCLE, []);

    return normalizeLayout(rawNodes, rawLinks, padding, padding);
}

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
