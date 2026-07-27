const jwt = require("jsonwebtoken");
const User = require("../models/User");
const log = require("../utils/logger");

// Never log the token or the raw cookie header — this ran on every
// authenticated request and put live access tokens in plaintext in the
// production log store. The user id is enough to trace a request.
const getUserFromRequest = async (req) => {
  try {
    const token = req.cookies.accessToken;

    if (token) {
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      if (decoded) {
        const user = await User.findByPk(decoded.id);
        log.debug(
          `getUserFromRequest - user ${decoded.id}: ${user ? "found" : "not found"}`,
        );
        return user;
      }
    }
    return null;
  } catch (error) {
    // It's okay if token is invalid or expired, just means user is not logged in.
    log.debug("getUserFromRequest - rejected:", error.message);
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

const authenticate = protect; // Alias for consistency

const optionalAuth = async (req, res, next) => {
  const user = await getUserFromRequest(req);
  req.user = user || null;
  next();
};

module.exports = { protect, authenticate, optionalAuth, getUserFromRequest };
