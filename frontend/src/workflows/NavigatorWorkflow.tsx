import { Component, createSignal, createEffect, onCleanup, untrack, JSX } from "solid-js";
import { RouteSectionProps, useLocation, useParams } from "@solidjs/router";
import { z } from "zod";
import toast from "solid-toast";
import {
    NavigatorSessionState,
    NavigatorWorkflowContext,
    NavigatorWorkflowContextValue
} from "../contexts/NavigatorContext";
import {
    NavigatorSocketProvider,
    useNavigatorSocket
} from "../providers/NavigatorSocketProvider";
import { validateSocketEvent } from "../utils/socketValidation";
import { Socket } from "socket.io-client";

const NavigatorDraftDataSchema = z.object({
    id: z.string(),
    session_id: z.string(),
    game_number: z.number(),
    status: z.enum(["active", "completed"]),
    draft_id: z.string().nullable()
});

const NavigatorSessionDataSchema = z.object({
    id: z.string(),
    name: z.string().nullable(),
    user_id: z.string(),
    our_side: z.enum(["blue", "red"]),
    display_pool: z.array(z.string()),
    search_pool: z.array(z.string()),
    opponent_pool: z.array(z.string()).nullable(),
    fearless: z.boolean(),
    status: z.enum(["setup", "active", "completed"]),
    NavigatorDrafts: z.array(NavigatorDraftDataSchema).optional(),
    createdAt: z.string(),
    updatedAt: z.string()
});

const NavigatorEventDataSchema = z.object({
    id: z.string(),
    navigator_draft_id: z.string(),
    event_type: z.enum([
        "ban",
        "pick",
        "what_if_pick",
        "what_if_ban",
        "engine_result"
    ]),
    slot: z.number(),
    side: z.enum(["blue", "red"]),
    champion_id: z.string(),
    user_injected: z.boolean(),
    createdAt: z.string()
});

const NavigatorSnapshotDataSchema = z.object({
    id: z.string(),
    navigator_draft_id: z.string(),
    after_event_id: z.string().nullable(),
    tree: z.unknown(),
    scenarios: z.array(z.unknown()),
    meta: z
        .object({
            nodesEvaluated: z.number(),
            computeTimeMs: z.number(),
            pruningRate: z.number(),
            depthReached: z.number(),
            transpositionsFound: z.number()
        })
        .nullable(),
    createdAt: z.string()
});

const NavigatorJoinResponseSchema = z.object({
    success: z.boolean(),
    session: NavigatorSessionDataSchema.nullable().optional(),
    draft: NavigatorDraftDataSchema.nullable().optional(),
    events: z.array(NavigatorEventDataSchema).optional(),
    snapshot: NavigatorSnapshotDataSchema.nullable().optional()
});

const NavigatorDraftUpdateSchema = z.object({
    session: NavigatorSessionDataSchema.optional(),
    draft: NavigatorDraftDataSchema.nullable().optional(),
    events: z.array(NavigatorEventDataSchema).optional(),
    snapshot: NavigatorSnapshotDataSchema.nullable().optional()
});

const NavigatorErrorSchema = z.object({
    error: z.string()
});

const initialNavigatorState = (): NavigatorSessionState => ({
    session: null,
    draft: null,
    events: [],
    snapshot: null,
    connected: false,
    error: null
});

const NavigatorWorkflow: Component<RouteSectionProps> = (props) => {
    return (
        <NavigatorSocketProvider>
            <NavigatorWorkflowInner>{props.children}</NavigatorWorkflowInner>
        </NavigatorSocketProvider>
    );
};

const NavigatorWorkflowInner: Component<{ children?: JSX.Element }> = (props) => {
    const params = useParams();
    const location = useLocation();
    const {
        socket: socketAccessor,
        connectionStatus: connectionStatusAccessor,
        justReconnected,
        clearReconnected
    } = useNavigatorSocket();

    const [navigatorContext, setNavigatorContext] =
        createSignal<NavigatorSessionState>(initialNavigatorState());
    const [pendingJoin, setPendingJoin] = createSignal<string | null>(null);
    const [currentSocket, setCurrentSocket] = createSignal<Socket | undefined>(
        undefined
    );
    const [currentSessionId, setCurrentSessionId] = createSignal<string | null>(null);
    let socketWithListeners: Socket | undefined = undefined;

    const getActiveSessionId = () =>
        navigatorContext().session?.id ?? params.sessionId ?? null;

    const resetNavigatorContext = () => {
        setNavigatorContext(initialNavigatorState());
    };

    const joinSession = (sessionId: string) => {
        const sock = currentSocket();
        if (!sock || !sock.connected) {
            return;
        }

        setPendingJoin(sessionId);
        sock.emit("navigatorJoin", { sessionId });
    };

    const leaveSession = () => {
        const sock = currentSocket();
        const sessionId = getActiveSessionId();

        if (sock && sessionId) {
            sock.emit("navigatorLeave", { sessionId });
        }

        setPendingJoin(null);
        resetNavigatorContext();
    };

    const handleJoinResponse = (rawData: unknown) => {
        const response = validateSocketEvent(
            "navigatorJoinResponse",
            rawData,
            NavigatorJoinResponseSchema
        );
        if (!response) return;

        if (!response.success || !response.session) {
            resetNavigatorContext();
            setNavigatorContext((prev) => ({
                ...prev,
                error: "Failed to join navigator session"
            }));
            setPendingJoin(null);
            toast.error("Failed to join navigator session");
            return;
        }

        setNavigatorContext({
            session: response.session,
            draft: response.draft ?? null,
            events: response.events ?? [],
            snapshot: response.snapshot ?? null,
            connected: true,
            error: null
        });
        setCurrentSessionId(response.session.id);
        setPendingJoin(null);
    };

    const handleDraftUpdate = (rawData: unknown) => {
        const data = validateSocketEvent(
            "navigatorDraftUpdate",
            rawData,
            NavigatorDraftUpdateSchema
        );
        if (!data) return;

        const activeSessionId = untrack(currentSessionId);
        const payloadSessionId = data.session?.id ?? data.draft?.session_id ?? null;

        if (activeSessionId && payloadSessionId && payloadSessionId !== activeSessionId) {
            return;
        }

        setNavigatorContext((prev) => ({
            session: data.session ?? prev.session,
            draft: data.draft === undefined ? prev.draft : data.draft,
            events: data.events ?? prev.events,
            snapshot: data.snapshot === undefined ? prev.snapshot : data.snapshot,
            connected: true,
            error: null
        }));
    };

    const handleError = (rawData: unknown) => {
        const data = validateSocketEvent(
            "navigatorError",
            rawData,
            NavigatorErrorSchema
        );
        if (!data) return;

        setPendingJoin(null);
        setNavigatorContext((prev) => ({
            ...prev,
            error: data.error
        }));
        toast.error(data.error);
    };

    createEffect(() => {
        const sock = socketAccessor();
        const connectionStatus = connectionStatusAccessor();

        if (!sock) {
            setCurrentSocket(undefined);
            return;
        }

        if (!sock.connected || connectionStatus !== "connected") {
            return;
        }

        setCurrentSocket(sock);

        if (socketWithListeners === sock) {
            return;
        }

        sock.on("navigatorJoinResponse", handleJoinResponse);
        sock.on("navigatorDraftUpdate", handleDraftUpdate);
        sock.on("navigatorError", handleError);

        socketWithListeners = sock;

        onCleanup(() => {
            if (socketWithListeners === sock) {
                socketWithListeners = undefined;
            }

            sock.off("navigatorJoinResponse");
            sock.off("navigatorDraftUpdate");
            sock.off("navigatorError");
        });
    });

    createEffect(() => {
        const sessionId = params.sessionId ?? null;
        const previousSessionId = untrack(currentSessionId);

        if (previousSessionId && previousSessionId !== sessionId) {
            const sock = untrack(currentSocket);
            if (sock) {
                sock.emit("navigatorLeave", { sessionId: previousSessionId });
            }

            setPendingJoin(null);
            resetNavigatorContext();
        }

        setCurrentSessionId(sessionId);
    });

    createEffect(() => {
        if (!justReconnected()) return;

        const sessionId = currentSessionId();
        if (sessionId) {
            joinSession(sessionId);
        }
        clearReconnected();
    });

    createEffect(() => {
        const sessionId = params.sessionId;
        const sock = currentSocket();
        const connectionStatus = connectionStatusAccessor();
        const context = navigatorContext();

        if (!sessionId || !sock || !sock.connected || connectionStatus !== "connected") {
            return;
        }

        if (pendingJoin() === sessionId) {
            return;
        }

        if (context.connected && context.session?.id === sessionId) {
            return;
        }

        joinSession(sessionId);
    });

    createEffect(() => {
        const isNavigatorRoute = location.pathname.startsWith("/navigator");

        if (!isNavigatorRoute && navigatorContext().connected) {
            leaveSession();
        }
    });

    const emitPick = (draftId: string, championId: string, slot: number) => {
        const sock = currentSocket();
        const sessionId = getActiveSessionId();

        if (!sock || !sessionId) return;

        sock.emit("navigatorPick", {
            sessionId,
            draftId,
            championId,
            slot
        });
    };

    const emitBan = (draftId: string, championId: string, slot: number) => {
        const sock = currentSocket();
        const sessionId = getActiveSessionId();

        if (!sock || !sessionId) return;

        sock.emit("navigatorBan", {
            sessionId,
            draftId,
            championId,
            slot
        });
    };

    const emitUndo = (draftId: string) => {
        const sock = currentSocket();
        const sessionId = getActiveSessionId();

        if (!sock || !sessionId) return;

        sock.emit("navigatorUndo", {
            sessionId,
            draftId
        });
    };

    const startDraft = () => {
        const sock = currentSocket();
        const sessionId = getActiveSessionId();

        if (!sock || !sessionId) return;

        sock.emit("navigatorStartDraft", { sessionId });
    };

    const nextGame = () => {
        const sock = currentSocket();
        const sessionId = getActiveSessionId();

        if (!sock || !sessionId) return;

        sock.emit("navigatorNextGame", { sessionId });
    };

    const contextValue: NavigatorWorkflowContextValue = {
        navigatorContext,
        joinSession,
        leaveSession,
        emitPick,
        emitBan,
        emitUndo,
        startDraft,
        nextGame
    };

    return (
        <NavigatorWorkflowContext.Provider value={contextValue}>
            {props.children}
        </NavigatorWorkflowContext.Provider>
    );
};

export default NavigatorWorkflow;
