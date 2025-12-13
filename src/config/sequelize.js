const { Sequelize } = require("sequelize");

const { DATABASE_URL } = process.env;

if (!DATABASE_URL) {
  throw new Error("DATABASE_URL is required");
}

const sequelize = new Sequelize(DATABASE_URL, {
  dialect: "postgres",
  logging: false,
  dialectOptions: {
    ssl: {
      require: true,
      rejectUnauthorized: false,
    },
  },
});

const initDb = async () => {
  await sequelize.authenticate();
  // Register models and associations before sync
  const models = require("../models");
  models.applyAssociations();
  await sequelize.sync();
  console.log("Database connected and synced");
  return models;
};

module.exports = { sequelize, initDb };


