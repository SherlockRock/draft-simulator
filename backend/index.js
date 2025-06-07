const express = require("express");
const passport = require("passport");
const GoogleStrategy = require("passport-google-oauth20").Strategy;
const cookieParser = require("cookie-parser");
const session = require("express-session");
const sequelize = require("./config/database");
const jwt = require("jsonwebtoken");
const https = require("https");
const http = require("http");
const url = require("url");
const { readFile } = require("node:fs/promises");
const { google } = require("googleapis");
const { Server } = require("socket.io");
const cors = require("cors");
const draftRoutes = require("./routes/drafts");
const userRoutes = require("./routes/users");
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
      const count = await Draft.count();
      if (count === 0) {
        console.log("No drafts found, creating a new draft");
        await Draft.create();
      }
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
  const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    `${FRONTEND_ORIGIN}/oauth2callback`
  );
  const JWT_SECRET = process.env.JWT_SECRET;
  const REFRESH_TOKEN_SECRET = process.env.REFRESH_TOKEN_SECRET;
  // const scopes = [
  //   "https://www.googleapis.com/auth/userinfo.email",
  //   "https://www.googleapis.com/auth/userinfo.profile",
  // ];

  // const PASETO_SECRET = generateKeys("local", { format: "buffer" });
  // const PASETO_SECRET = Buffer.from(process.env.PASETO_SECRET, "base64");

  app.use(
    session({
      secret: process.env.SESSION_SECRET,
      resave: false,
      saveUninitialized: true,
    })
  );

  app.use(cookieParser());
  app.use(express.json());

  passport.use(
    new GoogleStrategy(
      {
        clientID: process.env.GOOGLE_CLIENT_ID,
        clientSecret: process.env.GOOGLE_CLIENT_SECRET,
        callbackURL: "/oauth2callback",
      },
      (accessToken, refreshToken, profile, done) => {
        // User authentication logic
        return done(null, profile);
      }
    )
  );

  passport.serializeUser((user, done) => {
    done(null, user);
  });

  passport.deserializeUser((obj, done) => {
    done(null, obj);
  });

  app.get("/", (req, res) => res.send("OK"));

  app.get(
    "/auth/google",
    passport.authenticate("google", { scope: ["profile", "email"] })
  );

  // Receive the callback from Google's OAuth 2.0 server.
  app.get("/oauth2callback", async (req, res) => {
    // Handle the OAuth 2.0 server response
    let q = url.parse(req.url, true).query;
    if (q.error) {
      // An error response e.g. error=access_denied
      console.log("Error:" + q.error);
    } else if (q.state !== req.session.state) {
      //check state value
      console.log("State mismatch. Possible CSRF attack");
      res.end("State mismatch. Possible CSRF attack");
    } else {
      let { tokens } = await oauth2Client.getToken(q.code);
      oauth2Client.setCredentials(tokens);
      const ticket = await oauth2Client.verifyIdToken({
        idToken: tokens.id_token,
        audience: process.env.GOOGLE_CLIENT_ID,
      });

      // Get the user info from the payload
      const payload = ticket.getPayload();
      let loggedInUser = await User.findOne({
        where: { email: payload.email },
      });

      if (loggedInUser !== null) {
        loggedInUser.name = payload.name;
        loggedInUser.email = payload.email;
        loggedInUser.picture = payload.picture;
        await loggedInUser.save();
      } else {
        loggedInUser = await User.create({
          name: payload.name,
          email: payload.email,
          picture: payload.picture,
        });
      }
      const encodedToken = helpers.encrypt(tokens.access_token);
      const userTokens = await loggedInUser.getUserTokens();
      let edited = false;
      if (userTokens.length !== 0) {
        userTokens.forEach((token) => {
          try {
            const decodedToken = helpers.decrypt(token.jwt);
            if (decodedToken === tokens.access_token) {
              token.createdAt = new Date();
              token.save();
              edited = true;
            } else if (
              token.createdAt < new Date(Date.now() - 1000 * 60 * 60)
            ) {
              token.destroy();
            }
          } catch (error) {
            token.destroy();
          }
        });
      } else if (userTokens.length === 0 || !edited) {
        loggedInUser.createUserToken({ key: encodedToken });
      }

      // Check if user authorized Calendar read permission.
      if (
        tokens.scope.includes(
          "https://www.googleapis.com/auth/calendar.readonly"
        )
      ) {
        // User authorized Calendar read permission.
        // Calling the APIs, etc.
      } else {
        // User didn't authorize Calendar read permission.
        // Update UX and application accordingly
      }
      const user = {
        id: loggedInUser.id,
        name: loggedInUser.name,
        email: loggedInUser.email,
        picture: loggedInUser.picture,
      };
      const token = jwt.sign(user, JWT_SECRET, {
        expiresIn: "1h",
      });
      res.cookie("jwt", token, { httpOnly: true, secure: true });
      const refreshToken = jwt.sign({ id: user.id }, REFRESH_TOKEN_SECRET, {
        expiresIn: "30d",
      });
      res.cookie("refreshToken", refreshToken, {
        httpOnly: true,
        secure: true,
      });
      res.redirect("https://localhost:5173/");
    }
  });

  // Protected route example
  app.get("/api/user", async (req, res) => {
    const token = req.cookies.jwt;
    if (!token) {
      return res.status(401).send("Unauthorized");
    }

    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      const loggedInUser = await User.findOne({
        where: { id: decoded.id },
      });
      res.status(200).json({ user: loggedInUser });
    } catch (err) {
      res.status(403).send("Invalid or expired token");
    }
  });

  app.get("/refresh-token", async (req, res) => {
    const refreshToken = req.cookies.refreshToken;
    if (!refreshToken) {
      return res.status(403).json({ error: "No refresh token provided" });
    }
    // Verify refresh token and issue new JWT
    const decoded = jwt.verify(refreshToken, REFRESH_TOKEN_SECRET);
    if (decoded.err) {
      return res.status(403).json({ error: "Invalid refresh token" });
    }
    try {
      let loggedInUser = await User.findOne({
        where: { id: decoded.id },
      });
      const user = {
        id: loggedInUser.id,
        name: loggedInUser.name,
        email: loggedInUser.email,
        picture: loggedInUser.picture,
      };
      const newToken = jwt.sign(user, JWT_SECRET, {
        expiresIn: "60s",
      });
      res.cookie("jwt", newToken, { httpOnly: true, secure: true });
      res.status(200).json({ user });
    } catch (err) {
      res.status(403).json({ error: "User not found" });
    }
  });

  // Example on revoking a token
  app.get("/api/revoke", async (req, res) => {
    const token = req.cookies.jwt;
    let postData = "token=";
    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      if (decoded.err) {
        return res.status(403).json({ error: "Invalid token" });
      }
      const loggedInUser = await User.findOne({
        where: { id: decoded.id },
      });
      const userTokens = await loggedInUser.getUserTokens();
      userTokens.forEach((token) => {
        if (helpers.decrypt(token.jwt) === decoded) {
          postData += token.access;
          token.destroy();
        }
      });
    } catch (e) {
      res.status(403).json({ error: "User not found" });
    }

    // Options for POST request to Google's OAuth 2.0 server to revoke a token
    const postOptions = {
      host: "oauth2.googleapis.com",
      port: "443",
      path: "/revoke",
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "Content-Length": Buffer.byteLength(postData),
      },
    };

    // Set up the request
    const postReq = https.request(postOptions, function (res) {
      res.setEncoding("utf8");
      res.on("data", (d) => {
        console.log("Response: " + d);
      });
    });

    postReq.on("error", (error) => {
      console.log(error);
    });

    // Post the request with data
    postReq.write(postData);
    postReq.end();
  });

  app.use("/api/drafts", draftRoutes);
  app.use("/api/users", userRoutes);

  let server;
  if (process.env.ENVIRONMENT === "development") {
    const key = await readFile("./localhost+2-key.pem");
    const cert = await readFile("./localhost+2.pem");
    server = https.createServer({ key, cert }, app);
    console.log("development environment");
  } else {
    console.log("production environment");
    server = http.createServer(app);
  }
  const io = new Server(server, {
    connectionStateRecovery: {},
    cors: {
      origin: process.env.FRONTEND_ORIGIN,
      credentials: true,
    },
  });

  io.on("connection", (socket) => {
    const request = socket.request;
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
      let username = socket.id;
      try {
        const token = request.headers.cookie
          .split("; ")
          .find((c) => c.startsWith("jwt="))
          .replace(/^jwt=/, "");
        const decoded = jwt.verify(token, JWT_SECRET);
        const loggedInUser = await User.findOne({
          where: { id: decoded.id },
        });
        username = loggedInUser.name;
      } catch (err) {
        username = socket.id;
      }
      io.to(req.room).emit("chatMessage", {
        username,
        sockedId: socket.id,
        chat: req.message,
      });
    });
  });

  const PORT = process.env.PORT || 5000;
  server.listen(PORT, () => {
    console.log(`server running on PORT ${PORT}`);
  });
}

main().catch(console.error);
