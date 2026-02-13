const express = require("express");
const router = express.Router();
const { Op, literal } = require("sequelize");
const Draft = require("../models/Draft");
const { Canvas, UserCanvas } = require("../models/Canvas");
const VersusDraft = require("../models/VersusDraft");
const User = require("../models/User");
const { getUserFromRequest } = require("../middleware/auth");

const getSortOrder = (sort, tableName = null) => {
  const nameCol = tableName ? `LOWER("${tableName}"."name")` : "LOWER(name)";
  switch (sort) {
    case "oldest":
      return [["updatedAt", "ASC"]];
    case "name_asc":
      return [
        [literal(nameCol), "ASC"],
        ["updatedAt", "DESC"],
      ];
    case "name_desc":
      return [
        [literal(nameCol), "DESC"],
        ["updatedAt", "DESC"],
      ];
    case "recent":
    default:
      return [["updatedAt", "DESC"]];
  }
};

router.get("/recent", async (req, res) => {
  try {
    const user = await getUserFromRequest(req);

    if (!user) {
      return res.status(401).json({ error: "Not authorized, no user found" });
    }

    // Pagination parameters
    const page = parseInt(req.query.page) || 0;
    const pageSize = 12;
    const offset = page * pageSize;

    // Filter by resource type if provided
    const resourceType = req.query.resource_type; // 'draft', 'canvas', or undefined for all

    // Search and sort parameters
    const search = req.query.search || "";
    const sort = req.query.sort || "recent"; // recent, oldest, name_asc, name_desc

    // Fetch more items than needed to ensure proper pagination after sorting
    const fetchLimit = 50;

    // Get user's owned drafts (standalone only - versus series drafts are excluded) if needed
    const ownedDrafts =
      resourceType === "canvas" || resourceType === "versus"
        ? []
        : await Draft.findAll({
            where: {
              owner_id: user.id,
              type: "versus",
              versus_draft_id: null,
              ...(search && { name: { [Op.iLike]: `%${search}%` } }),
            },
            order: getSortOrder(sort),
            limit: fetchLimit,
            attributes: [
              "id",
              "name",
              "description",
              "public",
              "type",
              "icon",
              "updatedAt",
              "createdAt",
            ],
          });

    // Get user's canvases if needed
    const canvases =
      resourceType === "draft" || resourceType === "versus"
        ? []
        : await Canvas.findAll({
            where: {
              ...(search && { name: { [Op.iLike]: `%${search}%` } }),
            },
            include: [
              {
                model: User,
                where: { id: user.id },
                through: {
                  attributes: ["permissions"],
                },
                attributes: [],
                required: true,
              },
            ],
            order: getSortOrder(sort, "Canvas"),
            limit: fetchLimit,
            attributes: [
              "id",
              "name",
              "description",
              "icon",
              "updatedAt",
              "createdAt",
            ],
          });

    // Get user's versus drafts if needed
    const versusDrafts =
      resourceType === "draft" || resourceType === "canvas"
        ? []
        : await VersusDraft.findAll({
            where: {
              owner_id: user.id,
              ...(search && { name: { [Op.iLike]: `%${search}%` } }),
            },
            order: getSortOrder(sort),
            limit: fetchLimit,
            attributes: [
              "id",
              "name",
              "blueTeamName",
              "redTeamName",
              "description",
              "length",
              "competitive",
              "type",
              "updatedAt",
              "createdAt",
              "icon",
            ],
          });

    // Transform drafts to activity format
    const draftActivities = [
      ...ownedDrafts.map((draft) => ({
        resource_type: "draft",
        resource_id: draft.id,
        resource_name: draft.name,
        description: draft.description,
        public: draft.public,
        icon: draft.icon,
        timestamp: draft.updatedAt,
        created_at: draft.createdAt,
        is_owner: true,
        draft_type: draft.type,
      })),
    ];

    // Transform canvases to activity format
    const canvasActivities = canvases.map((canvas) => ({
      resource_type: "canvas",
      resource_id: canvas.id,
      resource_name: canvas.name,
      description: canvas.description,
      icon: canvas.icon,
      timestamp: canvas.updatedAt,
      created_at: canvas.createdAt,
      is_owner: true, // We don't track canvas ownership separately
    }));

    // Transform versus drafts to activity format
    const versusActivities = versusDrafts.map((versus) => ({
      resource_type: "versus",
      resource_id: versus.id,
      resource_name: versus.name,
      description: versus.description,
      blueTeamName: versus.blueTeamName,
      redTeamName: versus.redTeamName,
      length: versus.length,
      competitive: versus.competitive,
      type: versus.type,
      timestamp: versus.updatedAt,
      created_at: versus.createdAt,
      icon: versus.icon,
      is_owner: true,
    }));

    // Combine and sort
    const allActivities = [
      ...draftActivities,
      ...canvasActivities,
      ...versusActivities,
    ];

    // Sort combined results (case-insensitive for name sorting)
    if (sort === "name_asc") {
      allActivities.sort((a, b) => {
        const nameCompare = a.resource_name.localeCompare(
          b.resource_name,
          undefined,
          { sensitivity: "base" },
        );
        if (nameCompare !== 0) return nameCompare;
        return new Date(b.timestamp) - new Date(a.timestamp);
      });
    } else if (sort === "name_desc") {
      allActivities.sort((a, b) => {
        const nameCompare = b.resource_name.localeCompare(
          a.resource_name,
          undefined,
          { sensitivity: "base" },
        );
        if (nameCompare !== 0) return nameCompare;
        return new Date(b.timestamp) - new Date(a.timestamp);
      });
    } else if (sort === "oldest") {
      allActivities.sort(
        (a, b) => new Date(a.timestamp) - new Date(b.timestamp),
      );
    } else {
      // recent (default)
      allActivities.sort(
        (a, b) => new Date(b.timestamp) - new Date(a.timestamp),
      );
    }
    // Paginate the results
    const paginatedActivities = allActivities.slice(offset, offset + pageSize);
    const hasMore = offset + pageSize < allActivities.length;

    res.json({
      activities: paginatedActivities,
      hasMore,
      nextPage: hasMore ? page + 1 : null,
    });
  } catch (error) {
    console.error("Error fetching recent activity:", error);
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
