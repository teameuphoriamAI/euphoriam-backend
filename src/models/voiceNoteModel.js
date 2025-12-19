const { DataTypes } = require("sequelize");
const { sequelize } = require("../config/sequelize");

const VoiceNote = sequelize.define(
  "VoiceNote",
  {
    id: {
      type: DataTypes.INTEGER,
      autoIncrement: true,
      primaryKey: true,
    },
    diagnosticEmail: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    content: {
      type: DataTypes.TEXT,
      allowNull: false,
    },
    sourceType: {
      type: DataTypes.ENUM("text", "voice"),
      allowNull: false,
      defaultValue: "text",
    },
    transcriptMeta: {
      type: DataTypes.JSONB,
      allowNull: true,
    },
    audioPath: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    audioUrl: {
      type: DataTypes.STRING,
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
    tableName: "voice_notes",
    freezeTableName: true,
    timestamps: true,
  }
);

module.exports = { VoiceNote };


