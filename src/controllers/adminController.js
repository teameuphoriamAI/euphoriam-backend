const { Op } = require("sequelize");
const { User } = require("../models/userModel");
const { Diagnostic } = require("../models/diagnosticModel");
const { Discovery } = require("../models/discoveryModel");
const { DiscoveryChat } = require("../models/discoveryChat");
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
const { cleanTranscriptText } = require("../helpers/euphoriamChatbot");
const { PromptType, UserStatus, UserRole } = require("../utils/types");

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

    // Optional: delete related data
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

    const userEmail = user.email;
    const userIdNum = user.id;

    // Get diagnostics by email or userId (diagnostics may be stored with either)
    const diagnostics = await Diagnostic.findAll({
      where: {
        userId: userIdNum,
      },
      order: [["createdAt", "DESC"]],
    });
    console.log("diagnostic report", diagnostics);

    // Get discoveries by userId or email (discoveries may be stored with either)
    const discoveries = await Discovery.findAll({
      where: { userId: userIdNum },
      order: [["createdAt", "DESC"]],
    });
    console.log("discoveries report", discoveries);

    return successResponse(res, "User reports fetched", {
      user: user.toJSON(),
      diagnostics: diagnostics,
      discoveries: discoveries,
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
    // Execute queries sequentially to avoid connection pool exhaustion
    // With max: 1 connection pool, we need to ensure proper sequencing
    const totalUsers = await User.count({ where: { role: "user" } }).catch(
      (err) => {
        console.error("[admin] Error counting users:", err);
        return 0;
      },
    );

    const totalDiagnostics = await Diagnostic.count().catch((err) => {
      console.error("[admin] Error counting diagnostics:", err);
      return 0;
    });

    const totalDiscoveries = await Discovery.count().catch((err) => {
      console.error("[admin] Error counting discoveries:", err);
      return 0;
    });

    const totalPrompts = await Prompt.count().catch((err) => {
      console.error("[admin] Error counting prompts:", err);
      return 0;
    });

    const activePrompts = await Prompt.count({
      where: { isActive: true },
    }).catch((err) => {
      console.error("[admin] Error counting active prompts:", err);
      return 0;
    });

    // Get diagnostics by date (last 30 days)
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    const recentDiagnostics = await Diagnostic.count({
      where: {
        createdAt: {
          [Op.gte]: thirtyDaysAgo,
        },
      },
    }).catch((err) => {
      console.error("[admin] Error counting recent diagnostics:", err);
      return 0;
    });

    // Get users by date (last 30 days)
    const recentUsers = await User.count({
      where: {
        createdAt: {
          [Op.gte]: thirtyDaysAgo,
        },
        role: "user",
      },
    }).catch((err) => {
      console.error("[admin] Error counting recent users:", err);
      return 0;
    });

    // Get diagnostics grouped by month (last 6 months)
    const sixMonthsAgo = new Date();
    sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);

    // Get users with most reports
    const usersWithReports = await User.findAll({
      attributes: ["id", "name", "email"],
      where: { role: "user" },
    }).catch((err) => {
      console.error("[admin] Error fetching users with reports:", err);
      return [];
    });

    // Process top users sequentially to avoid connection issues
    const topUsers = [];
    for (const user of usersWithReports) {
      try {
        // Run counts in parallel
        const [diagnosticCount, discoveryCount, discoveryChatCount] =
          await Promise.all([
            Diagnostic.count({ where: { email: user.email } }).catch(() => 0),
            Discovery.count({ where: { userId: user.id } }).catch(() => 0),
            DiscoveryChat.count({ where: { userId: user.id } }).catch(() => 0),
          ]);

        topUsers.push({
          id: user.id,
          name: user.name,
          email: user.email,
          totalReports: diagnosticCount + discoveryCount + discoveryChatCount,
          diagnostics: diagnosticCount,
          diagnosticChat: discoveryCount,
          discoveries: discoveryChatCount,
        });
      } catch (err) {
        console.error(`[admin] Error processing user ${user.id}:`, err);
      }
    }

    topUsers.sort((a, b) => b.totalReports - a.totalReports);
    const topNUsers = topUsers.slice(0, 10);

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

    const [allDiagnostics, allDiscovery, allDiscoveryChat] = await Promise.all([
      Diagnostic.findAll({
        where: { createdAt: { [Op.gte]: startDate } },
        attributes: ["createdAt"],
        raw: true,
      }).catch(() => []),

      Discovery.findAll({
        where: { createdAt: { [Op.gte]: startDate } },
        attributes: ["createdAt"],
        raw: true,
      }).catch(() => []),

      DiscoveryChat.findAll({
        where: { createdAt: { [Op.gte]: startDate } },
        attributes: ["createdAt"],
        raw: true,
      }).catch(() => []),
    ]);

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

    const stats = {
      trends: {
        diagnostics: countByGroup(allDiagnostics),
        discovery: countByGroup(allDiscoveryChat),
        discoveryChat: countByGroup(allDiscovery),
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
};
