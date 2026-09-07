// @vitest-environment jsdom
import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render } from "@solidjs/testing-library";
import { QueryClient, QueryClientProvider } from "@tanstack/solid-query";
import type {
    NavigatorCompletedGame,
    NavigatorEventData,
    NavigatorSessionData,
    NavigatorSessionState,
    NavigatorTreeNode,
    NavigatorWorkflowContextValue
} from "../../contexts/NavigatorContext";
import { NavigatorWorkflowContext } from "../../contexts/NavigatorContext";
import item5 from "../../utils/__fixtures__/navigator-item5-snapshot.json";
import { NavigatorTreeNodeSchema } from "../../utils/navigatorTreeSchema";
import { eventsToConfirmedTurns, synthesizeFullTree } from "../../utils/treeReconcile";
import { TURN_SEQUENCE } from "../../utils/turnSequence";
import NavigatorDrafting from "./NavigatorDrafting";

// The canvas list query is enabled once a line is selected and the palette is open;
// never let it reach the network from jsdom.
vi.mock("../../utils/actions", () => ({
    fetchCanvasList: vi.fn(async () => [{ id: "c1", name: "Scrims", updatedAt: "" }]),
    postNewDraft: vi.fn(async () => ({
        id: "d",
        name: "Navigator G1 — red line Pantheon"
    }))
}));

afterEach(cleanup);

// jsdom does not implement scrollIntoView; ChampionPicker's tile-focus effect
// calls it once the swap picker opens (the "swap picker is up" test below).
// The exception is otherwise unhandled and fails the run despite every
// assertion passing — stub it rather than touch ChampionPicker or the test.
if (typeof Element !== "undefined" && !Element.prototype.scrollIntoView) {
    Element.prototype.scrollIntoView = () => {};
}

// JSON imports widen literal types (actionType: string); the wire schema narrows them.
const item5Tree: NavigatorTreeNode = NavigatorTreeNodeSchema.parse(item5.tree);

const ITEM5_ORDER = [
    "Ashe",
    "Twitch",
    "Caitlyn",
    "Jhin",
    "Jinx",
    "Kaisa",
    "Gragas",
    "Sejuani",
    "Sylas",
    "Hecarim",
    "Akali",
    "Lissandra",
    "Aphelios",
    "Draven",
    "Sivir",
    "Zeri",
    "Tristana",
    "Xayah",
    "Shen"
];
const ITEM7_ORDER = [
    "Irelia",
    "Galio",
    "Shaco",
    "Caitlyn",
    "Ashe",
    "Viego",
    "Jayce",
    "Rengar",
    "Nidalee",
    "Diana",
    "Talon",
    "Yone",
    "KSante",
    "Pantheon",
    "Locke",
    "LeeSin",
    "Ezreal",
    "Jhin",
    "Xerath"
];

function events(order: string[]): NavigatorEventData[] {
    return order.map((champion_id, slot) => ({
        id: `e${slot}`,
        navigator_draft_id: "draft-1",
        event_type: TURN_SEQUENCE[slot].type,
        slot,
        side: TURN_SEQUENCE[slot].side,
        champion_id,
        user_injected: false,
        createdAt: new Date(1700000000000 + slot).toISOString()
    }));
}
const emptyPool = {
    display: { top: [], jungle: [], mid: [], adc: [], support: [] },
    search: []
};
const session: NavigatorSessionData = {
    id: "s1",
    name: "Tour",
    user_id: "u",
    our_side: "red",
    blue_pool: emptyPool,
    red_pool: emptyPool,
    opponent_pool: null,
    draft_mode: "standard",
    series_length: 1,
    side_swap_mode: "auto",
    status: "active",
    config_version: 1,
    createdAt: "",
    updatedAt: ""
};
const emptyTree: NavigatorTreeNode = {
    championIds: [],
    actionType: "pick",
    phase: "pick2",
    scores: {
        composite: 0,
        compStrength: 0,
        informationValue: 0,
        flexRetention: 0,
        revealCost: 0
    },
    assignmentDistribution: [],
    side: "red",
    slots: [19],
    userInjected: false,
    children: []
};

function mount(
    order: string[],
    engineTree: NavigatorTreeNode,
    opts: { computing?: boolean; archive?: boolean } = {}
) {
    const computing = opts.computing ?? false;
    const evs = events(order);
    const meta = {
        nodesEvaluated: 1,
        computeTimeMs: 371,
        pruningRate: 0,
        depthReached: 8,
        transpositionsFound: 0
    };
    const archiveGame: NavigatorCompletedGame = {
        draft: {
            id: "draft-1",
            session_id: "s1",
            game_number: 1,
            status: "completed",
            our_side_override: null,
            draft_id: null
        },
        events: evs,
        snapshot: {
            source: "persisted",
            id: "snap-final",
            navigator_draft_id: "draft-1",
            after_event_id: "e19",
            tree: emptyTree,
            scenarios: [],
            meta,
            createdAt: null
        }
    };
    const state: NavigatorSessionState = {
        session,
        draft: opts.archive
            ? archiveGame.draft
            : {
                  id: "draft-1",
                  session_id: "s1",
                  game_number: 1,
                  status: "active",
                  our_side_override: null,
                  draft_id: null
              },
        events: evs,
        snapshot: {
            source: "persisted",
            id: "snap",
            navigator_draft_id: "draft-1",
            after_event_id: "e18",
            tree: engineTree,
            scenarios: [],
            meta,
            createdAt: null
        },
        completedGames: opts.archive ? [archiveGame] : [],
        connected: true,
        error: null
    };
    const synthetic = synthesizeFullTree(engineTree, eventsToConfirmedTurns(evs));
    const emitPickStep = vi.fn();
    const emitBan = vi.fn();
    const emitUndo = vi.fn();
    const viewGame = vi.fn();
    const value: NavigatorWorkflowContextValue = {
        navigatorContext: () => state,
        syntheticTree: () => synthetic,
        effectiveScenarios: () => [],
        isComputing: () => computing,
        currentMeta: () => state.snapshot?.meta ?? null,
        joinSession: vi.fn(),
        leaveSession: vi.fn(),
        emitPickStep,
        emitBan,
        emitUndo,
        startDraft: vi.fn(),
        nextGame: vi.fn(),
        startNextGame: vi.fn(),
        updateSessionPools: vi.fn(),
        viewingGameNumber: () => (opts.archive ? 1 : null),
        viewGame,
        selectedScenarioIndex: () => null,
        setSelectedScenarioIndex: vi.fn(),
        swapChampion: vi.fn(),
        createBranch: vi.fn(),
        // Radial-tree members: still in the context type until Task 10 deletes them (and these ten lines).
        panRequest: () => null,
        setPanRequest: vi.fn(),
        requestScenarioPan: vi.fn(),
        manualExpansionKeys: () => new Set<string>(),
        manualCollapseKeys: () => new Set<string>(),
        setManualExpansionKeys: vi.fn(),
        setManualCollapseKeys: vi.fn(),
        layoutOverrides: () => new Map(),
        setLayoutOverride: vi.fn(),
        clearAllLayoutOverrides: vi.fn()
    };
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const utils = render(() => (
        <QueryClientProvider client={client}>
            <NavigatorWorkflowContext.Provider value={value}>
                <NavigatorDrafting />
            </NavigatorWorkflowContext.Provider>
        </QueryClientProvider>
    ));
    return { ...utils, emitPickStep, emitBan, emitUndo, viewGame };
}
const key = (k: string) => fireEvent.keyDown(window, { key: k });

describe("NavigatorDrafting (design § 1 rows on the item5 / item7 smoke states)", () => {
    test("item5: header, ready pill, top-1 Pantheon as Sup at 3.00, role-gap strip", () => {
        const { container } = mount(ITEM5_ORDER, item5Tree);
        expect(container.querySelector("[data-drafting-header]")?.textContent).toContain(
            "Pick Phase 2 — Red Pick 5"
        );
        expect(container.querySelector("[data-drafting-header]")?.textContent).toContain(
            "you"
        );
        const pill = container.querySelector("[data-engine-status]");
        expect(pill?.getAttribute("data-engine-status")).toBe("ready");
        expect(pill?.textContent).toBe("● 8 candidates · depth 8 · 371 ms");
        const top1 = container.querySelector(
            "[data-column][data-depth='0'] [data-column-node][data-rank='1']"
        );
        expect(top1?.textContent).toContain("Pantheon");
        expect(top1?.querySelector("[data-node-role]")?.textContent).toBe("Sup");
        expect(top1?.querySelector("[data-node-score]")?.textContent).toBe("3.00");
        expect(
            container.querySelector("[data-role-gap-side='blue']")?.textContent
        ).toContain("all five covered");
        expect(
            container.querySelector("[data-role-gap-side='red']")?.textContent
        ).toContain("Top or Jg or Mid or ADC or Sup");
        expect(
            container.querySelectorAll("[data-timeline-slot][data-filled='true']")
        ).toHaveLength(19);
    });
    test("'/' opens the palette centred; the next slot opens it anchored; a tile commits via emitPickStep at slot 19", () => {
        const { container, emitPickStep } = mount(ITEM5_ORDER, item5Tree);
        key("/");
        expect(
            container.querySelector("[data-palette]")?.getAttribute("data-palette-mode")
        ).toBe("centred");
        expect(container.querySelector("[data-palette-heading]")?.textContent).toBe(
            "Red Pick 5"
        );
        key("Escape");
        expect(container.querySelector("[data-palette]")).toBeNull();
        const next = container.querySelector("[data-next-slot='true']");
        if (next) fireEvent.click(next);
        expect(
            container.querySelector("[data-palette]")?.getAttribute("data-palette-mode")
        ).toBe("anchored");
        key("Enter");
        const taric = container.querySelector(
            "[data-champion-pane] button[data-champion='Taric']"
        );
        if (taric) fireEvent.click(taric);
        expect(emitPickStep).toHaveBeenCalledWith("draft-1", ["Taric"], 19);
        expect(container.querySelector("[data-palette]")).toBeNull();
    });
    test("hover Pick on a column-0 card commits that node; selecting opens nothing further at depth 8 leaves", () => {
        const { container, emitPickStep } = mount(ITEM5_ORDER, item5Tree);
        const commit = container.querySelector(
            "[data-column-node][data-rank='1'] [data-commit='pick']"
        );
        if (commit) fireEvent.click(commit);
        expect(emitPickStep).toHaveBeenCalledWith("draft-1", ["Pantheon"], 19);
    });
    test("item7: empty pill with the infeasibility reason and the empty-fan card", () => {
        const { container, emitUndo } = mount(ITEM7_ORDER, emptyTree);
        const pill = container.querySelector("[data-engine-status]");
        expect(pill?.getAttribute("data-engine-status")).toBe("empty");
        expect(pill?.textContent).toBe(
            "✕ No legal completion — red cannot fill five roles with Rengar, Nidalee, Yone, Ezreal · undo or relax pool"
        );
        expect(
            container.querySelector("[data-role-gap-side='red']")?.textContent
        ).toContain("cannot complete five roles");
        const undo = container.querySelector("[data-empty-fan] [data-remedy='undo']");
        if (undo) fireEvent.click(undo);
        expect(emitUndo).toHaveBeenCalledWith("draft-1");
    });
    test("thinking: pill says thinking, columns dimmed, palette still opens", () => {
        const { container } = mount(ITEM5_ORDER, item5Tree, { computing: true });
        expect(
            container
                .querySelector("[data-engine-status]")
                ?.getAttribute("data-engine-status")
        ).toBe("thinking");
        expect(
            container.querySelector("[data-column]")?.classList.contains("opacity-50")
        ).toBe(true);
        key("/");
        expect(container.querySelector("[data-palette]")).not.toBeNull();
    });
    test("'/' does not open the palette while the swap picker is up", () => {
        const { container } = mount(ITEM5_ORDER, item5Tree);
        const card = container.querySelector("[data-column-node][data-rank='1']");
        if (card) fireEvent.contextMenu(card, { clientX: 10, clientY: 10 });
        const swap = Array.from(container.querySelectorAll("button")).find(
            (b) => b.textContent?.trim() === "Swap champion"
        );
        expect(swap).toBeDefined();
        if (swap) fireEvent.click(swap);
        key("/");
        expect(container.querySelector("[data-palette]")).toBeNull();
    });
    test("archive mode: read-only timeline, no pill, no palette, the archive card instead of columns", () => {
        const { container, viewGame } = mount([...ITEM5_ORDER, "Pantheon"], emptyTree, {
            archive: true
        });
        expect(container.querySelector("[data-reviewing-game]")?.textContent).toContain(
            "Reviewing Game 1"
        );
        expect(container.querySelector("[data-engine-status]")).toBeNull();
        expect(container.querySelector("[data-next-slot='true']")).toBeNull();
        expect(
            container.querySelectorAll("[data-timeline-slot][data-filled='true']")
        ).toHaveLength(20);
        expect(container.querySelector("[data-archive-card]")?.textContent).toContain(
            "Game 1 complete"
        );
        expect(container.querySelector("[data-column]")).toBeNull();
        const back = container.querySelector("[data-back-to-current]");
        if (back) fireEvent.click(back);
        expect(viewGame).toHaveBeenCalledWith(null);
        key("/");
        expect(container.querySelector("[data-palette]")).toBeNull();
    });
});
