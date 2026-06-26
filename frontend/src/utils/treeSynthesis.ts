import type {
    NavigatorEventData,
    NavigatorScenario,
    NavigatorScenarioPathStep,
    NavigatorTreeNode
} from "../contexts/NavigatorContext";
import type { DraftStateSummary } from "./draftEventsToState";
import { isChampionAvailable } from "./draftEventsToState";
import { nodeKey } from "./treeReconcile";
import type { ReconcilePriority } from "./treeReconcile";
import { TURN_SEQUENCE, phaseForSlot } from "./turnSequence";

export const SYNTHETIC_ROOT_CHAMPIONS: string[] = [];

/** A single confirmed turn's worth of event(s). One entry = one spine node,
 *  except for `pair-pending` which does not advance the spine. */
export interface ConfirmedTurn {
    side: "blue" | "red";
    actionType: "ban" | "pick";
    phase: "ban1" | "pick1" | "ban2" | "pick2";
    championIds: string[];
    slots: number[];
    userInjected: boolean;
    pairState: "solo" | "pair-complete" | "pair-pending";
}

export function eventsToConfirmedTurns(events: NavigatorEventData[]): ConfirmedTurn[] {
    const actionable = events.filter(isConfirmedActionEvent);
    const ordered = [...actionable].sort((a, b) => {
        if (a.slot !== b.slot) return a.slot - b.slot;
        const aTime = new Date(a.createdAt).getTime();
        const bTime = new Date(b.createdAt).getTime();
        if (aTime !== bTime) return aTime - bTime;
        return a.id.localeCompare(b.id);
    });

    const turns: ConfirmedTurn[] = [];
    let i = 0;
    while (i < ordered.length) {
        const first = ordered[i];
        const turnInfo = TURN_SEQUENCE[first.slot];
        if (!turnInfo) {
            // Unknown slot — skip defensively.
            i += 1;
            continue;
        }

        if (first.event_type === "pick" && turnInfo.pairStart) {
            const second = ordered[i + 1];
            const isCompletePair =
                second !== undefined &&
                second.event_type === "pick" &&
                second.side === first.side &&
                second.slot === first.slot + 1 &&
                TURN_SEQUENCE[second.slot]?.pairEnd === true;

            if (isCompletePair) {
                turns.push({
                    side: first.side,
                    actionType: "pick",
                    phase: phaseForSlot(first.slot),
                    championIds: [first.champion_id, second.champion_id],
                    slots: [first.slot, second.slot],
                    userInjected: first.user_injected || second.user_injected,
                    pairState: "pair-complete"
                });
                i += 2;
            } else {
                turns.push({
                    side: first.side,
                    actionType: "pick",
                    phase: phaseForSlot(first.slot),
                    championIds: [first.champion_id],
                    slots: [first.slot],
                    userInjected: first.user_injected,
                    pairState: "pair-pending"
                });
                i += 1;
            }
            continue;
        }

        turns.push({
            side: first.side,
            actionType: first.event_type,
            phase: phaseForSlot(first.slot),
            championIds: [first.champion_id],
            slots: [first.slot],
            userInjected: first.user_injected,
            pairState: "solo"
        });
        i += 1;
    }

    return turns;
}

/** Count of synthetic-tree spine nodes implied by a list of confirmed turns.
 *  Pair-pending turns do NOT add a spine node (the spine stays at the pre-pair
 *  node while the half-entered pair is filtered into the fanout). */
export function spineNodeCount(turns: ConfirmedTurn[]): number {
    const last = turns[turns.length - 1];
    if (last?.pairState === "pair-pending") return turns.length - 1;
    return turns.length;
}

function isConfirmedActionEvent(
    event: NavigatorEventData
): event is NavigatorEventData & { event_type: "ban" | "pick" } {
    return event.event_type === "ban" || event.event_type === "pick";
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

    let current: NavigatorTreeNode;
    if (confirmedTurns.length === 0) {
        // No confirmed picks yet — the engine root sits directly under the
        // overall root as the placeholder anchor for the projected fanout.
        current = {
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
    } else {
        // Fold the engine root into the latest confirmed turn so the projected
        // fanout hangs directly off the most recent pick (no empty intermediary).
        const latestTurn = confirmedTurns[confirmedTurns.length - 1];
        current = {
            championIds: [...latestTurn.championIds],
            actionType: latestTurn.actionType,
            phase: latestTurn.phase,
            scores: tail.scores,
            assignmentDistribution: [],
            side: latestTurn.side,
            slots: [...latestTurn.slots],
            userInjected: latestTurn.userInjected,
            children: tail.children
        };

        for (let i = confirmedTurns.length - 2; i >= 0; i--) {
            current = turnToSpineNode(confirmedTurns[i], current);
        }
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
 * Translate an engine-relative scenario path into a synthetic-tree-relative
 * content-addressed path.
 *
 * The synthetic tree wraps the engine tree with one spine node per confirmed
 * turn (excluding pair-pending — see `spineNodeCount`), plus one synthetic
 * root above. The engine's `treePath` is content-addressed and starts from the
 * fanout-parent's children. The full synthetic-relative path is
 * `[...spinePrefix, ...scenario.treePath]` where each prefix step matches one
 * spine node by `(slot, championIds)`. When no turns are confirmed the prefix
 * is a single step matching the engine-root placeholder (championIds: []).
 */
export function remapScenarioPath(
    scenario: NavigatorScenario,
    confirmedTurns: ConfirmedTurn[]
): NavigatorScenario {
    const spineLength = spineNodeCount(confirmedTurns);
    const spinePrefix: NavigatorScenarioPathStep[] =
        spineLength === 0
            ? [{ slot: 0, championIds: [] }]
            : confirmedTurns.slice(0, spineLength).map((turn) => ({
                  slot: turn.slots[0],
                  championIds: [...turn.championIds]
              }));
    return {
        ...scenario,
        treePath: [...spinePrefix, ...scenario.treePath]
    };
}

export function remapScenarios(
    scenarios: NavigatorScenario[],
    confirmedTurns: ConfirmedTurn[]
): NavigatorScenario[] {
    return scenarios.map((scenario) => remapScenarioPath(scenario, confirmedTurns));
}

function prependConfirmedValues(projected: string[], confirmed: string[]): string[] {
    const seen = new Set<string>();
    const combined: string[] = [];

    for (const championId of [...confirmed, ...projected]) {
        if (seen.has(championId)) continue;
        seen.add(championId);
        combined.push(championId);
    }

    return combined;
}

export function includeConfirmedDraftState(
    scenario: NavigatorScenario,
    state: DraftStateSummary
): NavigatorScenario {
    return {
        ...scenario,
        bluePicks: prependConfirmedValues(scenario.bluePicks, state.bluePicks),
        redPicks: prependConfirmedValues(scenario.redPicks, state.redPicks),
        blueBans: prependConfirmedValues(scenario.blueBans, state.blueBans),
        redBans: prependConfirmedValues(scenario.redBans, state.redBans)
    };
}

export function includeConfirmedDraftStateForScenarios(
    scenarios: NavigatorScenario[],
    state: DraftStateSummary
): NavigatorScenario[] {
    return scenarios.map((scenario) => includeConfirmedDraftState(scenario, state));
}

/**
 * Extend the previous synthetic tree by one confirmed turn — no engine input.
 * Used when events arrive before a fresh snapshot.
 *
 * Behaviour by `newTurn.pairState`:
 *
 * - `solo` or `pair-complete`: finds the child of the current spine tail whose
 *   nodeKey matches the turn; that branch survives, its siblings are dropped,
 *   and its children become the new projection fanout under a fresh spine node.
 *   If no child matches (surprise pick), the spine tail is extended with no
 *   children.
 *
 * - `pair-pending`: does NOT advance the spine. Instead, filters the fanout
 *   parent's children to pair candidates containing the entered champion and
 *   tags each survivor with `confirmedChampionIds: [enteredChamp]` so the
 *   renderer can show the confirmed half differently from the projected half.
 */
export function extendSpineOptimistic(
    prevSynthetic: NavigatorTreeNode,
    newTurn: ConfirmedTurn,
    prevSpineLength: number
): NavigatorTreeNode {
    const fanoutParent = walkSpine(prevSynthetic, Math.max(prevSpineLength, 1));

    if (newTurn.pairState === "pair-pending") {
        const enteredChamp = newTurn.championIds[0];
        const filteredChildren = fanoutParent.children
            .filter(
                (child) =>
                    child.championIds.length === 2 &&
                    child.championIds.includes(enteredChamp)
            )
            .map((child) => ({
                ...child,
                confirmedChampionIds: [enteredChamp]
            }));

        const updatedParent: NavigatorTreeNode = {
            ...fanoutParent,
            children: filteredChildren
        };

        return replaceNodeAtDepth(
            prevSynthetic,
            Math.max(prevSpineLength, 1),
            updatedParent
        );
    }

    const matchingChild = fanoutParent.children.find(
        (child) => nodeKey(child) === nodeKeyForTurn(newTurn)
    );

    const newTurnNode: NavigatorTreeNode = {
        championIds: [...newTurn.championIds],
        actionType: newTurn.actionType,
        phase: newTurn.phase,
        scores: matchingChild?.scores ?? fanoutParent.scores,
        assignmentDistribution: [],
        side: newTurn.side,
        slots: [...newTurn.slots],
        userInjected: newTurn.userInjected,
        children: matchingChild ? matchingChild.children : []
    };

    return replaceSpineTail(prevSynthetic, prevSpineLength, newTurnNode);
}

function nodeKeyForTurn(turn: ConfirmedTurn): string {
    const champs = [...turn.championIds].sort().join("|");
    return `${turn.side}:${turn.actionType}:${champs}`;
}

function walkSpine(root: NavigatorTreeNode, spineLength: number): NavigatorTreeNode {
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
    newTailNode: NavigatorTreeNode
): NavigatorTreeNode {
    function rebuild(node: NavigatorTreeNode, depth: number): NavigatorTreeNode {
        if (depth === prevSpineLength) {
            return { ...node, children: [newTailNode] };
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
    // Depth of the node whose children are the projected fanout — either the
    // engine-root placeholder (when no confirmed turns) or the latest confirmed
    // turn (otherwise).
    const fanoutParentDepth = Math.max(spineLength, 1);
    const fanoutParent = walkSpine(prevSynthetic, fanoutParentDepth);

    const updatedFanoutParent: NavigatorTreeNode = {
        ...fanoutParent,
        children: mergeChildren(
            fanoutParent.children,
            engineTree.children,
            priority,
            branchWidth,
            []
        )
    };

    return replaceNodeAtDepth(prevSynthetic, fanoutParentDepth, updatedFanoutParent);
}

function replaceNodeAtDepth(
    root: NavigatorTreeNode,
    targetDepth: number,
    newNode: NavigatorTreeNode
): NavigatorTreeNode {
    function rebuild(node: NavigatorTreeNode, depth: number): NavigatorTreeNode {
        if (depth === targetDepth) return newNode;
        const child = node.children[0];
        if (!child) return node;
        return { ...node, children: [rebuild(child, depth + 1)] };
    }
    return rebuild(root, 0);
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

    // Preserve absent-from-fresh children only when they have a reason to stick
    // around (scenario lane or user-pinned). Otherwise dropping out of the
    // engine's top-K means the child is stale — keeping it lets ghost branches
    // accumulate across successive emits.
    const scenarioSegmentsAtDepth = scenarioSegmentsAt(
        priority.scenarioKeyPaths,
        keyPath.length
    );
    for (const [key, preservedChild] of preservedByKey) {
        if (visited.has(key)) continue;
        const thisPath = [...keyPath, key].join(">");
        const isReferenced =
            scenarioSegmentsAtDepth.has(key) ||
            priority.manualExpansionKeyPaths.has(thisPath);
        if (!isReferenced) continue;
        result.push(preservedChild);
    }

    return trimChildrenByPriority(
        result,
        keyPath,
        priority,
        branchWidth,
        scenarioSegmentsAtDepth
    );
}

/** Collect the nodeKeys that appear at `depth` across any scenario path.
 *  Engine-side wire truncation keeps these (see `to_protocol_tree`'s
 *  must-keep paths in projection.rs); the frontend trim/preserve logic must
 *  mirror that contract so rendered scenario lanes match the engine's
 *  emitted scenarios. */
function scenarioSegmentsAt(paths: ReadonlyArray<string>, depth: number): Set<string> {
    const result = new Set<string>();
    for (const path of paths) {
        if (path === "") continue;
        const segs = path.split(">");
        const seg = segs[depth];
        if (seg !== undefined) result.add(seg);
    }
    return result;
}

function trimChildrenByPriority(
    children: NavigatorTreeNode[],
    keyPath: string[],
    priority: ReconcilePriority,
    branchWidth: number,
    scenarioSegmentsAtDepth: Set<string> = scenarioSegmentsAt(
        priority.scenarioKeyPaths,
        keyPath.length
    )
): NavigatorTreeNode[] {
    type Ranked = { child: NavigatorTreeNode; rank: number; score: number };
    const ranked: Ranked[] = children.map((child) => {
        const key = nodeKey(child);
        const thisPath = [...keyPath, key].join(">");
        let rank = 3;
        if (scenarioSegmentsAtDepth.has(key)) rank = 0;
        else if (priority.manualExpansionKeyPaths.has(thisPath)) rank = 1;
        return { child, rank, score: child.scores.composite };
    });

    // Keep every rank-0 child unconditionally (scenario lanes are
    // load-bearing). `branchWidth` is the floor on total kept children, not
    // a hard ceiling — fill remaining slots from rank-1 then rank-3 by
    // score, but never drop a scenario-referenced child.
    const rankZero = ranked.filter((r) => r.rank === 0);
    const rest = ranked
        .filter((r) => r.rank !== 0)
        .sort((a, b) => (a.rank !== b.rank ? a.rank - b.rank : b.score - a.score));
    const fillCount = Math.max(0, branchWidth - rankZero.length);
    return [...rankZero, ...rest.slice(0, fillCount)].map((entry) => entry.child);
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
    const fanoutParentDepth = Math.max(spineLength, 1);

    function pruneSubtree(node: NavigatorTreeNode): NavigatorTreeNode | null {
        const confirmed = new Set(node.confirmedChampionIds ?? []);
        for (const id of node.championIds) {
            if (confirmed.has(id)) continue;
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
        if (depth === fanoutParentDepth) {
            // At the fanout-parent: keep this spine node as-is (its champions
            // are confirmed/used-by-design) and prune only its children.
            const kept: NavigatorTreeNode[] = [];
            for (const child of node.children) {
                const next = pruneSubtree(child);
                if (next) kept.push(next);
            }
            return { ...node, children: kept };
        }
        const child = node.children[0];
        if (!child) return node;
        return { ...node, children: [rebuild(child, depth + 1)] };
    }

    return rebuild(root, 0);
}
