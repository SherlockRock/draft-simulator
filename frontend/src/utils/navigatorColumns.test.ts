import { describe, expect, test } from "vitest";
import type { NavigatorTreeNode } from "../contexts/NavigatorContext";
import type { ConfirmedTurn } from "./treeReconcile";
import banFixture from "./__fixtures__/navigator-ban1-snapshot.json";
import pickFixture from "./__fixtures__/navigator-item5-snapshot.json";
import { NavigatorTreeNodeSchema } from "./navigatorTreeSchema";
import {
    MAX_COLUMNS,
    banSignalAbsent,
    clampSelectedPath,
    deriveColumns,
    describeLine,
    fanoutDepth,
    fanoutParent,
    lineNodes,
    remapSelectedPath,
    sidePicksBefore,
    topLinePath
} from "./navigatorColumns";

const scores = (composite: number) => ({
    composite,
    compStrength: 0,
    informationValue: 0,
    flexRetention: 0,
    revealCost: 0
});
function node(
    championIds: string[],
    slots: number[],
    side: "blue" | "red",
    composite: number,
    children: NavigatorTreeNode[] = [],
    actionType: "ban" | "pick" = "pick"
): NavigatorTreeNode {
    return {
        championIds,
        actionType,
        phase: "pick2",
        scores: scores(composite),
        assignmentDistribution: [],
        side,
        slots,
        userInjected: false,
        children
    };
}
const root = (children: NavigatorTreeNode[]): NavigatorTreeNode => ({
    championIds: [],
    actionType: "ban",
    phase: "ban1",
    scores: scores(0),
    assignmentDistribution: [],
    side: null,
    slots: [],
    userInjected: false,
    children
});
const turn = (
    side: "blue" | "red",
    championIds: string[],
    slots: number[],
    pairState: ConfirmedTurn["pairState"] = "solo",
    actionType: "ban" | "pick" = "pick"
): ConfirmedTurn => ({
    side,
    actionType,
    phase: "pick1",
    championIds,
    slots,
    userInjected: false,
    pairState
});

// Fan at Red Pick 4 (slot 16): two candidates; Tristana's line continues into a blue pair then Red Pick 5.
const redPick5 = node(["Pantheon"], [19], "red", 3.0);
const bluePair = node(["Xayah", "Shen"], [17, 18], "blue", 2.9, [redPick5]);
const fan = [
    node(["Tristana"], [16], "red", 3.08, [bluePair]),
    node(["Ezreal"], [16], "red", 2.7)
];
const spineEnd = node(["Lissandra"], [11], "red", 0, fan);
const tree = root([node(["Gragas"], [6], "blue", 0, [spineEnd])]);
const turns = [turn("blue", ["Gragas"], [6]), turn("red", ["Lissandra"], [11])];

describe("fanoutParent", () => {
    test("walks max(spineNodeCount, 1) hops", () => {
        expect(fanoutDepth(turns)).toBe(2);
        expect(fanoutParent(tree, turns)).toBe(spineEnd);
    });
    test("zero turns: the engine-root placeholder is the fanout parent", () => {
        const placeholder = root(fan);
        expect(fanoutDepth([])).toBe(1);
        expect(fanoutParent(root([placeholder]), [])).toBe(placeholder);
    });
    test("pair-pending does not advance the spine", () => {
        const pending = [...turns, turn("red", ["Tristana"], [16], "pair-pending")];
        expect(fanoutDepth(pending)).toBe(2);
        expect(fanoutParent(tree, pending)).toBe(spineEnd);
    });
    test("a spine shorter than the turns stops at the deepest reachable node", () => {
        // Execution ruling 2026-09-07: the original fixture (4 turns) never ran out of
        // children[0] hops — root → Gragas → Lissandra → Tristana → Xayah+Shen exists —
        // so it asserted `spineEnd` against a walk the code (per design § 2: exactly
        // spineNodeCount hops) correctly continues. Six turns outrun the five-deep tree.
        const extra = [
            turn("red", ["X"], [12]),
            turn("blue", ["Y"], [13]),
            turn("red", ["Z"], [14]),
            turn("blue", ["W"], [15])
        ];
        expect(fanoutParent(tree, [...turns, ...extra])).toBe(redPick5);
    });
});

describe("deriveColumns", () => {
    test("column 0 is the fan in engine order with nothing selected", () => {
        const cols = deriveColumns(spineEnd, []);
        expect(cols).toHaveLength(1);
        expect(cols[0]).toEqual({
            depth: 0,
            nodes: fan,
            selectedIndex: null,
            lineage: []
        });
    });
    test("selecting opens the child column and records the lineage", () => {
        const cols = deriveColumns(spineEnd, [0, 0]);
        expect(cols.map((c) => c.selectedIndex)).toEqual([0, 0, null]);
        expect(cols[1].nodes).toEqual([bluePair]);
        expect(cols[2].nodes).toEqual([redPick5]);
        expect(cols[2].lineage.map((n) => n.championIds[0])).toEqual([
            "Tristana",
            "Xayah"
        ]);
    });
    test("an index that no longer resolves ends the columns there", () => {
        const cols = deriveColumns(spineEnd, [5]);
        expect(cols).toHaveLength(1);
        expect(cols[0].selectedIndex).toBeNull();
    });
    test("a selected leaf adds no empty column", () => {
        expect(deriveColumns(spineEnd, [1])).toHaveLength(1);
    });
    test("caps at MAX_COLUMNS", () => {
        let leaf = node(["Z"], [19], "red", 1);
        for (let i = 0; i < 8; i++) leaf = node([`N${i}`], [10], "blue", 1, [leaf]);
        expect(deriveColumns(root([leaf]), [0, 0, 0, 0, 0, 0, 0, 0])).toHaveLength(
            MAX_COLUMNS
        );
    });
});

describe("paths", () => {
    test("clampSelectedPath truncates at the first invalid index", () => {
        expect(clampSelectedPath(spineEnd, [0, 0, 0])).toEqual([0, 0, 0]);
        expect(clampSelectedPath(spineEnd, [0, 3, 0])).toEqual([0]);
        expect(clampSelectedPath(spineEnd, [1, 0])).toEqual([1]);
    });
    test("remapSelectedPath follows the champion, not the index, across a re-rank", () => {
        const reranked = node(["Lissandra"], [11], "red", 0, [fan[1], fan[0]]);
        expect(remapSelectedPath(spineEnd, reranked, [0, 0])).toEqual([1, 0]);
        expect(remapSelectedPath(spineEnd, reranked, [1])).toEqual([0]);
        const without = node(["Lissandra"], [11], "red", 0, [fan[1]]);
        expect(remapSelectedPath(spineEnd, without, [0, 0])).toEqual([]);
        expect(remapSelectedPath(spineEnd, spineEnd, [0, 0, 0])).toEqual([0, 0, 0]);
    });
    test("topLinePath follows index 0 to the leaf", () => {
        expect(topLinePath(spineEnd)).toEqual([0, 0, 0]);
        expect(topLinePath(node(["A"], [19], "red", 1))).toEqual([]);
    });
    test("lineNodes returns the nodes along the path", () => {
        expect(
            lineNodes(spineEnd, [0, 0, 0]).map((n) => n.championIds.join("+"))
        ).toEqual(["Tristana", "Xayah+Shen", "Pantheon"]);
    });
});

describe("sidePicksBefore / describeLine", () => {
    test("confirmed picks then the lineage's picks of that side, bans skipped, no duplicates", () => {
        const t = [
            turn("blue", ["Ashe"], [0], "solo", "ban"),
            turn("blue", ["Gragas"], [6]),
            turn("red", ["Lissandra"], [11])
        ];
        expect(sidePicksBefore(t, [fan[0], bluePair], "red")).toEqual([
            "Lissandra",
            "Tristana"
        ]);
        expect(sidePicksBefore(t, [fan[0], bluePair], "blue")).toEqual([
            "Gragas",
            "Xayah",
            "Shen"
        ]);
        const pending = [...t, turn("blue", ["Xayah"], [17], "pair-pending")];
        expect(sidePicksBefore(pending, [bluePair], "blue")).toEqual([
            "Gragas",
            "Xayah",
            "Shen"
        ]);
    });
    test("describeLine", () => {
        expect(describeLine([fan[0], bluePair, redPick5], (id) => id)).toEqual([
            "Red Pick 4: Tristana (3.08)",
            "Blue Pick 4 + Blue Pick 5: Xayah + Shen (2.90)",
            "Red Pick 5: Pantheon (3.00)"
        ]);
    });
});

describe("banSignalAbsent (design § 5)", () => {
    const banRoot = NavigatorTreeNodeSchema.parse(banFixture.tree);
    const pickRoot = NavigatorTreeNodeSchema.parse(pickFixture.tree);

    test("a phase-1 ban fan with equal composites and zero components has no signal", () => {
        expect(banSignalAbsent(banRoot.children)).toBe(true);
    });
    test("a pick fan has signal", () => {
        expect(banSignalAbsent(pickRoot.children)).toBe(false);
    });
    test("a ban fan whose composites differ has signal (phase-2 bans)", () => {
        const [a, ...rest] = banRoot.children;
        const varied = [{ ...a, scores: { ...a.scores, composite: a.scores.composite + 0.1 } }, ...rest];
        expect(banSignalAbsent(varied)).toBe(false);
    });
    test("a ban fan with a non-zero component has signal", () => {
        const [a, ...rest] = banRoot.children;
        const withInfo = [{ ...a, scores: { ...a.scores, informationValue: 0.2 } }, ...rest];
        expect(banSignalAbsent(withInfo)).toBe(false);
    });
    test("an empty fan is not 'absent signal'", () => {
        expect(banSignalAbsent([])).toBe(false);
    });
});
