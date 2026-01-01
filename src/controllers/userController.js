const userModel = require("../models/userModel");
const userSchema = require("../schemas/userSchema");
const validate = require("../helpers/validate");
const { successResponse, errorResponse } = require("../utils/response");
const { User } = require("../models/userModel");
const { Purchase } = require("../models/purchaseModel");
const { Product } = require("../models/productModel");
const { Diagnostic } = require("../models/diagnosticModel");
const { Discovery } = require("../models/discoveryModel");
const { CoachingSession } = require("../models/coachingSessionModel");
const { buildKajabiDiagnosticContext } = require("./kajabi");
const listUsers = async (_req, res) => {
  try {
    const users = await User.findAll({
      where: { role: "user" },
      attributes: { exclude: ["password"] },
      include: [
        {
          model: Diagnostic,
          required: false,
        },
        {
          model: Discovery,
          required: false,
        },
      ],
      order: [["createdAt", "DESC"]],
    });

    // Add report counts to each user
    const usersWithReportCounts = users.map((user) => {
      const userJson = user.toJSON();

      // Check if Diagnostics exists and has items, and if data.pdfUrls exists
      const diagnosticCount =
        userJson.Diagnostics &&
        userJson.Diagnostics.length > 0 &&
        userJson.Diagnostics[0].data &&
        Array.isArray(userJson.Diagnostics[0].data.pdfUrls)
          ? userJson.Diagnostics[0].data.pdfUrls.length
          : 0;
      const discoveryCount =
        userJson.Discoveries && Array.isArray(userJson.Discoveries)
          ? userJson.Discoveries.length
          : 0;
      return {
        ...userJson,
        diagnosticCount,
        discoveryCount,
        totalReportCount: diagnosticCount + discoveryCount,
      };
    });

    return successResponse(res, "Users fetched", usersWithReportCounts);
  } catch (err) {
    console.error("[listUsers] Error:", err);
    return errorResponse(res, err.message || "Failed to fetch users", 500);
  }
};
const userReport = async (_req, res) => {
  try {
    const id = _req.params.id;
    const users = await User.findOne({
      where: { id },
      attributes: { exclude: ["password"] },
      include: [
        {
          model: Diagnostic,
          required: false,
        },
        {
          model: Discovery,
          required: false,
        },
      ],
      order: [["createdAt", "DESC"]],
    });

    // Add report counts to each user
    if (!users) {
      return errorResponse(res, "User not found", 404);
    }

    const userJson = users.toJSON();

    // Check if Diagnostics exists and has items, and if data.pdfUrls exists
    const diagnosticCount =
      userJson.Diagnostics &&
      userJson.Diagnostics.length > 0 &&
      userJson.Diagnostics[0].data &&
      Array.isArray(userJson.Diagnostics[0].data.pdfUrls)
        ? userJson.Diagnostics[0].data.pdfUrls.length
        : 0;
    const discoveryCount =
      userJson.Discoveries && Array.isArray(userJson.Discoveries)
        ? userJson.Discoveries.length
        : 0;

    let pdf =
      userJson.Diagnostics &&
      userJson.Diagnostics.length > 0 &&
      userJson.Diagnostics[0].data &&
      Array.isArray(userJson.Diagnostics[0].data.pdfUrls)
        ? userJson.Diagnostics[0].data.pdfUrls
        : null;
    return successResponse(res, "Users fetched", {
      diagnosticCount,
      pdf,
    });
  } catch (err) {
    console.error("[listUsers] Error:", err);
    return errorResponse(res, err.message || "Failed to fetch users", 500);
  }
};
const createUser = async (req, res) => {
  const payload = validate(userSchema, req.body);
  const findUser = await userModel.findOne(payload.email);
  if (findUser) {
    return errorResponse(res, "User with this email already exists", 401);
  }
  const user = await userModel.create(payload);
  return successResponse(res, "User created", user, 201);
};

const getMe = async (req, res) => {
  const user = await User.findByPk(req.user.sub, {
    attributes: { exclude: ["password"] },
    include: [
      { model: Purchase, include: [{ model: Product }] },
      { model: Diagnostic },
      { model: Discovery },
      { model: CoachingSession },
    ],
  });

  if (!user) {
    return errorResponse(res, "User not found", 404);
  }

  return successResponse(res, "User fetched", user);
};
/**
 * Updates user's club membership status in the database
 * Calls buildKajabiDiagnosticContext once and saves the membership info
 * Returns all the data from buildKajabiDiagnosticContext for reuse
 */
const updateUserClubMembership = async ({
  email,
  name,
  assessmentIds = [],
}) => {
  // Find or create user first
  const user = await findOrCreateCreatorUser({ email, name });
  console.log("using kajabi in ", updateUserClubMembership);

  // Get Kajabi context to check membership (this is the only call to buildKajabiDiagnosticContext)
  const {
    diagnosticContext,
    courseAssessments,
    normalizedProducts,
    normalizedOffers,
    metrics,
    customerData,
    attributes,
    contactId,
    siteId,
  } = await buildKajabiDiagnosticContext({
    email,
    assessmentIds,
  });

  // Check if user is Creator Club member
  const isCreatorClub = isCreatorClubMember(diagnosticContext);

  // Update user membership column with club membership info
  const membership = {
    isCreatorClub,
    lastUpdated: new Date().toISOString(),
    products: diagnosticContext.products || [],
    offers: diagnosticContext.offers || [],
  };

  await user.update({ membership });

  return {
    user,
    isCreatorClub,
    diagnosticContext,
    courseAssessments,
    normalizedProducts,
    normalizedOffers,
    metrics,
    customerData,
    attributes,
    contactId,
    siteId,
  };
};
const isCreatorClubMember = (context = {}) => {
  const hasProduct = (context.products || []).some((p) =>
    (p.title || "").toLowerCase().includes("creator club")
  );
  const hasOffer = (context.offers || []).some((o) =>
    (o.title || "").toLowerCase().includes("creator club")
  );
  return hasProduct || hasOffer;
};
const findOrCreateCreatorUser = async ({ email, name }) => {
  let user = await User.findOne({ where: { email } });

  if (!user) {
    user = await User.create({
      email,
      name,
    });
  }

  return user;
};

module.exports = {
  listUsers,
  createUser,
  getMe,
  userReport,
  updateUserClubMembership,
};
