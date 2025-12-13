const { User } = require("./userModel");
const { Product } = require("./productModel");
const { Purchase } = require("./purchaseModel");
const { Diagnostic } = require("./diagnosticModel");
const { Discovery } = require("./discoveryModel");
const { CoachingSession } = require("./coachingSessionModel");
const { IntegrationEvent } = require("./integrationEventModel");

const applyAssociations = () => {
  User.hasMany(Purchase, { foreignKey: "userId" });
  Purchase.belongsTo(User, { foreignKey: "userId" });

  Product.hasMany(Purchase, { foreignKey: "productId" });
  Purchase.belongsTo(Product, { foreignKey: "productId" });

  User.hasMany(Diagnostic, { foreignKey: "userId" });
  Diagnostic.belongsTo(User, { foreignKey: "userId" });

  User.hasMany(Discovery, { foreignKey: "userId" });
  Discovery.belongsTo(User, { foreignKey: "userId" });

  User.hasMany(CoachingSession, { foreignKey: "userId" });
  CoachingSession.belongsTo(User, { foreignKey: "userId" });

  User.hasMany(CoachingSession, { foreignKey: "coachId", as: "CoachingAssignments" });
  CoachingSession.belongsTo(User, { foreignKey: "coachId", as: "Coach" });
};

module.exports = {
  User,
  Product,
  Purchase,
  Diagnostic,
  Discovery,
  CoachingSession,
  IntegrationEvent,
  applyAssociations,
};


