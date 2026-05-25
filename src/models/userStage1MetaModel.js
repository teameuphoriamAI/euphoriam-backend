const { DataTypes } = require("sequelize");
const { sequelize } = require("../config/sequelize");
const { DOMAINS } = require("../constants/domains");

const UserStage1Meta = sequelize.define(
  "UserStage1Meta",
  {
    userId: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      field: "user_id",
    },
    primaryDomain: {
      type: DataTypes.ENUM(...DOMAINS),
      allowNull: true,
      field: "primary_domain",
    },
    activeDomains: {
      type: DataTypes.JSONB,
      allowNull: false,
      defaultValue: [],
      field: "active_domains",
    },
    mapResistanceInProgress: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
      field: "map_resistance_in_progress",
    },
    walkthroughCompleted: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
      field: "walkthrough_completed",
    },
    walkthroughCompletedAt: {
      type: DataTypes.DATE,
      allowNull: true,
      field: "walkthrough_completed_at",
    },
    proofLogs: {
      type: DataTypes.JSONB,
      allowNull: false,
      defaultValue: [],
      field: "proof_logs",
    },
  },
  {
    tableName: "user_stage1_meta",
    freezeTableName: true,
    timestamps: true,
    underscored: true,
  },
);

module.exports = { UserStage1Meta };
