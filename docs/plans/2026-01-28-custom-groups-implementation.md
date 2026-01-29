# Custom Canvas Groups Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Enable users to create, manage, and organize custom groups on the canvas with drag-and-drop functionality for adding/removing drafts.

**Architecture:** Extend existing group infrastructure (used for series imports) to support user-created custom groups. Add new API endpoints for group CRUD, update frontend with drag-drop interactions, inline editing, and resizing.

**Tech Stack:** Express.js backend, Sequelize ORM, SolidJS frontend, TanStack Query, Socket.io for real-time sync.

---

## Task 1: Database Migration - Add width/height to CanvasGroup

**Files:**
- Create: `backend/migrations/XXXXXX-add-dimensions-to-canvas-groups.js`
- Modify: `backend/models/Canvas.js:116-144`

**Step 1: Create migration file**

```bash
cd backend && npx sequelize-cli migration:generate --name add-dimensions-to-canvas-groups
```

**Step 2: Write the migration**

```javascript
"use strict";

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn("CanvasGroups", "width", {
      type: Sequelize.FLOAT,
      allowNull: true,
    });
    await queryInterface.addColumn("CanvasGroups", "height", {
      type: Sequelize.FLOAT,
      allowNull: true,
    });
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.removeColumn("CanvasGroups", "width");
    await queryInterface.removeColumn("CanvasGroups", "height");
  },
};
```

**Step 3: Update CanvasGroup model**

Add to `backend/models/Canvas.js` inside CanvasGroup definition (after line 135):

```javascript
width: { type: DataTypes.FLOAT, allowNull: true },
height: { type: DataTypes.FLOAT, allowNull: true },
```

**Step 4: Run migration**

```bash
cd backend && npx sequelize-cli db:migrate
```

**Step 5: Commit**

```bash
git add backend/migrations/ backend/models/Canvas.js
git commit -m "feat(db): add width/height columns to CanvasGroup"
```

---

## Task 2: Update Frontend Types

**Files:**
- Modify: `frontend/src/utils/types.ts:19-36`

**Step 1: Add width/height to CanvasGroup type**

Update the CanvasGroup type to include:

```typescript
export type CanvasGroup = {
    id: string;
    canvas_id: string;
    name: string;
    type: "series" | "custom";
    positionX: number;
    positionY: number;
    width?: number | null;
    height?: number | null;
    versus_draft_id?: string;
    metadata: {
        blueTeamName?: string;
        redTeamName?: string;
        length?: number;
        competitive?: boolean;
        seriesType?: string;
    };
    isInProgress?: boolean;
    CanvasDrafts?: CanvasDraft[];
};
```

**Step 2: Commit**

```bash
git add frontend/src/utils/types.ts
git commit -m "feat(types): add width/height to CanvasGroup type"
```

---

## Task 3: Backend API - Create Custom Group Endpoint

**Files:**
- Modify: `backend/routes/canvas.js` (add after line 582, before delete group route)

**Step 1: Add POST endpoint for creating custom groups**

```javascript
// Create a custom group
router.post("/:canvasId/group", protect, async (req, res) => {
  try {
    const { canvasId } = req.params;
    const { name, positionX, positionY } = req.body;

    if (!name || typeof name !== "string" || name.trim().length === 0) {
      return res.status(400).json({ error: "Group name is required" });
    }

    const userCanvas = await UserCanvas.findOne({
      where: { canvas_id: canvasId, user_id: req.user.id },
    });

    if (
      !userCanvas ||
      (userCanvas.permissions !== "edit" && userCanvas.permissions !== "admin")
    ) {
      return res.status(403).json({
        error: "Forbidden: You don't have permission to edit this canvas",
      });
    }

    const group = await CanvasGroup.create({
      canvas_id: canvasId,
      name: name.trim(),
      type: "custom",
      positionX: positionX ?? 50,
      positionY: positionY ?? 50,
      width: 400,
      height: 200,
    });

    await touchCanvasTimestamp(canvasId);

    // Fetch all groups for socket broadcast
    const groups = await CanvasGroup.findAll({
      where: { canvas_id: canvasId },
    });

    const canvasDrafts = await CanvasDraft.findAll({
      where: { canvas_id: canvasId },
      attributes: ["positionX", "positionY", "is_locked", "group_id", "source_type"],
      include: [{ model: Draft, attributes: ["name", "id", "picks", "type", "versus_draft_id", "seriesIndex", "completed", "winner"] }],
      raw: true,
      nest: true,
    });

    const connections = await CanvasConnection.findAll({
      where: { canvas_id: canvasId },
      raw: true,
    });

    const canvas = await Canvas.findByPk(canvasId);

    res.status(201).json({
      success: true,
      group: group.toJSON(),
    });

    socketService.emitToRoom(canvasId, "canvasUpdate", {
      canvas: canvas.toJSON(),
      drafts: canvasDrafts,
      connections: connections,
      groups: groups.map((g) => g.toJSON()),
    });
  } catch (error) {
    console.error("Failed to create group:", error);
    res.status(500).json({ error: "Failed to create group" });
  }
});
```

**Step 2: Commit**

```bash
git add backend/routes/canvas.js
git commit -m "feat(api): add POST endpoint for creating custom groups"
```

---

## Task 4: Backend API - Update Group Endpoint (name, position, size)

**Files:**
- Modify: `backend/routes/canvas.js` (replace existing position endpoint at lines 694-735)

**Step 1: Replace the position-only endpoint with a general update endpoint**

Replace the existing `PUT /:canvasId/group/:groupId/position` with:

```javascript
// Update group (name, position, size)
router.put("/:canvasId/group/:groupId", protect, async (req, res) => {
  try {
    const { canvasId, groupId } = req.params;
    const { name, positionX, positionY, width, height } = req.body;

    const userCanvas = await UserCanvas.findOne({
      where: { canvas_id: canvasId, user_id: req.user.id },
    });

    if (
      !userCanvas ||
      (userCanvas.permissions !== "edit" && userCanvas.permissions !== "admin")
    ) {
      return res.status(403).json({
        error: "Forbidden: You don't have permission to edit this canvas",
      });
    }

    const group = await CanvasGroup.findOne({
      where: { id: groupId, canvas_id: canvasId },
    });

    if (!group) {
      return res.status(404).json({ error: "Group not found" });
    }

    // Build update object with only provided fields
    const updates = {};
    if (name !== undefined && typeof name === "string" && name.trim().length > 0) {
      updates.name = name.trim();
    }
    if (typeof positionX === "number") updates.positionX = positionX;
    if (typeof positionY === "number") updates.positionY = positionY;
    if (typeof width === "number" || width === null) updates.width = width;
    if (typeof height === "number" || height === null) updates.height = height;

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: "No valid fields to update" });
    }

    await group.update(updates);
    await touchCanvasTimestamp(canvasId);

    res.status(200).json({ success: true, group: group.toJSON() });

    // Emit appropriate socket event
    if (updates.positionX !== undefined || updates.positionY !== undefined) {
      socketService.emitToRoom(canvasId, "groupMoved", {
        groupId,
        positionX: group.positionX,
        positionY: group.positionY,
        width: group.width,
        height: group.height,
      });
    } else {
      // For name/size changes, emit full canvas update
      const groups = await CanvasGroup.findAll({
        where: { canvas_id: canvasId },
      });
      const canvasDrafts = await CanvasDraft.findAll({
        where: { canvas_id: canvasId },
        attributes: ["positionX", "positionY", "is_locked", "group_id", "source_type"],
        include: [{ model: Draft, attributes: ["name", "id", "picks", "type", "versus_draft_id", "seriesIndex", "completed", "winner"] }],
        raw: true,
        nest: true,
      });
      const connections = await CanvasConnection.findAll({
        where: { canvas_id: canvasId },
        raw: true,
      });
      const canvas = await Canvas.findByPk(canvasId);

      socketService.emitToRoom(canvasId, "canvasUpdate", {
        canvas: canvas.toJSON(),
        drafts: canvasDrafts,
        connections: connections,
        groups: groups.map((g) => g.toJSON()),
      });
    }
  } catch (error) {
    console.error("Failed to update group:", error);
    res.status(500).json({ error: "Failed to update group" });
  }
});
```

**Step 2: Commit**

```bash
git add backend/routes/canvas.js
git commit -m "feat(api): replace group position endpoint with general update endpoint"
```

---

## Task 5: Backend API - Update Delete Group with keepDrafts Option

**Files:**
- Modify: `backend/routes/canvas.js:586-692`

**Step 1: Update delete endpoint to handle keepDrafts query param**

Replace the existing delete group route with:

```javascript
// Delete a group from canvas
router.delete("/:canvasId/group/:groupId", protect, async (req, res) => {
  const t = await Canvas.sequelize.transaction();
  try {
    const { canvasId, groupId } = req.params;
    const keepDrafts = req.query.keepDrafts === "true";

    const userCanvas = await UserCanvas.findOne({
      where: { canvas_id: canvasId, user_id: req.user.id },
    });

    if (
      !userCanvas ||
      (userCanvas.permissions !== "edit" && userCanvas.permissions !== "admin")
    ) {
      await t.rollback();
      return res.status(403).json({
        error: "Forbidden: You don't have permission to edit this canvas",
      });
    }

    const group = await CanvasGroup.findOne({
      where: { id: groupId, canvas_id: canvasId },
      transaction: t,
    });

    if (!group) {
      await t.rollback();
      return res.status(404).json({ error: "Group not found" });
    }

    // Get draft IDs in the group
    const groupDrafts = await CanvasDraft.findAll({
      where: { group_id: groupId, canvas_id: canvasId },
      transaction: t,
    });
    const draftIdsToRemove = new Set(groupDrafts.map((d) => d.draft_id));

    if (keepDrafts) {
      // Convert positions to absolute and ungroup
      for (const draft of groupDrafts) {
        await draft.update(
          {
            positionX: group.positionX + draft.positionX,
            positionY: group.positionY + draft.positionY,
            group_id: null,
          },
          { transaction: t }
        );
      }
    } else {
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

      // Delete all CanvasDrafts in the group
      await CanvasDraft.destroy({
        where: { group_id: groupId, canvas_id: canvasId },
        transaction: t,
      });
    }

    // Delete the group
    await group.destroy({ transaction: t });

    await t.commit();
    await touchCanvasTimestamp(canvasId);

    // Fetch updated canvas data
    const canvasDrafts = await CanvasDraft.findAll({
      where: { canvas_id: canvasId },
      attributes: ["positionX", "positionY", "is_locked", "group_id", "source_type"],
      include: [{ model: Draft, attributes: ["name", "id", "picks", "type", "versus_draft_id", "seriesIndex", "completed", "winner"] }],
      raw: true,
      nest: true,
    });

    const connections = await CanvasConnection.findAll({
      where: { canvas_id: canvasId },
      raw: true,
    });

    const groups = await CanvasGroup.findAll({
      where: { canvas_id: canvasId },
    });

    const canvas = await Canvas.findByPk(canvasId);

    res.status(200).json({ success: true, message: "Group deleted" });

    socketService.emitToRoom(canvasId, "canvasUpdate", {
      canvas: canvas.toJSON(),
      drafts: canvasDrafts,
      connections: connections,
      groups: groups.map((g) => g.toJSON()),
    });
  } catch (error) {
    await t.rollback();
    console.error("Failed to delete group:", error);
    res.status(500).json({ error: "Failed to delete group" });
  }
});
```

**Step 2: Commit**

```bash
git add backend/routes/canvas.js
git commit -m "feat(api): add keepDrafts option to delete group endpoint"
```

---

## Task 6: Backend API - Update Draft Group Assignment

**Files:**
- Modify: `backend/routes/canvas.js:143-183`

**Step 1: Extend the draft update endpoint to handle group_id changes**

Update the existing PUT `/:canvasId/draft/:draftId` endpoint:

```javascript
router.put("/:canvasId/draft/:draftId", protect, async (req, res) => {
  try {
    const { positionX, positionY, group_id } = req.body;
    const { canvasId, draftId } = req.params;

    const userCanvas = await UserCanvas.findOne({
      where: { canvas_id: canvasId, user_id: req.user.id },
    });
    if (
      !userCanvas ||
      (userCanvas.permissions !== "edit" && userCanvas.permissions !== "admin")
    ) {
      return res.status(403).json({
        error: "Forbidden: You don't have permission to edit this canvas",
      });
    }

    // Build update object
    const updates = {};
    if (typeof positionX === "number") updates.positionX = positionX;
    if (typeof positionY === "number") updates.positionY = positionY;
    if (group_id !== undefined) updates.group_id = group_id; // null to ungroup

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: "No valid fields to update" });
    }

    const [affectedRows] = await CanvasDraft.update(updates, {
      where: {
        canvas_id: canvasId,
        draft_id: draftId,
      },
    });

    if (affectedRows > 0) {
      await touchCanvasTimestamp(canvasId);

      // If group assignment changed, emit full canvas update
      if (group_id !== undefined) {
        const canvasDrafts = await CanvasDraft.findAll({
          where: { canvas_id: canvasId },
          attributes: ["positionX", "positionY", "is_locked", "group_id", "source_type"],
          include: [{ model: Draft, attributes: ["name", "id", "picks", "type", "versus_draft_id", "seriesIndex", "completed", "winner"] }],
          raw: true,
          nest: true,
        });
        const connections = await CanvasConnection.findAll({
          where: { canvas_id: canvasId },
          raw: true,
        });
        const groups = await CanvasGroup.findAll({
          where: { canvas_id: canvasId },
        });
        const canvas = await Canvas.findByPk(canvasId);

        socketService.emitToRoom(canvasId, "canvasUpdate", {
          canvas: canvas.toJSON(),
          drafts: canvasDrafts,
          connections: connections,
          groups: groups.map((g) => g.toJSON()),
        });
      }

      res.status(200).json({ success: true, message: "Draft updated" });
    } else {
      res.status(404).json({ success: false, message: "Canvas draft not found" });
    }
  } catch (error) {
    console.error("Failed to update canvas draft:", error);
    res.status(500).json({ error: "Failed to update canvas draft" });
  }
});
```

**Step 2: Commit**

```bash
git add backend/routes/canvas.js
git commit -m "feat(api): extend draft update endpoint to handle group assignment"
```

---

## Task 7: Frontend Actions - Add Group API Functions

**Files:**
- Modify: `frontend/src/utils/actions.ts` (add after line 754)

**Step 1: Add createCanvasGroup action**

```typescript
export const createCanvasGroup = async (data: {
    canvasId: string;
    name: string;
    positionX: number;
    positionY: number;
}): Promise<{ success: boolean; group: CanvasGroup }> => {
    const res = await fetch(`${BASE_URL}/canvas/${data.canvasId}/group`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            name: data.name,
            positionX: data.positionX,
            positionY: data.positionY
        })
    });
    if (!res.ok) {
        const error = await res.json();
        throw new Error(error.error || "Failed to create group");
    }
    return await res.json();
};
```

**Step 2: Add updateCanvasGroup action**

```typescript
export const updateCanvasGroup = async (data: {
    canvasId: string;
    groupId: string;
    name?: string;
    positionX?: number;
    positionY?: number;
    width?: number | null;
    height?: number | null;
}): Promise<{ success: boolean; group: CanvasGroup }> => {
    const res = await fetch(`${BASE_URL}/canvas/${data.canvasId}/group/${data.groupId}`, {
        method: "PUT",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            name: data.name,
            positionX: data.positionX,
            positionY: data.positionY,
            width: data.width,
            height: data.height
        })
    });
    if (!res.ok) {
        const error = await res.json();
        throw new Error(error.error || "Failed to update group");
    }
    return await res.json();
};
```

**Step 3: Update deleteCanvasGroup to accept keepDrafts**

```typescript
export const deleteCanvasGroup = async (data: {
    canvasId: string;
    groupId: string;
    keepDrafts?: boolean;
}): Promise<{ success: boolean }> => {
    const params = new URLSearchParams();
    if (data.keepDrafts !== undefined) {
        params.append("keepDrafts", String(data.keepDrafts));
    }
    const url = `${BASE_URL}/canvas/${data.canvasId}/group/${data.groupId}${params.toString() ? `?${params}` : ""}`;
    const res = await fetch(url, {
        method: "DELETE",
        credentials: "include"
    });
    if (!res.ok) {
        const error = await res.json();
        throw new Error(error.error || "Failed to delete group");
    }
    return await res.json();
};
```

**Step 4: Update updateCanvasGroupPosition to use new endpoint**

```typescript
export const updateCanvasGroupPosition = async (data: {
    canvasId: string;
    groupId: string;
    positionX: number;
    positionY: number;
}): Promise<{ success: boolean }> => {
    const res = await fetch(
        `${BASE_URL}/canvas/${data.canvasId}/group/${data.groupId}`,
        {
            method: "PUT",
            credentials: "include",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                positionX: data.positionX,
                positionY: data.positionY
            })
        }
    );
    if (!res.ok) {
        const error = await res.json();
        throw new Error(error.error || "Failed to update group position");
    }
    return await res.json();
};
```

**Step 5: Add updateCanvasDraft action for group assignment**

```typescript
export const updateCanvasDraft = async (data: {
    canvasId: string;
    draftId: string;
    positionX?: number;
    positionY?: number;
    group_id?: string | null;
}): Promise<{ success: boolean }> => {
    const res = await fetch(`${BASE_URL}/canvas/${data.canvasId}/draft/${data.draftId}`, {
        method: "PUT",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            positionX: data.positionX,
            positionY: data.positionY,
            group_id: data.group_id
        })
    });
    if (!res.ok) {
        const error = await res.json();
        throw new Error(error.error || "Failed to update draft");
    }
    return await res.json();
};
```

**Step 6: Commit**

```bash
git add frontend/src/utils/actions.ts
git commit -m "feat(actions): add group CRUD and draft group assignment actions"
```

---

## Task 8: Create CustomGroupContainer Component

**Files:**
- Create: `frontend/src/components/CustomGroupContainer.tsx`

**Step 1: Create the component**

```tsx
import { Show, createSignal, createMemo, Accessor, JSX } from "solid-js";
import { CanvasDraft, CanvasGroup, Viewport } from "../utils/types";

type CustomGroupContainerProps = {
    group: CanvasGroup;
    drafts: CanvasDraft[];
    viewport: Accessor<Viewport>;
    onGroupMouseDown: (groupId: string, e: MouseEvent) => void;
    onDeleteGroup: (groupId: string) => void;
    onRenameGroup: (groupId: string, newName: string) => void;
    onResizeGroup: (groupId: string, width: number, height: number) => void;
    canEdit: boolean;
    isConnectionMode: boolean;
    // Drag and drop state
    isDragTarget: boolean;
    isExitingSource: boolean;
    // Pass-through for rendering children
    children: JSX.Element;
};

const MIN_WIDTH = 200;
const MIN_HEIGHT = 150;
const HEADER_HEIGHT = 48;
const PADDING = 16;

export const CustomGroupContainer = (props: CustomGroupContainerProps) => {
    const [isEditing, setIsEditing] = createSignal(false);
    const [editName, setEditName] = createSignal(props.group.name);
    const [isResizing, setIsResizing] = createSignal(false);

    const worldToScreen = (worldX: number, worldY: number) => {
        const vp = props.viewport();
        return {
            x: (worldX - vp.x) * vp.zoom,
            y: (worldY - vp.y) * vp.zoom
        };
    };

    const screenPos = () => worldToScreen(props.group.positionX, props.group.positionY);

    const groupWidth = () => props.group.width ?? 400;
    const groupHeight = () => props.group.height ?? 200;

    const handleNameClick = () => {
        if (!props.canEdit) return;
        setEditName(props.group.name);
        setIsEditing(true);
    };

    const handleNameBlur = () => {
        const newName = editName().trim();
        if (newName && newName !== props.group.name) {
            props.onRenameGroup(props.group.id, newName);
        }
        setIsEditing(false);
    };

    const handleNameKeyDown = (e: KeyboardEvent) => {
        if (e.key === "Enter") {
            (e.target as HTMLInputElement).blur();
        } else if (e.key === "Escape") {
            setEditName(props.group.name);
            setIsEditing(false);
        }
    };

    const handleResizeMouseDown = (e: MouseEvent) => {
        if (!props.canEdit) return;
        e.preventDefault();
        e.stopPropagation();
        setIsResizing(true);

        const startX = e.clientX;
        const startY = e.clientY;
        const startWidth = groupWidth();
        const startHeight = groupHeight();
        const zoom = props.viewport().zoom;

        const handleMouseMove = (moveEvent: MouseEvent) => {
            const deltaX = (moveEvent.clientX - startX) / zoom;
            const deltaY = (moveEvent.clientY - startY) / zoom;
            const newWidth = Math.max(MIN_WIDTH, startWidth + deltaX);
            const newHeight = Math.max(MIN_HEIGHT, startHeight + deltaY);
            props.onResizeGroup(props.group.id, newWidth, newHeight);
        };

        const handleMouseUp = () => {
            setIsResizing(false);
            window.removeEventListener("mousemove", handleMouseMove);
            window.removeEventListener("mouseup", handleMouseUp);
        };

        window.addEventListener("mousemove", handleMouseMove);
        window.addEventListener("mouseup", handleMouseUp);
    };

    const draftCount = createMemo(() => props.drafts.length);

    return (
        <div
            class="absolute z-20 rounded-lg border-2 bg-slate-700 shadow-xl"
            classList={{
                "border-slate-500": !props.isDragTarget && !props.isExitingSource,
                "border-teal-400 ring-2 ring-teal-400/50": props.isDragTarget,
                "border-slate-600 opacity-75": props.isExitingSource,
                "border-dashed": draftCount() === 0
            }}
            style={{
                left: `${screenPos().x}px`,
                top: `${screenPos().y}px`,
                width: `${groupWidth()}px`,
                height: `${groupHeight()}px`,
                transform: `scale(${props.viewport().zoom})`,
                "transform-origin": "top left"
            }}
            onMouseDown={(e) => e.stopPropagation()}
        >
            {/* Header */}
            <div
                class="flex items-center justify-between rounded-t-lg bg-slate-800 px-3"
                style={{
                    height: `${HEADER_HEIGHT}px`,
                    cursor: props.canEdit ? "move" : "default"
                }}
                onMouseDown={(e) => {
                    if (!isEditing()) {
                        props.onGroupMouseDown(props.group.id, e);
                    }
                }}
            >
                <div class="flex items-center gap-2 min-w-0 flex-1">
                    <Show
                        when={isEditing()}
                        fallback={
                            <span
                                class="font-semibold text-slate-50 cursor-text truncate"
                                onClick={handleNameClick}
                            >
                                {props.group.name}
                            </span>
                        }
                    >
                        <input
                            type="text"
                            value={editName()}
                            onInput={(e) => setEditName(e.currentTarget.value)}
                            onBlur={handleNameBlur}
                            onKeyDown={handleNameKeyDown}
                            class="bg-slate-700 text-slate-50 font-semibold px-1 rounded border border-slate-500 outline-none focus:border-teal-400 w-full"
                            autofocus
                        />
                    </Show>
                    <span class="text-xs text-slate-400 flex-shrink-0">
                        {draftCount()} draft{draftCount() !== 1 ? "s" : ""}
                    </span>
                </div>

                <Show when={props.canEdit}>
                    <button
                        onClick={(e) => {
                            e.stopPropagation();
                            props.onDeleteGroup(props.group.id);
                        }}
                        class="rounded p-1 text-slate-400 hover:bg-slate-700 hover:text-red-400"
                        title="Delete group"
                    >
                        <svg
                            class="h-4 w-4"
                            fill="none"
                            stroke="currentColor"
                            viewBox="0 0 24 24"
                        >
                            <path
                                stroke-linecap="round"
                                stroke-linejoin="round"
                                stroke-width="2"
                                d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
                            />
                        </svg>
                    </button>
                </Show>
            </div>

            {/* Content area */}
            <div
                class="relative"
                style={{
                    height: `${groupHeight() - HEADER_HEIGHT}px`,
                    padding: `${PADDING}px`
                }}
            >
                <Show
                    when={draftCount() > 0}
                    fallback={
                        <div class="flex h-full items-center justify-center text-slate-500 text-sm">
                            Drag drafts here
                        </div>
                    }
                >
                    {props.children}
                </Show>
            </div>

            {/* Resize handle */}
            <Show when={props.canEdit}>
                <div
                    class="absolute bottom-0 right-0 w-4 h-4 cursor-se-resize"
                    onMouseDown={handleResizeMouseDown}
                >
                    <svg
                        class="w-3 h-3 text-slate-500 absolute bottom-1 right-1"
                        fill="currentColor"
                        viewBox="0 0 10 10"
                    >
                        <path d="M9 1L1 9M9 5L5 9M9 9L9 9" stroke="currentColor" stroke-width="1.5" fill="none" />
                    </svg>
                </div>
            </Show>
        </div>
    );
};
```

**Step 2: Commit**

```bash
git add frontend/src/components/CustomGroupContainer.tsx
git commit -m "feat(components): add CustomGroupContainer component"
```

---

## Task 9: Create GroupNameDialog Component

**Files:**
- Create: `frontend/src/components/GroupNameDialog.tsx`

**Step 1: Create the dialog component**

```tsx
import { createSignal } from "solid-js";

type GroupNameDialogProps = {
    onConfirm: (name: string) => void;
    onCancel: () => void;
};

export const GroupNameDialog = (props: GroupNameDialogProps) => {
    const [name, setName] = createSignal("");

    const handleSubmit = (e: Event) => {
        e.preventDefault();
        const trimmedName = name().trim();
        if (trimmedName) {
            props.onConfirm(trimmedName);
        }
    };

    const handleKeyDown = (e: KeyboardEvent) => {
        if (e.key === "Escape") {
            props.onCancel();
        }
    };

    return (
        <form onSubmit={handleSubmit}>
            <h3 class="mb-4 text-lg font-bold text-slate-50">Create Group</h3>
            <div class="mb-4">
                <label class="block text-sm font-medium text-slate-300 mb-2">
                    Group Name
                </label>
                <input
                    type="text"
                    value={name()}
                    onInput={(e) => setName(e.currentTarget.value)}
                    onKeyDown={handleKeyDown}
                    class="w-full rounded-md border border-slate-500 bg-slate-700 px-3 py-2 text-slate-50 focus:border-teal-400 focus:outline-none"
                    placeholder="Enter group name"
                    autofocus
                    maxLength={100}
                />
            </div>
            <div class="flex justify-end gap-3">
                <button
                    type="button"
                    onClick={props.onCancel}
                    class="rounded-md bg-slate-600 px-4 py-2 text-slate-200 hover:bg-slate-500"
                >
                    Cancel
                </button>
                <button
                    type="submit"
                    disabled={!name().trim()}
                    class="rounded-md bg-teal-700 px-4 py-2 text-slate-50 hover:bg-teal-400 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                    Create
                </button>
            </div>
        </form>
    );
};
```

**Step 2: Commit**

```bash
git add frontend/src/components/GroupNameDialog.tsx
git commit -m "feat(components): add GroupNameDialog component"
```

---

## Task 10: Create DeleteGroupDialog Component

**Files:**
- Create: `frontend/src/components/DeleteGroupDialog.tsx`

**Step 1: Create the dialog component**

```tsx
import { CanvasGroup } from "../utils/types";

type DeleteGroupDialogProps = {
    group: CanvasGroup;
    draftCount: number;
    onKeepDrafts: () => void;
    onDeleteAll: () => void;
    onCancel: () => void;
};

export const DeleteGroupDialog = (props: DeleteGroupDialogProps) => {
    return (
        <div>
            <h3 class="mb-4 text-lg font-bold text-slate-50">
                Delete group "{props.group.name}"?
            </h3>
            <p class="mb-6 text-slate-200">
                This group contains {props.draftCount} draft{props.draftCount !== 1 ? "s" : ""}.
            </p>
            <div class="flex justify-end gap-3">
                <button
                    onClick={props.onCancel}
                    class="rounded-md bg-slate-600 px-4 py-2 text-slate-200 hover:bg-slate-500"
                >
                    Cancel
                </button>
                <button
                    onClick={props.onKeepDrafts}
                    class="rounded-md bg-teal-700 px-4 py-2 text-slate-50 hover:bg-teal-400"
                >
                    Keep Drafts
                </button>
                <button
                    onClick={props.onDeleteAll}
                    class="rounded-md bg-red-500 px-4 py-2 text-slate-50 hover:bg-red-600"
                >
                    Delete All
                </button>
            </div>
        </div>
    );
};
```

**Step 2: Commit**

```bash
git add frontend/src/components/DeleteGroupDialog.tsx
git commit -m "feat(components): add DeleteGroupDialog component"
```

---

## Task 11: Add "New Group" Button to CanvasWorkflow

**Files:**
- Modify: `frontend/src/workflows/CanvasWorkflow.tsx`

**Step 1: Add createGroupCallback to context type and provider**

Update the CanvasContextType (around line 35):

```typescript
type CanvasContextType = {
    // ... existing fields ...
    createGroupCallback: Accessor<((positionX: number, positionY: number) => void) | null>;
    setCreateGroupCallback: Setter<((positionX: number, positionY: number) => void) | null>;
};
```

**Step 2: Add signal and include in provider**

After the existing signals (around line 86):

```typescript
const [createGroupCallback, setCreateGroupCallback] = createSignal<
    ((positionX: number, positionY: number) => void) | null
>(null);
```

Add to provider value (around line 224):

```typescript
createGroupCallback,
setCreateGroupCallback,
```

**Step 3: Add "New Group" button after Import button**

After the Import button (around line 273):

```tsx
<button
    class="rounded-md bg-teal-700 px-3 py-2 text-center text-sm font-medium text-slate-200 hover:bg-teal-400"
    onClick={() => {
        const callback = createGroupCallback();
        if (callback) {
            // Default to center of viewport
            const canvas = canvas();
            callback(0, 0); // Canvas.tsx will handle positioning
        }
    }}
>
    New Group
</button>
```

**Step 4: Commit**

```bash
git add frontend/src/workflows/CanvasWorkflow.tsx
git commit -m "feat(workflow): add createGroupCallback and New Group button"
```

---

## Task 12: Integrate Custom Groups into Canvas.tsx - Part 1 (State & Mutations)

**Files:**
- Modify: `frontend/src/Canvas.tsx`

**Step 1: Add imports**

Add to imports at top:

```typescript
import { CustomGroupContainer } from "./components/CustomGroupContainer";
import { GroupNameDialog } from "./components/GroupNameDialog";
import { DeleteGroupDialog } from "./components/DeleteGroupDialog";
import {
    // ... existing imports ...
    createCanvasGroup,
    updateCanvasGroup,
    updateCanvasDraft
} from "./utils/actions";
```

**Step 2: Add new state signals**

After existing signals (around line 550):

```typescript
const [isCreateGroupDialogOpen, setIsCreateGroupDialogOpen] = createSignal(false);
const [createGroupPosition, setCreateGroupPosition] = createSignal({ x: 0, y: 0 });
const [dragOverGroupId, setDragOverGroupId] = createSignal<string | null>(null);
const [exitingGroupId, setExitingGroupId] = createSignal<string | null>(null);
```

**Step 3: Add mutations**

After existing mutations:

```typescript
const createGroupMutation = useMutation(() => ({
    mutationFn: createCanvasGroup,
    onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: ["canvas", params.id] });
        toast.success("Group created");
        setIsCreateGroupDialogOpen(false);
    },
    onError: (error: Error) => {
        toast.error(`Failed to create group: ${error.message}`);
    }
}));

const updateGroupMutation = useMutation(() => ({
    mutationFn: updateCanvasGroup,
    onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: ["canvas", params.id] });
    },
    onError: (error: Error) => {
        toast.error(`Failed to update group: ${error.message}`);
    }
}));

const updateDraftGroupMutation = useMutation(() => ({
    mutationFn: updateCanvasDraft,
    onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: ["canvas", params.id] });
    },
    onError: (error: Error) => {
        toast.error(`Failed to update draft: ${error.message}`);
    }
}));
```

**Step 4: Commit**

```bash
git add frontend/src/Canvas.tsx
git commit -m "feat(canvas): add group state signals and mutations"
```

---

## Task 13: Integrate Custom Groups into Canvas.tsx - Part 2 (Handlers)

**Files:**
- Modify: `frontend/src/Canvas.tsx`

**Step 1: Add createGroup callback setup**

In the createEffect section where other callbacks are set up:

```typescript
createEffect(() => {
    canvasContext.setCreateGroupCallback(() => (positionX: number, positionY: number) => {
        const vp = props.viewport();
        const centerX = positionX || vp.x + window.innerWidth / 2 / vp.zoom;
        const centerY = positionY || vp.y + window.innerHeight / 2 / vp.zoom;
        setCreateGroupPosition({ x: centerX, y: centerY });
        setIsCreateGroupDialogOpen(true);
    });

    onCleanup(() => {
        canvasContext.setCreateGroupCallback(null);
    });
});
```

**Step 2: Add handler functions**

```typescript
const handleCreateGroup = (name: string) => {
    const pos = createGroupPosition();
    createGroupMutation.mutate({
        canvasId: params.id,
        name,
        positionX: pos.x,
        positionY: pos.y
    });
};

const handleRenameGroup = (groupId: string, newName: string) => {
    updateGroupMutation.mutate({
        canvasId: params.id,
        groupId,
        name: newName
    });
};

const handleResizeGroup = (groupId: string, width: number, height: number) => {
    updateGroupMutation.mutate({
        canvasId: params.id,
        groupId,
        width,
        height
    });
};

const handleDeleteGroupWithChoice = (keepDrafts: boolean) => {
    const group = groupToDelete();
    if (group) {
        deleteGroupMutation.mutate({
            canvasId: params.id,
            groupId: group.id,
            keepDrafts
        });
    }
};
```

**Step 3: Update deleteGroupMutation to accept keepDrafts**

Update the existing deleteGroupMutation:

```typescript
const deleteGroupMutation = useMutation(() => ({
    mutationFn: (data: { canvasId: string; groupId: string; keepDrafts?: boolean }) =>
        deleteCanvasGroup(data),
    onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: ["canvas", params.id] });
        toast.success("Group deleted");
        setIsDeleteGroupDialogOpen(false);
        setGroupToDelete(null);
    },
    onError: (error: Error) => {
        toast.error(`Failed to delete group: ${error.message}`);
    }
}));
```

**Step 4: Commit**

```bash
git add frontend/src/Canvas.tsx
git commit -m "feat(canvas): add group handler functions"
```

---

## Task 14: Integrate Custom Groups into Canvas.tsx - Part 3 (Drag & Drop)

**Files:**
- Modify: `frontend/src/Canvas.tsx`

**Step 1: Add helper to check if point is inside group bounds**

```typescript
const isPointInGroup = (x: number, y: number, group: CanvasGroup): boolean => {
    const width = group.width ?? 400;
    const height = group.height ?? 200;
    return (
        x >= group.positionX &&
        x <= group.positionX + width &&
        y >= group.positionY &&
        y <= group.positionY + height
    );
};

const findGroupAtPosition = (x: number, y: number): CanvasGroup | null => {
    // Check custom groups (not series groups for now)
    return canvasGroups.find((g) => g.type === "custom" && isPointInGroup(x, y, g)) ?? null;
};
```

**Step 2: Update onWindowMouseUp to handle group assignment**

In the existing onWindowMouseUp handler, after handling draft movement but before clearing drag state:

```typescript
// Check if draft was dropped on a group
const dState = dragState();
if (dState.activeBoxId && !dState.activeBoxId.includes("group")) {
    const activeDraft = canvasDrafts.find((cd) => cd.Draft.id === dState.activeBoxId);
    if (activeDraft) {
        const dropGroup = findGroupAtPosition(activeDraft.positionX, activeDraft.positionY);

        // If dropped on a different group than current
        if (dropGroup && dropGroup.id !== activeDraft.group_id) {
            // Add to new group - convert position to group-relative
            const relativeX = activeDraft.positionX - dropGroup.positionX;
            const relativeY = activeDraft.positionY - dropGroup.positionY;

            updateDraftGroupMutation.mutate({
                canvasId: params.id,
                draftId: activeDraft.Draft.id,
                positionX: relativeX,
                positionY: relativeY,
                group_id: dropGroup.id
            });
        } else if (!dropGroup && activeDraft.group_id) {
            // Dropped outside all groups - ungroup
            const currentGroup = canvasGroups.find((g) => g.id === activeDraft.group_id);
            if (currentGroup && currentGroup.type === "custom") {
                // Convert to absolute position
                const absoluteX = currentGroup.positionX + activeDraft.positionX;
                const absoluteY = currentGroup.positionY + activeDraft.positionY;

                updateDraftGroupMutation.mutate({
                    canvasId: params.id,
                    draftId: activeDraft.Draft.id,
                    positionX: absoluteX,
                    positionY: absoluteY,
                    group_id: null
                });
            }
        }
    }
}

// Clear drag visual states
setDragOverGroupId(null);
setExitingGroupId(null);
```

**Step 3: Update mousemove to show visual feedback**

In the existing window mousemove handler, add group hover detection:

```typescript
// During draft drag, check for group hover
const dState = dragState();
if (dState.activeBoxId) {
    const worldPos = screenToWorld(e.clientX, e.clientY);
    const hoverGroup = findGroupAtPosition(worldPos.x, worldPos.y);

    const activeDraft = canvasDrafts.find((cd) => cd.Draft.id === dState.activeBoxId);
    const currentGroupId = activeDraft?.group_id;

    if (hoverGroup && hoverGroup.id !== currentGroupId) {
        setDragOverGroupId(hoverGroup.id);
        if (currentGroupId) {
            setExitingGroupId(currentGroupId);
        }
    } else {
        setDragOverGroupId(null);
        if (!hoverGroup && currentGroupId) {
            setExitingGroupId(currentGroupId);
        } else {
            setExitingGroupId(null);
        }
    }
}
```

**Step 4: Commit**

```bash
git add frontend/src/Canvas.tsx
git commit -m "feat(canvas): implement drag-and-drop group assignment"
```

---

## Task 15: Integrate Custom Groups into Canvas.tsx - Part 4 (Render Groups)

**Files:**
- Modify: `frontend/src/Canvas.tsx`

**Step 1: Update the groups render section**

Replace the existing For loop for canvasGroups:

```tsx
{/* Render Groups */}
<For each={canvasGroups}>
    {(group) => (
        <Show
            when={group.type === "series"}
            fallback={
                <CustomGroupContainer
                    group={group}
                    drafts={getDraftsForGroup(group.id)}
                    viewport={props.viewport}
                    onGroupMouseDown={onGroupMouseDown}
                    onDeleteGroup={handleDeleteGroup}
                    onRenameGroup={handleRenameGroup}
                    onResizeGroup={handleResizeGroup}
                    canEdit={hasEditPermissions(props.canvasData?.userPermissions)}
                    isConnectionMode={isConnectionMode()}
                    isDragTarget={dragOverGroupId() === group.id}
                    isExitingSource={exitingGroupId() === group.id}
                >
                    <For each={getDraftsForGroup(group.id)}>
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
                                isGrouped={true}
                                groupType="custom"
                            />
                        )}
                    </For>
                </CustomGroupContainer>
            }
        >
            <SeriesGroupContainer
                group={group}
                drafts={getDraftsForGroup(group.id)}
                viewport={props.viewport}
                onGroupMouseDown={onGroupMouseDown}
                onDeleteGroup={handleDeleteGroup}
                canEdit={hasEditPermissions(props.canvasData?.userPermissions)}
                isConnectionMode={isConnectionMode()}
                renderDraftCard={(cd) => (
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
                        groupType="series"
                    />
                )}
            />
        </Show>
    )}
</For>
```

**Step 2: Commit**

```bash
git add frontend/src/Canvas.tsx
git commit -m "feat(canvas): render custom groups with CustomGroupContainer"
```

---

## Task 16: Integrate Custom Groups into Canvas.tsx - Part 5 (Dialogs)

**Files:**
- Modify: `frontend/src/Canvas.tsx`

**Step 1: Add create group dialog**

After the existing dialogs:

```tsx
<Dialog
    isOpen={isCreateGroupDialogOpen}
    onCancel={() => setIsCreateGroupDialogOpen(false)}
    body={
        <GroupNameDialog
            onConfirm={handleCreateGroup}
            onCancel={() => setIsCreateGroupDialogOpen(false)}
        />
    }
/>
```

**Step 2: Update delete group dialog**

Replace the existing delete group dialog:

```tsx
<Dialog
    isOpen={isDeleteGroupDialogOpen}
    onCancel={onDeleteGroupCancel}
    body={
        <Show when={groupToDelete()}>
            {(group) => (
                <DeleteGroupDialog
                    group={group()}
                    draftCount={getDraftsForGroup(group().id).length}
                    onKeepDrafts={() => handleDeleteGroupWithChoice(true)}
                    onDeleteAll={() => handleDeleteGroupWithChoice(false)}
                    onCancel={onDeleteGroupCancel}
                />
            )}
        </Show>
    }
/>
```

**Step 3: Commit**

```bash
git add frontend/src/Canvas.tsx
git commit -m "feat(canvas): add create group and update delete group dialogs"
```

---

## Task 17: Add Right-Click Context Menu for Canvas

**Files:**
- Modify: `frontend/src/Canvas.tsx`

**Step 1: Add context menu state**

```typescript
const [contextMenuPosition, setContextMenuPosition] = createSignal<{ x: number; y: number } | null>(null);
const [contextMenuWorldPosition, setContextMenuWorldPosition] = createSignal<{ x: number; y: number }>({ x: 0, y: 0 });
```

**Step 2: Add context menu handler**

```typescript
const handleCanvasContextMenu = (e: MouseEvent) => {
    // Only show if right-clicking on empty canvas area
    const target = e.target as HTMLElement;
    if (target.closest(".canvas-card") || target.closest(".group-container")) {
        return;
    }

    e.preventDefault();

    if (!hasEditPermissions(props.canvasData?.userPermissions)) return;

    const worldPos = screenToWorld(e.clientX, e.clientY);
    setContextMenuWorldPosition(worldPos);
    setContextMenuPosition({ x: e.clientX, y: e.clientY });
};

const closeContextMenu = () => {
    setContextMenuPosition(null);
};
```

**Step 3: Add context menu component to render**

```tsx
<Show when={contextMenuPosition()}>
    <div
        class="fixed z-50 rounded-md bg-slate-700 py-1 shadow-lg border border-slate-500"
        style={{
            left: `${contextMenuPosition()!.x}px`,
            top: `${contextMenuPosition()!.y}px`
        }}
    >
        <button
            class="w-full px-4 py-2 text-left text-sm text-slate-200 hover:bg-slate-600"
            onClick={() => {
                const pos = contextMenuWorldPosition();
                setCreateGroupPosition(pos);
                setIsCreateGroupDialogOpen(true);
                closeContextMenu();
            }}
        >
            Create Group
        </button>
    </div>
</Show>
```

**Step 4: Add event listeners**

In onMount:

```typescript
window.addEventListener("click", closeContextMenu);
```

In onCleanup:

```typescript
window.removeEventListener("click", closeContextMenu);
```

**Step 5: Add onContextMenu to canvas container div**

```tsx
<div
    ref={canvasContainerRef}
    class="canvas-container ..."
    onContextMenu={handleCanvasContextMenu}
    // ... rest of props
>
```

**Step 6: Commit**

```bash
git add frontend/src/Canvas.tsx
git commit -m "feat(canvas): add right-click context menu for creating groups"
```

---

## Task 18: Final Integration Testing & Cleanup

**Step 1: Verify all imports are correct**

Review Canvas.tsx imports include all new components and actions.

**Step 2: Test the feature**

1. Right-click on empty canvas → "Create Group" appears
2. Click "New Group" in toolbar → Name dialog appears
3. Create a group → Empty group appears with dashed border
4. Drag an ungrouped draft into group → Draft joins group
5. Drag draft out of group → Draft becomes ungrouped
6. Click group name → Inline edit works
7. Drag resize handle → Group resizes
8. Delete group → Dialog shows Keep/Delete options
9. Both options work correctly

**Step 3: Run linting**

```bash
cd frontend && npm run lint
```

**Step 4: Final commit**

```bash
git add -A
git commit -m "feat(canvas): complete custom groups feature implementation"
```

---

## Summary of Files Changed

**Backend:**
- `backend/migrations/XXXXXX-add-dimensions-to-canvas-groups.js` (new)
- `backend/models/Canvas.js` (modified)
- `backend/routes/canvas.js` (modified)

**Frontend:**
- `frontend/src/utils/types.ts` (modified)
- `frontend/src/utils/actions.ts` (modified)
- `frontend/src/components/CustomGroupContainer.tsx` (new)
- `frontend/src/components/GroupNameDialog.tsx` (new)
- `frontend/src/components/DeleteGroupDialog.tsx` (new)
- `frontend/src/workflows/CanvasWorkflow.tsx` (modified)
- `frontend/src/Canvas.tsx` (modified)
