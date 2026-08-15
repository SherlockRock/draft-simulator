// In-memory canvas presence: who is currently viewing each canvas, deduped
// by user (a user with two tabs is one presence entry until their last
// socket departs). Single-instance assumption is documented in the design —
// horizontal scaling would need the socket.io adapter plus a shared store.
//
// This is session-scoped ephemera, not a persisted mutation, so it lives
// beside the Canvas Mutation Gate rather than inside it; access control for
// joining happens in the socket handler via assertCanvasAccess.

const ANNOTATION_LOCK_TTL_MS = 60_000;

function createPresenceStore() {
  // canvasId -> Map<userId, { user, sockets: Set<socketId> }>
  const canvases = new Map();
  // socketId -> { userId, canvasIds: Set<canvasId> } for disconnect cleanup
  const socketIndex = new Map();
  // "canvasId\0userId" -> monotonic revocation counter. joinCanvas snapshots
  // it before its async ACL lookup and aborts if it moved: an access check
  // that read the pre-revocation row must not grant room entry.
  const revocations = new Map();
  // canvasId -> Map<annotationId, { userId, socketId, at }>
  //
  // ⚠️ ADVISORY ONLY (design D12). Last-write-wins on blur is the underlying
  // truth and the PATCH never consults this — no persistence logic may depend
  // on the lock holding, or a dropped socket stops being a lost hint and
  // becomes a correctness bug. It exists so two people do not silently
  // overwrite each other's paragraph, not to make that impossible.
  const annotationLocks = new Map();

  function acquireAnnotationLock(canvasId, annotationId, userId, socketId, now = Date.now()) {
    let locks = annotationLocks.get(canvasId);
    if (!locks) {
      locks = new Map();
      annotationLocks.set(canvasId, locks);
    }

    const held = locks.get(annotationId);
    // The holder re-acquiring is not a conflict — it is how a long edit keeps
    // refreshing `at` against the inactivity timeout.
    if (
      held &&
      held.userId !== userId &&
      now - held.at < ANNOTATION_LOCK_TTL_MS
    ) {
      return false;
    }

    locks.set(annotationId, { userId, socketId, at: now });
    return true;
  }

  function releaseAnnotationLock(canvasId, annotationId, userId) {
    const locks = annotationLocks.get(canvasId);
    const held = locks?.get(annotationId);
    if (!held || held.userId !== userId) return false;

    locks.delete(annotationId);
    if (locks.size === 0) annotationLocks.delete(canvasId);
    return true;
  }

  function releaseLocksOf(socketId) {
    const released = [];
    for (const [canvasId, locks] of annotationLocks) {
      for (const [annotationId, held] of locks) {
        if (held.socketId !== socketId) continue;
        locks.delete(annotationId);
        released.push({ canvasId, annotationId });
      }
      if (locks.size === 0) annotationLocks.delete(canvasId);
    }
    return released;
  }

  // Disconnect alone is not enough: an idle open tab holds its socket, so its
  // note would stay un-editable forever. The timeout trades a rare silent loss
  // for never producing a common hard block.
  function expireStaleAnnotationLocks(canvasId, now = Date.now()) {
    const locks = annotationLocks.get(canvasId);
    if (!locks) return [];

    const expired = [];
    for (const [annotationId, held] of locks) {
      if (now - held.at < ANNOTATION_LOCK_TTL_MS) continue;
      locks.delete(annotationId);
      expired.push({ canvasId, annotationId });
    }
    if (locks.size === 0) annotationLocks.delete(canvasId);
    return expired;
  }

  // FILTERS rather than sweeps, deliberately: a snapshot read is on the join
  // path and must stay side-effect-free. It cannot lean on the sweep either —
  // that rides `annotationEditStart`, so if nobody ever edits again a late
  // joiner would be handed a phantom lock forever, on the exact channel that
  // exists to inform late joiners. Removal stays with the sweep, the
  // acquire-replacement and the disconnect/release paths.
  function annotationLocksSnapshot(canvasId, now = Date.now()) {
    const locks = annotationLocks.get(canvasId);
    if (!locks) return [];
    return [...locks]
      .filter(([, held]) => now - held.at < ANNOTATION_LOCK_TTL_MS)
      .map(([annotationId, held]) => ({ annotationId, userId: held.userId }));
  }

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
    acquireAnnotationLock,
    releaseAnnotationLock,
    releaseLocksOf,
    expireStaleAnnotationLocks,
    annotationLocksSnapshot,
    markRevoked,
    revocationCount,
  };
}

module.exports = { createPresenceStore };
