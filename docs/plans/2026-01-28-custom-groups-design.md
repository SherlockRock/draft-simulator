# Custom Canvas Groups Design

## Overview

Enable users to create and manage custom groups on the canvas, allowing organization of drafts beyond the existing series import functionality.

## Creation

**Two entry points:**
1. Right-click on empty canvas → "Create Group" context menu option
2. "New Group" button in canvas toolbar

**Flow:**
1. User triggers creation via either entry point
2. Name dialog appears (text input, auto-focused)
3. User enters name, presses Enter or clicks "Create"
4. Group created at right-click position (context menu) or default viewport position (toolbar)
5. Group appears as empty container ready for drafts

## Data Model

**CanvasGroup additions:**
```sql
ALTER TABLE CanvasGroups ADD COLUMN width FLOAT NULL;
ALTER TABLE CanvasGroups ADD COLUMN height FLOAT NULL;
```

- `width`/`height`: NULL means auto-sized to content, non-null means manually resized
- Existing `type` field already supports `"custom"` value

## API Endpoints

**Create custom group:**
```
POST /canvas/:canvasId/group
Body: { name: string, positionX: number, positionY: number }
Returns: CanvasGroup with type "custom"
```

**Update group (name, position, size):**
```
PUT /canvas/:canvasId/group/:groupId
Body: { name?: string, positionX?: number, positionY?: number, width?: number, height?: number }
```

**Delete group:**
```
DELETE /canvas/:canvasId/group/:groupId?keepDrafts=true|false
```
- `keepDrafts=true`: Drafts become ungrouped, positions converted to absolute
- `keepDrafts=false`: Drafts deleted along with group

## Drag and Drop

**Adding drafts to a group:**
- Drag ungrouped draft over group container
- Visual: group border highlights (teal glow)
- On drop: draft's `group_id` set, position converted to group-relative coordinates
- Group auto-expands if needed (unless manually sized larger)

**Removing drafts from a group:**
- Drag grouped draft outside group container bounds
- Visual: group border dims (exit indicator)
- On drop: draft's `group_id` set to NULL, position converted to canvas-absolute

**Moving drafts between groups:**
- Drag grouped draft over different group
- Visual: source group dims (exit) + target group highlights (entrance)
- On drop: `group_id` updated, position recalculated relative to new group

**Coordinate handling:**
- Grouped drafts store positions relative to group's top-left corner
- On add: `draftPos = absolutePos - groupPos`
- On remove: `absolutePos = groupPos + draftPos`

## Resizing

- Resize handle in bottom-right corner of group container
- Drag to expand/contract group bounds
- Minimum size: must contain all grouped drafts (can't shrink below draft bounding box)
- Can expand beyond drafts to reserve space for future drafts
- Persisted via `PUT /canvas/:canvasId/group/:groupId` with `width`/`height`

## Inline Renaming

- Group name in header is clickable
- Click transforms name into text input (pre-filled, text selected)
- Enter or blur: saves new name
- Escape: cancels, reverts to original
- Empty name rejected (reverts to original)

## Group Deletion

**Applies to both custom and series groups.**

Dialog:
```
Delete group "{groupName}"?

This group contains {n} draft(s).

[Keep Drafts]  [Delete All]  [Cancel]
```

- "Keep Drafts": Converts draft positions to absolute, sets `group_id` to NULL, deletes group
- "Delete All": Deletes all drafts in group, then deletes group

## Visual Design

**Custom group header:**
- Group name (click-to-edit)
- Draft count badge (e.g., "3 drafts")
- Delete button

**Empty group state:**
- Dashed border instead of solid
- Placeholder text: "Drag drafts here" (muted)
- Default minimum size: 400x200

**Container styling:**
- Background: `slate-700`
- Border: `slate-500`
- Consistent with series groups

## Socket Events

- `canvasUpdate`: Broadcast on group create/delete/update
- `groupMove`: Extended for position and size changes

## Files to Modify

**Backend:**
- `backend/models/Canvas.js` - Add width/height fields
- `backend/routes/canvas.js` - New/modified endpoints
- Migration file for schema changes

**Frontend:**
- `frontend/src/components/CustomGroupContainer.tsx` - New component
- `frontend/src/Canvas.tsx` - Context menu, toolbar button, drag-drop logic
- `frontend/src/components/SeriesGroupContainer.tsx` - Add resize handle, inline rename
- New dialog components for name input and delete confirmation
- `frontend/src/utils/actions.ts` - API action functions
- `frontend/src/utils/types.ts` - Update CanvasGroup type
