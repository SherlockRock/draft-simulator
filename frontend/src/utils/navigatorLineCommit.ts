import type { NavigatorEventData, NavigatorTreeNode } from "../contexts/NavigatorContext";
import { TURN_SEQUENCE, turnLabelForSlots } from "./turnSequence";

export interface LineStep {
    slot: number;
    type: "pick" | "ban";
    side: "blue" | "red";
    championIds: string[];
}

export type LinePlan = { ok: true; steps: LineStep[] } | { ok: false; reason: string };

/** Plans "take the line": one step per node, each carrying only the champions
 *  the draft does not yet hold (a pair-pending node sends its missing half). */
export function lineCommitPlan(
    line: readonly NavigatorTreeNode[],
    confirmed: readonly NavigatorEventData[],
    nameOf: (id: string) => string
): LinePlan {
    const taken = new Set(confirmed.map((e) => e.champion_id));
    const steps: LineStep[] = [];
    let slot = confirmed.length;
    for (const node of line) {
        const already = new Set(node.confirmedChampionIds ?? []);
        const added = node.championIds.filter((id) => !already.has(id));
        const turn = TURN_SEQUENCE[slot];
        if (!turn)
            return { ok: false, reason: `slot ${slot} is past the end of the draft` };
        if (turn.type !== node.actionType) {
            return { ok: false, reason: `slot ${slot} expects a ${turn.type}` };
        }
        if (node.side !== null && turn.side !== node.side) {
            return { ok: false, reason: `slot ${slot} expects a ${turn.side} turn` };
        }
        const expectedCount = turn.type === "pick" && turn.pairStart ? 2 : 1;
        if (added.length !== expectedCount) {
            return {
                ok: false,
                reason: `slot ${slot} expects ${expectedCount} champion${expectedCount === 1 ? "" : "s"}`
            };
        }
        for (const id of added) {
            if (taken.has(id))
                return { ok: false, reason: `${nameOf(id)} is already picked or banned` };
            taken.add(id);
        }
        steps.push({ slot, type: turn.type, side: turn.side, championIds: added });
        slot += added.length;
    }
    return { ok: true, steps };
}

export interface LineRun {
    steps: LineStep[];
    startCount: number;
    sent: number;
    confirmed: number;
    scopeKey: string;
}

export type LineRunAction =
    | { kind: "send"; step: number; confirmed: number }
    | { kind: "wait"; confirmed: number }
    | { kind: "done" }
    | {
          kind: "stop";
          reason: "undone" | "diverged";
          confirmed: number;
          event: NavigatorEventData | null;
      };

/** Mirrors the synthetic ids NavigatorWorkflow.tsx writes (`optimistic-${slot}`);
 *  not imported because the workflow is not changed in this plan. */
export const OPTIMISTIC_EVENT_PREFIX = "optimistic-";

export function isPersistedEvent(e: NavigatorEventData): boolean {
    return !e.id.startsWith(OPTIMISTIC_EVENT_PREFIX);
}

/** What the runner should do next, decided from the live event list alone.
 *  Does not read `run.scopeKey`: the caller checks scope first. */
export function lineRunNext(
    run: LineRun,
    events: readonly NavigatorEventData[]
): LineRunAction {
    const persisted = events
        .filter(
            (e) =>
                (e.event_type === "ban" || e.event_type === "pick") && isPersistedEvent(e)
        )
        .sort((a, b) => a.slot - b.slot);
    const expected = run.steps.flatMap((step) =>
        step.championIds.map((championId, i) => ({ slot: step.slot + i, championId }))
    );
    if (persisted.length < run.startCount) {
        return { kind: "stop", reason: "undone", confirmed: run.confirmed, event: null };
    }
    const tail = persisted.slice(run.startCount);
    let matched = 0;
    while (
        matched < expected.length &&
        matched < tail.length &&
        tail[matched].slot === expected[matched].slot &&
        tail[matched].champion_id === expected[matched].championId
    ) {
        matched += 1;
    }
    let done = 0;
    let covered = 0;
    for (const step of run.steps) {
        covered += step.championIds.length;
        if (covered <= matched) done += 1;
        else break;
    }
    if (matched < expected.length && matched < tail.length) {
        return {
            kind: "stop",
            reason: "diverged",
            confirmed: done,
            event: tail[matched]
        };
    }
    if (done < run.confirmed)
        return { kind: "stop", reason: "undone", confirmed: done, event: null };
    if (done === run.steps.length) return { kind: "done" };
    if (run.sent > done) return { kind: "wait", confirmed: done };
    return { kind: "send", step: done, confirmed: done };
}

export function lineTitle(
    line: readonly NavigatorTreeNode[],
    nameOf: (id: string) => string
): string {
    return line
        .map(
            (node) =>
                `${turnLabelForSlots(node.slots)}: ${node.championIds.map(nameOf).join(" + ")}`
        )
        .join(" → ");
}
