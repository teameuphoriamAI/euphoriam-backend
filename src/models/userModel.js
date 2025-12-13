const { DataTypes } = require("sequelize");
const bcrypt = require("bcryptjs");
const { sequelize } = require("../config/sequelize");

const hashPassword = async (user) => {
  if (!user.changed("password") || !user.password) return;
  const salt = await bcrypt.genSalt(10);
  user.password = await bcrypt.hash(user.password, salt);
};

const User = sequelize.define(
  "User",
  {
    id: {
      type: DataTypes.INTEGER,
      autoIncrement: true,
      primaryKey: true,
    },
    email: {
      type: DataTypes.STRING,
      allowNull: false,
      unique: true,
    },
    name: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    role: {
      type: DataTypes.STRING,
      allowNull: false,
      defaultValue: "user",
    },
    password: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    metadata: {
      type: DataTypes.JSONB,
      allowNull: true,
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
    tableName: "users",
    freezeTableName: true,
    timestamps: true,
    createdAt: "createdAt",
    updatedAt: "updatedAt",
    hooks: {
      beforeCreate: hashPassword,
      beforeUpdate: hashPassword,
    },
  }
);

User.prototype.toJSON = function () {
  const values = { ...this.get() };
  delete values.password;
  return values;
};

const getAll = async () => {
  const users = await User.findAll({
    order: [["createdAt", "DESC"]],
    attributes: { exclude: ["password"] },
  });
  return users;
};

const normalizeWhere = (query) =>
  typeof query === "string" ? { email: query } : query;

const findOne = async (query) => {
  const where = normalizeWhere(query);
  const user = await User.findOne({
    where,
    attributes: { exclude: ["password"] },
  });
  return user;
};

const findOneWithPassword = async (query) => {
  const where = normalizeWhere(query);
  const user = await User.findOne({
    where,
    attributes: { include: ["password"] },
  });
  return user;
};

const create = async (payload) => {
  const user = await User.create(payload);
  return user;
};

module.exports = { getAll, create, findOne, findOneWithPassword, User };
