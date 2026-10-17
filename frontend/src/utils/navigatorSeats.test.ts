import { describe, expect, test, vi } from "vitest";
import type { Role } from "@draft-sim/shared-types";
import type {
    NavigatorRoleAssignment,
    NavigatorWeightedAssignment
} from "../contexts/NavigatorContext";

// Every expectation below was computed on the FROZEN 2026-10-10 table with the D8 rule
// (max(share, 0.001) / max(shares), P(5, n) enumeration, normalised) on 2026-10-16; the live
// champions.json follows the latest patch, so the test reads the frozen copy (design § 11,
// memory project_champion_meta_positions_refresh).
vi.mock("../data/champions.json", async () => ({
    default: (await import("./__fixtures__/champions-2026-10-10-shares.json")).default
}));
import item4 from "./__fixtures__/navigator-item4-shares-snapshot.json";
import item5 from "./__fixtures__/navigator-item5-shares-snapshot.json";
import { ROLES } from "./championRoles";
import {
    bestPlayableSeat,
    decisiveMoves,
    infeasibleSummary,
    likelyRolesNote,
    ringGradient,
    ringTitle,
    seatMarginals,
    seatMoves,
    seatPlan,
    topSeating,
    type RoleDist,
    type Seating
} from "./navigatorSeats";

const RED_TOUR = ["Sejuani", "Sylas", "Lissandra", "Tristana"];
const BLUE_TOUR = ["Gragas", "Hecarim", "Akali", "Xayah", "Shen"];
const RED_ITEM4 = ["Ornn", "Sylas", "TwistedFate", "Ezreal"];
const BLUE_ITEM4 = ["Camille", "Elise", "Mel", "Xayah", "Sona"];
const KEY: Record<Role, keyof NavigatorRoleAssignment> = {
    top: "TOP",
    jungle: "JUNGLE",
    mid: "MIDDLE",
    adc: "ADC",
    support: "SUPPORT"
};

/** The marginals the ENGINE's weights imply — summed over the wire's assignments. */
function wireMarginals(
    wire: readonly NavigatorWeightedAssignment[]
): Map<string, Record<string, number>> {
    const out = new Map<string, Record<string, number>>();
    for (const w of wire) {
        for (const role of ROLES) {
            const id = w.assignment[KEY[role]];
            if (id === "") continue;
            const dist = out.get(id) ?? { top: 0, jungle: 0, mid: 0, adc: 0, support: 0 };
            dist[role] += w.weight;
            out.set(id, dist);
        }
    }
    return out;
}
const seatOf = (seating: Record<string, string | null>, id: string): string | null =>
    ROLES.find((r) => seating[r] === id) ?? null;

describe("seatMarginals — one champion's five numbers sum to 1, one seat's sum ≤ 1", () => {
    test("Jinx + Ashe", () => {
        const m = seatMarginals(["Jinx", "Ashe"]);
        const jinx = m.get("Jinx");
        const ashe = m.get("Ashe");
        expect(jinx).toBeDefined();
        expect(ashe).toBeDefined();
        if (!jinx || !ashe) return;
        expect(ROLES.reduce((s, r) => s + jinx[r], 0)).toBeCloseTo(1, 9);
        expect(ROLES.reduce((s, r) => s + ashe[r], 0)).toBeCloseTo(1, 9);
        expect(jinx.adc).toBeCloseTo(0.951, 2);
        expect(ashe.support).toBeCloseTo(0.715, 2);
        expect(ashe.top).toBeCloseTo(0.113, 2);
        for (const role of ROLES)
            expect(jinx[role] + ashe[role]).toBeLessThanOrEqual(1 + 1e-9);
        expect(jinx.adc + ashe.adc).toBeCloseTo(0.997, 2);
    });
    test("pins to the engine-emitted weights of the item5 and item4 captures (both sides, every scenario)", () => {
        const cases: { ids: string[]; wire: NavigatorWeightedAssignment[] }[] = [];
        for (const s of item5.scenarios) {
            cases.push({
                ids: [...RED_TOUR, ...s.redPicks],
                wire: s.redLikelyAssignments
            });
            cases.push({
                ids: [...BLUE_TOUR, ...s.bluePicks],
                wire: s.blueLikelyAssignments
            });
        }
        for (const s of item4.scenarios) {
            cases.push({
                ids: [...RED_ITEM4, ...s.redPicks],
                wire: s.redLikelyAssignments
            });
            cases.push({
                ids: [...BLUE_ITEM4, ...s.bluePicks],
                wire: s.blueLikelyAssignments
            });
        }
        expect(cases).toHaveLength(20);
        for (const { ids, wire } of cases) {
            const mine = seatMarginals(ids);
            const theirs = wireMarginals(wire);
            for (const id of ids) {
                const a = mine.get(id);
                const b = theirs.get(id);
                expect(a, id).toBeDefined();
                expect(b, id).toBeDefined();
                if (!a || !b) continue;
                for (const role of ROLES)
                    expect(Math.abs(a[role] - b[role]), `${id}/${role}`).toBeLessThan(
                        1e-9
                    );
            }
            // topSeating = the max-weight entry of the wire (first max on ties).
            let best = wire[0];
            for (const w of wire) if (w.weight > best.weight) best = w;
            const seating = topSeating(ids);
            expect(seating).not.toBeNull();
            if (!seating) continue;
            for (const role of ROLES)
                expect(seating[role] ?? "", `${ids.join("+")}/${role}`).toBe(
                    best.assignment[KEY[role]]
                );
        }
    });
});

describe("topSeating", () => {
    test("Jinx + Ashe: Jinx adc, Ashe support, three open", () => {
        expect(topSeating(["Jinx", "Ashe"])).toEqual({
            top: null,
            jungle: null,
            mid: null,
            adc: "Jinx",
            support: "Ashe"
        });
    });
    test("no champions, or more than five, is null", () => {
        expect(topSeating([])).toBeNull();
        expect(
            topSeating(["Jinx", "Ashe", "Swain", "Brand", "Poppy", "Neeko"])
        ).toBeNull();
    });
});

describe("seatMoves — decisive only (old seat ≥ 0.50 before AND new seat ≥ 0.50 after)", () => {
    test("Ashe + Aurelion Sol → + Aphelios: Ashe adc → support (0.900 → 0.766)", () => {
        expect(
            seatMoves(["Ashe", "AurelionSol"], ["Ashe", "AurelionSol", "Aphelios"])
        ).toEqual([{ championId: "Ashe", from: "adc", to: "support" }]);
    });
    test("Poppy + Tahm Kench → + Neeko: nothing (no top seat changes on this table)", () => {
        expect(
            seatMoves(["Poppy", "TahmKench"], ["Poppy", "TahmKench", "Neeko"])
        ).toEqual([]);
    });
    test("Diana + Ekko → + Nidalee: Ekko's top seat DOES change (jungle → top) but his old marginal is 0.469 — not a move", () => {
        const before = topSeating(["Diana", "Ekko"]);
        const after = topSeating(["Diana", "Ekko", "Nidalee"]);
        expect(before && seatOf(before, "Ekko")).toBe("jungle");
        expect(after && seatOf(after, "Ekko")).toBe("top");
        expect(seatMarginals(["Diana", "Ekko"]).get("Ekko")?.jungle).toBeCloseTo(
            0.469,
            2
        );
        expect(seatMoves(["Diana", "Ekko"], ["Diana", "Ekko", "Nidalee"])).toEqual([]);
    });
    test("decisiveMoves needs BOTH thresholds (synthetic marginals: one-sided rules must not fire)", () => {
        const zero: RoleDist = { top: 0, jungle: 0, mid: 0, adc: 0, support: 0 };
        const prev: Seating = {
            top: null,
            jungle: null,
            mid: null,
            adc: "A",
            support: null
        };
        const next: Seating = {
            top: null,
            jungle: null,
            mid: null,
            adc: null,
            support: "A"
        };
        const m = (adc: number, support: number) =>
            new Map([["A", { ...zero, adc, support }]]);
        expect(decisiveMoves(["A"], prev, next, m(0.9, 0), m(0, 0.9))).toEqual([
            { championId: "A", from: "adc", to: "support" }
        ]);
        expect(decisiveMoves(["A"], prev, next, m(0.9, 0), m(0, 0.3))).toEqual([]); // old certain, new not
        expect(decisiveMoves(["A"], prev, next, m(0.3, 0), m(0, 0.9))).toEqual([]); // new certain, old not
        expect(decisiveMoves(["A"], prev, prev, m(0.9, 0), m(0.9, 0))).toEqual([]); // no seat change
        expect(decisiveMoves(["A"], prev, next, m(0.5, 0), m(0, 0.5))).toHaveLength(1); // the thresholds are inclusive (≥)
    });
});

describe("bestPlayableSeat — the largest share among the playable roles", () => {
    test("Jinx and Aphelios adc; Yone top (0.505 over mid 0.467); an unknown id falls back to top", () => {
        expect(bestPlayableSeat("Jinx")).toBe("adc");
        expect(bestPlayableSeat("Aphelios")).toBe("adc");
        expect(bestPlayableSeat("Yone")).toBe("top");
        expect(bestPlayableSeat("Nobody")).toBe("top");
    });
});

describe("seatPlan — the renderer's input (design § 2 rule table)", () => {
    const byRole = (plan: ReturnType<typeof seatPlan>) =>
        Object.fromEntries(plan.seats.map((s) => [s.role, s]));
    test("feasible: one champion per seat, the candidate marked sky, holes open", () => {
        const plan = seatPlan({ ids: ["Jinx", "Ashe"], candidateIds: ["Ashe"] });
        expect(plan.infeasible).toBe(false);
        const s = byRole(plan);
        expect(s.adc).toMatchObject({ occupant: "Jinx", count: 1, marker: "none" });
        expect(s.support).toMatchObject({
            occupant: "Ashe",
            count: 1,
            marker: "candidate"
        });
        expect(s.top).toMatchObject({
            occupant: null,
            count: 0,
            marker: "none",
            dist: null
        });
        expect(s.support.dist?.support).toBeCloseTo(0.715, 2);
        expect(plan.seats.map((x) => x.role)).toEqual(ROLES);
    });
    test("moved: Aphelios as the candidate moves Ashe to support — amber on Ashe, sky on Aphelios", () => {
        const s = byRole(
            seatPlan({
                ids: ["Ashe", "AurelionSol", "Aphelios"],
                candidateIds: ["Aphelios"]
            })
        );
        expect(s.support).toMatchObject({ occupant: "Ashe", marker: "moved" });
        expect(s.adc).toMatchObject({ occupant: "Aphelios", marker: "candidate" });
        expect(s.mid).toMatchObject({ occupant: "AurelionSol", marker: "none" });
    });
    test("beforeIds overrides the baseline: with Aphelios already counted as before, nothing moved", () => {
        const s = byRole(
            seatPlan({
                ids: ["Ashe", "AurelionSol", "Aphelios"],
                candidateIds: [],
                beforeIds: ["Ashe", "AurelionSol", "Aphelios"]
            })
        );
        expect(s.support).toMatchObject({ occupant: "Ashe", marker: "none" });
    });
    test("infeasible: Jinx + Aphelios both at their best playable seat, count 2, every occupied seat red, no ring", () => {
        const plan = seatPlan({ ids: ["Jinx", "Aphelios"] });
        expect(plan.infeasible).toBe(true);
        const s = byRole(plan);
        expect(s.adc).toMatchObject({
            occupant: "Jinx",
            count: 2,
            marker: "infeasible",
            dist: null
        });
        expect(s.top).toMatchObject({ occupant: null, count: 0, marker: "none" });
        expect(s.mid.count + s.jungle.count + s.support.count).toBe(0);
    });
    test("denyMode (a ban row, plan-level decision 15): feasibility from beforeIds; the banned champion overlaid at its best playable seat with the sky marker and a count; the row never flips red", () => {
        const deny = seatPlan({
            ids: ["Gragas", "Hecarim", "Akali", "Xayah", "Jinx"],
            candidateIds: ["Jinx"],
            denyMode: true
        });
        expect(deny.infeasible).toBe(false);
        const d = byRole(deny);
        expect(d.adc).toMatchObject({ occupant: "Jinx", count: 2, marker: "candidate" });
        expect(d.adc.dist?.adc).toBeCloseTo(0.996, 2); // the candidate's own spread, not the team's
        expect(d.top).toMatchObject({ occupant: "Gragas", count: 1, marker: "none" });
        expect(d.support).toMatchObject({ occupant: null });
        const open = byRole(
            seatPlan({
                ids: ["Gragas", "Hecarim", "Akali", "Caitlyn"],
                candidateIds: ["Caitlyn"],
                denyMode: true
            })
        );
        expect(open.adc).toMatchObject({
            occupant: "Caitlyn",
            count: 1,
            marker: "candidate"
        }); // feasible: the ordinary branch
        // Without denyMode the same five are an infeasible set (the pick-row semantics).
        expect(
            seatPlan({
                ids: ["Gragas", "Hecarim", "Akali", "Xayah", "Jinx"],
                candidateIds: ["Jinx"]
            }).infeasible
        ).toBe(true);
        // A beforeIds that already names the candidate must not count it twice (Codex r2 finding 1).
        const overlap = byRole(
            seatPlan({
                ids: ["Gragas", "Hecarim", "Akali", "Xayah", "Jinx"],
                candidateIds: ["Jinx"],
                beforeIds: ["Gragas", "Hecarim", "Akali", "Xayah", "Jinx"],
                denyMode: true
            })
        );
        expect(overlap.adc).toMatchObject({
            occupant: "Jinx",
            count: 2,
            marker: "candidate"
        });
        // denyMode on a FEASIBLE set takes the ordinary team-aware path (never "always overlay at the best playable seat").
        const feasible = byRole(
            seatPlan({ ids: ["Jinx", "Ashe"], candidateIds: ["Ashe"], denyMode: true })
        );
        expect(feasible.support).toMatchObject({
            occupant: "Ashe",
            count: 1,
            marker: "candidate"
        });
        expect(feasible.adc).toMatchObject({ occupant: "Jinx", count: 1 });
        // The opponent's own picks already infeasible: the row is red from the base and the banned champion is
        // overlaid on the collided seat (decision 15 documents this; the displaced occupants sit behind the count).
        const broken = seatPlan({
            ids: ["Jinx", "Aphelios", "Caitlyn"],
            candidateIds: ["Caitlyn"],
            denyMode: true
        });
        expect(broken.infeasible).toBe(true);
        expect(byRole(broken).adc).toMatchObject({
            occupant: "Caitlyn",
            count: 3,
            marker: "candidate"
        });
    });
    test("degenerate inputs: no ids → five holes; six ids → five holes; duplicates are one champion; an unknown id sits at top, infeasible", () => {
        const empty = seatPlan({ ids: [] });
        expect(empty.infeasible).toBe(false);
        expect(empty.seats.every((s) => s.occupant === null && s.count === 0)).toBe(true);
        const six = seatPlan({
            ids: ["Jinx", "Ashe", "Swain", "Brand", "Poppy", "Neeko"]
        });
        expect(six.seats.every((s) => s.occupant === null)).toBe(true);
        expect(six.infeasible).toBe(false);
        const dup = seatPlan({ ids: ["Jinx", "Jinx", "Ashe"] });
        expect(dup.ids).toEqual(["Jinx", "Ashe"]);
        expect(byRole(dup).support.occupant).toBe("Ashe");
        const unknown = seatPlan({ ids: ["Nobody"] });
        expect(unknown.infeasible).toBe(true);
        expect(byRole(unknown).top).toMatchObject({
            occupant: "Nobody",
            count: 1,
            marker: "infeasible"
        });
    });
});

describe("ringGradient / ringTitle / likelyRolesNote / infeasibleSummary", () => {
    test("Brand alone: five arcs in ROLES order, 1-dp stops", () => {
        const dist = seatMarginals(["Brand"]).get("Brand");
        expect(dist).toBeDefined();
        if (!dist) return;
        expect(ringGradient(dist)).toBe(
            "conic-gradient(#f87171 0.0% 8.7%, #34d399 8.7% 17.0%, #60a5fa 17.0% 34.0%, #fbbf24 34.0% 57.1%, #c084fc 57.1% 100.0%)"
        );
        expect(ringTitle("Brand", dist)).toBe(
            "Brand: sup 43%, adc 23%, mid 17%, top 9%, jg 8%"
        );
        expect(likelyRolesNote(dist)).toBe("Sup 43% · ADC 23%");
    });
    test("arcs below 0.5% are skipped; an all-zero dist is no gradient", () => {
        const jinx = seatMarginals(["Jinx"]).get("Jinx");
        expect(jinx && ringGradient(jinx)).toBe("conic-gradient(#fbbf24 0.0% 99.6%)");
        expect(ringGradient({ top: 0, jungle: 0, mid: 0, adc: 0, support: 0 })).toBe("");
    });
    test("the note: two most likely roles ≥ 10%, ties by ROLES order (Ashe top = mid at Jinx + Ashe → Top)", () => {
        const m = seatMarginals(["Jinx", "Ashe"]);
        expect(
            likelyRolesNote(
                m.get("Jinx") ?? { top: 0, jungle: 0, mid: 0, adc: 0, support: 0 }
            )
        ).toBe("ADC 95%");
        expect(
            likelyRolesNote(
                m.get("Ashe") ?? { top: 0, jungle: 0, mid: 0, adc: 0, support: 0 }
            )
        ).toBe("Sup 72% · Top 11%");
    });
    test("infeasibleSummary names the picks", () => {
        expect(infeasibleSummary(["Jinx", "Aphelios"], (id) => id)).toBe(
            "✕ cannot fill five roles with Jinx, Aphelios"
        );
    });
});
