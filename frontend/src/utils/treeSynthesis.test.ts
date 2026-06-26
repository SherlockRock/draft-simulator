import { describe, expect, test } from "vitest";
import type {
    NavigatorEventData,
    NavigatorScenario,
    NavigatorTreeNode
} from "../contexts/NavigatorContext";
import type { ReconcilePriority } from "./treeReconcile";
import { nodeKey } from "./treeReconcile";
import {
    eventsToConfirmedTurns,
    extendSpineOptimistic,
    includeConfirmedDraftState,
    includeConfirmedDraftStateForScenarios,
    mergeEngineTree,
    pruneInvalid,
    remapScenarioPath,
    remapScenarios,
    spineNodeCount,
    synthesizeFullTree
} from "./treeSynthesis";

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

function event(overrides: Partial<NavigatorEventData> = {}): NavigatorEventData {
    return {
        id: overrides.id ?? "evt-1",
        navigator_draft_id: "draft-1",
        event_type: overrides.event_type ?? "ban",
        slot: overrides.slot ?? 0,
        side: overrides.side ?? "blue",
        champion_id: overrides.champion_id ?? "Ahri",
        user_injected: overrides.user_injected ?? false,
        createdAt: overrides.createdAt ?? "2026-01-01T00:00:00.000Z"
    };
}

function emptyScenario(overrides: Partial<NavigatorScenario> = {}): NavigatorScenario {
    return {
        name: overrides.name ?? "Scenario",
        scores: overrides.scores ?? {
            composite: 0,
            compStrength: 0,
            informationValue: 0
        },
        description: overrides.description ?? "",
        bluePicks: overrides.bluePicks ?? [],
        redPicks: overrides.redPicks ?? [],
        blueBans: overrides.blueBans ?? [],
        redBans: overrides.redBans ?? [],
        blueLikelyAssignments: overrides.blueLikelyAssignments ?? [],
        redLikelyAssignments: overrides.redLikelyAssignments ?? [],
        treePath: overrides.treePath ?? [],
        perspective: overrides.perspective ?? "robust",
        indicators: overrides.indicators ?? []
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

describe("eventsToConfirmedTurns", () => {
    test("emits one solo turn per ban event", () => {
        const turns = eventsToConfirmedTurns([
            event({ event_type: "ban", side: "blue", slot: 0, champion_id: "B1" })
        ]);
        expect(turns).toHaveLength(1);
        expect(turns[0]).toMatchObject({
            side: "blue",
            actionType: "ban",
            phase: "ban1",
            championIds: ["B1"],
            slots: [0],
            pairState: "solo"
        });
    });

    test("collapses two consecutive same-side picks at adjacent slots into pair-complete", () => {
        const turns = eventsToConfirmedTurns([
            event({
                id: "a",
                event_type: "pick",
                side: "red",
                slot: 7,
                champion_id: "RA"
            }),
            event({
                id: "b",
                event_type: "pick",
                side: "red",
                slot: 8,
                champion_id: "RB",
                createdAt: "2026-01-01T00:00:01.000Z"
            })
        ]);
        expect(turns).toHaveLength(1);
        expect(turns[0]).toMatchObject({
            side: "red",
            actionType: "pick",
            championIds: ["RA", "RB"],
            slots: [7, 8],
            pairState: "pair-complete"
        });
    });

    test("emits pair-pending when only the first of a pair is present", () => {
        const turns = eventsToConfirmedTurns([
            event({
                id: "a",
                event_type: "pick",
                side: "red",
                slot: 7,
                champion_id: "RA"
            })
        ]);
        expect(turns).toHaveLength(1);
        expect(turns[0]).toMatchObject({
            championIds: ["RA"],
            slots: [7],
            pairState: "pair-pending"
        });
    });

    test("sorts events by slot first, then createdAt, then id", () => {
        const turns = eventsToConfirmedTurns([
            event({
                id: "later-low-slot",
                event_type: "ban",
                side: "blue",
                slot: 0,
                champion_id: "First",
                createdAt: "2026-01-01T00:00:05.000Z"
            }),
            event({
                id: "earlier-high-slot",
                event_type: "ban",
                side: "red",
                slot: 1,
                champion_id: "Second",
                createdAt: "2026-01-01T00:00:01.000Z"
            })
        ]);
        expect(turns.map((t) => t.championIds[0])).toEqual(["First", "Second"]);
    });

    test("skips non-action event types", () => {
        const turns = eventsToConfirmedTurns([
            event({
                event_type: "engine_result",
                side: "blue",
                slot: 0,
                champion_id: "ER"
            }),
            event({
                id: "wi",
                event_type: "what_if_pick",
                side: "blue",
                slot: 6,
                champion_id: "WI"
            })
        ]);
        expect(turns).toEqual([]);
    });
});

describe("spineNodeCount", () => {
    test("returns 0 for an empty turn list", () => {
        expect(spineNodeCount([])).toBe(0);
    });

    test("returns turns.length when the tail is solo or pair-complete", () => {
        const turns = eventsToConfirmedTurns([
            event({ event_type: "ban", side: "blue", slot: 0, champion_id: "X" })
        ]);
        expect(spineNodeCount(turns)).toBe(1);
    });

    test("subtracts 1 when the tail is pair-pending", () => {
        const turns = eventsToConfirmedTurns([
            event({ event_type: "ban", side: "blue", slot: 0, champion_id: "X" }),
            event({
                id: "p",
                event_type: "pick",
                side: "red",
                slot: 7,
                champion_id: "RA",
                createdAt: "2026-01-01T00:00:01.000Z"
            })
        ]);
        expect(spineNodeCount(turns)).toBe(1);
    });
});

describe("synthesizeFullTree", () => {
    test("folds the engine root's fanout under the synthetic root when no turns are confirmed", () => {
        const engineTree = engineRootWithChildren([pickChild("A"), pickChild("B")]);
        const synth = synthesizeFullTree(engineTree, []);

        expect(synth.championIds).toEqual([]);
        expect(synth.children).toHaveLength(1);
        const placeholder = synth.children[0];
        expect(placeholder.championIds).toEqual([]);
        expect(placeholder.children.map((c) => c.championIds[0])).toEqual(["A", "B"]);
    });

    test("folds the engine root into the latest confirmed turn so the fanout hangs off the most recent pick", () => {
        const engineTree = engineRootWithChildren([
            pickChild("Proj1"),
            pickChild("Proj2")
        ]);
        const turns = eventsToConfirmedTurns([
            event({
                event_type: "ban",
                side: "blue",
                slot: 0,
                champion_id: "ConfBan"
            })
        ]);
        const synth = synthesizeFullTree(engineTree, turns);

        // synthetic root → confirmed ban → projected fanout
        const spineTail = synth.children[0];
        expect(spineTail.championIds).toEqual(["ConfBan"]);
        expect(spineTail.actionType).toBe("ban");
        expect(spineTail.children.map((c) => c.championIds[0])).toEqual([
            "Proj1",
            "Proj2"
        ]);
    });

    test("terminates at the spine tail when engineTree is null", () => {
        const turns = eventsToConfirmedTurns([
            event({ event_type: "ban", side: "blue", slot: 0, champion_id: "X" })
        ]);
        const synth = synthesizeFullTree(null, turns);
        const spineTail = synth.children[0];
        expect(spineTail.championIds).toEqual(["X"]);
        expect(spineTail.children).toEqual([]);
    });
});

describe("extendSpineOptimistic", () => {
    test("promotes the matching projected child onto the spine when the new turn lands on it", () => {
        const engineTree = engineRootWithChildren([
            // Make the projected child a ban so it matches the new turn's nodeKey.
            { ...pickChild("Proj1"), actionType: "ban" },
            { ...pickChild("Proj2"), actionType: "ban" }
        ]);
        const prev = synthesizeFullTree(engineTree, []);
        const newTurn = eventsToConfirmedTurns([
            event({
                event_type: "ban",
                side: "blue",
                slot: 0,
                champion_id: "Proj1"
            })
        ])[0];

        const extended = extendSpineOptimistic(prev, newTurn, 0);
        // The new spine tail replaces the engine placeholder, carrying the
        // matched projected child's subtree forward.
        const newTail = extended.children[0];
        expect(newTail.championIds).toEqual(["Proj1"]);
        expect(newTail.actionType).toBe("ban");
    });

    test("extends spine with no children when no projected child matches", () => {
        const engineTree = engineRootWithChildren([
            { ...pickChild("Proj1"), actionType: "ban" }
        ]);
        const prev = synthesizeFullTree(engineTree, []);
        const newTurn = eventsToConfirmedTurns([
            event({
                event_type: "ban",
                side: "blue",
                slot: 0,
                champion_id: "Surprise"
            })
        ])[0];

        const extended = extendSpineOptimistic(prev, newTurn, 0);
        const newTail = extended.children[0];
        expect(newTail.championIds).toEqual(["Surprise"]);
        expect(newTail.children).toEqual([]);
    });

    test("pair-pending: filters fanout to pair candidates containing the entered champion", () => {
        // Fanout under the engine placeholder represents pair candidates at slots 9+10.
        const pairAB: NavigatorTreeNode = {
            championIds: ["A", "B"],
            actionType: "pick",
            phase: "pick1",
            scores: zeroScores(),
            assignmentDistribution: [],
            side: "blue",
            slots: [9, 10],
            userInjected: false,
            children: []
        };
        const pairCD: NavigatorTreeNode = {
            championIds: ["C", "D"],
            actionType: "pick",
            phase: "pick1",
            scores: zeroScores(),
            assignmentDistribution: [],
            side: "blue",
            slots: [9, 10],
            userInjected: false,
            children: []
        };
        const pairAE: NavigatorTreeNode = {
            championIds: ["A", "E"],
            actionType: "pick",
            phase: "pick1",
            scores: zeroScores(),
            assignmentDistribution: [],
            side: "blue",
            slots: [9, 10],
            userInjected: false,
            children: []
        };
        const prev = synthesizeFullTree(
            engineRootWithChildren([pairAB, pairCD, pairAE]),
            []
        );
        const pendingTurn = {
            side: "blue" as const,
            actionType: "pick" as const,
            phase: "pick1" as const,
            championIds: ["A"],
            slots: [9],
            userInjected: false,
            pairState: "pair-pending" as const
        };

        const extended = extendSpineOptimistic(prev, pendingTurn, 0);
        const filteredFanout = extended.children[0].children;
        // Only the two pairs containing "A" survive; pairCD is dropped.
        expect(filteredFanout.map((c) => c.championIds.sort().join("|"))).toEqual([
            "A|B",
            "A|E"
        ]);
        // Each survivor is tagged with the confirmed champion.
        for (const child of filteredFanout) {
            expect(child.confirmedChampionIds).toEqual(["A"]);
        }
    });
});

describe("pruneInvalid", () => {
    test("drops subtree branches that reference a used champion", () => {
        const projUsed = pickChild("UsedChamp");
        const projFresh = pickChild("Fresh");
        const engineTree = engineRootWithChildren([projUsed, projFresh]);
        const synth = synthesizeFullTree(engineTree, []);

        const pruned = pruneInvalid(
            synth,
            {
                ...emptyDraftState(),
                blueBans: ["UsedChamp"]
            },
            0
        );

        const fanout = pruned.children[0].children;
        expect(fanout.map((c) => c.championIds[0])).toEqual(["Fresh"]);
    });

    test("leaves the spine node intact even if its championIds intersect the used pool", () => {
        // Spine tail = confirmed ban for "X"; pruning must not delete it.
        const engineTree = engineRootWithChildren([pickChild("Other")]);
        const turns = eventsToConfirmedTurns([
            event({ event_type: "ban", side: "blue", slot: 0, champion_id: "X" })
        ]);
        const synth = synthesizeFullTree(engineTree, turns);
        const spineLength = spineNodeCount(turns);

        const pruned = pruneInvalid(
            synth,
            {
                ...emptyDraftState(),
                blueBans: ["X"]
            },
            spineLength
        );

        // synthetic root → confirmed ban "X" → fanout
        expect(pruned.children[0].championIds).toEqual(["X"]);
    });

    test("treats a pair-pending node's confirmedChampionIds as exempt from the used-pool check", () => {
        // Pair node has confirmed "A" (in state.bluePicks) and projected "Z" (fresh).
        const pairNode: NavigatorTreeNode = {
            championIds: ["A", "Z"],
            actionType: "pick",
            phase: "pick1",
            scores: zeroScores(),
            assignmentDistribution: [],
            side: "blue",
            slots: [9, 10],
            userInjected: false,
            confirmedChampionIds: ["A"],
            children: []
        };
        const synth = synthesizeFullTree(engineRootWithChildren([pairNode]), []);

        const pruned = pruneInvalid(
            synth,
            {
                ...emptyDraftState(),
                bluePicks: ["A"]
            },
            0
        );

        const fanout = pruned.children[0].children;
        expect(fanout).toHaveLength(1);
        expect(fanout[0].championIds).toEqual(["A", "Z"]);
    });
});

describe("remapScenarioPath", () => {
    test("prepends a single empty-championIds step when no turns are confirmed", () => {
        const scenario = emptyScenario({
            treePath: [{ slot: 6, championIds: ["Ahri"] }]
        });

        const remapped = remapScenarioPath(scenario, []);
        expect(remapped.treePath).toEqual([
            { slot: 0, championIds: [] },
            { slot: 6, championIds: ["Ahri"] }
        ]);
    });

    test("prepends one step per confirmed (non-pair-pending) turn", () => {
        const turns = eventsToConfirmedTurns([
            event({ event_type: "ban", side: "blue", slot: 0, champion_id: "B0" }),
            event({
                id: "2",
                event_type: "ban",
                side: "red",
                slot: 1,
                champion_id: "R0",
                createdAt: "2026-01-01T00:00:01.000Z"
            })
        ]);
        const scenario = emptyScenario({
            treePath: [{ slot: 6, championIds: ["Ahri"] }]
        });

        const remapped = remapScenarioPath(scenario, turns);
        expect(remapped.treePath).toEqual([
            { slot: 0, championIds: ["B0"] },
            { slot: 1, championIds: ["R0"] },
            { slot: 6, championIds: ["Ahri"] }
        ]);
    });
});

describe("remapScenarios", () => {
    test("applies remapScenarioPath to each scenario", () => {
        const scenarios = [
            emptyScenario({ name: "S1", treePath: [{ slot: 6, championIds: ["A"] }] }),
            emptyScenario({ name: "S2", treePath: [{ slot: 6, championIds: ["B"] }] })
        ];
        const remapped = remapScenarios(scenarios, []);
        expect(remapped).toHaveLength(2);
        for (const s of remapped) {
            expect(s.treePath[0]).toEqual({ slot: 0, championIds: [] });
        }
    });
});

describe("includeConfirmedDraftState", () => {
    test("prepends the confirmed champion lists to the scenario's lists, deduped", () => {
        const scenario = emptyScenario({
            bluePicks: ["P1", "P2"],
            redPicks: [],
            blueBans: ["B1"],
            redBans: []
        });
        const merged = includeConfirmedDraftState(scenario, {
            blueBans: ["ConfB", "B1"], // dup B1 should not double
            redBans: ["ConfR"],
            bluePicks: ["ConfP"],
            redPicks: [],
            turnIndex: 0
        });
        expect(merged.blueBans).toEqual(["ConfB", "B1"]);
        expect(merged.redBans).toEqual(["ConfR"]);
        expect(merged.bluePicks).toEqual(["ConfP", "P1", "P2"]);
        expect(merged.redPicks).toEqual([]);
    });

    test("does not duplicate when scenario already lists a confirmed champion", () => {
        const scenario = emptyScenario({ bluePicks: ["Shared"] });
        const merged = includeConfirmedDraftState(scenario, {
            blueBans: [],
            redBans: [],
            bluePicks: ["Shared"],
            redPicks: [],
            turnIndex: 0
        });
        expect(merged.bluePicks).toEqual(["Shared"]);
    });
});

describe("includeConfirmedDraftStateForScenarios", () => {
    test("applies the merge to every scenario in the list", () => {
        const scenarios = [
            emptyScenario({ name: "S1", bluePicks: ["A"] }),
            emptyScenario({ name: "S2", bluePicks: ["B"] })
        ];
        const state = {
            blueBans: [],
            redBans: [],
            bluePicks: ["Conf"],
            redPicks: [],
            turnIndex: 0
        };
        const merged = includeConfirmedDraftStateForScenarios(scenarios, state);
        expect(merged.map((s) => s.bluePicks)).toEqual([
            ["Conf", "A"],
            ["Conf", "B"]
        ]);
    });
});
