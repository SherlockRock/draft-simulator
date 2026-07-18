const {
  assertCanvasAccess,
  CanvasMutationError,
  InvalidMutationError,
  NotAuthorizedError,
} = require("../services/canvasMutations");

// Presence payload deliberately excludes the email — it is broadcast to
// everyone in the canvas room.
function getPresenceUser(socket) {
  const row = socket.user?.dataValues ?? socket.user;
  if (!row?.id) return null;
  return {
    userId: row.id,
    // Non-empty fallback: clients validate the whole snapshot at once, so a
    // single blank name must not be able to drop presence for everyone.
    displayName: row.display_name || row.name || "Unknown",
    picture: row.picture ?? null,
  };
}

// Gated canvas room membership: joinCanvas verifies view access through the
// Canvas Mutation Gate before joining the socket.io room (named by canvasId,
// same room the gate broadcasts to) and registering presence. The legacy
// unauthenticated joinRoom remains for draft rooms only. Once inside, room
// membership IS the ACL for high-frequency presence relays; revocation must
// eject sockets from the room (slice 3).
function setupPresenceHandlers(socket, store, wrapSocketHandler) {
  // Canvases this socket currently wants to be in. joinCanvas re-checks the
  // set after its async ACL lookup: a leaveCanvas processed while the check
  // was in flight cancels the join instead of leaving ghost membership.
  const wantedCanvases = new Set();

  wrapSocketHandler(socket, "joinCanvas", async (data) => {
    const canvasId = data?.canvasId;
    try {
      if (typeof canvasId !== "string" || !canvasId) {
        throw new InvalidMutationError("canvasId is required");
      }
      wantedCanvases.add(canvasId);
      const user = getPresenceUser(socket);
      // Snapshot before the async ACL lookup: if a revocation lands while
      // the lookup is in flight, the lookup read the pre-delete row and its
      // success is stale — the counter moving is how we detect that.
      const revocationsSeen = user
        ? store.revocationCount(canvasId, user.userId)
        : 0;
      await assertCanvasAccess({
        userId: user?.userId ?? null,
        canvasId,
        level: "view",
      });
      if (!wantedCanvases.has(canvasId)) return;
      if (user && store.revocationCount(canvasId, user.userId) !== revocationsSeen) {
        throw new NotAuthorizedError();
      }

      socket.join(canvasId);
      const newlyPresent = store.join(canvasId, user, socket.id);
      if (newlyPresent) {
        socket.to(canvasId).emit("presenceJoin", { canvasId, user });
      }
      socket.emit("presenceSnapshot", {
        canvasId,
        users: store.snapshot(canvasId),
      });
    } catch (err) {
      if (err instanceof CanvasMutationError) {
        socket.emit("canvasMutationError", {
          event: "joinCanvas",
          code: err.code,
          message: err.message,
        });
      } else {
        console.error("Unexpected error in joinCanvas handler:", err);
      }
    }
  });

  wrapSocketHandler(socket, "leaveCanvas", async (data) => {
    const canvasId = data?.canvasId;
    if (typeof canvasId !== "string" || !canvasId) return;

    wantedCanvases.delete(canvasId);
    socket.leave(canvasId);
    const user = getPresenceUser(socket);
    if (!user) return;

    if (store.leave(canvasId, user.userId, socket.id)) {
      socket.to(canvasId).emit("presenceLeave", {
        canvasId,
        userId: user.userId,
      });
    }
  });

  // High-frequency presence relay. Room membership is the ONLY access check —
  // a deliberate, documented exception to the Canvas Mutation Gate convention:
  // the gate covers mutations and persisted relays; cursor positions are
  // session-scoped ephemera, and a DB hit per mousemove would not survive
  // production traffic. joinCanvas is the gate that controls room membership,
  // and revocation must eject sockets from the room (slice 3). Laser and
  // viewport events (slices 4-5) are meant to ride this same channel shape.
  wrapSocketHandler(socket, "cursorMove", async (data) => {
    const canvasId = data?.canvasId;
    if (typeof canvasId !== "string" || !canvasId) return;
    if (!socket.rooms.has(canvasId)) return;
    if (!Number.isFinite(data.x) || !Number.isFinite(data.y)) return;
    const user = getPresenceUser(socket);
    if (!user) return;

    // userId is stamped server-side; a client-supplied one is ignored.
    socket.to(canvasId).emit("cursorMove", {
      canvasId,
      userId: user.userId,
      x: data.x,
      y: data.y,
    });
  });

  // Fired when a client leaves the canvas *view* while staying in the canvas
  // room (e.g. drilling into a child draft): receivers prune the cursor
  // immediately instead of waiting out the idle fade. Same trust model as
  // cursorMove: room membership is the check, userId is stamped server-side.
  wrapSocketHandler(socket, "cursorLeave", async (data) => {
    const canvasId = data?.canvasId;
    if (typeof canvasId !== "string" || !canvasId) return;
    if (!socket.rooms.has(canvasId)) return;
    const user = getPresenceUser(socket);
    if (!user) return;

    socket.to(canvasId).emit("cursorLeave", {
      canvasId,
      userId: user.userId,
    });
  });

  // Viewport broadcast (slice 4): same thin-relay trust model as cursorMove,
  // plus the store keeps the sender's last-known viewport so presence
  // snapshots can offer jump-to-viewport to late joiners immediately.
  wrapSocketHandler(socket, "viewportMove", async (data) => {
    const canvasId = data?.canvasId;
    if (typeof canvasId !== "string" || !canvasId) return;
    if (!socket.rooms.has(canvasId)) return;
    if (!Number.isFinite(data.x) || !Number.isFinite(data.y)) return;
    if (!Number.isFinite(data.zoom) || data.zoom <= 0) return;
    const user = getPresenceUser(socket);
    if (!user) return;

    const viewport = { x: data.x, y: data.y, zoom: data.zoom };
    store.setViewport(canvasId, user.userId, viewport);
    socket.to(canvasId).emit("viewportMove", {
      canvasId,
      userId: user.userId,
      ...viewport,
    });
  });

  // Fired when a client leaves the canvas *view* while staying in the canvas
  // room (draft drilldown, canvas-to-canvas nav): the stored viewport is no
  // longer live, so jump-to-viewport must stop offering it.
  wrapSocketHandler(socket, "viewportLeave", async (data) => {
    const canvasId = data?.canvasId;
    if (typeof canvasId !== "string" || !canvasId) return;
    if (!socket.rooms.has(canvasId)) return;
    const user = getPresenceUser(socket);
    if (!user) return;

    store.clearViewport(canvasId, user.userId);
    socket.to(canvasId).emit("viewportLeave", {
      canvasId,
      userId: user.userId,
    });
  });

  socket.on("disconnecting", () => {
    for (const { canvasId, userId, departed } of store.leaveAll(socket.id)) {
      if (departed) {
        socket.to(canvasId).emit("presenceLeave", { canvasId, userId });
      }
    }
  });
}

module.exports = { setupPresenceHandlers };
