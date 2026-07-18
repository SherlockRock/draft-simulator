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
  // "canvasId\0userId" -> monotonic revocation counter. joinCanvas snapshots
  // it before its async ACL lookup and aborts if it moved: an access check
  // that read the pre-revocation row must not grant room entry.
  const revocations = new Map();

  function revocationKey(canvasId, userId) {
    return `${canvasId}\0${userId}`;
  }

  function markRevoked(canvasId, userId) {
    const key = revocationKey(canvasId, userId);
    revocations.set(key, (revocations.get(key) ?? 0) + 1);
  }

  function revocationCount(canvasId, userId) {
    return revocations.get(revocationKey(canvasId, userId)) ?? 0;
  }

  function join(canvasId, user, socketId) {
    let users = canvases.get(canvasId);
    if (!users) {
      users = new Map();
      canvases.set(canvasId, users);
    }

    let entry = users.get(user.userId);
    const newlyPresent = !entry;
    if (!entry) {
      // viewport is the user's last-known canvas viewport (slice 4): null
      // until their client first broadcasts one, preserved while any of
      // their sockets remains, gone once they fully depart.
      entry = { user, sockets: new Set(), viewport: null };
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

  // Socket ids a user currently has on a canvas — the lookup revocation
  // ejection needs to force those sockets out of the room.
  function socketsOf(canvasId, userId) {
    const entry = canvases.get(canvasId)?.get(userId);
    return entry ? [...entry.sockets] : [];
  }

  function setViewport(canvasId, userId, viewport) {
    const entry = canvases.get(canvasId)?.get(userId);
    if (!entry) return false;
    entry.viewport = viewport;
    return true;
  }

  function clearViewport(canvasId, userId) {
    const entry = canvases.get(canvasId)?.get(userId);
    if (entry) entry.viewport = null;
  }

  function snapshot(canvasId) {
    const users = canvases.get(canvasId);
    if (!users) return [];
    return [...users.values()].map((entry) => ({
      ...entry.user,
      viewport: entry.viewport,
    }));
  }

  return {
    join,
    leave,
    leaveAll,
    socketsOf,
    setViewport,
    clearViewport,
    snapshot,
    markRevoked,
    revocationCount,
  };
}

module.exports = { createPresenceStore };
