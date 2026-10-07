// @vitest-environment jsdom
import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, render } from "@solidjs/testing-library";
import { EventEmitter } from "node:events";
import type { Location, Params } from "@solidjs/router";
import type { JSX } from "solid-js";
import type {
    NavigatorDraftData,
    NavigatorEventData,
    NavigatorSessionData,
    NavigatorWorkflowContextValue
} from "../contexts/NavigatorContext";
import { useNavigatorContext } from "../contexts/NavigatorContext";
import { TURN_SEQUENCE } from "../utils/turnSequence";
import NavigatorWorkflow from "./NavigatorWorkflow";

// The workflow's handlers are the only consumer of the pure progress rules
// (navigatorProgress.ts); this file proves the CALL SITE — a real
// `navigatorDraftUpdate` / `navigatorEngineHeartbeat` sequence over a fake
// socket, asserted through the context the drafting view reads.

class SocketEmitter extends EventEmitter {
    off(event: string | symbol, listener?: (...args: unknown[]) => void) {
        return listener ? super.off(event, listener) : this.removeAllListeners(event);
    }
}
class FakeSocket extends SocketEmitter {
    connected = true;
}
let socket: FakeSocket;

vi.mock("../providers/NavigatorSocketProvider", () => ({
    NavigatorSocketProvider: (props: { children?: JSX.Element }) => <>{props.children}</>,
    useNavigatorSocket: () => ({
        socket: () => socket,
        connectionStatus: () => "connected",
        justReconnected: () => false,
        clearReconnected: vi.fn()
    })
}));
vi.mock("@solidjs/router", () => ({
    useParams: () => ({ sessionId: "s1" }),
    useLocation: () => ({ pathname: "/navigator/s1" })
}));
vi.mock("solid-toast", () => ({ default: { error: vi.fn(), success: vi.fn() } }));

afterEach(cleanup);

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
    createdAt: "2026-09-23T00:00:00.000Z",
    updatedAt: "2026-09-23T00:00:00.000Z"
};
const draft: NavigatorDraftData = {
    id: "draft-1",
    session_id: "s1",
    game_number: 1,
    status: "active",
    our_side_override: null,
    draft_id: null
};
function events(order: string[], draftId = "draft-1"): NavigatorEventData[] {
    return order.map((champion_id, slot) => ({
        id: `${draftId}-e${slot}`,
        navigator_draft_id: draftId,
        event_type: TURN_SEQUENCE[slot].type,
        slot,
        side: TURN_SEQUENCE[slot].side,
        champion_id,
        user_injected: false,
        createdAt: new Date(1700000000000 + slot).toISOString()
    }));
}
const joined = (evs: NavigatorEventData[]) => ({
    success: true,
    session,
    draft,
    events: evs,
    snapshot: null
});
const heartbeat = (afterEventId: string | null, draftId = "draft-1") => ({
    draftId,
    afterEventId,
    depthPainted: 0,
    depthInProgress: 1,
    nodes: 120,
    elapsedMs: 400
});

const location: Location = {
    pathname: "/navigator/s1",
    search: "",
    hash: "",
    query: {},
    state: null,
    key: ""
};
const params: Params = { sessionId: "s1" };

function mount() {
    socket = new FakeSocket();
    let captured: NavigatorWorkflowContextValue | undefined;
    const Child = () => {
        captured = useNavigatorContext();
        return <div>child</div>;
    };
    render(() => (
        <NavigatorWorkflow params={params} location={location} data={undefined}>
            <Child />
        </NavigatorWorkflow>
    ));
    if (!captured) throw new Error("workflow context was not provided");
    return { ctx: captured, socket };
}

describe("NavigatorWorkflow — failed compute (target note D10 item 2)", () => {
    test("an explicit `snapshot: null` on the same state ends computing, drops the heartbeat and reads failed", () => {
        const { ctx, socket } = mount();
        const evs = events(["Aatrox"]);
        socket.emit("navigatorJoinResponse", joined(evs));
        expect(ctx.isComputing()).toBe(true); // no snapshot yet for one event
        socket.emit("navigatorEngineHeartbeat", heartbeat(evs[0].id));
        expect(ctx.engineHeartbeat()).not.toBeNull();

        socket.emit("navigatorDraftUpdate", { draft, events: evs, snapshot: null });

        expect(ctx.computeFailed()).toBe(true);
        expect(ctx.isComputing()).toBe(false);
        expect(ctx.engineHeartbeat()).toBeNull();
    });

    test("a heartbeat for the same state (a new compute) clears the failure", () => {
        const { ctx, socket } = mount();
        const evs = events(["Aatrox"]);
        socket.emit("navigatorJoinResponse", joined(evs));
        socket.emit("navigatorDraftUpdate", { draft, events: evs, snapshot: null });
        expect(ctx.computeFailed()).toBe(true);

        socket.emit("navigatorEngineHeartbeat", heartbeat(evs[0].id));

        expect(ctx.computeFailed()).toBe(false);
        expect(ctx.isComputing()).toBe(true);
    });

    test("an interim update with a new event (snapshot omitted) clears the failure and computes again", () => {
        const { ctx, socket } = mount();
        const one = events(["Aatrox"]);
        socket.emit("navigatorJoinResponse", joined(one));
        socket.emit("navigatorDraftUpdate", { draft, events: one, snapshot: null });
        expect(ctx.computeFailed()).toBe(true);

        socket.emit("navigatorDraftUpdate", {
            draft,
            events: events(["Aatrox", "Ahri"])
        });

        expect(ctx.computeFailed()).toBe(false);
        expect(ctx.isComputing()).toBe(true);
    });

    test("the next-game update (`snapshot: null` with a draft change) is not a failure", () => {
        const { ctx, socket } = mount();
        const one = events(["Aatrox"]);
        socket.emit("navigatorJoinResponse", joined(one));

        socket.emit("navigatorDraftUpdate", {
            session,
            draft: { ...draft, id: "draft-2", game_number: 2 },
            events: [],
            snapshot: null
        });

        expect(ctx.computeFailed()).toBe(false);
        expect(ctx.isComputing()).toBe(false); // zero events
    });
});
