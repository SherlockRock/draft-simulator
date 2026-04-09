const express = require("express");
const router = express.Router();
const championData = require("../../frontend/src/data/champions.json");
const User = require("../models/User");
const { protect } = require("../middleware/auth");
const { Canvas, UserCanvas, CanvasDraft, CanvasGroup, CanvasConnection } = require("../models/Canvas");
const Draft = require("../models/Draft");
const VersusDraft = require("../models/VersusDraft");
const VersusParticipant = require("../models/VersusParticipant");
const UserToken = require("../models/UserToken");
const sequelize = require("../config/database");
const socketService = require("../middleware/socketService");
const {
  generateUniqueCanvasDraftName,
  generateUniqueCanvasGroupName,
} = require("../helpers");

const VALID_CHAMPION_IDS = new Set(championData.champions.map((champion) => champion.id));
const CHAMPION_ID_TO_INDEX = new Map(
  championData.champions.map((champion, index) => [champion.id, String(index)]),
);
let importUserDataRequestSchemaPromise;
let canvasJsonImportRequestSchemaPromise;

async function getImportUserDataRequestSchema() {
  importUserDataRequestSchemaPromise ??= import("@draft-sim/shared-types")
    .then((module) => module.ImportUserDataRequestSchema);
  return importUserDataRequestSchemaPromise;
}

async function getCanvasJsonImportRequestSchema() {
  canvasJsonImportRequestSchemaPromise ??= import("@draft-sim/shared-types")
    .then((module) => module.CanvasJsonImportRequestSchema);
  return canvasJsonImportRequestSchemaPromise;
}

function validateDraftPicks(picks, draftLabel) {
  for (const championId of picks) {
    if (championId === "") {
      continue;
    }

    if (!VALID_CHAMPION_IDS.has(championId)) {
      return {
        success: false,
        error: `Invalid champion ID "${championId}" in ${draftLabel}`,
      };
    }
  }

  return { success: true };
}

function validateChampionIds(ids, label) {
  for (const championId of ids || []) {
    if (championId === "") {
      continue;
    }

    if (!VALID_CHAMPION_IDS.has(championId)) {
      return {
        success: false,
        error: `Invalid champion ID "${championId}" in ${label}`,
      };
    }
  }

  return { success: true };
}

function normalizeChampionReference(championRef) {
  if (championRef === "") return "";
  return CHAMPION_ID_TO_INDEX.get(championRef) ?? null;
}

function normalizeChampionRefs(championRefs, label) {
  const normalized = [];

  for (const championRef of championRefs) {
    const value = normalizeChampionReference(championRef);
    if (value === null) {
      throw new Error(`Invalid champion ID "${championRef}" in ${label}`);
    }
    normalized.push(value);
  }

  return normalized;
}

async function validateImportPayload(body) {
  const ImportUserDataRequestSchema = await getImportUserDataRequestSchema();
  const parsed = ImportUserDataRequestSchema.safeParse(body);

  if (!parsed.success) {
    return {
      success: false,
      error: parsed.error.issues[0]?.message || "Invalid import payload",
    };
  }

  for (const canvas of parsed.data.exportData.canvases) {
    for (const draft of canvas.drafts) {
      const picksValidation = validateDraftPicks(
        draft.picks,
        `canvas draft "${draft.name}"`,
      );

      if (!picksValidation.success) {
        return picksValidation;
      }
    }
  }

  for (const series of parsed.data.exportData.versusSeries) {
    for (const draft of series.drafts) {
      const picksValidation = validateDraftPicks(
        draft.picks,
        `versus draft "${draft.name}"`,
      );

      if (!picksValidation.success) {
        return picksValidation;
      }
    }
  }

  return { success: true, data: parsed.data };
}

async function validateCanvasJsonImportPayload(body) {
  const CanvasJsonImportRequestSchema = await getCanvasJsonImportRequestSchema();
  const parsed = CanvasJsonImportRequestSchema.safeParse(body);

  if (!parsed.success) {
    return {
      success: false,
      error: parsed.error.issues[0]?.message || "Invalid import payload",
    };
  }

  for (const draft of parsed.data.data.drafts) {
    const picksValidation = validateDraftPicks(
      draft.picks,
      `draft "${draft.name}"`,
    );

    if (!picksValidation.success) {
      return picksValidation;
    }
  }

  for (const series of parsed.data.data.versusSeries) {
    const disabledValidation = validateChampionIds(
      series.disabledChampions || [],
      `disabledChampions for series "${series.name || `${series.blueTeamName || "Team 1"} vs ${series.redTeamName || "Team 2"}`}"`,
    );

    if (!disabledValidation.success) {
      return disabledValidation;
    }

    const seenGameNumbers = new Set();
    for (let i = 0; i < series.drafts.length; i += 1) {
      const draft = series.drafts[i];
      const picksValidation = validateDraftPicks(
        draft.picks,
        `versus draft "${draft.name || `Game ${i + 1}`}"`,
      );

      if (!picksValidation.success) {
        return picksValidation;
      }

      const gameNumber = draft.gameNumber ?? i + 1;
      if (gameNumber > series.seriesLength) {
        return {
          success: false,
          error: `Game ${gameNumber} exceeds seriesLength ${series.seriesLength} in "${series.name || `${series.blueTeamName || "Team 1"} vs ${series.redTeamName || "Team 2"}`}"`,
        };
      }

      if (seenGameNumbers.has(gameNumber)) {
        return {
          success: false,
          error: `Duplicate gameNumber ${gameNumber} in "${series.name || `${series.blueTeamName || "Team 1"} vs ${series.redTeamName || "Team 2"}`}"`,
        };
      }
      seenGameNumbers.add(gameNumber);
    }
  }

  return { success: true, data: parsed.data };
}

async function findCanvasDraftByName(canvasId, name, transaction) {
  return CanvasDraft.findOne({
    where: { canvas_id: canvasId },
    include: [
      {
        model: Draft,
        where: { name, type: "canvas" },
        required: true,
      },
    ],
    transaction,
  });
}

async function findOwnedCanvasByName(userId, name, transaction) {
  const userCanvas = await UserCanvas.findOne({
    where: { user_id: userId, permissions: "admin" },
    include: [
      {
        model: Canvas,
        where: { name },
        required: true,
      },
    ],
    transaction,
  });

  return userCanvas?.Canvas ?? null;
}

async function createOwnedCanvas(userId, canvasData, transaction) {
  const canvas = await Canvas.create(
    {
      name: canvasData.name || "Imported Canvas",
      description: canvasData.description || "",
      icon: canvasData.icon || "",
    },
    { transaction },
  );

  await UserCanvas.create(
    {
      user_id: userId,
      canvas_id: canvas.id,
      permissions: "admin",
    },
    { transaction },
  );

  return canvas;
}

async function clearCanvasContents(canvasId, transaction) {
  const canvasDrafts = await CanvasDraft.findAll({
    where: { canvas_id: canvasId },
    attributes: ["draft_id"],
    transaction,
  });
  const draftIds = canvasDrafts.map((canvasDraft) => canvasDraft.draft_id);

  await CanvasConnection.destroy({
    where: { canvas_id: canvasId },
    transaction,
  });
  await CanvasDraft.destroy({
    where: { canvas_id: canvasId },
    transaction,
  });
  if (draftIds.length > 0) {
    await Draft.destroy({
      where: { id: draftIds },
      transaction,
    });
  }
  await CanvasGroup.destroy({
    where: { canvas_id: canvasId },
    transaction,
  });
}

async function touchCanvasTimestamp(canvasId, transaction) {
  const canvas = await Canvas.findByPk(canvasId, { transaction });
  if (!canvas) return null;
  canvas.changed("updatedAt", true);
  await canvas.save({ transaction, silent: false });
  return canvas;
}

async function findOwnedVersusSeriesByName(userId, name, transaction) {
  return VersusDraft.findOne({
    where: { owner_id: userId, name },
    include: [{ model: Draft, as: "Drafts" }],
    transaction,
  });
}

function getImportedSeriesName(series) {
  return (
    series.name ||
    `${series.blueTeamName || "Team 1"} vs ${series.redTeamName || "Team 2"}`
  );
}

async function broadcastCanvasUpdate(canvasId) {
  const canvas = await Canvas.findByPk(canvasId);
  if (!canvas) return;

  const canvasDrafts = await CanvasDraft.findAll({
    where: { canvas_id: canvasId },
    attributes: [
      "positionX",
      "positionY",
      "is_locked",
      "group_id",
      "source_type",
    ],
    include: [
      {
        model: Draft,
        attributes: [
          "name",
          "id",
          "picks",
          "type",
          "versus_draft_id",
          "seriesIndex",
          "completed",
          "winner",
          "blueSideTeam",
          "firstPick",
        ],
      },
    ],
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

  socketService.emitToRoom(canvasId, "canvasUpdate", {
    canvas: canvas.toJSON(),
    drafts: canvasDrafts,
    connections,
    groups: groups.map((group) => group.toJSON()),
  });
}

router.get("/", async (req, res) => {
  const token = req.cookies.paseto;
  if (!token) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  try {
    const user = await User.findByPk(req.params.id);
    res.json(user);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server Error" });
  }
});

router.patch("/me", protect, async (req, res) => {
  try {
    const { displayName } = req.body;

    if (displayName !== null) {
      if (typeof displayName !== "string") {
        return res.status(400).json({ error: "Display name must be a string or null" });
      }

      const trimmed = displayName.trim();

      if (trimmed.length < 3 || trimmed.length > 16) {
        return res.status(400).json({ error: "Display name must be 3-16 characters" });
      }

      if (!/^[a-zA-Z0-9 _]{3,16}$/.test(trimmed)) {
        return res.status(400).json({ error: "Display name can only contain letters, numbers, spaces, and underscores" });
      }

      req.user.display_name = trimmed;
    } else {
      req.user.display_name = null;
    }

    await req.user.save();

    res.json({
      user: {
        id: req.user.id,
        name: req.user.name,
        email: req.user.email,
        picture: req.user.picture,
        display_name: req.user.display_name,
        keyboard_controls: req.user.keyboard_controls,
      },
    });
  } catch (error) {
    console.error("Failed to update display name:", error);
    res.status(500).json({ error: "Failed to update display name" });
  }
});

router.get("/me/export", protect, async (req, res) => {
  try {
    const userId = req.user.id;

    // Get user basic info
    const user = {
      name: req.user.name,
      email: req.user.email,
      picture: req.user.picture,
      display_name: req.user.display_name,
      createdAt: req.user.createdAt,
    };

    // Get canvases where user has admin permissions (owner)
    const userCanvases = await UserCanvas.findAll({
      where: { user_id: userId, permissions: "admin" },
      include: [{
        model: Canvas,
        include: [
          { model: CanvasDraft, include: [{ model: Draft }] },
          { model: CanvasGroup },
        ],
      }],
    });

    const canvases = userCanvases.map((uc) => ({
      id: uc.Canvas.id,
      name: uc.Canvas.name,
      description: uc.Canvas.description,
      icon: uc.Canvas.icon,
      createdAt: uc.Canvas.createdAt,
      drafts: uc.Canvas.CanvasDrafts.map((cd) => ({
        id: cd.Draft.id,
        name: cd.Draft.name,
        picks: cd.Draft.picks,
        positionX: cd.positionX,
        positionY: cd.positionY,
      })),
      groups: uc.Canvas.CanvasGroups.map((g) => ({
        id: g.id,
        name: g.name,
        type: g.type,
        positionX: g.positionX,
        positionY: g.positionY,
      })),
    }));

    // Get versus series owned by user
    const versusSeries = await VersusDraft.findAll({
      where: { owner_id: userId },
      include: [
        { model: Draft, as: "Drafts" },
        { model: VersusParticipant },
      ],
    });

    const series = versusSeries.map((vs) => ({
      id: vs.id,
      name: vs.name,
      seriesLength: vs.length,
      draftType: vs.type,
      blueTeamName: vs.blueTeamName,
      redTeamName: vs.redTeamName,
      status: vs.status,
      createdAt: vs.createdAt,
      drafts: vs.Drafts.map((d) => ({
        id: d.id,
        name: d.name,
        picks: d.picks,
        gameNumber: (d.seriesIndex ?? 0) + 1,
        winner: d.winner,
      })),
    }));

    res.json({
      exportedAt: new Date().toISOString(),
      user,
      canvases,
      versusSeries: series,
    });
  } catch (error) {
    console.error("Export error:", error);
    res.status(500).json({ error: "Failed to export data" });
  }
});

router.post("/me/import", protect, async (req, res) => {
  const transaction = await sequelize.transaction();

  try {
    const parsed = await validateImportPayload(req.body);

    if (!parsed.success) {
      await transaction.rollback();
      return res.status(400).json({
        error: "Invalid import payload",
        details: parsed.error,
      });
    }

    const {
      exportData,
      options: {
        canvasIds,
        versusSeriesIds,
        dedupeStrategy,
        canvasImportMode,
        targetCanvasId,
      },
    } = parsed.data;

    if (canvasIds.length === 0 && versusSeriesIds.length === 0) {
      await transaction.rollback();
      return res.status(400).json({ error: "Select at least one canvas or series to import" });
    }

    if (canvasImportMode === "target_canvas" && canvasIds.length > 0 && !targetCanvasId) {
      await transaction.rollback();
      return res.status(400).json({ error: "targetCanvasId is required for target canvas imports" });
    }

    let targetCanvas = null;

    if (targetCanvasId) {
      const userCanvas = await UserCanvas.findOne({
        where: { canvas_id: targetCanvasId, user_id: req.user.id },
        transaction,
      });

      if (
        !userCanvas ||
        (userCanvas.permissions !== "edit" && userCanvas.permissions !== "admin")
      ) {
        await transaction.rollback();
        return res.status(403).json({
          error: "Forbidden: You don't have permission to import into this canvas",
        });
      }

      targetCanvas = await Canvas.findByPk(targetCanvasId, { transaction });
    }

    const selectedCanvases = exportData.canvases.filter((canvas) =>
      canvasIds.includes(canvas.id),
    );
    const selectedSeries = exportData.versusSeries.filter((series) =>
      versusSeriesIds.includes(series.id),
    );

    const summary = {
      canvasesCreated: 0,
      canvasesUpdated: 0,
      draftsCreated: 0,
      draftsUpdated: 0,
      draftsSkipped: 0,
      seriesCreated: 0,
      seriesUpdated: 0,
      seriesSkipped: 0,
    };
    const warnings = [];

    for (const importedCanvas of selectedCanvases) {
      if ((importedCanvas.groups?.length || 0) > 0) {
        warnings.push(
          `Canvas "${importedCanvas.name}" contains groups in the export. Group structure is not restored by this import yet.`,
        );
      }

      let destinationCanvas = targetCanvas;

      if (canvasImportMode === "new_canvases") {
        const existingCanvas = await findOwnedCanvasByName(
          req.user.id,
          importedCanvas.name,
          transaction,
        );

        if (!existingCanvas) {
          destinationCanvas = await createOwnedCanvas(req.user.id, importedCanvas, transaction);
          summary.canvasesCreated += 1;
        } else if (dedupeStrategy === "skip") {
          summary.draftsSkipped += importedCanvas.drafts.length;
          continue;
        } else if (dedupeStrategy === "rename") {
          let candidateName = importedCanvas.name || "Imported Canvas";
          let counter = 1;

          while (await findOwnedCanvasByName(req.user.id, candidateName, transaction)) {
            candidateName = `${importedCanvas.name} ${counter}`;
            counter += 1;
          }

          destinationCanvas = await createOwnedCanvas(
            req.user.id,
            { ...importedCanvas, name: candidateName },
            transaction,
          );
          summary.canvasesCreated += 1;
        } else {
          destinationCanvas = existingCanvas;
          await destinationCanvas.update(
            {
              description: importedCanvas.description || "",
              icon: importedCanvas.icon || "",
            },
            { transaction },
          );
          await clearCanvasContents(destinationCanvas.id, transaction);
          summary.canvasesUpdated += 1;
        }
      }

      for (const importedDraft of importedCanvas.drafts) {
        const existingCanvasDraft = await findCanvasDraftByName(
          destinationCanvas.id,
          importedDraft.name,
          transaction,
        );

        if (!existingCanvasDraft) {
          const newDraft = await Draft.create(
            {
              owner_id: req.user.id,
              name:
                canvasImportMode === "target_canvas"
                  ? await generateUniqueCanvasDraftName(
                      importedDraft.name || "Imported Draft",
                      destinationCanvas.id,
                      null,
                      transaction,
                    )
                  : importedDraft.name || "Imported Draft",
              public: false,
              picks: importedDraft.picks,
              type: "canvas",
            },
            { transaction },
          );

          await CanvasDraft.create(
            {
              canvas_id: destinationCanvas.id,
              draft_id: newDraft.id,
              positionX: importedDraft.positionX,
              positionY: importedDraft.positionY,
              source_type: "canvas",
            },
            { transaction },
          );

          summary.draftsCreated += 1;
          continue;
        }

        if (dedupeStrategy === "skip") {
          summary.draftsSkipped += 1;
          continue;
        }

        if (dedupeStrategy === "rename") {
          const renamedDraft = await Draft.create(
            {
              owner_id: req.user.id,
              name: await generateUniqueCanvasDraftName(
                importedDraft.name || "Imported Draft",
                destinationCanvas.id,
                null,
                transaction,
              ),
              public: false,
              picks: importedDraft.picks,
              type: "canvas",
            },
            { transaction },
          );

          await CanvasDraft.create(
            {
              canvas_id: destinationCanvas.id,
              draft_id: renamedDraft.id,
              positionX: importedDraft.positionX,
              positionY: importedDraft.positionY,
              source_type: "canvas",
            },
            { transaction },
          );

          summary.draftsCreated += 1;
          continue;
        }

        await existingCanvasDraft.Draft.update(
          {
            picks: importedDraft.picks,
          },
          { transaction },
        );

        await existingCanvasDraft.update(
          {
            positionX: importedDraft.positionX,
            positionY: importedDraft.positionY,
          },
          { transaction },
        );

        summary.draftsUpdated += 1;
      }

      destinationCanvas.changed("updatedAt", true);
      await destinationCanvas.save({ transaction, silent: false });
    }

    for (const importedSeries of selectedSeries) {
      const existingSeries = await VersusDraft.findOne({
        where: {
          owner_id: req.user.id,
          name:
            importedSeries.name ||
            `${importedSeries.blueTeamName} vs ${importedSeries.redTeamName}`,
        },
        include: [{ model: Draft, as: "Drafts" }],
        transaction,
      });

      if (existingSeries && dedupeStrategy === "skip") {
        summary.seriesSkipped += 1;
        continue;
      }

      let series = existingSeries;

      if (!series || dedupeStrategy === "rename") {
        let seriesName =
          importedSeries.name ||
          `${importedSeries.blueTeamName} vs ${importedSeries.redTeamName}`;

        if (dedupeStrategy === "rename") {
          let counter = 1;
          while (
            await VersusDraft.findOne({
              where: { owner_id: req.user.id, name: seriesName },
              transaction,
            })
          ) {
            seriesName = `${importedSeries.name || `${importedSeries.blueTeamName} vs ${importedSeries.redTeamName}`} ${counter}`;
            counter += 1;
          }
        }

        series = await VersusDraft.create(
          {
            owner_id: req.user.id,
            name: seriesName,
            length: importedSeries.seriesLength,
            type: importedSeries.draftType || "standard",
            blueTeamName: importedSeries.blueTeamName || "Team 1",
            redTeamName: importedSeries.redTeamName || "Team 2",
          },
          { transaction },
        );
        summary.seriesCreated += 1;
      } else {
        await series.update(
          {
            length: importedSeries.seriesLength,
            type: importedSeries.draftType || "standard",
            blueTeamName: importedSeries.blueTeamName || "Team 1",
            redTeamName: importedSeries.redTeamName || "Team 2",
          },
          { transaction },
        );
        summary.seriesUpdated += 1;
      }

      const existingDraftsByIndex = new Map(
        (series.Drafts || []).map((draft) => [draft.seriesIndex ?? 0, draft]),
      );

      for (let i = 0; i < importedSeries.drafts.length; i += 1) {
        const importedDraft = importedSeries.drafts[i];
        const seriesIndex =
          importedDraft.gameNumber != null ? importedDraft.gameNumber - 1 : i;
        const existingDraft = existingDraftsByIndex.get(seriesIndex);

        if (!existingDraft) {
          await Draft.create(
            {
              owner_id: req.user.id,
              name: importedDraft.name || `Game ${seriesIndex + 1}`,
              public: false,
              picks: importedDraft.picks,
              type: "versus",
              versus_draft_id: series.id,
              seriesIndex,
              winner: importedDraft.winner ?? null,
            },
            { transaction },
          );
          continue;
        }

        await existingDraft.update(
          {
            name: importedDraft.name || existingDraft.name,
            picks: importedDraft.picks,
            winner: importedDraft.winner ?? null,
          },
          { transaction },
        );
      }

      // Delete existing drafts not present in the import to avoid
      // stale games when importing a shorter series over a longer one
      const importedIndices = new Set(
        importedSeries.drafts.map((d, i) =>
          d.gameNumber != null ? d.gameNumber - 1 : i,
        ),
      );
      for (const [idx, draft] of existingDraftsByIndex) {
        if (!importedIndices.has(idx)) {
          await draft.destroy({ transaction });
        }
      }
    }

    await transaction.commit();

    res.json({
      success: true,
      summary,
      warnings,
    });
  } catch (error) {
    await transaction.rollback();
    console.error("Import error:", error);
    res.status(500).json({ error: "Failed to import data" });
  }
});

router.post("/me/import/canvas/:canvasId", protect, async (req, res) => {
  const transaction = await sequelize.transaction();

  try {
    const { canvasId } = req.params;
    const parsed = await validateCanvasJsonImportPayload(req.body);

    if (!parsed.success) {
      await transaction.rollback();
      return res.status(400).json({ error: parsed.error });
    }

    const userCanvas = await UserCanvas.findOne({
      where: { canvas_id: canvasId, user_id: req.user.id },
      transaction,
    });

    if (
      !userCanvas ||
      (userCanvas.permissions !== "edit" && userCanvas.permissions !== "admin")
    ) {
      await transaction.rollback();
      return res.status(403).json({
        error: "Forbidden: You don't have permission to import into this canvas",
      });
    }

    const targetCanvas = await Canvas.findByPk(canvasId, { transaction });
    if (!targetCanvas) {
      await transaction.rollback();
      return res.status(404).json({ error: "Canvas not found" });
    }

    const {
      data: { drafts, versusSeries },
      options: { dedupeStrategy, basePositionX = 50, basePositionY = 50 },
    } = parsed.data;

    const summary = {
      draftsCreated: 0,
      draftsUpdated: 0,
      draftsSkipped: 0,
      seriesCreated: 0,
      seriesUpdated: 0,
      seriesSkipped: 0,
    };
    const warnings = [];

    for (let i = 0; i < drafts.length; i += 1) {
      const importedDraft = drafts[i];
      let normalizedPicks;
      try {
        normalizedPicks = normalizeChampionRefs(
          importedDraft.picks,
          `draft "${importedDraft.name}"`,
        );
      } catch (e) {
        await transaction.rollback();
        return res.status(400).json({ error: e.message });
      }
      const existingCanvasDraft = await findCanvasDraftByName(
        canvasId,
        importedDraft.name,
        transaction,
      );
      const positionX = importedDraft.positionX ?? basePositionX + i * 40;
      const positionY = importedDraft.positionY ?? basePositionY + i * 40;

      if (!existingCanvasDraft) {
        const newDraft = await Draft.create(
          {
            owner_id: req.user.id,
            name: importedDraft.name,
            public: false,
            picks: normalizedPicks,
            type: "canvas",
            firstPick: importedDraft.firstPick || "blue",
            blueSideTeam: importedDraft.blueSideTeam || 1,
          },
          { transaction },
        );

        await CanvasDraft.create(
          {
            canvas_id: canvasId,
            draft_id: newDraft.id,
            positionX,
            positionY,
            source_type: "canvas",
          },
          { transaction },
        );

        summary.draftsCreated += 1;
        continue;
      }

      if (dedupeStrategy === "skip") {
        summary.draftsSkipped += 1;
        continue;
      }

      if (dedupeStrategy === "rename") {
        const renamedDraft = await Draft.create(
          {
            owner_id: req.user.id,
            name: await generateUniqueCanvasDraftName(
              importedDraft.name,
              canvasId,
              null,
              transaction,
            ),
            public: false,
            picks: normalizedPicks,
            type: "canvas",
            firstPick: importedDraft.firstPick || "blue",
            blueSideTeam: importedDraft.blueSideTeam || 1,
          },
          { transaction },
        );

        await CanvasDraft.create(
          {
            canvas_id: canvasId,
            draft_id: renamedDraft.id,
            positionX,
            positionY,
            source_type: "canvas",
          },
          { transaction },
        );

        summary.draftsCreated += 1;
        continue;
      }

      await existingCanvasDraft.Draft.update(
        {
          picks: normalizedPicks,
          firstPick: importedDraft.firstPick || existingCanvasDraft.Draft.firstPick,
          blueSideTeam:
            importedDraft.blueSideTeam || existingCanvasDraft.Draft.blueSideTeam,
        },
        { transaction },
      );

      summary.draftsUpdated += 1;
    }

    for (let i = 0; i < versusSeries.length; i += 1) {
      const importedSeries = versusSeries[i];
      const baseSeriesName = getImportedSeriesName(importedSeries);
      let normalizedDisabledChampions;
      try {
        normalizedDisabledChampions = normalizeChampionRefs(
          importedSeries.disabledChampions || [],
          `disabledChampions for series "${baseSeriesName}"`,
        );
      } catch (e) {
        await transaction.rollback();
        return res.status(400).json({ error: e.message });
      }
      const existingSeries = await findOwnedVersusSeriesByName(
        req.user.id,
        baseSeriesName,
        transaction,
      );

      if (existingSeries && dedupeStrategy === "skip") {
        summary.seriesSkipped += 1;
        continue;
      }

      let series = existingSeries;

      if (!series || dedupeStrategy === "rename") {
        let seriesName = baseSeriesName;

        if (existingSeries || dedupeStrategy === "rename") {
          let counter = 1;
          while (
            await findOwnedVersusSeriesByName(req.user.id, seriesName, transaction)
          ) {
            seriesName = `${baseSeriesName} ${counter}`;
            counter += 1;
          }
        }

        series = await VersusDraft.create(
          {
            owner_id: req.user.id,
            name: seriesName,
            length: importedSeries.seriesLength,
            type: importedSeries.draftType || "standard",
            blueTeamName: importedSeries.blueTeamName || "Team 1",
            redTeamName: importedSeries.redTeamName || "Team 2",
            competitive: importedSeries.competitive || false,
            disabledChampions: normalizedDisabledChampions,
          },
          { transaction },
        );
        summary.seriesCreated += 1;
      } else {
        await series.update(
          {
            length: importedSeries.seriesLength,
            type: importedSeries.draftType || "standard",
            blueTeamName: importedSeries.blueTeamName || "Team 1",
            redTeamName: importedSeries.redTeamName || "Team 2",
            competitive: importedSeries.competitive || false,
            disabledChampions: normalizedDisabledChampions,
          },
          { transaction },
        );
        summary.seriesUpdated += 1;
      }

      const existingDraftsByIndex = new Map(
        ((series.Drafts || [])).map((draft) => [draft.seriesIndex ?? 0, draft]),
      );

      for (let draftIndex = 0; draftIndex < importedSeries.drafts.length; draftIndex += 1) {
        const importedDraft = importedSeries.drafts[draftIndex];
        let normalizedPicks;
        try {
          normalizedPicks = normalizeChampionRefs(
            importedDraft.picks,
            `versus draft "${importedDraft.name || `Game ${draftIndex + 1}`}"`,
          );
        } catch (e) {
          await transaction.rollback();
          return res.status(400).json({ error: e.message });
        }
        const seriesIndex =
          importedDraft.gameNumber != null ? importedDraft.gameNumber - 1 : draftIndex;
        const existingDraft = existingDraftsByIndex.get(seriesIndex);
        const completed = importedDraft.winner != null;
        const completedAt = completed ? new Date() : null;

        if (!existingDraft) {
          await Draft.create(
            {
              owner_id: req.user.id,
              name: importedDraft.name || `Game ${seriesIndex + 1}`,
              public: false,
              picks: normalizedPicks,
              type: "versus",
              versus_draft_id: series.id,
              seriesIndex,
              winner: importedDraft.winner ?? null,
              completed,
              completedAt,
              firstPick: importedDraft.firstPick || "blue",
              blueSideTeam: importedDraft.blueSideTeam || 1,
            },
            { transaction },
          );
          continue;
        }

        await existingDraft.update(
          {
            name: importedDraft.name || existingDraft.name,
            picks: normalizedPicks,
            winner: importedDraft.winner ?? null,
            completed,
            completedAt,
            firstPick: importedDraft.firstPick || existingDraft.firstPick,
            blueSideTeam: importedDraft.blueSideTeam || existingDraft.blueSideTeam,
          },
          { transaction },
        );
      }

      const importedIndices = new Set(
        importedSeries.drafts.map((draft, draftIndex) =>
          draft.gameNumber != null ? draft.gameNumber - 1 : draftIndex,
        ),
      );
      for (const [idx, draft] of existingDraftsByIndex) {
        if (!importedIndices.has(idx)) {
          await draft.destroy({ transaction });
        }
      }

      const syncedDrafts = await Draft.findAll({
        where: { versus_draft_id: series.id },
        order: [["seriesIndex", "ASC"]],
        transaction,
      });

      let existingGroup = await CanvasGroup.findOne({
        where: { canvas_id: canvasId, versus_draft_id: series.id },
        transaction,
      });

      const groupPositionX = importedSeries.positionX ?? basePositionX;
      const groupPositionY = importedSeries.positionY ?? basePositionY + i * 120;
      const metadata = {
        blueTeamName: series.blueTeamName,
        redTeamName: series.redTeamName,
        length: series.length,
        competitive: series.competitive,
        seriesType: series.type,
        disabledChampions: series.disabledChampions || [],
      };

      if (existingGroup) {
        await existingGroup.update(
          {
            name: series.name,
            positionX:
              dedupeStrategy === "overwrite"
                ? groupPositionX
                : existingGroup.positionX,
            positionY:
              dedupeStrategy === "overwrite"
                ? groupPositionY
                : existingGroup.positionY,
            metadata,
          },
          { transaction },
        );

        if (dedupeStrategy === "overwrite") {
          // Only remove CanvasDraft join records, not the Draft records themselves.
          // Versus drafts are owned by the VersusDraft series, not the canvas.
          await CanvasDraft.destroy({
            where: { canvas_id: canvasId, group_id: existingGroup.id },
            transaction,
          });
        } else {
          warnings.push(
            `Series "${series.name}" is already on this canvas. Updated the owned series data without adding another group.`,
          );
          continue;
        }
      } else {
        existingGroup = await CanvasGroup.create(
          {
            canvas_id: canvasId,
            name: await generateUniqueCanvasGroupName(series.name, canvasId, transaction),
            type: "series",
            positionX: groupPositionX,
            positionY: groupPositionY,
            versus_draft_id: series.id,
            metadata,
          },
          { transaction },
        );
      }

      for (let draftIndex = 0; draftIndex < syncedDrafts.length; draftIndex += 1) {
        const draft = syncedDrafts[draftIndex];
        await CanvasDraft.create(
          {
            canvas_id: canvasId,
            draft_id: draft.id,
            positionX: existingGroup.positionX + draftIndex * 380,
            positionY: existingGroup.positionY,
            is_locked: true,
            group_id: existingGroup.id,
            source_type: "versus",
          },
          { transaction },
        );
      }
    }

    await touchCanvasTimestamp(targetCanvas.id, transaction);
    await transaction.commit();
    await broadcastCanvasUpdate(targetCanvas.id);

    res.json({
      success: true,
      summary,
      warnings,
    });
  } catch (error) {
    await transaction.rollback();
    console.error("Canvas JSON import error:", error);
    res.status(500).json({ error: "Failed to import JSON into canvas" });
  }
});

router.delete("/me", protect, async (req, res) => {
  try {
    const userId = req.user.id;
    const { confirmEmail } = req.body;

    // Validate email confirmation
    if (!confirmEmail || confirmEmail !== req.user.email) {
      return res.status(400).json({ error: "Email confirmation does not match" });
    }

    // 1. Get canvases where user is admin (owner)
    const ownedCanvases = await UserCanvas.findAll({
      where: { user_id: userId, permissions: "admin" },
    });
    const ownedCanvasIds = ownedCanvases.map((uc) => uc.canvas_id);

    // 2. For each owned canvas, find drafts that are ONLY on that canvas
    for (const canvasId of ownedCanvasIds) {
      const canvasDrafts = await CanvasDraft.findAll({
        where: { canvas_id: canvasId },
      });

      for (const cd of canvasDrafts) {
        // Check if this draft exists on any OTHER canvas not owned by user
        const otherCanvasLinks = await CanvasDraft.findAll({
          where: { draft_id: cd.draft_id },
        });

        const isSharedElsewhere = otherCanvasLinks.some(
          (link) => !ownedCanvasIds.includes(link.canvas_id)
        );

        if (!isSharedElsewhere) {
          // Safe to delete the draft
          await Draft.destroy({ where: { id: cd.draft_id } });
        }
      }

      // Delete all UserCanvas entries for this canvas (including shared users)
      await UserCanvas.destroy({ where: { canvas_id: canvasId } });

      // Delete all connections on this canvas
      await CanvasConnection.destroy({ where: { canvas_id: canvasId } });

      // Delete the canvas (cascades to CanvasDraft, CanvasGroup, etc.)
      await Canvas.destroy({ where: { id: canvasId } });
    }

    // 3. Anonymize versus series (set owner_id to null)
    await VersusDraft.update(
      { owner_id: null },
      { where: { owner_id: userId } }
    );

    // 4. Delete user tokens
    await UserToken.destroy({ where: { user_id: userId } });

    // 5. Delete UserCanvas entries (for shared canvases user doesn't own)
    await UserCanvas.destroy({ where: { user_id: userId } });

    // 6. Delete user
    await req.user.destroy();

    // 7. Clear cookies
    res.clearCookie("refreshToken", {
      httpOnly: true,
      secure: true,
      sameSite: "none",
      path: "/api/auth",
    });
    res.clearCookie("accessToken", {
      httpOnly: true,
      secure: true,
      sameSite: "none",
    });

    res.json({ success: true, message: "Account deleted" });
  } catch (error) {
    console.error("Delete account error:", error);
    res.status(500).json({ error: "Failed to delete account" });
  }
});

router.patch("/me/preferences", protect, async (req, res) => {
  try {
    const { keyboard_controls } = req.body;

    if (typeof keyboard_controls !== "boolean") {
      return res.status(400).json({ error: "keyboard_controls must be a boolean" });
    }

    await req.user.update({ keyboard_controls });

    res.json({
      id: req.user.id,
      name: req.user.name,
      email: req.user.email,
      picture: req.user.picture,
      display_name: req.user.display_name,
      keyboard_controls: req.user.keyboard_controls,
    });
  } catch (error) {
    console.error("Update preferences error:", error);
    res.status(500).json({ error: "Failed to update preferences" });
  }
});

module.exports = router;
