const { DataTypes } = require("sequelize");
const { sequelize } = require("../config/sequelize");

const FunnelAccess = sequelize.define(
  "FunnelAccess",
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    email: {
      type: DataTypes.STRING(255),
      allowNull: false,
    },
    link_token: {
      type: DataTypes.STRING(512),
      allowNull: false,
      unique: true,
    },
    link_created_at: {
      type: DataTypes.DATE,
      allowNull: false,
    },
    link_expiry: {
      type: DataTypes.DATE,
      allowNull: false,
      comment: "link_created_at + 10 days",
    },
    first_accessed_at: {
      type: DataTypes.DATE,
      allowNull: true,
      comment: "Set on first activation",
    },
    expires_at: {
      type: DataTypes.DATE,
      allowNull: true,
      comment: "first_accessed_at + 7 days, set on first activation",
    },
    diagnostics_completed_count: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
    },
    last_diagnostic_at: {
      type: DataTypes.DATE,
      allowNull: true,
    },
    report_generated_count: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
    },
    report_last_sent_at: {
      type: DataTypes.DATE,
      allowNull: true,
    },
    is_blocked: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    },
    block_reason: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    kajabi_offer_source: {
      type: DataTypes.STRING,
      allowNull: true,
      comment: "Which Kajabi funnel/campaign this came from",
    },
    ip_at_creation: {
      type: DataTypes.STRING(64),
      allowNull: true,
    },
    ip_at_first_access: {
      type: DataTypes.STRING(64),
      allowNull: true,
    },
    // e.g. { signup_name: string } — set on direct-signup (checkUser) or create-token (first_name)
    metadata: {
      type: DataTypes.JSONB,
      allowNull: true,
      defaultValue: {},
    },
  },
  {
    tableName: "funnel_access",
    freezeTableName: true,
    timestamps: true,
    indexes: [
      {
        fields: ["email"],
        name: "idx_funnel_access_email",
      },
      {
        unique: true,
        fields: ["link_token"],
        name: "idx_funnel_access_token",
      },
      {
        unique: true,
        fields: ["email", "kajabi_offer_source"],
        name: "idx_funnel_access_email_source",
      },
    ],
  }
);

module.exports = { FunnelAccess };
