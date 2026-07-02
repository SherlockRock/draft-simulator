const { CanvasMutationError } = require("../services/canvasMutations");

function getSocketActor(socket) {
  return {
    userId: socket.user?.dataValues?.id ?? socket.user?.id ?? null,
    socketId: socket.id,
  };
}

// Thin socket adapters over the Canvas Mutation Gate: build the actor, map
// the wire payload onto a gate call, and translate typed gate errors into a
// canvasMutationError event. All authorization, validation, persistence and
// broadcasting lives in the gate.
function setupCanvasHandlers(io, socket, gate, wrapSocketHandler) {
  const handle = (event, run) => {
    wrapSocketHandler(socket, event, async (data) => {
      try {
        await run(data || {}, getSocketActor(socket));
      } catch (err) {
        if (err instanceof CanvasMutationError) {
          socket.emit("canvasMutationError", {
            event,
            code: err.code,
            message: err.message,
          });
        } else {
          console.error(`Unexpected error in ${event} handler:`, err);
        }
      }
    });
  };

  handle("newDraft", (data, actor) =>
    gate.applyDraftPicks({ actor, draftId: data.id, picks: data.picks }),
  );

  handle("canvasObjectMove", (data, actor) =>
    gate.relayObjectMove({
      actor,
      canvasId: data.canvasId,
      draftId: data.draftId,
      positionX: data.positionX,
      positionY: data.positionY,
    }),
  );

  handle("vertexMove", (data, actor) =>
    gate.relayVertexMove({
      actor,
      canvasId: data.canvasId,
      connectionId: data.connectionId,
      vertexId: data.vertexId,
      x: data.x,
      y: data.y,
    }),
  );

  handle("groupMove", (data, actor) =>
    gate.relayGroupMove({
      actor,
      canvasId: data.canvasId,
      groupId: data.groupId,
      positionX: data.positionX,
      positionY: data.positionY,
    }),
  );

  handle("groupResize", (data, actor) =>
    gate.relayGroupResize({
      actor,
      canvasId: data.canvasId,
      groupId: data.groupId,
      width: data.width,
      height: data.height,
      positionX: data.positionX,
    }),
  );
}

module.exports = { setupCanvasHandlers };
