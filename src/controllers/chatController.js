const fs = require("fs");
const { Diagnostic } = require("../models/diagnosticModel");
const { Discovery } = require("../models/discoveryModel");
const { Prompt } = require("../models/promptModel");
const { User } = require("../models/userModel");
const { Chat } = require("../models/chatModel");
const validate = require("../helpers/validate");
const openai = require("../config/openai");
const {
  discoveryReportEmail,
} = require("../utils/emailTemplate/initialDiscoveryReport");

const {
  buildFinalReportPrompt,
  DEFAULT_INTRO_PAGE_TEXT,
  sanitizeReportText,
  // Helper functions
  loadDiagnosticState,
  loadLatestDiscoveryMetrics,
  extractReportDate,
  preparePreviousReports,
  checkWantsNewDiagnostic,
  checkWantsEmail,
  determineChatMode,
  prepareTranscript,
  trackQuestionNumbers,
  buildChatPrompts,
  buildFreeformIntakePrompt,
  extractQuestionNumber,
  validateChatbotRequest,
  getDiscoverySystemPrompt,
} = require("../helpers/euphoriamChatbot");
const { retrieveSimilarChunks } = require("../helpers/rag");
const { successResponse, errorResponse } = require("../utils/response");
const { buildKajabiDiagnosticContext } = require("./kajabi");
const { generateDiagnosticPdf } = require("../utils/diagnosticPdf");
const { uploadBufferToSupabase } = require("../utils/storage");
const { sendEmail, sendEmailBasic } = require("../utils/email");
const {
  diagnosticReportEmail,
} = require("../utils/emailTemplate/initialDignosticReport");
const {
  detectUserWantsToEndOrGenerateReport,
  detectConversationComplete,
  detectBotSignaledEnd,
} = require("../utils/validation");

// Vector store service for semantic search
const {
  storeChatInVectorDB,
  searchChats,
  searchAllHistory,
  getRelevantContext,
} = require("../services/vectorStoreService");
const {
  deleteOngoingChatsForUser,
  clearIntakeStateOnDiagnostic,
  buildWelcomeAfterReset,
} = require("../helpers/chatSessionReset");
const { diagnosticHasCompletedReport } = require("../helpers/euphoriamChatbot");

const saveChatIncrementally = async ({
  userId,
  diagnosticId = null,
  discoveryId = null,
  chatType,
  transcript = [],
  isChatEnded = false,
  forceNewChat = false,
  pdfSummary = null, // PDF report summary to save with chat
  existingChatId = null, // when switching discovery → diagnostic: update this chat instead of creating new one
}) => {
  try {
    if (!userId) {
      console.warn("[saveChatIncrementally] No userId provided, skipping save");
      return null;
    }

    // If forcing new chat or transcript is empty (new session), always create new entry (unless we're updating existingChatId)
    const isNewSession = forceNewChat || (transcript.length === 0 && !existingChatId);

    console.log(
      `[saveChatIncrementally] Entry: userId=${userId}, chatType=${chatType}, diagnosticId=${diagnosticId}, forceNewChat=${forceNewChat}, transcriptLength=${transcript.length}, isNewSession=${isNewSession}, existingChatId=${existingChatId || "none"}`,
    );

    // When switching discovery → diagnostic: update the existing chat by id (same chat, new type + transcript)
    let chat = null;
    if (existingChatId) {
      chat = await Chat.findByPk(existingChatId);
      // Compare numerically — PG/Sequelize may return userId as string in some drivers.
      if (chat && Number(chat.userId) !== Number(userId)) {
        console.warn("[saveChatIncrementally] existingChatId does not belong to userId, ignoring");
        chat = null;
      }
      if (chat) {
        console.log(`[saveChatIncrementally] Updating existing chat ${chat.id} (switch to ${chatType}), transcript length=${transcript.length}`);
      }
      // Funnel (and explicit id updates): never fall through to "another recent chat" — avoids saving to the wrong row.
      if (!chat) {
        console.error(
          `[saveChatIncrementally] existingChatId ${existingChatId} not found or not owned; refusing save (transcriptLength=${transcript.length})`,
        );
        return null;
      }
    }

    // Find existing incomplete chat for this user and type (only if not forcing new and not updating by id)
    if (!chat && !isNewSession) {
      // Only look for incomplete chats that are recent (within last 24 hours)
      // This prevents reusing very old incomplete chats
      const { Op } = require("sequelize");
      const oneDayAgo = new Date();
      oneDayAgo.setHours(oneDayAgo.getHours() - 24);

      // Find any incomplete chat of this type for this user
      // Don't filter by diagnosticId/discoveryId initially because:
      // 1. They might be null when chat starts
      // 2. They might change during the conversation
      // 3. We want to find the most recent incomplete chat regardless
      const baseWhere = {
        userId: userId,
        chatType: chatType,
        isChatEnded: false,
        createdAt: {
          [Op.gte]: oneDayAgo, // Only recent incomplete chats
        },
      };

      console.log(
        `[saveChatIncrementally] Looking for existing chat: userId=${userId}, chatType=${chatType}, diagnosticId=${diagnosticId}, discoveryId=${discoveryId}, transcriptLength=${transcript.length}`,
      );

      // First, try to find chat with matching diagnosticId/discoveryId (if provided)
      if (diagnosticId || discoveryId) {
        const withIdWhere = { ...baseWhere };
        if (diagnosticId) {
          withIdWhere.dignosticId = diagnosticId;
        }
        if (discoveryId) {
          withIdWhere.discoveryId = discoveryId;
        }

        chat = await Chat.findOne({
          where: withIdWhere,
          order: [["createdAt", "DESC"]],
        });

        if (chat) {
          console.log(
            `[saveChatIncrementally] Found chat ${chat.id} with matching diagnosticId/discoveryId`,
          );
        }
      }

      // If not found, try without diagnosticId/discoveryId filter
      // This handles cases where diagnosticId is null initially or changes during conversation
      if (!chat) {
        chat = await Chat.findOne({
          where: baseWhere,
          order: [["createdAt", "DESC"]],
        });

        if (chat) {
          console.log(
            `[saveChatIncrementally] Found chat ${
              chat.id
            } without diagnosticId filter, will update it${
              diagnosticId ? ` with diagnosticId ${diagnosticId}` : ""
            }`,
          );
        } else {
          console.log(
            `[saveChatIncrementally] No existing incomplete chat found for user ${userId}, chatType=${chatType}`,
          );
        }
      }

      // Additional check: if the found chat's transcript doesn't match, it might be a different session
      // Only create new chat if current transcript is significantly shorter (user started over)
      // BUT: If isChatEnded is true, always update existing chat (we're ending it, transcript might be shorter due to closing message)
      // BUT: If existingChatId was provided (e.g. switching discovery → diagnostic), always update that chat and replace transcript
      if (
        chat &&
        !existingChatId &&
        chat.data?.transcript &&
        transcript.length > 0 &&
        !isChatEnded
      ) {
        const existingTranscript = chat.data.transcript || [];
        const existingLength = existingTranscript.length;
        const currentLength = transcript.length;

        console.log(
          `[saveChatIncrementally] Comparing transcripts: existing=${existingLength}, current=${currentLength}`,
        );

        // If current transcript is significantly shorter (more than 2 messages difference),
        // it's likely a new session (user started over)
        // But allow if current transcript is longer or same length (normal progression or concurrent saves)
        if (currentLength < existingLength - 2) {
          console.log(
            `[saveChatIncrementally] Transcript mismatch - current (${currentLength}) is significantly shorter than existing (${existingLength}), creating new chat`,
          );
          chat = null; // Force new chat creation
        } else {
          // Current transcript is same length, longer, or only slightly shorter
          // This is normal progression or concurrent saves - update existing chat
          console.log(
            `[saveChatIncrementally] Transcript length compatible (existing=${existingLength}, current=${currentLength}) - updating existing chat`,
          );
        }
      } else if (chat && isChatEnded) {
        // When ending chat, always update existing chat regardless of transcript length
        console.log(
          `[saveChatIncrementally] Ending chat - will update existing chat ${chat.id} regardless of transcript length`,
        );
      }
    }

    if (chat && !isNewSession) {
      // SAFETY: Prevent saving corrupted transcripts
      const MAX_TRANSCRIPT_LENGTH = 200;
      let transcriptToSave = transcript;
      if (transcript.length > MAX_TRANSCRIPT_LENGTH) {
        console.warn(`[saveChatIncrementally] ⚠️ Transcript too long (${transcript.length}), truncating to last ${MAX_TRANSCRIPT_LENGTH}`);
        transcriptToSave = transcript.slice(-MAX_TRANSCRIPT_LENGTH);
      }
      
      // Update existing incomplete chat with latest transcript
      // Also update diagnosticId/discoveryId if they were set after chat creation
      const updateData = {
        data: {
          ...(chat.data || {}),
          transcript: transcriptToSave,
          // messages: transcript,
          lastUpdated: new Date().toISOString(),
          ...(pdfSummary ? { pdfSummary: pdfSummary } : {}), // Add PDF summary if provided
        },
        isChatEnded: isChatEnded,
      };

      // Update diagnosticId if it was set after chat creation
      if (diagnosticId && !chat.dignosticId) {
        updateData.dignosticId = diagnosticId;
      }
      // Update discoveryId if it was set after chat creation
      if (discoveryId && !chat.discoveryId) {
        updateData.discoveryId = discoveryId;
      }
      // When switching discovery → diagnostic, update chatType so the same chat continues as diagnostic
      if (existingChatId && chatType) {
        updateData.chatType = chatType;
      }

      await chat.update(updateData);
      console.log(
        `[saveChatIncrementally] Updated existing chat ${chat.id} for user ${userId} (${transcript.length} messages)`,
      );

      // Store in vector DB for semantic search (async, non-blocking)
      storeChatInVectorDB({
        chatId: chat.id,
        userId: userId,
        transcript: transcriptToSave,
        chatType: chatType,
        metadata: { createdAt: chat.createdAt },
      }).catch((err) => console.error("[saveChatIncrementally] Vector DB error:", err));

      return chat;
    } else {
      // SAFETY: Prevent saving corrupted transcripts on new chat creation
      const MAX_TRANSCRIPT_LENGTH = 200;
      let transcriptToSave = transcript;
      if (transcript.length > MAX_TRANSCRIPT_LENGTH) {
        console.warn(`[saveChatIncrementally] ⚠️ New chat transcript too long (${transcript.length}), truncating to last ${MAX_TRANSCRIPT_LENGTH}`);
        transcriptToSave = transcript.slice(-MAX_TRANSCRIPT_LENGTH);
      }
      
      // Create new chat record (new session)
      chat = await Chat.create({
        userId: userId,
        dignosticId: diagnosticId,
        discoveryId: discoveryId,
        chatType: chatType,
        isChatEnded: isChatEnded,
        data: {
          transcript: transcriptToSave,
          sessionStartedAt: new Date().toISOString(),
          lastUpdated: new Date().toISOString(),
          ...(pdfSummary ? { pdfSummary: pdfSummary } : {}), // Add PDF summary if provided
        },
      });
      console.log(
        `[saveChatIncrementally] Created NEW chat session ${chat.id} for user ${userId} (${transcript.length} messages, type: ${chatType})`,
      );

      // Link chat to diagnostic if exists and not already linked
      if (diagnosticId) {
        const diagnostic = await Diagnostic.findByPk(diagnosticId);
        if (diagnostic && !diagnostic.chatId) {
          await diagnostic.update({ chatId: chat.id });
        }
      }

      // Store in vector DB for semantic search (async, non-blocking)
      if (transcriptToSave.length > 0) {
        storeChatInVectorDB({
          chatId: chat.id,
          userId: userId,
          transcript: transcriptToSave,
          chatType: chatType,
          metadata: { createdAt: chat.createdAt },
        }).catch((err) => console.error("[saveChatIncrementally] Vector DB error:", err));
      }

      return chat;
    }
  } catch (error) {
    console.error("[saveChatIncrementally] Error saving chat:", error);
    // Don't throw - we don't want to break the chat flow if saving fails
    return null;
  }
};
const getChatHistory = async (req, res) => {
  try {
    const { email } = req.user || {};

    const { chatType } = req.body || req.query || {};
    console.log("data is", req.params, req.query);

    if (!email) {
      return errorResponse(res, "Email is required", 400);
    }

    // Find user by email
    const user = await User.findOne({ where: { email } });
    if (!user) {
      return successResponse(res, "Chat history fetched", {
        chats: [],
        total: 0,
      });
    }

    // Build where clause
    const whereClause = {
      userId: user.id,
    };

    // Filter by chat type if provided
    if (chatType && (chatType === "dignostic" || chatType === "discovery")) {
      whereClause.chatType = chatType;
    }

    // Get all chats for the user
    const chats = await Chat.findAll({
      where: whereClause,
      order: [["createdAt", "DESC"]],
      attributes: [
        "id",
        "userId",
        "dignosticId",
        "discoveryId",
        "chatType",
        "isChatEnded",
        "data",
        "createdAt",
        "updatedAt",
      ],
    });

    // Format the response
    const formattedChats = chats.map((chat) => ({
      id: chat.id,
      userId: chat.userId,
      pdfSummary: chat.data?.pdfSummary || null,
      diagnosticId: chat.dignosticId,
      discoveryId: chat.discoveryId,
      chatType: chat.chatType,
      isChatEnded: chat.isChatEnded,
      transcript: chat.data?.transcript || [],
      createdAt: chat.createdAt,
      updatedAt: chat.updatedAt,
      endedAt: chat.data?.endedAt || null,
    }));

    return successResponse(res, "Chat history fetched", {
      chats: formattedChats,
      total: formattedChats.length,
    });
  } catch (error) {
    console.error("[getChatHistory] Error fetching chat history:", error);
    return errorResponse(res, "Failed to fetch chat history", 500);
  }
};

/**
 * Semantic search for chat history
 * Find relevant past conversations based on meaning, not just keywords
 */
const searchChatHistorySemantic = async (req, res) => {
  try {
    const { email } = req.user || {};
    const { query, chatType, topK = 5 } = req.body || {};

    if (!email) {
      return errorResponse(res, "Email is required", 400);
    }

    if (!query || query.trim().length === 0) {
      return errorResponse(res, "Search query is required", 400);
    }

    // Find user by email
    const user = await User.findOne({ where: { email } });
    if (!user) {
      return successResponse(res, "No chat history found", {
        results: [],
        total: 0,
      });
    }

    // Search using vector store
    const results = await searchChats({
      query: query.trim(),
      userId: user.id,
      chatType: chatType || undefined,
      topK: parseInt(topK) || 5,
      minScore: 0.3,
    });

    // Fetch full chat data for the results
    const chatIds = results.map((r) => parseInt(r.chatId)).filter(Boolean);
    const fullChats = await Chat.findAll({
      where: { id: chatIds },
      attributes: [
        "id",
        "userId",
        "dignosticId",
        "discoveryId",
        "chatType",
        "isChatEnded",
        "data",
        "createdAt",
        "updatedAt",
      ],
    });

    // Merge full chat data with similarity scores
    const enrichedResults = results.map((result) => {
      const fullChat = fullChats.find((c) => c.id === parseInt(result.chatId));
      return {
        ...result,
        transcript: fullChat?.data?.transcript || [],
        pdfSummary: fullChat?.data?.pdfSummary || null,
        diagnosticId: fullChat?.dignosticId,
        discoveryId: fullChat?.discoveryId,
        isChatEnded: fullChat?.isChatEnded,
      };
    });

    return successResponse(res, "Search completed", {
      results: enrichedResults,
      total: enrichedResults.length,
      query: query,
    });
  } catch (error) {
    console.error("[searchChatHistorySemantic] Error:", error);
    return errorResponse(res, "Failed to search chat history", 500);
  }
};

/**
 * Get relevant context from past conversations for the chatbot
 * This is used internally by the chatbot to provide personalized responses
 */
const getContextForChatbot = async (userId, userMessage) => {
  try {
    if (!userId || !userMessage) {
      return null;
    }

    const contextResult = await getRelevantContext({
      query: userMessage,
      userId: userId,
      topK: 3,
    });

    return contextResult;
  } catch (error) {
    console.error("[getContextForChatbot] Error:", error);
    return null;
  }
};

/**
 * POST /api/chat/reset
 * Reset an in-progress diagnostic Q&A or discovery chat:
 * - Deletes the ongoing chat row and ChromaDB chunks
 * - Clears diagnostic intakeState (keeps completed report)
 * - Returns a fresh welcome message (diagnostic Q1 or discovery welcome)
 *
 * Body: { mode: "diagnostic" | "discovery", chatId?: number }
 */
const resetChatSession = async (req, res) => {
  try {
    const { email, name } = req.user || {};
    const { mode = "diagnostic", chatId: rawChatId } = req.body || {};

    if (!email) {
      return errorResponse(res, "Email is required", 400);
    }

    const normalizedMode =
      typeof mode === "string" ? mode.trim().toLowerCase() : "";
    if (normalizedMode !== "diagnostic" && normalizedMode !== "discovery") {
      return errorResponse(
        res,
        'mode must be "diagnostic" (Q&A intake) or "discovery" (post-report chat)',
        400,
      );
    }

    const user = await User.findOne({ where: { email } });
    if (!user) {
      return errorResponse(res, "User not found", 404);
    }

    const chatId =
      rawChatId != null && rawChatId !== ""
        ? parseInt(String(rawChatId), 10)
        : undefined;

    let deletedChatIds = [];
    try {
      deletedChatIds = await deleteOngoingChatsForUser({
        userId: user.id,
        mode: normalizedMode,
        chatId: Number.isFinite(chatId) ? chatId : undefined,
      });
    } catch (err) {
      const status = err.statusCode || 500;
      return errorResponse(res, err.message || "Failed to delete chat", status);
    }

    const diagnostic = await Diagnostic.findOne({
      where: { email },
      order: [["updatedAt", "DESC"]],
    });

    if (diagnostic) {
      await clearIntakeStateOnDiagnostic(diagnostic, normalizedMode);
    }

    const welcome = await buildWelcomeAfterReset({
      name,
      email,
      mode: normalizedMode,
      diagnostic,
    });

    const responseMode = welcome.mode || normalizedMode;
    const welcomeMessage = { role: "assistant", content: welcome.content };
    const welcomeTranscript = [welcomeMessage];
    const chatType = responseMode === "discovery" ? "discovery" : "dignostic";

    await saveChatIncrementally({
      userId: user.id,
      diagnosticId: diagnostic?.id || null,
      chatType,
      transcript: welcomeTranscript,
      isChatEnded: false,
      forceNewChat: true,
    });

    if (diagnostic) {
      const priorIntake = diagnostic.data?.intakeState || {};
      await diagnostic.update({
        data: {
          ...(diagnostic.data || {}),
          intakeState: {
            transcript: welcomeTranscript,
            mode: responseMode,
            acceptedAnswers: [],
            answeredCount: 0,
            lastQuestionNumber: 0,
            pendingQuestion: true,
            updatedAt: new Date().toISOString(),
            ...(responseMode === "diagnostic"
              ? { requestingNewDiagnostic: true }
              : {}),
            // Do not carry discoveryType / completedAt — they route the next turn to discovery chat.
            ...(responseMode === "discovery"
              ? { completedAt: priorIntake.completedAt || new Date().toISOString() }
              : {}),
          },
        },
      });
    }

    const hasExistingReport = diagnosticHasCompletedReport(diagnostic);

    return successResponse(res, "Chat reset", {
      reset: true,
      mode: responseMode,
      deletedChatIds,
      hasExistingReport,
      nextMessage: welcomeMessage,
      transcript: welcomeTranscript,
      intakeState: {
        transcript: welcomeTranscript,
        mode: responseMode,
        acceptedAnswers: [],
        answeredCount: 0,
        pendingQuestion: true,
        ...(responseMode === "diagnostic"
          ? { requestingNewDiagnostic: true }
          : {}),
      },
      status:
        responseMode === "discovery" ? "discovery_ready" : "diagnostic_ready",
      statusMessage:
        responseMode === "discovery"
          ? "Discovery chat reset. Starting from welcome message."
          : "Diagnostic Q&A reset. Starting from Question 1.",
    });
  } catch (error) {
    console.error("[resetChatSession] Error:", error);
    return errorResponse(res, "Failed to reset chat session", 500);
  }
};

/**
 * Search across all history (chats and sessions)
 */
const searchAllChatAndSessionHistory = async (req, res) => {
  try {
    const { email } = req.user || {};
    const { query, topK = 5 } = req.body || {};

    if (!email) {
      return errorResponse(res, "Email is required", 400);
    }

    if (!query || query.trim().length === 0) {
      return errorResponse(res, "Search query is required", 400);
    }

    // Find user by email
    const user = await User.findOne({ where: { email } });
    if (!user) {
      return successResponse(res, "No history found", {
        chats: [],
        sessions: [],
        combined: [],
        total: 0,
      });
    }

    // Search using vector store
    const results = await searchAllHistory({
      query: query.trim(),
      userId: user.id,
      topK: parseInt(topK) || 5,
      minScore: 0.3,
    });

    return successResponse(res, "Search completed", {
      chats: results.chats,
      sessions: results.sessions,
      combined: results.combined,
      total: results.combined.length,
      query: query,
    });
  } catch (error) {
    console.error("[searchAllChatAndSessionHistory] Error:", error);
    return errorResponse(res, "Failed to search history", 500);
  }
};

module.exports = {
  saveChatIncrementally,
  getChatHistory,
  searchChatHistorySemantic,
  searchAllChatAndSessionHistory,
  getContextForChatbot,
  resetChatSession,
  deleteOngoingChatsForUser,
};
