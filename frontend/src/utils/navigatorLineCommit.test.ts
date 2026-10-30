import { describe, expect, test } from "vitest";
import type { NavigatorEventData, NavigatorTreeNode } from "../contexts/NavigatorContext";
import {
    isPersistedEvent,
    lineCommitPlan,
    lineRunNext,
    lineTitle,
    type LineRun,
    type LineStep
} from "./navigatorLineCommit";
import { TURN_SEQUENCE, turnLabelForSlots } from "./turnSequence";

const scores = {
    composite: 0,
    compStrength: 0,
    informationValue: 0,
    flexRetention: 0,
    revealCost: 0
};
function node(
    championIds: string[],
    slots: number[],
    confirmedChampionIds?: string[],
    actionType?: "ban" | "pick"
): NavigatorTreeNode {
    const turn = TURN_SEQUENCE[slots[0]];
    return {
        championIds,
        actionType: actionType ?? turn.type,
        phase: turn.phase,
        scores,
        assignmentDistribution: [],
        side: turn.side,
        slots,
        userInjected: false,
        children: [],
        confirmedChampionIds
    };
}
function event(slot: number, championId: string, id = `e${slot}`): NavigatorEventData {
    const turn = TURN_SEQUENCE[slot];
    return {
        id,
        slot,
        side: turn.side,
        event_type: turn.type,
        champion_id: championId,
        navigator_draft_id: "d",
        user_injected: false,
        createdAt: ""
    };
}
/** Slots 0..count-1 filled with c0, c1, ... */
function confirmedUpTo(count: number): NavigatorEventData[] {
    return Array.from({ length: count }, (_, i) => event(i, `c${i}`));
}
const nameOf = (id: string) => id;

const pairLine = [node(["Jax", "Yasuo"], [7, 8]), node(["Amumu", "Varus"], [9, 10])];
const pairSteps: LineStep[] = [
    { slot: 7, type: "pick", side: "red", championIds: ["Jax", "Yasuo"] },
    { slot: 9, type: "pick", side: "blue", championIds: ["Amumu", "Varus"] }
];
const run = (over: Partial<LineRun> = {}): LineRun => ({
    steps: pairSteps,
    startCount: 7,
    sent: 0,
    confirmed: 0,
    scopeKey: "k",
    ...over
});

describe("lineCommitPlan", () => {
    test("plan: Red pair then Blue pair from slot 7", () => {
        expect(lineCommitPlan(pairLine, confirmedUpTo(7), nameOf)).toEqual({
            ok: true,
            steps: pairSteps
        });
    });
    test("plan: pair-pending first node sends only its added half", () => {
        const confirmed = [...confirmedUpTo(7), event(7, "Jax")];
        const line = [node(["Jax", "Yasuo"], [7, 8], ["Jax"])];
        expect(lineCommitPlan(line, confirmed, nameOf)).toEqual({
            ok: true,
            steps: [{ slot: 8, type: "pick", side: "red", championIds: ["Yasuo"] }]
        });
    });
    test("plan: a line crossing pick1 → ban2", () => {
        const plan = lineCommitPlan(
            [node(["Zed"], [11]), node(["Ahri"], [12])],
            confirmedUpTo(11),
            nameOf
        );
        expect(plan.ok).toBe(true);
        if (plan.ok) {
            expect(plan.steps.map((s) => s.type)).toEqual(["pick", "ban"]);
            expect(plan.steps.map((s) => s.slot)).toEqual([11, 12]);
        }
    });
    test("plan: a taken champion is rejected", () => {
        const plan = lineCommitPlan(
            [node(["Kindred", "Yasuo"], [7, 8])],
            confirmedUpTo(7),
            (id) => (id === "Kindred" ? "Kindred" : id)
        );
        const taken = [...confirmedUpTo(6), event(6, "Kindred")];
        const rejected = lineCommitPlan(
            [node(["Kindred", "Yasuo"], [7, 8])],
            taken,
            nameOf
        );
        expect(plan.ok).toBe(true);
        expect(rejected).toEqual({
            ok: false,
            reason: "Kindred is already picked or banned"
        });
    });
    test("plan: a node whose type disagrees with the slot is rejected", () => {
        const plan = lineCommitPlan(
            [node(["Zed"], [12], undefined, "pick")],
            confirmedUpTo(12),
            nameOf
        );
        expect(plan).toEqual({ ok: false, reason: "slot 12 expects a ban" });
    });
    test("plan: a node with the wrong champion count for its slot is rejected", () => {
        const twoAtSingleSlot = lineCommitPlan(
            [node(["Jax", "Yasuo"], [6])],
            confirmedUpTo(6),
            nameOf
        );
        expect(twoAtSingleSlot).toEqual({
            ok: false,
            reason: "slot 6 expects 1 champion"
        });
        const oneAtPairStart = lineCommitPlan(
            [node(["Jax"], [7])],
            confirmedUpTo(7),
            nameOf
        );
        expect(oneAtPairStart).toEqual({
            ok: false,
            reason: "slot 7 expects 2 champions"
        });
    });
});

describe("lineRunNext", () => {
    test("run: sends step 0 at once", () => {
        expect(lineRunNext(run(), confirmedUpTo(7))).toEqual({
            kind: "send",
            step: 0,
            confirmed: 0
        });
    });
    test("run: waits while step 0 is in flight", () => {
        expect(lineRunNext(run({ sent: 1 }), confirmedUpTo(7))).toEqual({
            kind: "wait",
            confirmed: 0
        });
    });
    test("run: sends step 1 once step 0 is persisted", () => {
        const events = [...confirmedUpTo(7), event(7, "Jax"), event(8, "Yasuo")];
        expect(lineRunNext(run({ sent: 1 }), events)).toEqual({
            kind: "send",
            step: 1,
            confirmed: 1
        });
    });
    test("run: done after the last step", () => {
        const events = [
            ...confirmedUpTo(7),
            event(7, "Jax"),
            event(8, "Yasuo"),
            event(9, "Amumu"),
            event(10, "Varus")
        ];
        expect(lineRunNext(run({ sent: 2, confirmed: 1 }), events)).toEqual({
            kind: "done"
        });
    });
    test("run: waits while only optimistic events cover the step", () => {
        const events = [
            ...confirmedUpTo(7),
            event(7, "Jax", "optimistic-7"),
            event(8, "Yasuo", "optimistic-8")
        ];
        expect(lineRunNext(run({ sent: 1 }), events)).toEqual({
            kind: "wait",
            confirmed: 0
        });
    });
    test("run: another member's pick diverges", () => {
        const events = [
            ...confirmedUpTo(7),
            event(7, "Jax"),
            event(8, "Yasuo"),
            event(9, "Teemo")
        ];
        const action = lineRunNext(run({ sent: 1, confirmed: 1 }), events);
        expect(action.kind).toBe("stop");
        if (action.kind === "stop") {
            expect(action.reason).toBe("diverged");
            expect(action.event?.champion_id).toBe("Teemo");
            expect(action.confirmed).toBe(1);
        }
    });
    test("run: an event after the last step is done, not diverged", () => {
        const events = [
            ...confirmedUpTo(7),
            event(7, "Jax"),
            event(8, "Yasuo"),
            event(9, "Amumu"),
            event(10, "Varus"),
            event(11, "Teemo")
        ];
        expect(lineRunNext(run({ sent: 2, confirmed: 2 }), events)).toEqual({
            kind: "done"
        });
    });
    test("run: a step landing together with a divergence reports the step", () => {
        const events = [
            ...confirmedUpTo(7),
            event(7, "Jax"),
            event(8, "Yasuo"),
            event(9, "Teemo")
        ];
        const action = lineRunNext(run({ sent: 1, confirmed: 0 }), events);
        expect(action).toMatchObject({ kind: "stop", reason: "diverged", confirmed: 1 });
    });
    test("run: undo below the high-water mark stops the run", () => {
        const action = lineRunNext(run({ sent: 2, confirmed: 1 }), confirmedUpTo(7));
        expect(action).toEqual({
            kind: "stop",
            reason: "undone",
            confirmed: 0,
            event: null
        });
    });
    test("run: undo of a landed step stops the run", () => {
        const events = [...confirmedUpTo(7), event(7, "Jax"), event(8, "Yasuo")];
        const action = lineRunNext(run({ sent: 2, confirmed: 2 }), events);
        expect(action).toEqual({
            kind: "stop",
            reason: "undone",
            confirmed: 1,
            event: null
        });
    });
    test("run: a pair step counts as one step only when both halves are in", () => {
        const events = [...confirmedUpTo(7), event(7, "Jax")];
        expect(lineRunNext(run({ sent: 1 }), events)).toEqual({
            kind: "wait",
            confirmed: 0
        });
    });
});

describe("isPersistedEvent", () => {
    test("optimistic ids are not persisted", () => {
        expect(isPersistedEvent(event(7, "Jax", "optimistic-7"))).toBe(false);
        expect(isPersistedEvent(event(7, "Jax", "e7"))).toBe(true);
    });
});

describe("lineTitle", () => {
    test("joins turn labels and names", () => {
        expect(lineTitle(pairLine, nameOf)).toBe(
            `${turnLabelForSlots([7, 8])}: Jax + Yasuo → ${turnLabelForSlots([9, 10])}: Amumu + Varus`
        );
    });
});
