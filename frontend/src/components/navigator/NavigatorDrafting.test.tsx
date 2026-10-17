// @vitest-environment jsdom
import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render } from "@solidjs/testing-library";
import { QueryClient, QueryClientProvider } from "@tanstack/solid-query";
import { createSignal } from "solid-js";
import type {
    NavigatorCompletedGame,
    NavigatorEventData,
    NavigatorSessionData,
    NavigatorSessionState,
    NavigatorTreeNode,
    NavigatorWorkflowContextValue
} from "../../contexts/NavigatorContext";
import { NavigatorWorkflowContext } from "../../contexts/NavigatorContext";
import item5 from "../../utils/__fixtures__/navigator-item5-shares-snapshot.json";
import { NavigatorTreeNodeSchema } from "../../utils/navigatorTreeSchema";
import { eventsToConfirmedTurns, synthesizeFullTree } from "../../utils/treeReconcile";
import { TURN_SEQUENCE } from "../../utils/turnSequence";
import NavigatorDrafting from "./NavigatorDrafting";

// The seat rows and the role module solve on the FROZEN 2026-10-10 share table, the table the
// item5 shares snapshot was captured on (plan-level decision 2); the live champions.json
// follows the latest patch.
vi.mock("../../data/champions.json", async () => ({
    default: (await import("../../utils/__fixtures__/champions-2026-10-10-shares.json"))
        .default
}));

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
// Red Jinx + Aphelios: both `playable: [BOTTOM]` only, so no playable seating exists (design § 7).
// 9 events → Blue Pick 2 next; the empty fan carries red's reason although it is Blue's turn.
const INFEASIBLE_ORDER = [
    "Ashe",
    "Twitch",
    "Caitlyn",
    "Jhin",
    "Kaisa",
    "Draven",
    "Gragas",
    "Jinx",
    "Aphelios"
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
const session: NavigatorSessionData = {
    id: "s1",
    name: "Tour",
    user_id: "u",
    our_side: "red",
    blue_pool: {
        display: {
            top: ["Gragas", "Shen"],
            jungle: ["Hecarim"],
            mid: ["Akali"],
            adc: ["Xayah"],
            support: ["Shen", "Braum"]
        },
        search: ["Gragas", "Shen", "Hecarim", "Akali", "Xayah", "Braum"]
    },
    red_pool: {
        display: {
            top: ["Pantheon", "Poppy", "Sejuani"],
            jungle: ["Sylas", "Poppy", "Sejuani"],
            mid: ["Swain", "Lissandra", "Sylas"],
            adc: ["Tristana", "Jinx", "Ashe"],
            support: ["Swain", "Taric", "TahmKench", "Pantheon"]
        },
        search: [
            "Pantheon",
            "Poppy",
            "Sejuani",
            "Sylas",
            "Swain",
            "Lissandra",
            "Tristana",
            "Jinx",
            "Ashe",
            "Taric",
            "TahmKench"
        ]
    },
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
    initialEngineTree: NavigatorTreeNode,
    opts: {
        computing?: boolean;
        archive?: boolean;
        failed?: boolean;
        budgetHit?: boolean;
        treeOrder?: string[];
    } = {}
) {
    const computing = opts.computing ?? false;
    const failed = opts.failed ?? false;
    const [evs, setEvs] = createSignal(events(order));
    const [error, setError] = createSignal<string | null>(null);
    const [snapshotSeq, setSnapshotSeq] = createSignal(0);
    const [engineTree, setEngineTree] = createSignal(initialEngineTree);
    const meta = {
        nodesEvaluated: 1,
        computeTimeMs: 371,
        pruningRate: 0,
        depthReached: 8,
        transpositionsFound: 0,
        budgetHit: opts.budgetHit === true
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
        events: [],
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
    const stateOf = (): NavigatorSessionState => ({
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
        events: evs(),
        snapshot: {
            source: "persisted",
            id: `snap-${snapshotSeq()}`,
            navigator_draft_id: "draft-1",
            after_event_id: "e18",
            tree: initialEngineTree,
            scenarios: [],
            meta,
            createdAt: null
        },
        completedGames: opts.archive ? [{ ...archiveGame, events: evs() }] : [],
        connected: true,
        error: error()
    });
    const synthetic = () =>
        synthesizeFullTree(
            engineTree(),
            eventsToConfirmedTurns(opts.treeOrder ? events(opts.treeOrder) : evs())
        );
    const emitPickStep = vi.fn();
    const emitBan = vi.fn();
    const emitUndo = vi.fn();
    const viewGame = vi.fn();
    const value: NavigatorWorkflowContextValue = {
        navigatorContext: stateOf,
        syntheticTree: synthetic,
        effectiveScenarios: () => [],
        isComputing: () => computing,
        computeFailed: () => failed,
        currentMeta: () => stateOf().snapshot?.meta ?? null,
        engineHeartbeat: () => null,
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
        createBranch: vi.fn()
    };
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const utils = render(() => (
        <QueryClientProvider client={client}>
            <NavigatorWorkflowContext.Provider value={value}>
                <NavigatorDrafting />
            </NavigatorWorkflowContext.Provider>
        </QueryClientProvider>
    ));
    const pushEvent = (championId: string) =>
        setEvs((prev) => [
            ...prev,
            ...events([...prev.map((e) => e.champion_id), championId]).slice(prev.length)
        ]);
    const popEvent = () => setEvs((prev) => prev.slice(0, -1));
    const bumpSnapshot = () => setSnapshotSeq((n) => n + 1);
    return {
        ...utils,
        emitPickStep,
        emitBan,
        emitUndo,
        viewGame,
        setEngineTree,
        pushEvent,
        popEvent,
        setError,
        bumpSnapshot
    };
}
const key = (k: string) => fireEvent.keyDown(window, { key: k });

describe("NavigatorDrafting (design § 1 rows on the item5 / item7 smoke states)", () => {
    test("item5: header, ready pill, top-1 Pantheon as Sup at 3.43, role-gap strip", () => {
        const { container } = mount(ITEM5_ORDER, item5Tree);
        expect(container.querySelector("[data-drafting-header]")?.textContent).toContain(
            "Pick Phase 2 — Red Pick 5"
        );
        expect(container.querySelector("[data-drafting-header]")?.textContent).toContain(
            "you"
        );
        const pill = container.querySelector("[data-engine-status]");
        expect(pill?.getAttribute("data-engine-status")).toBe("ready");
        expect(pill?.textContent).toBe("● 5 candidates · depth 8 · 371 ms");
        const top1 = container.querySelector(
            "[data-column][data-depth='0'] [data-column-node][data-rank='1']"
        );
        expect(top1?.textContent).toContain("Pantheon");
        const seat = top1?.querySelector("[data-seat-row] [data-seat='support']");
        expect(seat?.getAttribute("data-occupant")).toBe("Pantheon");
        expect(seat?.getAttribute("data-marker")).toBe("candidate");
        expect(
            top1
                ?.querySelector("[data-seat-row] [data-seat='top']")
                ?.getAttribute("data-occupant")
        ).toBe("Sejuani");
        expect(top1?.querySelector("[data-node-score]")?.textContent).toBe("3.43");
        expect(container.querySelector("[data-budget-hint]")).toBeNull(); // meta.budgetHit false
        expect(
            container.querySelectorAll("[data-roles-summary='blue'] [data-open='true']")
        ).toHaveLength(0);
        expect(
            container.querySelectorAll("[data-roles-summary='red'] [data-open='true']")
        ).toHaveLength(1); // support
        expect(
            container
                .querySelector("[data-roles-summary='red'] [data-seat='adc']")
                ?.getAttribute("data-occupant")
        ).toBe("Tristana");
        expect(
            container.querySelectorAll("[data-pick-row][data-filled='true']")
        ).toHaveLength(9);
        expect(
            container.querySelectorAll("[data-ban-slot][data-filled='true']")
        ).toHaveLength(10);
        expect(container.querySelectorAll("[data-tick-state='filled']")).toHaveLength(19);
        expect(
            container.querySelector("[data-tick='19']")?.getAttribute("data-tick-state")
        ).toBe("next");
        expect(
            container
                .querySelector("[data-pick-row='R5']")
                ?.getAttribute("data-next-slot")
        ).toBe("true");
        expect(container.querySelector("[data-timeline-slot]")).toBeNull();
    });
    test("'/' opens the palette centred; the next slot FOCUSES THE POOL SEARCH; the palette's pick stage still commits a tile", () => {
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
        expect(container.querySelector("[data-palette]")).toBeNull();
        expect(document.activeElement).toBe(
            container.querySelector("[data-pool-search]")
        );
        key("/"); // from inside the search box nothing happens…
        expect(container.querySelector("[data-palette]")).toBeNull();
        const search = container.querySelector("[data-pool-search]");
        if (search) fireEvent.keyDown(search, { key: "Escape" }); // …Esc returns focus to the page…
        key("/"); // …and '/' works again; Enter on "Pick for Red Pick 5" closes the palette and focuses the pool search
        key("Enter");
        expect(container.querySelector("[data-palette]")).toBeNull();
        expect(document.activeElement).toBe(
            container.querySelector("[data-pool-search]")
        );
        expect(emitPickStep).not.toHaveBeenCalled();
    });
    test("hover Pick on a column-0 card commits that node; selecting opens nothing further at depth 8 leaves", () => {
        const { container, emitPickStep } = mount(ITEM5_ORDER, item5Tree);
        const commit = container.querySelector(
            "[data-column-node][data-rank='1'] [data-commit='pick']"
        );
        if (commit) fireEvent.click(commit);
        expect(emitPickStep).toHaveBeenCalledWith("draft-1", ["Pantheon"], 19);
    });
    test("selection follows the champion across the FIRST re-rank after mount (execution ruling 2026-09-07)", () => {
        const { container, setEngineTree } = mount(ITEM5_ORDER, item5Tree);
        const taric = container.querySelector(
            "[data-column][data-depth='0'] [data-column-node][data-rank='2']"
        );
        expect(taric?.textContent).toContain("Tahm Kench");
        if (taric) fireEvent.click(taric);
        expect(
            container.querySelector("[data-column-node][data-selected='true']")
                ?.textContent
        ).toContain("Tahm Kench");
        const [first, second, ...rest] = item5Tree.children;
        setEngineTree({ ...item5Tree, children: [second, first, ...rest] }); // Phase-2 re-rank: same events, Tahm Kench now #1
        const selected = container.querySelector(
            "[data-column-node][data-selected='true']"
        );
        expect(selected?.getAttribute("data-rank")).toBe("1");
        expect(selected?.textContent).toContain("Tahm Kench");
    });
    test("a failed compute renders the failed pill (target note D10 item 2)", () => {
        const { container } = mount(ITEM5_ORDER, item5Tree, { failed: true });
        const pill = container.querySelector("[data-engine-status]");
        expect(pill?.getAttribute("data-engine-status")).toBe("failed");
        expect(pill?.textContent).toBe(
            "✕ Engine failed · next pick, ban or undo retries"
        );
    });
    test("infeasible red side: empty pill with the reason, red strip, the empty-fan card's undo remedy", () => {
        const { container, emitUndo } = mount(INFEASIBLE_ORDER, emptyTree);
        const pill = container.querySelector("[data-engine-status]");
        expect(pill?.getAttribute("data-engine-status")).toBe("empty");
        expect(pill?.textContent).toBe(
            "✕ No legal completion — red cannot fill five roles with Jinx, Aphelios · undo or relax pool"
        );
        const summary = container.querySelector(
            "[data-roles-summary='red'] [data-seat-row]"
        );
        expect(summary?.getAttribute("data-infeasible")).toBe("true");
        expect(
            summary?.querySelector("[data-seat='adc']")?.getAttribute("data-count")
        ).toBe("2");
        expect(
            container.querySelector("[data-roles-summary='red'] [data-infeasible-text]")
                ?.textContent
        ).toBe("✕ cannot fill five roles with Jinx, Aphelios");
        expect(
            container
                .querySelector("[data-team-column='blue']")
                ?.getAttribute("data-on-clock")
        ).toBe("true"); // Blue's turn — the red summary is the earlier signal (design § 7)
        const undo = container.querySelector("[data-empty-fan] [data-remedy='undo']");
        if (undo) fireEvent.click(undo);
        expect(emitUndo).toHaveBeenCalledWith("draft-1");
    });
    test("zero confirmed events: the header undo button is disabled and does not emit", () => {
        const { container, emitUndo } = mount([], emptyTree);
        const undo = container.querySelector("button[data-undo]");
        expect(undo?.hasAttribute("disabled")).toBe(true);
        if (undo) fireEvent.click(undo);
        expect(emitUndo).not.toHaveBeenCalled();
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
            container.querySelectorAll("[data-pick-row][data-filled='true']")
        ).toHaveLength(10);
        expect(
            container.querySelectorAll("[data-ban-slot][data-filled='true']")
        ).toHaveLength(10);
        expect(container.querySelector("[data-glow='true']")).toBeNull();
        expect(container.querySelector("[data-pool-panel]")).toBeNull();
        expect(container.querySelector("[data-tick-state='next']")).toBeNull();
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
    test("a ban card's seat row is the OPPONENT's picks with the banned champion slashed (seatRowFor, design § 4)", () => {
        const banNode: NavigatorTreeNode = {
            ...emptyTree,
            championIds: ["Xayah"],
            actionType: "ban",
            phase: "ban2",
            side: "red",
            slots: [12]
        };
        const { container } = mount(ITEM5_ORDER.slice(0, 12), {
            ...emptyTree,
            children: [banNode]
        }); // next = slot 12, Red Ban 4
        const row = container.querySelector(
            "[data-column-node][data-rank='1'] [data-seat-row]"
        );
        expect(
            row?.querySelector("[data-seat='adc']")?.getAttribute("data-occupant")
        ).toBe("Xayah");
        expect(
            row
                ?.querySelector("[data-seat='adc'] [data-seat-ring]")
                ?.getAttribute("data-slash")
        ).toBe("true");
        expect(
            row?.querySelector("[data-seat='top']")?.getAttribute("data-occupant")
        ).toBe("Gragas"); // blue's picks
        expect(
            row?.querySelector("[data-seat='jungle']")?.getAttribute("data-occupant")
        ).toBe("Hecarim");
    });
    test("the budget-hit hint follows the ready pill's budgetHit", () => {
        const { container } = mount(ITEM5_ORDER, item5Tree, { budgetHit: true });
        expect(container.querySelector("[data-engine-status]")?.textContent).toContain(
            "budget hit"
        );
        expect(container.querySelector("[data-budget-hint]")).not.toBeNull();
    });
    test("a pair-pending card: the confirmed half stays in the baseline (no sky marker), only the added half is the candidate", () => {
        const pairNode: NavigatorTreeNode = {
            ...emptyTree,
            championIds: ["Xayah", "Shen"],
            phase: "pick2",
            side: "blue",
            slots: [17, 18],
            confirmedChampionIds: ["Xayah"]
        };
        // 18 events (Xayah confirmed at 17, slot 18 next) over the 17-event spine — the live pair-pending shape.
        const { container } = mount(
            ITEM5_ORDER.slice(0, 18),
            { ...emptyTree, children: [pairNode] },
            { treeOrder: ITEM5_ORDER.slice(0, 17) }
        );
        const row = container.querySelector(
            "[data-column-node][data-rank='1'] [data-seat-row]"
        );
        expect(
            row?.querySelector("[data-seat='adc']")?.getAttribute("data-occupant")
        ).toBe("Xayah");
        expect(row?.querySelector("[data-seat='adc']")?.getAttribute("data-marker")).toBe(
            "none"
        );
        expect(
            row?.querySelector("[data-seat='support']")?.getAttribute("data-occupant")
        ).toBe("Shen");
        expect(
            row?.querySelector("[data-seat='support']")?.getAttribute("data-marker")
        ).toBe("candidate");
    });
    test("type anywhere: a printable key focuses the pool search and appends; typing on, Enter commits the highlighted tile", () => {
        const { container, emitPickStep } = mount(ITEM5_ORDER, item5Tree);
        key("s");
        const search = container.querySelector("[data-pool-search]");
        expect(document.activeElement).toBe(search);
        expect(search instanceof HTMLInputElement ? search.value : "").toBe("s");
        if (search) fireEvent.input(search, { target: { value: "swain" } });
        expect(
            container.querySelector("[data-tile='Swain'][data-highlighted='true']")
        ).not.toBeNull();
        if (search) fireEvent.keyDown(search, { key: "Enter" });
        expect(emitPickStep).toHaveBeenCalledWith("draft-1", ["Swain"], 19);
    });
    test("type anywhere is inert for ctrl/meta/alt chords, non-printable keys, while the palette is open, and while the swap picker is up", () => {
        const { container } = mount(ITEM5_ORDER, item5Tree);
        const search = () => container.querySelector("[data-pool-search]");
        const value = () => {
            const el = search();
            return el instanceof HTMLInputElement ? el.value : "";
        };
        fireEvent.keyDown(window, { key: "c", ctrlKey: true });
        fireEvent.keyDown(window, { key: "c", metaKey: true });
        key(" "); // a leading space never seeds the query (a focused button keeps its Space activation)
        key("ArrowDown");
        key("Enter");
        expect(document.activeElement).not.toBe(search());
        expect(value()).toBe("");
        key("/");
        key("a");
        expect(value()).toBe("");
        key("Escape");
        const card = container.querySelector("[data-column-node][data-rank='1']");
        if (card) fireEvent.contextMenu(card, { clientX: 10, clientY: 10 });
        const swap = Array.from(container.querySelectorAll("button")).find(
            (b) => b.textContent?.trim() === "Swap champion"
        );
        if (swap) fireEvent.click(swap);
        key("a");
        expect(value()).toBe("");
        expect(document.activeElement).not.toBe(search());
    });
    test("Shift is allowed: a capital letter types; apostrophes type", () => {
        const { container } = mount(ITEM5_ORDER, item5Tree);
        fireEvent.keyDown(window, { key: "K", shiftKey: true });
        const search = container.querySelector("[data-pool-search]");
        expect(document.activeElement).toBe(search);
        // The first key focused the box, so the window handler now ignores keys (the box owns them);
        // blur first — the query state is kept — and the next printable key appends again.
        if (search instanceof HTMLElement) search.blur();
        fireEvent.keyDown(window, { key: "'" });
        expect(search instanceof HTMLInputElement ? search.value : "").toBe("K'");
    });
    test("the view override and the query reset at every confirmed event (design § 5)", () => {
        const { container, pushEvent } = mount(ITEM5_ORDER.slice(0, 17), emptyTree); // Blue Pick 4 + 5 next, we are red → enemy
        expect(
            container.querySelector("[data-pool-panel]")?.getAttribute("data-pool-view")
        ).toBe("enemy");
        const all = container.querySelector("[data-pool-view-button='all']");
        if (all) fireEvent.click(all);
        key("x");
        expect(
            container.querySelector("[data-pool-panel]")?.getAttribute("data-pool-view")
        ).toBe("all");
        pushEvent("Xayah"); // the server confirms Blue Pick 4
        expect(
            container.querySelector("[data-pool-panel]")?.getAttribute("data-pool-view")
        ).toBe("enemy");
        const search = container.querySelector("[data-pool-search]");
        expect(search instanceof HTMLInputElement ? search.value : "x").toBe("");
    });
    test("one commit per slot: a double click on a card's Pick emits once; the pool is disabled while committing; a server error re-arms it; the next confirmed event closes the turn", () => {
        const { container, emitPickStep, pushEvent, setError, bumpSnapshot } = mount(
            ITEM5_ORDER,
            item5Tree
        );
        // The card's hover Pick bypasses the panel's disabled tiles — this is the path that proves pendingSlot itself.
        const commit = container.querySelector(
            "[data-column-node][data-rank='1'] [data-commit='pick']"
        );
        if (commit) fireEvent.click(commit);
        if (commit) fireEvent.click(commit);
        expect(emitPickStep).toHaveBeenCalledTimes(1);
        expect(
            container.querySelector("[data-tile='Pantheon']")?.hasAttribute("disabled")
        ).toBe(true); // committing
        bumpSnapshot(); // a streaming snapshot with the same events and error null must NOT release the guard
        expect(
            container.querySelector("[data-tile='Pantheon']")?.hasAttribute("disabled")
        ).toBe(true);
        setError("Champion already taken"); // the server rejected it: the pool re-arms (decision 20)
        expect(
            container.querySelector("[data-tile='Taric']")?.hasAttribute("disabled")
        ).toBe(false);
        const tile = container.querySelector(
            "[data-pool-column='support'] [data-tile='Taric']"
        );
        if (tile) fireEvent.click(tile);
        if (tile) fireEvent.click(tile);
        expect(emitPickStep).toHaveBeenCalledTimes(2);
        pushEvent("Taric");
        expect(
            container
                .querySelector("[data-pool-panel]")
                ?.getAttribute("data-pool-disabled")
        ).toBe("true"); // 20 events: draft complete
    });
    test("Undo back to a committed slot re-arms it (pendingSlot clears with the selection scope)", () => {
        const { container, emitPickStep, pushEvent, popEvent } = mount(
            ITEM5_ORDER.slice(0, 16),
            emptyTree
        ); // Red Pick 4
        const tile = () =>
            container.querySelector("[data-pool-column='adc'] [data-tile='Tristana']");
        const t1 = tile();
        if (t1) fireEvent.click(t1);
        expect(emitPickStep).toHaveBeenCalledTimes(1);
        pushEvent("Tristana"); // the server confirms slot 16
        popEvent(); // Undo: back to slot 16
        expect(tile()?.hasAttribute("disabled")).toBe(false);
        const t2 = tile();
        if (t2) fireEvent.click(t2);
        expect(emitPickStep).toHaveBeenCalledTimes(2);
    });
    test("the pool view defaults per turn: yours on our pick turn, enemy on a ban turn; the toggle overrides", () => {
        const a = mount(ITEM5_ORDER, item5Tree); // Red Pick 5, we are red
        expect(
            a.container.querySelector("[data-pool-panel]")?.getAttribute("data-pool-view")
        ).toBe("yours");
        const all = a.container.querySelector("[data-pool-view-button='all']");
        if (all) fireEvent.click(all);
        expect(
            a.container.querySelector("[data-pool-panel]")?.getAttribute("data-pool-view")
        ).toBe("all");
        cleanup();
        const b = mount(ITEM5_ORDER.slice(0, 12), emptyTree); // Red Ban 4 (slot 12: red bans sit at 1, 3, 5, 12, 14)
        expect(
            b.container.querySelector("[data-pool-panel]")?.getAttribute("data-pool-view")
        ).toBe("enemy");
        expect(b.container.querySelector("[data-pool-title]")?.textContent).toBe(
            "Blue's pool · Ban for Red Ban 4"
        );
        expect(b.container.querySelector("[data-glow='true']")).toBeNull();
        expect(
            b.container.querySelector("[data-tick='12']")?.getAttribute("data-tick-state")
        ).toBe("next");
    });
    test("a fresh pair turn glows both rows; clicking the glowing row focuses the pool search whose header reads 1 of 2", () => {
        const { container } = mount(ITEM5_ORDER.slice(0, 17), emptyTree); // next = 17, Blue Pick 4 + 5
        const glowing = Array.from(container.querySelectorAll("[data-glow='true']")).map(
            (r) => r.getAttribute("data-pick-row")
        );
        expect(glowing).toEqual(["B4", "B5"]);
        const next = container.querySelector("[data-next-slot='true']");
        expect(next?.getAttribute("data-pick-row")).toBe("B4");
        if (next) fireEvent.click(next);
        expect(document.activeElement).toBe(
            container.querySelector("[data-pool-search]")
        );
        expect(container.querySelector("[data-pool-title]")?.textContent).toContain(
            "Blue Pick 4 + Blue Pick 5 — 1 of 2"
        );
        expect(
            container
                .querySelector("[data-team-column='blue']")
                ?.getAttribute("data-on-clock")
        ).toBe("true");
        expect(
            container
                .querySelector("[data-team-column='red']")
                ?.getAttribute("data-on-clock")
        ).toBe("false");
    });
});
