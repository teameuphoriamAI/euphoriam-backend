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
const { sequelize } = require("../config/sequelize");
const { Op } = require("sequelize");
const {
  loadDiagnosticState,
  loadLatestDiscoveryMetrics,
} = require("../helpers/euphoriamChatbot");
const { sendEmailBasic } = require("../utils/email");
const { otpEmailTemplate } = require("../utils/emailTemplate/verifyOTP");
const {
  unauthorizedAccessEmailTemplate,
} = require("../utils/emailTemplate/unauthorizedAccessEmailTemplate");
const { findOrCreateCreatorUser } = require("./diagnosticController");
const jwt = require("jsonwebtoken");
const { signAccessToken } = require("../utils/tokens");

const listUsers = async (_req, res) => {
  try {
    // First, get users without heavy includes to avoid timeout
    const users = await User.findAll({
      where: { role: "user" },
      attributes: { exclude: ["password"] },
      order: [["createdAt", "DESC"]],
      limit: 1000, // Add a reasonable limit
    });

    // If no users, return early
    if (users.length === 0) {
      return successResponse(res, "Users fetched", []);
    }

    // Get user IDs for batch counting
    const userIds = users.map((user) => user.id);

    // Get diagnostic counts using Sequelize count with grouping
    const diagnosticCountsData = await Diagnostic.findAll({
      where: {
        userId: {
          [Op.in]: userIds,
        },
      },
      attributes: [
        "userId",
        [sequelize.fn("COUNT", sequelize.col("id")), "count"],
      ],
      group: ["userId"],
      raw: true,
    });

    // Get discovery counts using Sequelize count with grouping
    const discoveryCountsData = await Discovery.findAll({
      where: {
        userId: {
          [Op.in]: userIds,
        },
      },
      attributes: [
        "userId",
        [sequelize.fn("COUNT", sequelize.col("id")), "count"],
      ],
      group: ["userId"],
      raw: true,
    });

    // Create lookup maps for counts
    const diagnosticCountMap = {};
    if (Array.isArray(diagnosticCountsData)) {
      diagnosticCountsData.forEach((item) => {
        diagnosticCountMap[item.userId] = parseInt(item.count) || 0;
      });
    }

    const discoveryCountMap = {};
    if (Array.isArray(discoveryCountsData)) {
      discoveryCountsData.forEach((item) => {
        discoveryCountMap[item.userId] = parseInt(item.count) || 0;
      });
    }

    // Add report counts to each user
    const usersWithReportCounts = users.map((user) => {
      const userJson = user.toJSON();
      const diagnosticCount = diagnosticCountMap[user.id] || 0;
      const discoveryCount = discoveryCountMap[user.id] || 0;

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
  //  const salt = await bcrypt.genSalt(10);
  //       const hashedPassword = await bcrypt.hash(payload.password, salt);
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
    (p.title || "").toLowerCase().includes("creator club"),
  );
  const hasOffer = (context.offers || []).some((o) =>
    (o.title || "").toLowerCase().includes("creator club"),
  );
  return hasProduct || hasOffer;
};

/**
 * Get comprehensive user profile data including metrics, goals, personal data, and membership
 */
const getUserProfile = async (req, res) => {
  try {
    const { email } = req.user;

    if (!email) {
      return errorResponse(res, " email is required", 400);
    }

    // Find user
    const user = await User.findOne({
      where: { email },
      attributes: { exclude: ["password"] },
    });

    if (!user) {
      return errorResponse(res, "User not found", 404);
    }

    // Get current metrics

    const { existingDiagnostic, diagnosticMetrics } = await loadDiagnosticState(
      user.email,
    );
    const { latestDiscoveryMetrics } = await loadLatestDiscoveryMetrics(
      existingDiagnostic,
      diagnosticMetrics,
    );

    // Use latest discovery metrics if available, otherwise use diagnostic metrics
    const currentMetrics = latestDiscoveryMetrics || diagnosticMetrics || {};

    // Get discovery counts
    const discoveries = await Discovery.findAll({
      where: { userId: user.id },
      attributes: ["discoveryType"],
    });

    const discoveryCounts = {
      alignment: 0,
      freedom: 0,
      prosperity: 0,
      integrated: 0,
      total: discoveries.length,
    };

    discoveries.forEach((d) => {
      const type = d.discoveryType || "integrated";
      if (discoveryCounts.hasOwnProperty(type)) {
        discoveryCounts[type]++;
      }
    });

    // Extract goals from latest report (diagnostic or discovery) - from report text directly
    let goals = [];
    let firstCorrection = null;
    let angleOfGrowth = null;
    try {
      // Get latest diagnostic report
      const latestDiagnostic = await Diagnostic.findOne({
        where: { email: user.email },
        order: [["updatedAt", "DESC"]],
      });

      // Get latest discovery report
      const latestDiscovery = await Discovery.findOne({
        where: { userId: user.id },
        order: [["updatedAt", "DESC"]],
      });

      // Determine which is latest and get the report text
      let latestReportText = null;
      let reportSource = null;

      if (latestDiagnostic && latestDiscovery) {
        const diagDate = new Date(latestDiagnostic.updatedAt);
        const discDate = new Date(latestDiscovery.updatedAt);
        if (diagDate > discDate) {
          latestReportText =
            latestDiagnostic.data?.aiReport || latestDiagnostic.report || null;
          reportSource = "diagnostic";
        } else {
          latestReportText =
            latestDiscovery.data?.newReport ||
            latestDiscovery.data?.previousReport ||
            null;
          reportSource = "discovery";
        }
      } else if (latestDiagnostic) {
        latestReportText =
          latestDiagnostic.data?.aiReport || latestDiagnostic.report || null;
        reportSource = "diagnostic";
      } else if (latestDiscovery) {
        latestReportText =
          latestDiscovery.data?.newReport ||
          latestDiscovery.data?.previousReport ||
          null;
        reportSource = "discovery";
      }

      if (latestReportText && typeof latestReportText === "string") {
        console.log(
          `[getUserProfile] Extracting goals from ${reportSource} report (${latestReportText.length} chars)`,
        );

        // Extract FIRST CORRECTION (the main goal)
        // Pattern 1: ### 10. FIRST CORRECTION or SECTION 10 — First Correction
        const firstCorrectionPatterns = [
          /(?:###?\s*10\.\s*FIRST\s+CORRECTION|SECTION\s*10\s*[—–-]\s*First\s*Correction|First\s+Correction\s*\(Updated\))[^\n]*\n([\s\S]{0,1500}?)(?=\n---|\n###|\n\n##|\nSECTION\s+\d|\nMETRICS\s+GAUGE|\nDATA\s+QUALITY)/i,
          // Pattern 2: Just "First Correction:" followed by content
          /First\s+Correction[:\s]*\n([\s\S]{0,1000}?)(?=\n---|\n###|\n\n##|\nSECTION)/i,
        ];

        for (const pattern of firstCorrectionPatterns) {
          const match = latestReportText.match(pattern);
          if (match && match[1]) {
            let correctionText = match[1].trim();
            // Extract the bolded/quoted part which is the actual correction
            const quotedMatch = correctionText.match(
              />\s*\*\*([^*]+)\*\*|>\s*\*([^*]+)\*|>\s*"([^"]+)"|>\s*'([^']+)'|"([^"]{20,300})"|'([^']{20,300})'|\*\*([^*\n]{20,300})\*\*/,
            );
            if (quotedMatch) {
              firstCorrection = (
                quotedMatch[1] ||
                quotedMatch[2] ||
                quotedMatch[3] ||
                quotedMatch[4] ||
                quotedMatch[5] ||
                quotedMatch[6] ||
                quotedMatch[7]
              ).trim();
            } else {
              // Take the first meaningful sentence
              const sentences = correctionText
                .split(/[.!?]/)
                .filter((s) => s.trim().length > 20);
              if (sentences.length > 0) {
                firstCorrection = sentences[0]
                  .trim()
                  .replace(/^[>\s*]+/, "")
                  .trim();
              }
            }
            if (firstCorrection) {
              console.log(
                "[getUserProfile] Extracted First Correction:",
                firstCorrection.substring(0, 100),
              );
              break;
            }
          }
        }

        // Extract ANGLE OF GROWTH
        const angleOfGrowthPatterns = [
          /(?:###?\s*9\.\s*ANGLE\s+OF\s+GROWTH|SECTION\s*9\s*[—–-]\s*Angle\s*of\s*Growth|Angle\s+of\s+Growth\s*\(Updated\))[^\n]*\n([\s\S]{0,1500}?)(?=\n---|\n###|\n\n##|\nSECTION\s+10|\nFirst\s+Correction)/i,
          /Angle\s+of\s+Growth[:\s]*\n([\s\S]{0,1000}?)(?=\n---|\n###|\n\n##)/i,
        ];

        for (const pattern of angleOfGrowthPatterns) {
          const match = latestReportText.match(pattern);
          if (match && match[1]) {
            let angleText = match[1].trim();
            // Look for "From X → to Y" pattern
            const fromToMatch = angleText.match(
              /(?:From|from)\s*["']?([^"'\n→–-]+)["']?\s*[→–-]+\s*(?:to)?\s*["']?([^"'\n]+?)["']?(?:\.|$|\n)/i,
            );
            if (fromToMatch) {
              angleOfGrowth = `From "${fromToMatch[1].trim()}" to "${fromToMatch[2].trim()}"`;
            } else {
              // Extract the current angle or growth direction
              const currentAngleMatch = angleText.match(
                /\*\*Current\s+Angle:\*\*\s*\n?([^\n*]+)|Current\s+Angle[:\s]+([^\n]+)/i,
              );
              if (currentAngleMatch) {
                angleOfGrowth = (
                  currentAngleMatch[1] || currentAngleMatch[2]
                ).trim();
              } else {
                // Take first meaningful line
                const lines = angleText
                  .split("\n")
                  .filter(
                    (l) =>
                      l.trim().length > 20 && !l.match(/^Not:|^Why:|^\*\*/),
                  );
                if (lines.length > 0) {
                  angleOfGrowth = lines[0].trim();
                }
              }
            }
            if (angleOfGrowth) {
              console.log(
                "[getUserProfile] Extracted Angle of Growth:",
                angleOfGrowth.substring(0, 100),
              );
              break;
            }
          }
        }

        // Build goals array
        if (firstCorrection) {
          goals.push({
            type: "first_correction",
            title: "First Correction",
            description: firstCorrection,
          });
        }
        if (angleOfGrowth) {
          goals.push({
            type: "angle_of_growth",
            title: "Angle of Growth",
            description: angleOfGrowth,
          });
        }

        // Also try to extract Discovery Recommendations if present
        const discoveryRecsMatch = latestReportText.match(
          /DISCOVERY\s+RECOMMENDATIONS[^\n]*\n([\s\S]{0,2000}?)(?=\n---|\n###|\nUNLIMITED\s+CREATOR)/i,
        );
        if (discoveryRecsMatch && discoveryRecsMatch[1]) {
          const recsText = discoveryRecsMatch[1];

          // Extract Alignment Discoveries count
          const alignmentMatch = recsText.match(
            /(\d+)\s*Alignment\s+Discover(?:y|ies)/i,
          );
          if (alignmentMatch) {
            goals.push({
              type: "discovery_recommendation",
              title: "Alignment Discoveries",
              description: `Complete ${alignmentMatch[1]} Alignment Discoveries`,
            });
          }

          // Extract Freedom Discoveries count
          const freedomMatch = recsText.match(
            /(\d+)\s*Freedom\s+Discover(?:y|ies)/i,
          );
          if (freedomMatch) {
            goals.push({
              type: "discovery_recommendation",
              title: "Freedom Discoveries",
              description: `Complete ${freedomMatch[1]} Freedom Discoveries`,
            });
          }

          // Extract Prosperity Discoveries count
          const prosperityMatch = recsText.match(
            /(\d+)\s*Prosperity\s+Discover(?:y|ies)/i,
          );
          if (prosperityMatch) {
            goals.push({
              type: "discovery_recommendation",
              title: "Prosperity Discoveries",
              description: `Complete ${prosperityMatch[1]} Prosperity Discoveries`,
            });
          }
        }

        console.log(
          `[getUserProfile] Extracted ${goals.length} goals from ${reportSource} report`,
        );
      } else {
        console.log("[getUserProfile] No report text found for user");
      }
    } catch (error) {
      console.error(
        "[getUserProfile] Error extracting goals from report:",
        error,
      );
      // Fallback to metadata goals
      goals = user.metadata?.goals || [];
    }

    // Extract personal data
    const personalData = {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      status: user.status,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
      metadata: user.metadata || {},
    };

    // Extract membership level
    const membership = user.membership || {};
    const membershipLevel = {
      isCreatorClub: membership.isCreatorClub || false,
      level: membership.isCreatorClub ? "Creator Club" : "Standard",
      products: membership.products || [],
      offers: membership.offers || [],
      lastUpdated: membership.lastUpdated || null,
    };

    // Format metrics
    const formattedMetrics = {
      signalOutput: currentMetrics.signalOutput || 0,
      qgcActivation: currentMetrics.qgcActivation || 0,
      consciousnessLevel:
        Number(currentMetrics.consciousnessLevel) <= 5
          ? (currentMetrics.consciousnessLevel / 5) * 100
          : currentMetrics.consciousnessLevel || 0,
      gravity: currentMetrics.gravity || 0,
      signalCoherence: currentMetrics.signalCoherence || 0,
      lastUpdated:
        existingDiagnostic?.updatedAt || existingDiagnostic?.createdAt || null,
    };

    return successResponse(res, "User profile fetched successfully", {
      metrics: formattedMetrics,
      goals: goals,
      personalData: personalData,
      membership: membershipLevel,
      discoveryCounts: discoveryCounts,
    });
  } catch (error) {
    console.error("[getUserProfile] Error:", error);
    return errorResponse(res, "Failed to fetch user profile", 500);
  }
};

const formatMsToMinSec = (ms) => {
  const min = Math.floor(ms / 60000);
  const sec = Math.floor((ms % 60000) / 1000);
  return `${min} min ${sec} sec`;
};

const verifyOTP = async (req, res) => {
  try {
    const { email, otp } = req.body;
    if (!email || !otp)
      return errorResponse(res, "Email and OTP are required", 400);

    const user = await User.findOne({
      where: { email: email.toLowerCase().trim() },
    });
    if (!user) return errorResponse(res, "User not found", 404);
    if (!user.requestedOTP) {
      await sendEmailBasic(
        user.email,
        "⚠️ Alert: Suspicious Account Activity",
        unauthorizedAccessEmailTemplate(user.name),
      );

      return errorResponse(res, "No OTP requested for this user", 400);
    }
    const now = new Date();

    // Cooldown check due to failed attempts
    if (user.otpCooldown && user.otpCooldown > now) {
      const diffMs = user.otpCooldown - now;
      return errorResponse(
        res,
        `Too many failed attempts. Try again in ${formatMsToMinSec(diffMs)}.`,
        429,
      );
    }

    // Expired OTP
    if (!user.otp || !user.otpExpiry || user.otpExpiry < now) {
      return errorResponse(
        res,
        "OTP has expired. Please request a new one.",
        400,
      );
    }

    // Invalid OTP
    if (otp !== user.otp) {
      user.otpAttempts = (user.otpAttempts || 0) + 1;

      if (user.otpAttempts >= 3) {
        // Lock user for 5 min
        user.otpCooldown = new Date(Date.now() + 10 * 60 * 1000);
        user.otpAttempts = 0;
        user.otp = null;
        user.otpExpiry = null;
        await user.save();

        return errorResponse(
          res,
          "Maximum attempts reached. Please wait 5 min before trying again.",
          429,
        );
      }

      await user.save();
      return errorResponse(
        res,
        `Invalid OTP. ${3 - user.otpAttempts} attempts remaining.`,
        400,
      );
    }

    // ✅ OTP verified successfully
    user.otp = null;
    user.otpExpiry = null;
    user.otpAttempts = 0;
    user.otpCooldown = null;
    user.resendOTPCount = 0;
    user.resendOTPCooldown = null;
    user.requestedOTP = false;
    await user.save();

    const token = signAccessToken({
      sub: user.id,
      userId: user.id,
      name: user.name,
      email: user.email,
    });

    return successResponse(res, "OTP verified successfully", {
      token,
      expiresIn: process.env.JWT_ACCESS_EXPIRES_IN || "15m",
    });
  } catch (error) {
    console.error("[verifyOTP] Error:", error);
    return errorResponse(res, "Failed to verify OTP", 500);
  }
};

const resendOTP = async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return errorResponse(res, "Email is required", 400);

    const user = await User.findOne({
      where: { email: email.toLowerCase().trim() },
    });
    if (!user) return errorResponse(res, "User not found", 404);
    if (user.requestedOTP === false) {
      return errorResponse(res, "No OTP requested for this user", 400);
    }
    const now = new Date();

    // Check if cooldown exists
    if (user.resendOTPCooldown && user.resendOTPCooldown > now) {
      const diffMs = user.resendOTPCooldown - now;
      const min = Math.floor(diffMs / 60000);
      const sec = Math.floor((diffMs % 60000) / 1000);

      return errorResponse(
        res,
        `Please wait ${min} min ${sec} sec before requesting a new OTP.`,
        429,
      );
    }

    // Reset cooldown if expired
    if (user.resendOTPCooldown && user.resendOTPCooldown <= now) {
      user.resendOTPCooldown = null;
      user.resendOTPCount = 0;
    }

    // Check resend limit
    if (user.resendOTPCount >= 3) {
      user.resendOTPCooldown = new Date(Date.now() + 5 * 60 * 1000); // 5 min
      user.resendOTPCount = 0;
      await user.save();

      return errorResponse(
        res,
        "Resend limit reached. Please wait 5 minutes.",
        429,
      );
    }

    // Generate new OTP
    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    user.otp = otp;
    user.otpExpiry = new Date(Date.now() + 10 * 60 * 1000); // 10 min
    user.otpAttempts = 0;
    user.resendOTPCount += 1;

    await user.save();
    await sendEmailBasic(
      user.email,
      "Your OTP Code",
      otpEmailTemplate(user.name, otp, "login verification", "10 minutes"),
    );

    return successResponse(res, "OTP resent successfully", {
      expiresIn: "10 minutes",
      remainingResends: 3 - user.resendOTPCount,
    });
  } catch (error) {
    console.error("[resendOTP] Error:", error);
    return errorResponse(res, "Failed to resend OTP", 500);
  }
};

module.exports = {
  listUsers,
  createUser,
  getMe,
  userReport,
  updateUserClubMembership,
  getUserProfile,
  verifyOTP,
  resendOTP,
};
