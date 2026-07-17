// In-memory canvas presence: who is currently viewing each canvas, deduped
// by user (a user with two tabs is one presence entry until their last
// socket departs). Single-instance assumption is documented in the design —
// horizontal scaling would need the socket.io adapter plus a shared store.
//
// This is session-scoped ephemera, not a persisted mutation, so it lives
// beside the Canvas Mutation Gate rather than inside it; access control for
// joining happens in the socket handler via assertCanvasAccess.

function createPresenceStore() {
  // canvasId -> Map<userId, { user, sockets: Set<socketId> }>
  const canvases = new Map();
  // socketId -> { userId, canvasIds: Set<canvasId> } for disconnect cleanup
  const socketIndex = new Map();

  function join(canvasId, user, socketId) {
    let users = canvases.get(canvasId);
    if (!users) {
      users = new Map();
      canvases.set(canvasId, users);
    }

    let entry = users.get(user.userId);
    const newlyPresent = !entry;
    if (!entry) {
      entry = { user, sockets: new Set() };
      users.set(user.userId, entry);
    } else {
      entry.user = user;
    }
    entry.sockets.add(socketId);

    let indexed = socketIndex.get(socketId);
    if (!indexed) {
      indexed = { userId: user.userId, canvasIds: new Set() };
      socketIndex.set(socketId, indexed);
    }
    indexed.canvasIds.add(canvasId);

    return newlyPresent;
  }

  function leave(canvasId, userId, socketId) {
    const indexed = socketIndex.get(socketId);
    if (indexed) {
      indexed.canvasIds.delete(canvasId);
      if (indexed.canvasIds.size === 0) {
        socketIndex.delete(socketId);
      }
    }

    const users = canvases.get(canvasId);
    const entry = users?.get(userId);
    if (!entry) return false;

    entry.sockets.delete(socketId);
    if (entry.sockets.size > 0) return false;

    users.delete(userId);
    if (users.size === 0) {
      canvases.delete(canvasId);
    }
    return true;
  }

  function leaveAll(socketId) {
    const indexed = socketIndex.get(socketId);
    if (!indexed) return [];

    return [...indexed.canvasIds].map((canvasId) => ({
      canvasId,
      userId: indexed.userId,
      departed: leave(canvasId, indexed.userId, socketId),
    }));
  }

  function snapshot(canvasId) {
    const users = canvases.get(canvasId);
    if (!users) return [];
    return [...users.values()].map((entry) => entry.user);
  }

  return { join, leave, leaveAll, snapshot };
}

module.exports = { createPresenceStore };
