const { DataTypes } = require("sequelize");
const { sequelize } = require("../config/sequelize");
const { DOMAINS } = require("../constants/domains");

const DOMAIN_GOAL_STATUS = ["draft", "stored", "active"];

const DomainGoal = sequelize.define(
  "DomainGoal",
  {
    id: {
      type: DataTypes.INTEGER,
      autoIncrement: true,
      primaryKey: true,
    },
    userId: {
      type: DataTypes.INTEGER,
      allowNull: false,
      field: "user_id",
    },
    domain: {
      type: DataTypes.ENUM(...DOMAINS),
      allowNull: false,
    },
    status: {
      type: DataTypes.ENUM(...DOMAIN_GOAL_STATUS),
      allowNull: false,
      defaultValue: "draft",
    },
    goalTitle: {
      type: DataTypes.TEXT,
      allowNull: true,
      field: "goal_title",
    },
    desiredOutcome: {
      type: DataTypes.TEXT,
      allowNull: true,
      field: "desired_outcome",
    },
    targetDate: {
      type: DataTypes.STRING(128),
      allowNull: true,
      field: "target_date",
    },
    proofOfSuccess: {
      type: DataTypes.TEXT,
      allowNull: true,
      field: "proof_of_success",
    },
    milestoneDay7: {
      type: DataTypes.TEXT,
      allowNull: true,
      field: "milestone_day_7",
    },
    milestoneDay30: {
      type: DataTypes.TEXT,
      allowNull: true,
      field: "milestone_day_30",
    },
    milestoneDay90: {
      type: DataTypes.TEXT,
      allowNull: true,
      field: "milestone_day_90",
    },
    todayVisibleAction: {
      type: DataTypes.TEXT,
      allowNull: true,
      field: "today_visible_action",
    },
    goalsComplete: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
      field: "goals_complete",
    },
    mapResistanceComplete: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
      field: "map_resistance_complete",
    },
    /** Map resistance / strategies / progress — not normalized yet */
    structureJson: {
      type: DataTypes.JSONB,
      allowNull: false,
      defaultValue: {},
      field: "structure_json",
    },
  },
  {
    tableName: "domain_goals",
    freezeTableName: true,
    timestamps: true,
    underscored: true,
    indexes: [
      { unique: true, fields: ["user_id", "domain"] },
      { fields: ["user_id"] },
      { fields: ["user_id", "status"] },
    ],
  },
);

module.exports = { DomainGoal, DOMAIN_GOAL_STATUS };
