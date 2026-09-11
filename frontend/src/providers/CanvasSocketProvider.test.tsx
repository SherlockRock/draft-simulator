// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@solidjs/testing-library";
import { createEffect, createSignal } from "solid-js";
import { EventEmitter } from "node:events";
import type { DraftPickAck, DraftPickMutation } from "@draft-sim/shared-types";
import {
    CanvasSocketProvider,
    useCanvasSocket,
    type CanvasSocketContextValue
} from "./CanvasSocketProvider";

class SocketEmitter extends EventEmitter {
    off(event: string | symbol, listener?: (...args: unknown[]) => void) {
        return listener ? super.off(event, listener) : this.removeAllListeners(event);
    }
}
class FakeSocket extends SocketEmitter {
    connected = false;
    active = true;
    io = new SocketEmitter();
    requests: {
        request: DraftPickMutation;
        reply: (error: Error | null, result?: DraftPickAck) => void;
    }[] = [];
    connect() {
        this.connected = true;
        this.emit("connect");
    }
    disconnect() {
        this.connected = false;
        this.emit("disconnect", "transport close");
    }
    timeout() {
        return {
            emit: (
                _event: string,
                request: DraftPickMutation,
                reply: (error: Error | null, result?: DraftPickAck) => void
            ) => {
                this.requests.push({ request, reply });
            }
        };
    }
}
let socket: FakeSocket;
let user: () => { id: string } | undefined;
vi.mock("./socketUtils", () => ({ createAuthenticatedSocket: () => socket }));
vi.mock("../userProvider", () => ({ useUser: () => () => [user] }));
vi.mock("@solidjs/router", () => ({
    useParams: () => ({ id: "canvas" }),
    useNavigate: () => vi.fn()
}));

const initial = {
    id: "7ebb27f4-2a62-478e-91d0-b056de9ba936",
    picks: Array(20).fill(""),
    picksVersion: 0
};
initial.picks[10] = "Ahri";
function setup() {
    const [identity, setIdentity] = createSignal<{ id: string }>();
    user = identity;
    setIdentity({ id: "user" });
    let context: CanvasSocketContextValue | undefined;
    let reloads = 0;
    function Child() {
        context = useCanvasSocket();
        const ctx = context;
        createEffect(() => {
            if (ctx.justReconnected()) {
                reloads++;
                ctx.clearReconnected();
            }
        });
        return <div>Canvas</div>;
    }
    const view = render(() => (
        <CanvasSocketProvider>
            <Child />
        </CanvasSocketProvider>
    ));
    if (!context) throw new Error("Provider did not mount");
    return {
        ...view,
        ctx: context,
        reloads: () => reloads,
        logout: () => setIdentity(undefined)
    };
}
beforeEach(() => {
    socket = new FakeSocket();
});
afterEach(() => {
    cleanup();
    vi.useRealTimers();
});

describe("Canvas socket recovery", () => {
    it("waits for namespace connection and requests exactly one reload", () => {
        const app = setup();
        socket.connect();
        expect(app.reloads()).toBe(0);
        socket.disconnect();
        socket.io.emit("reconnect", 1);
        expect(app.ctx.connectionStatus()).toBe("disconnected");
        expect(app.reloads()).toBe(0);
        socket.connect();
        expect(app.reloads()).toBe(1);
        expect(app.ctx.connectionStatus()).toBe("connected");
    });

    it("resyncs once when the first connection only succeeded after retries", () => {
        const app = setup();
        socket.io.emit("reconnect_attempt", 1);
        expect(app.ctx.connectionStatus()).toBe("connecting");
        socket.connect();
        expect(app.reloads()).toBe(1);
        socket.disconnect();
        socket.connect();
        expect(app.reloads()).toBe(2);
    });

    it("leaves the connecting state when the namespace refuses the connection", () => {
        const app = setup();
        socket.io.emit("reconnect_attempt", 1);
        // Transport-level failures keep the Manager retrying: stay connecting.
        socket.emit("connect_error", new Error("xhr poll error"));
        expect(app.ctx.connectionStatus()).toBe("connecting");
        // A namespace rejection will not be retried by the Manager.
        socket.active = false;
        socket.emit("connect_error", new Error("Authentication failed"));
        expect(app.ctx.connectionStatus()).toBe("error");
    });

    it("preserves an unsaved pick across disconnect and retries with the same mutation ID", () => {
        const app = setup();
        socket.connect();
        app.ctx.pickSync.edit(initial, [{ index: 10, championId: "Orianna" }]);
        // In-flight and queued saves show nothing; only failures surface.
        expect(app.ctx.pickSync.pendingCount()).toBe(1);
        expect(app.queryByRole("alert")).toBeNull();
        const original = socket.requests[0].request;
        socket.disconnect();
        expect(app.queryByRole("alert")).toBeNull();
        socket.connect();
        expect(socket.requests[1].request).toEqual(original);
        expect(app.ctx.pickSync.merge(initial).picks[10]).toBe("Orianna");
        const saved = { ...initial, picks: [...initial.picks], picksVersion: 1 };
        saved.picks[10] = "Orianna";
        socket.requests[1].reply(null, {
            ok: true,
            mutationId: original.mutationId,
            draft: saved
        });
        expect(app.ctx.pickSync.pendingCount()).toBe(0);
        socket.emit("draftUpdate", initial);
        expect(app.ctx.pickSync.merge(initial).picks[10]).toBe("Orianna");
    });

    it("shows a rejected save and lets the user discard it explicitly", () => {
        const app = setup();
        socket.connect();
        app.ctx.pickSync.edit(initial, [{ index: 10, championId: "Orianna" }]);
        const sent = socket.requests[0];
        sent.reply(null, {
            ok: false,
            mutationId: sent.request.mutationId,
            code: "DRAFT_LOCKED",
            message: "Draft is locked"
        });
        expect(app.getByText("Draft is locked")).toBeTruthy();
        expect(app.ctx.pickSync.merge(initial).picks[10]).toBe("Orianna");
        fireEvent.click(app.getByRole("button", { name: "Discard unsaved changes" }));
        expect(app.ctx.pickSync.merge(initial).picks[10]).toBe("Ahri");
        expect(app.ctx.pickSync.pendingCount()).toBe(0);
    });

    it("clears queued edits on logout and ignores old acknowledgements", () => {
        const app = setup();
        socket.connect();
        app.ctx.pickSync.edit(initial, [{ index: 10, championId: "Orianna" }]);
        app.logout();
        expect(app.ctx.pickSync.pendingCount()).toBe(0);
        expect(app.ctx.pickSync.merge(initial).picks[10]).toBe("Ahri");
    });
});
