// @vitest-environment jsdom
import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import type { NavigatorTreeNode } from "../../contexts/NavigatorContext";
import { deriveColumns } from "../../utils/navigatorColumns";
import { NavigatorColumns, type NavigatorColumnsProps } from "./NavigatorColumns";

// The seat rows solve on the FROZEN 2026-10-10 share table (plan-level decision 2).
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
function node(
    championIds: string[],
    slots: number[],
    side: "blue" | "red",
    composite: number,
    children: NavigatorTreeNode[] = [],
    extra: Partial<NavigatorTreeNode> = {}
): NavigatorTreeNode {
    return {
        championIds,
        actionType: "pick",
        phase: "pick2",
        scores: scores(composite),
        assignmentDistribution: [],
        side,
        slots,
        userInjected: false,
        children,
        ...extra
    };
}
const pantheon = node(["Pantheon"], [19], "red", 3.0012);
const bluePair = node(["Xayah", "Shen"], [17, 18], "blue", 2.9, [pantheon], {
    confirmedChampionIds: ["Xayah"]
});
const fan = [
    node(["Tristana"], [16], "red", 3.08, [bluePair]),
    node(["Ezreal"], [16], "red", 2.7, [], { userInjected: true })
];
const fanout = node([], [11], "red", 0, fan);

function props(overrides: Partial<NavigatorColumnsProps> = {}): NavigatorColumnsProps {
    return {
        columns: deriveColumns(fanout, []),
        ourSide: "red",
        dimmed: false,
        canMutate: true,
        emptyReason: null,
        canEditPools: false,
        canUndo: true,
        budgetHit: false,
        // The test's rule: the node's own champions as the row, all of them candidates.
        seatRowFor: (n) => ({
            ids: n.championIds,
            candidateIds: n.championIds,
            beforeIds: [],
            side: n.side ?? "red",
            slashCandidate: n.actionType === "ban"
        }),
        onSelect: () => undefined,
        onCommit: () => undefined,
        onContextMenu: () => undefined,
        onUndo: () => undefined,
        onEditPools: () => undefined,
        ...overrides
    };
}

describe("NavigatorColumns", () => {
    test("column 0 renders rank, name, the seat row and the two-decimal score, in engine order; 340px columns", () => {
        const { container } = render(() => <NavigatorColumns {...props()} />);
        const cards = container.querySelectorAll("[data-column-node]");
        expect(cards).toHaveLength(2);
        expect(cards[0].getAttribute("data-rank")).toBe("1");
        expect(cards[0].textContent).toContain("Tristana");
        expect(cards[0].querySelector("[data-node-score]")?.textContent).toBe("3.08");
        const row = cards[0].querySelector("[data-seat-row]");
        expect(
            row?.querySelector("[data-seat='adc']")?.getAttribute("data-occupant")
        ).toBe("Tristana");
        expect(row?.querySelector("[data-seat='adc']")?.getAttribute("data-marker")).toBe(
            "candidate"
        );
        expect(row?.querySelectorAll("[data-open='true']")).toHaveLength(4);
        expect(container.querySelector("[data-node-role]")).toBeNull();
        expect(container.querySelector("[data-node-shift]")).toBeNull();
        expect(
            container.querySelector("[data-column][data-depth='0']")?.textContent
        ).toContain("Red Pick 4 — you");
        expect(container.querySelector(".auto-cols-\\[340px\\]")).not.toBeNull();
        expect(container.querySelector(".auto-cols-\\[300px\\]")).toBeNull();
    });
    test("selecting ghosts the siblings and opens the child column headed '· for <champion>'", () => {
        const onSelect = vi.fn();
        const { container } = render(() => (
            <NavigatorColumns
                {...props({ columns: deriveColumns(fanout, [0]), onSelect })}
            />
        ));
        const col0 = container.querySelectorAll(
            "[data-column][data-depth='0'] [data-column-node]"
        );
        expect(col0[0].getAttribute("data-selected")).toBe("true");
        expect(col0[1].getAttribute("data-ghost")).toBe("true");
        const col1 = container.querySelector("[data-column][data-depth='1']");
        expect(col1?.textContent).toContain("Blue Pick 4 + Blue Pick 5");
        expect(col1?.textContent).toContain("for Tristana");
        const pairCard = col1?.querySelector("[data-column-node]");
        expect(pairCard?.querySelectorAll("[data-confirmed-half] img")).toHaveLength(2);
        expect(pairCard?.querySelectorAll("[data-confirmed-half='true']")).toHaveLength(
            1
        );
        if (col0[1]) fireEvent.click(col0[1]);
        expect(onSelect).toHaveBeenCalledWith(0, 1);
    });
    test("depth-0 cards expose a commit button only when mutable; it commits without selecting", () => {
        const onCommit = vi.fn();
        const onSelect = vi.fn();
        const { container } = render(() => (
            <NavigatorColumns {...props({ onCommit, onSelect })} />
        ));
        const commit = container.querySelector(
            "[data-column-node][data-rank='1'] [data-commit]"
        );
        expect(commit?.getAttribute("data-commit")).toBe("pick");
        if (commit) fireEvent.click(commit);
        expect(onCommit).toHaveBeenCalledWith(fan[0]);
        expect(onSelect).not.toHaveBeenCalled();
        cleanup();
        const ro = render(() => <NavigatorColumns {...props({ canMutate: false })} />);
        expect(ro.container.querySelector("[data-commit]")).toBeNull();
    });
    test("right-click reports node, depth, index and position", () => {
        const onContextMenu = vi.fn();
        const { container } = render(() => (
            <NavigatorColumns {...props({ onContextMenu })} />
        ));
        const card = container.querySelector("[data-column-node][data-rank='2']");
        if (card) fireEvent.contextMenu(card, { clientX: 40, clientY: 50 });
        expect(onContextMenu).toHaveBeenCalledTimes(1);
        expect(onContextMenu.mock.calls[0][0]).toMatchObject({
            node: fan[1],
            depth: 0,
            index: 1,
            x: 40,
            y: 50
        });
    });
    test("empty fan renders the reason card with both remedies", () => {
        const onUndo = vi.fn();
        const { container } = render(() => (
            <NavigatorColumns
                {...props({
                    columns: [],
                    emptyReason:
                        "red cannot fill five roles with Rengar, Nidalee, Yone, Ezreal",
                    onUndo
                })}
            />
        ));
        const card = container.querySelector("[data-empty-fan]");
        expect(card?.textContent).toContain(
            "red cannot fill five roles with Rengar, Nidalee, Yone, Ezreal"
        );
        const undo = card?.querySelector("[data-remedy='undo']");
        if (undo) fireEvent.click(undo);
        expect(onUndo).toHaveBeenCalledTimes(1);
        const pools = card?.querySelector("[data-remedy='pools']");
        expect(pools?.hasAttribute("disabled")).toBe(true); // mid-game: the server rejects pool edits (design § 7)
        expect(pools?.getAttribute("title")).toBe("between games");
    });
    test("empty fan's undo remedy is disabled at zero confirmed events (server rejects an undo)", () => {
        const onUndo = vi.fn();
        const { container } = render(() => (
            <NavigatorColumns
                {...props({
                    columns: [],
                    emptyReason:
                        "red cannot fill five roles with Rengar, Nidalee, Yone, Ezreal",
                    canUndo: false,
                    onUndo
                })}
            />
        ));
        const undo = container.querySelector("[data-remedy='undo']");
        expect(undo?.hasAttribute("disabled")).toBe(true);
        if (undo) fireEvent.click(undo);
        expect(onUndo).not.toHaveBeenCalled();
    });
    test("selecting twice keeps the hovered card's DOM (columns are positionally keyed)", () => {
        const [cols, setCols] = createSignal(deriveColumns(fanout, []));
        const { container } = render(() => (
            <NavigatorColumns {...props()} columns={cols()} />
        ));
        const before = container.querySelector("[data-column-node][data-rank='2']");
        setCols(deriveColumns(fanout, [0]));
        expect(container.querySelector("[data-column-node][data-rank='2']")).toBe(before);
    });
    test("dimmed while thinking; pinned marker on user-injected nodes", () => {
        const { container } = render(() => (
            <NavigatorColumns {...props({ dimmed: true })} />
        ));
        expect(
            container.querySelector("[data-column]")?.classList.contains("opacity-50")
        ).toBe(true);
        expect(
            container.querySelector("[data-column-node][data-rank='2'] [data-pinned]")
        ).not.toBeNull();
    });
    test("a ban card shows the opponent's row with the banned champion slashed as the candidate", () => {
        const ban = node(["Caitlyn"], [12], "red", 0.4, [], { actionType: "ban" });
        const banFanout = node([], [11], "red", 0, [ban]);
        const { container } = render(() => (
            <NavigatorColumns
                {...props({
                    columns: deriveColumns(banFanout, []),
                    // What NavigatorDrafting's seatRowFor passes for a red ban: BLUE's picks + Caitlyn.
                    seatRowFor: () => ({
                        ids: ["Gragas", "Hecarim", "Akali", "Caitlyn"],
                        candidateIds: ["Caitlyn"],
                        beforeIds: ["Gragas", "Hecarim", "Akali"],
                        side: "blue",
                        slashCandidate: true
                    })
                })}
            />
        ));
        const row = container.querySelector(
            "[data-column-node][data-rank='1'] [data-seat-row]"
        );
        expect(
            row?.querySelector("[data-seat='adc']")?.getAttribute("data-occupant")
        ).toBe("Caitlyn");
        expect(
            row
                ?.querySelector("[data-seat='adc'] [data-seat-ring]")
                ?.getAttribute("data-slash")
        ).toBe("true");
        expect(
            row?.querySelector("[data-seat='top']")?.getAttribute("data-occupant")
        ).toBe("Gragas");
        expect(
            row
                ?.querySelector("[data-seat='top'] [data-seat-ring]")
                ?.getAttribute("data-slash")
        ).toBe("false");
        expect(
            container.querySelector("[data-commit]")?.getAttribute("data-commit")
        ).toBe("ban");
    });
    test("the budget-hit hint renders under column 0 only when asked", () => {
        const off = render(() => <NavigatorColumns {...props()} />);
        expect(off.container.querySelector("[data-budget-hint]")).toBeNull();
        cleanup();
        const on = render(() => <NavigatorColumns {...props({ budgetHit: true })} />);
        expect(
            on.container.querySelector("[data-column][data-depth='0'] [data-budget-hint]")
                ?.textContent
        ).toBe("search budget hit — the order among close scores is soft");
    });
});
