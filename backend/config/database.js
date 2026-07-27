const { Sequelize } = require("sequelize");
require("dotenv").config();
const log = require("../utils/logger");

const sequelize = new Sequelize(
  process.env.DB_NAME,
  process.env.DB_USER,
  process.env.DB_PASSWORD,
  {
    host: process.env.DB_HOST,
    dialect: "postgres",
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
