import { describe, expect, test } from "vitest";
import type { NavigatorTreeNode } from "../contexts/NavigatorContext";
import type { ReconcilePriority } from "./treeReconcile";
import { nodeKey } from "./treeReconcile";
import { mergeEngineTree, synthesizeFullTree } from "./treeSynthesis";

function zeroScores() {
    return {
        composite: 0,
        compStrength: 0,
        informationValue: 0,
        flexRetention: 0,
        revealCost: 0
    };
}

function pickChild(championId: string, composite = 0): NavigatorTreeNode {
    return {
        championIds: [championId],
        actionType: "pick",
        phase: "pick1",
        scores: { ...zeroScores(), composite },
        assignmentDistribution: [],
        side: "blue",
        slots: [0],
        userInjected: false,
        children: []
    };
}

function emptyPriority(overrides: Partial<ReconcilePriority> = {}): ReconcilePriority {
    return {
        scenarioKeyPaths: overrides.scenarioKeyPaths ?? [],
        manualExpansionKeyPaths: overrides.manualExpansionKeyPaths ?? new Set<string>()
    };
}

function emptyDraftState() {
    return {
        bluePicks: [],
        redPicks: [],
        blueBans: [],
        redBans: [],
        turnIndex: 0
    };
}

function engineRootWithChildren(children: NavigatorTreeNode[]): NavigatorTreeNode {
    return {
        championIds: [],
        actionType: "pick",
        phase: "pick1",
        scores: zeroScores(),
        assignmentDistribution: [],
        side: "blue",
        slots: [],
        userInjected: false,
        children
    };
}

describe("mergeEngineTree", () => {
    test("drops preserved children absent from fresh emit when not referenced", () => {
        // Previous snapshot's fanout had A, B, C as projected children.
        const prevSynthetic = synthesizeFullTree(
            engineRootWithChildren([pickChild("A"), pickChild("B"), pickChild("C")]),
            []
        );
        // Fresh emit: top-K shifted — C dropped out, D entered.
        const freshEngineTree = engineRootWithChildren([
            pickChild("A"),
            pickChild("B"),
            pickChild("D")
        ]);

        const merged = mergeEngineTree(
            prevSynthetic,
            freshEngineTree,
            0,
            emptyDraftState(),
            emptyPriority(),
            /* branchWidth */ 10
        );

        const fanout = merged.children[0].children;
        const keys = fanout.map(nodeKey);
        expect(keys).toEqual(
            expect.arrayContaining([
                nodeKey(pickChild("A")),
                nodeKey(pickChild("B")),
                nodeKey(pickChild("D"))
            ])
        );
        expect(keys).not.toContain(nodeKey(pickChild("C")));
    });

    test("keeps preserved child absent from fresh emit when scenario-referenced", () => {
        const prevSynthetic = synthesizeFullTree(
            engineRootWithChildren([pickChild("A"), pickChild("B"), pickChild("C")]),
            []
        );
        const freshEngineTree = engineRootWithChildren([
            pickChild("A"),
            pickChild("B"),
            pickChild("D")
        ]);

        const merged = mergeEngineTree(
            prevSynthetic,
            freshEngineTree,
            0,
            emptyDraftState(),
            emptyPriority({
                scenarioKeyPaths: [nodeKey(pickChild("C"))]
            }),
            10
        );

        const fanout = merged.children[0].children;
        const keys = fanout.map(nodeKey);
        expect(keys).toContain(nodeKey(pickChild("C")));
        expect(keys).toContain(nodeKey(pickChild("D")));
    });

    test("keeps preserved child absent from fresh emit when manually expanded", () => {
        const prevSynthetic = synthesizeFullTree(
            engineRootWithChildren([pickChild("A"), pickChild("B"), pickChild("C")]),
            []
        );
        const freshEngineTree = engineRootWithChildren([
            pickChild("A"),
            pickChild("B"),
            pickChild("D")
        ]);

        const merged = mergeEngineTree(
            prevSynthetic,
            freshEngineTree,
            0,
            emptyDraftState(),
            emptyPriority({
                manualExpansionKeyPaths: new Set([nodeKey(pickChild("C"))])
            }),
            10
        );

        const fanout = merged.children[0].children;
        const keys = fanout.map(nodeKey);
        expect(keys).toContain(nodeKey(pickChild("C")));
    });
});
