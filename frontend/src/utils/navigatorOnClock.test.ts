import { expect, test } from "vitest";
import { ON_CLOCK, turnSlotsAt } from "./navigatorOnClock";

test("turnSlotsAt: a pair start lights both slots, a pair end or single turn one, null none", () => {
    expect(turnSlotsAt(7)).toEqual([7, 8]); // Red Pick 1 + 2
    expect(turnSlotsAt(8)).toEqual([8]); // pair-pending: the second half alone
    expect(turnSlotsAt(6)).toEqual([6]);
    expect(turnSlotsAt(0)).toEqual([0]); // a ban
    expect(turnSlotsAt(null)).toEqual([]);
    expect(turnSlotsAt(20)).toEqual([]);
});

test("ON_CLOCK: pale blue-200 / red-200 per side", () => {
    for (const v of Object.values(ON_CLOCK.blue)) expect(v).toContain("blue-200");
    for (const v of Object.values(ON_CLOCK.red)) expect(v).toContain("red-200");
});
