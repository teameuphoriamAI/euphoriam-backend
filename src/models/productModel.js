const { DataTypes } = require("sequelize");
const { sequelize } = require("../config/sequelize");

const Product = sequelize.define(
  "Product",
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
    sku: {
      type: DataTypes.STRING,
      allowNull: true,
      unique: true,
    },
    kajabiOfferId: {
      type: DataTypes.STRING,
      allowNull: true,
      unique: true,
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
    tableName: "products",
    freezeTableName: true,
    timestamps: true,
  }
);

const getAll = async () =>
  Product.findAll({ order: [["createdAt", "DESC"]] });

const findOrCreateProduct = async ({
  name,
  sku = null,
  kajabiOfferId = null,
  metadata = {},
}) => {
  const [product] = await Product.findOrCreate({
    where: kajabiOfferId
      ? { kajabiOfferId }
      : sku
      ? { sku }
      : { name },
    defaults: { name, sku, kajabiOfferId, metadata },
  });
  return product;
};

module.exports = { Product, getAll, findOrCreateProduct };


