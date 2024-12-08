const express = require("express");
const sequelize = require("./config/database");
const { Server } = require("socket.io");
const { createServer } = require("node:http");
const cors = require("cors");
const draftRoutes = require("./routes/drafts");
const Draft = require("./models/Draft");

async function main() {
  (async () => {
    try {
      await sequelize.authenticate();
      console.log(
        "Connection to the database has been established successfully."
      );
      await sequelize.sync(); // Sync all defined models to the database
      if ((await Draft.findAll().length) === 0) {
        await Draft.create();
      }
    } catch (error) {
      console.error("Unable to connect to the database:", error);
    }
  })();

  const app = express();
  app.use(
    cors({
      origin: "http://localhost:5173",
    })
  );
  app.use("/api/drafts", draftRoutes);
  const server = createServer(app);
  const io = new Server(server, {
    connectionStateRecovery: {},
    cors: {
      origin: "http://localhost:5173", // Frontend URL (adjust as needed)
      methods: ["GET", "POST"],
    },
  });

  io.on("connection", (socket) => {
    console.log("A user connected:", socket.id);
    socket.on("newDraft", async (data) => {
      console.log(data);
      try {
        // store the message in the database
        if ("id" in data && data.picks.length === 20) {
          Draft.update({ picks: data.picks }, { where: { id: data.id } });
        }
      } catch (e) {
        console.log("catch");
        console.log(e);
        // TODO handle the failure
        return;
      }
      // include the offset with the message
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
    socket.on("newMessage", (test) => {
      console.log(test);
      io.to(test.room).emit("chatMessage", {
        username: socket.id,
        chat: test.message,
      });
      console.log(`Message sent to room ${test.room}: ${test.message}`);
    });
  });

  const PORT = process.env.PORT || 5000;
  server.listen(PORT, () => {
    console.log(`server running at http://localhost:${PORT}`);
  });
}

main();
