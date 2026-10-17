// @vitest-environment jsdom
import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import type { NavigatorEventData } from "../../contexts/NavigatorContext";
import { TURN_SEQUENCE } from "../../utils/turnSequence";
import { DraftOrderTicks } from "./DraftOrderTicks";
import { NavigatorTeamColumn } from "./NavigatorTeamColumn";

vi.mock("../../data/champions.json", async () => ({
    default: (await import("../../utils/__fixtures__/champions-2026-10-10-shares.json"))
        .default
}));

afterEach(cleanup);

function events(order: string[]): NavigatorEventData[] {
    return order.map((champion_id, slot) => ({
        id: `e${slot}`,
        navigator_draft_id: "d",
        event_type: TURN_SEQUENCE[slot].type,
        slot,
        side: TURN_SEQUENCE[slot].side,
        champion_id,
        user_injected: false,
        createdAt: new Date(1700000000000 + slot).toISOString()
    }));
}
// The lobby mockup's state: Red Pick 3 next (slot 11) with Jinx + Ashe on red, Gragas + Hecarim + Akali on blue.
const BANS = ["Caitlyn", "Twitch", "Draven", "Jhin", "Zeri", "Kaisa"];
const RED_PICK_3 = [...BANS, "Gragas", "Jinx", "Ashe", "Hecarim", "Akali"];
const FULL = [
    ...BANS,
    "Gragas",
    "Jinx",
    "Ashe",
    "Hecarim",
    "Akali",
    "Lissandra",
    "Sivir",
    "Aphelios",
    "Ezreal",
    "Xayah",
    "Sejuani",
    "Shen",
    "Taric",
    "Pantheon"
];

function column(
    side: "blue" | "red",
    order: string[],
    overrides: Partial<Parameters<typeof NavigatorTeamColumn>[0]> = {}
) {
    const onPickNow = vi.fn();
    const utils = render(() => (
        <NavigatorTeamColumn
            side={side}
            events={events(order)}
            ourSide="red"
            nextSlot={order.length < 20 ? order.length : null}
            active={true}
            onPickNow={onPickNow}
            {...overrides}
        />
    ));
    return { ...utils, onPickNow };
}
const rows = (c: ParentNode) =>
    Array.from(c.querySelectorAll("[data-pick-row]")).map((r) =>
        r.getAttribute("data-pick-row")
    );

describe("NavigatorTeamColumn (design § 3)", () => {
    test("red at Red Pick 3: R1 Jinx, R2 Ashe with their notes, R3 glowing and clickable, R4/R5 empty, bans in draft order, summary Jinx adc / Ashe support", () => {
        const { container, onPickNow } = column("red", RED_PICK_3);
        expect(
            container
                .querySelector("[data-team-column='red']")
                ?.getAttribute("data-on-clock")
        ).toBe("true");
        expect(container.textContent).toContain("on the clock · you");
        expect(rows(container)).toEqual(["R1", "R2", "R3", "R4", "R5"]);
        const r1 = container.querySelector("[data-pick-row='R1']");
        expect(r1?.getAttribute("data-filled")).toBe("true");
        expect(r1?.getAttribute("data-slot")).toBe("7");
        expect(r1?.querySelector("[data-seat-ring]")?.getAttribute("data-champion")).toBe(
            "Jinx"
        );
        expect(r1?.querySelector("[data-pick-note]")?.textContent).toBe("ADC 95%");
        expect(
            container.querySelector("[data-pick-row='R2'] [data-pick-note]")?.textContent
        ).toBe("Sup 72% · Top 11%");
        const r3 = container.querySelector("[data-pick-row='R3']");
        expect(r3?.tagName).toBe("BUTTON");
        expect(r3?.getAttribute("data-next-slot")).toBe("true");
        expect(r3?.getAttribute("data-glow")).toBe("true");
        expect(r3?.getAttribute("data-slot")).toBe("11");
        expect(r3?.textContent).toContain("R3 — pick now");
        if (r3) fireEvent.click(r3);
        expect(onPickNow).toHaveBeenCalledTimes(1);
        expect(
            container.querySelector("[data-pick-row='R4']")?.getAttribute("data-filled")
        ).toBe("false");
        expect(container.querySelectorAll("[data-glow='true']")).toHaveLength(1);
        const bans = Array.from(container.querySelectorAll("[data-ban-slot]"));
        expect(bans.map((b) => b.getAttribute("data-ban-slot"))).toEqual([
            "1",
            "3",
            "5",
            "12",
            "14"
        ]);
        expect(bans.map((b) => b.getAttribute("data-filled"))).toEqual([
            "true",
            "true",
            "true",
            "false",
            "false"
        ]);
        expect(bans[1].getAttribute("title")).toBe("Red Ban 2: Jhin");
        const summary = container.querySelector("[data-roles-summary='red']");
        expect(
            summary?.querySelector("[data-seat='adc']")?.getAttribute("data-occupant")
        ).toBe("Jinx");
        expect(
            summary?.querySelector("[data-seat='support']")?.getAttribute("data-occupant")
        ).toBe("Ashe");
        expect(summary?.querySelectorAll("[data-open='true']")).toHaveLength(3);
    });
    test("blue at Red Pick 3: three filled rows, no glow, not on the clock, bans at 0/2/4/13/15", () => {
        const { container } = column("blue", RED_PICK_3);
        expect(
            container
                .querySelector("[data-team-column='blue']")
                ?.getAttribute("data-on-clock")
        ).toBe("false");
        expect(rows(container)).toEqual(["B1", "B2", "B3", "B4", "B5"]);
        expect(
            container.querySelectorAll("[data-pick-row][data-filled='true']")
        ).toHaveLength(3);
        expect(container.querySelector("[data-glow='true']")).toBeNull();
        expect(container.querySelector("[data-next-slot='true']")).toBeNull();
        expect(
            Array.from(container.querySelectorAll("[data-ban-slot]")).map((b) =>
                b.getAttribute("data-ban-slot")
            )
        ).toEqual(["0", "2", "4", "13", "15"]);
        expect(
            container
                .querySelector("[data-roles-summary='blue'] [data-seat='top']")
                ?.getAttribute("data-occupant")
        ).toBe("Gragas");
    });
    test("a fresh pair turn glows both rows; data-next-slot lands on the first", () => {
        const { container } = column("blue", [...BANS, "Gragas", "Jinx", "Ashe"]); // next = slot 9, Blue Pick 2 + 3
        const glowing = Array.from(container.querySelectorAll("[data-glow='true']")).map(
            (r) => r.getAttribute("data-pick-row")
        );
        expect(glowing).toEqual(["B2", "B3"]);
        expect(
            container
                .querySelector("[data-pick-row='B2']")
                ?.getAttribute("data-next-slot")
        ).toBe("true");
        expect(
            container
                .querySelector("[data-pick-row='B3']")
                ?.hasAttribute("data-next-slot")
        ).toBe(false);
    });
    test("pair-pending glows one row: B2 confirmed, only B3 glows", () => {
        const { container } = column("blue", [
            ...BANS,
            "Gragas",
            "Jinx",
            "Ashe",
            "Hecarim"
        ]); // next = slot 10
        expect(
            container.querySelector("[data-pick-row='B2']")?.getAttribute("data-filled")
        ).toBe("true");
        expect(
            Array.from(container.querySelectorAll("[data-glow='true']")).map((r) =>
                r.getAttribute("data-pick-row")
            )
        ).toEqual(["B3"]);
        expect(
            container
                .querySelector("[data-pick-row='B3']")
                ?.getAttribute("data-next-slot")
        ).toBe("true");
    });
    test("a ban turn: no row glows on either side; the banning side is on the clock; empty boards show five holes", () => {
        const blue = column("blue", []); // next = slot 0, Blue Ban 1
        expect(blue.container.querySelector("[data-glow='true']")).toBeNull();
        expect(
            blue.container
                .querySelector("[data-team-column='blue']")
                ?.getAttribute("data-on-clock")
        ).toBe("true");
        expect(
            blue.container.querySelectorAll(
                "[data-roles-summary='blue'] [data-open='true']"
            )
        ).toHaveLength(5);
        cleanup();
        const red = column("red", []);
        expect(
            red.container
                .querySelector("[data-team-column='red']")
                ?.getAttribute("data-on-clock")
        ).toBe("false");
        expect(red.container.querySelector("[data-glow='true']")).toBeNull();
    });
    test("archive / between games (active=false, nextSlot=null): read-only, no glow, no button, every row and ban filled", () => {
        const { container } = column("red", FULL, { active: false, nextSlot: null });
        expect(
            container.querySelectorAll("[data-pick-row][data-filled='true']")
        ).toHaveLength(5);
        expect(
            container.querySelectorAll("[data-ban-slot][data-filled='true']")
        ).toHaveLength(5);
        expect(container.querySelector("[data-glow='true']")).toBeNull();
        expect(container.querySelectorAll("button")).toHaveLength(0);
        expect(
            container
                .querySelector("[data-team-column='red']")
                ?.getAttribute("data-on-clock")
        ).toBe("false");
    });
    test("an infeasible side: the summary turns red with the reason before that side's own turn; the pick rows do NOT render the ε-noise spread", () => {
        const { container } = column("red", [...BANS, "Gragas", "Jinx", "Aphelios"]); // next = slot 9 (Blue)
        const summary = container.querySelector(
            "[data-roles-summary='red'] [data-seat-row]"
        );
        expect(summary?.getAttribute("data-infeasible")).toBe("true");
        expect(
            summary?.querySelector("[data-seat='adc']")?.getAttribute("data-count")
        ).toBe("2");
        expect(container.querySelector("[data-infeasible-text]")?.textContent).toBe(
            "✕ cannot fill five roles with Jinx, Aphelios"
        );
        // Design § 2: the solver's spread for an infeasible side (Aphelios top 0.33) is not rendered anywhere.
        expect(
            container
                .querySelector("[data-pick-row='R2'] [data-seat-ring]")
                ?.getAttribute("data-marker")
        ).toBe("infeasible");
        expect(
            container.querySelector("[data-pick-row='R2'] [data-pick-note]")?.textContent
        ).toBe("ADC only");
        expect(
            container.querySelector("[data-pick-row='R1'] [data-pick-note]")?.textContent
        ).toBe("ADC only");
        // No dist reaches the ring, so its tooltip is the bare name — the ε-noise must not leak there either.
        expect(
            container
                .querySelector("[data-pick-row='R2'] [data-seat-ring]")
                ?.getAttribute("title")
        ).toBe("Aphelios");
    });
    test("the column is reactive: a new event fills B3 and moves the glow to the next pick row without a remount", () => {
        const [order, setOrder] = createSignal([
            ...BANS,
            "Gragas",
            "Jinx",
            "Ashe",
            "Hecarim"
        ]); // next = 10 (B3 glows)
        const { container } = render(() => (
            <NavigatorTeamColumn
                side="blue"
                events={events(order())}
                ourSide="red"
                nextSlot={order().length}
                active={true}
                onPickNow={() => undefined}
            />
        ));
        expect(
            container.querySelector("[data-pick-row='B3']")?.getAttribute("data-glow")
        ).toBe("true");
        setOrder([...BANS, "Gragas", "Jinx", "Ashe", "Hecarim", "Akali"]); // next = 11 (Red): no blue glow
        expect(
            container.querySelector("[data-pick-row='B3']")?.getAttribute("data-filled")
        ).toBe("true");
        expect(
            container
                .querySelector("[data-pick-row='B3'] [data-seat-ring]")
                ?.getAttribute("data-champion")
        ).toBe("Akali");
        expect(container.querySelector("[data-glow='true']")).toBeNull();
        expect(
            container
                .querySelector("[data-roles-summary='blue'] [data-seat='mid']")
                ?.getAttribute("data-occupant")
        ).toBe("Akali");
    });
});

describe("DraftOrderTicks (design § 1)", () => {
    test("20 side-coloured ticks, the next one highlighted, separators after slots 5, 11 and 15", () => {
        const { container } = render(() => (
            <DraftOrderTicks filledCount={11} nextSlot={11} />
        ));
        const ticks = Array.from(container.querySelectorAll("[data-tick]"));
        expect(ticks).toHaveLength(20);
        expect(
            ticks.filter((t) => t.getAttribute("data-tick-state") === "filled")
        ).toHaveLength(11);
        expect(ticks[11].getAttribute("data-tick-state")).toBe("next");
        expect(ticks[11].getAttribute("data-tick-side")).toBe("red");
        expect(ticks[11].getAttribute("title")).toBe("Red Pick 3");
        expect(ticks[19].getAttribute("data-tick-state")).toBe("empty");
        expect(container.querySelectorAll("[data-tick-separator]")).toHaveLength(3);
        for (const n of [6, 12, 16])
            expect(
                ticks[n].previousElementSibling?.hasAttribute("data-tick-separator"),
                `before ${n}`
            ).toBe(true);
        expect(ticks[5].previousElementSibling?.hasAttribute("data-tick-separator")).toBe(
            false
        );
        cleanup();
        const done = render(() => <DraftOrderTicks filledCount={20} nextSlot={null} />);
        expect(done.container.querySelectorAll("[data-tick-state='next']")).toHaveLength(
            0
        );
    });
});
