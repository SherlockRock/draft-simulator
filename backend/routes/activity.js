const express = require("express");
const router = express.Router();
const Draft = require("../models/Draft");
const { Canvas, UserCanvas } = require("../models/Canvas");
const User = require("../models/User");
const { getUserFromRequest } = require("../middleware/auth");
const { Op } = require("sequelize");

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

    // Fetch more items than needed to ensure proper pagination after sorting
    const fetchLimit = 50;

    // Get user's owned drafts (standalone and versus only) if needed
    const ownedDrafts =
      resourceType === "canvas"
        ? []
        : await Draft.findAll({
            where: {
              owner_id: user.id,
              type: { [Op.in]: ["standalone", "versus"] },
            },
            order: [["updatedAt", "DESC"]],
            limit: fetchLimit,
            attributes: ["id", "name", "description", "public", "type", "icon", "updatedAt", "createdAt"],
          });

    // Get drafts shared with user (standalone and versus only) if needed
    const sharedDrafts =
      resourceType === "canvas"
        ? []
        : await user.getSharedDrafts({
            where: {
              type: { [Op.in]: ["standalone", "versus"] },
            },
            order: [["updatedAt", "DESC"]],
            limit: fetchLimit,
            attributes: ["id", "name", "description", "public", "type", "icon", "updatedAt", "createdAt"],
            joinTableAttributes: [],
          });

    // Get user's canvases if needed
    const canvases =
      resourceType === "draft"
        ? []
        : await Canvas.findAll({
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
            order: [["updatedAt", "DESC"]],
            limit: fetchLimit,
            attributes: ["id", "name", "description", "icon", "updatedAt", "createdAt"],
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
      ...sharedDrafts.map((draft) => ({
        resource_type: "draft",
        resource_id: draft.id,
        resource_name: draft.name,
        description: draft.description,
        public: draft.public,
        icon: draft.icon,
        timestamp: draft.updatedAt,
        created_at: draft.createdAt,
        is_owner: false,
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

    // Combine and sort by timestamp
    const allActivities = [...draftActivities, ...canvasActivities].sort(
      (a, b) => new Date(b.timestamp) - new Date(a.timestamp)
    );
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
