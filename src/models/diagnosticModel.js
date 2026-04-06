const { DataTypes } = require("sequelize");
const { sequelize } = require("../config/sequelize");

const Diagnostic = sequelize.define(
  "Diagnostic",
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
    chatId: {
      type: DataTypes.INTEGER,
      allowNull: true,
    },
    email: {
      type: DataTypes.STRING,
      allowNull: true,
      validate: {
        isEmail: true,
      },
      unique: true,
    },
    pdfUrl: { type: DataTypes.STRING, allowNull: true },
    report: { type: DataTypes.STRING, allowNull: true },
    title: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    report_type: {
      type: DataTypes.STRING(50),
      allowNull: false,
      defaultValue: "full",
      comment: '"full" = existing paid diagnostic report | "invisible_red_line" = funnel IRL report',
    },
    funnel_access_id: {
      type: DataTypes.UUID,
      allowNull: true,
      comment: "FK to funnel_access — set only for funnel diagnostics",
    },
    data: {
      type: DataTypes.JSONB,
      allowNull: false,
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
    tableName: "diagnostics",
    freezeTableName: true,
    timestamps: true,
  }
);

module.exports = { Diagnostic };
