import type { NavigatorTreeNode } from "../contexts/NavigatorContext";
import type { ConfirmedTurn } from "./treeReconcile";
import { spineNodeCount } from "./treeReconcile";
import { turnLabelForSlots } from "./turnSequence";

/** Engine depth reached is 1–5 in practice (memory project_engine_search_budget). */
export const MAX_COLUMNS = 5;

/** Depth of the node whose children are the current decision's fan — the rule
 *  mergeEngineTree / pruneInvalid use (treeSynthesis.ts). */
export function fanoutDepth(turns: ConfirmedTurn[]): number {
    return Math.max(spineNodeCount(turns), 1);
}

/** The spine end (design § 2). Falls back to the deepest reachable node when
 *  the tree is shorter than the turns (a transient between two updates). */
export function fanoutParent(
    root: NavigatorTreeNode,
    turns: ConfirmedTurn[]
): NavigatorTreeNode {
    const depth = fanoutDepth(turns);
    let node = root;
    for (let i = 0; i < depth; i++) {
        const next = node.children[0];
        if (!next) return node;
        node = next;
    }
    return node;
}

export interface ColumnModel {
    depth: number;
    /** Engine order: index 0 = top-1. */
    nodes: NavigatorTreeNode[];
    selectedIndex: number | null;
    /** The nodes selected in columns 0..depth-1 — the line leading here. */
    lineage: NavigatorTreeNode[];
}

/** Column 0 = the fan; column k = children of the node selected in column k−1.
 *  A selected leaf adds no empty column; an unresolvable index ends the walk. */
export function deriveColumns(
    fanout: NavigatorTreeNode,
    selectedPath: readonly number[],
    maxColumns = MAX_COLUMNS
): ColumnModel[] {
    const columns: ColumnModel[] = [];
    const lineage: NavigatorTreeNode[] = [];
    let nodes = fanout.children;
    for (let depth = 0; depth < maxColumns && nodes.length > 0; depth++) {
        const idx = selectedPath[depth];
        const selectedIndex = idx !== undefined && nodes[idx] !== undefined ? idx : null;
        columns.push({ depth, nodes, selectedIndex, lineage: [...lineage] });
        if (selectedIndex === null) break;
        const chosen = nodes[selectedIndex];
        lineage.push(chosen);
        nodes = chosen.children;
    }
    return columns;
}

export function clampSelectedPath(
    fanout: NavigatorTreeNode,
    path: readonly number[]
): number[] {
    const out: number[] = [];
    let node = fanout;
    for (const idx of path) {
        const next = node.children[idx];
        if (!next) break;
        out.push(idx);
        node = next;
    }
    return out;
}

const setKey = (ids: readonly string[]): string => [...ids].sort().join("|");

/** Re-resolve a path across a tree change by each hop's championIds (the same
 *  sorted-set match `pathStepsToIndexPath` uses); stop at the first miss. */
export function remapSelectedPath(
    prevFanout: NavigatorTreeNode,
    nextFanout: NavigatorTreeNode,
    path: readonly number[]
): number[] {
    const out: number[] = [];
    let prev = prevFanout;
    let next = nextFanout;
    for (const idx of path) {
        const oldChild = prev.children[idx];
        if (!oldChild) break;
        const key = setKey(oldChild.championIds);
        const newIdx = next.children.findIndex((c) => setKey(c.championIds) === key);
        if (newIdx === -1) break;
        out.push(newIdx);
        prev = oldChild;
        next = next.children[newIdx];
    }
    return out;
}

export function topLinePath(
    fanout: NavigatorTreeNode,
    maxColumns = MAX_COLUMNS
): number[] {
    const out: number[] = [];
    let node = fanout;
    while (node.children.length > 0 && out.length < maxColumns) {
        out.push(0);
        node = node.children[0];
    }
    return out;
}

export function lineNodes(
    fanout: NavigatorTreeNode,
    path: readonly number[]
): NavigatorTreeNode[] {
    const out: NavigatorTreeNode[] = [];
    let node = fanout;
    for (const idx of path) {
        const next = node.children[idx];
        if (!next) break;
        out.push(next);
        node = next;
    }
    return out;
}

/** Picks of `side` visible before a node: confirmed picks (pair-pending
 *  included) plus that side's picks along the lineage, deduplicated. */
export function sidePicksBefore(
    turns: readonly ConfirmedTurn[],
    lineage: readonly NavigatorTreeNode[],
    side: "blue" | "red"
): string[] {
    const out = new Set<string>();
    for (const t of turns) {
        if (t.actionType === "pick" && t.side === side)
            t.championIds.forEach((id) => out.add(id));
    }
    for (const n of lineage) {
        if (n.actionType === "pick" && n.side === side)
            n.championIds.forEach((id) => out.add(id));
    }
    return [...out];
}

/** "Red Pick 4: Tristana (3.08)" per node — the top-line preview and the export description. */
export function describeLine(
    nodes: readonly NavigatorTreeNode[],
    nameOf: (id: string) => string
): string[] {
    return nodes.map(
        (n) =>
            `${turnLabelForSlots(n.slots)}: ${n.championIds.map(nameOf).join(" + ")} (${n.scores.composite.toFixed(2)})`
    );
}

export const NO_BAN_SIGNAL_LABEL = "no ban signal yet";

// Controller ruling 2026-09-07 (verified against NavigatorContext.ts:4-10):
// NavigatorScoreSet has no `roleCoverage` key — the brief's five-key list is
// amended to these four.
const SCORE_COMPONENTS = [
    "compStrength",
    "informationValue",
    "flexRetention",
    "revealCost"
] as const;

/** Design § 5: a ban fan carries no engine signal when every sibling is a ban
 *  with the same composite and every score component is zero (phase-1 bans
 *  today: 0.003 across the board). Phase-2 bans differ per child and keep
 *  their numbers; slice 4 gives bans real scores and this returns false on
 *  its own. */
export function banSignalAbsent(nodes: readonly NavigatorTreeNode[]): boolean {
    if (nodes.length === 0) return false;
    if (!nodes.every((n) => n.actionType === "ban")) return false;
    const first = nodes[0].scores.composite;
    return nodes.every(
        (n) =>
            Math.abs(n.scores.composite - first) < 1e-9 &&
            SCORE_COMPONENTS.every((k) => n.scores[k] === 0)
    );
}
