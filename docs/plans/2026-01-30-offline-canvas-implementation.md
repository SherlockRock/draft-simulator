# Offline Canvas Mode — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Allow anonymous users to work on a single Canvas stored in localStorage, with full feature parity (drafts, connections, groups), that auto-syncs to the server when they sign in.

**Architecture:** A localStorage persistence layer sits alongside the existing API layer. A `useCanvasPersistence` hook routes mutations to the right backend based on auth state. Canvas.tsx's existing SolidJS stores remain the source of truth for rendering — only the persistence target changes. On sign-in, a sync function replays the local canvas to the server via existing API endpoints with ID remapping.

**Tech Stack:** SolidJS, TypeScript, localStorage, existing REST API endpoints (no backend changes)

---

### Task 1: Create localCanvasStore.ts — localStorage CRUD

**Files:**
- Create: `frontend/src/utils/localCanvasStore.ts`

**Context:** This utility handles reading, writing, and clearing a single canvas blob from localStorage under the key `draft-sim:local-canvas`. It uses the existing types from `types.ts`. All IDs are temporary UUIDs generated via `crypto.randomUUID()`.

**Step 1: Create the local canvas store utility**

```typescript
// frontend/src/utils/localCanvasStore.ts
import { CanvasDraft, Connection, CanvasGroup, Viewport } from "./types";

const STORAGE_KEY = "draft-sim:local-canvas";

export type LocalCanvas = {
    name: string;
    description: string;
    icon: string;
    drafts: CanvasDraft[];
    connections: Connection[];
    groups: CanvasGroup[];
    viewport: Viewport;
    createdAt: string;
};

export const getLocalCanvas = (): LocalCanvas | null => {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return null;
        return JSON.parse(raw) as LocalCanvas;
    } catch {
        return null;
    }
};

export const saveLocalCanvas = (canvas: LocalCanvas): void => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(canvas));
};

export const clearLocalCanvas = (): void => {
    localStorage.removeItem(STORAGE_KEY);
};

export const createEmptyLocalCanvas = (name: string, description?: string, icon?: string): LocalCanvas => {
    return {
        name,
        description: description ?? "",
        icon: icon ?? "",
        drafts: [],
        connections: [],
        groups: [],
        viewport: { x: 0, y: 0, zoom: 1 },
        createdAt: new Date().toISOString()
    };
};

export const hasLocalCanvas = (): boolean => {
    return localStorage.getItem(STORAGE_KEY) !== null;
};
```

**Step 2: Commit**

```bash
git add frontend/src/utils/localCanvasStore.ts
git commit -m "feat: add localCanvasStore utility for offline canvas persistence"
```

---

### Task 2: Create useLocalCanvasMutations — local mutation handlers

**Files:**
- Create: `frontend/src/utils/useLocalCanvasMutations.ts`

**Context:** This module provides mutation functions that mirror what Canvas.tsx does with TanStack mutations, but instead operate on the localStorage blob and return data in the same shapes. Canvas.tsx will call these when the user is anonymous. Each function reads the current local canvas, applies the change, writes it back, and returns the result.

Canvas.tsx currently uses these mutations (defined at `Canvas.tsx:569-778`):
- `updateCanvasNameMutation` — PATCH name/icon
- `newDraftMutation` — POST new draft
- `editDraftMutation` — PUT draft name
- `updatePositionMutation` — PUT draft position
- `deleteDraftMutation` — DELETE draft from canvas
- `updateViewportMutation` — PATCH viewport
- `createConnectionMutation` — POST connection
- `updateConnectionMutation` — PATCH connection (add source/target)
- `deleteConnectionMutation` — DELETE connection
- `createVertexMutation` — POST vertex
- `updateVertexMutation` — PUT vertex position
- `deleteVertexMutation` — DELETE vertex
- `updateGroupPositionMutation` — PUT group position
- `deleteGroupMutation` — DELETE group
- `createGroupMutation` — POST group
- `updateGroupMutation` — PUT group
- `updateDraftGroupMutation` — PUT draft group assignment

**Step 1: Create the local mutations module**

```typescript
// frontend/src/utils/useLocalCanvasMutations.ts
import { CanvasDraft, Connection, CanvasGroup, Viewport } from "./types";
import { getLocalCanvas, saveLocalCanvas, LocalCanvas } from "./localCanvasStore";

// Helper: read, apply, save, return
const mutateLocal = <T>(fn: (canvas: LocalCanvas) => { canvas: LocalCanvas; result: T }): T => {
    const canvas = getLocalCanvas();
    if (!canvas) throw new Error("No local canvas");
    const { canvas: updated, result } = fn(canvas);
    saveLocalCanvas(updated);
    return result;
};

export const localUpdateCanvasName = (data: {
    name: string;
    description?: string;
    icon?: string;
}) => {
    return mutateLocal((canvas) => {
        canvas.name = data.name;
        if (data.description !== undefined) canvas.description = data.description;
        if (data.icon !== undefined) canvas.icon = data.icon;
        return { canvas, result: { name: canvas.name, id: "local" } };
    });
};

export const localNewDraft = (data: {
    name: string;
    picks: string[];
    positionX: number;
    positionY: number;
}) => {
    return mutateLocal((canvas) => {
        const draftId = crypto.randomUUID();
        const newDraft: CanvasDraft = {
            positionX: data.positionX,
            positionY: data.positionY,
            group_id: null,
            source_type: "canvas",
            Draft: {
                id: draftId,
                name: data.name,
                picks: data.picks,
                type: "canvas"
            }
        };
        canvas.drafts.push(newDraft);
        return { canvas, result: newDraft };
    });
};

export const localEditDraft = (draftId: string, data: { name: string }) => {
    return mutateLocal((canvas) => {
        const draft = canvas.drafts.find((d) => d.Draft.id === draftId);
        if (draft) {
            draft.Draft.name = data.name;
        }
        return { canvas, result: draft };
    });
};

export const localUpdateDraftPosition = (data: {
    draftId: string;
    positionX: number;
    positionY: number;
}) => {
    return mutateLocal((canvas) => {
        const draft = canvas.drafts.find((d) => d.Draft.id === data.draftId);
        if (draft) {
            draft.positionX = data.positionX;
            draft.positionY = data.positionY;
        }
        return { canvas, result: { success: true } };
    });
};

export const localDeleteDraft = (draftId: string) => {
    return mutateLocal((canvas) => {
        canvas.drafts = canvas.drafts.filter((d) => d.Draft.id !== draftId);
        // Also remove connections referencing this draft
        canvas.connections = canvas.connections.filter((c) => {
            const srcRefs = c.source_draft_ids.some(
                (e) => ("draft_id" in e && e.draft_id === draftId)
            );
            const tgtRefs = c.target_draft_ids.some(
                (e) => ("draft_id" in e && e.draft_id === draftId)
            );
            return !srcRefs && !tgtRefs;
        });
        return { canvas, result: { success: true } };
    });
};

export const localUpdateViewport = (viewport: Viewport) => {
    return mutateLocal((canvas) => {
        canvas.viewport = viewport;
        return { canvas, result: { success: true } };
    });
};

export const localCreateConnection = (data: {
    sourceDraftIds: Array<{ draftId?: string; groupId?: string; anchorType?: string }>;
    targetDraftIds: Array<{ draftId?: string; groupId?: string; anchorType?: string }>;
    style?: "solid" | "dashed" | "dotted";
    vertices?: Array<{ id: string; x: number; y: number }>;
}) => {
    return mutateLocal((canvas) => {
        const connectionId = crypto.randomUUID();
        const connection: Connection = {
            id: connectionId,
            canvas_id: "local",
            source_draft_ids: data.sourceDraftIds.map((e) =>
                e.groupId
                    ? { type: "group" as const, group_id: e.groupId, anchor_type: (e.anchorType ?? "bottom") as any }
                    : { draft_id: e.draftId!, anchor_type: (e.anchorType ?? "bottom") as any }
            ),
            target_draft_ids: data.targetDraftIds.map((e) =>
                e.groupId
                    ? { type: "group" as const, group_id: e.groupId, anchor_type: (e.anchorType ?? "top") as any }
                    : { draft_id: e.draftId!, anchor_type: (e.anchorType ?? "top") as any }
            ),
            vertices: data.vertices ?? [],
            style: data.style ?? "solid"
        };
        canvas.connections.push(connection);
        return { canvas, result: { success: true, connection } };
    });
};

export const localUpdateConnection = (data: {
    connectionId: string;
    addSource?: { draftId?: string; groupId?: string; anchorType?: string };
    addTarget?: { draftId?: string; groupId?: string; anchorType?: string };
}) => {
    return mutateLocal((canvas) => {
        const conn = canvas.connections.find((c) => c.id === data.connectionId);
        if (conn) {
            if (data.addSource) {
                const endpoint = data.addSource.groupId
                    ? { type: "group" as const, group_id: data.addSource.groupId, anchor_type: (data.addSource.anchorType ?? "bottom") as any }
                    : { draft_id: data.addSource.draftId!, anchor_type: (data.addSource.anchorType ?? "bottom") as any };
                conn.source_draft_ids.push(endpoint);
            }
            if (data.addTarget) {
                const endpoint = data.addTarget.groupId
                    ? { type: "group" as const, group_id: data.addTarget.groupId, anchor_type: (data.addTarget.anchorType ?? "top") as any }
                    : { draft_id: data.addTarget.draftId!, anchor_type: (data.addTarget.anchorType ?? "top") as any };
                conn.target_draft_ids.push(endpoint);
            }
        }
        return { canvas, result: { success: true, connection: conn } };
    });
};

export const localDeleteConnection = (connectionId: string) => {
    return mutateLocal((canvas) => {
        canvas.connections = canvas.connections.filter((c) => c.id !== connectionId);
        return { canvas, result: { success: true } };
    });
};

export const localCreateVertex = (data: {
    connectionId: string;
    x: number;
    y: number;
    insertAfterIndex?: number;
}) => {
    return mutateLocal((canvas) => {
        const conn = canvas.connections.find((c) => c.id === data.connectionId);
        const vertexId = crypto.randomUUID();
        const vertex = { id: vertexId, x: data.x, y: data.y };
        if (conn) {
            const idx = data.insertAfterIndex ?? conn.vertices.length;
            conn.vertices.splice(idx + 1, 0, vertex);
        }
        return { canvas, result: { success: true, vertex, connection: conn } };
    });
};

export const localUpdateVertex = (data: {
    connectionId: string;
    vertexId: string;
    x: number;
    y: number;
}) => {
    return mutateLocal((canvas) => {
        const conn = canvas.connections.find((c) => c.id === data.connectionId);
        if (conn) {
            const vertex = conn.vertices.find((v) => v.id === data.vertexId);
            if (vertex) {
                vertex.x = data.x;
                vertex.y = data.y;
            }
        }
        return { canvas, result: { success: true, vertex: { id: data.vertexId, x: data.x, y: data.y } } };
    });
};

export const localDeleteVertex = (data: {
    connectionId: string;
    vertexId: string;
}) => {
    return mutateLocal((canvas) => {
        const conn = canvas.connections.find((c) => c.id === data.connectionId);
        if (conn) {
            conn.vertices = conn.vertices.filter((v) => v.id !== data.vertexId);
        }
        return { canvas, result: { success: true, connection: conn } };
    });
};

export const localCreateGroup = (data: {
    name: string;
    positionX: number;
    positionY: number;
}) => {
    return mutateLocal((canvas) => {
        const group: CanvasGroup = {
            id: crypto.randomUUID(),
            canvas_id: "local",
            name: data.name,
            type: "custom",
            positionX: data.positionX,
            positionY: data.positionY,
            metadata: {}
        };
        canvas.groups.push(group);
        return { canvas, result: { success: true, group } };
    });
};

export const localUpdateGroupPosition = (data: {
    groupId: string;
    positionX: number;
    positionY: number;
}) => {
    return mutateLocal((canvas) => {
        const group = canvas.groups.find((g) => g.id === data.groupId);
        if (group) {
            group.positionX = data.positionX;
            group.positionY = data.positionY;
        }
        return { canvas, result: { success: true } };
    });
};

export const localUpdateGroup = (data: {
    groupId: string;
    name?: string;
    positionX?: number;
    positionY?: number;
    width?: number | null;
    height?: number | null;
}) => {
    return mutateLocal((canvas) => {
        const group = canvas.groups.find((g) => g.id === data.groupId);
        if (group) {
            if (data.name !== undefined) group.name = data.name;
            if (data.positionX !== undefined) group.positionX = data.positionX;
            if (data.positionY !== undefined) group.positionY = data.positionY;
            if (data.width !== undefined) group.width = data.width;
            if (data.height !== undefined) group.height = data.height;
        }
        return { canvas, result: { success: true, group } };
    });
};

export const localDeleteGroup = (groupId: string, keepDrafts?: boolean) => {
    return mutateLocal((canvas) => {
        if (!keepDrafts) {
            canvas.drafts = canvas.drafts.filter((d) => d.group_id !== groupId);
        } else {
            canvas.drafts = canvas.drafts.map((d) =>
                d.group_id === groupId ? { ...d, group_id: null } : d
            );
        }
        canvas.groups = canvas.groups.filter((g) => g.id !== groupId);
        // Remove connections referencing this group
        canvas.connections = canvas.connections.filter((c) => {
            const srcRefs = c.source_draft_ids.some(
                (e) => "group_id" in e && e.group_id === groupId
            );
            const tgtRefs = c.target_draft_ids.some(
                (e) => "group_id" in e && e.group_id === groupId
            );
            return !srcRefs && !tgtRefs;
        });
        return { canvas, result: { success: true } };
    });
};

export const localUpdateDraftGroup = (data: {
    draftId: string;
    group_id: string | null;
    positionX?: number;
    positionY?: number;
}) => {
    return mutateLocal((canvas) => {
        const draft = canvas.drafts.find((d) => d.Draft.id === data.draftId);
        if (draft) {
            draft.group_id = data.group_id;
            if (data.positionX !== undefined) draft.positionX = data.positionX;
            if (data.positionY !== undefined) draft.positionY = data.positionY;
        }
        return { canvas, result: { success: true } };
    });
};
```

**Step 2: Commit**

```bash
git add frontend/src/utils/useLocalCanvasMutations.ts
git commit -m "feat: add local canvas mutation functions for offline mode"
```

---

### Task 3: Wire local mode into CanvasWorkflow — loading & context

**Files:**
- Modify: `frontend/src/workflows/CanvasWorkflow.tsx`
- Modify: `frontend/src/index.tsx` (add route for `/canvas/local`)

**Context:** CanvasWorkflow loads canvas data via `createResource(fetchCanvas)` at line 80-83. For anonymous users (or when `params.id === "local"`), we need to populate the canvas resource from localStorage instead. The canvas list at line 77-78 should show the local canvas for anon users.

**Step 1: Add `/canvas/local` route**

In `frontend/src/index.tsx`, add a route for the local canvas. The `CanvasDetailView` component will be reused — it already receives canvas data from the workflow context.

At line 46 (after the `/:id` route), the local route uses the same `CanvasDetailView`. However, since `params.id` would be `"local"`, CanvasWorkflow needs to detect this and load from localStorage instead of fetching.

In `frontend/src/index.tsx`, change line 46:

```typescript
// Before:
<Route path="/:id" component={CanvasDetailView} />

// After (no change needed — "local" is just a valid :id value)
// CanvasWorkflow will detect params.id === "local" and branch
```

Actually, no route change is needed. `/canvas/local` already matches `/:id` with `id = "local"`.

**Step 2: Modify CanvasWorkflow to handle local mode**

In `frontend/src/workflows/CanvasWorkflow.tsx`:

Add import at top:

```typescript
import { getLocalCanvas, hasLocalCanvas, LocalCanvas } from "../utils/localCanvasStore";
```

Modify the canvas resource fetcher (lines 80-83) to branch on `params.id === "local"`:

```typescript
const [canvas, { mutate: mutateCanvas, refetch: refetchCanvas }] = createResource(
    () => (params.id !== undefined ? String(params.id) : null),
    async (id: string) => {
        if (id === "local") {
            const local = getLocalCanvas();
            if (!local) return undefined;
            return {
                name: local.name,
                drafts: local.drafts,
                connections: local.connections,
                groups: local.groups,
                lastViewport: local.viewport,
                userPermissions: "admin" as const
            };
        }
        return fetchCanvas(id);
    }
);
```

Modify the canvas list resource (lines 77-78) to show local canvas for anon users:

```typescript
const [canvasList, { mutate: mutateCanvasList, refetch: refetchCanvasList }] =
    createResource<any[]>(async () => {
        if (!user()) {
            // Anon user: show local canvas entry if one exists
            if (hasLocalCanvas()) {
                const local = getLocalCanvas()!;
                return [{ id: "local", name: local.name, updatedAt: local.createdAt }];
            }
            return [];
        }
        return fetchCanvasList();
    });
```

Modify the user-change effect (lines 102-112) to also handle the anon→auth transition:

```typescript
createEffect(() => {
    const currentUser = user();
    if (currentUser === undefined) {
        // Anon: load local canvas list
        refetchCanvasList();
        if (params.id && params.id !== "local") {
            mutateCanvas(undefined);
        }
    } else if (currentUser !== previousUser) {
        refetchCanvasList();
        refetchCanvas();
    }
    previousUser = currentUser;
});
```

**Step 3: Modify CanvasDetailView to allow local mode**

In `frontend/src/pages/CanvasDetailView.tsx`, the component is wrapped in `<AuthGuard requireAuth={true}>` (line 83). For local mode, we need to skip the auth guard.

```typescript
// Before (line 82-99):
return (
    <AuthGuard requireAuth={true}>
        <div ref={canvasContainerRef} class="flex-1 overflow-hidden">
            ...
        </div>
    </AuthGuard>
);

// After:
const isLocalMode = () => params.id === "local";

return (
    <AuthGuard requireAuth={!isLocalMode()}>
        <div ref={canvasContainerRef} class="flex-1 overflow-hidden">
            ...
        </div>
    </AuthGuard>
);
```

Also modify the `createNewDraft` function (lines 50-71) to handle local mode. Currently it calls `postNewDraft` which hits the API. In local mode, it should use the local mutation:

```typescript
import { localNewDraft } from "../utils/useLocalCanvasMutations";
import { getLocalCanvas, saveLocalCanvas } from "../utils/localCanvasStore";

// Replace the existing newDraftMutation and createNewDraft with:
const createNewDraft = () => {
    if (canvasContainerRef) {
        const vp = viewport();
        const canvasRect = canvasContainerRef.getBoundingClientRect();
        const currentHeight = cardHeight(layoutToggle());
        const currentWidth = cardWidth(layoutToggle());
        const centerWorldX = vp.x + canvasRect.width / 2 / vp.zoom;
        const centerWorldY = vp.y + canvasRect.height / 2 / vp.zoom;
        const positionX = centerWorldX - currentWidth / 2;
        const positionY = centerWorldY - currentHeight / 2;

        if (params.id === "local") {
            const newDraft = localNewDraft({
                name: "New Draft",
                picks: Array(20).fill(""),
                positionX,
                positionY
            });
            // Trigger re-render by mutating canvas resource
            const local = getLocalCanvas();
            if (local) {
                mutateCanvas({
                    name: local.name,
                    drafts: local.drafts,
                    connections: local.connections,
                    groups: local.groups,
                    lastViewport: local.viewport,
                    userPermissions: "admin"
                });
            }
            toast.success("Successfully created new draft!");
        } else {
            newDraftMutation.mutate({
                name: "New Draft",
                picks: Array(20).fill(""),
                public: false,
                canvas_id: params.id,
                positionX,
                positionY
            });
        }
    }
};
```

**Step 4: Commit**

```bash
git add frontend/src/workflows/CanvasWorkflow.tsx frontend/src/pages/CanvasDetailView.tsx
git commit -m "feat: wire local canvas mode into CanvasWorkflow and CanvasDetailView"
```

---

### Task 4: Wire local mutations into Canvas.tsx

**Files:**
- Modify: `frontend/src/Canvas.tsx`

**Context:** Canvas.tsx defines 17 TanStack mutations (lines 569-778) and calls them throughout the component. For local mode, each mutation call site needs to branch: if `params.id === "local"`, call the local mutation function instead of the TanStack mutation.

Rather than rewriting every mutation, we create a helper pattern inside CanvasComponent. At the top of CanvasComponent (after line 416), add:

**Step 1: Add local mode detection and local mutation imports**

Add to imports at top of Canvas.tsx (after line 38):

```typescript
import {
    localUpdateCanvasName,
    localNewDraft,
    localEditDraft,
    localUpdateDraftPosition,
    localDeleteDraft,
    localUpdateViewport,
    localCreateConnection,
    localUpdateConnection,
    localDeleteConnection,
    localCreateVertex,
    localUpdateVertex,
    localDeleteVertex,
    localCreateGroup,
    localUpdateGroupPosition,
    localUpdateGroup,
    localDeleteGroup,
    localUpdateDraftGroup
} from "./utils/useLocalCanvasMutations";
import { getLocalCanvas } from "./utils/localCanvasStore";
```

Inside CanvasComponent (after line 416):

```typescript
const isLocalMode = () => params.id === "local";

// Helper to refresh canvas data from localStorage after a local mutation
const refreshFromLocal = () => {
    const local = getLocalCanvas();
    if (local) {
        setCanvasDrafts(local.drafts);
        setConnections(local.connections);
        setCanvasGroups(local.groups);
    }
};
```

**Step 2: Wrap each mutation call site**

For each mutation `.mutate(...)` call in Canvas.tsx, add an `if (isLocalMode())` branch that calls the corresponding local function then calls `refreshFromLocal()`. The key call sites are:

1. **`handleCanvasNameChange`** (line 1018-1025): Add local branch
2. **`addBox`** (line 1027-1036): Add local branch
3. **`handleNameChange`** (line 1067-1073): Add local branch
4. **`handlePickChange`** (line 1046-1065): For local mode, write picks directly to localStorage (the socket emit on line 1058 is skipped)
5. **`onAnchorClick` / connection creation** (lines 1082-1170): Add local branches for `createConnectionMutation.mutate` and `updateConnectionMutation.mutate`
6. **`onDelete`** (line 1923-1930): Add local branch for `deleteDraftMutation.mutate`
7. **`onWindowMouseUp`** (lines 1733-1883): Add local branches for `updateVertexMutation.mutate`, `updateGroupPositionMutation.mutate`, `updatePositionMutation.mutate`, `updateDraftGroupMutation.mutate`
8. **Viewport save** — the `debouncedSaveViewport` (referenced at line 1687): Add local branch
9. **Group operations**: `deleteGroupMutation.mutate`, `createGroupMutation.mutate`, `updateGroupMutation.mutate`
10. **Vertex operations**: `createVertexMutation.mutate`, `deleteVertexMutation.mutate`

For each call site, the pattern is:

```typescript
// Before:
someApiMutation.mutate({ canvasId: params.id, ... });

// After:
if (isLocalMode()) {
    localSomeFunction({ ... });
    refreshFromLocal();
    toast.success("...");  // if applicable
} else {
    someApiMutation.mutate({ canvasId: params.id, ... });
}
```

**Step 3: Skip socket operations in local mode**

The socket join/emit calls (lines 830-856, 780-828, 1058) should be skipped in local mode. Wrap them:

```typescript
// Line 843 area — socket room joins
if (!isLocalMode()) {
    socketAccessor().emit("joinRoom", params.id);
    props.canvasData.drafts.forEach((draft: CanvasDraft) => {
        socketAccessor().emit("joinRoom", draft.Draft.id);
    });
}
```

```typescript
// Line 859 area — socket listeners
if (!isLocalMode()) {
    socketAccessor().on("canvasUpdate", ...);
    // ... all other socket listeners
}
```

```typescript
// Line 1058 — pick change socket emit
if (!isLocalMode()) {
    socketAccessor().emit("newDraft", { picks: holdPicks, id: draftId });
}
```

```typescript
// Lines 780-828 — movement socket emits
const emitMove = (draftId: string, positionX: number, positionY: number) => {
    if (isLocalMode()) return;
    socketAccessor().emit("canvasObjectMove", { ... });
};
// Same for emitVertexMove, emitGroupMove, emitGroupResize
```

**Step 4: Handle local mode data initialization**

The existing effect at line 830-857 populates stores from `props.canvasData`. This works for both modes since CanvasWorkflow already provides local data through the same `canvas` resource. No change needed here — but ensure the socket joins are conditional (done in step 3).

**Step 5: Commit**

```bash
git add frontend/src/Canvas.tsx
git commit -m "feat: add local mode branching to Canvas.tsx mutations and socket ops"
```

---

### Task 5: Modify CreateCanvasDialog and CanvasFlowDashboard for anon users

**Files:**
- Modify: `frontend/src/components/CreateCanvasDialog.tsx`
- Modify: `frontend/src/pages/CanvasFlowDashboard.tsx`

**Context:** When an anonymous user clicks "Create New Canvas", it should create a local canvas in localStorage and navigate to `/canvas/local` instead of hitting the API.

**Step 1: Modify CreateCanvasDialog**

In `frontend/src/components/CreateCanvasDialog.tsx`, the `handleSubmit` function (lines 62-83) calls `createCanvas()` which hits the API. Add a branch for anon users:

```typescript
import { useUser } from "../userProvider";
import { createEmptyLocalCanvas, saveLocalCanvas } from "../utils/localCanvasStore";

// Inside the component, add:
const accessor = useUser();
const [user] = accessor();

// Replace handleSubmit (lines 62-83):
const handleSubmit = async (e: Event) => {
    e.preventDefault();
    if (!validateForm()) return;

    setIsSubmitting(true);
    try {
        if (!user()) {
            // Anon user: create local canvas
            const local = createEmptyLocalCanvas(
                name().trim(),
                description().trim() || undefined,
                icon()
            );
            saveLocalCanvas(local);
            toast.success("Canvas created!");
            props.onSuccess?.("local");
        } else {
            const result = await createCanvas({
                name: name().trim(),
                description: description().trim() || undefined,
                icon: icon()
            });
            toast.success("Canvas created successfully!");
            props.onSuccess?.(result.canvas.id);
        }
    } catch (error) {
        toast.error("Failed to create canvas");
        console.error(error);
    } finally {
        setIsSubmitting(false);
    }
};
```

**Step 2: Modify CanvasFlowDashboard**

In `frontend/src/pages/CanvasFlowDashboard.tsx`, the activity query (lines 16-22) is disabled for anon users (`enabled: !!user()`). The "Create New Canvas" button already works — it opens CreateCanvasDialog which we just modified.

Add: if a local canvas already exists and user is anon, auto-navigate to it:

```typescript
import { hasLocalCanvas } from "../utils/localCanvasStore";

// Inside CanvasFlowDashboard, after line 14:
createEffect(() => {
    if (!user() && hasLocalCanvas()) {
        navigate("/canvas/local");
    }
});
```

This means anon users with an existing local canvas skip the dashboard and go straight to their canvas.

**Step 3: Commit**

```bash
git add frontend/src/components/CreateCanvasDialog.tsx frontend/src/pages/CanvasFlowDashboard.tsx
git commit -m "feat: support anon canvas creation in CreateCanvasDialog and dashboard"
```

---

### Task 6: Add "Local — sign in to save" banner to Canvas.tsx

**Files:**
- Modify: `frontend/src/Canvas.tsx`

**Context:** Anonymous users should see a subtle banner indicating their canvas is local-only. This goes in the Canvas.tsx top-bar area (around line 1968 where the canvas name input and toolbar are rendered).

**Step 1: Add the local mode banner**

After the toolbar div (around line 1968), add:

```tsx
<Show when={isLocalMode()}>
    <div class="absolute right-4 top-4 z-40 flex items-center gap-2 rounded-lg border border-yellow-600/30 bg-yellow-900/40 px-3 py-1.5 text-xs text-yellow-300 shadow-lg backdrop-blur-sm">
        <span>Local only</span>
        <span class="text-yellow-500">—</span>
        <button
            onClick={() => handleLogin()}
            class="font-medium text-yellow-200 underline underline-offset-2 hover:text-yellow-100"
        >
            Sign in to save
        </button>
    </div>
</Show>
```

Add import for `handleLogin` at top of Canvas.tsx:

```typescript
import { handleLogin } from "./utils/actions";
```

**Step 2: Hide share/collab features for local mode**

In CanvasWorkflow.tsx, the admin section (lines 318-431) shows Users and Share buttons. These should be hidden in local mode. The existing `hasAdminPermissions()` check handles this since we set `userPermissions: "admin"` for local — but we actually want to hide these for local mode regardless. Modify:

```typescript
// In CanvasWorkflow.tsx, change the admin section Show condition (line 318):
// Before:
<Show when={hasAdminPermissions()}>

// After:
<Show when={hasAdminPermissions() && params.id !== "local"}>
```

**Step 3: Commit**

```bash
git add frontend/src/Canvas.tsx frontend/src/workflows/CanvasWorkflow.tsx
git commit -m "feat: add local mode banner and hide share features for anon users"
```

---

### Task 7: Implement sync-on-login in userProvider.tsx

**Files:**
- Modify: `frontend/src/userProvider.tsx`
- Create: `frontend/src/utils/syncLocalCanvas.ts`

**Context:** When an anonymous user signs in via Google OAuth, the `login()` function in `userProvider.tsx` (lines 71-76) handles the auth callback. After successful auth, we need to check for a local canvas and push it to the server.

**Step 1: Create the sync utility**

```typescript
// frontend/src/utils/syncLocalCanvas.ts
import { getLocalCanvas, clearLocalCanvas } from "./localCanvasStore";
import { createCanvas } from "./actions";
import { postNewDraft } from "./actions";
import { createCanvasGroup, updateCanvasDraft, createConnection } from "./actions";

export const syncLocalCanvasToServer = async (): Promise<string | null> => {
    const local = getLocalCanvas();
    if (!local) return null;

    // Step 1: Create the canvas
    const canvasResult = await createCanvas({
        name: local.name,
        description: local.description || undefined,
        icon: local.icon || undefined
    });
    const canvasId = canvasResult.canvas.id;

    // ID remapping: tempId -> serverId
    const draftIdMap = new Map<string, string>();
    const groupIdMap = new Map<string, string>();

    // Step 2: Create groups first (drafts reference groups)
    for (const group of local.groups) {
        const result = await createCanvasGroup({
            canvasId,
            name: group.name,
            positionX: group.positionX,
            positionY: group.positionY
        });
        groupIdMap.set(group.id, result.group.id);
    }

    // Step 3: Create drafts
    for (const draft of local.drafts) {
        const result = await postNewDraft({
            name: draft.Draft.name,
            picks: draft.Draft.picks,
            canvas_id: canvasId,
            positionX: draft.positionX,
            positionY: draft.positionY
        });
        draftIdMap.set(draft.Draft.id, result.id);

        // If draft was in a group, assign it
        if (draft.group_id) {
            const serverGroupId = groupIdMap.get(draft.group_id);
            if (serverGroupId) {
                await updateCanvasDraft({
                    canvasId,
                    draftId: result.id,
                    group_id: serverGroupId
                });
            }
        }
    }

    // Step 4: Create connections with remapped IDs
    for (const conn of local.connections) {
        const remapEndpoint = (e: any) => {
            if ("group_id" in e && e.group_id) {
                return { groupId: groupIdMap.get(e.group_id) ?? e.group_id, anchorType: e.anchor_type };
            }
            return { draftId: draftIdMap.get(e.draft_id) ?? e.draft_id, anchorType: e.anchor_type };
        };

        await createConnection({
            canvasId,
            sourceDraftIds: conn.source_draft_ids.map(remapEndpoint),
            targetDraftIds: conn.target_draft_ids.map(remapEndpoint),
            style: conn.style,
            vertices: conn.vertices
        });
    }

    // Step 5: Clear local storage
    clearLocalCanvas();

    return canvasId;
};
```

**Step 2: Wire sync into userProvider login flow**

In `frontend/src/userProvider.tsx`, modify the `login` function (lines 71-76):

```typescript
import { syncLocalCanvasToServer } from "./utils/syncLocalCanvas";
import toast from "solid-toast";

// Replace login function:
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
```

**Step 3: Commit**

```bash
git add frontend/src/utils/syncLocalCanvas.ts frontend/src/userProvider.tsx
git commit -m "feat: implement sync-on-login for local canvas"
```

---

### Task 8: Handle pick changes in local mode

**Files:**
- Modify: `frontend/src/Canvas.tsx`

**Context:** The `handlePickChange` function (Canvas.tsx lines 1046-1065) updates a draft's picks and emits a socket event. In local mode, the socket emit should be skipped and the change should be persisted to localStorage. The SolidJS store update (lines 1052-1063) works fine for both modes — we just need to also write to localStorage.

**Step 1: Modify handlePickChange**

```typescript
// After the existing store update (line 1063), add localStorage persistence:
const handlePickChange = (
    draftId: string,
    pickIndex: number,
    championName: string
) => {
    const champIndex = champions.findIndex((value) => value.name === championName);
    setCanvasDrafts(
        (cd) => cd.Draft.id === draftId,
        "Draft",
        (Draft) => {
            const holdPicks = [...Draft.picks];
            holdPicks[pickIndex] = champIndex !== -1 ? String(champIndex) : "";
            if (!isLocalMode()) {
                socketAccessor().emit("newDraft", {
                    picks: holdPicks,
                    id: draftId
                });
            }
            return { ...Draft, picks: holdPicks };
        }
    );

    // Persist to localStorage in local mode
    if (isLocalMode()) {
        const local = getLocalCanvas();
        if (local) {
            const draft = local.drafts.find((d) => d.Draft.id === draftId);
            if (draft) {
                const holdPicks = [...draft.Draft.picks];
                holdPicks[pickIndex] = champIndex !== -1 ? String(champIndex) : "";
                draft.Draft.picks = holdPicks;
                saveLocalCanvas(local);
            }
        }
    }
};
```

Add import for `saveLocalCanvas`:

```typescript
import { getLocalCanvas, saveLocalCanvas } from "./utils/localCanvasStore";
```

**Step 2: Commit**

```bash
git add frontend/src/Canvas.tsx
git commit -m "feat: persist pick changes to localStorage in local mode"
```

---

### Task 9: Handle CanvasSelector for local mode

**Files:**
- Modify: `frontend/src/components/CanvasSelector.tsx`

**Context:** The CanvasSelector dropdown shows the user's canvases and a "+ New" button. For anonymous users with a local canvas, it should show their single local canvas. The canvas list from CanvasWorkflow already includes the local entry (from Task 3), so CanvasSelector should work without changes — but verify the selected state matches `"local"` correctly.

**Step 1: Check CanvasSelector**

Read the CanvasSelector component to verify it handles `id: "local"` as a selected canvas. The `selectedId` prop is passed from CanvasWorkflow (line 259: `<CanvasSelector selectedId={params.id} />`). If CanvasSelector compares against canvas list item IDs, it should work since we added `{ id: "local", name: ... }` to the list.

If CanvasSelector calls `createCanvas` directly via its "+ New" button, it also needs the anon branch. Check and update if needed.

**Step 2: Commit (if changes needed)**

```bash
git add frontend/src/components/CanvasSelector.tsx
git commit -m "feat: support local canvas entry in CanvasSelector"
```

---

### Task 10: Manual testing & edge cases

**Files:**
- No new files

**Steps to verify:**

1. **Anon user creates canvas:** Log out, navigate to `/canvas`, click Create New Canvas, verify it creates in localStorage and navigates to `/canvas/local`
2. **Anon user adds drafts:** On local canvas, add drafts (sidebar button + double-click), verify they render and persist across page reload
3. **Anon user edits picks:** Change champion picks on drafts, reload, verify they persist
4. **Anon user creates connections:** Enter connection mode, create connections between drafts, reload, verify they persist
5. **Anon user creates groups:** Create a custom group, drag drafts into it, reload, verify persistence
6. **Anon user moves drafts/groups:** Drag drafts and groups, reload, verify positions persist
7. **Viewport persistence:** Pan and zoom, reload, verify viewport restores
8. **Sign in syncs canvas:** Sign in via Google OAuth, verify local canvas appears on server, localStorage is cleared, user is navigated to the server canvas
9. **No local canvas on sign-in:** Sign in without a local canvas, verify normal login flow works unchanged
10. **Returning signed-in user:** Sign in, verify existing server canvases still work, no regressions
11. **Anon user with existing local canvas:** Navigate to `/canvas`, verify auto-redirect to `/canvas/local`
