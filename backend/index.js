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
const authRoutes = require("./routes/auth"); // Import the new auth routes
const Draft = require("./models/Draft");
const User = require("./models/User");
const setupAssociations = require("./models/associations");
const helpers = require("./helpers");
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
    })
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
            JWT_SECRET
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
    socket.on("newDraft", async (data) => {
      try {
        if ("id" in data && data.picks.length === 20) {
          Draft.update({ picks: data.picks }, { where: { id: data.id } });
        }
      } catch (e) {
        console.log(e);
        // TODO handle the failure
        return;
      }
      io.to(data.id).emit("draftUpdate", data, data.id);
    });

    // Join a room
    socket.on("joinRoom", (room) => {
      socket.join(room);
      console.log(`${socket.id} joined room: ${room}`);
    });

    // Leave a room
    socket.on("leaveRoom", (room) => {
      socket.leave(room);
      console.log(`${socket.id} left room: ${room}`);
    });

    // Broadcast to a room
    socket.on("newMessage", async (req) => {
      const username = socket.user ? socket.user.name : socket.id;
      io.to(req.room).emit("chatMessage", {
        username,
        socketId: socket.id,
        chat: req.message,
      });
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
