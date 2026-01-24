// HeartbeatManager.js
class HeartbeatManager {
  constructor(io) {
    this.io = io;
    this.clients = new Map(); // socketId -> client data
    this.usersByRole = new Map(); // role -> Set of userIds
    this.userSockets = new Map(); // userId -> Set of socketIds (for multiple tabs)
    this.heartbeatInterval = 10000; // 10 seconds - reduced for testing
    this.timeoutThreshold = 30000; // 30 seconds - reduced for testing

    this.checkInterval = setInterval(() => {
      this.checkStaleConnections();
    }, 10000);
  }

  registerClient(socket, userId, role) {
    // Store client data
    this.clients.set(socket.id, {
      socket,
      lastHeartbeat: Date.now(),
      userId,
      role,
    });

    // Track user's sockets (for multiple tabs/connections)
    if (!this.userSockets.has(userId)) {
      this.userSockets.set(userId, new Set());
    }
    this.userSockets.get(userId).add(socket.id);

    // Track by role
    if (!this.usersByRole.has(role)) {
      this.usersByRole.set(role, new Set());
    }
    this.usersByRole.get(role).add(userId);

    socket.on("heartbeat", () => {
      this.handleHeartbeat(socket.id);
    });

    socket.on("disconnect", () => {
      this.handleDisconnect(socket.id);
    });

    // Allow clients to update their role
    socket.on("update:role", (newRole) => {
      this.updateUserRole(socket.id, newRole);
    });

    socket.emit("heartbeat:config", {
      interval: this.heartbeatInterval,
    });

    // Broadcast updated user list to all clients
    this.broadcastConnectedUsers();
  }

  handleHeartbeat(socketId) {
    const client = this.clients.get(socketId);
    if (client) {
      client.lastHeartbeat = Date.now();
      client.socket.emit("heartbeat:ack");
    }
  }

  checkStaleConnections() {
    const now = Date.now();

    for (const [socketId, client] of this.clients.entries()) {
      const timeSinceLastBeat = now - client.lastHeartbeat;

      if (timeSinceLastBeat > this.timeoutThreshold) {
        console.log(`Client ${socketId} timed out`);
        client.socket.disconnect(true);
        this.handleDisconnect(socketId);
      }
    }
  }

  handleDisconnect(socketId) {
    const client = this.clients.get(socketId);
    if (!client) return;

    const { userId, role } = client;

    // Remove from clients map
    this.clients.delete(socketId);

    // Remove socket from user's socket set
    const userSocketSet = this.userSockets.get(userId);
    if (userSocketSet) {
      userSocketSet.delete(socketId);

      // If user has no more active connections, remove from role tracking
      if (userSocketSet.size === 0) {
        this.userSockets.delete(userId);

        const roleSet = this.usersByRole.get(role);
        if (roleSet) {
          roleSet.delete(userId);
          if (roleSet.size === 0) {
            this.usersByRole.delete(role);
          }
        }

        console.log(`User ${userId} fully disconnected from role ${role}`);

        // Emit event for when user is completely gone
        this.io.emit("user:disconnected", {
          userId,
          role,
          reason: "disconnect",
        });

        // Broadcast updated user list
        this.broadcastConnectedUsers();
      }
    }
  }

  updateUserRole(socketId, newRole) {
    const client = this.clients.get(socketId);
    if (!client) return;

    const { userId, role: oldRole } = client;

    // Remove from old role
    const oldRoleSet = this.usersByRole.get(oldRole);
    if (oldRoleSet) {
      oldRoleSet.delete(userId);
      if (oldRoleSet.size === 0) {
        this.usersByRole.delete(oldRole);
      }
    }

    // Add to new role
    if (!this.usersByRole.has(newRole)) {
      this.usersByRole.set(newRole, new Set());
    }
    this.usersByRole.get(newRole).add(userId);

    // Update all sockets for this user
    const userSocketSet = this.userSockets.get(userId);
    if (userSocketSet) {
      for (const sid of userSocketSet) {
        const c = this.clients.get(sid);
        if (c) c.role = newRole;
      }
    }

    this.io.emit("user:role-changed", { userId, oldRole, newRole });
    this.broadcastConnectedUsers();
  }

  getConnectedUsers() {
    const users = new Map();

    for (const [userId, socketIds] of this.userSockets.entries()) {
      // Get role from any of the user's sockets
      const firstSocket = socketIds.values().next().value;
      const client = this.clients.get(firstSocket);

      if (client) {
        users.set(userId, {
          userId,
          role: client.role,
          connectionCount: socketIds.size,
        });
      }
    }

    return Array.from(users.values());
  }

  broadcastConnectedUsers() {
    const users = this.getConnectedUsers();
    this.io.emit("users:update", users);
  }

  destroy() {
    clearInterval(this.checkInterval);
    this.clients.clear();
    this.usersByRole.clear();
    this.userSockets.clear();
  }
}

module.exports = HeartbeatManager;
