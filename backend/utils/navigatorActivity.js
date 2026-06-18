// Maps a NavigatorSession model instance to a Recent Activity row,
// mirroring the canvas/versus row shape in routes/activity.js.
// Navigator has no icon/description columns and a single-owner user_id,
// so those fields are null / is_owner is a direct equality check.
function mapNavigatorActivityRow(session, userId) {
  return {
    resource_type: "navigator",
    resource_id: session.id,
    resource_name: session.name ?? "Untitled Session",
    description: null,
    icon: null,
    timestamp: session.updatedAt,
    created_at: session.createdAt,
    is_owner: session.user_id === userId,
  };
}

module.exports = { mapNavigatorActivityRow };
