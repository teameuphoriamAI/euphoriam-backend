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
      if (chat && chat.userId !== userId) {
        console.warn("[saveChatIncrementally] existingChatId does not belong to userId, ignoring");
        chat = null;
      }
      if (chat) {
        console.log(`[saveChatIncrementally] Updating existing chat ${chat.id} (switch to ${chatType}), transcript length=${transcript.length}`);
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

module.exports = {
  saveChatIncrementally,
  getChatHistory,
};
