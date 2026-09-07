// @vitest-environment jsdom
import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render } from "@solidjs/testing-library";
import type { NavigatorTreeNode } from "../../contexts/NavigatorContext";
import { buildPaletteCommands } from "../../utils/navigatorPalette";
import {
    NavigatorCommandPalette,
    type NavigatorCommandPaletteProps
} from "./NavigatorCommandPalette";

afterEach(cleanup);

const scores = (composite: number) => ({
    composite,
    compStrength: 0,
    informationValue: 0,
    flexRetention: 0,
    revealCost: 0
});
const single = (id: string, composite: number): NavigatorTreeNode => ({
    championIds: [id],
    actionType: "pick",
    phase: "pick2",
    scores: scores(composite),
    assignmentDistribution: [],
    side: "red",
    slots: [19],
    userInjected: false,
    children: []
});
const pair = (a: string, b: string, composite: number): NavigatorTreeNode => ({
    championIds: [a, b],
    actionType: "pick",
    phase: "pick2",
    scores: scores(composite),
    assignmentDistribution: [],
    side: "blue",
    slots: [17, 18],
    userInjected: false,
    children: []
});

function props(
    overrides: Partial<NavigatorCommandPaletteProps> = {}
): NavigatorCommandPaletteProps {
    return {
        open: true,
        anchor: null,
        heading: "Red Pick 5",
        commands: buildPaletteCommands({
            turn: { slot: 19, type: "pick" },
            slotLabel: "Red Pick 5",
            isOurTurn: true,
            hasFan: true,
            lastEventChampionName: "Shen",
            hasSelection: true,
            canEditPools: false,
            stale: false
        }),
        turn: { slot: 19, type: "pick", collect: 1, partnerOf: null },
        fan: [single("Pantheon", 3.0), single("Taric", 2.8)],
        unavailable: new Set(["Shen"]),
        unavailableReason: (id) => (id === "Shen" ? "picked in Game 1 (fearless)" : null),
        coloring: () => "neutral",
        rankedRoleLine: () => "Sup",
        preview: (id) => [`preview ${id}`],
        canvases: [
            { id: "c1", name: "Scrims" },
            { id: "c2", name: "Worlds prep" }
        ],
        canvasesLoading: false,
        defaultCanvasId: "c2",
        onCommit: () => undefined,
        onExplore: () => undefined,
        onRun: () => undefined,
        onExport: () => undefined,
        onClose: () => undefined,
        ...overrides
    };
}
const key = (k: string) => fireEvent.keyDown(window, { key: k });

describe("NavigatorCommandPalette", () => {
    test("centred vs anchored", () => {
        const a = render(() => <NavigatorCommandPalette {...props()} />);
        expect(
            a.container.querySelector("[data-palette]")?.getAttribute("data-palette-mode")
        ).toBe("centred");
        expect(a.container.querySelector("[data-palette-heading]")?.textContent).toBe(
            "Red Pick 5"
        );
        cleanup();
        const b = render(() => (
            <NavigatorCommandPalette {...props({ anchor: { left: 120, top: 80 } })} />
        ));
        const root = b.container.querySelector("[data-palette]");
        expect(root?.getAttribute("data-palette-mode")).toBe("anchored");
        expect(root instanceof HTMLElement ? root.style.left : "").toBe("120px");
    });
    test("↑↓ move the highlight, Enter runs a plain command and the disabled ones do nothing", () => {
        const onRun = vi.fn();
        const { container } = render(() => (
            <NavigatorCommandPalette {...props({ onRun })} />
        ));
        expect(
            container
                .querySelector("[data-palette-command='pick']")
                ?.getAttribute("data-highlighted")
        ).toBe("true");
        key("ArrowDown");
        key("ArrowDown");
        key("ArrowDown");
        expect(
            container
                .querySelector("[data-palette-command='undo']")
                ?.getAttribute("data-highlighted")
        ).toBe("true");
        expect(container.textContent).toContain("preview undo");
        key("Enter");
        expect(onRun).toHaveBeenCalledWith("undo");
        key("ArrowDown");
        key("ArrowDown");
        expect(
            container
                .querySelector("[data-palette-command='pools']")
                ?.getAttribute("aria-disabled")
        ).toBe("true");
        key("Enter");
        expect(onRun).toHaveBeenCalledTimes(1);
    });
    test("typing filters commands; the highlighted pick command shows ranked rows", () => {
        const onCommit = vi.fn();
        const { container } = render(() => (
            <NavigatorCommandPalette {...props({ onCommit })} />
        ));
        const rows = container.querySelectorAll("[data-ranked-row]");
        expect(rows).toHaveLength(2);
        expect(rows[0].getAttribute("data-ranked-row")).toBe("Pantheon");
        expect(rows[0].textContent).toContain("3.00");
        fireEvent.click(rows[0]);
        expect(onCommit).toHaveBeenCalledWith(["Pantheon"]);
        const input = container.querySelector("[data-palette-input]");
        if (input) fireEvent.input(input, { target: { value: "expo" } });
        expect(container.querySelectorAll("[data-palette-command]")).toHaveLength(1);
        expect(container.querySelector("[data-palette-command='export']")).not.toBeNull();
    });
    test("Enter on pick opens the champion pane; a tile commits; Backspace on an empty query returns", () => {
        const onCommit = vi.fn();
        const { container } = render(() => (
            <NavigatorCommandPalette {...props({ onCommit })} />
        ));
        key("Enter");
        expect(container.querySelector("[data-champion-pane]")).not.toBeNull();
        expect(
            container
                .querySelector("[data-champion-pane] button[data-champion='Pantheon']")
                ?.getAttribute("data-ranked")
        ).toBe("true");
        expect(
            container
                .querySelector("[data-champion-pane] button[data-champion='Shen']")
                ?.hasAttribute("disabled")
        ).toBe(true);
        expect(
            container
                .querySelector("[data-champion-pane] button[data-champion='Shen']")
                ?.getAttribute("title")
        ).toBe("Shen — picked in Game 1 (fearless)");
        key("Backspace");
        expect(container.querySelector("[data-champion-pane]")).toBeNull();
        key("Enter");
        const input2 = container.querySelector("[data-palette-input]");
        if (input2) fireEvent.input(input2, { target: { value: "Taric" } });
        key("Enter");
        expect(onCommit).toHaveBeenCalledWith(["Taric"]);
        expect(onCommit).toHaveBeenCalledTimes(1); // one Enter → one commit: the palette's and the pane's key handlers never both act
    });
    test("a pair turn collects two champions and commits both", () => {
        const onCommit = vi.fn();
        const fan = [pair("Xayah", "Shen", 2.9), pair("Xayah", "Braum", 2.8)];
        const { container } = render(() => (
            <NavigatorCommandPalette
                {...props({
                    onCommit,
                    fan,
                    unavailable: new Set(),
                    heading: "Blue Pick 4 + Blue Pick 5",
                    turn: { slot: 17, type: "pick", collect: 2, partnerOf: null },
                    commands: buildPaletteCommands({
                        turn: { slot: 17, type: "pick" },
                        slotLabel: "Blue Pick 4 + Blue Pick 5",
                        isOurTurn: false,
                        hasFan: true,
                        lastEventChampionName: "Tristana",
                        hasSelection: false,
                        canEditPools: false,
                        stale: false
                    })
                })}
            />
        ));
        key("Enter");
        expect(container.querySelector("[data-palette-heading]")?.textContent).toBe(
            "Blue Pick 4 + Blue Pick 5 — 1 of 2"
        );
        const xayah = container.querySelector(
            "[data-champion-pane] button[data-champion='Xayah']"
        );
        if (xayah) fireEvent.click(xayah);
        expect(onCommit).not.toHaveBeenCalled();
        expect(container.querySelector("[data-palette-heading]")?.textContent).toBe(
            "Blue Pick 4 + Blue Pick 5 — 2 of 2"
        );
        expect(
            container
                .querySelector("[data-champion-pane] button[data-champion='Braum']")
                ?.getAttribute("data-ranked")
        ).toBe("true");
        expect(
            container.querySelector("[data-champion-pane] button[data-champion='Xayah']")
        ).toBeNull();
        const braum = container.querySelector(
            "[data-champion-pane] button[data-champion='Braum']"
        );
        if (braum) fireEvent.click(braum);
        expect(onCommit).toHaveBeenCalledWith(["Xayah", "Braum"]);
    });
    test("explore selects instead of committing", () => {
        const onExplore = vi.fn();
        const { container } = render(() => (
            <NavigatorCommandPalette {...props({ onExplore })} />
        ));
        key("ArrowDown");
        key("Enter");
        const taric = container.querySelector(
            "[data-champion-pane] button[data-champion='Taric']"
        );
        if (taric) fireEvent.click(taric);
        expect(onExplore).toHaveBeenCalledWith("Taric");
    });
    test("export opens the canvas chooser with the remembered canvas highlighted; Enter exports", () => {
        const onExport = vi.fn();
        const { container } = render(() => (
            <NavigatorCommandPalette {...props({ onExport })} />
        ));
        const input = container.querySelector("[data-palette-input]");
        if (input) fireEvent.input(input, { target: { value: "export" } });
        key("Enter");
        expect(
            container
                .querySelector("[data-canvas-row='c2']")
                ?.getAttribute("data-highlighted")
        ).toBe("true");
        key("Enter");
        expect(onExport).toHaveBeenCalledWith("c2");
    });
    test("Escape closes; closed palette renders nothing", () => {
        const onClose = vi.fn();
        render(() => <NavigatorCommandPalette {...props({ onClose })} />);
        key("Escape");
        expect(onClose).toHaveBeenCalledTimes(1);
        cleanup();
        const closed = render(() => (
            <NavigatorCommandPalette {...props({ open: false })} />
        ));
        expect(closed.container.querySelector("[data-palette]")).toBeNull();
    });
});
