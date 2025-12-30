const { Op } = require("sequelize");
const { User } = require("../models/userModel");
const { Diagnostic } = require("../models/diagnosticModel");
const { Discovery } = require("../models/discoveryModel");
const { Prompt, PromptHistory } = require("../models/promptModel");
const { successResponse, errorResponse } = require("../utils/response");
const { createPromptSchemaValidator } = require("../utils/validator");
const validate = require("../helpers/validate");
// const Joi = require("joi");

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

    // Get report counts for each user
    const usersWithReports = await Promise.all(
      users.map(async (user) => {
        const diagnostics = await Diagnostic.count({
          where: {
            [Op.or]: [{ email: user.email }, { userId: user.id }],
          },
        });
        const discoveries = await Discovery.count({
          where: { userId: user.id },
        });

        return {
          ...user.toJSON(),
          reportCount: diagnostics + discoveries,
          diagnosticCount: diagnostics,
          discoveryCount: discoveries,
        };
      })
    );

    return successResponse(res, "Users fetched", usersWithReports);
  } catch (error) {
    console.error("[admin] Error fetching users:", error);
    return errorResponse(res, "Failed to fetch users", 500);
  }
};

// Get user reports
const getUserReports = async (req, res) => {
  try {
    const { userId } = req.params;
    const user = await User.findByPk(userId, {
      attributes: { exclude: ["password"] },
    });

    if (!user) {
      return errorResponse(res, "User not found", 404);
    }

    // Get diagnostics by email or userId
    const diagnostics = await Diagnostic.findAll({
      where: {
        [Op.or]: [{ email: user.email }, { userId: user.id }],
      },
      order: [["createdAt", "DESC"]],
    });

    const discoveries = await Discovery.findAll({
      where: { userId: user.id },
      order: [["createdAt", "DESC"]],
    });

    return successResponse(res, "User reports fetched", {
      user: user.toJSON(),
      diagnostics,
      discoveries,
      totalReports: diagnostics.length + discoveries.length,
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
      // include: [
      //   {
      //     model: PromptHistory,
      //     as: "history",
      //     limit: 1,
      //     order: [["createdAt", "DESC"]],
      //   },
      // ],
    });

    // Get the latest prompt (most recently updated)
    const latestPromptId = prompts.length > 0 ? prompts[0].id : null;

    const promptsWithLatest = prompts.map((prompt) => ({
      ...prompt.toJSON(),
      isLatest: prompt.id === latestPromptId,
    }));

    return successResponse(res, "Prompts fetched", promptsWithLatest);
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
      req.body
    );

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
        }
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

// Get admin stats
const getStats = async (req, res) => {
  try {
    const totalUsers = await User.count();
    const totalDiagnostics = await Diagnostic.count();
    const totalDiscoveries = await Discovery.count();
    const totalPrompts = await Prompt.count();
    const activePrompts = await Prompt.count({ where: { isActive: true } });

    // Get diagnostics by date (last 30 days)
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    const recentDiagnostics = await Diagnostic.count({
      where: {
        createdAt: {
          [Op.gte]: thirtyDaysAgo,
        },
      },
    });

    // Get users by date (last 30 days)
    const recentUsers = await User.count({
      where: {
        createdAt: {
          [Op.gte]: thirtyDaysAgo,
        },
      },
    });

    // Get diagnostics grouped by month (last 6 months)
    const sixMonthsAgo = new Date();
    sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);

    const allDiagnostics = await Diagnostic.findAll({
      where: {
        createdAt: {
          [Op.gte]: sixMonthsAgo,
        },
      },
      attributes: ["createdAt"],
      raw: true,
    });

    const diagnosticsByMonth = {};
    allDiagnostics.forEach((diag) => {
      const month = new Date(diag.createdAt).toISOString().slice(0, 7); // YYYY-MM
      diagnosticsByMonth[month] = (diagnosticsByMonth[month] || 0) + 1;
    });

    // Get users with most reports
    const usersWithReports = await User.findAll({
      attributes: ["id", "name", "email"],
      limit: 10,
    });

    const topUsers = await Promise.all(
      usersWithReports.map(async (user) => {
        const diagCount = await Diagnostic.count({
          where: { email: user.email },
        });
        const discCount = await Discovery.count({
          where: { userId: user.id },
        });
        return {
          id: user.id,
          name: user.name,
          email: user.email,
          totalReports: diagCount + discCount,
          diagnostics: diagCount,
          discoveries: discCount,
        };
      })
    );

    topUsers.sort((a, b) => b.totalReports - a.totalReports);

    const stats = {
      overview: {
        totalUsers,
        totalDiagnostics,
        totalDiscoveries,
        totalReports: totalDiagnostics + totalDiscoveries,
        totalPrompts,
        activePrompts,
      },
      recent: {
        diagnosticsLast30Days: recentDiagnostics,
        usersLast30Days: recentUsers,
      },
      trends: {
        diagnosticsByMonth,
      },
      topUsers: topUsers.slice(0, 10),
    };

    return successResponse(res, "Stats fetched", stats);
  } catch (error) {
    console.error("[admin] Error fetching stats:", error);
    return errorResponse(res, "Failed to fetch stats", 500);
  }
};

module.exports = {
  adminLogin,
  getAllUsers,
  getUserReports,
  getAllPrompts,
  getPromptById,
  createPrompt,
  updatePrompt,
  deletePrompt,
  getPromptHistory,
  getStats,
};
