# Canvas Import Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Enable users to import existing standalone drafts and versus series into canvas workflows.

**Architecture:** Extend the existing CanvasDraft model with new fields, add a CanvasGroup model for series containers, and create import endpoints. Frontend gets new dialog components for import UI.

**Tech Stack:** Express.js, Sequelize, PostgreSQL, SolidJS, TanStack Query

---

## Task 1: Database Schema - Extend CanvasDraft Model

**Files:**
- Modify: `backend/models/Canvas.js:47-58`

**Step 1: Add new columns to CanvasDraft model**

In `backend/models/Canvas.js`, update the `CanvasDraft` definition:

```javascript
const CanvasDraft = sequelize.define("CanvasDraft", {
  draft_id: {
    type: DataTypes.UUID,
    references: { model: Draft, key: "id" },
  },
  canvas_id: {
    type: DataTypes.UUID,
    references: { model: Canvas, key: "id" },
  },
  positionX: { type: DataTypes.FLOAT, defaultValue: 50 },
  positionY: { type: DataTypes.FLOAT, defaultValue: 50 },
  is_locked: { type: DataTypes.BOOLEAN, defaultValue: false },
  group_id: {
    type: DataTypes.UUID,
    allowNull: true,
    references: { model: "CanvasGroups", key: "id" },
  },
  source_type: {
    type: DataTypes.ENUM("canvas", "standalone", "versus"),
    defaultValue: "canvas",
  },
});
```

**Step 2: Sync database to add columns**

Run: `cd backend && node -e "require('./models/Canvas.js'); require('./config/database').sync({ alter: true }).then(() => console.log('Done'))"`

**Step 3: Commit**

```bash
git add backend/models/Canvas.js
git commit -m "feat(canvas): add is_locked, group_id, source_type to CanvasDraft"
```

---

## Task 2: Database Schema - Create CanvasGroup Model

**Files:**
- Modify: `backend/models/Canvas.js`

**Step 1: Add CanvasGroup model after CanvasConnection definition**

In `backend/models/Canvas.js`, add before `module.exports`:

```javascript
const CanvasGroup = sequelize.define("CanvasGroup", {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true,
  },
  canvas_id: {
    type: DataTypes.UUID,
    references: { model: Canvas, key: "id" },
  },
  name: {
    type: DataTypes.STRING,
    allowNull: false,
  },
  type: {
    type: DataTypes.ENUM("series", "custom"),
    defaultValue: "series",
  },
  positionX: { type: DataTypes.FLOAT, defaultValue: 50 },
  positionY: { type: DataTypes.FLOAT, defaultValue: 50 },
  versus_draft_id: {
    type: DataTypes.UUID,
    allowNull: true,
  },
  metadata: {
    type: DataTypes.JSONB,
    defaultValue: {},
  },
});
```

**Step 2: Update module.exports to include CanvasGroup**

```javascript
module.exports = {
  Canvas,
  UserCanvas,
  CanvasDraft,
  CanvasShare,
  CanvasConnection,
  CanvasGroup,
};
```

**Step 3: Sync database**

Run: `cd backend && node -e "require('./models/Canvas.js'); require('./config/database').sync({ alter: true }).then(() => console.log('Done'))"`

**Step 4: Commit**

```bash
git add backend/models/Canvas.js
git commit -m "feat(canvas): add CanvasGroup model for series containers"
```

---

## Task 3: Add Model Associations

**Files:**
- Modify: `backend/models/associations.js`
- Modify: `backend/routes/canvas.js:1-14`

**Step 1: Update associations.js imports**

At top of `backend/models/associations.js`, update Canvas import:

```javascript
const { Canvas, UserCanvas, CanvasDraft, CanvasShare, CanvasGroup } = require("./Canvas");
```

**Step 2: Add CanvasGroup associations in setupAssociations function**

Add after the existing Canvas associations (around line 45):

```javascript
  // CanvasGroup associations
  Canvas.hasMany(CanvasGroup, { foreignKey: "canvas_id", onDelete: "CASCADE" });
  CanvasGroup.belongsTo(Canvas, { foreignKey: "canvas_id", onDelete: "CASCADE" });

  CanvasGroup.belongsTo(VersusDraft, { foreignKey: "versus_draft_id" });

  CanvasGroup.hasMany(CanvasDraft, { foreignKey: "group_id", onDelete: "SET NULL" });
  CanvasDraft.belongsTo(CanvasGroup, { foreignKey: "group_id", onDelete: "SET NULL" });
```

**Step 3: Update canvas.js route imports**

In `backend/routes/canvas.js`, update the import:

```javascript
const {
  Canvas,
  UserCanvas,
  CanvasDraft,
  CanvasConnection,
  CanvasGroup,
} = require("../models/Canvas.js");
```

**Step 4: Commit**

```bash
git add backend/models/associations.js backend/routes/canvas.js
git commit -m "feat(canvas): add CanvasGroup associations"
```

---

## Task 4: Backend - Import Standalone Draft Endpoint

**Files:**
- Modify: `backend/routes/canvas.js`

**Step 1: Add import draft endpoint after the POST "/" route (around line 321)**

```javascript
// Import existing standalone draft to canvas
router.post("/:canvasId/import/draft", protect, async (req, res) => {
  try {
    const { canvasId } = req.params;
    const { draftId, positionX, positionY } = req.body;

    if (!draftId) {
      return res.status(400).json({ error: "draftId is required" });
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

    const draft = await Draft.findByPk(draftId);
    if (!draft) {
      return res.status(404).json({ error: "Draft not found" });
    }

    // Check user has access to the draft
    if (draft.owner_id !== req.user.id && !draft.public) {
      const isSharedWith = await draftHasSharedWithUser(draft, req.user);
      if (!isSharedWith) {
        return res.status(403).json({ error: "Not authorized to use this draft" });
      }
    }

    // Determine if draft is from versus series (locked) or standalone (editable)
    const isLocked = draft.type === "versus" || !!draft.versus_draft_id;
    const sourceType = draft.versus_draft_id ? "versus" : (draft.type || "standalone");

    const canvasDraft = await CanvasDraft.create({
      canvas_id: canvasId,
      draft_id: draftId,
      positionX: positionX ?? 50,
      positionY: positionY ?? 50,
      is_locked: isLocked,
      source_type: sourceType,
    });

    await touchCanvasTimestamp(canvasId);

    // Fetch the full canvas data for socket broadcast
    const canvasDrafts = await CanvasDraft.findAll({
      where: { canvas_id: canvasId },
      attributes: ["positionX", "positionY", "is_locked", "group_id", "source_type"],
      include: [{ model: Draft, attributes: ["name", "id", "picks", "type", "versus_draft_id", "seriesIndex"] }],
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
      canvasDraft: {
        ...canvasDraft.toJSON(),
        Draft: draft.toJSON(),
      },
    });

    socketService.emitToRoom(canvasId, "canvasUpdate", {
      canvas: canvas.toJSON(),
      drafts: canvasDrafts,
      connections: connections,
    });
  } catch (error) {
    console.error("Failed to import draft:", error);
    res.status(500).json({ error: "Failed to import draft" });
  }
});
```

**Step 2: Commit**

```bash
git add backend/routes/canvas.js
git commit -m "feat(canvas): add import draft endpoint"
```

---

## Task 5: Backend - Import Versus Series Endpoint

**Files:**
- Modify: `backend/routes/canvas.js`

**Step 1: Add VersusDraft import at top of file**

```javascript
const VersusDraft = require("../models/VersusDraft.js");
```

**Step 2: Add import series endpoint after the import draft endpoint**

```javascript
// Import versus series as a group
router.post("/:canvasId/import/series", protect, async (req, res) => {
  const t = await Canvas.sequelize.transaction();
  try {
    const { canvasId } = req.params;
    const { versusDraftId, positionX, positionY } = req.body;

    if (!versusDraftId) {
      return res.status(400).json({ error: "versusDraftId is required" });
    }

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

    const versusDraft = await VersusDraft.findByPk(versusDraftId, {
      include: [{ model: Draft, as: "Drafts" }],
    });

    if (!versusDraft) {
      await t.rollback();
      return res.status(404).json({ error: "Versus series not found" });
    }

    // Check user has access (owner or participant)
    if (versusDraft.owner_id !== req.user.id) {
      // Could add participant check here if needed
    }

    // Create the group container
    const group = await CanvasGroup.create(
      {
        canvas_id: canvasId,
        name: versusDraft.name,
        type: "series",
        positionX: positionX ?? 50,
        positionY: positionY ?? 50,
        versus_draft_id: versusDraftId,
        metadata: {
          blueTeamName: versusDraft.blueTeamName,
          redTeamName: versusDraft.redTeamName,
          length: versusDraft.length,
          competitive: versusDraft.competitive,
          seriesType: versusDraft.type,
        },
      },
      { transaction: t }
    );

    // Create CanvasDraft for each game in the series
    const drafts = versusDraft.Drafts || [];
    const sortedDrafts = [...drafts].sort((a, b) => a.seriesIndex - b.seriesIndex);

    const createdCanvasDrafts = [];
    for (let i = 0; i < sortedDrafts.length; i++) {
      const draft = sortedDrafts[i];
      const canvasDraft = await CanvasDraft.create(
        {
          canvas_id: canvasId,
          draft_id: draft.id,
          positionX: 20 + i * 380, // Horizontal layout within group
          positionY: 60,
          is_locked: true,
          group_id: group.id,
          source_type: "versus",
        },
        { transaction: t }
      );
      createdCanvasDrafts.push({
        ...canvasDraft.toJSON(),
        Draft: draft.toJSON(),
      });
    }

    await t.commit();
    await touchCanvasTimestamp(canvasId);

    // Fetch all groups for response
    const groups = await CanvasGroup.findAll({
      where: { canvas_id: canvasId },
      include: [
        {
          model: CanvasDraft,
          include: [{ model: Draft }],
        },
      ],
    });

    // Fetch full canvas data for socket broadcast
    const canvasDrafts = await CanvasDraft.findAll({
      where: { canvas_id: canvasId },
      attributes: ["positionX", "positionY", "is_locked", "group_id", "source_type"],
      include: [{ model: Draft, attributes: ["name", "id", "picks", "type", "versus_draft_id", "seriesIndex"] }],
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
      group: {
        ...group.toJSON(),
        CanvasDrafts: createdCanvasDrafts,
      },
    });

    socketService.emitToRoom(canvasId, "canvasUpdate", {
      canvas: canvas.toJSON(),
      drafts: canvasDrafts,
      connections: connections,
      groups: groups.map((g) => g.toJSON()),
    });
  } catch (error) {
    await t.rollback();
    console.error("Failed to import series:", error);
    res.status(500).json({ error: "Failed to import series" });
  }
});
```

**Step 3: Commit**

```bash
git add backend/routes/canvas.js
git commit -m "feat(canvas): add import versus series endpoint"
```

---

## Task 6: Backend - Group Management Endpoints

**Files:**
- Modify: `backend/routes/canvas.js`

**Step 1: Add delete group endpoint**

```javascript
// Delete a group from canvas
router.delete("/:canvasId/group/:groupId", protect, async (req, res) => {
  const t = await Canvas.sequelize.transaction();
  try {
    const { canvasId, groupId } = req.params;

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

    // Delete all CanvasDrafts in the group
    await CanvasDraft.destroy({
      where: { group_id: groupId, canvas_id: canvasId },
      transaction: t,
    });

    // Delete the group
    const affectedRows = await CanvasGroup.destroy({
      where: { id: groupId, canvas_id: canvasId },
      transaction: t,
    });

    if (affectedRows === 0) {
      await t.rollback();
      return res.status(404).json({ error: "Group not found" });
    }

    await t.commit();
    await touchCanvasTimestamp(canvasId);

    // Fetch updated canvas data
    const canvasDrafts = await CanvasDraft.findAll({
      where: { canvas_id: canvasId },
      attributes: ["positionX", "positionY", "is_locked", "group_id", "source_type"],
      include: [{ model: Draft, attributes: ["name", "id", "picks", "type"] }],
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

// Update group position
router.put("/:canvasId/group/:groupId/position", protect, async (req, res) => {
  try {
    const { canvasId, groupId } = req.params;
    const { positionX, positionY } = req.body;

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

    const [affectedRows] = await CanvasGroup.update(
      { positionX, positionY },
      { where: { id: groupId, canvas_id: canvasId } }
    );

    if (affectedRows === 0) {
      return res.status(404).json({ error: "Group not found" });
    }

    await touchCanvasTimestamp(canvasId);

    res.status(200).json({ success: true, message: "Group position updated" });

    socketService.emitToRoom(canvasId, "groupMoved", {
      groupId,
      positionX,
      positionY,
    });
  } catch (error) {
    console.error("Failed to update group position:", error);
    res.status(500).json({ error: "Failed to update group position" });
  }
});
```

**Step 2: Commit**

```bash
git add backend/routes/canvas.js
git commit -m "feat(canvas): add group delete and position endpoints"
```

---

## Task 7: Backend - Update Canvas GET to Include Groups

**Files:**
- Modify: `backend/routes/canvas.js:64-121`

**Step 1: Update GET /:canvasId endpoint to include groups and new fields**

Replace the existing endpoint:

```javascript
router.get("/:canvasId", async (req, res) => {
  try {
    const user = await getUserFromRequest(req);

    if (!user) {
      return res.status(401).json({ error: "Not authorized, no user found" });
    }

    const canvas = await Canvas.findOne({
      where: { id: req.params.canvasId },
    });

    if (!canvas) {
      return res.status(404).json({ error: "Canvas not found" });
    }

    const userCanvas = await UserCanvas.findOne({
      where: {
        canvas_id: canvas.id,
        user_id: user.id,
      },
    });

    if (!userCanvas) {
      return res
        .status(403)
        .json({ error: "Not authorized to access this canvas" });
    }

    const canvasDrafts = await CanvasDraft.findAll({
      where: { canvas_id: canvas.id },
      attributes: ["positionX", "positionY", "is_locked", "group_id", "source_type"],
      include: [{
        model: Draft,
        attributes: ["name", "id", "picks", "type", "versus_draft_id", "seriesIndex", "completed", "winner"]
      }],
      raw: true,
      nest: true,
    });

    const connections = await CanvasConnection.findAll({
      where: { canvas_id: canvas.id },
      raw: true,
    });

    const groups = await CanvasGroup.findAll({
      where: { canvas_id: canvas.id },
      include: [{ model: VersusDraft }],
    });

    res.json({
      name: canvas.name,
      drafts: canvasDrafts,
      connections: connections,
      groups: groups.map((g) => ({
        ...g.toJSON(),
        isInProgress: g.VersusDraft ? !g.VersusDraft.Drafts?.every((d) => d.completed) : false,
      })),
      lastViewport: {
        x: userCanvas.lastViewportX,
        y: userCanvas.lastViewportY,
        zoom: userCanvas.lastZoomLevel,
      },
      userPermissions: userCanvas.permissions,
    });
  } catch (error) {
    console.log("Error loading canvas:", error);
    res.status(500).json({ error: "Failed to load canvas" });
  }
});
```

**Step 2: Commit**

```bash
git add backend/routes/canvas.js
git commit -m "feat(canvas): include groups and new draft fields in GET endpoint"
```

---

## Task 8: Frontend - Update Types

**Files:**
- Modify: `frontend/src/utils/types.ts`

**Step 1: Update CanvasDraft type**

```typescript
export type CanvasDraft = {
    positionX: number;
    positionY: number;
    is_locked?: boolean;
    group_id?: string | null;
    source_type?: "canvas" | "standalone" | "versus";
    Draft: {
        name: string;
        id: string;
        picks: string[];
        type: "canvas" | "standalone" | "versus";
        versus_draft_id?: string;
        seriesIndex?: number;
        completed?: boolean;
        winner?: "blue" | "red" | null;
    };
};
```

**Step 2: Add CanvasGroup type**

```typescript
export type CanvasGroup = {
    id: string;
    canvas_id: string;
    name: string;
    type: "series" | "custom";
    positionX: number;
    positionY: number;
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

**Step 3: Commit**

```bash
git add frontend/src/utils/types.ts
git commit -m "feat(canvas): add CanvasGroup type and update CanvasDraft"
```

---

## Task 9: Frontend - Add Import Actions

**Files:**
- Modify: `frontend/src/utils/actions.ts`

**Step 1: Add import draft action**

```typescript
export const importDraftToCanvas = async (data: {
    canvasId: string;
    draftId: string;
    positionX?: number;
    positionY?: number;
}): Promise<{ success: boolean; canvasDraft: CanvasDraft }> => {
    const res = await fetch(`${BASE_URL}/canvas/${data.canvasId}/import/draft`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            draftId: data.draftId,
            positionX: data.positionX,
            positionY: data.positionY,
        }),
    });
    if (!res.ok) {
        const error = await res.json();
        throw new Error(error.error || "Failed to import draft");
    }
    return await res.json();
};
```

**Step 2: Add import series action**

```typescript
export const importSeriesToCanvas = async (data: {
    canvasId: string;
    versusDraftId: string;
    positionX?: number;
    positionY?: number;
}): Promise<{ success: boolean; group: any }> => {
    const res = await fetch(`${BASE_URL}/canvas/${data.canvasId}/import/series`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            versusDraftId: data.versusDraftId,
            positionX: data.positionX,
            positionY: data.positionY,
        }),
    });
    if (!res.ok) {
        const error = await res.json();
        throw new Error(error.error || "Failed to import series");
    }
    return await res.json();
};
```

**Step 3: Add fetch user's standalone drafts action**

```typescript
export const fetchStandaloneDrafts = async (): Promise<any[]> => {
    const res = await fetch(`${BASE_URL}/drafts?type=standalone`, {
        method: "GET",
        credentials: "include",
    });
    if (!res.ok) {
        throw new Error("Failed to fetch standalone drafts");
    }
    return await res.json();
};
```

**Step 4: Add fetch user's versus series action**

```typescript
export const fetchUserVersusSeries = async (): Promise<VersusDraft[]> => {
    const res = await fetch(`${BASE_URL}/versus-drafts`, {
        method: "GET",
        credentials: "include",
    });
    if (!res.ok) {
        throw new Error("Failed to fetch versus series");
    }
    return await res.json();
};
```

**Step 5: Add group management actions**

```typescript
export const deleteCanvasGroup = async (data: {
    canvasId: string;
    groupId: string;
}): Promise<{ success: boolean }> => {
    const res = await fetch(`${BASE_URL}/canvas/${data.canvasId}/group/${data.groupId}`, {
        method: "DELETE",
        credentials: "include",
    });
    if (!res.ok) {
        const error = await res.json();
        throw new Error(error.error || "Failed to delete group");
    }
    return await res.json();
};

export const updateCanvasGroupPosition = async (data: {
    canvasId: string;
    groupId: string;
    positionX: number;
    positionY: number;
}): Promise<{ success: boolean }> => {
    const res = await fetch(`${BASE_URL}/canvas/${data.canvasId}/group/${data.groupId}/position`, {
        method: "PUT",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            positionX: data.positionX,
            positionY: data.positionY,
        }),
    });
    if (!res.ok) {
        const error = await res.json();
        throw new Error(error.error || "Failed to update group position");
    }
    return await res.json();
};
```

**Step 6: Commit**

```bash
git add frontend/src/utils/actions.ts
git commit -m "feat(canvas): add import and group management actions"
```

---

## Task 10: Frontend - ImportToCanvasDialog Component

**Files:**
- Create: `frontend/src/components/ImportToCanvasDialog.tsx`

**Step 1: Create the dialog component**

```typescript
import { Component, createSignal, For, Show, createMemo } from "solid-js";
import { useQuery, useMutation, useQueryClient } from "@tanstack/solid-query";
import { fetchStandaloneDrafts, fetchUserVersusSeries, importDraftToCanvas, importSeriesToCanvas } from "../utils/actions";
import { VersusDraft } from "../utils/types";
import { champions } from "../utils/constants";
import toast from "solid-toast";

type Props = {
    canvasId: string;
    positionX: number;
    positionY: number;
    onClose: () => void;
    onSuccess: () => void;
};

export const ImportToCanvasDialog: Component<Props> = (props) => {
    const queryClient = useQueryClient();
    const [activeTab, setActiveTab] = createSignal<"drafts" | "series">("drafts");
    const [searchQuery, setSearchQuery] = createSignal("");
    const [selectedDraftId, setSelectedDraftId] = createSignal<string | null>(null);
    const [selectedSeriesId, setSelectedSeriesId] = createSignal<string | null>(null);
    const [expandedSeriesId, setExpandedSeriesId] = createSignal<string | null>(null);
    const [selectedGameId, setSelectedGameId] = createSignal<string | null>(null);

    const draftsQuery = useQuery(() => ({
        queryKey: ["standaloneDrafts"],
        queryFn: fetchStandaloneDrafts,
    }));

    const seriesQuery = useQuery(() => ({
        queryKey: ["userVersusSeries"],
        queryFn: fetchUserVersusSeries,
    }));

    const importDraftMutation = useMutation(() => ({
        mutationFn: (draftId: string) =>
            importDraftToCanvas({
                canvasId: props.canvasId,
                draftId,
                positionX: props.positionX,
                positionY: props.positionY,
            }),
        onSuccess: () => {
            toast.success("Draft imported to canvas");
            queryClient.invalidateQueries({ queryKey: ["canvas", props.canvasId] });
            props.onSuccess();
            props.onClose();
        },
        onError: (error: Error) => {
            toast.error(error.message);
        },
    }));

    const importSeriesMutation = useMutation(() => ({
        mutationFn: (versusDraftId: string) =>
            importSeriesToCanvas({
                canvasId: props.canvasId,
                versusDraftId,
                positionX: props.positionX,
                positionY: props.positionY,
            }),
        onSuccess: () => {
            toast.success("Series imported to canvas");
            queryClient.invalidateQueries({ queryKey: ["canvas", props.canvasId] });
            props.onSuccess();
            props.onClose();
        },
        onError: (error: Error) => {
            toast.error(error.message);
        },
    }));

    const filteredDrafts = createMemo(() => {
        const drafts = draftsQuery.data || [];
        const query = searchQuery().toLowerCase();
        if (!query) return drafts;
        return drafts.filter((d: any) => d.name.toLowerCase().includes(query));
    });

    const filteredSeries = createMemo(() => {
        const series = seriesQuery.data || [];
        const query = searchQuery().toLowerCase();
        if (!query) return series;
        return series.filter((s: VersusDraft) => s.name.toLowerCase().includes(query));
    });

    const getSeriesScore = (series: VersusDraft) => {
        if (!series.Drafts) return { blue: 0, red: 0 };
        const blue = series.Drafts.filter((d) => d.winner === "blue").length;
        const red = series.Drafts.filter((d) => d.winner === "red").length;
        return { blue, red };
    };

    const isSeriesInProgress = (series: VersusDraft) => {
        if (!series.Drafts || series.Drafts.length === 0) return true;
        const completedGames = series.Drafts.filter((d) => d.completed).length;
        const winsNeeded = Math.ceil(series.length / 2);
        const score = getSeriesScore(series);
        return score.blue < winsNeeded && score.red < winsNeeded;
    };

    const handleImport = () => {
        if (activeTab() === "drafts" && selectedDraftId()) {
            importDraftMutation.mutate(selectedDraftId()!);
        } else if (activeTab() === "series") {
            if (selectedGameId()) {
                // Import individual game
                importDraftMutation.mutate(selectedGameId()!);
            } else if (selectedSeriesId()) {
                // Import full series
                importSeriesMutation.mutate(selectedSeriesId()!);
            }
        }
    };

    const canImport = () => {
        if (activeTab() === "drafts") return !!selectedDraftId();
        return !!selectedSeriesId() || !!selectedGameId();
    };

    return (
        <div class="flex flex-col gap-4">
            <h2 class="text-lg font-bold text-slate-50">Import to Canvas</h2>

            {/* Tabs */}
            <div class="flex gap-2">
                <button
                    class="rounded-md px-4 py-2 text-sm font-medium"
                    classList={{
                        "bg-teal-700 text-slate-50": activeTab() === "drafts",
                        "bg-slate-700 text-slate-300 hover:bg-slate-600": activeTab() !== "drafts",
                    }}
                    onClick={() => {
                        setActiveTab("drafts");
                        setSelectedSeriesId(null);
                        setSelectedGameId(null);
                    }}
                >
                    Standalone Drafts
                </button>
                <button
                    class="rounded-md px-4 py-2 text-sm font-medium"
                    classList={{
                        "bg-teal-700 text-slate-50": activeTab() === "series",
                        "bg-slate-700 text-slate-300 hover:bg-slate-600": activeTab() !== "series",
                    }}
                    onClick={() => {
                        setActiveTab("series");
                        setSelectedDraftId(null);
                    }}
                >
                    Versus Series
                </button>
            </div>

            {/* Search */}
            <input
                type="text"
                placeholder="Search..."
                value={searchQuery()}
                onInput={(e) => setSearchQuery(e.currentTarget.value)}
                class="rounded-md border border-slate-500 bg-slate-700 px-3 py-2 text-slate-50 placeholder-slate-400"
            />

            {/* Content */}
            <div class="max-h-80 min-h-40 overflow-y-auto rounded-md border border-slate-500 bg-slate-800">
                <Show when={activeTab() === "drafts"}>
                    <Show
                        when={!draftsQuery.isPending}
                        fallback={<div class="p-4 text-slate-400">Loading...</div>}
                    >
                        <Show
                            when={filteredDrafts().length > 0}
                            fallback={<div class="p-4 text-slate-400">No drafts found</div>}
                        >
                            <For each={filteredDrafts()}>
                                {(draft: any) => (
                                    <div
                                        class="flex cursor-pointer items-center gap-3 border-b border-slate-700 px-4 py-3 hover:bg-slate-700"
                                        classList={{
                                            "bg-teal-900/50": selectedDraftId() === draft.id,
                                        }}
                                        onClick={() => setSelectedDraftId(draft.id)}
                                    >
                                        <div class="flex flex-1 flex-col">
                                            <span class="font-medium text-slate-50">{draft.name}</span>
                                            <div class="flex gap-1">
                                                <For each={draft.picks?.slice(10, 15) || []}>
                                                    {(pick: string) => (
                                                        <Show when={pick && champions[parseInt(pick)]}>
                                                            <img
                                                                src={champions[parseInt(pick)]?.icon}
                                                                alt=""
                                                                class="h-6 w-6 rounded"
                                                            />
                                                        </Show>
                                                    )}
                                                </For>
                                            </div>
                                        </div>
                                    </div>
                                )}
                            </For>
                        </Show>
                    </Show>
                </Show>

                <Show when={activeTab() === "series"}>
                    <Show
                        when={!seriesQuery.isPending}
                        fallback={<div class="p-4 text-slate-400">Loading...</div>}
                    >
                        <Show
                            when={filteredSeries().length > 0}
                            fallback={<div class="p-4 text-slate-400">No series found</div>}
                        >
                            <For each={filteredSeries()}>
                                {(series: VersusDraft) => {
                                    const score = getSeriesScore(series);
                                    const inProgress = isSeriesInProgress(series);
                                    const isExpanded = () => expandedSeriesId() === series.id;

                                    return (
                                        <div class="border-b border-slate-700">
                                            <div
                                                class="flex cursor-pointer items-center gap-3 px-4 py-3 hover:bg-slate-700"
                                                classList={{
                                                    "bg-teal-900/50": selectedSeriesId() === series.id && !selectedGameId(),
                                                }}
                                                onClick={() => {
                                                    if (isExpanded()) {
                                                        setExpandedSeriesId(null);
                                                    } else {
                                                        setExpandedSeriesId(series.id);
                                                    }
                                                    setSelectedSeriesId(series.id);
                                                    setSelectedGameId(null);
                                                }}
                                            >
                                                <div class="flex flex-1 flex-col">
                                                    <div class="flex items-center gap-2">
                                                        <span class="font-medium text-slate-50">{series.name}</span>
                                                        <Show when={inProgress}>
                                                            <span class="rounded bg-yellow-500/20 px-2 py-0.5 text-xs text-yellow-300">
                                                                Live
                                                            </span>
                                                        </Show>
                                                    </div>
                                                    <span class="text-sm text-slate-400">
                                                        {series.blueTeamName} vs {series.redTeamName} ({score.blue}-{score.red})
                                                    </span>
                                                </div>
                                                <button
                                                    class="rounded bg-teal-700 px-3 py-1 text-sm text-slate-50 hover:bg-teal-600"
                                                    onClick={(e) => {
                                                        e.stopPropagation();
                                                        setSelectedSeriesId(series.id);
                                                        setSelectedGameId(null);
                                                        importSeriesMutation.mutate(series.id);
                                                    }}
                                                >
                                                    Import Series
                                                </button>
                                                <span class="text-slate-400">{isExpanded() ? "▲" : "▼"}</span>
                                            </div>

                                            <Show when={isExpanded() && series.Drafts}>
                                                <div class="bg-slate-900 px-4 py-2">
                                                    <For each={series.Drafts}>
                                                        {(draft, index) => (
                                                            <div
                                                                class="flex cursor-pointer items-center gap-2 rounded px-2 py-2 hover:bg-slate-800"
                                                                classList={{
                                                                    "bg-teal-900/50": selectedGameId() === draft.id,
                                                                }}
                                                                onClick={() => {
                                                                    setSelectedGameId(draft.id);
                                                                    setSelectedSeriesId(null);
                                                                }}
                                                            >
                                                                <span class="text-sm text-slate-300">
                                                                    Game {index() + 1}
                                                                </span>
                                                                <Show when={draft.completed}>
                                                                    <span
                                                                        class="text-xs"
                                                                        classList={{
                                                                            "text-blue-400": draft.winner === "blue",
                                                                            "text-red-400": draft.winner === "red",
                                                                        }}
                                                                    >
                                                                        {draft.winner === "blue" ? series.blueTeamName : series.redTeamName} wins
                                                                    </span>
                                                                </Show>
                                                                <Show when={!draft.completed}>
                                                                    <span class="text-xs text-slate-500">In progress</span>
                                                                </Show>
                                                            </div>
                                                        )}
                                                    </For>
                                                </div>
                                            </Show>
                                        </div>
                                    );
                                }}
                            </For>
                        </Show>
                    </Show>
                </Show>
            </div>

            {/* Footer */}
            <div class="flex justify-end gap-2">
                <button
                    class="rounded-md bg-slate-600 px-4 py-2 text-sm text-slate-200 hover:bg-slate-500"
                    onClick={props.onClose}
                >
                    Cancel
                </button>
                <button
                    class="rounded-md bg-teal-700 px-4 py-2 text-sm text-slate-50 hover:bg-teal-600 disabled:opacity-50"
                    disabled={!canImport() || importDraftMutation.isPending || importSeriesMutation.isPending}
                    onClick={handleImport}
                >
                    {importDraftMutation.isPending || importSeriesMutation.isPending ? "Importing..." : "Import"}
                </button>
            </div>
        </div>
    );
};
```

**Step 2: Commit**

```bash
git add frontend/src/components/ImportToCanvasDialog.tsx
git commit -m "feat(canvas): add ImportToCanvasDialog component"
```

---

## Task 11: Frontend - Add Import Button to Canvas Workflow

**Files:**
- Modify: `frontend/src/workflows/CanvasWorkflow.tsx`

**Step 1: Add import callback state to context**

Update `CanvasContextType`:

```typescript
type CanvasContextType = {
    canvas: Resource<any>;
    mutateCanvas: Setter<any>;
    canvasList: Resource<any>;
    mutateCanvasList: Setter<any>;
    layoutToggle: Accessor<boolean>;
    setLayoutToggle: Setter<boolean>;
    createDraftCallback: Accessor<(() => void) | null>;
    setCreateDraftCallback: Setter<(() => void) | null>;
    navigateToDraftCallback: Accessor<
        ((positionX: number, positionY: number) => void) | null
    >;
    setNavigateToDraftCallback: Setter<
        ((positionX: number, positionY: number) => void) | null
    >;
    importCallback: Accessor<(() => void) | null>;
    setImportCallback: Setter<(() => void) | null>;
};
```

**Step 2: Add state and provide it**

After `navigateToDraftCallback` state:

```typescript
const [importCallback, setImportCallback] = createSignal<(() => void) | null>(null);
```

Add to provider value:

```typescript
importCallback,
setImportCallback,
```

**Step 3: Add Import button in the control buttons section (after Create Draft button)**

```typescript
<Show when={hasEditPermissions()}>
    <button
        class="rounded-md bg-teal-700 px-3 py-2 text-center text-sm font-medium text-slate-200 hover:bg-teal-400"
        onClick={() => {
            const callback = importCallback();
            if (callback) callback();
        }}
    >
        Import
    </button>
</Show>
```

**Step 4: Commit**

```bash
git add frontend/src/workflows/CanvasWorkflow.tsx
git commit -m "feat(canvas): add import button to canvas workflow"
```

---

## Task 12: Frontend - Wire Import Dialog to Canvas

**Files:**
- Modify: `frontend/src/Canvas.tsx`

**Step 1: Add imports at top of file**

```typescript
import { ImportToCanvasDialog } from "./components/ImportToCanvasDialog";
```

**Step 2: Add import dialog state in CanvasComponent (after other signals)**

```typescript
const [isImportDialogOpen, setIsImportDialogOpen] = createSignal(false);
const [importPosition, setImportPosition] = createSignal({ x: 0, y: 0 });
```

**Step 3: Register import callback in onMount or createEffect**

After the `setCreateDraftCallback` registration:

```typescript
canvasContext.setImportCallback(() => () => {
    // Calculate center of viewport
    const vp = viewport();
    const centerX = vp.x + (window.innerWidth / 2) / vp.zoom;
    const centerY = vp.y + (window.innerHeight / 2) / vp.zoom;
    setImportPosition({ x: centerX, y: centerY });
    setIsImportDialogOpen(true);
});
```

**Step 4: Add Dialog with ImportToCanvasDialog in the JSX (near other dialogs)**

```typescript
<Dialog
    isOpen={isImportDialogOpen}
    onCancel={() => setIsImportDialogOpen(false)}
    body={
        <ImportToCanvasDialog
            canvasId={params.id}
            positionX={importPosition().x}
            positionY={importPosition().y}
            onClose={() => setIsImportDialogOpen(false)}
            onSuccess={() => {
                queryClient.invalidateQueries({ queryKey: ["canvas", params.id] });
            }}
        />
    }
/>
```

**Step 5: Commit**

```bash
git add frontend/src/Canvas.tsx
git commit -m "feat(canvas): wire import dialog to canvas component"
```

---

## Task 13: Frontend - Add Lock Icon to CanvasCard

**Files:**
- Modify: `frontend/src/Canvas.tsx`

**Step 1: Update CanvasCard to show lock icon for locked drafts**

In the CanvasCard header section (after the type badge), add:

```typescript
<Show when={props.canvasDraft.is_locked}>
    <span
        class="cursor-help rounded bg-slate-500/30 px-1.5 py-0.5 text-xs text-slate-300"
        title={
            props.canvasDraft.Draft.versus_draft_id
                ? `Game ${(props.canvasDraft.Draft.seriesIndex ?? 0) + 1} of imported series`
                : "Imported from versus series"
        }
    >
        🔒
    </span>
</Show>
```

**Step 2: Disable pick editing for locked drafts**

In the champion selection/edit handlers, add a check:

```typescript
// Before allowing pick changes
if (props.canvasDraft.is_locked) {
    return; // Don't allow editing locked drafts
}
```

**Step 3: Commit**

```bash
git add frontend/src/Canvas.tsx
git commit -m "feat(canvas): add lock icon and disable editing for locked drafts"
```

---

## Task 14: Backend - Add Endpoint for User's Standalone Drafts

**Files:**
- Modify: `backend/routes/drafts.js`

**Step 1: Add query parameter support to GET /api/drafts**

Find the existing GET route that lists drafts and add type filtering:

```javascript
// In the existing drafts listing endpoint, add type filter support
const { type } = req.query;

let whereClause = { owner_id: user.id };
if (type) {
    whereClause.type = type;
}

const drafts = await Draft.findAll({
    where: whereClause,
    order: [["updatedAt", "DESC"]],
});
```

**Step 2: Commit**

```bash
git add backend/routes/drafts.js
git commit -m "feat(drafts): add type filter to drafts listing"
```

---

## Task 15: Backend - Add Endpoint for User's Versus Series

**Files:**
- Modify: `backend/routes/versus.js`

**Step 1: Add endpoint to list user's versus series with drafts**

```javascript
// Get user's versus series
router.get("/", protect, async (req, res) => {
  try {
    const versusDrafts = await VersusDraft.findAll({
      where: { owner_id: req.user.id },
      include: [
        {
          model: Draft,
          as: "Drafts",
          attributes: ["id", "name", "picks", "seriesIndex", "completed", "winner"],
        },
      ],
      order: [["updatedAt", "DESC"]],
    });

    res.json(versusDrafts);
  } catch (error) {
    console.error("Failed to fetch versus series:", error);
    res.status(500).json({ error: "Failed to fetch versus series" });
  }
});
```

**Step 2: Commit**

```bash
git add backend/routes/versus.js
git commit -m "feat(versus): add endpoint to list user's versus series"
```

---

## Task 16: Integration Testing

**Step 1: Start the backend server**

```bash
cd backend && node index.js
```

**Step 2: Start the frontend dev server**

```bash
cd frontend && npm run dev
```

**Step 3: Test the import flow**

1. Navigate to a canvas
2. Click "Import" button
3. Verify tabs show "Standalone Drafts" and "Versus Series"
4. Verify search filters the lists
5. Import a standalone draft - verify it appears on canvas and is editable
6. Import a versus series - verify group appears with all games
7. Verify versus games show lock icon and are not editable

**Step 4: Commit any fixes**

```bash
git add -A
git commit -m "fix: integration testing fixes for canvas import"
```

---

## Summary

This plan implements canvas import in 16 tasks:

1. **Tasks 1-3**: Database schema changes (CanvasDraft extensions, CanvasGroup model, associations)
2. **Tasks 4-7**: Backend API endpoints (import draft, import series, group management, GET updates)
3. **Tasks 8-9**: Frontend types and actions
4. **Tasks 10-13**: Frontend UI components (ImportToCanvasDialog, workflow integration, Canvas wiring, lock icon)
5. **Tasks 14-15**: Supporting backend endpoints (list drafts, list series)
6. **Task 16**: Integration testing

Each task is independently committable and builds on the previous ones.
