export interface LayoutNode {
    championId: string | null;
    side: "blue" | "red" | null;
    slot: number | null;
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

interface PositionedTreeNode<T extends LayoutNode> {
    x: number;
    y: number;
    depth: number;
    data: T;
    children: PositionedTreeNode<T>[];
}

function layoutTree<T extends LayoutNode>(
    node: T,
    depth: number,
    nextLeafY: { value: number },
    horizontalGap: number,
    verticalGap: number
): PositionedTreeNode<T> {
    const children = node.children.map((child) =>
        layoutTree(child, depth + 1, nextLeafY, horizontalGap, verticalGap)
    );

    let y = nextLeafY.value;
    if (children.length === 0) {
        nextLeafY.value += verticalGap;
    } else {
        const firstChild = children[0];
        const lastChild = children[children.length - 1];
        y = (firstChild.y + lastChild.y) / 2;
    }

    return {
        x: depth * horizontalGap,
        y,
        depth,
        data: node,
        children
    };
}

function collectNodes<T extends LayoutNode>(
    node: PositionedTreeNode<T>,
    nodes: Array<{ x: number; y: number; data: T; depth: number }>,
    links: LayoutLink<T>[]
) {
    nodes.push({
        x: node.x,
        y: node.y,
        data: node.data,
        depth: node.depth
    });

    for (const child of node.children) {
        links.push({
            source: { x: node.x, y: node.y, data: node.data },
            target: { x: child.x, y: child.y, data: child.data }
        });
        collectNodes(child, nodes, links);
    }
}

export function computeTreeLayout<T extends LayoutNode>(
    treeData: T,
    nodeWidth: number,
    nodeHeight: number
): {
    nodes: Array<{ x: number; y: number; data: T; depth: number }>;
    links: LayoutLink<T>[];
    width: number;
    height: number;
} {
    const verticalGap = nodeHeight + 28;
    const horizontalGap = nodeWidth + 92;
    const nextLeafY = { value: 0 };
    const laidOutRoot = layoutTree(
        treeData,
        0,
        nextLeafY,
        horizontalGap,
        verticalGap
    );

    const rawNodes: Array<{ x: number; y: number; data: T; depth: number }> = [];
    const rawLinks: LayoutLink<T>[] = [];
    collectNodes(laidOutRoot, rawNodes, rawLinks);

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

    const horizontalPadding = nodeWidth * 1.5;
    const verticalPadding = nodeHeight * 1.5;

    const nodes = rawNodes.map((node) => ({
        x: node.x - minX + horizontalPadding,
        y: node.y - minY + verticalPadding,
        data: node.data,
        depth: node.depth
    }));

    const links = rawLinks.map((link) => ({
        source: {
            x: link.source.x - minX + horizontalPadding,
            y: link.source.y - minY + verticalPadding,
            data: link.source.data
        },
        target: {
            x: link.target.x - minX + horizontalPadding,
            y: link.target.y - minY + verticalPadding,
            data: link.target.data
        }
    }));

    return {
        nodes,
        links,
        width: maxX - minX + horizontalPadding * 2,
        height: maxY - minY + verticalPadding * 2
    };
}
