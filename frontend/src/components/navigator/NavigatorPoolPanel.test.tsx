// @vitest-environment jsdom
import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import type { RolePoolMap } from "@draft-sim/shared-types";
import type { NavigatorTreeNode } from "../../contexts/NavigatorContext";
import { NavigatorPoolPanel, type NavigatorPoolPanelProps } from "./NavigatorPoolPanel";

vi.mock("../../data/champions.json", async () => ({
    default: (await import("../../utils/__fixtures__/champions-2026-10-10-shares.json"))
        .default
}));

afterEach(cleanup);

const scores = (composite: number) => ({
    composite,
    compStrength: 0,
    informationValue: 0,
    flexRetention: 0,
    revealCost: 0
});
const pick = (
    id: string,
    composite: number,
    side: "blue" | "red" = "red",
    slots = [11]
): NavigatorTreeNode => ({
    championIds: [id],
    actionType: "pick",
    phase: "pick1",
    scores: scores(composite),
    assignmentDistribution: [],
    side,
    slots,
    userInjected: false,
    children: []
});
const pair = (a: string, b: string, composite: number): NavigatorTreeNode => ({
    ...pick(a, composite, "blue", [9, 10]),
    championIds: [a, b]
});
const RED: RolePoolMap = {
    top: ["Pantheon", "Poppy", "Gragas"],
    jungle: ["Sylas", "Poppy"],
    mid: ["Brand", "Swain", "Akali", "Sylas"],
    adc: ["Jinx", "Ashe", "Xayah", "Caitlyn"],
    support: ["Brand", "Swain", "Ashe", "TahmKench"]
};
const BLUE: RolePoolMap = {
    top: ["Shen", "Gragas"],
    jungle: ["Hecarim"],
    mid: ["Akali"],
    adc: ["Xayah", "Jinx"],
    support: ["Shen", "Braum"]
};
const EMPTY: RolePoolMap = { top: [], jungle: [], mid: [], adc: [], support: [] };
const FAN = [
    pick("Pantheon", 2.69),
    pick("Sylas", 2.46),
    pick("Brand", 2.42),
    pick("Poppy", 2.28)
];
const USED = new Set(["Jinx", "Ashe", "Gragas", "Hecarim", "Akali", "Caitlyn"]);

const DEFAULT_TURN: NavigatorPoolPanelProps["turn"] = {
    slot: 11,
    type: "pick",
    side: "red",
    collect: 1,
    partnerOf: null
};
function mount(overrides: Partial<NavigatorPoolPanelProps> = {}) {
    const [query, setQuery] = createSignal(overrides.query ?? "");
    const [focusRequest, setFocusRequest] = createSignal(0);
    const [fan, setFan] = createSignal<NavigatorTreeNode[]>(overrides.fan ?? FAN);
    // `turn` is a signal so a test can hand over a NEW object with the same slot (what an engine
    // snapshot does in the real page) or a new slot.
    const [turn, setTurn] = createSignal<NavigatorPoolPanelProps["turn"]>(
        "turn" in overrides ? (overrides.turn ?? null) : DEFAULT_TURN
    );
    const onCommit = vi.fn();
    const onExplore = vi.fn();
    const onBlurToPage = vi.fn();
    const onViewChange = vi.fn();
    const onEditPools = vi.fn();
    const utils = render(() => (
        <NavigatorPoolPanel
            ourSide="red"
            view="yours"
            onViewChange={onViewChange}
            pools={{ blue: BLUE, red: RED }}
            picks={{ blue: ["Gragas", "Hecarim", "Akali"], red: ["Jinx", "Ashe"] }}
            unavailable={USED}
            unavailableReason={(id) => (USED.has(id) ? "already used this game" : null)}
            onCommit={onCommit}
            onExplore={onExplore}
            onBlurToPage={onBlurToPage}
            committing={false}
            canEditPools={false}
            onEditPools={onEditPools}
            {...overrides}
            turn={turn()}
            query={query()}
            onQueryChange={setQuery}
            focusRequest={focusRequest()}
            fan={fan()}
        />
    ));
    return {
        ...utils,
        setFan,
        setQuery,
        query,
        setFocusRequest,
        setTurn,
        onCommit,
        onExplore,
        onBlurToPage,
        onViewChange,
        onEditPools
    };
}
const key = (el: Element | null, k: string, init: KeyboardEventInit = {}) => {
    if (el) fireEvent.keyDown(el, { key: k, ...init });
};
const search = (c: ParentNode) => c.querySelector("[data-pool-search]");

describe("NavigatorPoolPanel (design § 5)", () => {
    test("header: title names the pool and the turn; five columns in seat order, lit/dim and status from the seating; legend", () => {
        const { container } = mount();
        expect(
            container.querySelector("[data-pool-panel]")?.getAttribute("data-pool-view")
        ).toBe("yours");
        expect(container.querySelector("[data-pool-title]")?.textContent).toBe(
            "Red's pool · Pick for Red Pick 3"
        );
        const cols = Array.from(container.querySelectorAll("[data-pool-column]"));
        expect(cols.map((c) => c.getAttribute("data-pool-column"))).toEqual([
            "top",
            "jungle",
            "mid",
            "adc",
            "support"
        ]);
        expect(cols[0].getAttribute("data-lit")).toBe("true");
        expect(cols[0].querySelector("[data-pool-status]")?.textContent).toBe("open");
        expect(cols[3].getAttribute("data-lit")).toBe("false");
        expect(cols[3].querySelector("[data-pool-status]")?.textContent).toBe("Jinx 95%");
        expect(cols[4].querySelector("[data-pool-status]")?.textContent).toBe("Ashe 72%");
        expect(container.querySelector("[data-pool-legend]")?.textContent).toContain(
            "Sup"
        );
    });
    test("tiles: ranked first with the score badge; used tiles disabled with the reason and not committable", () => {
        const { container, onCommit } = mount();
        const top = container.querySelector("[data-pool-column='top']");
        const tiles = Array.from(top?.querySelectorAll("[data-tile]") ?? []);
        expect(tiles.map((t) => t.getAttribute("data-tile"))).toEqual([
            "Pantheon",
            "Poppy",
            "Gragas"
        ]);
        expect(tiles[0].getAttribute("data-ranked")).toBe("true");
        expect(tiles[0].textContent).toContain("2.69");
        expect(tiles[2].hasAttribute("disabled")).toBe(true);
        expect(tiles[2].getAttribute("title")).toBe("Gragas — already used this game");
        fireEvent.click(tiles[2]);
        expect(onCommit).not.toHaveBeenCalled();
        fireEvent.click(tiles[0]);
        expect(onCommit).toHaveBeenCalledWith(["Pantheon"]);
    });
    test("the view toggle reports a change; enemy shows Blue's pool; all shows every champion with the on-clock side's seating", () => {
        const a = mount();
        const enemy = a.container.querySelector("[data-pool-view-button='enemy']");
        if (enemy) fireEvent.click(enemy);
        expect(a.onViewChange).toHaveBeenCalledWith("enemy");
        cleanup();
        const b = mount({ view: "enemy" });
        expect(b.container.querySelector("[data-pool-title]")?.textContent).toBe(
            "Blue's pool · Pick for Red Pick 3"
        );
        expect(
            b.container.querySelector("[data-pool-column='support'] [data-tile='Braum']")
        ).not.toBeNull();
        expect(
            b.container
                .querySelector("[data-pool-column='top']")
                ?.getAttribute("data-lit")
        ).toBe("false"); // Gragas sits top for Blue
        cleanup();
        const c = mount({ view: "all" });
        expect(
            c.container.querySelector("[data-pool-panel]")?.getAttribute("data-pool-view")
        ).toBe("all");
        expect(
            c.container.querySelector("[data-pool-column='adc'] [data-tile='Caitlyn']")
        ).not.toBeNull();
        expect(
            c.container
                .querySelector("[data-pool-column='adc']")
                ?.getAttribute("data-lit")
        ).toBe("false"); // red (on the clock) has Jinx at adc
    });
    test("search: matches lit and highlighted, non-matches dimmed; one match shows '<Name> · ↵ picks'", () => {
        const { container, setQuery } = mount();
        setQuery("sw");
        const swainMid = container.querySelector(
            "[data-pool-column='mid'] [data-tile='Swain']"
        );
        expect(swainMid?.getAttribute("data-match")).toBe("true");
        expect(swainMid?.getAttribute("data-highlighted")).toBe("true");
        expect(
            container
                .querySelector("[data-pool-column='support'] [data-tile='Swain']")
                ?.getAttribute("data-highlighted")
        ).toBe("false");
        expect(
            container.querySelector("[data-tile='Pantheon']")?.getAttribute("data-match")
        ).toBe("false");
        expect(container.querySelectorAll("[data-highlighted='true']")).toHaveLength(1);
        expect(container.querySelector("[data-single-match]")?.textContent).toBe(
            "Swain · ↵ picks"
        );
    });
    test("a used champion never shows the single-match label and Enter commits nothing", () => {
        const { container, setQuery, onCommit } = mount();
        setQuery("jinx");
        expect(container.querySelector("[data-single-match]")).toBeNull();
        expect(container.querySelector("[data-highlighted='true']")).toBeNull();
        key(search(container), "Enter");
        expect(onCommit).not.toHaveBeenCalled();
        setQuery("sw");
        expect(container.querySelector("[data-single-match]")?.textContent).toBe(
            "Swain · ↵ picks"
        );
    });
    test("Enter commits the highlighted tile; Shift+Enter explores a fan champion, or hints 'not in the fan'", () => {
        const { container, setQuery, query, onCommit, onExplore } = mount();
        setQuery("sw");
        key(search(container), "Enter");
        expect(onCommit).toHaveBeenCalledWith(["Swain"]);
        setQuery("pa");
        key(search(container), "Enter", { shiftKey: true });
        expect(onExplore).toHaveBeenCalledWith("Pantheon");
        expect(query()).toBe(""); // explore clears the query (the box is about to blur)
        expect(onCommit).toHaveBeenCalledTimes(1);
        setQuery("sw");
        key(search(container), "Enter", { shiftKey: true });
        expect(onExplore).toHaveBeenCalledTimes(1);
        expect(container.querySelector("[data-pool-hint]")?.textContent).toBe(
            "not in the fan"
        );
    });
    test("Enter with no match commits nothing; Esc clears and returns focus to the page; Backspace on an empty box returns focus", () => {
        const { container, setQuery, query, onCommit, onBlurToPage } = mount();
        setQuery("zzz");
        expect(container.querySelector("[data-highlighted='true']")).toBeNull();
        key(search(container), "Enter");
        expect(onCommit).not.toHaveBeenCalled();
        key(search(container), "Escape");
        expect(query()).toBe("");
        expect(onBlurToPage).toHaveBeenCalledTimes(1);
        key(search(container), "Backspace");
        expect(onBlurToPage).toHaveBeenCalledTimes(2);
    });
    test("arrows move the highlight across visible tiles and columns (used tiles skipped)", () => {
        const { container } = mount();
        key(search(container), "ArrowDown"); // from nothing: the first visible tile
        expect(
            container
                .querySelector("[data-highlighted='true']")
                ?.getAttribute("data-tile")
        ).toBe("Pantheon");
        key(search(container), "ArrowRight");
        expect(
            container
                .querySelector("[data-highlighted='true']")
                ?.getAttribute("data-tile")
        ).toBe("Poppy");
        key(search(container), "ArrowRight"); // Gragas is used → the top column ends → jungle's first tile
        expect(
            container
                .querySelector("[data-pool-column='jungle'] [data-highlighted='true']")
                ?.getAttribute("data-tile")
        ).toBe("Sylas");
        key(search(container), "ArrowLeft");
        expect(
            container
                .querySelector("[data-pool-column='top'] [data-highlighted='true']")
                ?.getAttribute("data-tile")
        ).toBe("Poppy");
    });
    test("a pair turn collects two: the first click becomes a chip, the header says 1 of 2 then 2 of 2, the chip's ✕ undoes it", () => {
        const { container, onCommit } = mount({
            turn: { slot: 9, type: "pick", side: "blue", collect: 2, partnerOf: null },
            ourSide: "blue",
            fan: [pair("Xayah", "Shen", 2.9), pair("Xayah", "Braum", 2.8)],
            picks: { blue: ["Gragas"], red: ["Jinx", "Ashe"] },
            unavailable: new Set(["Gragas", "Jinx", "Ashe"])
        });
        expect(container.querySelector("[data-pool-title]")?.textContent).toBe(
            "Blue's pool · Pick for Blue Pick 2 + Blue Pick 3 — 1 of 2"
        );
        const xayah = container.querySelector(
            "[data-pool-column='adc'] [data-tile='Xayah']"
        );
        if (xayah) fireEvent.click(xayah);
        expect(onCommit).not.toHaveBeenCalled();
        expect(container.querySelector("[data-pair-chip='Xayah']")).not.toBeNull();
        expect(container.querySelector("[data-pool-title]")?.textContent).toContain(
            "2 of 2"
        );
        const remove = container.querySelector(
            "[data-pair-chip='Xayah'] [data-pair-chip-remove]"
        );
        if (remove) fireEvent.click(remove);
        expect(container.querySelector("[data-pair-chip='Xayah']")).toBeNull();
        expect(container.querySelector("[data-pool-title]")?.textContent).toContain(
            "1 of 2"
        );
        if (xayah) fireEvent.click(xayah);
        const shen = container.querySelector(
            "[data-pool-column='support'] [data-tile='Shen']"
        );
        if (shen) fireEvent.click(shen);
        expect(onCommit).toHaveBeenCalledWith(["Xayah", "Shen"]);
    });
    test("pair-pending: ranked tiles are the partners of the confirmed half, which is disabled; the header says 2 of 2", () => {
        const { container } = mount({
            turn: {
                slot: 10,
                type: "pick",
                side: "blue",
                collect: 1,
                partnerOf: "Xayah"
            },
            ourSide: "blue",
            fan: [
                pair("Xayah", "Shen", 2.9),
                pair("Xayah", "Braum", 2.8),
                pair("Jinx", "Shen", 2.7)
            ],
            picks: { blue: ["Gragas", "Xayah"], red: ["Jinx", "Ashe"] },
            unavailable: new Set(["Gragas", "Xayah", "Jinx", "Ashe"])
        });
        expect(container.querySelector("[data-pool-title]")?.textContent).toBe(
            "Blue's pool · Pick for Blue Pick 3 — 2 of 2"
        );
        expect(
            container
                .querySelector("[data-pool-column='support'] [data-tile='Shen']")
                ?.getAttribute("data-ranked")
        ).toBe("true");
        expect(
            container
                .querySelector("[data-pool-column='support'] [data-tile='Braum']")
                ?.getAttribute("data-ranked")
        ).toBe("true");
        expect(
            container
                .querySelector("[data-pool-column='adc'] [data-tile='Xayah']")
                ?.hasAttribute("disabled")
        ).toBe(true);
    });
    test("hover shows the seating preview with the hovered champion as the candidate; a ban turn previews the opponent with the slash", () => {
        const a = mount();
        const swain = a.container.querySelector(
            "[data-pool-column='mid'] [data-tile='Swain']"
        );
        if (swain) fireEvent.mouseEnter(swain);
        const preview = document.querySelector("[data-pool-preview]");
        expect(preview?.textContent).toContain("Swain → Red");
        expect(
            preview?.querySelector("[data-seat='mid']")?.getAttribute("data-occupant")
        ).toBe("Swain");
        expect(
            preview?.querySelector("[data-seat='mid']")?.getAttribute("data-marker")
        ).toBe("candidate");
        expect(
            preview?.querySelector("[data-seat='support']")?.getAttribute("data-occupant")
        ).toBe("Ashe");
        if (swain) fireEvent.mouseLeave(swain);
        expect(document.querySelector("[data-pool-preview]")).toBeNull();
        cleanup();
        const b = mount({
            turn: { slot: 12, type: "ban", side: "red", collect: 1, partnerOf: null },
            view: "enemy"
        });
        expect(b.container.querySelector("[data-pool-title]")?.textContent).toBe(
            "Blue's pool · Ban for Red Ban 4"
        );
        const xayah = b.container.querySelector(
            "[data-pool-column='adc'] [data-tile='Xayah']"
        );
        if (xayah) fireEvent.mouseEnter(xayah);
        const banPreview = document.querySelector("[data-pool-preview]");
        expect(banPreview?.textContent).toContain("Xayah → Blue");
        expect(
            banPreview
                ?.querySelector("[data-seat='adc'] [data-seat-ring]")
                ?.getAttribute("data-slash")
        ).toBe("true");
        expect(
            banPreview?.querySelector("[data-seat='top']")?.getAttribute("data-occupant")
        ).toBe("Gragas");
        expect(b.container.querySelector("[data-single-match]")).toBeNull();
    });
    test("a same-slot turn object (an engine snapshot) keeps the arrow position and the pair chip; a new slot resets both", () => {
        const a = mount();
        key(search(a.container), "ArrowDown");
        key(search(a.container), "ArrowRight");
        expect(
            a.container
                .querySelector("[data-highlighted='true']")
                ?.getAttribute("data-tile")
        ).toBe("Poppy");
        a.setTurn({ slot: 11, type: "pick", side: "red", collect: 1, partnerOf: null }); // fresh object, same slot
        expect(
            a.container
                .querySelector("[data-highlighted='true']")
                ?.getAttribute("data-tile")
        ).toBe("Poppy");
        a.setTurn({ slot: 12, type: "ban", side: "red", collect: 1, partnerOf: null });
        expect(a.container.querySelector("[data-highlighted='true']")).toBeNull();
        cleanup();
        const b = mount({
            turn: { slot: 9, type: "pick", side: "blue", collect: 2, partnerOf: null },
            ourSide: "blue",
            fan: [pair("Xayah", "Shen", 2.9)],
            picks: { blue: ["Gragas"], red: ["Jinx", "Ashe"] },
            unavailable: new Set(["Gragas", "Jinx", "Ashe"])
        });
        const xayah = b.container.querySelector(
            "[data-pool-column='adc'] [data-tile='Xayah']"
        );
        if (xayah) fireEvent.click(xayah);
        expect(b.container.querySelector("[data-pair-chip='Xayah']")).not.toBeNull();
        b.setTurn({ slot: 9, type: "pick", side: "blue", collect: 2, partnerOf: null }); // a Phase-2 snapshot mid-pair
        expect(b.container.querySelector("[data-pair-chip='Xayah']")).not.toBeNull();
        b.setTurn({ slot: 11, type: "pick", side: "red", collect: 1, partnerOf: null });
        expect(b.container.querySelector("[data-pair-chip='Xayah']")).toBeNull();
    });
    test("the arrowed highlight follows the champion when the engine re-ranks the fan", () => {
        const { container, setFan, onCommit } = mount();
        key(search(container), "ArrowDown");
        key(search(container), "ArrowRight");
        expect(
            container
                .querySelector("[data-highlighted='true']")
                ?.getAttribute("data-tile")
        ).toBe("Poppy");
        setFan([
            pick("Poppy", 2.9),
            pick("Pantheon", 2.69),
            pick("Sylas", 2.46),
            pick("Brand", 2.42)
        ]);
        expect(
            container
                .querySelector("[data-highlighted='true']")
                ?.getAttribute("data-tile")
        ).toBe("Poppy");
        key(search(container), "Enter");
        expect(onCommit).toHaveBeenCalledWith(["Poppy"]);
    });
    test("a focus request focuses the search box", () => {
        const { container, setFocusRequest } = mount();
        expect(document.activeElement).not.toBe(search(container));
        setFocusRequest(1);
        expect(document.activeElement).toBe(search(container));
    });
    test("an empty pool offers Edit pools, disabled mid-game with the 'between games' hint", () => {
        const a = mount({ pools: { blue: BLUE, red: EMPTY } });
        const edit = a.container.querySelector("[data-pool-edit]");
        expect(edit?.hasAttribute("disabled")).toBe(true);
        expect(edit?.getAttribute("title")).toBe("between games");
        cleanup();
        const b = mount({ pools: { blue: BLUE, red: EMPTY }, canEditPools: true });
        const edit2 = b.container.querySelector("[data-pool-edit]");
        if (edit2) fireEvent.click(edit2);
        expect(b.onEditPools).toHaveBeenCalledTimes(1);
    });
    test("no open turn: the panel renders disabled; while committing, tiles are disabled and Enter is a no-op", () => {
        const a = mount({ turn: null });
        expect(
            a.container
                .querySelector("[data-pool-panel]")
                ?.getAttribute("data-pool-disabled")
        ).toBe("true");
        expect(search(a.container)?.hasAttribute("disabled")).toBe(true);
        cleanup();
        const b = mount({ committing: true });
        expect(
            b.container.querySelector("[data-tile='Pantheon']")?.hasAttribute("disabled")
        ).toBe(true);
        b.setQuery("sw");
        key(search(b.container), "Enter");
        expect(b.onCommit).not.toHaveBeenCalled();
    });
});
