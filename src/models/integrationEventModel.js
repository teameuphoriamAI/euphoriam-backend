const { DataTypes } = require("sequelize");
const { sequelize } = require("../config/sequelize");

const IntegrationEvent = sequelize.define(
  "IntegrationEvent",
  {
    id: {
      type: DataTypes.INTEGER,
      autoIncrement: true,
      primaryKey: true,
    },
    source: {
      type: DataTypes.STRING,
      allowNull: false,
      unique: "source_external",
    },
    externalId: {
      type: DataTypes.STRING,
      allowNull: true,
      unique: "source_external",
    },
    status: {
      type: DataTypes.STRING,
      allowNull: false,
      defaultValue: "received",
    },
    error: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    payload: {
      type: DataTypes.JSONB,
      allowNull: true,
    },
    createdAt: {
      type: DataTypes.DATE,
      allowNull: false,
      defaultValue: DataTypes.NOW,
    },
    updatedAt: {
      type: DataTypes.DATE,
      allowNull: false,
      defaultValue: DataTypes.NOW,
    },
  },
  {
    tableName: "integration_events",
    freezeTableName: true,
    timestamps: true,
  }
);

module.exports = { IntegrationEvent };


