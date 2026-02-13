# Group Context Menu (DRA-24) Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add right-click context menu to canvas groups in both sidebar and canvas, with Rename, Go to, and Delete actions.

**Architecture:** Create a `GroupContextMenu` component mirroring `DraftContextMenu`. Canvas.tsx manages canvas context menu + editingGroupId signal. CanvasWorkflow.tsx manages sidebar context menu and receives handlers from Canvas.

**Tech Stack:** SolidJS, TypeScript, Tailwind CSS

---

### Task 1: Create GroupContextMenu Component

**Files:**
- Create: `frontend/src/components/GroupContextMenu.tsx`
- Reference: `frontend/src/components/DraftContextMenu.tsx`

**Step 1: Create the component file**

```tsx
import { Component, onMount, onCleanup } from "solid-js";
import { CanvasGroup } from "../utils/types";

type GroupContextMenuProps = {
    position: { x: number; y: number };
    group: CanvasGroup;
    onRename: () => void;
    onGoTo: () => void;
    onDelete: () => void;
    onClose: () => void;
};

export const GroupContextMenu: Component<GroupContextMenuProps> = (props) => {
    let menuRef: HTMLDivElement | undefined;

    const handleClickOutside = (e: MouseEvent) => {
        if (menuRef && !menuRef.contains(e.target as Node)) {
            props.onClose();
        }
    };

    onMount(() => {
        setTimeout(() => {
            document.addEventListener("mousedown", handleClickOutside);
        }, 0);
    });

    onCleanup(() => {
        document.removeEventListener("mousedown", handleClickOutside);
    });

    return (
        <div
            ref={menuRef}
            class="group-context-menu fixed z-50 rounded-md border border-slate-500 bg-slate-700 py-1 shadow-lg"
            style={{
                left: `${props.position.x}px`,
                top: `${props.position.y}px`
            }}
        >
            <button
                class="w-full px-4 py-2 text-left text-sm text-slate-200 hover:bg-slate-600"
                onClick={() => {
                    props.onRename();
                    props.onClose();
                }}
            >
                Rename
            </button>
            <button
                class="w-full px-4 py-2 text-left text-sm text-slate-200 hover:bg-slate-600"
                onClick={() => {
                    props.onGoTo();
                    props.onClose();
                }}
            >
                Go to
            </button>
            <button
                class="w-full px-4 py-2 text-left text-sm text-red-400 hover:bg-slate-600"
                onClick={() => {
                    props.onDelete();
                    props.onClose();
                }}
            >
                Delete
            </button>
        </div>
    );
};
```

**Step 2: Verify TypeScript compiles**

Run: `cd frontend && npx tsc --noEmit`
Expected: No errors

**Step 3: Commit**

```bash
git add frontend/src/components/GroupContextMenu.tsx
git commit -m "feat(canvas): add GroupContextMenu component (DRA-24)"
```

---

### Task 2: Update CustomGroupContainer for External Edit Trigger

**Files:**
- Modify: `frontend/src/components/CustomGroupContainer.tsx`

**Step 1: Add editingGroupId prop to type**

In `CustomGroupContainerProps` type (around line 4-23), add:

```tsx
editingGroupId?: Accessor<string | null>;
```

Add `Accessor` to the imports from "solid-js" if not already present.

**Step 2: Add createEffect to watch editingGroupId**

After the existing signals (around line 36), add:

```tsx
createEffect(() => {
    if (props.editingGroupId?.() === props.group.id) {
        setEditName(props.group.name);
        setIsEditing(true);
    }
});
```

Add `createEffect` to the imports from "solid-js".

**Step 3: Verify TypeScript compiles**

Run: `cd frontend && npx tsc --noEmit`
Expected: No errors

**Step 4: Commit**

```bash
git add frontend/src/components/CustomGroupContainer.tsx
git commit -m "feat(canvas): add editingGroupId prop to CustomGroupContainer (DRA-24)"
```

---

### Task 3: Add Context Menu State to Canvas.tsx

**Files:**
- Modify: `frontend/src/Canvas.tsx`

**Step 1: Add import for GroupContextMenu**

Near other component imports (around line 85):

```tsx
import { GroupContextMenu } from "./components/GroupContextMenu";
```

**Step 2: Add signals for group context menu**

Find the existing `draftContextMenu` signal (around line 546) and add nearby:

```tsx
const [groupContextMenu, setGroupContextMenu] = createSignal<{
    group: CanvasGroup;
    position: { x: number; y: number };
} | null>(null);

const [editingGroupId, setEditingGroupId] = createSignal<string | null>(null);
```

**Step 3: Add handler and close functions**

Near `handleDraftContextMenu` (around line 1866), add:

```tsx
const handleGroupContextMenu = (group: CanvasGroup, e: MouseEvent) => {
    if (!hasEditPermissions()) return;
    e.preventDefault();
    setGroupContextMenu({
        group,
        position: { x: e.clientX, y: e.clientY }
    });
};

const closeGroupContextMenu = () => {
    setGroupContextMenu(null);
};
```

**Step 4: Verify TypeScript compiles**

Run: `cd frontend && npx tsc --noEmit`
Expected: No errors

**Step 5: Commit**

```bash
git add frontend/src/Canvas.tsx
git commit -m "feat(canvas): add group context menu state and handlers (DRA-24)"
```

---

### Task 4: Wire Context Menu to CustomGroupContainer

**Files:**
- Modify: `frontend/src/components/CustomGroupContainer.tsx`
- Modify: `frontend/src/Canvas.tsx`

**Step 1: Add onContextMenu prop to CustomGroupContainer**

In `CustomGroupContainerProps` type, add:

```tsx
onContextMenu?: (group: CanvasGroup, e: MouseEvent) => void;
```

**Step 2: Add onContextMenu handler to header div**

Find the header div (around line 142-152) and add onContextMenu:

```tsx
<div
    class="flex items-center justify-between rounded-t-lg bg-slate-800 px-3"
    style={{
        height: `${HEADER_HEIGHT}px`,
        cursor: props.canEdit() ? "move" : "default"
    }}
    onMouseDown={(e) => {
        if (!isEditing()) {
            props.onGroupMouseDown(props.group.id, e);
        }
    }}
    onContextMenu={(e) => {
        if (props.canEdit() && props.onContextMenu) {
            e.preventDefault();
            props.onContextMenu(props.group, e);
        }
    }}
>
```

**Step 3: Pass props to CustomGroupContainer in Canvas.tsx**

Find where `CustomGroupContainer` is rendered (around line 2510-2533) and add props:

```tsx
<CustomGroupContainer
    group={group}
    drafts={getDraftsForGroup(group.id)}
    viewport={viewport}
    onGroupMouseDown={onGroupMouseDown}
    onDeleteGroup={handleDeleteGroup}
    onRenameGroup={handleRenameGroup}
    onResizeGroup={handleResizeGroup}
    onResizeEnd={handleResizeEnd}
    canEdit={hasEditPermissions}
    isConnectionMode={isConnectionMode()}
    isDragTarget={dragOverGroupId() === group.id}
    isExitingSource={exitingGroupId() === group.id}
    contentMinWidth={computeMinGroupSize(group.id).minWidth}
    contentMinHeight={computeMinGroupSize(group.id).minHeight}
    onSelectAnchor={onGroupAnchorClick}
    isGroupSelected={groupConnectionSource() === group.id}
    sourceAnchor={sourceAnchor()}
    onContextMenu={handleGroupContextMenu}
    editingGroupId={editingGroupId}
>
```

**Step 4: Verify TypeScript compiles**

Run: `cd frontend && npx tsc --noEmit`
Expected: No errors

**Step 5: Commit**

```bash
git add frontend/src/components/CustomGroupContainer.tsx frontend/src/Canvas.tsx
git commit -m "feat(canvas): wire context menu to CustomGroupContainer (DRA-24)"
```

---

### Task 5: Render GroupContextMenu in Canvas.tsx

**Files:**
- Modify: `frontend/src/Canvas.tsx`

**Step 1: Add GroupContextMenu render**

Find where `DraftContextMenu` is rendered (around line 2786-2796). Add similar block nearby:

```tsx
<Show when={groupContextMenu()}>
    {(menu) => (
        <GroupContextMenu
            position={menu().position}
            group={menu().group}
            onRename={() => {
                setEditingGroupId(menu().group.id);
                closeGroupContextMenu();
            }}
            onGoTo={() => {
                const group = menu().group;
                setViewport({
                    x: group.positionX - window.innerWidth / 2 / viewport().zoom,
                    y: group.positionY - window.innerHeight / 2 / viewport().zoom,
                    zoom: viewport().zoom
                });
                closeGroupContextMenu();
            }}
            onDelete={() => {
                handleDeleteGroup(menu().group.id);
                closeGroupContextMenu();
            }}
            onClose={closeGroupContextMenu}
        />
    )}
</Show>
```

**Step 2: Verify TypeScript compiles**

Run: `cd frontend && npx tsc --noEmit`
Expected: No errors

**Step 3: Manual test - canvas context menu**

1. Start frontend: `cd frontend && npm run dev`
2. Navigate to a canvas with groups
3. Right-click a group header
4. Verify menu appears with Rename, Go to, Delete
5. Test each action works

**Step 4: Commit**

```bash
git add frontend/src/Canvas.tsx
git commit -m "feat(canvas): render GroupContextMenu on canvas (DRA-24)"
```

---

### Task 6: Add Sidebar Group Context Menu to CanvasWorkflow

**Files:**
- Modify: `frontend/src/workflows/CanvasWorkflow.tsx`

**Step 1: Add import for GroupContextMenu**

Near other component imports:

```tsx
import { GroupContextMenu } from "../components/GroupContextMenu";
```

**Step 2: Add signal for sidebar group context menu**

Near `sidebarDraftContextMenu` signal (around line 164):

```tsx
const [sidebarGroupContextMenu, setSidebarGroupContextMenu] = createSignal<{
    group: CanvasGroup;
    position: { x: number; y: number };
} | null>(null);
```

**Step 3: Add handler functions**

Near `handleSidebarDraftContextMenu` (around line 279):

```tsx
const handleSidebarGroupContextMenu = (group: CanvasGroup, e: MouseEvent) => {
    e.preventDefault();
    setSidebarGroupContextMenu({
        group,
        position: { x: e.clientX, y: e.clientY }
    });
};

const closeSidebarGroupContextMenu = () => {
    setSidebarGroupContextMenu(null);
};
```

**Step 4: Verify TypeScript compiles**

Run: `cd frontend && npx tsc --noEmit`
Expected: No errors

**Step 5: Commit**

```bash
git add frontend/src/workflows/CanvasWorkflow.tsx
git commit -m "feat(canvas): add sidebar group context menu state (DRA-24)"
```

---

### Task 7: Wire Context Menu to Sidebar Group Rows

**Files:**
- Modify: `frontend/src/workflows/CanvasWorkflow.tsx`

**Step 1: Add onContextMenu to sidebar group row**

Find the group row div in sidebar (around line 635-657). Add onContextMenu:

```tsx
<div
    class="flex cursor-pointer items-center gap-2 rounded-md bg-slate-600 px-2 py-1.5 text-xs font-medium text-slate-300 hover:bg-slate-500"
    onClick={() => {
        const callback = navigateToDraftCallback();
        if (callback) {
            callback(group.positionX, group.positionY);
        }
    }}
    onContextMenu={(e) => handleSidebarGroupContextMenu(group, e)}
>
```

**Step 2: Verify TypeScript compiles**

Run: `cd frontend && npx tsc --noEmit`
Expected: No errors

**Step 3: Commit**

```bash
git add frontend/src/workflows/CanvasWorkflow.tsx
git commit -m "feat(canvas): add context menu handler to sidebar group rows (DRA-24)"
```

---

### Task 8: Render GroupContextMenu in Sidebar and Wire Actions

**Files:**
- Modify: `frontend/src/workflows/CanvasWorkflow.tsx`

**Step 1: Identify what callbacks need to come from Canvas**

The sidebar needs:
- `setEditingGroupId` - to trigger rename
- `handleDeleteGroup` - to open delete dialog
- `navigateToDraftCallback` - already available for Go to

These need to be passed from where Canvas is rendered. Check how Canvas is used in CanvasWorkflow.

**Step 2: Add props to Canvas component for callbacks**

First, check Canvas.tsx exports. We need to expose `setEditingGroupId` and `handleDeleteGroup`.

Add to Canvas props type in Canvas.tsx (if not using render props pattern, may need to use a ref or context).

Actually, looking at the codebase structure: Canvas is rendered inside CanvasWorkflow. The cleanest approach is to:
1. Have Canvas expose callbacks via a ref or
2. Use a shared context

For simplicity, add props to Canvas that allow parent to receive these callbacks:

In Canvas.tsx, add to props:
```tsx
onEditingGroupIdChange?: (setter: (id: string | null) => void) => void;
onDeleteGroupHandler?: (handler: (groupId: string) => void) => void;
```

In Canvas component body, call these on mount to pass the functions up:
```tsx
onMount(() => {
    props.onEditingGroupIdChange?.(setEditingGroupId);
    props.onDeleteGroupHandler?.((id) => handleDeleteGroup(id));
});
```

**Step 3: In CanvasWorkflow, capture the callbacks**

Add signals to store the callbacks:
```tsx
const [canvasSetEditingGroupId, setCanvasSetEditingGroupId] = createSignal<((id: string | null) => void) | null>(null);
const [canvasHandleDeleteGroup, setCanvasHandleDeleteGroup] = createSignal<((groupId: string) => void) | null>(null);
```

Pass to Canvas:
```tsx
<Canvas
    ...
    onEditingGroupIdChange={(setter) => setCanvasSetEditingGroupId(() => setter)}
    onDeleteGroupHandler={(handler) => setCanvasHandleDeleteGroup(() => handler)}
/>
```

**Step 4: Render GroupContextMenu in sidebar**

Near where `DraftContextMenu` is rendered for sidebar (around line 833):

```tsx
<Show when={sidebarGroupContextMenu()}>
    {(menu) => (
        <GroupContextMenu
            position={menu().position}
            group={menu().group}
            onRename={() => {
                const callback = navigateToDraftCallback();
                if (callback) {
                    callback(menu().group.positionX, menu().group.positionY);
                }
                canvasSetEditingGroupId()?.(menu().group.id);
                closeSidebarGroupContextMenu();
            }}
            onGoTo={() => {
                const callback = navigateToDraftCallback();
                if (callback) {
                    callback(menu().group.positionX, menu().group.positionY);
                }
                closeSidebarGroupContextMenu();
            }}
            onDelete={() => {
                canvasHandleDeleteGroup()?.(menu().group.id);
                closeSidebarGroupContextMenu();
            }}
            onClose={closeSidebarGroupContextMenu}
        />
    )}
</Show>
```

**Step 5: Verify TypeScript compiles**

Run: `cd frontend && npx tsc --noEmit`
Expected: No errors

**Step 6: Manual test - sidebar context menu**

1. Start frontend: `cd frontend && npm run dev`
2. Navigate to a canvas with groups
3. Right-click a group in the sidebar
4. Verify menu appears
5. Test Rename - should pan to group and enter edit mode
6. Test Go to - should pan to group
7. Test Delete - should open delete dialog

**Step 7: Commit**

```bash
git add frontend/src/Canvas.tsx frontend/src/workflows/CanvasWorkflow.tsx
git commit -m "feat(canvas): render GroupContextMenu in sidebar with actions (DRA-24)"
```

---

### Task 9: Clear editingGroupId After Edit Completes

**Files:**
- Modify: `frontend/src/components/CustomGroupContainer.tsx`

**Step 1: Add callback to clear editingGroupId**

Add prop to type:
```tsx
onEditingComplete?: () => void;
```

**Step 2: Call callback when editing ends**

In `handleNameBlur` function, after `setIsEditing(false)`:
```tsx
props.onEditingComplete?.();
```

In `handleNameKeyDown` for Escape case, after `setIsEditing(false)`:
```tsx
props.onEditingComplete?.();
```

**Step 3: Pass callback from Canvas.tsx**

Where CustomGroupContainer is rendered, add:
```tsx
onEditingComplete={() => setEditingGroupId(null)}
```

**Step 4: Verify TypeScript compiles**

Run: `cd frontend && npx tsc --noEmit`
Expected: No errors

**Step 5: Commit**

```bash
git add frontend/src/components/CustomGroupContainer.tsx frontend/src/Canvas.tsx
git commit -m "feat(canvas): clear editingGroupId after edit completes (DRA-24)"
```

---

### Task 10: Final Testing and Cleanup

**Step 1: Full manual test**

Test matrix:
- [ ] Canvas: Right-click group header shows menu
- [ ] Canvas: Rename enters edit mode, saves on Enter/blur
- [ ] Canvas: Go to pans to group (should already be visible, minor pan)
- [ ] Canvas: Delete opens dialog, both options work
- [ ] Sidebar: Right-click group shows menu
- [ ] Sidebar: Rename pans to group and enters edit mode
- [ ] Sidebar: Go to pans to group
- [ ] Sidebar: Delete opens dialog, both options work
- [ ] Local mode: All actions work for anonymous users
- [ ] View-only: Context menu does NOT appear

**Step 2: Update Linear issue**

Move DRA-24 to "In Review" status.

**Step 3: Final commit if any fixes needed**

```bash
git add -A
git commit -m "fix(canvas): address group context menu edge cases (DRA-24)"
```
