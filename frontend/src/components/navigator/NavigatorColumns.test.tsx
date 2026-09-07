// @vitest-environment jsdom
import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import type { NavigatorTreeNode } from "../../contexts/NavigatorContext";
import { deriveColumns } from "../../utils/navigatorColumns";
import { NavigatorColumns, type NavigatorColumnsProps } from "./NavigatorColumns";

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
        roleLineFor: (n) => ({
            roles: n.championIds.map(() => "Sup"),
            shift: n.championIds[0] === "Ezreal" ? "Sylas → Sup" : null
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
    test("column 0 renders rank, name, role line, shift and two-decimal score, in engine order", () => {
        const { container } = render(() => <NavigatorColumns {...props()} />);
        const cards = container.querySelectorAll("[data-column-node]");
        expect(cards).toHaveLength(2);
        expect(cards[0].getAttribute("data-rank")).toBe("1");
        expect(cards[0].textContent).toContain("Tristana");
        expect(cards[0].querySelector("[data-node-score]")?.textContent).toBe("3.08");
        expect(cards[0].querySelector("[data-node-role]")?.textContent).toBe("Sup");
        expect(cards[0].querySelector("[data-node-shift]")).toBeNull();
        expect(cards[1].querySelector("[data-node-shift]")?.textContent).toContain(
            "Sylas → Sup"
        );
        expect(
            container.querySelector("[data-column][data-depth='0']")?.textContent
        ).toContain("Red Pick 4 — you");
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
        expect(pairCard?.querySelectorAll("img")).toHaveLength(2);
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
});
