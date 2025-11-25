const jwt = require("jsonwebtoken");
const User = require("../models/User");

const getUserFromRequest = async (req) => {
  try {
    const token = req.cookies.accessToken;
    if (token) {
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      if (decoded) {
        const user = await User.findByPk(decoded.id);
        return user;
      }
    }
    return null;
  } catch (error) {
    // It's okay if token is invalid or expired, just means user is not logged in.
    console.log("Could not get user from request:", error.message);
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
