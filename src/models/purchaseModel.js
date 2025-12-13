const { DataTypes } = require("sequelize");
const { sequelize } = require("../config/sequelize");

const Purchase = sequelize.define(
  "Purchase",
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
    productId: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    source: {
      type: DataTypes.STRING,
      allowNull: false,
      defaultValue: "kajabi",
    },
    externalId: {
      type: DataTypes.STRING,
      allowNull: true,
      unique: true,
    },
    purchasedAt: {
      type: DataTypes.DATE,
      allowNull: false,
      defaultValue: DataTypes.NOW,
    },
    metadata: {
      type: DataTypes.JSONB,
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
    tableName: "purchases",
    freezeTableName: true,
    timestamps: true,
  }
);

const listByUser = async (userId) =>
  Purchase.findAll({
    where: { userId },
    order: [["purchasedAt", "DESC"]],
  });

const listAll = async () =>
  Purchase.findAll({ order: [["purchasedAt", "DESC"]] });

const findByExternalId = async (externalId) =>
  Purchase.findOne({ where: { externalId } });

module.exports = { Purchase, listByUser, listAll, findByExternalId };


