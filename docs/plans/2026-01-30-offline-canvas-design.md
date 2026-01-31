# Offline Canvas Mode for Anonymous Users

## Goal

Allow anonymous users to work on a Canvas without any backend calls. Their work persists in localStorage and auto-syncs to the server when they sign in. This avoids server costs for uncommitted users and gives them a real taste of the product before creating an account.

## Constraints

- Single local canvas per anonymous user
- Full feature set: drafts, connections, groups, drag/drop, viewport
- No real-time collaboration or sharing for anonymous users
- No backend changes required
- Auto-save to server on sign-in (no prompt)

## Architecture

### Overview

The frontend already manages canvas state through local SolidJS stores (`canvasDrafts`, `connections`, `canvasGroups` in Canvas.tsx), with mutations sent to the backend separately. We introduce a persistence abstraction that routes mutations to either the backend API or localStorage depending on auth state. Canvas.tsx calls this abstraction instead of calling `actions.ts` directly.

### Local Storage Schema

**Key:** `draft-sim:local-canvas`

```typescript
interface LocalCanvas {
  name: string
  description: string
  icon: string
  drafts: LocalCanvasDraft[]    // same shape as CanvasDraft, with temp UUIDs
  connections: Connection[]
  groups: CanvasGroup[]
  viewport: { x: number, y: number, zoom: number }
  createdAt: string             // ISO timestamp
}
```

Temp IDs generated via `crypto.randomUUID()`. The blob is written on every mutation (debounced ~500ms). A canvas with 50 drafts, connections, and groups is ~20-30KB, well within localStorage limits.

### Persistence Abstraction

**`useCanvasPersistence(canvasId, user)`** returns a uniform mutation interface:

```typescript
{
  saveDraft(draft)
  deleteDraft(draftId)
  updateDraftPosition(draftId, x, y)
  saveConnection(connection)
  deleteConnection(connectionId)
  saveGroup(group)
  deleteGroup(groupId)
  updateGroupPosition(groupId, x, y)
  updateCanvasName(name, description, icon)
  updateViewport(x, y, zoom)
}
```

- **Authenticated:** delegates to existing TanStack Query mutations (current behavior, unchanged).
- **Anonymous:** reads/modifies the localStorage blob via `localCanvasStore.ts` and updates SolidJS stores directly. No network calls.

Canvas.tsx currently creates ~12 TanStack mutations inline (lines ~561-850). These get replaced with calls through this hook. Store population on load also branches: if anonymous, populate from localStorage instead of `fetchCanvas()`.

### Sync on Sign-In

After `login()` completes in `userProvider.tsx`:

1. Check localStorage for `draft-sim:local-canvas`
2. If none exists, normal login flow
3. If it exists:
   - `POST /api/canvas/` with `{ name, description, icon }` to get `canvasId`
   - Create each draft via `POST /api/canvas/:canvasId/draft`
   - Create each group via `POST /api/canvas/:canvasId/group`
   - Update draft `group_id` references to server-assigned group IDs
   - Create each connection via `POST /api/canvas/:canvasId/connection` with remapped draft/group IDs
4. Clear localStorage
5. Navigate to `/canvas/:canvasId`

**ID remapping:** A `Map<tempId, serverId>` is built up as each entity is created server-side. Connection source/target IDs and draft group assignments are remapped before posting.

**Error handling:** If sync fails, keep local canvas in localStorage and show a toast: "Couldn't save your canvas. It's still stored locally." No partial server state -- if canvas creation fails, nothing was persisted.

### UX

**Navigation is the same for everyone.** When an anonymous user creates or opens a canvas, it goes to local mode instead of hitting the API. The URL can be `/canvas/local` or `/canvas` with no server-assigned ID.

If a local canvas already exists in storage, it loads. Otherwise, an empty one is initialized. The canvas list view shows their single local canvas or the empty/create state.

**Visual indicators:**
- Subtle banner/badge: "Local -- sign in to save"
- Share/collaboration features hidden
- Everything else looks and works identically

**Disabled for anonymous:**
- Real-time collaboration (no socket room)
- Sharing/permissions
- Canvas list (one canvas, always on it)
- Creating additional canvases

## Files

### New

- `frontend/src/utils/localCanvasStore.ts` -- localStorage read/write/clear for the local canvas blob
- `frontend/src/utils/canvasPersistence.ts` -- persistence abstraction hook that routes to API or localStorage

### Modified

- `frontend/src/Canvas.tsx` -- use persistence hook instead of inline TanStack mutations
- `frontend/src/userProvider.tsx` -- post-login sync logic
- `frontend/src/workflows/CanvasWorkflow.tsx` -- branch on auth state for loading canvas data
- Canvas list component -- show local canvas entry for anonymous users

### No backend changes required
