const { Op } = require("sequelize");
const { User } = require("../models/userModel");
const { Diagnostic } = require("../models/diagnosticModel");
const { Discovery } = require("../models/discoveryModel");
const { Prompt, PromptHistory } = require("../models/promptModel");
const { UserSession } = require("../models/userSessionModel");
const { successResponse, errorResponse } = require("../utils/response");
const { createPromptSchemaValidator } = require("../utils/validator");
const validate = require("../helpers/validate");
const { parseWebVTT } = require("../utils/webvttParser");
const { extractTextFromPdf } = require("../utils/pdfParser");
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
    const totalUsers = await User.count({ where: { role: "user" } });
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
        role: "user",
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
      where: { role: "user" },
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

// Upload user session (1:1 coaching session transcript)
const uploadUserSession = async (req, res) => {
  try {
    const { transcript, webvtt, email, sessionDate, coachNames } = req.body;
    const pdfFile = req.file; // PDF file from multer

    let parsedTranscript = null;
    let extractedText = null;

    // Handle PDF upload
    if (pdfFile) {
      try {
        // Extract text from PDF
        extractedText = await extractTextFromPdf(pdfFile.buffer);
        
        if (!extractedText || extractedText.trim().length === 0) {
          return errorResponse(
            res,
            "PDF appears to be empty or could not extract text",
            400
          );
        }

        // Try to parse as WEBVTT format (common for transcripts)
        try {
          parsedTranscript = parseWebVTT(extractedText, {
            coachNames: Array.isArray(coachNames)
              ? coachNames
              : coachNames
              ? [coachNames]
              : [],
          });
        } catch (webvttError) {
          // If WEBVTT parsing fails, try to parse as plain text transcript
          // Split by lines and try to identify speakers
          const lines = extractedText.split("\n").filter((l) => l.trim().length > 0);
          
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
                    speakerName.toLowerCase().includes(name.toLowerCase())
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
              400
            );
          }
        }
      } catch (pdfError) {
        return errorResponse(
          res,
          `Failed to process PDF: ${pdfError.message}`,
          400
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
          400
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
          400
        );
      }

      // Validate transcript format (should have role and content)
      const isValidTranscript = transcript.every(
        (msg) => msg.role && msg.content
      );
      if (!isValidTranscript) {
        return errorResponse(
          res,
          "Transcript must contain messages with 'role' and 'content' fields",
          400
        );
      }

      parsedTranscript = transcript;
    } else {
      return errorResponse(
        res,
        "Either 'pdf' (file upload), 'transcript' (JSON array), or 'webvtt' (WEBVTT string) is required",
        400
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

    // Create user session
    const userSession = await UserSession.create({
      transcript: parsedTranscript,
      email: email || null,
      userId: userId || null,
      sessionDate: parsedDate,
    });

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
        400
      );
    }

    // Update the userId and email
    await session.update({
      userId: user.id,
      email: user.email,
    });

    return successResponse(res, "Session attached to user successfully", session);
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
      order: [["sessionDate", "DESC"], ["createdAt", "DESC"]],
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
      order: [["sessionDate", "DESC"], ["createdAt", "DESC"]],
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
  uploadUserSession,
  attachUserSessionToUser,
  getAllUserSessions,
  getUserSessions,getUserLatestSession,singleUserSessionToUser
};
