const express = require("express");
const cookieParser = require("cookie-parser");
const sequelize = require("./config/database");
const jwt = require("jsonwebtoken");
const https = require("https");
const http = require("http");
const { readFile } = require("node:fs/promises");
const { existsSync } = require("node:fs");
const path = require("path");
const os = require("os");
const { Server } = require("socket.io");
const cors = require("cors");
const draftRoutes = require("./routes/drafts");
const userRoutes = require("./routes/users");
const shareRoutes = require("./routes/shares");
const authRoutes = require("./routes/auth");
const canvasRoutes = require("./routes/canvas");
const activityRoutes = require("./routes/activity");
const versusRoutes = require("./routes/versus");
const navigatorRoutes = require("./routes/navigator");
const savedPoolsRoutes = require("./routes/savedPools");
const { router: scoutingRouter } = require("./routes/scouting");
const User = require("./models/User");
const Draft = require("./models/Draft");
const setupAssociations = require("./models/associations");
const socketService = require("./middleware/socketService");
const { setupVersusHandlers } = require("./socketHandlers/versusHandlers");
const { setupNavigatorHandlers } = require("./socketHandlers/navigatorHandlers");
const { setupCanvasHandlers } = require("./socketHandlers/canvasHandlers");
const { setupPresenceHandlers } = require("./socketHandlers/presenceHandlers");
const { createCanvasMutationGate } = require("./services/canvasMutations");
const { createPresenceStore } = require("./services/canvasPresence");
const { initializeTimerService } = require("./services/versusTimerService");
const VersusSessionManager = require("./services/versusSessionManager");
require("dotenv").config();
const otelMetrics = require("./tracing");

function wrapSocketHandler(socket, eventName, handler, flow = "canvas") {
  socket.on(eventName, async (...args) => {
    if (otelMetrics.socketEvents) {
      otelMetrics.socketEvents.add(1, { event: eventName, flow });
    }
    const start = Date.now();
    try {
      await handler(...args);
    } finally {
      if (otelMetrics.socketEventDuration) {
        otelMetrics.socketEventDuration.record(Date.now() - start, {
          event: eventName,
          flow,
        });
      }
    }
  });
}

function findCertPath() {
  const localPath = ".";
  const sharedPath = path.join(os.homedir(), ".config/local-certs");

  if (existsSync(path.join(localPath, "localhost+2.pem"))) {
    return localPath;
  }
  if (existsSync(path.join(sharedPath, "localhost+2.pem"))) {
    return sharedPath;
  }
  return null;
}

async function main() {
  (async () => {
    try {
      await sequelize.authenticate();
      setupAssociations(sequelize);
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
  app.use("/api/navigator", navigatorRoutes);
  app.use("/api/saved-pools", savedPoolsRoutes);
  app.use("/api/scouting", scoutingRouter);

  let server;
  const certPath =
    process.env.ENVIRONMENT === "development" ? findCertPath() : null;
  if (certPath) {
    const key = await readFile(path.join(certPath, "localhost+2-key.pem"));
    const cert = await readFile(path.join(certPath, "localhost+2.pem"));
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

  const canvasMutationGate = createCanvasMutationGate({ io });
  const presenceStore = createPresenceStore();

  // Initialize versus timer service
  initializeTimerService(io);
  const versusSessionManager = new VersusSessionManager();

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
    if (otelMetrics.socketConnections) {
      otelMetrics.socketConnections.add(1);
    }

    // Set up versus-specific handlers
    setupVersusHandlers(io, socket, versusSessionManager, wrapSocketHandler);
    setupNavigatorHandlers(io, socket, wrapSocketHandler);

    setupCanvasHandlers(socket, canvasMutationGate, wrapSocketHandler);
    setupPresenceHandlers(socket, presenceStore, wrapSocketHandler);

    wrapSocketHandler(socket, "joinRoom", async (room) => {
      // Legacy unauthenticated join is for draft rooms only. Canvas rooms
      // (named by canvasId) are ACL-gated behind joinCanvas and carry
      // presence identities, so refuse anything that isn't a known draft.
      if (typeof room !== "string" || !(await Draft.findByPk(room))) {
        return;
      }
      socket.join(room);
      console.log(`${socket.id} joined room: ${room}`);
      const roomSize = await socketService.getRoomSize(room);
      io.to(room).emit("userCountUpdate", roomSize);
    });

    wrapSocketHandler(socket, "leaveRoom", async (room) => {
      socket.leave(room);
      console.log(`${socket.id} left room: ${room}`);
      const roomSize = await socketService.getRoomSize(room);
      io.to(room).emit("userCountUpdate", roomSize);
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
      if (otelMetrics.socketConnections) {
        otelMetrics.socketConnections.add(-1);
      }
      console.log(`Client disconnected: ${socket.id}`);
    });
  });

  const PORT = process.env.PORT || 5000;
  server.listen(PORT, () => {
    console.log(`server running on PORT ${PORT}`);
  });
}

main().catch(console.error);
