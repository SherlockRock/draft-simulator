// @vitest-environment jsdom
import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render } from "@solidjs/testing-library";
import type { NavigatorEventData } from "../../contexts/NavigatorContext";
import { NavigatorTimeline } from "./NavigatorTimeline";

afterEach(cleanup);

function event(
    slot: number,
    side: "blue" | "red",
    type: "ban" | "pick",
    champion_id: string
): NavigatorEventData {
    return {
        id: `e${slot}`,
        navigator_draft_id: "d",
        event_type: type,
        slot,
        side,
        champion_id,
        user_injected: false,
        createdAt: new Date(slot).toISOString()
    };
}
const sixBansOnePick = [
    event(0, "blue", "ban", "Ashe"),
    event(1, "red", "ban", "Twitch"),
    event(2, "blue", "ban", "Caitlyn"),
    event(3, "red", "ban", "Jhin"),
    event(4, "blue", "ban", "Jinx"),
    event(5, "red", "ban", "Kaisa"),
    event(6, "blue", "pick", "Gragas")
];

describe("NavigatorTimeline", () => {
    test("renders 20 slots, fills the confirmed ones, marks bans", () => {
        const { container } = render(() => (
            <NavigatorTimeline
                events={sixBansOnePick}
                nextSlot={7}
                ourSide="red"
                readOnly={false}
                gapText={{ blue: "ADC + Sup", red: "all five open" }}
                onNextSlotClick={() => undefined}
            />
        ));
        expect(container.querySelectorAll("[data-timeline-slot]")).toHaveLength(20);
        expect(container.querySelectorAll('[data-filled="true"]')).toHaveLength(7);
        expect(container.querySelectorAll('[data-ban="true"]')).toHaveLength(6);
        expect(
            container.querySelector('[data-timeline-slot="6"] img')?.getAttribute("alt")
        ).toBe("Gragas");
    });
    test("the next slot is a labelled button that reports its element on click", () => {
        const onClick = vi.fn();
        const { container } = render(() => (
            <NavigatorTimeline
                events={sixBansOnePick}
                nextSlot={7}
                ourSide="red"
                readOnly={false}
                gapText={{ blue: "", red: "" }}
                onNextSlotClick={onClick}
            />
        ));
        const next = container.querySelector('[data-next-slot="true"]');
        expect(next?.getAttribute("aria-label")).toBe("Red Pick 1");
        expect(next?.getAttribute("data-timeline-slot")).toBe("7");
        if (next) fireEvent.click(next);
        expect(onClick).toHaveBeenCalledTimes(1);
        expect(onClick.mock.calls[0][0]).toBe(next);
    });
    test("read-only: no next-slot button, no click", () => {
        const onClick = vi.fn();
        const { container } = render(() => (
            <NavigatorTimeline
                events={sixBansOnePick}
                nextSlot={null}
                ourSide="red"
                readOnly={true}
                gapText={{ blue: "", red: "" }}
                onNextSlotClick={onClick}
            />
        ));
        expect(container.querySelector('[data-next-slot="true"]')).toBeNull();
        expect(container.querySelectorAll("button")).toHaveLength(0);
    });
    test("role-gap strip shows both sides' text", () => {
        const { container } = render(() => (
            <NavigatorTimeline
                events={[]}
                nextSlot={0}
                ourSide="blue"
                readOnly={false}
                gapText={{ blue: "ADC + Sup", red: "ADC + Top or Jg or Mid or Sup" }}
                onNextSlotClick={() => undefined}
            />
        ));
        expect(
            container.querySelector('[data-role-gap-side="red"]')?.textContent
        ).toContain("Red needs ADC + Top or Jg or Mid or Sup");
        expect(
            container.querySelector('[data-role-gap-side="blue"]')?.textContent
        ).toContain("Blue needs ADC + Sup");
    });
});
