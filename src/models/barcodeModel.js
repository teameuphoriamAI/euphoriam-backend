const { DataTypes } = require("sequelize");
const { sequelize } = require("../config/sequelize");
const { User } = require("./userModel");

const Barcode = sequelize.define(
  "Barcode",
  {
    id: {
      type: DataTypes.INTEGER,
      autoIncrement: true,
      primaryKey: true,
    },
    websiteLink: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    productName: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    barcodeImage: {
      type: DataTypes.STRING,
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
    tableName: "Barcode",
    freezeTableName: true,
    timestamps: true,
  },
);

module.exports = { Barcode };
