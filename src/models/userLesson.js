const { DataTypes } = require("sequelize");
const { sequelize } = require("../config/sequelize");

// VoiceNote and User required after define to avoid circular deps
let VoiceNote;
let User;

const UserLesson = sequelize.define(
  "UserLesson",
  {
    id: {
      type: DataTypes.INTEGER,
      autoIncrement: true,
      primaryKey: true,
    },
    userId: {
      type: DataTypes.STRING,
      allowNull: false,
      unique: false,
    },
    course: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    module: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    lesson: {
      type: DataTypes.STRING,
      defaultValue: null,
    },
    isCompleted: {
      type: DataTypes.BOOLEAN,
      defaultValue: false,
    },
    voiceId: {
      type: DataTypes.INTEGER,
      defaultValue: null,
    },
    createdAt: {
      type: DataTypes.DATE,
      allowNull: false,
      field: "createdAt",
      defaultValue: DataTypes.NOW,
    },
    updatedAt: {
      type: DataTypes.DATE,
      allowNull: false,
      field: "updatedAt",
      defaultValue: DataTypes.NOW,
    },
  },
  {
    tableName: "userlesson",
    freezeTableName: true,
    timestamps: true,
    createdAt: "createdAt",
    updatedAt: "updatedAt",
  },
);

// Lazy-load associations to avoid circular dependencies
const setupAssociations = () => {
  if (UserLesson.associations?.VoiceNote) return;
  VoiceNote = VoiceNote || require("./voiceNoteModel").VoiceNote;
  User = User || require("./userModel").User;
  UserLesson.belongsTo(VoiceNote, { foreignKey: "voiceId" });
  UserLesson.belongsTo(User, { foreignKey: "userId", targetKey: "id" });
};
setupAssociations();

module.exports = { UserLesson };
