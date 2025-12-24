const { DataTypes } = require("sequelize");
const { sequelize } = require("../config/sequelize");

// Simple document store for RAG. Embedding stored as JSON array to avoid pgvector
// dependency; similarity is computed in app layer.
const Document = sequelize.define(
  "Document",
  {
    id: {
      type: DataTypes.INTEGER,
      autoIncrement: true,
      primaryKey: true,
    },
    title: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    chunk: {
      type: DataTypes.TEXT,
      allowNull: false,
    },
    embedding: {
      // Array of numbers
      type: DataTypes.JSONB,
      allowNull: false,
    },
    metadata: {
      type: DataTypes.JSONB,
      allowNull: true,
    },
  },
  {
    tableName: "documents",
    freezeTableName: true,
    timestamps: true,
  }
);

module.exports = { Document };

