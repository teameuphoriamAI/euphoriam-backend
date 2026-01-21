const { DataTypes } = require("sequelize");
const { sequelize } = require("../config/sequelize");
const { User } = require("./userModel");

const UserSession = sequelize.define(
  "UserSession",
  {
    id: {
      type: DataTypes.INTEGER,
      autoIncrement: true,
      primaryKey: true,
    },
    userId: {
      type: DataTypes.INTEGER,
      allowNull: true,
      comment: "Associated user ID (can be set later via attachUser endpoint)",
    },
    email: {
      type: DataTypes.STRING,
      allowNull: true,
      comment: "User email for identification before association",
    },
    transcript: {
      type: DataTypes.JSONB,
      allowNull: false,
      comment: "1:1 coaching session transcript stored as JSON array of messages",
    },
    embeddings: {
      type: DataTypes.JSONB,
      allowNull: true,
      comment: "Embedding vector for semantic search (array of numbers)",
    },
    summery:{
      type: DataTypes.TEXT,
      allowNull: true,
      comment: "Summery of the session",
    },
    sessionDate: {
      type: DataTypes.DATE,
      allowNull: true,
      comment: "Optional date when the session occurred",
    },
    metadata: {
      type: DataTypes.JSONB,
      allowNull: true,
      defaultValue: {},
      comment: "Additional metadata about the session",
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
    tableName: "user_sessions",
    freezeTableName: true,
    timestamps: true,
  }
);

// Associations are defined in src/models/index.js to avoid duplicates

module.exports = { UserSession };

