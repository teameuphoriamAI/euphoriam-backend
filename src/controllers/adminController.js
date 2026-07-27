const { Op } = require("sequelize");
const crypto = require("crypto");
const { User } = require("../models/userModel");
const { Diagnostic } = require("../models/diagnosticModel");
const { Discovery } = require("../models/discoveryModel");
const { DiscoveryChat } = require("../models/discoveryChat");
const { Chat } = require("../models/chatModel");
const { Prompt, PromptHistory } = require("../models/promptModel");
const { UserSession } = require("../models/userSessionModel");
const { successResponse, errorResponse } = require("../utils/response");
const { createPromptSchemaValidator } = require("../utils/validator");
const validate = require("../helpers/validate");
const { parseWebVTT } = require("../utils/webvttParser");
const { extractTextFromPdf } = require("../utils/pdfParser");
// const Joi = require("joi");
const { createEmbeddings } = require("../config/Embedding");
const { generateSessionSummary } = require("../config/sessionSummary");
const { cleanTranscriptText, invalidateLatestPromptCache } = require("../helpers/euphoriamChatbot");
const { PromptType, UserStatus, UserRole } = require("../utils/types");
const { getMarketResearchData, getMarketResearchRows } = require("../helpers/marketResearchAggregator");
const {
  userDiagnosticWhere,
  formatDiagnosticForAdmin,
  loadAdminUserStage1,
  countDiagnosticsByCategory,
  mapResistanceCountForUser,
  formatMembershipForAdmin,
  resolveAdminMembershipTier,
  computeUserProgress,
} = require("../helpers/adminUserData");
const { DomainGoal } = require("../models/domainGoalModel");
const { UserStage1Meta } = require("../models/userStage1MetaModel");
const openai = require("../config/openai");
const { withDbSlot, sequelize } = require("../config/sequelize");

const classicDiagnosticWhere = {
  report_type: { [Op.ne]: "invisible_red_line" },
  [Op.and]: [sequelize.literal(`NOT (data ? 'map_resistance_domain')`)],
};

const bustPromptCache = (type) => {
  if (!type) return;
  invalidateLatestPromptCache(type);
  if (
    type === PromptType.BRAINPROMPT ||
    type === PromptType.COACHBRAINPROMPT
  ) {
    invalidateLatestPromptCache(PromptType.BRAINPROMPT);
    invalidateLatestPromptCache(PromptType.COACHBRAINPROMPT);
  }
};

// Vector store service for semantic search
const {
  storeSessionInVectorDB,
  searchSessions,
} = require("../services/vectorStoreService");
// Admin login (uses existing auth but ensures admin role)
const adminLogin = async (req, res) => {
  // This will be handled by the existing auth/login endpoint
  // We just need to verify admin role
  if (req.user && req.user.role === "admin") {
    return successResponse(res, "Admin login successful", {
      user: req.user,
    });
  }
  return errorResponse(res, "Admin access required", 403);
};

// Get all users
const getAllUsers = async (req, res) => {
  try {
    const users = await User.findAll({
      order: [["createdAt", "DESC"]],
      attributes: { exclude: ["password"] },
    });

    const userIds = users.map((u) => u.id);

    const [mapResistanceRows, coachMetaRows, goalRows] = await Promise.all([
      DomainGoal.findAll({
        where: { userId: { [Op.in]: userIds }, mapResistanceComplete: true },
        attributes: ["userId"],
        raw: true,
      }).catch(() => []),
      UserStage1Meta.findAll({
        where: { userId: { [Op.in]: userIds } },
        attributes: ["userId", "coachSessionLog", "activeDomains", "primaryDomain", "proofLogs"],
        raw: true,
      }).catch(() => []),
      DomainGoal.findAll({
        where: {
          userId: { [Op.in]: userIds },
          [Op.or]: [
            { goalTitle: { [Op.ne]: null } },
            { desiredOutcome: { [Op.ne]: null } },
          ],
        },
        attributes: ["userId", "goalsComplete", "status"],
        raw: true,
      }).catch(() => []),
    ]);

    const mapResistanceCountMap = {};
    for (const row of mapResistanceRows) {
      mapResistanceCountMap[row.userId] = (mapResistanceCountMap[row.userId] || 0) + 1;
    }

    const coachCountMap = {};
    const activeDomainCountMap = {};
    const proofCountMap = {};
    for (const row of coachMetaRows) {
      const sessions = Array.isArray(row.coachSessionLog) ? row.coachSessionLog : [];
      coachCountMap[row.userId] = sessions.length;
      const active = Array.isArray(row.activeDomains) ? row.activeDomains : [];
      activeDomainCountMap[row.userId] = active.length;
      proofCountMap[row.userId] = Array.isArray(row.proofLogs) ? row.proofLogs.length : 0;
    }

    const goalsCountMap = {};
    const goalsCompleteMap = {};
    for (const row of goalRows) {
      if (row.status === "draft") continue;
      goalsCountMap[row.userId] = (goalsCountMap[row.userId] || 0) + 1;
      if (row.goalsComplete) {
        goalsCompleteMap[row.userId] = (goalsCompleteMap[row.userId] || 0) + 1;
      }
    }

    const usersWithReports = await Promise.all(
      users.map(async (user) => {
        const reportCounts = await countDiagnosticsByCategory(user);
        const membership = formatMembershipForAdmin(user);
        const progress = computeUserProgress({
          membership,
          stage1: {
            mapResistanceCompleteCount: mapResistanceCountMap[user.id] ?? reportCounts.mapResistance,
            coachSessionCount: coachCountMap[user.id] || 0,
            proofLogCount: proofCountMap[user.id] || 0,
            activeDomains: Array.from({ length: activeDomainCountMap[user.id] || 0 }),
          },
          redlineCount: reportCounts.redline,
          goalsSetOverride: goalsCountMap[user.id] || 0,
          goalsCompleteOverride: goalsCompleteMap[user.id] || 0,
        });

        return {
          ...user.toJSON(),
          membership,
          membershipTier: membership.tier,
          membershipLabel: membership.label,
          reportCount: reportCounts.totalReports,
          totalReportCount: reportCounts.totalReports,
          redlineCount: reportCounts.redline,
          mapResistanceCount:
            mapResistanceCountMap[user.id] ?? reportCounts.mapResistance,
          coachSessionCount: coachCountMap[user.id] || 0,
          proofLogCount: proofCountMap[user.id] || 0,
          goalsCount: goalsCountMap[user.id] || 0,
          goalsCompleteCount: goalsCompleteMap[user.id] || 0,
          activeDomainCount: activeDomainCountMap[user.id] || 0,
          progressPhase: progress.phase,
          progressScore: progress.progressScore,
        };
      }),
    );

    return successResponse(res, "Users fetched", usersWithReports);
  } catch (error) {
    console.error("[admin] Error fetching users:", error);
    return errorResponse(res, "Failed to fetch users", 500);
  }
};
//delete user
const deleteUser = async (req, res) => {
  try {
    const { id } = req.params;

    const user = await User.findByPk(id);
    if (!user) {
      return errorResponse(res, "User not found", 404);
    }

    // Prevent deleting admin accounts
    if (user.role === UserRole.ADMIN) {
      return errorResponse(res, "Admin users cannot be deleted", 403);
    }

    // Delete funnel Q&A chats first (while funnel_access rows still exist for the subquery).
    const normalizedEmail = String(user.email || "").trim().toLowerCase();
    if (normalizedEmail) {
      await withDbSlot(() =>
        sequelize.query(
          `DELETE FROM chat
           WHERE "userId" = :userId
              OR LOWER(data->>'email') = :email
              OR data->>'funnel_access_id' IN (
                SELECT id::text FROM funnel_access WHERE LOWER(email) = :email
              )`,
          { replacements: { userId: user.id, email: normalizedEmail } },
        ),
      );
      await withDbSlot(() =>
        sequelize.query(`DELETE FROM funnel_access WHERE LOWER(email) = :email`, {
          replacements: { email: normalizedEmail },
        }),
      );
    } else {
      await Chat.destroy({ where: { userId: user.id } });
    }

    await Diagnostic.destroy({
      where: {
        [Op.or]: [{ email: user.email }, { userId: user.id }],
      },
    });

    await Discovery.destroy({
      where: { userId: user.id },
    });

    await user.destroy();

    return successResponse(res, "User deleted successfully");
  } catch (error) {
    console.error("[admin] delete user error:", error);
    return errorResponse(res, "Failed to delete user", 500);
  }
};

//change status
const changeUserStatus = async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;
    console.log("id", req.params, req.query, status);
    if (!Object.values(UserStatus).includes(status)) {
      return errorResponse(res, "Invalid status value", 400);
    }

    const user = await User.findOne({ where: { id: id } });
    if (!user) {
      return errorResponse(res, "User not found", 404);
    }

    user.status = status;
    await user.save();

    return successResponse(res, "User status updated", user);
  } catch (error) {
    console.error("[admin] change status error:", error);
    return errorResponse(res, "Failed to update status", 500);
  }
};
// Get user reports
const getUserReports = async (req, res) => {
  try {
    const userId = parseInt(req.params.userId, 10);
    if (Number.isNaN(userId)) {
      return errorResponse(res, "Invalid user ID", 400);
    }

    const user = await User.findByPk(userId, {
      attributes: { exclude: ["password"] },
    });

    if (!user) {
      return errorResponse(res, "User not found", 404);
    }

    const userIdNum = user.id;

    const [diagnostics, stage1] = await Promise.all([
      Diagnostic.findAll({
        where: userDiagnosticWhere(user),
        order: [["createdAt", "DESC"]],
      }),
      loadAdminUserStage1(userIdNum),
    ]);

    const membership = formatMembershipForAdmin(user);
    const formattedDiagnostics = diagnostics
      .map(formatDiagnosticForAdmin)
      .filter((d) => d.category === "redline" || d.category === "map_resistance");
    const redlineReports = formattedDiagnostics.filter((d) => d.category === "redline");
    const mapResistanceReports = formattedDiagnostics.filter(
      (d) => d.category === "map_resistance",
    );
    const progress = computeUserProgress({
      membership,
      stage1,
      redlineCount: redlineReports.length,
    });

    return successResponse(res, "User reports fetched", {
      user: user.toJSON(),
      membership,
      progress,
      redlineReports,
      mapResistanceReports,
      stage1,
      totalReports: redlineReports.length + stage1.mapResistanceCompleteCount,
      counts: {
        redline: redlineReports.length,
        mapResistance: Math.max(
          mapResistanceReports.length,
          stage1.mapResistanceCompleteCount,
        ),
        coachSessions: stage1.coachSessionCount,
        proofLogs: stage1.proofLogCount,
        goalsSet: stage1.goalsSetCount,
        goalsComplete: stage1.goalsCompleteCount,
        activeDomains: stage1.activeDomains.length,
      },
    });
  } catch (error) {
    console.error("[admin] Error fetching user reports:", error);
    return errorResponse(res, "Failed to fetch user reports", 500);
  }
};

// Get all prompts (latest highlighted)
const getAllPrompts = async (req, res) => {
  try {
    const prompts = await Prompt.findAll({
      order: [["updatedAt", "DESC"]],
    });

    return successResponse(res, "Prompts fetched", prompts);
  } catch (error) {
    console.error("[admin] Error fetching prompts:", error);
    return errorResponse(res, "Failed to fetch prompts", 500);
  }
};

// Get prompt by ID (preview)
const getPromptById = async (req, res) => {
  try {
    const { id } = req.params;
    console.log("Fetching prompt with ID:", id);
    console.log("Fetching prompt with ID:", req.query.id);
    const prompt = await Prompt.findByPk(id, {
      include: [
        {
          model: PromptHistory,
          as: "history",
          order: [["createdAt", "DESC"]],
        },
      ],
    });

    if (!prompt) {
      return errorResponse(res, "Prompt not found", 404);
    }

    return successResponse(res, "Prompt fetched", prompt);
  } catch (error) {
    console.error("[admin] Error fetching prompt:", error);
    return errorResponse(res, "Failed to fetch prompt", 500);
  }
};

// Create new prompt
const createPrompt = async (req, res) => {
  try {
    console.log("🚀 [createPrompt] Request received");
    console.log("📥 Raw body:", req.body);
    console.log("👤 User:", req.user);

    const { name, type, content, isActive } = validate(
      createPromptSchemaValidator,
      req.body,
    );

    if (!Object.values(PromptType).includes(type)) {
      return errorResponse(
        res,
        `Type should be one of: ${Object.values(PromptType).join(", ")}`,
        400,
      );
    }
    console.log("✅ Validation passed:", {
      name,
      type,
      isActive,
      contentLength: content?.length,
    });

    let version = 1;

    // 🔒 Only touch old prompt if new one is active
    if (isActive === true) {
      console.log("🔍 Checking existing active prompt for type:", type);

      const existingPrompt = await Prompt.findOne({
        where: {
          type,
          isActive: true,
        },
        order: [["createdAt", "DESC"]],
      });

      if (existingPrompt) {
        console.log("⚠️ Existing active prompt found:", {
          id: existingPrompt.id,
          version: existingPrompt.version,
        });

        await existingPrompt.update({ isActive: false });

        console.log("♻️ Existing prompt deactivated:", existingPrompt.id);

        version = existingPrompt.version + 1;
      } else {
        console.log("✅ No active prompt found for this type");
      }
    } else {
      console.log("📝 Creating prompt as INACTIVE");
    }

    console.log("🧱 Creating new prompt with version:", version);

    const prompt = await Prompt.create({
      name,
      type,
      content,
      version,
      isActive,
      createdBy: req.user?.sub || null,
    });

    console.log("✅ Prompt created:", {
      id: prompt.id,
      version: prompt.version,
      isActive: prompt.isActive,
    });

    console.log("🕒 Saving prompt history...");

    await PromptHistory.create({
      promptId: prompt.id,
      name,
      type,
      content,
      version,
      changedBy: req.user?.sub || null,
      changeType: "create",
    });

    console.log("📚 Prompt history saved");

    bustPromptCache(type);

    return successResponse(res, "Prompt created", prompt, 201);
  } catch (error) {
    console.error("❌ [createPrompt] Error occurred");
    console.error("🧨 Error message:", error.message);
    console.error("📍 Error stack:", error.stack);
    console.error("📦 Error object:", error);

    return errorResponse(res, "Failed to create prompt", 500);
  }
};

// Update prompt
const updatePrompt = async (req, res) => {
  try {
    console.log("🚀 [updatePrompt] Request received", req.params);

    const { id } = req.params;
    const updates = validate(createPromptSchemaValidator, req.body);

    const prompt = await Prompt.findByPk(id);
    if (!prompt) {
      console.log("❌ Prompt not found:", id);
      return errorResponse(res, "Prompt not found", 404);
    }

    console.log("📄 Existing prompt:", {
      id: prompt.id,
      type: prompt.type,
      isActive: prompt.isActive,
      version: prompt.version,
    });

    // Save current state to history BEFORE updating
    await PromptHistory.create({
      promptId: prompt.id,
      name: prompt.name,
      type: prompt.type,
      content: prompt.content,
      version: prompt.version,
      changedBy: req.user?.sub || null,
      changeType: "update",
    });

    // 🔒 If activating, deactivate all others FIRST
    if (updates.isActive === true) {
      console.log("♻️ Activating prompt, deactivating others of same type");

      await Prompt.update(
        { isActive: false },
        {
          where: {
            type: prompt.type,
            id: { [Op.ne]: prompt.id },
            isActive: true,
          },
        },
      );
    }

    // Only increment version if something actually changed
    const newVersion =
      JSON.stringify(updates) !==
      JSON.stringify({
        name: prompt.name,
        type: prompt.type,
        content: prompt.content,
        isActive: prompt.isActive,
      })
        ? prompt.version + 1
        : prompt.version;

    await prompt.update({
      ...updates,
      version: newVersion,
    });

    const updatedPrompt = await Prompt.findByPk(id);

    console.log("✅ Prompt updated:", {
      id: updatedPrompt.id,
      isActive: updatedPrompt.isActive,
      version: updatedPrompt.version,
    });

    bustPromptCache(prompt.type);
    if (updates.type && updates.type !== prompt.type) {
      bustPromptCache(updates.type);
    }

    return successResponse(res, "Prompt updated", updatedPrompt);
  } catch (error) {
    console.error("❌ [admin] Error updating prompt:", error);
    return errorResponse(res, "Failed to update prompt", 500);
  }
};

// Delete prompt
const deletePrompt = async (req, res) => {
  try {
    const { id } = req.params;
    const prompt = await Prompt.findByPk(id);

    if (!prompt) {
      return errorResponse(res, "Prompt not found", 404);
    }

    // Save to history before deleting
    await PromptHistory.create({
      promptId: prompt.id,
      name: prompt.name,
      type: prompt.type,
      content: prompt.content,
      version: prompt.version,
      metadata: prompt.metadata || {},
      changedBy: req.user?.sub || null,
      changeType: "delete",
    });

    // Soft delete (set isActive to false) or hard delete
    await prompt.destroy();

    return successResponse(res, "Prompt deleted", { id });
  } catch (error) {
    console.error("[admin] Error deleting prompt:", error);
    return errorResponse(res, "Failed to delete prompt", 500);
  }
};

// Get prompt history
const getPromptHistory = async (req, res) => {
  try {
    const { id } = req.params;
    const history = await PromptHistory.findAll({
      where: { promptId: id },
      order: [["createdAt", "DESC"]],
    });

    return successResponse(res, "Prompt history fetched", history);
  } catch (error) {
    console.error("[admin] Error fetching prompt history:", error);
    return errorResponse(res, "Failed to fetch prompt history", 500);
  }
};

// Get admin stats — aligned to product flow: Free → Creator Club / Silver / Accelerate
const getStats = async (req, res) => {
  try {
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    const [
      allUsers,
      totalRedlineReports,
      totalMapResistanceDomains,
      totalGoalsSet,
      stage1MetaRows,
      totalPrompts,
      activePrompts,
      recentRedlineReports,
      recentMapResistanceDomains,
      recentGoalsSet,
      recentUsers,
    ] = await Promise.all([
      User.findAll({
        where: { role: "user" },
        attributes: ["id", "name", "email", "membership", "createdAt"],
      }).catch(() => []),
      Diagnostic.count({ where: { report_type: "invisible_red_line" } }).catch(() => 0),
      DomainGoal.count({ where: { mapResistanceComplete: true } }).catch(() => 0),
      DomainGoal.count({
        where: {
          [Op.or]: [
            { goalTitle: { [Op.ne]: null } },
            { desiredOutcome: { [Op.ne]: null } },
          ],
          status: { [Op.ne]: "draft" },
        },
      }).catch(() => 0),
      UserStage1Meta.findAll({
        attributes: ["userId", "coachSessionLog", "proofLogs", "activeDomains"],
      }).catch(() => []),
      Prompt.count().catch(() => 0),
      Prompt.count({ where: { isActive: true } }).catch(() => 0),
      Diagnostic.count({
        where: {
          createdAt: { [Op.gte]: thirtyDaysAgo },
          report_type: "invisible_red_line",
        },
      }).catch(() => 0),
      DomainGoal.count({
        where: {
          mapResistanceComplete: true,
          updatedAt: { [Op.gte]: thirtyDaysAgo },
        },
      }).catch(() => 0),
      DomainGoal.count({
        where: {
          createdAt: { [Op.gte]: thirtyDaysAgo },
          [Op.or]: [
            { goalTitle: { [Op.ne]: null } },
            { desiredOutcome: { [Op.ne]: null } },
          ],
        },
      }).catch(() => 0),
      User.count({
        where: { createdAt: { [Op.gte]: thirtyDaysAgo }, role: "user" },
      }).catch(() => 0),
    ]);

    const usersByTier = { free: 0, bronze: 0, silver: 0, accelerate: 0 };
    for (const user of allUsers) {
      const tier = resolveAdminMembershipTier(user);
      usersByTier[tier] = (usersByTier[tier] || 0) + 1;
    }

    let totalCoachSessions = 0;
    let totalProofLogs = 0;
    let totalActiveDomainSlots = 0;
    let recentCoachSessions = 0;
    for (const row of stage1MetaRows) {
      const sessions = Array.isArray(row.coachSessionLog) ? row.coachSessionLog : [];
      totalCoachSessions += sessions.length;
      totalProofLogs += Array.isArray(row.proofLogs) ? row.proofLogs.length : 0;
      totalActiveDomainSlots += Array.isArray(row.activeDomains)
        ? row.activeDomains.length
        : 0;
      for (const session of sessions) {
        const started = session?.started_at || session?.created_at;
        if (started && new Date(started) >= thirtyDaysAgo) recentCoachSessions += 1;
      }
    }

    const topUsers = [];
    for (const user of allUsers) {
      try {
        const membership = formatMembershipForAdmin(user);
        const [reportCounts, mapResistanceCount, stage1Meta, goalsCount, goalsCompleteCount] =
          await Promise.all([
          countDiagnosticsByCategory(user),
          mapResistanceCountForUser(user.id).catch(() => 0),
          UserStage1Meta.findOne({
            where: { userId: user.id },
            attributes: ["coachSessionLog", "proofLogs", "activeDomains"],
          }).catch(() => null),
          DomainGoal.count({
            where: {
              userId: user.id,
              status: { [Op.ne]: "draft" },
              [Op.or]: [
                { goalTitle: { [Op.ne]: null } },
                { desiredOutcome: { [Op.ne]: null } },
              ],
            },
          }).catch(() => 0),
          DomainGoal.count({
            where: { userId: user.id, goalsComplete: true },
          }).catch(() => 0),
        ]);

        const stage1 = {
          mapResistanceCompleteCount: mapResistanceCount,
          coachSessionCount: Array.isArray(stage1Meta?.coachSessionLog)
            ? stage1Meta.coachSessionLog.length
            : 0,
          proofLogCount: Array.isArray(stage1Meta?.proofLogs)
            ? stage1Meta.proofLogs.length
            : 0,
          activeDomains: Array.isArray(stage1Meta?.activeDomains)
            ? stage1Meta.activeDomains
            : [],
        };
        const progress = computeUserProgress({
          membership,
          stage1,
          redlineCount: reportCounts.redline,
          goalsSetOverride: goalsCount,
          goalsCompleteOverride: goalsCompleteCount,
        });

        topUsers.push({
          id: user.id,
          name: user.name,
          email: user.email,
          membershipTier: membership.tier,
          membershipLabel: membership.label,
          progressPhase: progress.phase,
          progressScore: progress.progressScore,
          redlineReports: reportCounts.redline,
          mapResistanceReports: mapResistanceCount,
          coachSessions: stage1.coachSessionCount,
          proofLogs: stage1.proofLogCount,
          activeDomains: stage1.activeDomains.length,
          goalsSet: progress.goalsSet,
        });
      } catch (err) {
        console.error(`[admin] Error processing user ${user.id}:`, err);
      }
    }

    topUsers.sort((a, b) => b.progressScore - a.progressScore);

    const stats = {
      overview: {
        totalUsers: allUsers.length,
        usersByTier,
        totalRedlineReports,
        totalMapResistanceReports: totalMapResistanceDomains,
        totalGoalsSet,
        totalCoachSessions,
        totalProofLogs,
        totalActiveDomainSlots,
        totalReports: totalRedlineReports + totalMapResistanceDomains,
        totalPrompts,
        activePrompts,
      },
      recent: {
        redlineReportsLast30Days: recentRedlineReports,
        mapResistanceLast30Days: recentMapResistanceDomains,
        goalsLast30Days: recentGoalsSet,
        coachSessionsLast30Days: recentCoachSessions,
        usersLast30Days: recentUsers,
      },
      topUsers: topUsers.slice(0, 10),
    };

    return successResponse(res, "Stats fetched", stats);
  } catch (error) {
    console.error("[admin] Error fetching stats:", error);
    return errorResponse(res, "Failed to fetch stats", 500);
  }
};

const getMonthlystats = async (req, res) => {
  try {
    const { filterBy = "last6" } = req.query;

    const now = new Date();
    let startDate = new Date();

    switch (filterBy) {
      case "weekly":
        startDate = new Date();
        startDate.setHours(0, 0, 0, 0);
        startDate.setDate(startDate.getDate() - 6); // last 7 days
        break;

      case "monthly":
        startDate.setMonth(now.getMonth() - 1);
        break;

      case "yearly":
        startDate.setFullYear(now.getFullYear() - 1);
        break;

      case "last6":
      default:
        startDate.setMonth(now.getMonth() - 6);
        break;
    }

    const [redlineDiagnostics, mapResistanceGoals, goalsCreated, coachMetaForTrends] =
      await Promise.all([
      Diagnostic.findAll({
        where: {
          createdAt: { [Op.gte]: startDate },
          report_type: "invisible_red_line",
        },
        attributes: ["createdAt"],
        raw: true,
      }).catch(() => []),

      DomainGoal.findAll({
        where: {
          mapResistanceComplete: true,
          updatedAt: { [Op.gte]: startDate },
        },
        attributes: ["updatedAt"],
        raw: true,
      }).catch(() => []),

      DomainGoal.findAll({
        where: { createdAt: { [Op.gte]: startDate } },
        attributes: ["createdAt"],
        raw: true,
      }).catch(() => []),

      UserStage1Meta.findAll({
        attributes: ["coachSessionLog"],
      }).catch(() => []),
    ]);

    const coachSessionRows = [];
    for (const row of coachMetaForTrends) {
      const sessions = Array.isArray(row.coachSessionLog) ? row.coachSessionLog : [];
      for (const session of sessions) {
        const started = session?.started_at || session?.created_at;
        if (!started) continue;
        const ts = new Date(started);
        if (ts >= startDate) coachSessionRows.push({ createdAt: ts });
      }
    }

    const getKey = (date) => {
      const d = new Date(date);

      if (filterBy === "weekly") {
        return d.toISOString().split("T")[0]; // YYYY-MM-DD
      }

      if (filterBy === "yearly") {
        return `${d.getFullYear()}`;
      }

      return d.toISOString().slice(0, 7); // YYYY-MM
    };

    const countByGroup = (rows) => {
      const map = {};

      // Weekly → initialize 7 days
      if (filterBy === "weekly") {
        for (let i = 6; i >= 0; i--) {
          const d = new Date();
          d.setHours(0, 0, 0, 0);
          d.setDate(d.getDate() - i);

          const key = d.toISOString().split("T")[0];
          map[key] = 0;
        }
      }

      rows.forEach((r) => {
        const key = getKey(r.createdAt);
        map[key] = (map[key] || 0) + 1;
      });

      return Object.keys(map)
        .sort()
        .map((key) => {
          if (filterBy === "weekly") {
            const d = new Date(key);
            const dayName = d.toLocaleDateString("en-US", {
              weekday: "long",
            });

            return {
              date: key,
              day: dayName,
              count: map[key],
            };
          }

          return {
            label: key,
            count: map[key],
          };
        });
    };

    const mapResistanceRows = mapResistanceGoals.map((row) => ({
      createdAt: row.updatedAt,
    }));

    const stats = {
      trends: {
        redlineReports: countByGroup(redlineDiagnostics),
        mapResistanceReports: countByGroup(mapResistanceRows),
        goalsCreated: countByGroup(goalsCreated),
        coachSessions: countByGroup(coachSessionRows),
      },
    };

    return successResponse(res, "Stats fetched", stats);
  } catch (error) {
    return errorResponse(res, error.message || error, 500);
  }
};

// Upload user session (1:1 coaching session transcript)
const uploadUserSession = async (req, res) => {
  try {
    const { transcript, webvtt, email, sessionDate, coachNames } = req.body;
    const pdfFile = req.file;

    let parsedTranscript = null;
    let extractedText = null;

    if (pdfFile) {
      try {
        const rawPdfText = await extractTextFromPdf(pdfFile.buffer);
        extractedText = cleanTranscriptText(rawPdfText);

        if (!extractedText || extractedText.trim().length === 0) {
          return errorResponse(
            res,
            "PDF appears to be empty or could not extract text",
            400,
          );
        }

        try {
          parsedTranscript = parseWebVTT(extractedText, {
            coachNames: Array.isArray(coachNames)
              ? coachNames
              : coachNames
                ? [coachNames]
                : [],
          });
        } catch (webvttError) {
          const lines = extractedText
            .split("\n")
            .filter((l) => l.trim().length > 0);

          // Simple fallback: look for "Speaker: text" pattern
          parsedTranscript = lines
            .map((line) => {
              const match = line.match(/^([^:]+):\s*(.+)$/);
              if (match) {
                const speakerName = match[1].trim();
                const content = match[2].trim();
                const isCoach =
                  (Array.isArray(coachNames)
                    ? coachNames
                    : coachNames
                      ? [coachNames]
                      : []
                  ).some((name) =>
                    speakerName.toLowerCase().includes(name.toLowerCase()),
                  ) || /nathan|coach|therapist|counselor/i.test(speakerName);

                return {
                  role: isCoach ? "assistant" : "user",
                  content,
                  speaker: speakerName,
                };
              }
              return null;
            })
            .filter((msg) => msg !== null);

          if (parsedTranscript.length === 0) {
            return errorResponse(
              res,
              "Could not parse transcript from PDF. Please ensure the PDF contains a transcript with speaker names (e.g., 'Speaker: text').",
              400,
            );
          }
        }
      } catch (pdfError) {
        return errorResponse(
          res,
          `Failed to process PDF: ${pdfError.message}`,
          400,
        );
      }
    }
    // Handle WEBVTT format (text input)
    else if (webvtt) {
      if (typeof webvtt !== "string") {
        return errorResponse(res, "WEBVTT must be a string", 400);
      }

      try {
        // coachNames can be an array of names to identify as coach/assistant role
        // e.g., ["Nathan King", "Nathan"] - any speaker containing these will be "assistant"
        parsedTranscript = parseWebVTT(webvtt, {
          coachNames: Array.isArray(coachNames)
            ? coachNames
            : coachNames
              ? [coachNames]
              : [],
        });
      } catch (parseError) {
        return errorResponse(
          res,
          `Failed to parse WEBVTT: ${parseError.message}`,
          400,
        );
      }
    }
    // Handle JSON transcript format
    else if (transcript) {
      // Validate transcript is an array
      if (!Array.isArray(transcript)) {
        return errorResponse(
          res,
          "Transcript must be an array of message objects",
          400,
        );
      }

      // Validate transcript format (should have role and content)
      const isValidTranscript = transcript.every(
        (msg) => msg.role && msg.content,
      );
      if (!isValidTranscript) {
        return errorResponse(
          res,
          "Transcript must contain messages with 'role' and 'content' fields",
          400,
        );
      }

      parsedTranscript = transcript;
    } else {
      return errorResponse(
        res,
        "Either 'pdf' (file upload), 'transcript' (JSON array), or 'webvtt' (WEBVTT string) is required",
        400,
      );
    }

    // Parse sessionDate if provided
    let parsedDate = null;
    if (sessionDate) {
      parsedDate = new Date(sessionDate);
      if (isNaN(parsedDate.getTime())) {
        return errorResponse(res, "Invalid sessionDate format", 400);
      }
    }

    // Find user by email if provided
    let userId = null;
    if (email) {
      const user = await User.findOne({ where: { email } });
      if (user) {
        userId = user.id;
      }
    }

    // Convert transcript array to string for embeddings
    // Format: "role: content\nrole: content..."
    const transcriptText = Array.isArray(parsedTranscript)
      ? parsedTranscript
          .map((msg) => `${msg.role || "user"}: ${msg.content || ""}`)
          .join("\n")
      : typeof parsedTranscript === "string"
        ? parsedTranscript
        : JSON.stringify(parsedTranscript);

    // Generate embeddings and summary in parallel for efficiency
    const [createEmbedding, summary] = await Promise.all([
      createEmbeddings(transcriptText).catch((err) => {
        console.error("[admin] Error creating embeddings:", err);
        return null; // Continue even if embeddings fail
      }),
      generateSessionSummary(parsedTranscript, {
        sessionDate: parsedDate,
      }).catch((err) => {
        console.error("[admin] Error generating summary:", err);
        return null; // Continue even if summary generation fails
      }),
    ]);

    // Create user session
    const userSession = await UserSession.create({
      transcript: parsedTranscript,
      email: email || null,
      userId: userId || null,
      embeddings: createEmbedding,
      summery: summary,
      sessionDate: parsedDate,
    });

    // Store in vector DB for semantic search (async, non-blocking)
    storeSessionInVectorDB({
      sessionId: userSession.id,
      userId: userId,
      email: email || null,
      transcript: parsedTranscript,
      summary: summary,
      metadata: {
        sessionDate: parsedDate,
        createdAt: userSession.createdAt,
      },
    }).catch((err) =>
      console.error("[uploadUserSession] Vector DB error:", err),
    );

    return successResponse(res, "User session uploaded successfully", {
      session: userSession,
      message: userId
        ? "Session created and associated with user"
        : "Session created. Use attachUser endpoint to associate with user.",
    });
  } catch (error) {
    console.error("[admin] Error uploading user session:", error);
    return errorResponse(res, error.message || "Failed to upload session", 500);
  }
};

// Attach user session to user (similar to voice notes)
const attachUserSessionToUser = async (req, res) => {
  try {
    const { email, sessionId } = req.body;

    if (!email) {
      return errorResponse(res, "Email is required", 400);
    }
    if (!sessionId) {
      return errorResponse(res, "sessionId is required", 400);
    }

    // Find user by email
    const user = await User.findOne({ where: { email } });
    if (!user) {
      return errorResponse(res, `No user found for email: ${email}`, 404);
    }

    // Find the session
    const session = await UserSession.findOne({ where: { id: sessionId } });
    if (!session) {
      return errorResponse(res, "User session not found", 404);
    }

    // Check if session is already attached to another user
    if (session.userId && session.userId !== user.id) {
      return errorResponse(
        res,
        "Session is already attached to another user",
        400,
      );
    }

    // Update the userId and email
    await session.update({
      userId: user.id,
      email: user.email,
    });

    return successResponse(
      res,
      "Session attached to user successfully",
      session,
    );
  } catch (error) {
    console.error("[admin] Error attaching session to user:", error);
    return errorResponse(res, error.message || "Failed to attach session", 500);
  }
};

// Get all user sessions
const getAllUserSessions = async (req, res) => {
  try {
    const sessions = await UserSession.findAll({
      order: [["createdAt", "DESC"]],
      include: [
        {
          model: User,
          as: "user",
          attributes: ["id", "email", "name", "createdAt"],
        },
      ],
    });

    return successResponse(res, "User sessions retrieved", sessions);
  } catch (error) {
    console.error("[admin] Error fetching user sessions:", error);
    return errorResponse(res, "Failed to fetch user sessions", 500);
  }
};

// Get user sessions by user ID or email
const getUserSessions = async (req, res) => {
  try {
    const { userId, email } = req.query;

    if (!userId && !email) {
      return errorResponse(res, "userId or email is required", 400);
    }

    let whereClause = {};
    if (userId) {
      whereClause.userId = userId;
    } else if (email) {
      whereClause.email = email;
    }

    const sessions = await UserSession.findAll({
      where: whereClause,
      order: [
        ["sessionDate", "DESC"],
        ["createdAt", "DESC"],
      ],
      include: [
        {
          model: User,
          as: "user",
          attributes: ["id", "email", "name"],
        },
      ],
    });

    return successResponse(res, "User sessions retrieved", sessions);
  } catch (error) {
    console.error("[admin] Error fetching user sessions:", error);
    return errorResponse(res, "Failed to fetch user sessions", 500);
  }
};
const getUserLatestSession = async (req, res) => {
  try {
    const { userId, email } = req.query;

    if (!userId && !email) {
      return errorResponse(res, "userId or email is required", 400);
    }

    const whereClause = userId ? { userId } : { email };

    const latestSession = await UserSession.findOne({
      where: whereClause,
      order: [
        ["sessionDate", "DESC"],
        ["createdAt", "DESC"],
      ],
      include: [
        {
          model: User,
          as: "user",
          attributes: ["id", "email", "name"],
        },
      ],
    });

    if (!latestSession) {
      return successResponse(res, "No sessions found for user", null);
    }

    return successResponse(res, "Latest user session retrieved", latestSession);
  } catch (error) {
    console.error("[admin] Error fetching latest user session:", error);
    return errorResponse(res, "Failed to fetch latest user session", 500);
  }
};
const singleUserSessionToUser = async (req, res) => {
  try {
    const { email, id } = req.params;

    // if (!email) {
    //   return errorResponse(res, "Email is required", 400);
    // }
    if (!id) {
      return errorResponse(res, "sessionId is required", 400);
    }

    // // Find user by email
    // const user = await User.findOne({ where: { email } });
    // if (!user) {
    //   return errorResponse(res, `No user found for email: ${email}`, 404);
    // }

    // Find the session
    const session = await UserSession.findOne({ where: { id: id } });
    if (!session) {
      return errorResponse(res, "User session not found", 404);
    }

    return successResponse(res, "Session fetched successfully", session);
  } catch (error) {
    console.error("[admin] Error fetching single session to user:", error);
    return errorResponse(res, error.message || "Failed to fetch session", 500);
  }
};

/**
 * Semantic search for user sessions
 * Find relevant past coaching sessions based on meaning
 */
const searchUserSessionsSemantic = async (req, res) => {
  try {
    const { query, email, userId, topK = 5 } = req.body || {};

    if (!query || query.trim().length === 0) {
      return errorResponse(res, "Search query is required", 400);
    }

    // Search using vector store
    const results = await searchSessions({
      query: query.trim(),
      userId: userId || undefined,
      email: email || undefined,
      topK: parseInt(topK) || 5,
      minScore: 0.3,
    });

    // Fetch full session data for the results
    const sessionIds = results
      .map((r) => parseInt(r.sessionId))
      .filter(Boolean);
    const fullSessions = await UserSession.findAll({
      where: { id: sessionIds },
      include: [
        {
          model: User,
          as: "user",
          attributes: ["id", "email", "name"],
        },
      ],
    });

    // Merge full session data with similarity scores
    const enrichedResults = results.map((result) => {
      const fullSession = fullSessions.find(
        (s) => s.id === parseInt(result.sessionId),
      );
      return {
        ...result,
        transcript: fullSession?.transcript || [],
        summary: fullSession?.summery || null,
        user: fullSession?.user || null,
        sessionDate: fullSession?.sessionDate,
      };
    });

    return successResponse(res, "Search completed", {
      results: enrichedResults,
      total: enrichedResults.length,
      query: query,
    });
  } catch (error) {
    console.error("[searchUserSessionsSemantic] Error:", error);
    return errorResponse(res, "Failed to search sessions", 500);
  }
};

// ── Market Research ────────────────────────────────────────────────────────────

// Simple in-memory cache — keyed by stringified filter params, 5-min TTL
const _mrCache = new Map();
const MR_CACHE_TTL_MS = 5 * 60 * 1000;

/**
 * Merges `req.body` and `req.query` so filters work when sent as query params, JSON body (e.g. some clients
 * attach a body to GET), or a mix. Query wins on conflicts. Supports `userAudience` as alias for `user_audience`.
 */
const getMrFilterParams = (req) => {
  const b = req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body : {};
  const q = req.query && typeof req.query === "object" ? req.query : {};
  const m = { ...b, ...q };
  return {
    date_from: m.date_from,
    date_to: m.date_to,
    funnel_source: m.funnel_source,
    user_audience: m.user_audience ?? m.userAudience,
    report_source: m.report_source ?? m.reportSource,
  };
};

/** Stable cache key: all slots explicit so filters are never dropped by `JSON.stringify`. */
const getCacheKey = ({
  date_from,
  date_to,
  funnel_source,
  user_audience,
  report_source,
}) =>
  JSON.stringify({
    date_from: date_from ?? null,
    date_to: date_to ?? null,
    funnel_source: funnel_source ?? null,
    user_audience: user_audience ?? null,
    report_source: report_source ?? null,
  });

/**
 * GET /api/admin/market-research
 * Returns aggregated diagnostic data for market research purposes.
 */
const getMarketResearch = async (req, res) => {
  try {
    const { date_from, date_to, funnel_source, user_audience, report_source } =
      getMrFilterParams(req);
    const cacheKey = getCacheKey({
      date_from,
      date_to,
      funnel_source,
      user_audience,
      report_source,
    });

    const cached = _mrCache.get(cacheKey);
    if (cached && Date.now() - cached.ts < MR_CACHE_TTL_MS) {
      return successResponse(res, "Market research data (cached)", cached.data);
    }

    const data = await getMarketResearchData({
      date_from,
      date_to,
      funnel_source,
      user_audience,
      report_source,
    });
    _mrCache.set(cacheKey, { data, ts: Date.now() });

    return successResponse(res, "Market research data", data);
  } catch (err) {
    console.error("[getMarketResearch] Error:", err);
    return errorResponse(res, "Failed to fetch market research data", 500);
  }
};

/**
 * GET /api/admin/market-research/export
 * Returns a CSV of all diagnostic records with real emails.
 */
const exportMarketResearchCsv = async (req, res) => {
  try {
    const { date_from, date_to, funnel_source, user_audience, report_source } =
      getMrFilterParams(req);
    const rows = await getMarketResearchRows({
      date_from,
      date_to,
      funnel_source,
      user_audience,
      report_source,
    });

    const CSV_HEADERS = [
      "date",
      "email",
      "eo",
      "lack",
      "avoid",
      "vortex_signature",
      "domain",
      "desired_outcome",
      "current_loop",
      "orbit_pattern",
      "structure_type",
      "gravity_depth",
      "cl_estimate",
      "protector_type",
      "contradiction_rate",
      "recovery_speed",
      "funnel_source",
    ];

    const escapeCell = (val) => {
      if (val == null) return "";
      const str = String(val).replace(/\r?\n/g, " ");
      return str.includes(",") || str.includes('"') || str.includes("\n")
        ? `"${str.replace(/"/g, '""')}"`
        : str;
    };

    const lines = [CSV_HEADERS.join(",")];
    for (const row of rows) {
      lines.push(CSV_HEADERS.map((h) => escapeCell(row[h])).join(","));
    }

    const dateStr = new Date().toISOString().slice(0, 10);
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="euphoriam-market-research-${dateStr}.csv"`
    );
    return res.send(lines.join("\n"));
  } catch (err) {
    console.error("[exportMarketResearchCsv] Error:", err);
    return errorResponse(res, "Failed to export CSV", 500);
  }
};

/**
 * POST /api/admin/market-research/report
 * Body: same filters as GET /market-research — date_from, date_to, funnel_source, user_audience;
 * plus focus_area, custom_question for the LLM. Calls GPT-4o to generate a market research insight report.
 */
const generateMarketResearchReport = async (req, res) => {
  try {
    const b = req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body : {};
    const q = req.query && typeof req.query === "object" ? req.query : {};
    const m = { ...q, ...b };
    const {
      date_from,
      date_to,
      funnel_source,
      focus_area,
      custom_question,
    } = m;
    const user_audience = m.user_audience ?? m.userAudience;
    const report_source = m.report_source ?? m.reportSource;

    // Load the market_research prompt from the DB
    const promptRecord = await withDbSlot(() =>
      Prompt.findOne({ where: { type: "market_research", isActive: true }, order: [["createdAt", "DESC"]] })
    );

    const systemPrompt = promptRecord?.content || `You are a market research analyst specialising in consciousness and personal development.
You will receive aggregated diagnostic data from the Euphoriam AI platform (real user data, fully anonymised).
Generate a structured market research report designed to inform marketing copywriting.

Include:
1. Who the audience really is (demographic-level description based on the patterns)
2. What their real pain is (beneath the stated desire)
3. Most common hidden structures and what that means for copy
4. Language patterns that will resonate (derived from top desired outcomes)
5. Marketing angles that match the dominant vortex signatures
6. 5–10 copy headline suggestions based on dominant patterns

Be specific. Use the data. Write in a tone suitable for a marketing strategist.`;

    // Get aggregated data (same filter set as GET /api/admin/market-research)
    const data = await getMarketResearchData({
      date_from,
      date_to,
      funnel_source,
      user_audience,
      report_source,
    });

    // Build user content
    const focusSection = focus_area ? `\nFocus area for this report: ${focus_area}` : "";
    const questionSection = custom_question ? `\nSpecific question to answer: ${custom_question}` : "";

    const userContent = `Here is aggregated Euphoriam diagnostic data from ${data.total_diagnostics} users:

${JSON.stringify(data, null, 2)}
${focusSection}${questionSection}

Generate the market research insight report now.`;

    const response = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userContent },
      ],
      temperature: 0.5,
      max_completion_tokens: 2000,
    });

    const report_text = (response?.choices?.[0]?.message?.content || "").trim();
    const tokens_used = response?.usage?.total_tokens || 0;

    return successResponse(res, "Market research report generated", {
      report_text,
      model: "gpt-4o",
      tokens_used,
      data_summary: {
        total_diagnostics: data.total_diagnostics,
        date_range: data.date_range,
        user_audience: data.user_audience,
        funnel_source: funnel_source || null,
      },
    });
  } catch (err) {
    console.error("[generateMarketResearchReport] Error:", err);
    return errorResponse(res, "Failed to generate report", 500);
  }
};

module.exports = {
  adminLogin,
  getAllUsers,
  deleteUser,
  changeUserStatus,
  getUserReports,
  getAllPrompts,
  getPromptById,
  createPrompt,
  updatePrompt,
  deletePrompt,
  getPromptHistory,
  getStats,
  getMonthlystats,
  uploadUserSession,
  attachUserSessionToUser,
  getAllUserSessions,
  getUserSessions,
  getUserLatestSession,
  singleUserSessionToUser,
  searchUserSessionsSemantic,
  getMarketResearch,
  exportMarketResearchCsv,
  generateMarketResearchReport,
};
