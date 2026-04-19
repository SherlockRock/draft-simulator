import type {
    NavigatorEventData,
    NavigatorScenario,
    NavigatorTreeNode
} from "../contexts/NavigatorContext";
import type { DraftStateSummary } from "./draftEventsToState";
import { isChampionAvailable } from "./draftEventsToState";
import { nodeKey } from "./treeReconcile";
import type { ReconcilePriority } from "./treeReconcile";

export const SYNTHETIC_ROOT_CHAMPIONS: string[] = [];

/** A single confirmed turn's worth of event(s). One entry = one spine node. */
export interface ConfirmedTurn {
    side: "blue" | "red";
    actionType: "ban" | "pick";
    phase: "ban1" | "pick1" | "ban2" | "pick2";
    championIds: string[];
    slots: number[];
    userInjected: boolean;
}

export function eventsToConfirmedTurns(
    events: NavigatorEventData[]
): ConfirmedTurn[] {
    const actionable = events.filter(isConfirmedActionEvent);
    const ordered = [...actionable].sort((a, b) => {
        const aTime = new Date(a.createdAt).getTime();
        const bTime = new Date(b.createdAt).getTime();
        if (aTime !== bTime) return aTime - bTime;
        return a.slot - b.slot;
    });

    const turns: ConfirmedTurn[] = [];
    let i = 0;
    while (i < ordered.length) {
        const first = ordered[i];
        const second = ordered[i + 1];
        const isPair =
            second !== undefined &&
            second.event_type === first.event_type &&
            second.side === first.side &&
            new Date(second.createdAt).getTime() ===
                new Date(first.createdAt).getTime();

        const picks = isPair ? [first, second] : [first];
        turns.push({
            side: first.side,
            actionType: first.event_type,
            phase: inferPhase(turns.length, first.event_type, picks.length),
            championIds: picks.map((event) => event.champion_id),
            slots: picks.map((event) => event.slot),
            userInjected: picks.some((event) => event.user_injected)
        });
        i += picks.length;
    }
    return turns;
}

function isConfirmedActionEvent(
    event: NavigatorEventData
): event is NavigatorEventData & { event_type: "ban" | "pick" } {
    return event.event_type === "ban" || event.event_type === "pick";
}

function inferPhase(
    turnIndexBeforeAdding: number,
    actionType: "ban" | "pick",
    pickSize: number
): "ban1" | "pick1" | "ban2" | "pick2" {
    void actionType;
    void pickSize;
    const turnIndex = turnIndexBeforeAdding;
    if (turnIndex < 6) return "ban1";
    if (turnIndex < 11) return "pick1";
    if (turnIndex < 15) return "ban2";
    return "pick2";
}

/**
 * Assemble the synthetic full-draft tree.
 *
 * @param engineTree      Engine's tree rooted at the post-last-confirmed-pick
 *                        state. Its root has empty championIds; its children
 *                        become the current-decision fanout. Pass `null` if
 *                        the engine hasn't returned yet — the tree terminates
 *                        at the spine tail.
 * @param confirmedTurns  All confirmed events collapsed into one entry per
 *                        turn (see `eventsToConfirmedTurns`).
 */
export function synthesizeFullTree(
    engineTree: NavigatorTreeNode | null,
    confirmedTurns: ConfirmedTurn[]
): NavigatorTreeNode {
    const tail = engineTree ?? emptyNodeChildren();

    let current: NavigatorTreeNode = {
        championIds: [...tail.championIds],
        actionType: tail.actionType,
        phase: tail.phase,
        scores: tail.scores,
        assignmentDistribution: tail.assignmentDistribution,
        side: tail.side,
        slots: [...tail.slots],
        userInjected: tail.userInjected,
        children: tail.children
    };

    for (let i = confirmedTurns.length - 1; i >= 0; i--) {
        const turn = confirmedTurns[i];
        const spineNode = turnToSpineNode(turn, current);
        current = spineNode;
    }

    return {
        championIds: SYNTHETIC_ROOT_CHAMPIONS,
        actionType: "ban",
        phase: "ban1",
        scores: current.scores,
        assignmentDistribution: [],
        side: null,
        slots: [],
        userInjected: false,
        children: [current]
    };
}

function turnToSpineNode(
    turn: ConfirmedTurn,
    child: NavigatorTreeNode
): NavigatorTreeNode {
    return {
        championIds: [...turn.championIds],
        actionType: turn.actionType,
        phase: turn.phase,
        scores: child.scores,
        assignmentDistribution: [],
        side: turn.side,
        slots: [...turn.slots],
        userInjected: turn.userInjected,
        children: [child]
    };
}

function emptyNodeChildren(): NavigatorTreeNode {
    return {
        championIds: SYNTHETIC_ROOT_CHAMPIONS,
        actionType: "ban",
        phase: "ban1",
        scores: {
            composite: 0,
            compStrength: 0,
            informationValue: 0,
            flexRetention: 0,
            revealCost: 0
        },
        assignmentDistribution: [],
        side: null,
        slots: [],
        userInjected: false,
        children: []
    };
}

/**
 * Translate an engine-tree scenario path into the synthetic-tree index path.
 *
 * The synthetic tree prepends N spine indices (all zero) where N is the number
 * of confirmed turns. Each spine node has exactly one child, so each spine
 * step is always `0`. The engine's `treePath` indexes *from the engine root*;
 * the engine root in the synthetic tree is the node at
 * `[0, 0, ..., 0]` (N zeros).
 */
export function remapScenarioPath(
    scenario: NavigatorScenario,
    spineLength: number
): NavigatorScenario {
    const spinePrefix = Array.from({ length: spineLength + 1 }, () => 0);
    return {
        ...scenario,
        treePath: [...spinePrefix, ...scenario.treePath]
    };
}

export function remapScenarios(
    scenarios: NavigatorScenario[],
    spineLength: number
): NavigatorScenario[] {
    return scenarios.map((scenario) => remapScenarioPath(scenario, spineLength));
}

/**
 * Extend the previous synthetic tree by one confirmed pick — no engine input.
 * Used when events arrive before a fresh snapshot.
 *
 * Finds the child of the current spine-tail whose nodeKey matches the pick;
 * that branch survives, its siblings are dropped, and its children become the
 * new projection fanout under a fresh spine node.
 *
 * If no child matches (surprise pick), the spine tail is extended with no
 * children.
 */
export function extendSpineOptimistic(
    prevSynthetic: NavigatorTreeNode,
    newTurn: ConfirmedTurn,
    prevSpineLength: number
): NavigatorTreeNode {
    const tailParent = walkSpine(prevSynthetic, prevSpineLength);
    const tail = tailParent.children[0];
    if (!tail) {
        return prevSynthetic;
    }

    const matchingChild = tail.children.find(
        (child) => nodeKey(child) === nodeKeyForTurn(newTurn)
    );

    const newSpineNode = turnToSpineNode(newTurn, {
        championIds: SYNTHETIC_ROOT_CHAMPIONS,
        actionType: tail.actionType,
        phase: tail.phase,
        scores: tail.scores,
        assignmentDistribution: [],
        side: null,
        slots: [],
        userInjected: false,
        children: matchingChild ? matchingChild.children : []
    });

    return replaceSpineTail(prevSynthetic, prevSpineLength, newSpineNode);
}

function nodeKeyForTurn(turn: ConfirmedTurn): string {
    const champs = [...turn.championIds].sort().join("|");
    return `${turn.side}:${turn.actionType}:${champs}`;
}

function walkSpine(
    root: NavigatorTreeNode,
    spineLength: number
): NavigatorTreeNode {
    let node = root;
    for (let i = 0; i < spineLength; i++) {
        const next = node.children[0];
        if (!next) return node;
        node = next;
    }
    return node;
}

function replaceSpineTail(
    root: NavigatorTreeNode,
    prevSpineLength: number,
    newTailChild: NavigatorTreeNode
): NavigatorTreeNode {
    function rebuild(node: NavigatorTreeNode, depth: number): NavigatorTreeNode {
        if (depth === prevSpineLength) {
            const currentTail = node.children[0];
            if (!currentTail) return node;
            const newTailWithChild: NavigatorTreeNode = {
                ...currentTail,
                children: [newTailChild]
            };
            return { ...node, children: [newTailWithChild] };
        }
        const child = node.children[0];
        if (!child) return node;
        return { ...node, children: [rebuild(child, depth + 1)] };
    }
    return rebuild(root, 0);
}

/**
 * Replace the spine tail of the prior synthetic tree with a fresh engine
 * tree, merging the engine's children into whatever projection children the
 * spine-tail has preserved from an earlier Phase-1 extension.
 */
export function mergeEngineTree(
    prevSynthetic: NavigatorTreeNode,
    engineTree: NavigatorTreeNode,
    spineLength: number,
    state: DraftStateSummary,
    priority: ReconcilePriority,
    branchWidth = 5
): NavigatorTreeNode {
    void state;
    const prevTail = walkSpine(prevSynthetic, spineLength + 1);
    const engineRoot = engineTree;

    const mergedTail: NavigatorTreeNode = {
        ...engineRoot,
        championIds: [...prevTail.championIds],
        side: prevTail.side,
        slots: [...prevTail.slots],
        userInjected: prevTail.userInjected,
        phase: prevTail.phase,
        actionType: prevTail.actionType,
        children: mergeChildren(
            prevTail.children,
            engineRoot.children,
            priority,
            branchWidth,
            []
        )
    };

    return replaceSpineTailNode(prevSynthetic, spineLength, mergedTail);
}

function mergeChildren(
    preserved: NavigatorTreeNode[],
    fresh: NavigatorTreeNode[],
    priority: ReconcilePriority,
    branchWidth: number,
    keyPath: string[]
): NavigatorTreeNode[] {
    const preservedByKey = new Map<string, NavigatorTreeNode>();
    for (const child of preserved) preservedByKey.set(nodeKey(child), child);

    const result: NavigatorTreeNode[] = [];
    const visited = new Set<string>();

    for (const freshChild of fresh) {
        const key = nodeKey(freshChild);
        visited.add(key);
        const preservedChild = preservedByKey.get(key);
        if (preservedChild) {
            result.push({
                ...freshChild,
                children: mergeChildren(
                    preservedChild.children,
                    freshChild.children,
                    priority,
                    branchWidth,
                    [...keyPath, key]
                )
            });
        } else {
            result.push(freshChild);
        }
    }

    for (const [key, preservedChild] of preservedByKey) {
        if (visited.has(key)) continue;
        result.push(preservedChild);
    }

    return trimChildrenByPriority(result, keyPath, priority, branchWidth);
}

function trimChildrenByPriority(
    children: NavigatorTreeNode[],
    keyPath: string[],
    priority: ReconcilePriority,
    branchWidth: number
): NavigatorTreeNode[] {
    if (children.length <= branchWidth) return children;
    const selectedSegments = priority.selectedScenarioKeyPath
        ? priority.selectedScenarioKeyPath.split(">")
        : [];
    const selectedAtDepth = selectedSegments[keyPath.length] ?? null;

    type Ranked = { child: NavigatorTreeNode; rank: number; score: number };
    const ranked: Ranked[] = children.map((child) => {
        const key = nodeKey(child);
        const thisPath = [...keyPath, key].join(">");
        let rank = 3;
        if (selectedAtDepth === key) rank = 0;
        else if (priority.manualExpansionKeyPaths.has(thisPath)) rank = 1;
        return { child, rank, score: child.scores.composite };
    });
    ranked.sort((a, b) =>
        a.rank !== b.rank ? a.rank - b.rank : b.score - a.score
    );
    return ranked.slice(0, branchWidth).map((entry) => entry.child);
}

function replaceSpineTailNode(
    root: NavigatorTreeNode,
    spineLength: number,
    newTailNode: NavigatorTreeNode
): NavigatorTreeNode {
    function rebuild(node: NavigatorTreeNode, depth: number): NavigatorTreeNode {
        if (depth === spineLength + 1) return newTailNode;
        const child = node.children[0];
        if (!child) return node;
        return { ...node, children: [rebuild(child, depth + 1)] };
    }
    return rebuild(root, 0);
}

/**
 * Walk the subtree below the spine tail and drop any node whose championIds
 * intersect the used pool (ban/pick by either side). Spine nodes themselves
 * are never pruned — they *are* the used pool.
 */
export function pruneInvalid(
    root: NavigatorTreeNode,
    state: DraftStateSummary,
    spineLength: number
): NavigatorTreeNode {
    function pruneSubtree(node: NavigatorTreeNode): NavigatorTreeNode | null {
        for (const id of node.championIds) {
            if (!isChampionAvailable(id, state)) return null;
        }
        const kept: NavigatorTreeNode[] = [];
        for (const child of node.children) {
            const next = pruneSubtree(child);
            if (next) kept.push(next);
        }
        return { ...node, children: kept };
    }

    function rebuild(node: NavigatorTreeNode, depth: number): NavigatorTreeNode {
        if (depth > spineLength) {
            const pruned = pruneSubtree(node);
            return pruned ?? { ...node, children: [] };
        }
        const child = node.children[0];
        if (!child) return node;
        return { ...node, children: [rebuild(child, depth + 1)] };
    }

    return rebuild(root, 0);
}
