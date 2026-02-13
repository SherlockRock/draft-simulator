# DRA-24: Group Context Menu

## Problem Statement

Users need a quick way to perform actions on groups in their canvas without navigating through multiple UI elements. Currently, rename requires clicking the group name on canvas, and delete requires clicking the small trash icon in the header.

## Proposed Solution

Add a right-click context menu to groups in **both locations**:
1. Sidebar group list (in `CanvasWorkflow.tsx`)
2. Canvas group headers (in `CustomGroupContainer.tsx`)

### Menu Options
- **Rename** - Triggers inline edit mode on the canvas group header
- **Go to** - Pans canvas to center the group
- **Delete** - Opens `DeleteGroupDialog` with keep/delete drafts options

### Design Decisions

1. **Shared component**: Create a reusable `GroupContextMenu` component mirroring `DraftContextMenu`
2. **Separate signals**: Canvas and sidebar each manage their own context menu state (same pattern as draft context menu)
3. **Rename flow**: Triggers existing inline edit in `CustomGroupContainer` via `editingGroupId` signal
4. **Delete flow**: Reuses existing `DeleteGroupDialog` and delete mutations
5. **Local mode**: Supported via existing `localUpdateGroup` and `localDeleteGroup` mutations

### Component Structure

**GroupContextMenu props:**
```typescript
type GroupContextMenuProps = {
    position: { x: number; y: number };
    group: CanvasGroup;
    onRename: () => void;
    onGoTo: () => void;
    onDelete: () => void;
    onClose: () => void;
};
```

### Rename Flow

**Canvas (from canvas context menu):**
1. Right-click group header → context menu appears
2. Click "Rename" → sets `editingGroupId` signal to group ID
3. `CustomGroupContainer` has createEffect watching `editingGroupId` prop
4. When matched, auto-enters edit mode
5. Existing blur/keydown handlers save via `onRenameGroup`

**Sidebar (from sidebar context menu):**
1. Right-click group in sidebar → context menu appears
2. Click "Rename" → pans canvas to group, sets `editingGroupId`
3. Same flow as canvas from there

**CustomGroupContainer changes:**
- Add optional `editingGroupId?: Accessor<string | null>` prop
- Add createEffect to watch and trigger edit mode when ID matches

### Delete Flow

Both locations use existing infrastructure:
1. Click "Delete" → context menu closes
2. `DeleteGroupDialog` opens via existing `groupToDelete` signal
3. User chooses "Keep Drafts" or "Delete All"
4. Existing `deleteGroupMutation` or `localDeleteGroup` executes

### State Management

**Canvas.tsx:**
```typescript
const [groupContextMenu, setGroupContextMenu] = createSignal<{
    group: CanvasGroup;
    position: { x: number; y: number };
} | null>(null);

const [editingGroupId, setEditingGroupId] = createSignal<string | null>(null);
```

**CanvasWorkflow.tsx:**
```typescript
const [sidebarGroupContextMenu, setSidebarGroupContextMenu] = createSignal<{
    group: CanvasGroup;
    position: { x: number; y: number };
} | null>(null);
```

Sidebar needs handlers passed down from Canvas:
- `setEditingGroupId` - to trigger rename on canvas
- `handleDeleteGroup` - to open delete dialog

## Implementation Tasks

1. **Create `GroupContextMenu` component** (`frontend/src/components/GroupContextMenu.tsx`)
   - Mirror `DraftContextMenu` structure and styling
   - Three menu items: Rename, Go to, Delete

2. **Update `CustomGroupContainer`**
   - Add `editingGroupId?: Accessor<string | null>` prop
   - Add createEffect to auto-enter edit mode when ID matches

3. **Integrate into Canvas.tsx**
   - Add `groupContextMenu` and `editingGroupId` signals
   - Add `onContextMenu` prop to `CustomGroupContainer`
   - Handle context menu in group header
   - Render `GroupContextMenu` when active

4. **Integrate into CanvasWorkflow.tsx**
   - Add `sidebarGroupContextMenu` signal
   - Add `onContextMenu` to sidebar group rows
   - Pass `setEditingGroupId` and delete handler from Canvas
   - Render `GroupContextMenu` when active

5. **Permission checks**
   - Only show context menu when `hasEditPermissions()` returns true
   - Prevent default browser context menu for edit users only

## Existing Infrastructure

- Backend DELETE `/canvas/:id/group/:groupId?keepDrafts=` - exists
- Backend PUT `/canvas/:id/group/:groupId` with name field - exists
- `DeleteGroupDialog` component - exists
- `localUpdateGroup` and `localDeleteGroup` - exist
- Inline rename in `CustomGroupContainer` - exists (click name to edit)
