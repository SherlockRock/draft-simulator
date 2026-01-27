# Series Group Container Design

## Overview

Visual representation for imported versus series on the canvas. Series appear as a container box wrapping all games, distinct from standalone drafts.

## Visual Structure

```
┌─────────────────────────────────────────────────────────────────────────┐
│ [Header]                                                                │
│  📋 Series Name    Blue Team 1 - 2 Red Team    Bo3 │ Competitive │ 🗑️  │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│   ┌─────────┐      ┌─────────┐      ┌─────────┐                        │
│   │ Game 1  │ ───► │ Game 2  │ ───► │ Game 3  │                        │
│   │ (Draft) │      │ (Draft) │      │ (Draft) │                        │
│   └─────────┘      └─────────┘      └─────────┘                        │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

### Header Elements (left to right)
- Series name (editable if user has permissions)
- Team score display: "Blue Team X - Y Red Team" with team colors
- Series type badge (Bo3, Bo5)
- Competitive/Casual badge
- Status indicator (in progress = yellow dot, completed = green checkmark)
- Delete group button (trash icon)

### Styling
- Container: `bg-slate-700` with `border-2 border-slate-500`, `rounded-lg`, subtle shadow
- Header: `bg-slate-800` strip at top
- Draft cards: 20px padding from edges, 380px horizontal spacing between cards

## Component Architecture

### New Component: `SeriesGroupContainer.tsx`

```typescript
type SeriesGroupContainerProps = {
    group: CanvasGroup;
    drafts: CanvasDraft[];
    viewport: Accessor<Viewport>;
    onGroupMouseDown: (groupId: string, e: MouseEvent) => void;
    onDeleteGroup: (groupId: string) => void;
    canEdit: boolean;
    isConnectionMode: boolean;
    layoutToggle: () => boolean;
    // Pass-through props for child CanvasCards
    onAnchorClick: (draftId: string, anchorType: AnchorType) => void;
    connectionSource: () => string | null;
    sourceAnchor: () => { type: AnchorType } | null;
};
```

### Rendering Logic in Canvas.tsx

1. Partition `canvasDrafts` into grouped (has `group_id`) and ungrouped
2. Render `SeriesGroupContainer` for each group with its drafts
3. Render individual `CanvasCard` for ungrouped drafts only

### Position Calculation
- Group container uses `group.positionX/Y` for world position
- Draft positions within container are relative offsets:
  - Game 1: x=20, y=80 (after header)
  - Game 2: x=400, y=80
  - Game N: x=20 + (N-1)*380, y=80

## Data Flow

### Type Updates

```typescript
// Update CanvasResposnse in actions.ts
export type CanvasResposnse = {
    name: string;
    drafts: CanvasDraft[];
    connections: Connection[];
    groups: CanvasGroup[];        // Add this
    lastViewport: Viewport;
    userPermissions: "view" | "edit" | "admin";
};
```

### State Management

```typescript
// In Canvas.tsx
const [canvasGroups, setCanvasGroups] = createStore<CanvasGroup[]>([]);
```

### Socket Events

Extend `canvasUpdate`:
```typescript
socketAccessor().on("canvasUpdate", (data) => {
    setCanvasDrafts(data.drafts);
    setConnections(data.connections);
    setCanvasGroups(data.groups ?? []);
});
```

Add `groupMoved`:
```typescript
socketAccessor().on("groupMoved", (data) => {
    setCanvasGroups(
        (g) => g.id === data.groupId,
        { positionX: data.positionX, positionY: data.positionY }
    );
});
```

## Interactions

### Group Dragging
- Mouse down on header starts drag
- Drag state tracks `activeGroupId` and offsets
- Mouse move updates `group.positionX/Y` optimistically + emits socket
- Mouse up persists via `updateCanvasGroupPosition`

### Delete Group
- Click trash icon shows confirmation dialog
- Deletes: CanvasGroup, CanvasDrafts, CanvasConnections for those drafts
- Preserves: Draft records, VersusDraft record (source data remains intact)

### Connection Mode
- Group container not clickable for connections
- Anchor points appear on individual draft cards inside
- Connections work same as ungrouped drafts

### Locked Drafts
- All drafts in series groups are locked
- Name/pick editing disabled
- "Locked" badge shown

## Backend Updates

### Connection Cleanup on Group Delete

Update `DELETE /:canvasId/group/:groupId` to also remove connections:

```javascript
// Get draft IDs in the group
const groupDrafts = await CanvasDraft.findAll({
    where: { group_id: groupId, canvas_id: canvasId },
    attributes: ['draft_id']
});
const draftIds = groupDrafts.map(d => d.draft_id);

// Delete connections involving these drafts
// (filter source_draft_ids and target_draft_ids arrays)
```

### Already Implemented
- Automatic connections created between consecutive games on series import
- Groups returned in canvas GET endpoint without redundant VersusDraft data
