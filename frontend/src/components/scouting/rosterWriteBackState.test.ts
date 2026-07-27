import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRoot, createSignal, type Setter } from "solid-js";
import type { Team, TeamPlayer } from "@draft-sim/shared-types";
import type { SavePayload } from "../../utils/rosterSaver";
import type { PlayerId } from "../../utils/playerStats";
import {
    createRosterWriteBack,
    type RosterWriteBack,
    type ScoutSide
} from "./rosterWriteBackState";

// The pure helpers (shouldStayArmed, mergeScoutedRoster, createRosterSaver) are
// each covered in their own suites. What is exercised here is their
// COMPOSITION — the decision-26a guard that stops one team's players landing on
// another team's roster, plus the load-window stash/flush around it.

const player = (gameName: string, ordinal: number): TeamPlayer => ({
    id: `p-${gameName}-${ordinal}`,
    team_id: "team-a",
    role: null,
    gameName,
    tagLine: "NA1",
    ordinal
});

const team = (id: string, name: string, names: string[]): Team => ({
    id,
    owner_id: "owner-1",
    name,
    region: "na1",
    TeamPlayers: names.map((n, i) => ({ ...player(n, i), team_id: id }))
});

const id = (gameName: string): PlayerId => ({ gameName, tagLine: "NA1" });

const lineup = (...names: (string | null)[]): (PlayerId | null)[] =>
    names.map((n) => (n === null ? null : id(n)));

type Harness = {
    state: RosterWriteBack;
    saves: { teamId: string; payload: SavePayload }[];
    disarmed: ScoutSide[];
    toasts: { id: string; message: string }[];
    setTeamId: Setter<Record<ScoutSide, string>>;
    setOwnedTeams: Setter<Team[]>;
    setResolved: Setter<boolean>;
    setFailed: Setter<boolean>;
    setSignedIn: Setter<boolean>;
    dispose: () => void;
};

type Options = {
    teamId?: Partial<Record<ScoutSide, string>>;
    ownedTeams?: Team[];
    resolved?: boolean;
    failed?: boolean;
    signedIn?: boolean;
};

const setup = (options: Options = {}): Harness => {
    const saves: { teamId: string; payload: SavePayload }[] = [];
    const disarmed: ScoutSide[] = [];
    const toasts: { id: string; message: string }[] = [];

    return createRoot((dispose) => {
        const [teamId, setTeamId] = createSignal<Record<ScoutSide, string>>({
            you: options.teamId?.you ?? "",
            enemy: options.teamId?.enemy ?? ""
        });
        const [ownedTeams, setOwnedTeams] = createSignal<Team[]>(
            options.ownedTeams ?? []
        );
        const [resolved, setResolved] = createSignal(options.resolved ?? true);
        const [failed, setFailed] = createSignal(options.failed ?? false);
        const [signedIn, setSignedIn] = createSignal(options.signedIn ?? true);

        const state = createRosterWriteBack({
            isSignedIn: signedIn,
            ownedTeams,
            teamsResolved: resolved,
            teamsFailed: failed,
            teamIdFor: (side) => teamId()[side],
            regionFor: (side) => (side === "you" ? "kr" : undefined),
            disarm: (side) => disarmed.push(side),
            saveRoster: (teamId, payload) => {
                saves.push({ teamId, payload });
                return Promise.resolve();
            },
            notifyError: (id, message) => toasts.push({ id, message }),
            delayMs: 500
        });

        return {
            state,
            saves,
            disarmed,
            toasts,
            setTeamId,
            setOwnedTeams,
            setResolved,
            setFailed,
            setSignedIn,
            dispose
        };
    });
};

// The saver debounces; nothing is observable until the window elapses.
const flushDebounce = (): void => {
    vi.advanceTimersByTime(500);
};

const alpha = team("team-a", "Alpha", ["Ann", "Ben", "Cal", "Dot", "Eve"]);
const beta = team("team-b", "Beta", ["Fay", "Gus"]);
// Five starters plus a sub, so the bench half of the payload has something to
// carry.
const gamma = team("team-g", "Gamma", ["Ann", "Ben", "Cal", "Dot", "Eve", "Fay"]);

describe("createRosterWriteBack", () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    describe("arming", () => {
        it("resolves the armed team from the param plus ownership", () => {
            const h = setup({ teamId: { you: "team-a" }, ownedTeams: [alpha, beta] });
            expect(h.state.armedTeam("you")?.name).toBe("Alpha");
            expect(h.state.armedTeam("enemy")).toBeNull();
            h.dispose();
        });

        it("arms nothing for a team the user does not own", () => {
            const h = setup({ teamId: { you: "team-z" }, ownedTeams: [alpha] });
            expect(h.state.armedTeam("you")).toBeNull();
            h.dispose();
        });
    });

    describe("writeBack", () => {
        it("saves the merged roster when the lineup still overlaps the stored one", () => {
            const h = setup({ teamId: { you: "team-a" }, ownedTeams: [alpha] });
            h.state.writeBack("you", lineup("Ann", "Ben", "Cal", "Dot", "Eve"));
            flushDebounce();
            expect(h.saves).toHaveLength(1);
            expect(h.saves[0].teamId).toBe("team-a");
            expect(h.saves[0].payload.players.map((p) => p.role)).toEqual([
                "top",
                "jungle",
                "mid",
                "adc",
                "support"
            ]);
            // Region comes from the RAW param, not a "na1" default (decision 28).
            expect(h.saves[0].payload.region).toBe("kr");
            expect(h.disarmed).toEqual([]);
            expect(h.toasts).toEqual([]);
            h.dispose();
        });

        it("stays armed on a partial overlap, so scouting a sub still saves", () => {
            const h = setup({ teamId: { you: "team-a" }, ownedTeams: [alpha] });
            h.state.writeBack("you", lineup("Ann", "Ben", "Cal", "Dot", "NewSub"));
            flushDebounce();
            expect(h.saves).toHaveLength(1);
            h.dispose();
        });

        // THE corruption guard. Without it, scouting team A, typing team B's
        // Riot IDs and dragging once writes B's players onto A's roster.
        it("refuses to save a lineup with no overlap at all", () => {
            const h = setup({ teamId: { you: "team-a" }, ownedTeams: [alpha] });
            h.state.writeBack("you", lineup("Fay", "Gus", null, null, null));
            flushDebounce();
            expect(h.saves).toEqual([]);
            h.dispose();
        });

        // The caller performs the disarm — the drag gesture is already
        // navigating and must fold it into that one setSearchParams.
        it("tells the user and reports 'disarmed' when it refuses", () => {
            const h = setup({ teamId: { you: "team-a" }, ownedTeams: [alpha] });
            const outcome = h.state.writeBack(
                "you",
                lineup("Fay", "Gus", null, null, null)
            );
            expect(outcome).toBe("disarmed");
            expect(h.toasts).toHaveLength(1);
            expect(h.toasts[0].message).toContain("Alpha");
            h.dispose();
        });

        it("refuses per side, not globally", () => {
            const h = setup({
                teamId: { you: "team-a", enemy: "team-b" },
                ownedTeams: [alpha, beta]
            });
            expect(
                h.state.writeBack("enemy", lineup("Zed", null, null, null, null))
            ).toBe("disarmed");
            expect(h.state.writeBack("you", lineup("Ann", "Ben", null, null, null))).toBe(
                "saved"
            );
            flushDebounce();
            expect(h.saves.map((s) => s.teamId)).toEqual(["team-a"]);
            h.dispose();
        });

        // Carve-out: shouldStayArmed can never overlap an empty roster, so as a
        // write gate it would permanently refuse every save to a team whose
        // roster was emptied in Settings while this tab was open.
        it("does NOT refuse when the stored roster is empty", () => {
            const empty = team("team-c", "Gamma", []);
            const h = setup({ teamId: { you: "team-c" }, ownedTeams: [empty] });
            h.state.writeBack("you", lineup("Ann", "Ben", null, null, null));
            flushDebounce();
            expect(h.saves).toHaveLength(1);
            expect(h.saves[0].payload.players.map((p) => p.gameName)).toEqual([
                "Ann",
                "Ben"
            ]);
            expect(h.disarmed).toEqual([]);
            h.dispose();
        });

        it("treats an absent TeamPlayers array as an empty roster", () => {
            const bare: Team = {
                id: "team-d",
                owner_id: "owner-1",
                name: "Delta",
                region: "na1"
            };
            const h = setup({ teamId: { you: "team-d" }, ownedTeams: [bare] });
            h.state.writeBack("you", lineup("Ann", null, null, null, null));
            flushDebounce();
            expect(h.saves).toHaveLength(1);
            h.dispose();
        });

        it("sends nothing and toasts once when the merge would exceed the cap", () => {
            const full = team("team-e", "Epsilon", [
                "R1",
                "R2",
                "R3",
                "R4",
                "R5",
                "R6",
                "R7",
                "R8",
                "R9",
                "R10"
            ]);
            const h = setup({ teamId: { you: "team-e" }, ownedTeams: [full] });
            h.state.writeBack("you", lineup("R1", "New1", "New2", null, null));
            h.state.writeBack("you", lineup("R1", "New1", "New2", null, null));
            flushDebounce();
            expect(h.saves).toEqual([]);
            // Same stable id both times, so the toast replaces rather than stacks.
            expect(h.toasts).toHaveLength(2);
            expect(new Set(h.toasts.map((t) => t.id)).size).toBe(1);
            h.dispose();
        });

        it("sends the URL bench alongside the slots", () => {
            const h = setup({ teamId: { you: "team-g" }, ownedTeams: [gamma] });
            h.state.writeBack("you", lineup("Ann", "Ben", "Cal", "Dot", "Eve"), [
                id("Fay")
            ]);
            flushDebounce();
            expect(h.saves[0].payload.players).toEqual([
                { role: "top", gameName: "Ann", tagLine: "NA1" },
                { role: "jungle", gameName: "Ben", tagLine: "NA1" },
                { role: "mid", gameName: "Cal", tagLine: "NA1" },
                { role: "adc", gameName: "Dot", tagLine: "NA1" },
                { role: "support", gameName: "Eve", tagLine: "NA1" },
                { role: null, gameName: "Fay", tagLine: "NA1" }
            ]);
            h.dispose();
        });

        // A legacy link carries no bench, and that must not delete the stored
        // one — the union re-appends it.
        it("keeps the stored bench when the URL carries none", () => {
            const h = setup({ teamId: { you: "team-g" }, ownedTeams: [gamma] });
            h.state.writeBack("you", lineup("Ann", "Ben", "Cal", "Dot", "Eve"));
            flushDebounce();
            expect(h.saves[0].payload.players).toContainEqual({
                role: null,
                gameName: "Fay",
                tagLine: "NA1"
            });
            h.dispose();
        });

        it("does nothing when no team param is set", () => {
            const h = setup({ ownedTeams: [alpha] });
            expect(h.state.writeBack("you", lineup("Ann", "Ben", null, null, null))).toBe(
                "inert"
            );
            flushDebounce();
            expect(h.saves).toEqual([]);
            expect(h.disarmed).toEqual([]);
            h.dispose();
        });

        it("reports 'over-cap' without touching the arming", () => {
            const full = team("team-f", "Zeta", [
                "S1",
                "S2",
                "S3",
                "S4",
                "S5",
                "S6",
                "S7",
                "S8",
                "S9",
                "S10"
            ]);
            const h = setup({ teamId: { you: "team-f" }, ownedTeams: [full] });
            expect(h.state.writeBack("you", lineup("S1", "New1", null, null, null))).toBe(
                "over-cap"
            );
            expect(h.disarmed).toEqual([]);
            h.dispose();
        });
    });

    describe("load-window stash and flush", () => {
        it("stashes a gesture made before ['teams'] resolves, then flushes it", () => {
            const h = setup({
                teamId: { you: "team-a" },
                ownedTeams: [],
                resolved: false
            });
            expect(h.state.writeBack("you", lineup("Ann", "Ben", null, null, null))).toBe(
                "stashed"
            );
            flushDebounce();
            expect(h.saves).toEqual([]);

            h.setOwnedTeams([alpha]);
            h.setResolved(true);
            flushDebounce();
            expect(h.saves).toHaveLength(1);
            expect(h.saves[0].teamId).toBe("team-a");
            h.dispose();
        });

        // The bench is stashed for the same reason the teamId is: re-reading it
        // from the URL at flush time would commit whatever the normalization
        // effect wrote in the meantime, which is the closest that effect ever
        // gets to the database.
        it("replays the bench the gesture was made with", () => {
            const h = setup({
                teamId: { you: "team-g" },
                ownedTeams: [],
                resolved: false
            });
            expect(
                h.state.writeBack("you", lineup("Ann", "Ben", null, null, null), [
                    id("Fay")
                ])
            ).toBe("stashed");

            h.setOwnedTeams([gamma]);
            h.setResolved(true);
            flushDebounce();

            expect(h.saves).toHaveLength(1);
            expect(h.saves[0].payload.players).toEqual([
                { role: "top", gameName: "Ann", tagLine: "NA1" },
                { role: "jungle", gameName: "Ben", tagLine: "NA1" },
                { role: null, gameName: "Fay", tagLine: "NA1" },
                { role: null, gameName: "Cal", tagLine: "NA1" },
                { role: null, gameName: "Dot", tagLine: "NA1" },
                { role: null, gameName: "Eve", tagLine: "NA1" }
            ]);
            h.dispose();
        });

        // The stashed teamId is the one from the drag, NOT re-read at flush
        // time: replaying it against whatever the URL names now is exactly the
        // cross-team write this whole guard exists to prevent.
        it("DROPS a stashed gesture when the team id changed before the flush", () => {
            const h = setup({
                teamId: { you: "team-a" },
                ownedTeams: [],
                resolved: false
            });
            h.state.writeBack("you", lineup("Ann", "Ben", null, null, null));

            h.setTeamId({ you: "team-b", enemy: "" });
            h.setOwnedTeams([alpha, beta]);
            h.setResolved(true);
            flushDebounce();
            expect(h.saves).toEqual([]);

            // Truly discarded, not merely deferred: pointing the URL back at
            // the original team must not resurrect it either.
            h.setTeamId({ you: "team-a", enemy: "" });
            flushDebounce();
            expect(h.saves).toEqual([]);
            h.dispose();
        });

        it("still applies the corruption guard to a flushed gesture", () => {
            const h = setup({
                teamId: { you: "team-a" },
                ownedTeams: [],
                resolved: false
            });
            h.state.writeBack("you", lineup("Fay", "Gus", null, null, null));

            h.setOwnedTeams([alpha]);
            h.setResolved(true);
            flushDebounce();
            expect(h.saves).toEqual([]);
            expect(h.disarmed).toEqual(["you"]);
            h.dispose();
        });

        it("drops the stashed gesture when the lookup fails", () => {
            const h = setup({
                teamId: { you: "team-a" },
                ownedTeams: [],
                resolved: false
            });
            h.state.writeBack("you", lineup("Ann", "Ben", null, null, null));

            h.setFailed(true);
            // Even a later success must not resurrect it.
            h.setFailed(false);
            h.setOwnedTeams([alpha]);
            h.setResolved(true);
            flushDebounce();
            expect(h.saves).toEqual([]);
            h.dispose();
        });

        // A disabled TanStack v5 query stays "pending" forever for an anonymous
        // visitor, so stashing must key off sign-in, not off "not yet resolved".
        it("discards rather than stashes a gesture from a signed-out visitor", () => {
            const h = setup({
                teamId: { you: "team-a" },
                ownedTeams: [],
                resolved: false,
                signedIn: false
            });
            h.state.writeBack("you", lineup("Ann", "Ben", null, null, null));

            h.setSignedIn(true);
            h.setOwnedTeams([alpha]);
            h.setResolved(true);
            flushDebounce();
            expect(h.saves).toEqual([]);
            h.dispose();
        });

        it("does not stash when the team simply is not owned", () => {
            const h = setup({ teamId: { you: "team-z" }, ownedTeams: [alpha] });
            h.state.writeBack("you", lineup("Ann", "Ben", null, null, null));

            h.setOwnedTeams([alpha, team("team-z", "Zeta", ["Ann"])]);
            flushDebounce();
            expect(h.saves).toEqual([]);
            h.dispose();
        });
    });

    describe("shouldKeepTeamParam (submit-time polarity)", () => {
        it("preserves the param while ['teams'] has not succeeded", () => {
            const h = setup({
                teamId: { you: "team-a" },
                ownedTeams: [],
                resolved: false
            });
            // No overlap is even computable yet — disarming here out of pure
            // ignorance turned auto-save off for the whole session.
            expect(h.state.shouldKeepTeamParam("you", [id("Fay"), id("Gus")])).toBe(true);
            h.dispose();
        });

        it("deletes the param once resolved and the overlap fails", () => {
            const h = setup({ teamId: { you: "team-a" }, ownedTeams: [alpha] });
            expect(h.state.shouldKeepTeamParam("you", [id("Fay"), id("Gus")])).toBe(
                false
            );
            h.dispose();
        });

        it("keeps the param when at least one submitted player is on the roster", () => {
            const h = setup({ teamId: { you: "team-a" }, ownedTeams: [alpha] });
            expect(h.state.shouldKeepTeamParam("you", [id("Ann"), id("NewSub")])).toBe(
                true
            );
            h.dispose();
        });

        it("deletes the param for a side that submits no players", () => {
            const h = setup({
                teamId: { you: "team-a" },
                ownedTeams: [],
                resolved: false
            });
            expect(h.state.shouldKeepTeamParam("enemy", [])).toBe(false);
            h.dispose();
        });
    });

    describe("saved marker", () => {
        it("marks the saved team, then clears it", async () => {
            const h = setup({ teamId: { you: "team-a" }, ownedTeams: [alpha] });
            h.state.writeBack("you", lineup("Ann", "Ben", null, null, null));
            flushDebounce();
            await vi.advanceTimersByTimeAsync(0);
            expect([...h.state.savedTeams()]).toEqual(["team-a"]);

            await vi.advanceTimersByTimeAsync(2000);
            expect([...h.state.savedTeams()]).toEqual([]);
            h.dispose();
        });
    });

    describe("teardown", () => {
        it("flushes a debounced-but-unsent gesture when the view goes away", () => {
            const h = setup({ teamId: { you: "team-a" }, ownedTeams: [alpha] });
            h.state.writeBack("you", lineup("Ann", "Ben", null, null, null));
            h.dispose();
            expect(h.saves).toHaveLength(1);
        });
    });
});
