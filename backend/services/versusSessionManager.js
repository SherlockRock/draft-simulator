const crypto = require("crypto");

/**
 * VersusSessionManager manages real-time versus sessions (in-memory).
 * Tracks who is currently connected via active sockets.
 * Reclaim tokens are persisted in the database (VersusParticipant table),
 * not stored here - this is purely for real-time presence.
 */
class VersusSessionManager {
  constructor() {
    // Map: versusDraftId -> session data
    this.sessions = new Map();
  }

  /**
   * Get or create a session for a versus draft
   */
  getSession(versusDraftId) {
    if (!this.sessions.has(versusDraftId)) {
      this.sessions.set(versusDraftId, {
        versusDraftId,
        participants: new Map(), // socketId -> participant data
        roleAssignments: {
          blue_captain: null, // visitorId or null (visitorId = oderId or visitorId)
          red_captain: null,
        },
      });
    }
    return this.sessions.get(versusDraftId);
  }

  /**
   * Add a participant to the in-memory session (marks them as connected).
   * The reclaim token should be saved to the database separately by the handler.
   */
  addParticipant(versusDraftId, socket, visitorId, role, participantId = null) {
    const session = this.getSession(versusDraftId);

    // Generate reclaim token (will be saved to DB by handler)
    const reclaimToken = crypto.randomBytes(32).toString("hex");

    const participant = {
      socketId: socket.id,
      visitorId,
      role,
      participantId: participantId || crypto.randomUUID(),
      joinedAt: Date.now(),
      lastSeenAt: Date.now(),
      reclaimToken,
    };

    session.participants.set(socket.id, participant);

    // Update role assignments for captains
    if (role === "blue_captain") {
      session.roleAssignments.blue_captain = visitorId;
    } else if (role === "red_captain") {
      session.roleAssignments.red_captain = visitorId;
    }

    return participant;
  }

  /**
   * Remove a participant from the in-memory session (marks them as disconnected).
   * Does NOT invalidate their reclaim token - they can still reconnect using it
   * until someone else claims the role.
   */
  removeParticipant(versusDraftId, socketId) {
    const session = this.sessions.get(versusDraftId);
    if (!session) return null;

    const participant = session.participants.get(socketId);
    if (!participant) return null;

    // Clear role assignment for captains
    if (
      participant.role === "blue_captain" &&
      session.roleAssignments.blue_captain === participant.visitorId
    ) {
      session.roleAssignments.blue_captain = null;
    } else if (
      participant.role === "red_captain" &&
      session.roleAssignments.red_captain === participant.visitorId
    ) {
      session.roleAssignments.red_captain = null;
    }

    session.participants.delete(socketId);

    // Clean up empty sessions from memory (DB records persist for reclaim)
    if (session.participants.size === 0) {
      this.sessions.delete(versusDraftId);
    }

    return participant;
  }

  /**
   * Get all participants in a session (currently connected)
   */
  getParticipants(versusDraftId) {
    const session = this.sessions.get(versusDraftId);
    if (!session) return [];

    return Array.from(session.participants.values()).map((p) => ({
      id: p.participantId,
      versus_draft_id: versusDraftId,
      visitorId: p.visitorId,
      role: p.role,
      socketId: p.socketId,
      isConnected: true,
      lastSeenAt: new Date(p.lastSeenAt).toISOString(),
    }));
  }

  /**
   * Check if a role is available
   */
  isRoleAvailable(versusDraftId, role) {
    const session = this.sessions.get(versusDraftId);
    if (!session) return true;

    if (role === "blue_captain") {
      return session.roleAssignments.blue_captain === null;
    } else if (role === "red_captain") {
      return session.roleAssignments.red_captain === null;
    }

    // Spectators always available
    return true;
  }

  /**
   * Get available roles for a session (based on current connections)
   */
  getAvailableRoles(versusDraftId) {
    return {
      blue_captain: this.isRoleAvailable(versusDraftId, "blue_captain"),
      red_captain: this.isRoleAvailable(versusDraftId, "red_captain"),
      spectator: true,
    };
  }

  /**
   * Update participant's last seen time
   */
  updateLastSeen(versusDraftId, socketId) {
    const session = this.sessions.get(versusDraftId);
    if (!session) return;

    const participant = session.participants.get(socketId);
    if (participant) {
      participant.lastSeenAt = Date.now();
    }
  }

  /**
   * Get participant by socket ID
   */
  getParticipantBySocket(versusDraftId, socketId) {
    const session = this.sessions.get(versusDraftId);
    if (!session) return null;
    return session.participants.get(socketId) || null;
  }
}


module.exports = VersusSessionManager;
