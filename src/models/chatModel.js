const { DataTypes } = require("sequelize");
const { sequelize } = require("../config/sequelize");

const Chat = sequelize.define(
  "Chat",
  {
    id: {
      type: DataTypes.INTEGER,
      autoIncrement: true,
      primaryKey: true,
    },
    userId: {
      type: DataTypes.INTEGER,
      allowNull: true,
    },
    dignosticId: {
      type: DataTypes.INTEGER,
      allowNull: true,
    },
    discoveryId: {
      type: DataTypes.INTEGER,
      allowNull: true,
    },

    data: {
      type: DataTypes.JSONB,
      allowNull: false,
    },
    isChatEnded: {
      type: DataTypes.BOOLEAN,
      defaultValue: false,
    },
    chatType: {
      type: DataTypes.ENUM("dignostic", "discovery"),
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
    tableName: "chat",
    freezeTableName: true,
    timestamps: true,
  }
);

module.exports = { Chat };
