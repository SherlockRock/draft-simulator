const express = require("express");
const router = express.Router();
const { google } = require("googleapis");
const jwt = require("jsonwebtoken");
const User = require("../models/User");
const helpers = require("../helpers");
require("dotenv").config();

const REFRESH_TOKEN_SECRET = process.env.REFRESH_TOKEN_SECRET;
const JWT_SECRET = process.env.JWT_SECRET;

const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  `${process.env.FRONTEND_ORIGIN}/oauth2callback`
);

router.post("/google/callback", async (req, res) => {
  const { code } = req.body;
  if (!code) {
    return res.status(400).json({ error: "Code is required" });
  }

  try {
    const { tokens } = await oauth2Client.getToken(code);
    console.log("Google OAuth tokens:", tokens);
    oauth2Client.setCredentials(tokens);

    const ticket = await oauth2Client.verifyIdToken({
      idToken: tokens.id_token,
      audience: process.env.GOOGLE_CLIENT_ID,
    });

    const payload = ticket.getPayload();
    let loggedInUser = await User.findOne({
      where: { email: payload.email },
    });

    if (loggedInUser) {
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

    const user = {
      id: loggedInUser.id,
      name: loggedInUser.name,
      email: loggedInUser.email,
      picture: loggedInUser.picture,
    };

    const accessToken = jwt.sign(user, process.env.JWT_SECRET, {
      expiresIn: "1d",
    });
    const refreshToken = jwt.sign(
      { user_id: user.id },
      process.env.REFRESH_TOKEN_SECRET,
      {
        expiresIn: "30d",
      }
    );

    res.cookie("accessToken", accessToken, {
      httpOnly: true,
      secure: true,
      sameSite: "none",
    });
    res.cookie("refreshToken", refreshToken, {
      httpOnly: true,
      secure: true,
      sameSite: "none",
    });

    try {
      const encodedRefreshToken = helpers.encrypt(refreshToken);
      await loggedInUser.createUserToken({
        user_id: loggedInUser.id,
        refresh: encodedRefreshToken,
      });
    } catch (error) {
      console.error("Error creating new token:", error);
    }

    res.json({ user });
  } catch (error) {
    console.error("Error during Google OAuth callback:", error);
    res.status(500).json({ error: "Authentication failed" });
  }
});

router.get("/refresh-token", async (req, res) => {
  console.log(req.cookies);
  const refreshToken = req.cookies.refreshToken;
  if (!refreshToken) {
    return res.status(403).json({ error: "No refresh token provided" });
  }
  try {
    const decoded = jwt.verify(refreshToken, REFRESH_TOKEN_SECRET);

    let loggedInUser = await User.findOne({
      where: { id: decoded.user_id },
    });
    if (!loggedInUser) {
      res.status(403).send("User not found");
    } else {
      const userTokens = await loggedInUser.getUserTokens();
      let found = false;
      userTokens.forEach((token) => {
        const tokenDecrypted = helpers.decrypt(token.refresh);
        if (refreshToken === tokenDecrypted) {
          found = true;
        }
      });
      if (!found || new Date(decoded.exp * 1000) < new Date(Date.now())) {
        res.status(403).send("Expired or invalid token");
      } else {
        const user = {
          id: loggedInUser.id,
          name: loggedInUser.name,
          email: loggedInUser.email,
          picture: loggedInUser.picture,
        };
        const newToken = jwt.sign(user, JWT_SECRET, {
          expiresIn: "1d",
        });
        res.cookie("accessToken", newToken, {
          httpOnly: true,
          secure: true,
          sameSite: "none",
        });
        res.status(200).json({ user });
      }
    }
  } catch (err) {
    console.log("Error verifying refresh token:", err);
    res.status(403).send("Invalid or expired token");
  }
});

// Example on revoking a token
router.get("/revoke", async (req, res) => {
  const refreshToken = req.cookies.refreshToken;
  res.clearCookie("refreshToken", {
    httpOnly: true,
    secure: true,
    sameSite: "none",
  });
  res.clearCookie("accessToken", {
    httpOnly: true,
    secure: true,
    sameSite: "none",
  });
  try {
    console.log("Revoking token:", refreshToken);
    const reqDecoded = jwt.verify(refreshToken, REFRESH_TOKEN_SECRET);
    const loggedInUser = await User.findOne({
      where: { id: reqDecoded.user_id },
    });
    if (loggedInUser) {
      const userTokens = await loggedInUser.getUserTokens();
      userTokens.forEach((token) => {
        const dbTokenDecrypted = helpers.decrypt(token.refresh);
        if (refreshToken === dbTokenDecrypted) {
          token.destroy();
        }
      });
    }
    res.status(200).json({ message: "Tokens revoked successfully" });
  } catch (e) {
    console.log("Error decoding JWT:", e);
    res.status(403).json({ error: "User not found" });
  }

  // Options for POST request to Google's OAuth 2.0 server to revoke a token
  // const postOptions = {
  //   host: "oauth2.googleapis.com",
  //   port: "443",
  //   path: "/revoke",
  //   method: "POST",
  //   headers: {
  //     "Content-Type": "application/x-www-form-urlencoded",
  //     "Content-Length": Buffer.byteLength(postData),
  //   },
  // };

  // // Set up the request
  // const postReq = https.request(postOptions, function (res) {
  //   res.setEncoding("utf8");
  //   res.on("data", (d) => {
  //     console.log("Response: " + d);
  //   });
  // });

  // postReq.on("error", (error) => {
  //   console.log(error);
  // });

  // // Post the request with data
  // postReq.write(postData);
  // postReq.end();
});

module.exports = router;
