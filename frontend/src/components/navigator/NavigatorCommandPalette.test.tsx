// @vitest-environment jsdom
import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render } from "@solidjs/testing-library";
import { buildPaletteCommands } from "../../utils/navigatorPalette";
import {
    NavigatorCommandPalette,
    type NavigatorCommandPaletteProps
} from "./NavigatorCommandPalette";

afterEach(cleanup);

function props(
    overrides: Partial<NavigatorCommandPaletteProps> = {}
): NavigatorCommandPaletteProps {
    return {
        open: true,
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
        preview: (id) => [`preview ${id}`],
        canvases: [
            { id: "c1", name: "Scrims" },
            { id: "c2", name: "Worlds prep" }
        ],
        canvasesLoading: false,
        defaultCanvasId: "c2",
        onRun: () => undefined,
        onExport: () => undefined,
        onClose: () => undefined,
        ...overrides
    };
}
const key = (k: string) => fireEvent.keyDown(window, { key: k });

describe("NavigatorCommandPalette", () => {
    test("always centred, headed by the turn", () => {
        const { container } = render(() => <NavigatorCommandPalette {...props()} />);
        expect(
            container.querySelector("[data-palette]")?.getAttribute("data-palette-mode")
        ).toBe("centred");
        expect(container.querySelector("[data-palette-heading]")?.textContent).toBe(
            "Red Pick 5"
        );
        expect(container.querySelector("[data-ranked-row]")).toBeNull();
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
    test("typing filters commands; the highlighted command shows its preview", () => {
        const { container } = render(() => <NavigatorCommandPalette {...props()} />);
        expect(container.textContent).toContain("preview pick");
        const input = container.querySelector("[data-palette-input]");
        if (input) fireEvent.input(input, { target: { value: "expo" } });
        expect(container.querySelectorAll("[data-palette-command]")).toHaveLength(1);
        expect(container.querySelector("[data-palette-command='export']")).not.toBeNull();
    });
    test("Enter on pick RUNS it (the parent focuses the pool search); no champion pane exists", () => {
        const onRun = vi.fn();
        const { container } = render(() => (
            <NavigatorCommandPalette {...props({ onRun })} />
        ));
        key("Enter");
        expect(onRun).toHaveBeenCalledWith("pick");
        expect(container.querySelector("[data-champion-pane]")).toBeNull();
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
