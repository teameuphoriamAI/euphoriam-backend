const { DataTypes } = require("sequelize");
const { sequelize } = require("../config/sequelize");

const Prompt = sequelize.define(
  "Prompt",
  {
    id: {
      type: DataTypes.INTEGER,
      autoIncrement: true,
      primaryKey: true,
    },
    name: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    type: {
      type: DataTypes.STRING,
      allowNull: false,
      comment: "e.g., 'system', 'intake', 'discovery', 'report'",
    },
    content: {
      type: DataTypes.TEXT,
      allowNull: false,
    },
    isActive: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: true,
    },
    version: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 1,
    },
    metadata: {
      type: DataTypes.JSONB,
      allowNull: true,
      comment: "Additional metadata like description, tags, etc.",
    },
    createdBy: {
      type: DataTypes.INTEGER,
      allowNull: true,
      comment: "Admin user ID who created this prompt",
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
    tableName: "prompts",
    freezeTableName: true,
    timestamps: true,
  }
);

const PromptHistory = sequelize.define(
  "PromptHistory",
  {
    id: {
      type: DataTypes.INTEGER,
      autoIncrement: true,
      primaryKey: true,
    },
    promptId: {
      type: DataTypes.INTEGER,
      allowNull: false,
      references: {
        model: Prompt,
        key: "id",
      },
    },
    name: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    type: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    content: {
      type: DataTypes.TEXT,
      allowNull: false,
    },
    version: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    metadata: {
      type: DataTypes.JSONB,
      allowNull: true,
    },
    changedBy: {
      type: DataTypes.INTEGER,
      allowNull: true,
      comment: "Admin user ID who made this change",
    },
    changeType: {
      type: DataTypes.STRING,
      allowNull: false,
      defaultValue: "update",
      comment: "e.g., 'create', 'update', 'delete'",
    },
    createdAt: {
      type: DataTypes.DATE,
      allowNull: false,
      defaultValue: DataTypes.NOW,
    },
  },
  {
    tableName: "prompt_history",
    freezeTableName: true,
    timestamps: false,
    createdAt: "createdAt",
    updatedAt: false,
  }
);

// Associations
Prompt.hasMany(PromptHistory, { foreignKey: "promptId", as: "history" });
PromptHistory.belongsTo(Prompt, { foreignKey: "promptId" });

module.exports = { Prompt, PromptHistory };



