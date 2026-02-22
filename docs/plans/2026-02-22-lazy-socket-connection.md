# Lazy Socket Connection Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Refactor socket connections to be lazy - only connect when entering Canvas or Versus features, disconnect when leaving.

**Architecture:** Create feature-specific socket providers (CanvasSocketProvider, VersusSocketProvider) that manage socket lifecycle. Remove socket from global UserProvider. Remove HeartbeatManager from backend.

**Tech Stack:** SolidJS, Socket.io-client, TypeScript

---

## Task 1: Create shared socket utilities

**Files:**
- Create: `frontend/src/providers/socketUtils.ts`

**Step 1: Create socket utilities file**

```typescript
import { io, Socket } from "socket.io-client";

export type ConnectionStatus = "connecting" | "connected" | "disconnected" | "error";

export type ConnectionInfo = {
    status: ConnectionStatus;
    reconnectAttempts: number;
};

export type SocketContextValue = {
    socket: () => Socket | undefined;
    connectionStatus: () => ConnectionStatus;
    connectionInfo: () => ConnectionInfo;
    reconnect: () => void;
};

const socketOptions = {
    pingInterval: 25000,
    pingTimeout: 5000,
    reconnection: true,
    reconnectionAttempts: 3,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 5000
};

const socketUrl = import.meta.env.VITE_API_URL;

export const createAnonymousSocket = () => io(socketUrl, socketOptions);
export const createAuthenticatedSocket = () =>
    io(socketUrl, { ...socketOptions, withCredentials: true });
```

**Step 2: Verify file created**

Run: `ls -la frontend/src/providers/`
Expected: Directory created with socketUtils.ts

**Step 3: Commit**

```bash
git add frontend/src/providers/socketUtils.ts
git commit -m "feat: add shared socket utilities for lazy providers"
```

---

## Task 2: Create CanvasSocketProvider

**Files:**
- Create: `frontend/src/providers/CanvasSocketProvider.tsx`

**Step 1: Create CanvasSocketProvider**

```typescript
import {
    createContext,
    useContext,
    createSignal,
    createEffect,
    onCleanup,
    JSX,
    createMemo,
    Accessor
} from "solid-js";
import { Socket } from "socket.io-client";
import {
    ConnectionStatus,
    ConnectionInfo,
    SocketContextValue,
    createAuthenticatedSocket
} from "./socketUtils";
import ConnectionBanner from "../ConnectionBanner";

const CanvasSocketContext = createContext<SocketContextValue>();

export function CanvasSocketProvider(props: { children: JSX.Element }) {
    const [socket, setSocket] = createSignal<Socket | undefined>(undefined);
    const [connectionStatus, setConnectionStatus] =
        createSignal<ConnectionStatus>("connecting");
    const [reconnectAttempts, setReconnectAttempts] = createSignal(0);

    const reconnect = () => {
        const sock = socket();
        if (sock) {
            setReconnectAttempts(0);
            setConnectionStatus("connecting");
            sock.connect();
        }
    };

    const connectionInfo = createMemo<ConnectionInfo>(() => ({
        status: connectionStatus(),
        reconnectAttempts: reconnectAttempts()
    }));

    createEffect(() => {
        const newSocket = createAuthenticatedSocket();

        newSocket.on("connect", () => {
            setConnectionStatus("connected");
            setReconnectAttempts(0);
        });

        newSocket.on("disconnect", () => {
            setConnectionStatus("disconnected");
        });

        newSocket.io.on("reconnect", () => {
            setConnectionStatus("connected");
            setReconnectAttempts(0);
        });

        newSocket.io.on("reconnect_attempt", (attemptNumber) => {
            setConnectionStatus("connecting");
            setReconnectAttempts(attemptNumber);
        });

        newSocket.io.on("reconnect_failed", () => {
            setConnectionStatus("error");
        });

        setSocket(newSocket);

        onCleanup(() => {
            newSocket.disconnect();
            newSocket.off("connect");
            newSocket.off("disconnect");
            newSocket.io.off("reconnect");
            newSocket.io.off("reconnect_attempt");
            newSocket.io.off("reconnect_failed");
        });
    });

    const contextValue: SocketContextValue = {
        socket,
        connectionStatus,
        connectionInfo,
        reconnect
    };

    return (
        <CanvasSocketContext.Provider value={contextValue}>
            <ConnectionBanner
                connectionStatus={connectionStatus}
                connectionInfo={connectionInfo}
                onReconnect={reconnect}
            />
            {props.children}
        </CanvasSocketContext.Provider>
    );
}

export function useCanvasSocket(): SocketContextValue {
    const context = useContext(CanvasSocketContext);
    if (!context) {
        throw new Error("useCanvasSocket must be used within CanvasSocketProvider");
    }
    return context;
}
```

**Step 2: Verify file created**

Run: `cat frontend/src/providers/CanvasSocketProvider.tsx | head -20`
Expected: File contents visible

**Step 3: Commit**

```bash
git add frontend/src/providers/CanvasSocketProvider.tsx
git commit -m "feat: add CanvasSocketProvider for lazy canvas socket connections"
```

---

## Task 3: Create VersusSocketProvider

**Files:**
- Create: `frontend/src/providers/VersusSocketProvider.tsx`

**Step 1: Create VersusSocketProvider**

```typescript
import {
    createContext,
    useContext,
    createSignal,
    createEffect,
    onCleanup,
    JSX,
    createMemo
} from "solid-js";
import { Socket } from "socket.io-client";
import {
    ConnectionStatus,
    ConnectionInfo,
    SocketContextValue,
    createAuthenticatedSocket,
    createAnonymousSocket
} from "./socketUtils";
import { useUser } from "../userProvider";
import ConnectionBanner from "../ConnectionBanner";

const VersusSocketContext = createContext<SocketContextValue>();

export function VersusSocketProvider(props: { children: JSX.Element }) {
    const accessor = useUser();
    const [user] = accessor();

    const [socket, setSocket] = createSignal<Socket | undefined>(undefined);
    const [connectionStatus, setConnectionStatus] =
        createSignal<ConnectionStatus>("connecting");
    const [reconnectAttempts, setReconnectAttempts] = createSignal(0);

    const reconnect = () => {
        const sock = socket();
        if (sock) {
            setReconnectAttempts(0);
            setConnectionStatus("connecting");
            sock.connect();
        }
    };

    const connectionInfo = createMemo<ConnectionInfo>(() => ({
        status: connectionStatus(),
        reconnectAttempts: reconnectAttempts()
    }));

    createEffect(() => {
        // Create authenticated socket if user is logged in, anonymous otherwise
        const currentUser = user();
        const newSocket = currentUser
            ? createAuthenticatedSocket()
            : createAnonymousSocket();

        newSocket.on("connect", () => {
            setConnectionStatus("connected");
            setReconnectAttempts(0);
        });

        newSocket.on("disconnect", () => {
            setConnectionStatus("disconnected");
        });

        newSocket.io.on("reconnect", () => {
            setConnectionStatus("connected");
            setReconnectAttempts(0);
        });

        newSocket.io.on("reconnect_attempt", (attemptNumber) => {
            setConnectionStatus("connecting");
            setReconnectAttempts(attemptNumber);
        });

        newSocket.io.on("reconnect_failed", () => {
            setConnectionStatus("error");
        });

        setSocket(newSocket);

        onCleanup(() => {
            newSocket.disconnect();
            newSocket.off("connect");
            newSocket.off("disconnect");
            newSocket.io.off("reconnect");
            newSocket.io.off("reconnect_attempt");
            newSocket.io.off("reconnect_failed");
        });
    });

    const contextValue: SocketContextValue = {
        socket,
        connectionStatus,
        connectionInfo,
        reconnect
    };

    return (
        <VersusSocketContext.Provider value={contextValue}>
            <ConnectionBanner
                connectionStatus={connectionStatus}
                connectionInfo={connectionInfo}
                onReconnect={reconnect}
            />
            {props.children}
        </VersusSocketContext.Provider>
    );
}

export function useVersusSocket(): SocketContextValue {
    const context = useContext(VersusSocketContext);
    if (!context) {
        throw new Error("useVersusSocket must be used within VersusSocketProvider");
    }
    return context;
}
```

**Step 2: Commit**

```bash
git add frontend/src/providers/VersusSocketProvider.tsx
git commit -m "feat: add VersusSocketProvider for lazy versus socket connections"
```

---

## Task 4: Update ConnectionBanner to accept props

**Files:**
- Modify: `frontend/src/ConnectionBanner.tsx`

**Step 1: Update ConnectionBanner to accept props instead of using useUser**

Replace entire file content:

```typescript
import { Show, Accessor } from "solid-js";
import { ConnectionStatus, ConnectionInfo } from "./providers/socketUtils";

type Props = {
    connectionStatus: Accessor<ConnectionStatus>;
    connectionInfo: Accessor<ConnectionInfo>;
    onReconnect: () => void;
};

const ConnectionBanner = (props: Props) => {
    return (
        <Show when={props.connectionStatus() !== "connected"}>
            <div
                class="flex items-center justify-center gap-4 p-3 text-center font-bold text-slate-50"
                classList={{
                    "bg-yellow-600": props.connectionStatus() === "connecting",
                    "bg-red-600":
                        props.connectionStatus() === "disconnected" ||
                        props.connectionStatus() === "error"
                }}
            >
                <div class="flex items-center gap-2">
                    <Show when={props.connectionStatus() === "connecting"}>
                        <svg
                            class="h-5 w-5 animate-spin"
                            xmlns="http://www.w3.org/2000/svg"
                            fill="none"
                            viewBox="0 0 24 24"
                        >
                            <circle
                                class="opacity-25"
                                cx="12"
                                cy="12"
                                r="10"
                                stroke="currentColor"
                                stroke-width="4"
                            />
                            <path
                                class="opacity-75"
                                fill="currentColor"
                                d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                            />
                        </svg>
                        <span>
                            Reconnecting to server
                            <Show when={props.connectionInfo().reconnectAttempts > 0}>
                                {" "}
                                (attempt {props.connectionInfo().reconnectAttempts})
                            </Show>
                            ...
                        </span>
                    </Show>
                    <Show when={props.connectionStatus() === "disconnected"}>
                        <svg
                            class="h-5 w-5"
                            xmlns="http://www.w3.org/2000/svg"
                            fill="none"
                            viewBox="0 0 24 24"
                            stroke="currentColor"
                        >
                            <path
                                stroke-linecap="round"
                                stroke-linejoin="round"
                                stroke-width="2"
                                d="M18.364 5.636a9 9 0 010 12.728m0 0l-2.829-2.829m2.829 2.829L21 21M15.536 8.464a5 5 0 010 7.072m0 0l-2.829-2.829m-4.243 2.829a4.978 4.978 0 01-1.414-2.83m-1.414 5.658a9 9 0 01-2.167-9.238m7.824 2.167a1 1 0 111.414 1.414m-1.414-1.414L3 3"
                            />
                        </svg>
                        <span>Disconnected from server</span>
                    </Show>
                    <Show when={props.connectionStatus() === "error"}>
                        <svg
                            class="h-5 w-5"
                            xmlns="http://www.w3.org/2000/svg"
                            fill="none"
                            viewBox="0 0 24 24"
                            stroke="currentColor"
                        >
                            <path
                                stroke-linecap="round"
                                stroke-linejoin="round"
                                stroke-width="2"
                                d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
                            />
                        </svg>
                        <span>Connection error</span>
                    </Show>
                </div>
                <Show
                    when={
                        props.connectionStatus() === "error" ||
                        props.connectionStatus() === "disconnected"
                    }
                >
                    <button
                        onClick={props.onReconnect}
                        class="rounded-md bg-white/20 px-3 py-1 text-sm font-medium transition-colors hover:bg-white/30"
                    >
                        Reconnect
                    </button>
                </Show>
            </div>
        </Show>
    );
};

export default ConnectionBanner;
```

**Step 2: Commit**

```bash
git add frontend/src/ConnectionBanner.tsx
git commit -m "refactor: update ConnectionBanner to accept props instead of using useUser"
```

---

## Task 5: Remove socket from UserProvider

**Files:**
- Modify: `frontend/src/userProvider.tsx`

**Step 1: Remove socket-related imports and code**

The file needs these changes:
1. Remove `io, Socket` import
2. Remove `ConnectionStatus`, `ConnectionInfo` types (now in socketUtils)
3. Remove `currentSocket`, `connectionStatus`, `reconnectAttempts` signals
4. Remove `manualReconnect` function
5. Remove socket creation `createEffect`
6. Remove socket options and creation functions
7. Change `UserContextValue` to 2-tuple: `[UserAccessor, UserActions]`

New file content:

```typescript
import {
    Accessor,
    createContext,
    createMemo,
    useContext,
    JSX,
    createEffect,
    createSignal
} from "solid-js";
import { useQuery, useQueryClient } from "@tanstack/solid-query";
import { fetchUserDetails, handleGoogleLogin, handleRevoke } from "./utils/actions";
import { useNavigate } from "@solidjs/router";
import { syncLocalCanvasToServer } from "./utils/syncLocalCanvas";
import toast from "solid-toast";

export type UserData = {
    id: string;
    name: string;
    email: string;
    picture: string;
};

export interface UserAccessor {
    (): UserData | null | undefined;
    isLoading: boolean;
    loading: boolean;
    isError: boolean;
    error: Error | null;
}

export interface UserActions {
    login: (code: string, state: string) => Promise<UserData | undefined>;
    logout: () => Promise<void>;
    refetch: () => void;
}

export type UserContextValue = [UserAccessor, UserActions];

const UserContext = createContext<Accessor<UserContextValue>>();

export function UserProvider(props: { children: JSX.Element }) {
    const navigate = useNavigate();
    const queryClient = useQueryClient();

    const isOAuthCallback = () => window.location.pathname.includes("/oauth2callback");

    const userQuery = useQuery(() => {
        const enabled = !isOAuthCallback();

        return {
            queryKey: ["user"],
            queryFn: fetchUserDetails,
            enabled: enabled,
            staleTime: 1000 * 60 * 60 * 24, // 24 hours
            retry: false
        };
    });

    const login = async (code: string, state: string) => {
        const res = await handleGoogleLogin(code, state);
        userQuery.refetch();

        // Check for local canvas to sync
        try {
            const syncedCanvasId = await syncLocalCanvasToServer();
            if (syncedCanvasId) {
                toast.success("Your canvas has been saved to your account!");
                navigate(`/canvas/${syncedCanvasId}`, { replace: true });
                return res?.user;
            }
        } catch (error) {
            console.error("Failed to sync local canvas:", error);
            toast.error("Couldn't save your local canvas. It's still stored locally.");
        }

        navigate(res?.returnTo ?? "/", { replace: true });
        return res?.user;
    };

    const logout = async () => {
        await handleRevoke();
        queryClient.setQueryData(["user"], null);
    };

    // Create a compatibility wrapper that mimics the old createResource API
    const userAccessor: UserAccessor = Object.assign(() => userQuery.data, {
        get isLoading() {
            return userQuery.isLoading;
        },
        get loading() {
            return userQuery.isLoading;
        },
        get isError() {
            return userQuery.isError;
        },
        get error() {
            return userQuery.error;
        }
    });

    const holdUser = createMemo<UserContextValue>(() => [
        userAccessor,
        {
            login,
            logout,
            refetch: userQuery.refetch
        }
    ]);

    return (
        <UserContext.Provider value={holdUser}>
            <div class="h-full">{props.children}</div>
        </UserContext.Provider>
    );
}

export function useUser() {
    const context = useContext(UserContext);
    if (!context) {
        throw new Error("useUser must be used within a UserProvider");
    }
    return context;
}
```

**Step 2: Commit**

```bash
git add frontend/src/userProvider.tsx
git commit -m "refactor: remove socket from UserProvider - now managed by feature providers"
```

---

## Task 6: Remove ConnectionBanner from UserWrapper

**Files:**
- Modify: `frontend/src/UserWrapper.tsx`

**Step 1: Remove ConnectionBanner import and usage**

New file content:

```typescript
import { UserProvider } from "./userProvider";
import { RouteSectionProps } from "@solidjs/router";
import GlobalNavBar from "./components/GlobalNavBar";

export const UserWrapper = (props: RouteSectionProps) => {
    return (
        <UserProvider>
            <div class="flex h-screen flex-col">
                <GlobalNavBar />
                <div class="flex flex-1 overflow-hidden">{props.children}</div>
            </div>
        </UserProvider>
    );
};
```

**Step 2: Commit**

```bash
git add frontend/src/UserWrapper.tsx
git commit -m "refactor: remove ConnectionBanner from UserWrapper - now in socket providers"
```

---

## Task 7: Integrate CanvasSocketProvider into CanvasWorkflow

**Files:**
- Modify: `frontend/src/workflows/CanvasWorkflow.tsx:1-15` (imports)
- Modify: `frontend/src/workflows/CanvasWorkflow.tsx:385-412` (wrap with provider)

**Step 1: Add import**

Add to imports section:

```typescript
import { CanvasSocketProvider } from "../providers/CanvasSocketProvider";
```

**Step 2: Wrap CanvasContext.Provider with CanvasSocketProvider**

Change the return statement structure from:

```tsx
return (
    <CanvasContext.Provider value={...}>
        ...
    </CanvasContext.Provider>
);
```

To:

```tsx
return (
    <CanvasSocketProvider>
        <CanvasContext.Provider value={...}>
            ...
        </CanvasContext.Provider>
    </CanvasSocketProvider>
);
```

**Step 3: Verify typecheck passes**

Run: `pnpm typecheck`
Expected: No errors related to CanvasWorkflow

**Step 4: Commit**

```bash
git add frontend/src/workflows/CanvasWorkflow.tsx
git commit -m "feat: wrap CanvasWorkflow with CanvasSocketProvider"
```

---

## Task 8: Update Canvas.tsx to use useCanvasSocket

**Files:**
- Modify: `frontend/src/Canvas.tsx:26` (add import)
- Modify: `frontend/src/Canvas.tsx:119-120` (change socket access)

**Step 1: Add import**

```typescript
import { useCanvasSocket } from "./providers/CanvasSocketProvider";
```

**Step 2: Update socket access**

Change:

```typescript
const accessor = useUser();
const socketAccessor = accessor()[2];
```

To:

```typescript
const accessor = useUser();
const [user] = accessor();
const { socket: socketAccessor } = useCanvasSocket();
```

**Step 3: Verify typecheck passes**

Run: `pnpm typecheck`
Expected: No errors related to Canvas.tsx

**Step 4: Commit**

```bash
git add frontend/src/Canvas.tsx
git commit -m "refactor: update Canvas.tsx to use useCanvasSocket"
```

---

## Task 9: Update Draft.tsx to use useCanvasSocket

**Files:**
- Modify: `frontend/src/Draft.tsx`

**Step 1: Add import**

```typescript
import { useCanvasSocket } from "./providers/CanvasSocketProvider";
```

**Step 2: Find socket usage and update**

Search for `useUser` usage and determine if socket is accessed. If socket is used, get it from `useCanvasSocket()` instead.

**Step 3: Verify typecheck passes**

Run: `pnpm typecheck`
Expected: No errors related to Draft.tsx

**Step 4: Commit**

```bash
git add frontend/src/Draft.tsx
git commit -m "refactor: update Draft.tsx to use useCanvasSocket"
```

---

## Task 10: Integrate VersusSocketProvider into VersusWorkflow

**Files:**
- Modify: `frontend/src/workflows/VersusWorkflow.tsx`

**Step 1: Add import**

```typescript
import { VersusSocketProvider, useVersusSocket } from "../providers/VersusSocketProvider";
```

**Step 2: Remove internal socket management code**

Remove these lines/signals:
- `const [currentSocket, setCurrentSocket] = createSignal<Socket | undefined>(undefined);`
- `let socketWithListeners: Socket | undefined = undefined;`
- The entire `createEffect` that sets up socket listeners (lines ~210-405)

**Step 3: Get socket from useVersusSocket**

Replace internal socket signals with:

```typescript
const { socket: socketAccessor, connectionStatus: connectionStatusAccessor } = useVersusSocket();
```

**Step 4: Wrap return with VersusSocketProvider**

The component needs to be split - VersusSocketProvider must wrap the content but useVersusSocket must be called inside. Create inner component pattern:

```tsx
const VersusWorkflow: Component<RouteSectionProps> = (props) => {
    return (
        <VersusSocketProvider>
            <VersusWorkflowInner {...props} />
        </VersusSocketProvider>
    );
};

const VersusWorkflowInner: Component<RouteSectionProps> = (props) => {
    const { socket: socketAccessor, connectionStatus: connectionStatusAccessor } = useVersusSocket();
    // ... rest of component logic
};
```

**Step 5: Verify typecheck passes**

Run: `pnpm typecheck`
Expected: No errors

**Step 6: Commit**

```bash
git add frontend/src/workflows/VersusWorkflow.tsx
git commit -m "refactor: update VersusWorkflow to use VersusSocketProvider"
```

---

## Task 11: Update Versus child components to use useVersusSocket

**Files:**
- Modify: `frontend/src/pages/VersusDraftView.tsx`
- Modify: `frontend/src/components/VersusFlowPanelContent.tsx`
- Modify: `frontend/src/components/VersusChatPanel.tsx`

**Step 1: Update each file to import and use useVersusSocket**

For each file, if it accesses socket via `useUser()`, change to:

```typescript
import { useVersusSocket } from "../providers/VersusSocketProvider";
// ...
const { socket } = useVersusSocket();
```

**Step 2: Verify typecheck passes**

Run: `pnpm typecheck`
Expected: No errors

**Step 3: Commit**

```bash
git add frontend/src/pages/VersusDraftView.tsx frontend/src/components/VersusFlowPanelContent.tsx frontend/src/components/VersusChatPanel.tsx
git commit -m "refactor: update Versus components to use useVersusSocket"
```

---

## Task 12: Remove HeartbeatManager from backend

**Files:**
- Delete: `backend/services/heartbeatManager.js`
- Modify: `backend/index.js`
- Modify: `backend/services/versusSessionManager.js`

**Step 1: Delete heartbeatManager.js**

```bash
rm backend/services/heartbeatManager.js
```

**Step 2: Update backend/index.js**

Remove these lines:
- `const HeartbeatManager = require("./services/heartbeatManager");`
- `const heartbeatManager = new HeartbeatManager(io);`
- `const versusSessionManager = new VersusSessionManager(heartbeatManager);`
- `heartbeatManager.registerClient(socket, socket.id);`

Change:
```javascript
const versusSessionManager = new VersusSessionManager(heartbeatManager);
```
To:
```javascript
const versusSessionManager = new VersusSessionManager();
```

**Step 3: Update versusSessionManager.js**

Remove:
- `this.heartbeatManager = heartbeatManager;` from constructor
- `this.heartbeatManager.registerClient(...)` call in `addParticipant()`

Change constructor from:
```javascript
constructor(heartbeatManager) {
    this.heartbeatManager = heartbeatManager;
    this.sessions = new Map();
}
```
To:
```javascript
constructor() {
    this.sessions = new Map();
}
```

**Step 4: Commit**

```bash
git add -A
git commit -m "refactor: remove HeartbeatManager - Socket.io native ping handles keepalive"
```

---

## Task 13: Run full typecheck and fix any remaining issues

**Step 1: Run typecheck**

Run: `pnpm typecheck`

**Step 2: Fix any type errors**

Address errors one by one based on output.

**Step 3: Commit fixes if any**

```bash
git add -A
git commit -m "fix: resolve type errors from lazy socket refactor"
```

---

## Task 14: Manual testing checklist

**Step 1: Test Canvas flow**
- Navigate to `/canvas/dashboard` - verify no socket connection (check Network tab)
- Open a canvas `/canvas/:id` - verify socket connects
- Navigate away to `/settings` - verify socket disconnects
- Return to canvas - verify socket reconnects

**Step 2: Test Versus flow**
- Navigate to `/versus` dashboard - verify no socket (or socket connects if provider wraps dashboard)
- Join a versus draft - verify socket connects
- Navigate away - verify socket disconnects

**Step 3: Test disconnect banner**
- While on canvas, simulate disconnect (DevTools > Network > Offline)
- Verify banner appears
- Reconnect - verify banner disappears

**Step 4: Test anonymous versus**
- Open incognito/logged out
- Join versus via share link
- Verify socket connects and draft works

---

## Summary

| Task | Description | Files |
|------|-------------|-------|
| 1 | Create socket utilities | `providers/socketUtils.ts` |
| 2 | Create CanvasSocketProvider | `providers/CanvasSocketProvider.tsx` |
| 3 | Create VersusSocketProvider | `providers/VersusSocketProvider.tsx` |
| 4 | Update ConnectionBanner | `ConnectionBanner.tsx` |
| 5 | Remove socket from UserProvider | `userProvider.tsx` |
| 6 | Remove banner from UserWrapper | `UserWrapper.tsx` |
| 7 | Integrate Canvas provider | `workflows/CanvasWorkflow.tsx` |
| 8 | Update Canvas.tsx | `Canvas.tsx` |
| 9 | Update Draft.tsx | `Draft.tsx` |
| 10 | Integrate Versus provider | `workflows/VersusWorkflow.tsx` |
| 11 | Update Versus components | 3 files |
| 12 | Remove HeartbeatManager | backend files |
| 13 | Typecheck & fix | - |
| 14 | Manual testing | - |
