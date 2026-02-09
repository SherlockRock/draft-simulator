const express = require("express");
const cookieParser = require("cookie-parser");
const sequelize = require("./config/database");
const jwt = require("jsonwebtoken");
const https = require("https");
const http = require("http");
const { readFile } = require("node:fs/promises");
const { Server } = require("socket.io");
const cors = require("cors");
const draftRoutes = require("./routes/drafts");
const userRoutes = require("./routes/users");
const shareRoutes = require("./routes/shares");
const authRoutes = require("./routes/auth");
const canvasRoutes = require("./routes/canvas");
const activityRoutes = require("./routes/activity");
const versusRoutes = require("./routes/versus");
const Draft = require("./models/Draft");
const User = require("./models/User");
const setupAssociations = require("./models/associations");
const socketService = require("./middleware/socketService");
const { UserCanvas, CanvasDraft } = require("./models/Canvas");
const { setupVersusHandlers } = require("./socketHandlers/versusHandlers");
const { initializeTimerService } = require("./services/versusTimerService");
const HeartbeatManager = require("./services/heartbeatManager");
const VersusSessionManager = require("./services/versusSessionManager");
require("dotenv").config();

async function main() {
  (async () => {
    try {
      await sequelize.authenticate();
      setupAssociations(sequelize);
      await sequelize.sync({ alter: true }); // Sync all defined models to the database
    } catch (error) {
      console.error("Unable to connect to the database:", error);
    }
  })();

  const app = express();
  app.use(
    cors({
      origin: process.env.FRONTEND_ORIGIN,
      credentials: true,
    }),
  );

  /**
   * To use OAuth2 authentication, we need access to a CLIENT_ID, CLIENT_SECRET, AND REDIRECT_URI
   * from the client_secret.json file. To get these credentials for your application, visit
   * https://console.cloud.google.com/apis/credentials.
   */
  const JWT_SECRET = process.env.JWT_SECRET;

  app.set("trust proxy", 1);

  app.use(cookieParser());
  app.use(express.json());

  app.get("/", (req, res) => res.send("OK"));

  app.use("/api/auth", authRoutes);
  app.use("/api/drafts", draftRoutes);
  app.use("/api/users", userRoutes);
  app.use("/api/shares", shareRoutes);
  app.use("/api/canvas", canvasRoutes);
  app.use("/api/activity", activityRoutes);
  app.use("/api/versus-drafts", versusRoutes);

  let server;
  if (process.env.ENVIRONMENT === "development") {
    const key = await readFile("./localhost+2-key.pem");
    const cert = await readFile("./localhost+2.pem");
    server = https.createServer({ key, cert }, app);
  } else {
    server = http.createServer(app);
  }
  const io = new Server(server, {
    connectionStateRecovery: {},
    cors: {
      origin: process.env.FRONTEND_ORIGIN,
      methods: ["GET", "POST"],
      credentials: true,
    },
    pingInterval: 25000, // Send a ping every 25 seconds
    pingTimeout: 5000, // If no pong received within 5 seconds, consider the connection dead
  });

  socketService.init(io);

  // Initialize versus timer service
  initializeTimerService(io);
  const heartbeatManager = new HeartbeatManager(io);
  const versusSessionManager = new VersusSessionManager(heartbeatManager);

  io.use(async (socket, next) => {
    const handshake = socket.handshake;
    const cookieHeader = handshake.headers.cookie;

    if (cookieHeader) {
      try {
        const token = cookieHeader
          .split("; ")
          .find((c) => c.startsWith("accessToken="));
        if (token) {
          const decoded = jwt.verify(
            token.replace(/^accessToken=/, ""),
            JWT_SECRET,
          );
          const loggedInUser = await User.findOne({
            where: { id: decoded.id },
          });

          if (loggedInUser) {
            socket.user = loggedInUser;
            return next();
          }
        }
      } catch (err) {
        console.error("Error authenticating Socket.IO connection:", err);
        return next(new Error("Authentication error"));
      }
    }
    console.log("No valid token found in cookies");
    next();
  });

  io.on("connection", (socket) => {
    console.log(`New client connected: ${socket.id}`);

    // Set up versus-specific handlers
    setupVersusHandlers(io, socket, versusSessionManager);
    heartbeatManager.registerClient(socket, socket.id);

    socket.on("newDraft", async (data) => {
      try {
        if ("id" in data && data.picks.length === 20) {
          // Find all canvases containing this draft
          const canvasDrafts = await CanvasDraft.findAll({
            where: { draft_id: data.id },
            attributes: ["canvas_id", "is_locked"],
          });

          if (canvasDrafts.length > 0) {
            // Canvas draft: require sign-in and edit/admin on at least one canvas
            if (!socket.user) {
              return;
            }
            let hasPermission = false;
            for (const cd of canvasDrafts) {
              const userCanvas = await UserCanvas.findOne({
                where: {
                  canvas_id: cd.canvas_id,
                  user_id: socket.user.dataValues.id,
                },
              });
              if (
                userCanvas &&
                (userCanvas.permissions === "edit" ||
                  userCanvas.permissions === "admin")
              ) {
                hasPermission = true;
                break;
              }
            }
            if (!hasPermission) {
              return;
            }
            // Check if draft is locked in any canvas
            const isLocked = canvasDrafts.some(cd => cd.is_locked);
            if (isLocked) {
              return;
            }
          } else {
            // Standalone draft: require sign-in and ownership
            if (!socket.user) {
              return;
            }
            const draft = await Draft.findByPk(data.id);
            if (!draft || socket.user.dataValues.id !== draft.owner_id) {
              return;
            }
          }

          await Draft.update({ picks: data.picks }, { where: { id: data.id } });

          // Multi-context broadcast: send to draft room
          io.to(data.id).emit("draftUpdate", data, data.id);

          // Broadcast to each canvas room
          for (const cd of canvasDrafts) {
            io.to(cd.canvas_id).emit("draftUpdate", data, data.id);
          }
        }
      } catch (e) {
        console.log(e);
        // TODO handle the failure
        return;
      }
    });

    socket.on("joinRoom", async (room) => {
      socket.join(room);
      console.log(`${socket.id} joined room: ${room}`);
      const roomSize = await socketService.getRoomSize(room);
      io.to(room).emit("userCountUpdate", roomSize);
    });

    socket.on("leaveRoom", async (room) => {
      socket.leave(room);
      console.log(`${socket.id} left room: ${room}`);
      const roomSize = await socketService.getRoomSize(room);
      io.to(room).emit("userCountUpdate", roomSize);
    });

    socket.on("canvasObjectMove", async (data) => {
      if (!socket.user) return;
      const userCanvas = await UserCanvas.findOne({
        where: { canvas_id: data.canvasId, user_id: socket.user.dataValues.id },
      });
      if (
        userCanvas &&
        (userCanvas.permissions === "edit" ||
          userCanvas.permissions === "admin")
      ) {
        io.to(data.canvasId).emit(
          "canvasObjectMoved",
          {
            draftId: data.draftId,
            positionX: data.positionX,
            positionY: data.positionY,
          },
          data.canvasId,
        );
      }
    });

    socket.on("vertexMove", async (data) => {
      if (!socket.user) return;
      const userCanvas = await UserCanvas.findOne({
        where: { canvas_id: data.canvasId, user_id: socket.user.dataValues.id },
      });
      if (
        userCanvas &&
        (userCanvas.permissions === "edit" ||
          userCanvas.permissions === "admin")
      ) {
        io.to(data.canvasId).emit("vertexMoved", {
          connectionId: data.connectionId,
          vertexId: data.vertexId,
          x: data.x,
          y: data.y,
        });
      }
    });

    socket.on("groupMove", async (data) => {
      if (!socket.user) return;
      const userCanvas = await UserCanvas.findOne({
        where: { canvas_id: data.canvasId, user_id: socket.user.dataValues.id },
      });
      if (
        userCanvas &&
        (userCanvas.permissions === "edit" ||
          userCanvas.permissions === "admin")
      ) {
        socket.to(data.canvasId).emit("groupMoved", {
          groupId: data.groupId,
          positionX: data.positionX,
          positionY: data.positionY,
        });
      }
    });

    socket.on("groupResize", async (data) => {
      if (!socket.user) return;
      const userCanvas = await UserCanvas.findOne({
        where: { canvas_id: data.canvasId, user_id: socket.user.dataValues.id },
      });
      if (
        userCanvas &&
        (userCanvas.permissions === "edit" ||
          userCanvas.permissions === "admin")
      ) {
        socket.to(data.canvasId).emit("groupResized", {
          groupId: data.groupId,
          width: data.width,
          height: data.height,
        });
      }
    });

    socket.on("disconnecting", () => {
      for (const room of socket.rooms) {
        if (room !== socket.id) {
          const roomSize = io.sockets.adapter.rooms.get(room).size;
          io.to(room).emit("userCountUpdate", roomSize - 1);
        }
      }
    });

    socket.on("disconnect", () => {
      console.log(`Client disconnected: ${socket.id}`);
    });
  });

  const PORT = process.env.PORT || 5000;
  server.listen(PORT, () => {
    console.log(`server running on PORT ${PORT}`);
  });
}

main().catch(console.error);
