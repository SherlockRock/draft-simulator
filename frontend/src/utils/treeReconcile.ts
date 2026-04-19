import type {
    NavigatorScenario,
    NavigatorTreeNode
} from "../contexts/NavigatorContext";
import type { DraftStateSummary } from "./draftEventsToState";
import { isChampionAvailable } from "./draftEventsToState";

/** Stable identity for a tree node — side:actionType:sortedChampionIds */
export function nodeKey(node: NavigatorTreeNode): string {
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
export function collectNodeKeyPaths(root: NavigatorTreeNode): Set<NodeKeyPath> {
    const result = new Set<NodeKeyPath>();
    function walk(node: NavigatorTreeNode, keys: string[]): void {
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
    root: NavigatorTreeNode,
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
 * Given a node-key path and a `root`, return the index path (one index per
 * child step) that identifies the same node in `root`, or null if absent.
 */
export function nodeKeyPathToIndices(
    root: NavigatorTreeNode,
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

const DEFAULT_PRIORITY: ReconcilePriority = {
    selectedScenarioKeyPath: null,
    manualExpansionKeyPaths: new Set()
};

/**
 * Merge the old tree's still-valid subtree with the engine's fresh tree.
 *
 * @param oldTree         Previous snapshot's tree. Null on first update.
 * @param newTree         Engine's fresh tree for the post-pick state.
 * @param pick            The confirmed move that advanced the draft.
 * @param newState        Accumulated draft state after the pick.
 * @param priority        Engagement signals used to break branch-width ties.
 * @param branchWidth     Maximum children per node in the merged tree.
 */
export function reconcileTree(
    oldTree: NavigatorTreeNode | null,
    newTree: NavigatorTreeNode,
    pick: PickDescriptor,
    newState: DraftStateSummary,
    priority: ReconcilePriority = DEFAULT_PRIORITY,
    branchWidth = 5
): NavigatorTreeNode {
    if (!oldTree) return newTree;

    const matchingChild = oldTree.children.find(
        (child) =>
            child.side === pick.side &&
            child.actionType === pick.actionType &&
            sameChampionSet(child.championIds, pick.championIds)
    );

    if (!matchingChild) return newTree;

    const pruned = pruneInvalid(matchingChild, newState);
    if (!pruned) return newTree;

    return mergeTrees(pruned, newTree, newState, priority, branchWidth, []);
}

function sameChampionSet(a: string[], b: string[]): boolean {
    if (a.length !== b.length) return false;
    const as = [...a].sort();
    const bs = [...b].sort();
    for (let i = 0; i < as.length; i++) {
        if (as[i] !== bs[i]) return false;
    }
    return true;
}

/**
 * Recursively drop any node whose championIds reference an already-taken
 * champion. Returns null if the node itself is invalid.
 */
function pruneInvalid(
    node: NavigatorTreeNode,
    state: DraftStateSummary
): NavigatorTreeNode | null {
    for (const id of node.championIds) {
        if (!isChampionAvailable(id, state)) return null;
    }
    const validChildren: NavigatorTreeNode[] = [];
    for (const child of node.children) {
        const kept = pruneInvalid(child, state);
        if (kept) validChildren.push(kept);
    }
    return { ...node, children: validChildren };
}

function mergeTrees(
    preserved: NavigatorTreeNode,
    fresh: NavigatorTreeNode,
    state: DraftStateSummary,
    priority: ReconcilePriority,
    branchWidth: number,
    keyPath: string[]
): NavigatorTreeNode {
    // preserved and fresh represent the same state. Use preserved's children
    // as the "history" layer and fresh's as the "engine" layer.
    const preservedByKey = new Map<string, NavigatorTreeNode>();
    for (const child of preserved.children) {
        preservedByKey.set(nodeKey(child), child);
    }

    const mergedChildren: NavigatorTreeNode[] = [];
    const visitedKeys = new Set<string>();

    for (const freshChild of fresh.children) {
        const key = nodeKey(freshChild);
        visitedKeys.add(key);
        const preservedChild = preservedByKey.get(key);
        if (preservedChild) {
            // Both trees have this child. Recurse with history pair.
            mergedChildren.push(
                mergeTrees(preservedChild, freshChild, state, priority, branchWidth, [
                    ...keyPath,
                    key
                ])
            );
        } else {
            // Only engine has it — graft it in (already pruned by construction;
            // engine produced it for the current state).
            mergedChildren.push(freshChild);
        }
    }

    for (const [key, preservedChild] of preservedByKey) {
        if (visitedKeys.has(key)) continue;
        // Preserved-only — carry it forward. Already pruned.
        mergedChildren.push(preservedChild);
    }

    const trimmed = trimChildren(mergedChildren, keyPath, priority, branchWidth);

    return { ...fresh, children: trimmed };
}

function trimChildren(
    children: NavigatorTreeNode[],
    keyPath: string[],
    priority: ReconcilePriority,
    branchWidth: number
): NavigatorTreeNode[] {
    if (children.length <= branchWidth) return children;

    const selectedSegments = priority.selectedScenarioKeyPath
        ? priority.selectedScenarioKeyPath.split(">")
        : [];
    const selectedAtThisDepth = selectedSegments[keyPath.length] ?? null;

    type Scored = { child: NavigatorTreeNode; rank: number; score: number };
    const scored: Scored[] = children.map((child) => {
        const key = nodeKey(child);
        const thisKeyPath = nodeKeyPath([...keyPath, key]);
        let rank = 3; // lower rank = keep first
        if (selectedAtThisDepth === key) rank = 0;
        else if (priority.manualExpansionKeyPaths.has(thisKeyPath)) rank = 1;
        return { child, rank, score: child.scores.composite };
    });

    scored.sort((a, b) => {
        if (a.rank !== b.rank) return a.rank - b.rank;
        return b.score - a.score;
    });

    return scored.slice(0, branchWidth).map((entry) => entry.child);
}

/**
 * Translate a scenario from the fresh engine tree to the merged tree.
 *
 * Strategy: compute the node-key path of the scenario's treePath in `freshTree`,
 * then resolve that node-key path against `mergedTree`. If the path doesn't
 * exist in the merged tree (e.g., trimmed by branch-width cap), returns null.
 */
export function remapScenarioPath(
    scenario: NavigatorScenario,
    freshTree: NavigatorTreeNode,
    mergedTree: NavigatorTreeNode
): NavigatorScenario | null {
    const keyPath = pathIndicesToNodeKeyPath(freshTree, scenario.treePath);
    if (keyPath === null) return null;
    const newIndices = nodeKeyPathToIndices(mergedTree, keyPath);
    if (newIndices === null) return null;
    return { ...scenario, treePath: newIndices };
}

export function remapScenarios(
    scenarios: NavigatorScenario[],
    freshTree: NavigatorTreeNode,
    mergedTree: NavigatorTreeNode
): NavigatorScenario[] {
    const remapped: NavigatorScenario[] = [];
    for (const scenario of scenarios) {
        const next = remapScenarioPath(scenario, freshTree, mergedTree);
        if (next) remapped.push(next);
    }
    return remapped;
}

export {
    synthesizeFullTree,
    extendSpineOptimistic,
    mergeEngineTree,
    remapScenarioPath as remapScenarioSpinePath,
    remapScenarios as remapScenariosSpine,
    eventsToConfirmedTurns,
    pruneInvalid as pruneInvalidProjection
} from "./treeSynthesis";

export type { ConfirmedTurn } from "./treeSynthesis";
