const Draft = require("../models/Draft");
const VersusDraft = require("../models/VersusDraft");
const VersusParticipant = require("../models/VersusParticipant");
const { initializeState, getState } = require("../services/versusStateManager");
const {
  VERSUS_PICK_ORDER,
  getEffectivePickOrder,
  getPicksArrayIndex,
  getCurrentPickIndexFromPicks,
} = require("../utils/versusPickOrder");
const { getRestrictedChampions } = require("../utils/seriesRestrictions");
const crypto = require("crypto");

function uuidv4() {
  return crypto.randomUUID();
}

function setupVersusHandlers(io, socket, versusSessionManager) {
  // Join versus session (initial handshake)
  socket.on("versusJoin", async (data) => {
    try {
      const { linkToken, versusDraftId, storedRole, defaultToSpectator } = data;
      console.log("versusJoin:", {
        linkToken,
        versusDraftId,
        storedRole: storedRole,
        defaultToSpectator,
      });

      let versusDraft;

      // Find versus draft by linkToken or versusDraftId
      if (linkToken) {
        versusDraft = await VersusDraft.findOne({
          where: { shareLink: linkToken },
          include: [
            {
              model: Draft,
              as: "Drafts",
            },
          ],
          order: [[{ model: Draft, as: "Drafts" }, "seriesIndex", "ASC"]],
        });
      } else if (versusDraftId) {
        versusDraft = await VersusDraft.findByPk(versusDraftId, {
          include: [
            {
              model: Draft,
              as: "Drafts",
            },
          ],
          order: [[{ model: Draft, as: "Drafts" }, "seriesIndex", "ASC"]],
        });
      }

      if (!versusDraft) {
        socket.emit("versusJoinResponse", {
          success: false,
          error: "Versus draft not found",
        });
        return;
      }

      // Join the versus draft room
      socket.join(`versus:${versusDraft.id}`);
      console.log(`Socket ${socket.id} joined versus:${versusDraft.id}`);

      // Get current participants from session manager (who's connected now)
      const availableRoles = versusSessionManager.getAvailableRoles(
        versusDraft.id,
      );

      // Attempt to auto-join with stored role if provided
      let myParticipant = null;
      let autoJoinedRole = null;

      if (storedRole && storedRole.reclaimToken) {
        // Query DB for the reclaim token
        const dbParticipant = await VersusParticipant.findOne({
          where: {
            versus_draft_id: versusDraft.id,
            reclaimToken: storedRole.reclaimToken,
          },
        });

        if (dbParticipant) {
          // Verify role matches and role is available (no one connected with it)
          const roleAvailable = versusSessionManager.isRoleAvailable(
            versusDraft.id,
            dbParticipant.role,
          );

          if (roleAvailable) {
            // Successfully reclaimed role - add to memory session
            const visitorId = socket.user?.id || socket.id;
            myParticipant = versusSessionManager.addParticipant(
              versusDraft.id,
              socket,
              visitorId,
              dbParticipant.role,
              dbParticipant.id,
            );
            autoJoinedRole = dbParticipant.role;

            // Update the DB record with new reclaim token and lastSeenAt
            await dbParticipant.update({
              reclaimToken: myParticipant.reclaimToken,
              lastSeenAt: new Date(),
            });

            console.log(`User reclaimed role: ${dbParticipant.role}`);

            // Broadcast participant update to all users in the session
            const updatedParticipants = versusSessionManager.getParticipants(
              versusDraft.id,
            );
            io.to(`versus:${versusDraft.id}`).emit("versusParticipantsUpdate", {
              participants: updatedParticipants,
            });
          } else {
            console.log(
              `Role ${dbParticipant.role} no longer available, reclaim failed`,
            );
          }
        } else {
          console.log("Reclaim token not found in DB");
        }
      }

      // If no stored role but defaultToSpectator is requested, auto-join as spectator
      if (!myParticipant && defaultToSpectator) {
        console.log("No stored role, defaulting to spectator");
        const visitorId = socket.user?.id || socket.id;

        // Add as spectator to memory session
        myParticipant = versusSessionManager.addParticipant(
          versusDraft.id,
          socket,
          visitorId,
          "spectator",
        );
        autoJoinedRole = "spectator";

        // Save spectator to DB
        await VersusParticipant.upsert({
          id: myParticipant.participantId,
          versus_draft_id: versusDraft.id,
          user_id: socket.user?.id || null,
          role: "spectator",
          reclaimToken: myParticipant.reclaimToken,
          lastSeenAt: new Date(),
        });

        // Broadcast participant update
        const updatedParticipants = versusSessionManager.getParticipants(
          versusDraft.id,
        );
        io.to(`versus:${versusDraft.id}`).emit("versusParticipantsUpdate", {
          participants: updatedParticipants,
        });
      }

      console.log("emitting versusJoinResponse");

      const response = {
        success: true,
        versusDraft: versusDraft.toJSON(),
        participants: versusSessionManager.getParticipants(versusDraft.id),
        myParticipant: myParticipant
          ? {
              id: myParticipant.participantId,
              versus_draft_id: versusDraft.id,
              visitorId: myParticipant.visitorId,
              role: myParticipant.role,
              socketId: myParticipant.socketId,
              isConnected: true,
              lastSeenAt: new Date(myParticipant.lastSeenAt).toISOString(),
              reclaimToken: myParticipant.reclaimToken,
            }
          : null,
        availableRoles,
        autoJoinedRole,
      };

      // Send join response
      socket.emit("versusJoinResponse", response);

      console.log("versusJoinResponse emitted to socket", socket.id);
    } catch (error) {
      console.error("Error in versusJoin:", error);
      socket.emit("versusJoinResponse", {
        success: false,
        error: "Failed to join versus session",
      });
    }
  });

  // Select role in versus session
  socket.on("versusSelectRole", async (data) => {
    try {
      const { versusDraftId, role } = data;
      console.log("versusSelectRole:", { versusDraftId, role });

      if (!["blue_captain", "red_captain", "spectator"].includes(role)) {
        socket.emit("versusRoleSelectResponse", {
          success: false,
          error: "Invalid role",
        });
        return;
      }

      // Check if role is available (no one currently connected with this role)
      if (!versusSessionManager.isRoleAvailable(versusDraftId, role)) {
        socket.emit("versusRoleSelectResponse", {
          success: false,
          error: "Role is already taken",
        });
        return;
      }

      const visitorId = socket.user?.id || socket.id;

      // Add participant to memory session
      const participant = versusSessionManager.addParticipant(
        versusDraftId,
        socket,
        visitorId,
        role,
      );

      console.log(`Visitor ${visitorId} selected role: ${role}`);

      // For captain roles, clear old reclaim tokens before saving new one
      // This invalidates any previous claim to this role
      if (role === "blue_captain" || role === "red_captain") {
        await VersusParticipant.update(
          { reclaimToken: null },
          { where: { versus_draft_id: versusDraftId, role: role } },
        );
      }

      // Save participant to DB with reclaim token (works for both auth and anonymous users)
      await VersusParticipant.upsert({
        id: participant.participantId,
        versus_draft_id: versusDraftId,
        user_id: socket.user?.id || null, // null for anonymous users
        role: participant.role,
        reclaimToken: participant.reclaimToken,
        lastSeenAt: new Date(),
      });

      // Broadcast participant update to all users in the session
      const updatedParticipants =
        versusSessionManager.getParticipants(versusDraftId);
      io.to(`versus:${versusDraftId}`).emit("versusParticipantsUpdate", {
        participants: updatedParticipants,
      });

      // Send response to the user who selected the role
      socket.emit("versusRoleSelectResponse", {
        success: true,
        participant: {
          id: participant.participantId,
          versus_draft_id: versusDraftId,
          visitorId: participant.visitorId,
          role: participant.role,
          socketId: participant.socketId,
          isConnected: true,
          lastSeenAt: new Date(participant.lastSeenAt).toISOString(),
        },
        reclaimToken: participant.reclaimToken,
      });
    } catch (error) {
      console.error("Error in versusSelectRole:", error);
      socket.emit("versusRoleSelectResponse", {
        success: false,
        error: "Failed to select role",
      });
    }
  });

  // Leave versus session
  socket.on("versusLeave", async (data) => {
    try {
      const { versusDraftId } = data;
      console.log("versusLeave:", { versusDraftId, socketId: socket.id });

      const participant = versusSessionManager.removeParticipant(
        versusDraftId,
        socket.id,
      );

      if (participant) {
        // Broadcast participant update
        const updatedParticipants =
          versusSessionManager.getParticipants(versusDraftId);
        io.to(`versus:${versusDraftId}`).emit("versusParticipantsUpdate", {
          participants: updatedParticipants,
        });

        console.log(
          `Visitor ${participant.visitorId} left versus:${versusDraftId}`,
        );
      }

      // Leave the room
      socket.leave(`versus:${versusDraftId}`);
    } catch (error) {
      console.error("Error in versusLeave:", error);
    }
  });

  // Release role (switch role flow) - removes role but stays in session
  socket.on("versusReleaseRole", async (data) => {
    try {
      const { versusDraftId } = data;
      console.log("versusReleaseRole:", { versusDraftId, socketId: socket.id });

      const participant = versusSessionManager.removeParticipant(
        versusDraftId,
        socket.id,
      );

      if (participant) {
        // Clear the reclaim token in DB so role can be taken by someone else
        if (participant.participantId) {
          await VersusParticipant.update(
            { reclaimToken: null },
            { where: { id: participant.participantId } },
          );
        }

        // Broadcast participant update
        const updatedParticipants =
          versusSessionManager.getParticipants(versusDraftId);
        io.to(`versus:${versusDraftId}`).emit("versusParticipantsUpdate", {
          participants: updatedParticipants,
        });

        console.log(
          `Visitor ${participant.visitorId} released role ${participant.role} in versus:${versusDraftId}`,
        );
      }

      // Send confirmation to the client
      socket.emit("versusRoleReleased", {
        success: true,
        versusDraftId,
      });
    } catch (error) {
      console.error("Error in versusReleaseRole:", error);
      socket.emit("versusRoleReleased", {
        success: false,
        error: "Failed to release role",
      });
    }
  });

  // Handle disconnect - clean up all versus sessions this socket is in
  socket.on("disconnect", async () => {
    try {
      // Find all sessions this socket is part of
      const sessions = versusSessionManager.sessions;
      for (const [versusDraftId, session] of sessions.entries()) {
        const participant = session.participants.get(socket.id);
        if (participant) {
          versusSessionManager.removeParticipant(versusDraftId, socket.id);
          // Broadcast participant update
          const updatedParticipants =
            versusSessionManager.getParticipants(versusDraftId);
          io.to(`versus:${versusDraftId}`).emit("versusParticipantsUpdate", {
            participants: updatedParticipants,
          });

          console.log(
            `Visitor ${participant.visitorId} disconnected from versus:${versusDraftId}`,
          );
        }
      }
    } catch (error) {
      console.error("Error handling disconnect in versus:", error);
    }
  });

  // Request sync after reconnection
  socket.on("versusRequestSync", async (data) => {
    try {
      const { versusDraftId, storedRole } = data;

      const versusDraft = await VersusDraft.findByPk(versusDraftId, {
        include: [{ model: Draft, as: "Drafts" }],
        order: [[{ model: Draft, as: "Drafts" }, "seriesIndex", "ASC"]],
      });

      if (!versusDraft) {
        return socket.emit("versusError", { error: "Versus draft not found" });
      }

      // Rejoin the versus room (lost on disconnect)
      socket.join(`versus:${versusDraftId}`);

      let myParticipant = null;

      // Attempt to re-register participant with stored role
      if (storedRole && storedRole.reclaimToken) {
        const dbParticipant = await VersusParticipant.findOne({
          where: {
            versus_draft_id: versusDraftId,
            reclaimToken: storedRole.reclaimToken,
          },
        });

        if (dbParticipant) {
          const roleAvailable = versusSessionManager.isRoleAvailable(
            versusDraftId,
            dbParticipant.role
          );

          if (roleAvailable) {
            const visitorId = socket.user?.id || socket.id;
            myParticipant = versusSessionManager.addParticipant(
              versusDraftId,
              socket,
              visitorId,
              dbParticipant.role,
              dbParticipant.id
            );

            // Update DB record with new reclaim token
            await dbParticipant.update({
              reclaimToken: myParticipant.reclaimToken,
              lastSeenAt: new Date(),
            });

            console.log(
              `User reclaimed role on reconnect: ${dbParticipant.role}`
            );
          }
        }
      }

      const participants = versusSessionManager.getParticipants(versusDraftId);

      // If we didn't re-register, check if already registered (shouldn't happen but be safe)
      if (!myParticipant) {
        const existing = versusSessionManager.getParticipantBySocket(
          versusDraftId,
          socket.id
        );
        if (existing) {
          myParticipant = existing;
        }
      }

      socket.emit("versusSyncResponse", {
        versusDraft: versusDraft.toJSON(),
        participants,
        myParticipant: myParticipant
          ? {
              id: myParticipant.participantId,
              versus_draft_id: versusDraftId,
              visitorId: myParticipant.visitorId,
              role: myParticipant.role,
              socketId: myParticipant.socketId,
              isConnected: true,
              lastSeenAt: new Date(myParticipant.lastSeenAt).toISOString(),
              reclaimToken: myParticipant.reclaimToken,
            }
          : null,
      });

      // Broadcast updated participants to everyone
      io.to(`versus:${versusDraftId}`).emit("versusParticipantsUpdate", {
        participants,
      });
    } catch (error) {
      console.error("Error in versusRequestSync:", error);
      socket.emit("versusError", { error: "Failed to sync versus session" });
    }
  });

  // Join versus draft room (for draft view)
  socket.on("joinVersusDraft", async (data) => {
    try {
      const { versusDraftId, draftId, role, participantId } = data;

      // Join rooms
      socket.join(`versus:${versusDraftId}`);
      socket.join(`draft:${draftId}`);

      console.log(
        `${socket.id} joined versus:${versusDraftId} and draft:${draftId} as ${role}`,
      );

      // Update participant's last seen
      versusSessionManager.updateLastSeen(versusDraftId, socket.id);

      // Initialize or get draft state
      const draft = await Draft.findByPk(draftId);
      if (draft) {
        const state = initializeState(draftId, draft.picks, draft.firstPick);

        // Send current state to joining client
        socket.emit("draftStateSync", {
          draftId,
          picks: draft.picks,
          currentPickIndex: state.currentPickIndex,
          timerStartedAt: state.timerStartedAt,
          isPaused: state.isPaused,
          pauseRequestedBy: state.pauseRequestedBy,
          resumeRequestedBy: state.resumeRequestedBy,
          isCountingDown: state.isCountingDown,
          countdownStartedAt: state.countdownStartedAt,
          readyStatus: state.readyStatus,
          completed: draft.completed,
          winner: draft.winner,
          firstPick: draft.firstPick,
          blueSideTeam: draft.blueSideTeam,
        });
      }
    } catch (error) {
      console.error("Error joining versus draft:", error);
      socket.emit("error", { message: "Failed to join versus draft" });
    }
  });

  // Set game settings (first pick, side assignment)
  socket.on("versusSetGameSettings", async (data) => {
    try {
      const { versusDraftId, draftId, firstPick, blueSideTeam } = data;

      // Get participant info
      const participant = versusSessionManager.getParticipantBySocket(
        versusDraftId,
        socket.id
      );

      const isCaptain =
        participant?.role === "blue_captain" ||
        participant?.role === "red_captain";

      // Load versus draft for owner check
      const versusDraft = await VersusDraft.findByPk(versusDraftId);
      if (!versusDraft) {
        return socket.emit("error", { message: "Versus draft not found" });
      }

      const isOwner = socket.user?.id === versusDraft.owner_id;

      if (!isCaptain && !isOwner) {
        return socket.emit("error", {
          message: "Only captains and owner can change game settings",
        });
      }

      const draft = await Draft.findByPk(draftId);
      if (!draft) {
        return socket.emit("error", { message: "Draft not found" });
      }

      // Don't allow changes after draft has started
      const state = getState(draftId);
      if (state && state.timerStartedAt !== null && state.currentPickIndex > 0) {
        return socket.emit("error", {
          message: "Cannot change settings after draft has started",
        });
      }

      // Update fields
      if (firstPick !== undefined && ["blue", "red"].includes(firstPick)) {
        draft.firstPick = firstPick;
        if (state) {
          state.firstPick = firstPick;
        }
      }
      if (blueSideTeam !== undefined && [1, 2].includes(blueSideTeam)) {
        draft.blueSideTeam = blueSideTeam;
      }

      await draft.save();

      // Broadcast to draft room
      io.to(`draft:${draftId}`).emit("gameSettingsUpdate", {
        draftId,
        firstPick: draft.firstPick,
        blueSideTeam: draft.blueSideTeam,
      });

      // Also broadcast to versus room so series overview updates
      const updatedVersusDraft = await VersusDraft.findByPk(versusDraftId, {
        include: [{ model: Draft, as: "Drafts" }],
        order: [[{ model: Draft, as: "Drafts" }, "seriesIndex", "ASC"]],
      });
      if (updatedVersusDraft) {
        io.to(`versus:${versusDraftId}`).emit("versusSeriesUpdate", {
          versusDraft: updatedVersusDraft.toJSON(),
        });
      }
    } catch (error) {
      console.error("Error setting game settings:", error);
      socket.emit("error", { message: "Failed to update game settings" });
    }
  });

  // Captain ready
  socket.on("captainReady", async (data) => {
    try {
      const { draftId, role } = data;
      const state = getState(draftId);
      if (!state) {
        return socket.emit("error", { message: "Draft state not found" });
      }

      if (role && role.includes("captain")) {
        const team = role.includes("blue") ? "blue" : "red";
        state.readyStatus[team] = true;
        // Broadcast ready update
        io.to(`draft:${draftId}`).emit("readyUpdate", {
          draftId,
          blueReady: state.readyStatus.blue,
          redReady: state.readyStatus.red,
        });

        // If both ready, start draft
        if (state.readyStatus.blue && state.readyStatus.red) {
          state.timerStartedAt = Date.now();
          state.currentPickIndex = 0;

          io.to(`draft:${draftId}`).emit("draftStarted", {
            draftId,
            timerStartedAt: state.timerStartedAt,
            currentPickIndex: state.currentPickIndex,
            firstPick: state.firstPick || "blue",
          });
        }
      }
    } catch (error) {
      console.error("Error handling captain ready:", error);
      socket.emit("error", { message: "Failed to process ready status" });
    }
  });

  // Captain unready
  socket.on("captainUnready", async (data) => {
    try {
      const { draftId, role } = data;
      const state = getState(draftId);
      if (!state) {
        return socket.emit("error", { message: "Draft state not found" });
      }

      // Only allow unready before draft has started
      if (state.timerStartedAt !== null && state.currentPickIndex > 0) {
        return socket.emit("error", {
          message: "Cannot unready after draft has started",
        });
      }

      if (role && role.includes("captain")) {
        const team = role.includes("blue") ? "blue" : "red";
        state.readyStatus[team] = false;
        io.to(`draft:${draftId}`).emit("readyUpdate", {
          draftId,
          blueReady: state.readyStatus.blue,
          redReady: state.readyStatus.red,
        });
      }
    } catch (error) {
      console.error("Error handling captain unready:", error);
      socket.emit("error", { message: "Failed to process unready status" });
    }
  });

  // Lock in pick (manual)
  socket.on("lockInPick", async (data) => {
    try {
      const { draftId, role } = data;
      if (role && role.includes("captain")) {
        const team = role.includes("blue") ? "blue" : "red";
        await processPickLock(io, draftId, team);
      }
    } catch (error) {
      console.error("Error locking in pick:", error);
      socket.emit("error", { message: "Failed to lock in pick" });
    }
  });

  // Versus pick (saves pending pick without advancing)
  socket.on("versusPick", async (data) => {
    try {
      const { draftId, champion, role } = data;

      const state = getState(draftId);
      if (!state) {
        return socket.emit("error", { message: "Draft state not found" });
      }

      if (!role || !role.includes("captain")) {
        return socket.emit("error", { message: "Invalid role" });
      }

      const team = role.includes("blue") ? "blue" : "red";

      // Validate draft is not complete
      const effectiveOrder = getEffectivePickOrder(state.firstPick || "blue");
      if (state.currentPickIndex >= effectiveOrder.length) {
        return socket.emit("error", { message: "Draft is complete" });
      }

      // Validate it's this team's turn
      const currentPick = effectiveOrder[state.currentPickIndex];
      if (currentPick.team !== team) {
        return socket.emit("error", { message: "Not your turn" });
      }

      // Validate not paused
      if (state.isPaused) {
        return socket.emit("error", { message: "Draft is paused" });
      }

      // Get draft and validate champion not already picked
      const draft = await Draft.findByPk(draftId);
      if (!draft) {
        return socket.emit("error", { message: "Draft not found" });
      }

      // Check if champion is already picked (excluding current pending slot)
      const picksIndex = getPicksArrayIndex(state.currentPickIndex, state.firstPick || "blue");
      const picksWithoutCurrent = draft.picks.filter(
        (_, idx) => idx !== picksIndex,
      );
      if (picksWithoutCurrent.includes(champion)) {
        return socket.emit("error", {
          message: "Champion already picked/banned",
        });
      }

      // Check series restrictions (Fearless/Ironman modes)
      if (draft.versus_draft_id) {
        const versusDraft = await VersusDraft.findByPk(draft.versus_draft_id, {
          include: [{ model: Draft, as: "Drafts" }],
        });

        if (versusDraft) {
          const restrictedChampions = getRestrictedChampions(
            versusDraft.type,
            versusDraft.Drafts,
            draft.seriesIndex
          );

          if (restrictedChampions.includes(champion)) {
            return socket.emit("error", {
              message: "Champion restricted from previous games in this series",
            });
          }
        }
      }

      // Save the pending pick (do NOT advance currentPickIndex)
      const updatedPicks = [...draft.picks];
      updatedPicks[picksIndex] = champion;

      draft.picks = updatedPicks;
      await draft.save();

      // Broadcast update (currentPickIndex stays the same)
      io.to(`draft:${draftId}`).emit("draftUpdate", {
        draftId,
        picks: updatedPicks,
        currentPickIndex: state.currentPickIndex,
        timerStartedAt: state.timerStartedAt,
        isPaused: state.isPaused,
        completed: draft.completed,
      });
    } catch (error) {
      console.error("Error processing versus pick:", error);
      socket.emit("error", { message: "Failed to process pick" });
    }
  });

  // Request pause
  socket.on("requestPause", async (data) => {
    try {
      const { draftId, role } = data;

      if (!role || !role.includes("captain")) {
        return socket.emit("error", { message: "Invalid role" });
      }

      const team = role.includes("blue") ? "blue" : "red";

      const draft = await Draft.findByPk(draftId);
      if (!draft) {
        return socket.emit("error", { message: "Draft not found" });
      }

      const versusDraft = await VersusDraft.findByPk(draft.versus_draft_id);
      const state = getState(draftId);

      if (!state) {
        return socket.emit("error", { message: "Draft state not found" });
      }

      // Scrim mode: immediate pause/resume
      if (!versusDraft.competitive) {
        const PICK_TIMER_DURATION = 30000; // 30 seconds in ms

        if (!state.isPaused) {
          // Pausing: calculate and store remaining time
          if (state.timerStartedAt) {
            const elapsed = Date.now() - state.timerStartedAt;
            state.pausedTimeRemaining = Math.max(
              0,
              PICK_TIMER_DURATION - elapsed,
            );
          }
          state.isPaused = true;
        } else {
          // Resuming: restore timer with remaining time
          if (state.pausedTimeRemaining !== null) {
            // Set timerStartedAt such that elapsed time = (30000 - pausedTimeRemaining)
            state.timerStartedAt =
              Date.now() - (PICK_TIMER_DURATION - state.pausedTimeRemaining);
          } else {
            // Fallback: start fresh
            state.timerStartedAt = Date.now();
          }
          state.isPaused = false;
          state.pausedTimeRemaining = null;
        }

        io.to(`draft:${draftId}`).emit("draftUpdate", {
          draftId,
          picks: draft.picks,
          currentPickIndex: state.currentPickIndex,
          timerStartedAt: state.timerStartedAt,
          isPaused: state.isPaused,
          completed: draft.completed,
        });
      } else {
        // Competitive mode: request approval for both pause and resume

        if (!state.isPaused) {
          // Requesting pause
          state.pauseRequestedBy = team;

          io.to(`draft:${draftId}`).emit("pauseRequested", {
            draftId,
            team,
          });
        } else {
          // Requesting resume - also requires approval
          state.resumeRequestedBy = team;

          io.to(`draft:${draftId}`).emit("resumeRequested", {
            draftId,
            team,
          });
        }
      }
    } catch (error) {
      console.error("Error requesting pause:", error);
      socket.emit("error", { message: "Failed to request pause" });
    }
  });

  // Approve pause
  socket.on("approvePause", async (data) => {
    try {
      const { draftId, role } = data;

      if (!role || !role.includes("captain")) {
        return socket.emit("error", { message: "Invalid role" });
      }

      const team = role.includes("blue") ? "blue" : "red";

      const state = getState(draftId);
      if (!state) {
        return socket.emit("error", { message: "Draft state not found" });
      }

      // Validate it's the opposite team approving
      if (state.pauseRequestedBy === team) {
        return socket.emit("error", {
          message: "Cannot approve your own pause request",
        });
      }

      const draft = await Draft.findByPk(draftId);
      const PICK_TIMER_DURATION = 30000; // 30 seconds in ms

      // Calculate and store remaining time
      if (state.timerStartedAt) {
        const elapsed = Date.now() - state.timerStartedAt;
        state.pausedTimeRemaining = Math.max(0, PICK_TIMER_DURATION - elapsed);
      }

      state.isPaused = true;
      state.pauseRequestedBy = null;

      io.to(`draft:${draftId}`).emit("draftUpdate", {
        draftId,
        picks: draft.picks,
        currentPickIndex: state.currentPickIndex,
        timerStartedAt: state.timerStartedAt,
        isPaused: state.isPaused,
        completed: draft.completed,
      });
    } catch (error) {
      console.error("Error approving pause:", error);
      socket.emit("error", { message: "Failed to approve pause" });
    }
  });

  // Approve resume
  socket.on("approveResume", async (data) => {
    try {
      const { draftId, role } = data;

      if (!role || !role.includes("captain")) {
        return socket.emit("error", { message: "Invalid role" });
      }

      const team = role.includes("blue") ? "blue" : "red";

      const state = getState(draftId);
      if (!state) {
        return socket.emit("error", { message: "Draft state not found" });
      }

      // Validate it's the opposite team approving
      if (state.resumeRequestedBy === team) {
        return socket.emit("error", {
          message: "Cannot approve your own resume request",
        });
      }

      const draft = await Draft.findByPk(draftId);
      const PICK_TIMER_DURATION = 30000; // 30 seconds in ms

      // Clear resume request
      state.resumeRequestedBy = null;
      state.isCountingDown = true;
      state.countdownStartedAt = Date.now();

      // Start 3-second countdown
      io.to(`draft:${draftId}`).emit("resumeCountdownStarted", {
        draftId,
        countdownStartedAt: state.countdownStartedAt,
      });

      // Resume after 3 seconds
      setTimeout(() => {
        const currentState = getState(draftId);
        if (!currentState || !currentState.isCountingDown) return;

        // Restore timer with remaining time
        if (currentState.pausedTimeRemaining !== null) {
          currentState.timerStartedAt =
            Date.now() -
            (PICK_TIMER_DURATION - currentState.pausedTimeRemaining);
        } else {
          currentState.timerStartedAt = Date.now();
        }

        currentState.isPaused = false;
        currentState.pausedTimeRemaining = null;
        currentState.isCountingDown = false;
        currentState.countdownStartedAt = null;

        io.to(`draft:${draftId}`).emit("draftUpdate", {
          draftId,
          picks: draft.picks,
          currentPickIndex: currentState.currentPickIndex,
          timerStartedAt: currentState.timerStartedAt,
          isPaused: currentState.isPaused,
          completed: draft.completed,
        });
      }, 3000);
    } catch (error) {
      console.error("Error approving resume:", error);
      socket.emit("error", { message: "Failed to approve resume" });
    }
  });

  // Reject resume
  socket.on("rejectResume", async (data) => {
    try {
      const { draftId, role } = data;

      if (!role || !role.includes("captain")) {
        return socket.emit("error", { message: "Invalid role" });
      }

      const team = role.includes("blue") ? "blue" : "red";

      const state = getState(draftId);
      if (!state) {
        return socket.emit("error", { message: "Draft state not found" });
      }

      // Validate it's the opposite team rejecting
      if (state.resumeRequestedBy === team) {
        return socket.emit("error", {
          message: "Cannot reject your own resume request",
        });
      }

      // Clear resume request
      state.resumeRequestedBy = null;

      // Notify that resume was rejected
      io.to(`draft:${draftId}`).emit("resumeRejected", {
        draftId,
      });
    } catch (error) {
      console.error("Error rejecting resume:", error);
      socket.emit("error", { message: "Failed to reject resume" });
    }
  });

  // Request pick change
  socket.on("requestPickChange", async (data) => {
    try {
      const { draftId, pickIndex, newChampion, role } = data;

      if (!role || !role.includes("captain")) {
        return socket.emit("error", { message: "Invalid role" });
      }

      const team = role.includes("blue") ? "blue" : "red";

      const draft = await Draft.findByPk(draftId);
      if (!draft) {
        return socket.emit("error", { message: "Draft not found" });
      }

      if (!draft.completed) {
        return socket.emit("error", {
          message: "Can only change picks after draft is complete",
        });
      }

      const versusDraft = await VersusDraft.findByPk(draft.versus_draft_id);
      const state = getState(draftId);

      if (!state) {
        return socket.emit("error", { message: "Draft state not found" });
      }

      const oldChampion = draft.picks[pickIndex];

      // Scrim mode: immediate change
      if (!versusDraft.competitive) {
        const updatedPicks = [...draft.picks];
        updatedPicks[pickIndex] = newChampion;
        draft.picks = updatedPicks;
        await draft.save();

        io.to(`draft:${draftId}`).emit("draftUpdate", {
          draftId,
          picks: updatedPicks,
          currentPickIndex: state.currentPickIndex,
          timerStartedAt: state.timerStartedAt,
          isPaused: state.isPaused,
          completed: draft.completed,
        });
      } else {
        // Competitive mode: request approval
        const requestId = uuidv4();

        state.pickChangeRequests.push({
          requestId,
          team,
          pickIndex,
          oldChampion,
          newChampion,
          status: "pending",
        });

        io.to(`draft:${draftId}`).emit("pickChangeRequested", {
          requestId,
          draftId,
          team,
          pickIndex,
          oldChampion,
          newChampion,
        });
      }
    } catch (error) {
      console.error("Error requesting pick change:", error);
      socket.emit("error", { message: "Failed to request pick change" });
    }
  });

  // Respond to pick change request
  socket.on("respondPickChange", async (data) => {
    try {
      const { draftId, requestId, approved, role } = data;

      if (!role || !role.includes("captain")) {
        return socket.emit("error", { message: "Invalid role" });
      }

      const team = role.includes("blue") ? "blue" : "red";

      const state = getState(draftId);
      if (!state) {
        return socket.emit("error", { message: "Draft state not found" });
      }

      const request = state.pickChangeRequests.find(
        (r) => r.requestId === requestId,
      );

      if (!request) {
        return socket.emit("error", { message: "Request not found" });
      }

      if (request.team === team) {
        return socket.emit("error", {
          message: "Cannot approve your own request",
        });
      }

      const draft = await Draft.findByPk(draftId);

      if (approved) {
        const updatedPicks = [...draft.picks];
        updatedPicks[request.pickIndex] = request.newChampion;
        draft.picks = updatedPicks;
        await draft.save();

        request.status = "approved";

        io.to(`draft:${draftId}`).emit("draftUpdate", {
          draftId,
          picks: updatedPicks,
          currentPickIndex: state.currentPickIndex,
          timerStartedAt: state.timerStartedAt,
          isPaused: state.isPaused,
          completed: draft.completed,
        });

        io.to(`draft:${draftId}`).emit("pickChangeApproved", {
          requestId,
        });
      } else {
        request.status = "rejected";

        io.to(`draft:${draftId}`).emit("pickChangeRejected", {
          requestId,
        });
      }
    } catch (error) {
      console.error("Error responding to pick change:", error);
      socket.emit("error", { message: "Failed to respond to pick change" });
    }
  });

  // Send versus message (chat)
  socket.on("sendVersusMessage", async (data) => {
    try {
      const { versusDraftId, message, role, username } = data;
      console.log("sendVersusMessage:", data);
      io.to(`versus:${versusDraftId}`).emit("newVersusMessage", {
        username: username || socket.user?.name || socket.id,
        role,
        message,
        timestamp: Date.now(),
      });
    } catch (error) {
      console.error("Error sending versus message:", error);
    }
  });

  // Report winner for a draft
  socket.on("versusReportWinner", async (data) => {
    try {
      const { versusDraftId, draftId, winner } = data;

      if (!["blue", "red"].includes(winner)) {
        return socket.emit("versusError", { error: "Invalid winner value" });
      }

      const draft = await Draft.findByPk(draftId);
      if (!draft) {
        return socket.emit("versusError", { error: "Draft not found" });
      }

      if (!draft.completed) {
        return socket.emit("versusError", { error: "Draft is not completed" });
      }

      const versusDraft = await VersusDraft.findByPk(versusDraftId, {
        include: [{ model: Draft, as: "Drafts" }],
        order: [[{ model: Draft, as: "Drafts" }, "seriesIndex", "ASC"]],
      });

      if (!versusDraft) {
        return socket.emit("versusError", { error: "Versus draft not found" });
      }

      // Get participant info for this socket
      const participant = versusSessionManager.getParticipantBySocket(
        versusDraftId,
        socket.id
      );

      const isCaptain =
        participant?.role === "blue_captain" ||
        participant?.role === "red_captain";
      const isOwner = socket.user?.id === versusDraft.owner_id;

      // Determine if this is the "current" game (latest completed, no newer completed drafts)
      const drafts = versusDraft.Drafts || [];
      const draftIndex = drafts.findIndex((d) => d.id === draftId);
      const hasNewerCompletedDraft = drafts
        .slice(draftIndex + 1)
        .some((d) => d.completed);

      // Permission check: current game = captains, past games = owner only
      const canReport = hasNewerCompletedDraft ? isOwner : isCaptain || isOwner;

      if (!canReport) {
        return socket.emit("versusError", {
          error: "You don't have permission to report the winner",
        });
      }

      // Update the draft winner
      await draft.update({ winner });

      // Update parent VersusDraft so it appears in recent activity
      versusDraft.changed("updatedAt", true);
      await versusDraft.save();

      // Broadcast to all participants
      io.to(`versus:${versusDraftId}`).emit("versusWinnerUpdate", {
        draftId,
        winner,
      });
    } catch (error) {
      console.error("Error reporting winner:", error);
      socket.emit("versusError", { error: "Failed to report winner" });
    }
  });
}

// Helper function to process pick lock (used by timer and manual lock-in)
async function processPickLock(io, draftId, team) {
  const state = getState(draftId);
  if (!state) {
    console.log(`processPickLock: No state found for draft ${draftId}`);
    return;
  }

  const draft = await Draft.findByPk(draftId);
  if (!draft || draft.completed) {
    console.log(`processPickLock: Draft not found or completed`);
    return;
  }

  // Advance to next pick
  state.currentPickIndex++;
  state.timerStartedAt = Date.now();

  if (state.currentPickIndex >= 20) {
    draft.completed = true;
    state.timerStartedAt = null;
    await draft.save();

    // Also broadcast to versus room so series overview updates
    if (draft.versus_draft_id) {
      // Update parent VersusDraft so it appears in recent activity
      const versusDraft = await VersusDraft.findByPk(draft.versus_draft_id);
      if (versusDraft) {
        versusDraft.changed("updatedAt", true);
        await versusDraft.save();
      }

      io.to(`versus:${draft.versus_draft_id}`).emit("versusDraftStatusUpdate", {
        draftId,
        completed: true,
      });
    }
  }

  // Broadcast update
  io.to(`draft:${draftId}`).emit("draftUpdate", {
    draftId,
    picks: draft.picks,
    currentPickIndex: state.currentPickIndex,
    timerStartedAt: state.timerStartedAt,
    isPaused: state.isPaused,
    completed: draft.completed,
    firstPick: state.firstPick || "blue",
  });
}

module.exports = { setupVersusHandlers, processPickLock };
