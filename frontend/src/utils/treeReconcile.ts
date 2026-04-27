type NodeKeyTreeNode = {
    side: "blue" | "red" | null;
    actionType: "ban" | "pick";
    championIds: string[];
    children: NodeKeyTreeNode[];
};

/** Stable identity for a tree node — side:actionType:sortedChampionIds */
export function nodeKey(node: NodeKeyTreeNode): string {
    const champs = [...node.championIds].sort().join("|");
    return `${node.side ?? "none"}:${node.actionType}:${champs}`;
}

/** A node-key path is the sequence of nodeKey strings from root's child down to some node. */
export type NodeKeyPath = string;

export function nodeKeyPath(keys: string[]): NodeKeyPath {
    return keys.join(">");
}

/**
 * Walk the tree and return the set of every reachable node-key path.
 * Used to filter stale manualExpansions / manualCollapses entries.
 */
export function collectNodeKeyPaths(root: NodeKeyTreeNode): Set<NodeKeyPath> {
    const result = new Set<NodeKeyPath>();
    function walk(node: NodeKeyTreeNode, keys: string[]): void {
        for (const child of node.children) {
            const nextKeys = [...keys, nodeKey(child)];
            result.add(nodeKeyPath(nextKeys));
            walk(child, nextKeys);
        }
    }
    walk(root, []);
    return result;
}

/**
 * Given an index path into `root` (e.g. [0, 1, 2]), return the node-key path.
 * Returns null if any index is out of bounds.
 */
export function pathIndicesToNodeKeyPath(
    root: NodeKeyTreeNode,
    indexPath: number[]
): NodeKeyPath | null {
    const keys: string[] = [];
    let node = root;
    for (const index of indexPath) {
        const child = node.children[index];
        if (!child) return null;
        keys.push(nodeKey(child));
        node = child;
    }
    return nodeKeyPath(keys);
}

/**
 * Given a content-addressed path of `(slot, championIds)` steps, walk the
 * tree by matching each step against the children of the current node. Match
 * uses sorted-set equality on `championIds` so pair-pick entries are
 * order-independent (mirrors `nodeKey`'s sort). `slot` is informational only —
 * championIds uniquely identifies the child within a single decision layer.
 *
 * Used to translate `Scenario.treePath` (content-addressed, the new engine
 * wire shape) into an index path the synthetic-tree consumers can use.
 */
export function pathStepsToIndexPath(
    root: NodeKeyTreeNode,
    steps: ReadonlyArray<{ slot: number; championIds: string[] }>
): number[] | null {
    const result: number[] = [];
    let node = root;
    for (const step of steps) {
        const stepKey = [...step.championIds].sort().join("|");
        const index = node.children.findIndex(
            (child) => [...child.championIds].sort().join("|") === stepKey
        );
        if (index === -1) return null;
        result.push(index);
        node = node.children[index];
    }
    return result;
}

/**
 * Given a content-addressed path of `(slot, championIds)` steps, return the
 * matching node-key path (or null if any step doesn't match). Convenience
 * wrapper around pathStepsToIndexPath + pathIndicesToNodeKeyPath that avoids
 * walking the tree twice.
 */
export function pathStepsToNodeKeyPath(
    root: NodeKeyTreeNode,
    steps: ReadonlyArray<{ slot: number; championIds: string[] }>
): NodeKeyPath | null {
    const keys: string[] = [];
    let node = root;
    for (const step of steps) {
        const stepKey = [...step.championIds].sort().join("|");
        const child = node.children.find(
            (c) => [...c.championIds].sort().join("|") === stepKey
        );
        if (!child) return null;
        keys.push(nodeKey(child));
        node = child;
    }
    return nodeKeyPath(keys);
}

/**
 * Given a node-key path and a `root`, return the index path (one index per
 * child step) that identifies the same node in `root`, or null if absent.
 */
export function nodeKeyPathToIndices(
    root: NodeKeyTreeNode,
    keyPath: NodeKeyPath
): number[] | null {
    if (keyPath === "") return [];
    const keys = keyPath.split(">");
    const result: number[] = [];
    let node = root;
    for (const key of keys) {
        const index = node.children.findIndex((child) => nodeKey(child) === key);
        if (index === -1) return null;
        result.push(index);
        node = node.children[index];
    }
    return result;
}

export interface ReconcilePriority {
    /** Node-key path of the selected scenario (or null). */
    selectedScenarioKeyPath: NodeKeyPath | null;
    /** Node-key paths the user has manually expanded. */
    manualExpansionKeyPaths: ReadonlySet<NodeKeyPath>;
}

export interface PickDescriptor {
    side: "blue" | "red";
    actionType: "ban" | "pick";
    championIds: string[]; // 1 for singleton turns, 2 for pair turns
}

export {
    synthesizeFullTree,
    extendSpineOptimistic,
    mergeEngineTree,
    includeConfirmedDraftStateForScenarios,
    remapScenarioPath as remapScenarioSpinePath,
    remapScenarios as remapScenariosSpine,
    eventsToConfirmedTurns,
    pruneInvalid as pruneInvalidProjection,
    spineNodeCount
} from "./treeSynthesis";

export type { ConfirmedTurn } from "./treeSynthesis";
