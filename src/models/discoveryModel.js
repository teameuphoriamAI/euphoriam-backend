const { DataTypes } = require("sequelize");
const { sequelize } = require("../config/sequelize");

const Discovery = sequelize.define(
  "Discovery",
  {
    id: {
      type: DataTypes.INTEGER,
      autoIncrement: true,
      primaryKey: true,
    },
    userId: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    title: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    discoveryType: {
      type: DataTypes.STRING,
      allowNull: true,
      comment: "Type of discovery: 'alignment', 'freedom', 'prosperity', or 'integrated' (all three)",
    },
    email: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    diagnosticId: {
      type: DataTypes.INTEGER,
      allowNull: true,
    },
    transcript: {
      type: DataTypes.JSONB,
      allowNull: true,
      comment: "Chat transcript stored as JSON array",
    },
    previousReportSnippet: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    newReportSnippet: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    pdfUrl: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    data: {
      type: DataTypes.JSONB,
      allowNull: false,
      defaultValue: {},
      comment: "Kept for backward compatibility and additional metadata",
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
    tableName: "discoveries",
    freezeTableName: true,
    timestamps: true,
  }
);

module.exports = { Discovery };


