const { User } = require("./userModel");
const { Product } = require("./productModel");
const { Purchase } = require("./purchaseModel");
const { Diagnostic } = require("./diagnosticModel");
const { Discovery } = require("./discoveryModel");
const { CoachingSession } = require("./coachingSessionModel");
const { IntegrationEvent } = require("./integrationEventModel");
const { VoiceNote } = require("./voiceNoteModel");
const { Document } = require("./documentModel");
const { Prompt, PromptHistory } = require("./promptModel");
const { UserSession } = require("./userSessionModel");

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

  User.hasMany(VoiceNote, {
    foreignKey: "userId",
    onDelete: "CASCADE",
  });

  User.hasMany(UserSession, {
    foreignKey: "userId",
    onDelete: "CASCADE",
  });
  UserSession.belongsTo(User, { foreignKey: "userId", as: "user" });
};

module.exports = {
  User,
  Product,
  Purchase,
  Diagnostic,
  Discovery,
  CoachingSession,
  IntegrationEvent,
  VoiceNote,
  Document,
  Prompt,
  PromptHistory,
  UserSession,
  applyAssociations,
};



