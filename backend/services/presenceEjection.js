// Revocation ejection: room membership is the ACL for high-frequency
// presence relays (see presenceHandlers.js), so removing a user's canvas
// access must also force their live sockets out of the room and the
// presence map — otherwise they keep receiving cursors and names.
//
// Singleton mirroring middleware/socketService: routes are wired at module
// scope before the socket.io server exists, so index.js injects io and the
// presence store at startup.
class PresenceEjection {
  constructor() {
    this.io = null;
    this.store = null;
  }

  init({ io, store }) {
    this.io = io;
    this.store = store;
  }

  // Called AFTER the revoking mutation commits. Ejected sockets receive
  // canvasAccessRevoked (client shows a toast and leaves the canvas); the
  // remaining room hears the usual presenceLeave.
  ejectUserFromCanvas(canvasId, userId) {
    if (!this.io || !this.store) {
      console.warn("Presence ejection not initialized, skipping eject");
      return;
    }

    const socketIds = this.store.socketsOf(canvasId, userId);
    if (socketIds.length === 0) return;

    for (const socketId of socketIds) {
      this.store.leave(canvasId, userId, socketId);
      const socket = this.io.sockets.sockets.get(socketId);
      if (!socket) continue;
      socket.leave(canvasId);
      socket.emit("canvasAccessRevoked", { canvasId });
    }

    this.io.to(canvasId).emit("presenceLeave", { canvasId, userId });
  }
}

module.exports = new PresenceEjection();
