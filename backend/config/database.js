const { Sequelize } = require("sequelize");
require("dotenv").config();
const log = require("../utils/logger");

function envInt(name, fallback) {
  const raw = process.env[name];
  const n = raw === undefined ? NaN : Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

// Explicit pool. Sequelize's defaults (max 5, acquire 60 s) are what turned
// one stalled row into a 60 s site-wide outage on 2026-08-28. Fail fast
// instead: a request that cannot get a connection in 15 s gets a 500 the
// client can retry, rather than a hung tab.
const pool = {
  max: envInt("DB_POOL_MAX", 10),
  min: 0,
  acquire: envInt("DB_POOL_ACQUIRE_MS", 15000),
  idle: envInt("DB_POOL_IDLE_MS", 10000),
};

const sequelize = new Sequelize(
  process.env.DB_NAME,
  process.env.DB_USER,
  process.env.DB_PASSWORD,
  {
    host: process.env.DB_HOST,
    dialect: "postgres",
    pool,
    // Sequelize defaults to console.log, which meant every query was written
    // to stdout and mirrored into OTel. Off unless debugging.
    logging: log.isEnabled() ? (msg) => log.debug(msg) : false,
    dialectOptions: {
      ssl: {
        require: true,
        rejectUnauthorized: false,
      },
    },
  }
);

module.exports = sequelize;
