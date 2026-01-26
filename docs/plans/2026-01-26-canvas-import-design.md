# Canvas Import Design

## Overview

Enable users to import existing standalone drafts and versus series into canvas workflows. Standalone drafts remain editable; versus series games are view-only (locked). Versus series can be imported as a grouped container or as individual games.

## User Entry Points

### From Canvas
- "Import" button in canvas toolbar (next to "Create Draft")
- Opens `ImportToCanvasDialog` with tabbed interface

### From List Views
- "Add to Canvas" button on standalone draft cards
- "Add to Canvas" button on versus series cards
- Opens `CanvasPickerDialog` to select destination canvas

## Data Model

### New Table: `CanvasGroup`

```javascript
{
  id: UUID,
  canvas_id: UUID,           // FK to Canvas
  name: STRING,              // Display name (series name or user-defined)
  type: ENUM['series', 'custom'],  // Extensible for future user-created groups
  positionX: FLOAT,
  positionY: FLOAT,
  versus_draft_id: UUID,     // Nullable, only for type='series'
  metadata: JSONB,           // Flexible storage (team names, score, etc.)
  created_at: DATE,
  updated_at: DATE
}
```

### Extended `CanvasDraft` Table

Add columns:
```javascript
{
  is_locked: BOOLEAN,        // Default false; true for versus series games
  group_id: UUID,            // Nullable FK to CanvasGroup
  source_type: ENUM['canvas', 'standalone', 'versus']  // Origin tracking
}
```

When `group_id` is set, `positionX`/`positionY` become relative to the group container. The whole group moves as a unit while individual cards can be repositioned within.

### Associations

```javascript
CanvasGroup.belongsTo(Canvas);
CanvasGroup.belongsTo(VersusDraft);  // Optional, for type='series'
CanvasGroup.hasMany(CanvasDraft);
CanvasDraft.belongsTo(CanvasGroup);  // Optional
```

## Backend API

### New Endpoints

**Import Standalone Draft**
```
POST /api/canvas/:canvasId/import/draft
Body: { draftId, positionX, positionY }
Response: CanvasDraft record

- Creates CanvasDraft with is_locked=false, source_type='standalone'
- Draft remains fully editable
```

**Import Versus Series**
```
POST /api/canvas/:canvasId/import/series
Body: { versusDraftId, positionX, positionY }
Response: CanvasGroup with nested CanvasDraft records

- Creates CanvasGroup with type='series', linked to VersusDraft
- Creates CanvasDraft for each game (is_locked=true, group_id set)
- Individual drafts auto-positioned in horizontal row within group
- Stores team names and score in metadata
```

**Import Individual Versus Game**
```
POST /api/canvas/:canvasId/import/versus-game
Body: { draftId, positionX, positionY }
Response: CanvasDraft record

- Creates CanvasDraft with is_locked=true, source_type='versus', no group_id
- Shows minimal series reference icon on card
```

**Delete Group**
```
DELETE /api/canvas/:canvasId/group/:groupId

- Removes CanvasGroup and associated CanvasDraft records
- Does NOT delete underlying drafts/series (just canvas references)
```

**Move Group**
```
PUT /api/canvas/:canvasId/group/:groupId/position
Body: { positionX, positionY }

- Updates group container position
- All child drafts move with it (relative positioning preserved)
```

### Extended Endpoint

```
GET /api/canvas/:canvasId

- Include CanvasGroup records with nested drafts
- Include is_locked, group_id, source_type on draft responses
- For series groups, include versus series metadata (team names, score, status)
```

### Socket Events

Existing `canvasUpdate` event broadcasts:
- Group created/deleted/moved
- Draft imported to canvas

New `versusGameAdded` event:
- Emitted when new game starts in an in-progress series
- Canvas listeners add new CanvasDraft to existing group

## Frontend Components

### `ImportToCanvasDialog.tsx`

Triggered by "Import" button in canvas toolbar.

**Structure:**
- Header: "Import to Canvas" with close button
- Tabs: "Standalone Drafts" | "Versus Series"
- Search bar: Filters list by name in real-time
- Content area: Scrollable list based on active tab
- Footer: "Import" button (disabled until selection), "Cancel" button

**Standalone Drafts Tab:**
- Lists user's drafts where type='standalone'
- Row display: icon, name, pick preview (first few champions)
- Click to select, Import button adds to canvas

**Versus Series Tab:**
- Lists user's versus series (completed and in-progress)
- Row display: icon, name, team names, score, status badge if in-progress
- Expandable: reveals individual games
- Actions: "Import Series" (full group) or select individual games

**Data Fetching:**
- Query user's standalone drafts: `GET /api/drafts?type=standalone`
- Query user's versus series: `GET /api/versus-drafts`

### `CanvasPickerDialog.tsx`

Opened from draft/versus list views.

**Structure:**
- Header: "Add to Canvas"
- List of user's canvases (icon, name, draft count)
- "Create New Canvas" option
- Selecting triggers import API call

**For Versus Series:**
- Intermediate step: "Import full series" or "Select individual games"
- Then proceed to canvas selection

### `CanvasGroup.tsx`

Renders the series group container on canvas.

**Visual Structure:**
- Header bar: series name, team names ("Blue vs Red"), score
- Status indicator: "Live" badge for in-progress series
- Subtle background/border differentiation from canvas
- Draggable as a whole unit

**Child Cards:**
- Rendered using existing `CanvasCard` component
- Game number badge ("G1", "G2", etc.)
- Positioned relative to group origin
- Can be rearranged within group via drag

### Extended `CanvasCard.tsx`

**For Locked Drafts (versus games):**
- Lock icon in corner
- Pick slots non-interactive (no editing, no drag-drop)
- Tooltip on lock: "Game X of [Series Name]"
- View button works (opens read-only view)
- Copy button creates unlocked canvas copy

**For Individual Versus Game Import (no group):**
- Small icon indicating versus origin
- Full context on hover: "Game X of [Series Name]"

### Extended `Canvas.tsx`

- "Import" button in toolbar
- Render `CanvasGroup` components for series
- Handle group dragging (move all children together)
- Socket listeners for group updates and series sync

### List View Changes

**DraftList.tsx:**
- Add "Add to Canvas" button on standalone draft cards

**Versus List View:**
- Add "Add to Canvas" button on series cards

## Positioning Logic

**Import from Canvas (via dialog):**
- Place at click position or center of viewport

**Import from List View:**
1. Check user's `lastViewport` for target canvas (stored in UserCanvas)
2. If exists, calculate center of that viewport
3. Otherwise, find bounding box of existing content and place nearby
4. Emit socket event for real-time update

## Live Updates for In-Progress Series

**Game Completion:**
1. Backend emits existing `versusDraftUpdate` event
2. Canvas checks if any `CanvasGroup` references that `versus_draft_id`
3. If match found, refresh group data and re-render

**New Game Starts:**
1. Backend detects new draft created with `versus_draft_id`
2. Emits `versusGameAdded` event with series ID and draft data
3. Canvas adds new `CanvasDraft` to existing group
4. New card auto-positioned after existing games

**Visual Indicators:**
- In-progress series: "Live" badge in group header
- Active game: subtle highlight (border glow)
- Completed games: winner indicator (blue/red accent)
- Series completion: "Live" badge transitions to final score

## Behavior Rules

| Scenario | Behavior |
|----------|----------|
| Same draft on multiple canvases | Allowed (reference model) |
| Duplicate on same canvas | Allowed |
| Edit standalone import | Allowed (is_locked=false) |
| Edit versus game | Not allowed (is_locked=true) |
| Delete group from canvas | Removes references only, not source data |
| In-progress series imported | Updates live as games complete |

## Files to Create

- `backend/models/CanvasGroup.js` - New model
- `frontend/src/components/ImportToCanvasDialog.tsx`
- `frontend/src/components/CanvasPickerDialog.tsx`
- `frontend/src/components/CanvasGroup.tsx`

## Files to Modify

### Backend
- `backend/models/Canvas.js` - Add columns to CanvasDraft
- `backend/models/associations.js` - Add CanvasGroup associations
- `backend/routes/canvas.js` - New import/group endpoints
- `backend/socketHandlers/` - Group update events

### Frontend
- `frontend/src/Canvas.tsx` - Import button, group rendering, group dragging
- `frontend/src/components/CanvasCard.tsx` - Lock icon, read-only mode
- `frontend/src/workflows/CanvasWorkflow.tsx` - Import button in toolbar
- Draft/Versus list views - "Add to Canvas" buttons

### Database Migration
- Add `is_locked`, `group_id`, `source_type` to `CanvasDrafts`
- Create `CanvasGroups` table

## Future Extensibility

The `CanvasGroup` table with `type` field supports future user-created groups:
- `type='custom'` for manual grouping
- No `versus_draft_id` for custom groups
- Same positioning and drag behavior
- User-defined name and metadata
