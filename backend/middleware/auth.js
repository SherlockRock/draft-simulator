const jwt = require("jsonwebtoken");
const User = require("../models/User");

const getUserFromRequest = async (req) => {
  try {
    console.log("getUserFromRequest - All cookies:", req.cookies);
    console.log("getUserFromRequest - Cookie header:", req.headers.cookie);
    const token = req.cookies.accessToken;
    console.log("getUserFromRequest - accessToken:", token ? "EXISTS (length: " + token.length + ")" : "MISSING");

    if (token) {
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      console.log("getUserFromRequest - Token decoded, user ID:", decoded.id);
      if (decoded) {
        const user = await User.findByPk(decoded.id);
        console.log("getUserFromRequest - User found:", user ? `ID ${user.id}, Email: ${user.email}` : "NULL");
        return user;
      }
    }
    console.log("getUserFromRequest - Returning null (no token)");
    return null;
  } catch (error) {
    // It's okay if token is invalid or expired, just means user is not logged in.
    console.log("getUserFromRequest - Error:", error.message);
    return null;
  }
};

const protect = async (req, res, next) => {
  const user = await getUserFromRequest(req);

  if (user) {
    req.user = user;
    next();
  } else {
    res.status(401).json({ error: "Not authorized, no token" });
  }
};

module.exports = { protect, getUserFromRequest };
