// services/socketService.js
class SocketService {
  constructor() {
    this.io = null;
  }

  /**
   * Initialize the socket service with the Socket.IO instance
   * @param {Server} io - Socket.IO server instance
   */
  init(io) {
    this.io = io;
    console.log("Socket service initialized");
  }

  /**
   * Check if Socket.IO is initialized
   * @returns {boolean}
   */
  isInitialized() {
    return this.io !== null;
  }

  /**
   * Emit an event to a specific room
   * @param {string} room - Room ID
   * @param {string} event - Event name
   * @param {any} data - Data to emit
   */
  emitToRoom(room, event, data) {
    if (!this.isInitialized()) {
      console.warn("Socket service not initialized, skipping emit");
      return;
    }
    console.log(`Emitting to room ${room}: ${event}`, data);
    this.io.to(room).emit(event, data, room);
  }

  /**
   * Get connected clients count for a room
   * @param {string} room - Room ID
   * @returns {Promise<number>} Number of clients in room
   */
  async getRoomSize(room) {
    if (!this.isInitialized()) {
      return 0;
    }
    const sockets = await this.io.in(room).fetchSockets();
    return sockets.length;
  }
}

// Export singleton instance
module.exports = new SocketService();
