# Series Group Container Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Implement visual container representation for imported versus series on the canvas.

**Architecture:** Create a `SeriesGroupContainer` component that wraps grouped drafts. Canvas.tsx partitions drafts into grouped/ungrouped, rendering containers for groups and individual cards for ungrouped. Group dragging moves all contained drafts together.

**Tech Stack:** SolidJS, TypeScript, Tailwind CSS, TanStack Query, Socket.io

---

### Task 1: Update Frontend Types

**Files:**
- Modify: `frontend/src/utils/actions.ts:190-196`

**Step 1: Add groups to CanvasResposnse type**

In `frontend/src/utils/actions.ts`, update the type:

```typescript
export type CanvasResposnse = {
    name: string;
    drafts: CanvasDraft[];
    connections: Connection[];
    groups: CanvasGroup[];
    lastViewport: Viewport;
    userPermissions: "view" | "edit" | "admin";
};
```

**Step 2: Add CanvasGroup import**

At the top of `frontend/src/utils/actions.ts`, add `CanvasGroup` to the imports from types:

```typescript
import { CanvasDraft, Viewport, Connection, CanvasGroup } from "./types";
```

**Step 3: Commit**

```bash
git add frontend/src/utils/actions.ts
git commit -m "feat(canvas): add groups to CanvasResposnse type"
```

---

### Task 2: Add Group State to Canvas.tsx

**Files:**
- Modify: `frontend/src/Canvas.tsx:37` (imports)
- Modify: `frontend/src/Canvas.tsx:455-456` (state declarations)

**Step 1: Update imports**

Add `CanvasGroup` to the types import:

```typescript
import { CanvasDraft, draft, Viewport, Connection, CanvasGroup } from "./utils/types";
```

**Step 2: Add canvasGroups store**

After the `connections` store declaration (around line 456), add:

```typescript
const [canvasGroups, setCanvasGroups] = createStore<CanvasGroup[]>([]);
```

**Step 3: Add group drag state**

After the `vertexDragState` signal (around line 502), add:

```typescript
const [groupDragState, setGroupDragState] = createSignal<{
    activeGroupId: string | null;
    offsetX: number;
    offsetY: number;
}>({
    activeGroupId: null,
    offsetX: 0,
    offsetY: 0
});
```

**Step 4: Add delete group dialog state**

After `isImportDialogOpen` signal (around line 505), add:

```typescript
const [isDeleteGroupDialogOpen, setIsDeleteGroupDialogOpen] = createSignal(false);
const [groupToDelete, setGroupToDelete] = createSignal<CanvasGroup | null>(null);
```

**Step 5: Commit**

```bash
git add frontend/src/Canvas.tsx
git commit -m "feat(canvas): add group state management"
```

---

### Task 3: Update Data Loading and Socket Handlers

**Files:**
- Modify: `frontend/src/Canvas.tsx` (createEffect blocks around lines 722-876)

**Step 1: Update initial data loading**

Find the createEffect that sets initial canvas data (around line 722). Update to include groups:

```typescript
createEffect(() => {
    if (props.canvasData && canvasDrafts.length === 0) {
        setCanvasDrafts(props.canvasData.drafts ?? []);
        setConnections(props.canvasData.connections ?? []);
        setCanvasGroups(props.canvasData.groups ?? []);
        // ... rest of existing code
```

**Step 2: Update canvasUpdate socket handler**

Find the `canvasUpdate` socket handler (around line 751). Update to include groups:

```typescript
socketAccessor().on(
    "canvasUpdate",
    (data: {
        canvas: { id: string; name: string };
        drafts: CanvasDraft[];
        connections: Connection[];
        groups?: CanvasGroup[];
    }) => {
        setCanvasDrafts(data.drafts);
        setConnections(data.connections);
        setCanvasGroups(data.groups ?? []);
        queryClient.setQueryData(["canvas", params.id], (oldData: any) => {
            return { ...oldData, name: data.canvas.name };
        });
    }
);
```

**Step 3: Add groupMoved socket handler**

After the `vertexDeleted` handler (around line 863), add:

```typescript
socketAccessor().on(
    "groupMoved",
    (data: { groupId: string; positionX: number; positionY: number }) => {
        const gState = groupDragState();
        if (gState.activeGroupId !== data.groupId) {
            setCanvasGroups(
                (g) => g.id === data.groupId,
                { positionX: data.positionX, positionY: data.positionY }
            );
        }
    }
);
```

**Step 4: Add cleanup for groupMoved**

In the onCleanup block (around line 864), add:

```typescript
socketAccessor().off("groupMoved");
```

**Step 5: Commit**

```bash
git add frontend/src/Canvas.tsx
git commit -m "feat(canvas): wire up group data loading and socket handlers"
```

---

### Task 4: Add Group Mutation and Handlers

**Files:**
- Modify: `frontend/src/Canvas.tsx`

**Step 1: Import deleteCanvasGroup and updateCanvasGroupPosition**

Add to imports from actions.ts:

```typescript
import {
    // ... existing imports
    deleteCanvasGroup,
    updateCanvasGroupPosition
} from "./utils/actions";
```

**Step 2: Add updateGroupPositionMutation**

After the existing mutations (around line 693), add:

```typescript
const updateGroupPositionMutation = useMutation(() => ({
    mutationFn: updateCanvasGroupPosition,
    onError: (error: Error) => {
        toast.error(`Failed to save group position: ${error.message}`);
        queryClient.invalidateQueries({ queryKey: ["canvas", params.id] });
    }
}));

const deleteGroupMutation = useMutation(() => ({
    mutationFn: deleteCanvasGroup,
    onSuccess: () => {
        setIsDeleteGroupDialogOpen(false);
        setGroupToDelete(null);
        toast.success("Series removed from canvas");
        queryClient.invalidateQueries({ queryKey: ["canvas", params.id] });
    },
    onError: (error: Error) => {
        toast.error(`Error removing series: ${error.message}`);
    }
}));
```

**Step 3: Add group drag emit function**

After the `debouncedEmitVertexMove` (around line 720), add:

```typescript
const emitGroupMove = (groupId: string, positionX: number, positionY: number) => {
    socketAccessor().emit("groupMove", {
        canvasId: params.id,
        groupId,
        positionX,
        positionY
    });
};

const debouncedEmitGroupMove = debounce(emitGroupMove, 25);
```

**Step 4: Add group interaction handlers**

After `onSelectPrevious` function (around line 1168), add:

```typescript
const onGroupMouseDown = (groupId: string, e: MouseEvent) => {
    if (isConnectionMode()) return;
    if (!hasEditPermissions(props.canvasData?.userPermissions)) return;

    const target = e.target as HTMLElement;
    if (target.closest("button")) return;

    e.preventDefault();
    const group = canvasGroups.find((g) => g.id === groupId);
    if (group) {
        const worldCoords = screenToWorld(e.clientX, e.clientY);
        setGroupDragState({
            activeGroupId: groupId,
            offsetX: worldCoords.x - group.positionX,
            offsetY: worldCoords.y - group.positionY
        });
    }
};

const handleDeleteGroup = (groupId: string) => {
    const group = canvasGroups.find((g) => g.id === groupId);
    if (group) {
        setGroupToDelete(group);
        setIsDeleteGroupDialogOpen(true);
    }
};

const onDeleteGroupConfirm = () => {
    const group = groupToDelete();
    if (group) {
        deleteGroupMutation.mutate({
            canvasId: params.id,
            groupId: group.id
        });
    }
};

const onDeleteGroupCancel = () => {
    setIsDeleteGroupDialogOpen(false);
    setGroupToDelete(null);
};
```

**Step 5: Commit**

```bash
git add frontend/src/Canvas.tsx
git commit -m "feat(canvas): add group mutations and interaction handlers"
```

---

### Task 5: Update Mouse Move/Up Handlers for Group Dragging

**Files:**
- Modify: `frontend/src/Canvas.tsx` (onWindowMouseMove and onWindowMouseUp in onMount)

**Step 1: Update onWindowMouseMove**

In `onWindowMouseMove` (around line 1237), add group drag handling after vertex drag handling and before the existing drag state handling:

```typescript
// After vertex drag handling (around line 1261), add:
const gState = groupDragState();
if (gState.activeGroupId) {
    const worldCoords = screenToWorld(e.clientX, e.clientY);
    const newX = worldCoords.x - gState.offsetX;
    const newY = worldCoords.y - gState.offsetY;
    setCanvasGroups(
        (g) => g.id === gState.activeGroupId,
        { positionX: newX, positionY: newY }
    );
    debouncedEmitGroupMove(gState.activeGroupId, newX, newY);
    return;
}
```

**Step 2: Update onWindowMouseUp**

In `onWindowMouseUp` (around line 1289), add group drag handling after vertex drag handling:

```typescript
// After vertex drag handling (around line 1316), add:
const gState = groupDragState();
if (gState.activeGroupId) {
    const group = canvasGroups.find((g) => g.id === gState.activeGroupId);
    if (group) {
        updateGroupPositionMutation.mutate({
            canvasId: params.id,
            groupId: gState.activeGroupId,
            positionX: group.positionX,
            positionY: group.positionY
        });
    }
    setGroupDragState({
        activeGroupId: null,
        offsetX: 0,
        offsetY: 0
    });
    return;
}
```

**Step 3: Commit**

```bash
git add frontend/src/Canvas.tsx
git commit -m "feat(canvas): implement group drag handling"
```

---

### Task 6: Create SeriesGroupContainer Component

**Files:**
- Create: `frontend/src/components/SeriesGroupContainer.tsx`

**Step 1: Create the component file**

```typescript
import { For, Show, createMemo, Accessor } from "solid-js";
import { CanvasDraft, CanvasGroup, Viewport, AnchorType } from "../utils/types";
import { cardWidth, cardHeight } from "../utils/helpers";

type SeriesGroupContainerProps = {
    group: CanvasGroup;
    drafts: CanvasDraft[];
    viewport: Accessor<Viewport>;
    onGroupMouseDown: (groupId: string, e: MouseEvent) => void;
    onDeleteGroup: (groupId: string) => void;
    canEdit: boolean;
    isConnectionMode: boolean;
    layoutToggle: () => boolean;
    // Pass-through for CanvasCard rendering
    renderDraftCard: (draft: CanvasDraft, relativeX: number, relativeY: number) => any;
};

// Constants for layout
const HEADER_HEIGHT = 56;
const PADDING = 20;
const CARD_SPACING = 380;

export const SeriesGroupContainer = (props: SeriesGroupContainerProps) => {
    const worldToScreen = (worldX: number, worldY: number) => {
        const vp = props.viewport();
        return {
            x: (worldX - vp.x) * vp.zoom,
            y: (worldY - vp.y) * vp.zoom
        };
    };

    const screenPos = () => worldToScreen(props.group.positionX, props.group.positionY);

    const sortedDrafts = createMemo(() => {
        return [...props.drafts].sort(
            (a, b) => (a.Draft.seriesIndex ?? 0) - (b.Draft.seriesIndex ?? 0)
        );
    });

    const containerWidth = createMemo(() => {
        const numDrafts = props.drafts.length;
        const draftWidth = cardWidth(props.layoutToggle());
        return PADDING * 2 + draftWidth + (numDrafts - 1) * CARD_SPACING;
    });

    const containerHeight = createMemo(() => {
        return HEADER_HEIGHT + PADDING * 2 + cardHeight(props.layoutToggle());
    });

    const teamScore = createMemo(() => {
        let blueWins = 0;
        let redWins = 0;
        props.drafts.forEach((d) => {
            if (d.Draft.winner === "blue") blueWins++;
            if (d.Draft.winner === "red") redWins++;
        });
        return { blue: blueWins, red: redWins };
    });

    const isCompleted = createMemo(() => {
        return props.drafts.length > 0 && props.drafts.every((d) => d.Draft.completed);
    });

    const seriesTypeLabel = createMemo(() => {
        const len = props.group.metadata.length ?? props.drafts.length;
        return `Bo${len}`;
    });

    return (
        <div
            class="absolute z-20 rounded-lg border-2 border-slate-500 bg-slate-700 shadow-xl"
            style={{
                left: `${screenPos().x}px`,
                top: `${screenPos().y}px`,
                width: `${containerWidth()}px`,
                height: `${containerHeight()}px`,
                transform: `scale(${props.viewport().zoom})`,
                "transform-origin": "top left"
            }}
        >
            {/* Header */}
            <div
                class="flex items-center justify-between rounded-t-lg bg-slate-800 px-4"
                style={{ height: `${HEADER_HEIGHT}px`, cursor: props.canEdit ? "move" : "default" }}
                onMouseDown={(e) => props.onGroupMouseDown(props.group.id, e)}
            >
                <div class="flex items-center gap-3">
                    <span class="font-semibold text-slate-50">{props.group.name}</span>

                    {/* Team Score */}
                    <div class="flex items-center gap-2 text-sm">
                        <span class="text-blue-400">
                            {props.group.metadata.blueTeamName ?? "Blue Team"}
                        </span>
                        <span class="font-bold text-slate-50">
                            {teamScore().blue} - {teamScore().red}
                        </span>
                        <span class="text-red-400">
                            {props.group.metadata.redTeamName ?? "Red Team"}
                        </span>
                    </div>
                </div>

                <div class="flex items-center gap-2">
                    {/* Series Type Badge */}
                    <span class="rounded bg-slate-600 px-2 py-0.5 text-xs text-slate-300">
                        {seriesTypeLabel()}
                    </span>

                    {/* Competitive Badge */}
                    <Show when={props.group.metadata.competitive}>
                        <span class="rounded bg-amber-600/30 px-2 py-0.5 text-xs text-amber-300">
                            Competitive
                        </span>
                    </Show>
                    <Show when={!props.group.metadata.competitive}>
                        <span class="rounded bg-slate-600 px-2 py-0.5 text-xs text-slate-400">
                            Casual
                        </span>
                    </Show>

                    {/* Status Indicator */}
                    <Show when={isCompleted()} fallback={
                        <span class="flex items-center gap-1 text-xs text-yellow-400">
                            <span class="h-2 w-2 rounded-full bg-yellow-400"></span>
                            In Progress
                        </span>
                    }>
                        <span class="flex items-center gap-1 text-xs text-green-400">
                            <svg class="h-3 w-3" fill="currentColor" viewBox="0 0 20 20">
                                <path fill-rule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clip-rule="evenodd" />
                            </svg>
                            Completed
                        </span>
                    </Show>

                    {/* Delete Button */}
                    <Show when={props.canEdit}>
                        <button
                            onClick={(e) => {
                                e.stopPropagation();
                                props.onDeleteGroup(props.group.id);
                            }}
                            class="rounded p-1 text-slate-400 hover:bg-slate-700 hover:text-red-400"
                            title="Remove series from canvas"
                        >
                            <svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                            </svg>
                        </button>
                    </Show>
                </div>
            </div>

            {/* Draft Cards Container */}
            <div class="relative" style={{ height: `${containerHeight() - HEADER_HEIGHT}px` }}>
                <For each={sortedDrafts()}>
                    {(draft, index) => {
                        const relativeX = PADDING + index() * CARD_SPACING;
                        const relativeY = PADDING;
                        return props.renderDraftCard(draft, relativeX, relativeY);
                    }}
                </For>
            </div>
        </div>
    );
};
```

**Step 2: Commit**

```bash
git add frontend/src/components/SeriesGroupContainer.tsx
git commit -m "feat(canvas): create SeriesGroupContainer component"
```

---

### Task 7: Integrate SeriesGroupContainer into Canvas.tsx

**Files:**
- Modify: `frontend/src/Canvas.tsx`

**Step 1: Import SeriesGroupContainer**

Add to imports:

```typescript
import { SeriesGroupContainer } from "./components/SeriesGroupContainer";
```

**Step 2: Create memos for grouped/ungrouped drafts**

After the existing state declarations (around line 507), add:

```typescript
const ungroupedDrafts = createMemo(() =>
    canvasDrafts.filter((cd) => !cd.group_id)
);

const getDraftsForGroup = (groupId: string) =>
    canvasDrafts.filter((cd) => cd.group_id === groupId);
```

**Step 3: Create renderDraftCard function for groups**

After the `onDeleteGroupCancel` function, add:

```typescript
const renderGroupedDraftCard = (
    cd: CanvasDraft,
    relativeX: number,
    relativeY: number,
    groupPos: { x: number; y: number }
) => {
    // Calculate absolute world position from group + relative offset
    const absoluteX = groupPos.x + relativeX;
    const absoluteY = groupPos.y + relativeY + 56; // 56 = header height

    const worldToScreen = (worldX: number, worldY: number) => {
        const vp = props.viewport();
        return {
            x: (worldX - vp.x) * vp.zoom,
            y: (worldY - vp.y) * vp.zoom
        };
    };

    const screenPos = worldToScreen(absoluteX, absoluteY);

    // Return a simplified card that doesn't handle its own dragging
    return (
        <div
            class="absolute z-30 flex flex-col rounded-md border border-slate-500 bg-slate-600 shadow-lg"
            classList={{
                "ring-4 ring-blue-400": isConnectionMode() && connectionSource() !== cd.Draft.id,
                "ring-4 ring-green-400": connectionSource() === cd.Draft.id
            }}
            style={{
                left: `${screenPos.x}px`,
                top: `${screenPos.y}px`,
                width: props.layoutToggle() ? "700px" : "350px",
                cursor: "default",
                transform: `scale(${props.viewport().zoom})`,
                "transform-origin": "top left"
            }}
        >
            {/* Re-use CanvasCard internals or create inline */}
        </div>
    );
};
```

Actually, this approach would require duplicating a lot of CanvasCard code. Instead, let's modify CanvasCard to accept an optional position override.

**Step 3 (revised): Modify CanvasCard to support grouped mode**

Add new props to cardProps type (around line 47):

```typescript
type cardProps = {
    canvasDraft: CanvasDraft;
    addBox: (fromBox: CanvasDraft) => void;
    deleteBox: (draftId: string) => void;
    handleNameChange: (draftId: string, newName: string) => void;
    handlePickChange: (draftId: string, pickIndex: number, championName: string) => void;
    onBoxMouseDown: (draftId: string, e: MouseEvent) => void;
    layoutToggle: () => boolean;
    setLayoutToggle: (val: boolean) => void;
    viewport: () => Viewport;
    isConnectionMode: boolean;
    onAnchorClick: (draftId: string, anchorType: AnchorType) => void;
    connectionSource: () => string | null;
    sourceAnchor: () => { type: AnchorType } | null;
    focusedDraftId: () => string | null;
    focusedSelectIndex: () => number;
    onSelectFocus: (draftId: string, selectIndex: number) => void;
    onSelectNext: () => void;
    onSelectPrevious: () => void;
    canEdit: boolean;
    // New props for grouped mode
    isGrouped?: boolean;
    groupPosition?: { x: number; y: number };
    relativePosition?: { x: number; y: number };
};
```

**Step 4: Update CanvasCard screenPos calculation**

In CanvasCard, update the screenPos calculation (around line 110):

```typescript
const screenPos = () => {
    if (props.isGrouped && props.groupPosition && props.relativePosition) {
        const absoluteX = props.groupPosition.x + props.relativePosition.x;
        const absoluteY = props.groupPosition.y + props.relativePosition.y + 56; // header height
        return worldToScreen(absoluteX, absoluteY);
    }
    return worldToScreen(props.canvasDraft.positionX, props.canvasDraft.positionY);
};
```

**Step 5: Update CanvasCard cursor and drag behavior**

In CanvasCard's main div (around line 147), update:

```typescript
cursor: props.isConnectionMode || !props.canEdit || props.isGrouped ? "default" : "move",
```

And update onMouseDown (around line 151):

```typescript
onMouseDown={(e) => {
    if (!props.isConnectionMode && !props.isGrouped) {
        props.onBoxMouseDown(props.canvasDraft.Draft.id, e);
    }
}}
```

**Step 6: Commit**

```bash
git add frontend/src/Canvas.tsx
git commit -m "feat(canvas): extend CanvasCard for grouped mode"
```

---

### Task 8: Render Groups and Ungrouped Drafts

**Files:**
- Modify: `frontend/src/Canvas.tsx` (render section around line 1508)

**Step 1: Update the render section**

Replace the `<For each={canvasDrafts}>` block (around line 1508) with:

```typescript
{/* Render Series Groups */}
<For each={canvasGroups}>
    {(group) => (
        <SeriesGroupContainer
            group={group}
            drafts={getDraftsForGroup(group.id)}
            viewport={props.viewport}
            onGroupMouseDown={onGroupMouseDown}
            onDeleteGroup={handleDeleteGroup}
            canEdit={hasEditPermissions(props.canvasData?.userPermissions)}
            isConnectionMode={isConnectionMode()}
            layoutToggle={props.layoutToggle}
            renderDraftCard={(cd, relativeX, relativeY) => (
                <CanvasCard
                    canvasDraft={cd}
                    addBox={addBox}
                    deleteBox={deleteBox}
                    handleNameChange={handleNameChange}
                    handlePickChange={handlePickChange}
                    viewport={props.viewport}
                    onBoxMouseDown={onBoxMouseDown}
                    layoutToggle={props.layoutToggle}
                    setLayoutToggle={props.setLayoutToggle}
                    isConnectionMode={isConnectionMode()}
                    onAnchorClick={onAnchorClick}
                    connectionSource={connectionSource}
                    sourceAnchor={sourceAnchor}
                    focusedDraftId={focusedDraftId}
                    focusedSelectIndex={focusedSelectIndex}
                    onSelectFocus={onSelectFocus}
                    onSelectNext={onSelectNext}
                    onSelectPrevious={onSelectPrevious}
                    canEdit={hasEditPermissions(props.canvasData?.userPermissions)}
                    isGrouped={true}
                    groupPosition={{ x: group.positionX, y: group.positionY }}
                    relativePosition={{ x: relativeX, y: relativeY }}
                />
            )}
        />
    )}
</For>

{/* Render Ungrouped Drafts */}
<For each={ungroupedDrafts()}>
    {(cd) => (
        <CanvasCard
            canvasDraft={cd}
            addBox={addBox}
            deleteBox={deleteBox}
            handleNameChange={handleNameChange}
            handlePickChange={handlePickChange}
            viewport={props.viewport}
            onBoxMouseDown={onBoxMouseDown}
            layoutToggle={props.layoutToggle}
            setLayoutToggle={props.setLayoutToggle}
            isConnectionMode={isConnectionMode()}
            onAnchorClick={onAnchorClick}
            connectionSource={connectionSource}
            sourceAnchor={sourceAnchor}
            focusedDraftId={focusedDraftId}
            focusedSelectIndex={focusedSelectIndex}
            onSelectFocus={onSelectFocus}
            onSelectNext={onSelectNext}
            onSelectPrevious={onSelectPrevious}
            canEdit={hasEditPermissions(props.canvasData?.userPermissions)}
        />
    )}
</For>
```

**Step 2: Add delete group confirmation dialog**

After the import dialog (around line 1579), add:

```typescript
<Dialog
    isOpen={isDeleteGroupDialogOpen}
    onCancel={onDeleteGroupCancel}
    body={
        <>
            <h3 class="mb-4 text-lg font-bold text-slate-50">
                Remove Series from Canvas?
            </h3>
            <p class="mb-4 text-slate-200">
                This will remove "{groupToDelete()?.name}" and all its games from this canvas.
            </p>
            <p class="mb-6 text-sm text-slate-400">
                The original series data will not be deleted - you can re-import it later.
            </p>
            <div class="flex justify-end gap-4">
                <button
                    onClick={onDeleteGroupCancel}
                    class="rounded bg-teal-700 px-4 py-2 text-slate-50 hover:bg-teal-400"
                >
                    Cancel
                </button>
                <button
                    onClick={onDeleteGroupConfirm}
                    class="rounded bg-red-400 px-4 py-2 text-slate-50 hover:bg-red-600"
                >
                    Remove
                </button>
            </div>
        </>
    }
/>
```

**Step 3: Commit**

```bash
git add frontend/src/Canvas.tsx frontend/src/components/SeriesGroupContainer.tsx
git commit -m "feat(canvas): integrate SeriesGroupContainer rendering"
```

---

### Task 9: Update Backend Group Delete to Clean Up Connections

**Files:**
- Modify: `backend/routes/canvas.js:570-640`

**Step 1: Add connection cleanup before deleting group**

Update the delete group endpoint to remove connections involving drafts in the group. After permission check and before `CanvasDraft.destroy`:

```javascript
// Get draft IDs in the group
const groupDrafts = await CanvasDraft.findAll({
    where: { group_id: groupId, canvas_id: canvasId },
    attributes: ['draft_id'],
    transaction: t,
});
const draftIdsToRemove = new Set(groupDrafts.map(d => d.draft_id));

// Clean up connections involving these drafts
const allConnections = await CanvasConnection.findAll({
    where: { canvas_id: canvasId },
    transaction: t,
});

for (const conn of allConnections) {
    const filteredSources = (conn.source_draft_ids || []).filter(
        (src) => !draftIdsToRemove.has(src.draft_id)
    );
    const filteredTargets = (conn.target_draft_ids || []).filter(
        (tgt) => !draftIdsToRemove.has(tgt.draft_id)
    );

    if (filteredSources.length === 0 || filteredTargets.length === 0) {
        await conn.destroy({ transaction: t });
    } else if (
        filteredSources.length !== conn.source_draft_ids.length ||
        filteredTargets.length !== conn.target_draft_ids.length
    ) {
        conn.source_draft_ids = filteredSources;
        conn.target_draft_ids = filteredTargets;
        await conn.save({ transaction: t });
    }
}

// Delete all CanvasDrafts in the group (existing code)
await CanvasDraft.destroy({
    where: { group_id: groupId, canvas_id: canvasId },
    transaction: t,
});
```

**Step 2: Commit**

```bash
git add backend/routes/canvas.js
git commit -m "fix(canvas): clean up connections when deleting group"
```

---

### Task 10: Add Backend Socket Handler for Group Move

**Files:**
- Modify: `backend/socketHandlers/canvasHandler.js` (or wherever socket handlers are)

**Step 1: Find the socket handler file**

Check `backend/index.js` or `backend/socketHandlers/` for where canvas socket events are handled.

**Step 2: Add groupMove handler**

```javascript
socket.on("groupMove", (data) => {
    const { canvasId, groupId, positionX, positionY } = data;
    socket.to(canvasId).emit("groupMoved", {
        groupId,
        positionX,
        positionY
    });
});
```

**Step 3: Commit**

```bash
git add backend/
git commit -m "feat(canvas): add groupMove socket handler"
```

---

### Task 11: Test the Implementation

**Step 1: Start backend**

```bash
cd backend && node index.js
```

**Step 2: Start frontend**

```bash
cd frontend && npm run dev
```

**Step 3: Manual test checklist**

- [ ] Import a versus series to a canvas
- [ ] Verify series appears in a container with header
- [ ] Verify header shows: series name, team score, Bo3/Bo5 badge, competitive badge, status
- [ ] Verify draft cards appear horizontally inside container
- [ ] Verify connections appear between games
- [ ] Drag container header - all drafts move together
- [ ] Verify individual draft cards inside group are not draggable
- [ ] Click delete button on group header
- [ ] Verify confirmation dialog appears
- [ ] Confirm delete - verify group and drafts removed
- [ ] Verify original series still exists (can re-import)
- [ ] Test connection mode works on grouped drafts

**Step 4: Final commit**

```bash
git add -A
git commit -m "feat(canvas): complete series group container implementation"
```

---

## Summary

This plan implements:
1. Frontend types updated with groups
2. Canvas state management for groups
3. Socket handlers for real-time group updates
4. SeriesGroupContainer component with rich header
5. CanvasCard extended for grouped mode
6. Rendering logic for groups vs ungrouped drafts
7. Backend connection cleanup on group delete
8. Backend socket handler for group movement
