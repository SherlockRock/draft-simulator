const {
  assertCanvasAccess,
  CanvasMutationError,
  InvalidMutationError,
} = require("../services/canvasMutations");

// Presence payload deliberately excludes the email — it is broadcast to
// everyone in the canvas room.
function getPresenceUser(socket) {
  const row = socket.user?.dataValues ?? socket.user;
  if (!row?.id) return null;
  return {
    userId: row.id,
    displayName: row.display_name ?? row.name,
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
  wrapSocketHandler(socket, "joinCanvas", async (data) => {
    const canvasId = data?.canvasId;
    try {
      if (!canvasId) {
        throw new InvalidMutationError("canvasId is required");
      }
      const user = getPresenceUser(socket);
      await assertCanvasAccess({
        userId: user?.userId ?? null,
        canvasId,
        level: "view",
      });

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
    if (!canvasId) return;

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

  socket.on("disconnecting", () => {
    for (const { canvasId, userId, departed } of store.leaveAll(socket.id)) {
      if (departed) {
        socket.to(canvasId).emit("presenceLeave", { canvasId, userId });
      }
    }
  });
}

module.exports = { setupPresenceHandlers };
