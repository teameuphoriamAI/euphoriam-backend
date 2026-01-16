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
const { saveChatIncrementally } = require("./chatController");
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
  SUPPORT_LOCK_PROMPT,
  EUPHORIAM_FREEFORM_INTAKE_SYSTEM_PROMPT,
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
const isQuestion = (text = "") => text.trim().endsWith("?");

const isCreatorClubMember = (context = {}) => {
  const hasProduct = (context.products || []).some((p) =>
    (p.title || "").toLowerCase().includes("creator club")
  );
  const hasOffer = (context.offers || []).some((o) =>
    (o.title || "").toLowerCase().includes("creator club")
  );
  return hasProduct || hasOffer;
};

/**
 * Finds or creates a user and checks/updates their Creator Club membership status
 * This is the ONLY place we call buildKajabiDiagnosticContext - just for membership checking
 * Always checks latest status from Kajabi and updates the database
 */
const findOrCreateCreatorUser = async (req, res) => {
  try {
    let { email, name, assessmentIds = [] } = req.body;
    email = email.toLowerCase().trim();
    name = name.trim();

    let user = await User.findOne({ where: { email, name } });

    if (!user) {
      user = await User.create({ email, name });
    }
    let diagnosticContext = null;
    // Check membership if missing or not a Creator Club member
    if (!user.membership?.isCreatorClub) {
      try {
        const result = await buildKajabiDiagnosticContext({
          email,
          assessmentIds,
        });
        if (!result) {
          return errorResponse(res, "user not found in euphoriam", 404);
        } else {
          diagnosticContext = result.diagnosticContext || null;
        }
        const isCreatorClub = isCreatorClubMember(diagnosticContext);
        if (!isCreatorClub) {
          return errorResponse(res, "user is not a creator club member", 404);
        }
        const membership = {
          isCreatorClub,
          lastUpdated: new Date().toISOString(),
          products: diagnosticContext.products || [],
          offers: diagnosticContext.offers || [],
        };

        await user.update({ membership });
        await user.reload(); // ensure updated membership
        return successResponse(res, "user is creator club member", user);
      } catch (err) {
        console.error(
          "[findOrCreateCreatorUser] Failed to check membership:",
          err
        );
        return errorResponse(res, "failed to verify membership", 500);
      }
    }
    return successResponse(res, "user found", user);
  } catch (error) {
    console.error("[findOrCreateCreatorUser] Unexpected error:", error);
    return errorResponse(res, "Failed to find or create user");
  }
};

// Lightweight AI check to decide if a user reply is an answer to the last question.
const isAiLikelyAnswer = async ({ question, reply }) => {
  console.log("[isAiLikelyAnswer] START", { question, reply });

  const t = (reply || "").trim().toLowerCase();
  if (!t) {
    console.log("[isAiLikelyAnswer] ❌ Empty reply");
    return false;
  }

  if (isQuestion(t)) {
    console.log("[isAiLikelyAnswer] ❌ Reply detected as question");
    return false;
  }

  // Hard fail on clarify/intents
  const clarifyPhrases = [
    "elaborate",
    "clarify",
    "explain",
    "repeat",
    "don't understand",
    "do not understand",
    "not sure",
    "what do you mean",
    "?",
  ];

  const clarifier = clarifyPhrases.find((p) => t.includes(p));
  if (clarifier) {
    console.log(
      "[isAiLikelyAnswer] ❌ Clarification intent detected:",
      clarifier
    );
    return false;
  }

  const normalizedReply = t.trim();

  // Simple yes/no answers
  const simpleAnswers = ["yes", "no", "y", "n", "yeah", "yep", "nope", "nah"];
  if (simpleAnswers.includes(normalizedReply)) {
    console.log("[isAiLikelyAnswer] ✅ Simple yes/no detected");
    return true;
  }

  // Single letter answers (A-F)
  const singleLetterAnswers = ["a", "b", "c", "d", "e", "f"];
  if (singleLetterAnswers.includes(normalizedReply)) {
    const questionText = (question || "").toLowerCase();
    const hasMultipleChoice =
      /\([a-f]\)/i.test(question) ||
      /^[a-f]\)/i.test(question) ||
      /\*\*[a-f]\)/i.test(question) ||
      /\[a-f\]/i.test(question) ||
      /pick\s+[a-f]/i.test(question) ||
      /choose\s+[a-f]/i.test(question) ||
      /reply\s+with\s+[a-f]/i.test(question) ||
      /option\s+[a-f]/i.test(question);

    console.log("[isAiLikelyAnswer] Single-letter answer", {
      normalizedReply,
      hasMultipleChoice,
    });

    if (hasMultipleChoice) {
      console.log(
        "[isAiLikelyAnswer] ✅ Accepted single-letter multiple-choice answer"
      );
      return true;
    }
  }

  // Single number answers (1–6)
  const singleNumberAnswers = ["1", "2", "3", "4", "5", "6"];
  if (singleNumberAnswers.includes(normalizedReply)) {
    const questionText = (question || "").toLowerCase();
    const hasNumberedOptions =
      /\([1-6]\)/i.test(question) ||
      /^[1-6]\)/i.test(question) ||
      /\*\*[1-6]\)/i.test(question) ||
      /\[1-6\]/i.test(question) ||
      /option\s+[1-6]/i.test(question);

    console.log("[isAiLikelyAnswer] Single-number answer", {
      normalizedReply,
      hasNumberedOptions,
    });

    if (hasNumberedOptions) {
      console.log("[isAiLikelyAnswer] ✅ Accepted numbered option answer");
      return true;
    }
  }

  // Move-on / skip intent
  const moveOnPhrases = [
    "move on",
    "next question",
    "next",
    "skip",
    "move to next",
    "continue",
    "proceed",
    "go to next",
  ];

  const moveOnMatch = moveOnPhrases.find((p) => normalizedReply.includes(p));
  if (moveOnMatch) {
    console.log("[isAiLikelyAnswer] ✅ Move-on intent detected:", moveOnMatch);
    return true;
  }

  // Single-word descriptive answers
  const singleWordAnswers = [
    "alone",
    "together",
    "home",
    "work",
    "bed",
    "couch",
    "chair",
    "desk",
    "balcony",
    "outside",
    "library",
    "park",
    "car",
    "office",
    "calm",
    "relaxed",
    "interrupted",
    "available",
    "free",
    "busy",
    "watched",
    "on-call",
  ];

  if (singleWordAnswers.includes(normalizedReply)) {
    console.log(
      "[isAiLikelyAnswer] ✅ Single-word descriptive answer detected"
    );
    return true;
  }

  // Descriptive multi-word patterns
  const descriptiveAnswerPatterns = [
    /^(completely|fully|totally|mostly|usually|always|never|sometimes)\s+(alone|interrupted|available|on-call|watched|free|busy|calm|relaxed)/i,
    /^(at|in|on|by|near)\s+(home|work|bed|couch|chair|desk|balcony|outside|library|park|car|office)/i,
    /^(alone|together|with\s+people|by\s+myself|with\s+family|with\s+friends)/i,
    /^(yes|no|maybe|sometimes|often|rarely|never|always)\s+(alone|interrupted|available)/i,
  ];

  if (descriptiveAnswerPatterns.some((p) => p.test(reply))) {
    console.log("[isAiLikelyAnswer] ✅ Descriptive pattern matched");
    return true;
  }

  const alpha = t.match(/[A-Za-z]/g);
  if (!alpha || alpha.length < 1) {
    console.log("[isAiLikelyAnswer] ❌ No alphabetic characters");
    return false;
  }

  console.log("[isAiLikelyAnswer] 🤖 Escalating to AI classifier");

  const prompt = `
You are a binary classifier. Decide if the user's reply is an *answer* to the given question.

Question: "${question || "N/A"}"
Reply: "${reply}"

Rules:
- Reply only "yes" or "no".
- "yes" if the reply attempts to answer; "no" if it is just a question, "I don't know", or unrelated.
`;

  try {
    const resp = await openai.chat.completions.create({
      model: "gpt-5.2",
      messages: [{ role: "user", content: prompt }],
      temperature: 0,
      max_completion_tokens: 20,
    });

    const txt = (resp?.choices?.[0]?.message?.content || "").toLowerCase();
    const result = txt.includes("yes");

    console.log("[isAiLikelyAnswer] 🤖 AI response:", txt);
    console.log("[isAiLikelyAnswer] RESULT:", result);

    return result;
  } catch (err) {
    console.error(
      "[isAiLikelyAnswer] ⚠️ AI failed — using heuristic fallback",
      err
    );
    return false;
  }
};

const truncateForContext = (text = "", max = 6000) => {
  const safe = String(text || "");
  if (!safe) return "";
  return safe.length > max ? `${safe.slice(0, max)}\n...[truncated]` : safe;
};

/**
 * Extract key sentence and correction from diagnostic report using LLM
 * This provides more reliable extraction than regex patterns
 */
const extractKeySentenceAndCorrectionWithLLM = async (reportText) => {
  if (!reportText || reportText.length < 100) {
    return { keySentence: "", correction: "" };
  }

  try {
    // Truncate report to reasonable length for LLM (keep last 8000 chars which usually contains the relevant sections)
    const reportSnippet = reportText.length > 8000 
      ? reportText.slice(-8000) 
      : reportText;

    const prompt = `You are extracting two specific pieces of information from a Euphoriam diagnostic report.

REPORT TEXT:
${reportSnippet}

TASK:
Extract exactly two things from this report:

1. KEY SENTENCE: Find the "key sentence" or "distilled" pattern/statement. This is usually:
   - A quoted sentence after "key sentence" or "distilled" markers
   - An identity pattern like "I will..." or structural description
   - Found in "Key refinement" sections
   - Must be a COMPLETE sentence (starts with capital letter, ends with punctuation)
   - If you find fragments like "ence, no micro-truth" or "d, no", skip it and look for the complete sentence

2. CORRECTION: Find the "First Correction" or "10. FIRST CORRECTION" section. This is:
   - The actual correction text from the "First Correction" section
   - Usually starts with "When you feel..." or similar action-oriented text
   - NOT from "Key refinement" sections
   - Must be a COMPLETE sentence or phrase

OUTPUT FORMAT (JSON only, no other text):
{
  "keySentence": "complete sentence here or empty string if not found",
  "correction": "complete correction text here or empty string if not found"
}

RULES:
- Return empty string ("") if you cannot find a complete, valid sentence
- Do NOT return fragments or incomplete text
- Key sentence must start with capital letter
- Correction must be from "First Correction" section only
- Return valid JSON only`;

    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: "You are a precise text extraction tool. Extract only complete sentences. Return valid JSON only.",
        },
        {
          role: "user",
          content: prompt,
        },
      ],
      temperature: 0.1,
      max_tokens: 500,
      response_format: { type: "json_object" },
    });

    const content = response.choices[0]?.message?.content?.trim();
    if (!content) {
      return { keySentence: "", correction: "" };
    }

    const parsed = JSON.parse(content);
    return {
      keySentence: parsed.keySentence?.trim() || "",
      correction: parsed.correction?.trim() || "",
    };
  } catch (error) {
    console.error("[extractKeySentenceAndCorrectionWithLLM] Error:", error);
    return { keySentence: "", correction: "" };
  }
};

const buildDiscoveryEmail = ({ transcript = [], email }) => {
  const lastMessages = transcript.slice(-10);
  const body = lastMessages
    .map((m) => `${m.role === "assistant" ? "Assistant" : "You"}: ${m.content}`)
    .join("<br/>");

  return `
  <html>
    <body style="font-family: Arial, sans-serif; color: #222;">
      <p>Hi ${email || "there"},</p>
      <p>Your discovery chat has been saved. Here’s a quick recap of the last messages:</p>
      <div style="background:#f7f7f7;padding:12px;border-radius:8px;font-size:14px;line-height:1.5;">
        ${body || "No messages captured."}
      </div>
      <p>If you’d like to continue, start a new chat and we’ll build on this.</p>
      <p style="margin-top:20px;">— Euphoraum AI</p>
    </body>
  </html>
  `;
};

const persistDiscoveryRecord = async ({
  userId,
  email,
  title,
  transcript,
  previousReport,
  newReport,
  diagnosticId,
  pdfUrl,
  discoveryType = null, // 'alignment', 'freedom', 'prosperity', or 'integrated'
  metrics = null, // Formula-based metrics including vortex signature
}) => {
  const safeUserId =
    userId !== undefined && userId !== null && userId !== 0 ? userId : null;

  if (!safeUserId) {
    console.warn(
      "[diagnostic] Skipping discovery persist because userId is missing"
    );
    return;
  }

  try {
    await Discovery.create({
      userId: safeUserId,
      title: title || `Diagnostic Follow-up – ${email || "client"}`,
      discoveryType: discoveryType || "integrated", // Default to integrated if not specified
      email: email || null,
      diagnosticId: diagnosticId || null,
      transcript: transcript || null,
      previousReportSnippet: previousReport
        ? truncateForContext(previousReport, 1500)
        : null,
      newReportSnippet: newReport ? truncateForContext(newReport, 1500) : null,
      pdfUrl: pdfUrl || null,
      data: {
        createdAt: new Date().toISOString(),
        type: "diagnostic_followup",
        // Save full reports in JSONB data field (not truncated)
        previousReport: previousReport || null, // Full previous report
        newReport: newReport || null, // Full new report
        // Save formula-based metrics
        metrics: metrics || null, // Includes: signalOutput, gravityDepth, vortexSignature, etc.
      },
    });
  } catch (err) {
    console.error("[diagnostic] Failed to persist discovery record", err);
  }
};

// Helper function to render metrics gauge for discovery reports
const renderGauge = (value) => {
  const v = Math.max(0, Math.min(100, Number(value || 0)));
  const totalBlocks = 12;
  // Clamp filled and empty to prevent negative values
  const filled = Math.max(
    0,
    Math.min(totalBlocks, Math.round((v / 100) * totalBlocks))
  );
  const empty = Math.max(0, Math.min(totalBlocks, totalBlocks - filled));
  const filledBlock = "█".repeat(filled);
  const emptyBlock = "░".repeat(empty);
  return `${filledBlock}${emptyBlock} ${v}%`;
};
//get latest promt from db
const getLatestPromptFromDb = async () => {
  try {
    const prompt = await Prompt.findOne({
      where: { isActive: true },
      order: [["createdAt", "DESC"]],
      raw: true, // returns plain JS object
    });

    if (!prompt) return null;

    return {
      ...prompt,
      fullPrompt: `${prompt.content}\n\n${SUPPORT_LOCK_PROMPT}`,
    };
  } catch (error) {
    console.error("Error fetching latest prompt:", error);
    return null;
  }
};

/**
 * ============================================
 * DISCOVERY MODE HANDLER
 * ============================================
 * Handles all discovery mode logic for users with existing reports
 * This includes:
 * - Discovery chat conversations
 * - Generating discovery follow-up reports
 * - Handling discovery finalize requests
 */
const handleDiscoveryMode = async ({
  req,
  res,
  email,
  name,
  messages,
  transcript,
  updatedTranscript,
  existingDiagnostic,
  existingState,
  priorReportSnippet,
  diagnosticMetrics,
  latestDiscoveryMetrics,
  reportDate,
  appUser,
  lastUser,
  lastAssistant,
  nextMessage,
  introText,
  discoveryType,
}) => {
  // Discovery mode: Check if user wants to end/generate report
  // If nextMessage is null, it means we're skipping bot response to generate report directly
  console.log("[handleDiscoveryMode] Checking if chat should end");
  console.log("[handleDiscoveryMode] Input:", {
    nextMessage: nextMessage ? "exists" : "null",
    lastUser: lastUser ? lastUser.content?.substring(0, 100) : "none",
    lastAssistant: lastAssistant
      ? lastAssistant.content?.substring(0, 100)
      : "none",
  });

  let wantsToEndOrGenerate = false;
  let conversationComplete = false;

  // Count questions asked in discovery mode for logging (but don't force completion based on count)
  // The bot should ask enough questions to understand the user's current state, then end naturally
  const assistantMessages = updatedTranscript.filter(
    (m) => m?.role === "assistant"
  );
  const userMessages = updatedTranscript.filter((m) => m?.role === "user");

  // Count questions asked by assistant (messages ending with "?" or containing question words)
  const questionsAsked = assistantMessages.filter((m) => {
    const content = m.content || "";
    // Check if it's a question (ends with ? or contains question words followed by ?)
    return (
      /\?/.test(content) &&
      !/(we stop here|let it land|pause here|let this integrate|integration limit|we'll continue tomorrow)/i.test(
        content
      )
    );
  }).length;

  // Count questions that have been answered (user responded after assistant question)
  let questionsAnswered = 0;
  for (let i = 0; i < assistantMessages.length; i++) {
    const assistantMsg = assistantMessages[i];
    const hasQuestion = /\?/.test(assistantMsg.content || "");
    if (hasQuestion) {
      // Check if there's a user message after this assistant message
      const assistantIndex = updatedTranscript.indexOf(assistantMsg);
      const messagesAfter = updatedTranscript.slice(assistantIndex + 1);
      const hasUserResponse = messagesAfter.some((m) => m?.role === "user");
      if (hasUserResponse) {
        questionsAnswered++;
      }
    }
  }

  console.log("[handleDiscoveryMode] Question count:", {
    questionsAsked,
    questionsAnswered,
    note: "Bot will ask enough questions to understand user's state, then end naturally",
  });

  // Check if AI signaled completion using detectBotSignaledEnd (comprehensive detection)
  if (nextMessage?.content) {
    const botSignaledEnd = await detectBotSignaledEnd({
      lastAssistantMessage: nextMessage,
      transcript: updatedTranscript,
    });

    if (botSignaledEnd) {
      console.log(
        "[handleDiscoveryMode] AI signaled completion via detectBotSignaledEnd - will generate report"
      );
      conversationComplete = true;
    } else {
      // Also check for common completion phrases (fallback)
      const aiMessage = nextMessage.content.toLowerCase();
      const aiSignalsCompletion =
        /(we stop here|let it land|that's enough|stop here|we'll stop|enough for now|that's it for now|pause here|let this integrate|integration limit|we'll continue tomorrow|let this settle|we'll pause|today's integration limit|complete for this phase|work is complete|reached.*integration limit)/i.test(
          aiMessage
        ) &&
        !/(one question|ask|what happens|what do you|how do you|when do you)/i.test(
          aiMessage
        ); // Don't trigger if AI is asking a question

      if (aiSignalsCompletion) {
        console.log(
          "[handleDiscoveryMode] AI signaled completion via phrase detection - will generate report"
        );
        conversationComplete = true;
      }
    }
  }

  // Don't treat nextMessage === null as a signal to generate report
  // nextMessage === null means the LLM needs to generate a response (which should have happened already)
  // Only generate report if user explicitly wants it OR AI signaled completion
  if (lastUser) {
    console.log(
      "[handleDiscoveryMode] Checking detectUserWantsToEndOrGenerateReport for:",
      lastUser.content?.substring(0, 100)
    );

    wantsToEndOrGenerate = await detectUserWantsToEndOrGenerateReport({
      userMessage: lastUser.content,
      transcript: updatedTranscript,
    });

    console.log(
      "[handleDiscoveryMode] detectUserWantsToEndOrGenerateReport result:",
      wantsToEndOrGenerate
    );

    // If user wants to end, set conversationComplete
    // Respect explicit user request to end immediately, regardless of message count
    if (wantsToEndOrGenerate) {
      const userMessages = updatedTranscript.filter(
        (m) => m?.role === "user"
      ).length;
      const assistantMessages = updatedTranscript.filter(
        (m) => m?.role === "assistant"
      ).length;

      // If user explicitly wants to end, respect their request immediately
      console.log(
        `[handleDiscoveryMode] User wants to end (${userMessages} user, ${assistantMessages} assistant messages) - will generate report`
      );
      conversationComplete = true;
    }
  } else {
    console.log(
      "[handleDiscoveryMode] No lastUser message - skipping end check"
    );
  }

  // SAFETY NET: Force completion if too many questions are asked (prevents endless loops)
  // After 6-8 questions, we should have enough information - force completion if bot hasn't signaled it
  const MAX_QUESTIONS_SAFETY_LIMIT = 8; // Safety limit to prevent endless questions
  if (
    questionsAnswered >= MAX_QUESTIONS_SAFETY_LIMIT &&
    !conversationComplete
  ) {
    console.log(
      "[handleDiscoveryMode] ⚠️ SAFETY LIMIT REACHED - Forcing completion after",
      questionsAnswered,
      "questions"
    );
    conversationComplete = true;

    // If nextMessage doesn't already signal completion, modify it to signal completion
    if (
      nextMessage?.content &&
      !/(we stop here|let it land|pause here|let this integrate|integration limit|we'll continue tomorrow|we'll pause)/i.test(
        nextMessage.content
      )
    ) {
      // Check if message ends with a question - if so, remove it and add completion signal
      if (/\?/.test(nextMessage.content)) {
        // Remove the question and add completion signal
        const withoutQuestion = nextMessage.content
          .replace(/\s*[^.!?]*\?[^.!?]*$/g, "")
          .trim();
        nextMessage.content = `${withoutQuestion}\n\nWe'll pause here and let this integrate. You've reached today's integration limit. Let this settle — we'll continue tomorrow.`;
        console.log(
          "[handleDiscoveryMode] Modified nextMessage to signal completion (safety limit)"
        );
      } else {
        // Just append completion signal
        nextMessage.content = `${nextMessage.content}\n\nWe'll pause here and let this integrate. You've reached today's integration limit. Let this settle — we'll continue tomorrow.`;
        console.log(
          "[handleDiscoveryMode] Appended completion signal to nextMessage (safety limit)"
        );
      }
    }
  }

  // CRITICAL: Check if nextMessage has a question when completion is detected
  // If completion is detected, remove ALL questions from the message
  if (nextMessage?.content && conversationComplete) {
    const aiMessage = nextMessage.content;
    const hasQuestion =
      /(one question|One question|question only|Question)[\s\S]*?\?/i.test(
        aiMessage
      ) || /\?/.test(aiMessage);

    if (hasQuestion) {
      console.log(
        "[handleDiscoveryMode] Completion detected but message contains question - removing question"
      );

      // Remove "One question:" sections and everything after
      let cleaned = aiMessage
        .replace(
          /(?:One question|one question|question only|Question)[\s\S]*$/i,
          ""
        )
        .trim();

      // If that didn't work, remove everything from the last question mark onwards
      if (cleaned === aiMessage && /\?/.test(aiMessage)) {
        const parts = aiMessage.split(/\?/);
        if (parts.length > 1) {
          // Take everything before the last question mark
          cleaned = parts.slice(0, -1).join("?").trim();
          // If there's no content before the question, try to find the last sentence before "One question"
          if (!cleaned || cleaned.length < 20) {
            const beforeQuestionMatch = aiMessage.match(
              /(.*?)(?:One question|one question|question only)[\s\S]*$/i
            );
            if (beforeQuestionMatch && beforeQuestionMatch[1]) {
              cleaned = beforeQuestionMatch[1].trim();
            }
          }
        }
      }

      // Ensure the cleaned message ends properly
      if (cleaned && !cleaned.match(/[.!]$/)) {
        cleaned = cleaned + ".";
      }

      // Add completion signal if not already present
      if (
        cleaned &&
        !/(we stop here|let it land|pause here|let this integrate|integration limit|we'll continue tomorrow|let this settle)/i.test(
          cleaned
        )
      ) {
        cleaned = `${cleaned}\n\nWe'll pause here and let this integrate. You've reached today's integration limit. Let this settle — we'll continue tomorrow.`;
      }

      nextMessage.content = cleaned || nextMessage.content;
      console.log(
        "[handleDiscoveryMode] Cleaned message (removed question):",
        nextMessage.content.substring(0, 150)
      );
    } else if (
      !/(we stop here|let it land|pause here|let this integrate|integration limit|we'll continue tomorrow|let this settle)/i.test(
        aiMessage
      )
    ) {
      // No question but also no completion signal - add it
      nextMessage.content = `${aiMessage}\n\nWe'll pause here and let this integrate. You've reached today's integration limit. Let this settle — we'll continue tomorrow.`;
    }
  }

  console.log("[handleDiscoveryMode] Final decision:", {
    wantsToEndOrGenerate,
    conversationComplete,
    willGenerateReport: wantsToEndOrGenerate || conversationComplete,
    nextMessageHasCompletion: nextMessage?.content
      ? /(we stop here|let it land|that's enough)/i.test(nextMessage.content)
      : false,
  });

  // If user wants to end/generate report OR conversation is complete, generate discovery report
  // IMPORTANT: Generate report WITHOUT emailing (user didn't explicitly request email)
  if (wantsToEndOrGenerate || conversationComplete) {
    console.log(
      "[handleDiscoveryMode] 🚨 GENERATING REPORT - wantsToEndOrGenerate:",
      wantsToEndOrGenerate,
      "conversationComplete:",
      conversationComplete
    );
    const userName = name || email?.split("@")[0] || "User";

    // Get previous discovery if exists
    const previousDiscoveries = await Discovery.findAll({
      where: {
        userId: existingDiagnostic?.userId || appUser?.id || null,
      },
      order: [["createdAt", "DESC"]],
      limit: 1,
    });
    const previousDiscovery = previousDiscoveries[0];

    // Get full prior report for saving to DB (not truncated snippet)
    // Try to get from latest discovery first, then from existing diagnostic
    const fullPriorReport =
      previousDiscovery?.data?.newReport ||
      previousDiscovery?.data?.previousReport ||
      existingDiagnostic?.data?.aiReport ||
      null;

    // Generate discovery report
    // const reportDate = new Date().toLocaleDateString("en-US", {
    //   month: "short",
    //   day: "numeric",
    //   year: "numeric",
    // });
    const reportVersion = previousDiscovery ? "v3.2" : "v3.1";

    const discoveryPrompt = `
You are generating a FULL DISCOVERY REPORT in PDF format for Euphoriam AI.

Context: The user already has a completed diagnostic report and may have previous discovery sessions.

Previous diagnostic (reference):
${priorReportSnippet || "None"}

${previousDiscovery
        ? `Previous discovery report (reference):
${truncateForContext(
          previousDiscovery.data?.newReport ||
          previousDiscovery.data?.previousReport ||
          previousDiscovery.newReportSnippet ||
          previousDiscovery.data?.newReportSnippet ||
          "",
          4000
        )}`
        : ""
      }

New conversation transcript (latest messages last):
${JSON.stringify(updatedTranscript, null, 2)}

Client Name: ${userName}
Client ID: N/A
Report Type: Structural Update Report
Date: ${reportDate}

CRITICAL: You MUST generate the report in the EXACT format shown below. This is a structural update report based on the conversation interaction.

**METRICS CALCULATION RULE:**
- Calculate UPDATED metrics based on the NEW conversation transcript above
- Compare previous metrics (Gravity: ~${diagnosticMetrics.gravity || "N/A"
      }%, CL: ~${diagnosticMetrics.consciousnessLevel || "N/A"}, QGC: ~${diagnosticMetrics.qgcActivation || "N/A"
      }%, Signal Coherence: ~${diagnosticMetrics.signalCoherence || "N/A"
      }%, Signal Output: ~${diagnosticMetrics.signalOutput || "N/A"
      }%) with evidence from the new conversation
- Calculate what changed based on the new responses
- Output updated metrics in the METRICS GAUGE section with actual calculated values
- DO NOT use placeholders - calculate actual values based on evidence from the new conversation
- IMPORTANT: The system will calculate Signal Output automatically - you do NOT need to show how it's calculated
- Include the calculated Signal Output value in the METRICS GAUGE section (just the number, no explanation of calculation)
- NEVER reveal any formulas, equations, or calculation methods to the user
- If you identify a vortex signature (EO + Lack + Avoid pattern), note it in the VORTEX STATUS section

Generate a FULL DISCOVERY REPORT following this EXACT format:

---

## EUPHORIAM™ STRUCTURAL UPDATE REPORT

**Client:** ${userName}
**Report Type:** Identity Authority Collapse + Gravity Shift (or appropriate type based on conversation)
**Version:** ${reportVersion}
**Date:** ${reportDate}
**Tone:** Warm / Grounded

---

### 1. STRUCTURE TYPE (Updated)

**Primary Structure:**
[Analyze their primary structure based on metrics and conversation - be specific about what changed]

**Key refinement:**
[Explain what has shifted or been refined in their structure based on the conversation]

---

### 2. AVOIDANCE BEHAVIOUR (Resolved Layer)

**Original Pattern:**
[What was the original avoidance pattern from previous report]

**Updated Reading:**
[How the avoidance has changed or been resolved based on the conversation - be specific about what shifted]

---

### 3. VORTEX STATUS

**Previous Vortex:**
[What was the previous vortex state]

**Current State:**
[Current vortex status - use ⚠️ if destabilized, ✅ if stable, etc.]

Why:
[Explain what changed and why based on the conversation]

---

### 4. GRAVITY (3D CODE)

**Previous Gravity:** ~${diagnosticMetrics.gravity || "N/A"}%
**Current Reading:** [Current gravity status - use ↓ if dropping, ↑ if increasing, or stable]

Critical insight:
[Explain what the gravity shift means based on the conversation]

---

### 5. CONSCIOUSNESS LEVEL (CL)

**Previous CL:** ~${diagnosticMetrics.consciousnessLevel || "N/A"}
**Current CL:** [Current CL level]

Marker of shift:
[Explain what changed and what it indicates]

---

### 6. QUANTUM GENIUS CODES (QGC)

**Previous QGC:** ~${diagnosticMetrics.qgcActivation || "N/A"}%
**Current Status:** [Current QGC status]

[Explain what changed and what it means]

---

### 7. SIGNAL COHERENCE

**Signal Coherence:** [Current status - use exact value: ${diagnosticMetrics.signalCoherence || "N/A"
      }%]

Important note:
[Explain what the coherence level indicates]

---

### 8. SIGNAL OUTPUT

**Previous Output:** ~${diagnosticMetrics.signalOutput || "N/A"}%
**Current Status:** [Current status]

This is crucial:
[Explain what changed and why]

---

### 9. ANGLE OF GROWTH (Updated)

**Current Angle:**
[Their updated growth axis based on the conversation]

Not:
[What it's NOT about]

---

### 10. FIRST CORRECTION (Updated)

One sentence. Exact.

> **[The exact correction based on the conversation]**

That's it.

---

## METRICS GAUGE (Current Snapshot)

* **QGC Activation:** ${renderGauge(diagnosticMetrics.qgcActivation || 0)}  ~${diagnosticMetrics.qgcActivation || "N/A"
      }%
* **Consciousness Level:** ${renderGauge(
        (diagnosticMetrics.consciousnessLevel || 0) * 20
      )}  ~${diagnosticMetrics.consciousnessLevel || "N/A"}
* **Gravity:** ${renderGauge(
        diagnosticMetrics.gravity || 0
      )}  [Current status with arrow if changed]
* **Signal Coherence:** ${renderGauge(
        diagnosticMetrics.signalCoherence || 0
      )}  ${diagnosticMetrics.signalCoherence || "N/A"}%
* **Signal Output:** ${renderGauge(
        diagnosticMetrics.signalOutput || 0
      )}  [Current status]

---

## FRICTION ANALYSIS

**Primary Friction Source:**
[Identify the primary friction: Surface (Level 1), Vortex (Level 2), or Template (Level 3)]

**Surface Friction (Physics Level 1):**
[If present: reactive language, emotional charge, scattered focus indicators]

**Vortex Friction (Physics Level 2):**
[If present: repeated orbit patterns, protector triggers, rules engine statements]

**Template Friction (Physics Level 3):**
[If present: "I know what to do but can't do it", disproportionate reactions, instant reprints after progress]

**Why This Blocks Your Highest Timeline:**
[Explain how the identified friction prevents their highest timeline from locking in]

---

## DISCOVERY RECOMMENDATIONS

Based on your friction analysis, here are the specific Discoveries you need to complete:

### Alignment Discoveries Needed
[Specify how many and why - for QGC activation and authentic genius]

**Why:** [Explain why Alignment Discoveries are needed based on their friction]

### Freedom Discoveries Needed
[Specify how many and why - for reducing gravity and vortex patterns]

**Why:** [Explain why Freedom Discoveries are needed based on their friction]

### Prosperity Discoveries Needed
[Specify how many and why - for increasing signal output and receiving capacity]

**Why:** [Explain why Prosperity Discoveries are needed based on their friction]

**Next Steps:**
1. Complete the recommended Discoveries above
2. Each Discovery will help you increase your CL, reduce gravity, and increase your signal to the field
3. Log each Discovery with the appropriate label (Alignment/Freedom/Prosperity)

---

## UNLIMITED CREATOR / CREATOR CLUB RECOMMENDATIONS

Based on current metrics, friction analysis, and collapse point:

### Primary Focus (now)

* **[Specific UC module recommendation based on friction analysis]**
* **[Specific UC module recommendation based on friction analysis]**
* **[Specific UC module recommendation based on friction analysis]**

Why:
[Explain why these modules are recommended based on their friction analysis]

### Deferred (not yet)

* [What should be deferred]
* [What should be deferred]

These come **after** [specific condition].

---

## EVOLUTION NOTE (Important)

What just happened is [rare/common] and [clean/complex]:

[Explain what structural shift occurred - be specific about what changed]

---

## FINAL SUMMARY

${userName}, [Personalized summary based on the conversation - what shifted, what it means, what's next]

---

### 📄 PDF STATUS

Your **Euphoriam Diagnostic PDF (${reportVersion})** has been generated and logged internally under your profile.

**Filename:**
\`${userName}_Euphoriam_Diagnostic_${new Date()
        .toISOString()
        .split("T")[0]
        .replace(/-/g, "")}_${reportVersion}.pdf\`

[Closing message based on the conversation]

We'll stop here.

---

Generate the full report in this exact format. Use actual insights from the conversation transcript, not placeholders.

**At the END of the report, after the closing message, add a METRICS JSON block in this exact format (for system parsing):**

METRICS_JSON_START
{
  "qgcActivation": [number 0-100 - calculate from new conversation],
  "consciousnessLevel": [number 1.0-5.0 - calculate from new conversation],
  "gravity": [number 0-100 - calculate from new conversation],
  "signalCoherence": [number 0-100 - calculate from new conversation],
  "signalOutput": [number 0-100 - system calculates automatically, do NOT show calculation method]
}
METRICS_JSON_END`;

    let discoveryReport = "";
    try {
      // Add timeout wrapper for OpenAI call
      const timeoutPromise = new Promise(
        (_, reject) =>
          setTimeout(() => reject(new Error("OpenAI request timeout")), 120000) // 2 minute timeout
      );

      const aiDiscoveryPromise = openai.chat.completions.create({
        model: "gpt-5.2",
        messages: [{ role: "user", content: discoveryPrompt }],
        temperature: 0.15,
        max_completion_tokens: 4500,
      });

      const aiDiscovery = await Promise.race([
        aiDiscoveryPromise,
        timeoutPromise,
      ]);
      discoveryReport =
        aiDiscovery?.choices?.[0]?.message?.content?.trim() || "";
    } catch (err) {
      console.error("[discovery] failed to generate follow-up report", err);
      // Return error response if report generation fails
      return errorResponse(
        res,
        "Failed to generate discovery report. Please try again.",
        500
      );
    }

    if (discoveryReport) {
      // Sanitize report to remove any formula references (IP protection)
      const {
        extractMetricsFromReport,
        sanitizeReportText,
      } = require("../helpers/euphoriamChatbot");

      // Sanitize report BEFORE extracting metrics (remove any formula references)
      discoveryReport = sanitizeReportText(
        discoveryReport,
        diagnosticMetrics || {}
      );

      // Import metrics calculator for formula-based calculations
      const {
        updateMetricsFromDiscovery,
      } = require("../helpers/metricsCalculator");

      // First try to extract from METRICS_JSON block
      let extractedMetrics = {};
      const metricsJsonMatch = discoveryReport.match(
        /METRICS_JSON_START\s*([\s\S]*?)\s*METRICS_JSON_END/
      );
      if (metricsJsonMatch) {
        try {
          extractedMetrics = JSON.parse(metricsJsonMatch[1].trim());
          console.log(
            "[discovery] Extracted metrics from JSON block:",
            extractedMetrics
          );
          // Remove the JSON block from report text
          discoveryReport = discoveryReport
            .replace(/METRICS_JSON_START[\s\S]*?METRICS_JSON_END/, "")
            .trim();
        } catch (e) {
          console.error("[discovery] Failed to parse metrics JSON:", e);
        }
      }

      // If no JSON block, try regex extraction
      if (!extractedMetrics || Object.keys(extractedMetrics).length === 0) {
        extractedMetrics = extractMetricsFromReport(discoveryReport);
        console.log(
          "[discovery] Extracted metrics from report text (regex):",
          extractedMetrics
        );
      }

      // Combine conversation text for formula-based calculation
      const conversationText =
        JSON.stringify(updatedTranscript, null, 2) + " " + discoveryReport;

      // Calculate metrics using Euphoriam Formula
      const finalMetrics = updateMetricsFromDiscovery({
        conversationText,
        existingMetrics: diagnosticMetrics || {},
        extractedMetrics,
      });

      console.log("[discovery] Final metrics (formula-based):", {
        signalOutput: finalMetrics.signalOutput,
        signalZone: finalMetrics.signalZone,
        gravityDepth: finalMetrics.gravityDepth,
        vortexSignature: finalMetrics.vortexSignature,
        integrationAngle: finalMetrics.integrationAngle,
      });

      console.log(
        "[discovery] Final metrics for discovery report:",
        finalMetrics
      );

      const discoveryTypeValue =
        discoveryType || req.body.discoveryType || "integrated";

      const userForDiscovery = existingDiagnostic?.userId
        ? await User.findByPk(existingDiagnostic.userId)
        : await User.findOne({ where: { email } });

      // Save discovery record immediately (before PDF/email)
      // Pass full reports (not truncated) so they can be saved in JSONB data field
      await persistDiscoveryRecord({
        userId: userForDiscovery?.id || existingDiagnostic?.userId || null,
        email,
        title: `Diagnostics Chat Report – ${userName}`,
        transcript: updatedTranscript,
        previousReport: fullPriorReport, // Full report, not truncated snippet
        newReport: discoveryReport, // Full new report
        diagnosticId: existingDiagnostic?.id || null,
        pdfUrl: null, // Will be updated after PDF is generated
        discoveryType: discoveryTypeValue,
        metrics: finalMetrics, // Include formula-based metrics
      });

      // Mark chat as ended when report is generated
      if (appUser) {
        const chatType = "discovery";
        // Find the latest incomplete chat for this user
        const chat = await Chat.findOne({
          where: {
            userId: appUser.id,
            chatType: chatType,
            isChatEnded: false,
            ...(existingDiagnostic?.id
              ? { dignosticId: existingDiagnostic.id }
              : {}),
          },
          order: [["createdAt", "DESC"]],
        });

        if (chat) {
          await chat.update({
            isChatEnded: true,
            data: {
              ...(chat.data || {}),
              transcript: updatedTranscript,
              messages: updatedTranscript,
              endedAt: new Date().toISOString(),
            },
          });
          console.log(
            `[handleDiscoveryMode] Chat ${chat.id} marked as ended for user ${email} (report generated)`
          );
        }
      }

      // Clear intakeState transcript since report is completed
      if (existingDiagnostic) {
        await existingDiagnostic.update({
          data: {
            ...(existingDiagnostic.data || {}),
            intakeState: {
              ...(existingDiagnostic.data?.intakeState || {}),
              transcript: [], // Clear transcript after report generation
              completedAt: new Date().toISOString(),
              mode: null, // Clear mode
            },
          },
        });
      }

      // Check if user explicitly requested email
      const lastUserMessage = lastUser?.content || "";
      const lowerMessage = lastUserMessage.toLowerCase();
      const explicitlyWantsEmail =
        /(email|send).*(me|the|my).*(report|it)/i.test(lowerMessage) ||
        /(generate|create|make|get).*(report|it).*(and|then).*(email|send)/i.test(
          lowerMessage
        ) ||
        /(end|finish|stop).*(chat|conversation).*(and|then).*(email|send)/i.test(
          lowerMessage
        );

      const userWantsEmail = checkWantsEmail(
        updatedTranscript,
        lastUser?.content
      );

      // Don't email if user just wants to stop/pause (e.g., "I'm good with this for now", "that's enough")
      const justStopping =
        /(I'm good|that's enough|I'm done|that's it|we can stop|stop here).*(for now|with this|here)/i.test(
          lowerMessage
        ) && !/(email|send|report)/i.test(lowerMessage);

      // Only email if user explicitly requested it AND didn't just say they're done
      let shouldEmail =
        (explicitlyWantsEmail || userWantsEmail) && !justStopping;

      // Send response immediately - don't wait for PDF/email
      // Include the bot's final message (nextMessage) with system message appended
      let finalBotMessage = nextMessage?.content || "";
      if (
        finalBotMessage &&
        !finalBotMessage.includes("Discovery report generated")
      ) {
        // Append the system message to the bot's final message
        finalBotMessage = `${finalBotMessage}\n\nDiscovery report generated. PDF are being processed in the background.`;
      }

      const response = successResponse(res, "Discovery chat saved", {
        discovery: true,
        message:
          "Discovery report generated. PDF are being processed in the background.",
        nextMessage: finalBotMessage
          ? {
            role: "assistant",
            content: finalBotMessage,
          }
          : nextMessage, // Include bot's final completion message + system message
        discoveryReport: discoveryReport || null,
        pdfPath: null, // Will be generated in background
        pdfUrl: null, // Will be updated after PDF is generated
        autoGenerated: true,
        status: "completed",
        statusMessage:
          "Report generated. PDF and email processing in background.",
        userMessage: `Your discovery report has been generated. ${shouldEmail
          ? "Email will be sent shortly."
          : "You can access it in your account."
          }`,
        emailed: false, // Will be updated in background
        // Don't include answeredCount or pendingQuestion in discovery mode - those are for diagnostic mode only
      });

      // Process PDF and email in background (don't await - fire and forget)
      (async () => {
        try {
          const discoveryForPdf = {
            id: existingDiagnostic?.id || Date.now(),
            title: `Diagnostics Chat Report – ${userName}`,
            userId: userForDiscovery?.id || existingDiagnostic?.userId || null,
            data: {
              profile: {
                name: userName,
                email: email,
              },
              aiReport: discoveryReport,
              metrics: finalMetrics, // Use metrics calculated from new responses
            },
          };

          let pdfPath = null;
          let pdfUrl = null;

          try {
            // Generate PDF in background
            pdfPath = await generateDiagnosticPdf(discoveryForPdf);

            if (pdfPath) {
              // Upload PDF in background
              const buffer = await fs.promises.readFile(pdfPath);
              const upload = await uploadBufferToSupabase({
                buffer,
                objectPath: `discoveries/discovery-${existingDiagnostic?.id || Date.now()
                  }-${Date.now()}.pdf`,
                contentType: "application/pdf",
              });

              pdfUrl = upload.url || null;

              // Update discovery record with PDF URL
              const latestDiscovery = await Discovery.findOne({
                where: {
                  userId:
                    userForDiscovery?.id || existingDiagnostic?.userId || null,
                  email: email,
                },
                order: [["createdAt", "DESC"]],
              });

              if (latestDiscovery) {
                await latestDiscovery.update({
                  pdfUrl: pdfUrl,
                });
              }
            }
          } catch (err) {
            console.error(
              "[discovery] PDF generation/upload failed (background):",
              err
            );
          }

          // Send email in background if requested
          if (email && shouldEmail && pdfPath) {
            try {
              await sendEmail(
                email,
                "Your Discovery Report – Euphoriam AI",
                discoveryReportEmail(userName),
                pdfPath
              );
              console.log("[discovery] Email sent successfully (background)");
            } catch (err) {
              console.error(
                "[discovery] Email sending failed (background):",
                err
              );
            }
          }
        } catch (err) {
          console.error("[discovery] Background processing error:", err);
        }
      })();

      return response;
    }
  }

  // Save incomplete discovery conversation to intakeState so user can resume
  if (updatedTranscript && updatedTranscript.length > 0) {
    const discoveryIntakeState = {
      transcript: updatedTranscript,
      discoveryType: discoveryType || "integrated",
      updatedAt: new Date().toISOString(),
      mode: "discovery",
    };

    if (existingDiagnostic) {
      await existingDiagnostic.update({
        data: {
          ...(existingDiagnostic.data || {}),
          intakeState: {
            ...(existingDiagnostic.data?.intakeState || {}),
            ...discoveryIntakeState,
          },
        },
      });
    } else if (appUser) {
      // Create a diagnostic record to store discovery state if none exists
      await Diagnostic.create({
        userId: appUser.id || null,
        email,
        title: `Discovery Chat (Draft) – ${name || email?.split("@")[0] || "User"
          }`,
        data: {
          profile: { name, email },
          intakeState: discoveryIntakeState,
        },
      });
    }
  }

  // Get updated state after saving
  const updatedState = existingDiagnostic
    ? (await Diagnostic.findByPk(existingDiagnostic.id))?.data?.intakeState ||
    existingState
    : existingState;

  // Final check: ensure nextMessage is never null
  if (
    !nextMessage ||
    !nextMessage.content ||
    nextMessage.content.trim() === ""
  ) {
    // Last resort: generate a response using LLM
    const lastUserMsg =
      transcript.filter((m) => m.role === "user").slice(-1)[0]?.content || "";

    try {
      // Let LLM understand the user's intent from context - no keyword matching
      const finalPrompt = lastUserMsg
        ? `The user asked: "${lastUserMsg}"

Answer directly and helpfully. Use their diagnostic report data to inform your response. Understand what they're asking for and provide a direct, helpful answer.

NEVER use generic phrases like "I'm here" or "How can I help you today?". Answer their actual question or request.`
        : "Provide a helpful response to the user. NEVER use generic phrases like 'I'm here' or 'How can I help you today?'.";

      const finalResponse = await openai.chat.completions.create({
        model: "gpt-5.2",
        messages: [
          {
            role: "system",
            content:
              getDiscoverySystemPrompt() ||
              "You are Euphoriam AI. Answer questions directly using the diagnostic report data provided. NEVER use generic phrases. Understand the user's intent and provide helpful, direct responses.",
          },
          { role: "user", content: finalPrompt },
        ],
        temperature: 0.7,
        max_completion_tokens: 1000,
      });

      const finalMessage = finalResponse?.choices?.[0]?.message;
      if (finalMessage?.content && finalMessage.content.trim() !== "") {
        nextMessage = finalMessage;
      } else {
        // Absolute last resort - but still avoid generic phrases
        nextMessage = {
          role: "assistant",
          content: `I'm having trouble generating a response right now. Please try asking again, or ask about a specific area from your report.`,
        };
      }
    } catch (err) {
      console.error("[finalCheck] Error generating answer:", err);
      nextMessage = {
        role: "assistant",
        content: `I'm having trouble generating a response right now. Please try asking again.`,
      };
    }
  }

  // Note: Chat saving is handled in chatbotDiagnosticFreeform to avoid duplicate saves
  // Don't save here to prevent creating multiple chat entries

  // Return regular discovery chat response
  // Don't include answeredCount or pendingQuestion - those are for diagnostic mode only (12-question progress)
  return successResponse(res, "Next chatbot message", {
    nextMessage,
    introPageText: introText,
    transcript: updatedTranscript,
    intakeState: updatedState,
    retrieved: [],
    resumeNotice: null,
    // answeredCount and pendingQuestion removed - not applicable to discovery mode
    status: "chatting",
    statusMessage: "Chatting in progress",
    canResume: true, // Always allow resuming
  });
};

/**
 * ============================================
 * DISCOVERY FINALIZE HANDLER
 * ============================================
 * Handles discovery finalize requests (finalize=true with existing report)
 */
const handleDiscoveryFinalize = async ({
  req,
  res,
  email,
  name,
  transcriptForFinal,
  existingDiagnostic,
  priorReportSnippet,
  diagnosticMetrics,
  appUser,
  introText,
  backgroundMode = false, // If true, skip email and don't send response
}) => {
  // Get previous discovery if exists
  const previousDiscoveries = await Discovery.findAll({
    where: {
      userId: existingDiagnostic?.userId || appUser?.id || null,
    },
    order: [["createdAt", "DESC"]],
    limit: 1,
  });
  const previousDiscovery = previousDiscoveries[0];

  // Get full prior report for saving to DB (not truncated snippet)
  // Try to get from latest discovery first, then from existing diagnostic
  const fullPriorReport =
    previousDiscovery?.data?.newReport ||
    previousDiscovery?.data?.previousReport ||
    existingDiagnostic?.data?.aiReport ||
    null;

  // // Generate a FULL discovery report using prior diagnostic + new transcript
  const reportDate = new Date().toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
  const reportVersion = previousDiscovery ? "v3.2" : "v3.1";
  const userName = name || email?.split("@")[0] || "User";

  const discoveryPrompt = `
You are generating a FULL DISCOVERY REPORT in PDF format for Euphoriam AI.

Context: The user already has a completed diagnostic report and may have previous discovery sessions.

Previous diagnostic (reference):
${priorReportSnippet || "None"}

${previousDiscovery
      ? `Previous discovery report (reference):
${truncateForContext(
        previousDiscovery.data?.newReport ||
        previousDiscovery.data?.previousReport ||
        previousDiscovery.newReportSnippet ||
        previousDiscovery.data?.newReportSnippet ||
        "",
        4000
      )}`
      : ""
    }

New conversation transcript (latest messages last):
${JSON.stringify(transcriptForFinal, null, 2)}

Client Name: ${userName}
Client ID: N/A
Report Type: Structural Update Report
Date: ${reportDate}

CRITICAL: You MUST generate the report in the EXACT format shown below. This is a structural update report based on the conversation interaction.

Generate a FULL DISCOVERY REPORT following this EXACT format:

---

## EUPHORIAM™ STRUCTURAL UPDATE REPORT

**Client:** ${userName}
**Report Type:** Identity Authority Collapse + Gravity Shift (or appropriate type based on conversation)
**Version:** ${reportVersion}
**Date:** ${reportDate}
**Tone:** Warm / Grounded

---

### 1. STRUCTURE TYPE (Updated)

**Primary Structure:**
[Analyze their primary structure based on metrics and conversation - be specific about what changed]

**Key refinement:**
[Explain what has shifted or been refined in their structure based on the conversation]

---

### 2. AVOIDANCE BEHAVIOUR (Resolved Layer)

**Original Pattern:**
[What was the original avoidance pattern from previous report]

**Updated Reading:**
[How the avoidance has changed or been resolved based on the conversation - be specific about what shifted]

---

### 3. VORTEX STATUS

**Previous Vortex:**
[What was the previous vortex state]

**Current State:**
[Current vortex status - use ⚠️ if destabilized, ✅ if stable, etc.]

Why:
[Explain what changed and why based on the conversation]

---

### 4. GRAVITY (3D CODE)

**Previous Gravity:** ~${diagnosticMetrics.gravity || "N/A"}%
**Current Reading:** [Current gravity status - use ↓ if dropping, ↑ if increasing, or stable]

Critical insight:
[Explain what the gravity shift means based on the conversation]

---

### 5. CONSCIOUSNESS LEVEL (CL)

**Previous CL:** ~${diagnosticMetrics.consciousnessLevel || "N/A"}
**Current CL:** [Current CL level]

Marker of shift:
[Explain what changed and what it indicates]

---

### 6. QUANTUM GENIUS CODES (QGC)

**Previous QGC:** ~${diagnosticMetrics.qgcActivation || "N/A"}%
**Current Status:** [Current QGC status]

[Explain what changed and what it means]

---

### 7. SIGNAL COHERENCE

**Signal Coherence:** [Current status - use exact value: ${diagnosticMetrics.signalCoherence || "N/A"
    }%]

Important note:
[Explain what the coherence level indicates]

---

### 8. SIGNAL OUTPUT

**Previous Output:** ~${diagnosticMetrics.signalOutput || "N/A"}%
**Current Status:** [Current status]

This is crucial:
[Explain what changed and why]

---

### 9. ANGLE OF GROWTH (Updated)

**Current Angle:**
[Their updated growth axis based on the conversation]

Not:
[What it's NOT about]

---

### 10. FIRST CORRECTION (Updated)

One sentence. Exact.

> **[The exact correction based on the conversation]**

That's it.

---

## METRICS GAUGE (Current Snapshot)

* **QGC Activation:** ${renderGauge(diagnosticMetrics.qgcActivation || 0)}  ~${diagnosticMetrics.qgcActivation || "N/A"
    }%
* **Consciousness Level:** ${renderGauge(
      (diagnosticMetrics.consciousnessLevel || 0) * 20
    )}  ~${diagnosticMetrics.consciousnessLevel || "N/A"}
* **Gravity:** ${renderGauge(
      diagnosticMetrics.gravity || 0
    )}  [Current status with arrow if changed]
* **Signal Coherence:** ${renderGauge(
      diagnosticMetrics.signalCoherence || 0
    )}  ${diagnosticMetrics.signalCoherence || "N/A"}%
* **Signal Output:** ${renderGauge(
      diagnosticMetrics.signalOutput || 0
    )}  [Current status]

---

## UNLIMITED CREATOR / CREATOR CLUB RECOMMENDATIONS

Based on current metrics and collapse point:

### Primary Focus (now)

* **[Specific recommendation 1]**
* **[Specific recommendation 2]**
* **[Specific recommendation 3]**

Why:
[Explain why these are recommended]

### Deferred (not yet)

* [What should be deferred]
* [What should be deferred]

These come **after** [specific condition].

---

## EVOLUTION NOTE (Important)

What just happened is [rare/common] and [clean/complex]:

[Explain what structural shift occurred - be specific about what changed]

---

## FINAL SUMMARY

${userName}, [Personalized summary based on the conversation - what shifted, what it means, what's next]

---

### 📄 PDF STATUS

Your **Euphoriam Diagnostic PDF (${reportVersion})** has been generated and logged internally under your profile.

**Filename:**
\`${userName}_Euphoriam_Diagnostic_${new Date()
      .toISOString()
      .split("T")[0]
      .replace(/-/g, "")}_${reportVersion}.pdf\`

[Closing message based on the conversation]

We'll stop here.

---

Generate the full report in this exact format. Use actual insights from the conversation transcript, not placeholders.`;

  const discoveryType = req.body.discoveryType || "integrated";

  const userForDiscovery = existingDiagnostic?.userId
    ? await User.findByPk(existingDiagnostic.userId)
    : await User.findOne({ where: { email } });

  // Save discovery record immediately (report will be generated in background)
  // Pass full report (not truncated snippet) so it can be saved in JSONB data field
  await persistDiscoveryRecord({
    userId: userForDiscovery?.id || existingDiagnostic?.userId || null,
    email,
    title: `Diagnostic Follow-up – ${name || email?.split("@")[0] || "User"}`,
    transcript: transcriptForFinal,
    previousReport: fullPriorReport, // Full report, not truncated snippet
    newReport: null, // Will be updated after report is generated
    diagnosticId: existingDiagnostic?.id || null,
    pdfUrl: null, // Will be updated after PDF is generated
    discoveryType,
  });

  // Mark chat as ended when report is generated
  if (appUser) {
    const chatType = "discovery";
    // Find the latest incomplete chat for this user
    const chat = await Chat.findOne({
      where: {
        userId: appUser.id,
        chatType: chatType,
        isChatEnded: false,
        ...(existingDiagnostic?.id
          ? { dignosticId: existingDiagnostic.id }
          : {}),
      },
      order: [["createdAt", "DESC"]],
    });

    if (chat) {
      await chat.update({
        isChatEnded: true,
        data: {
          ...(chat.data || {}),
          transcript: transcriptForFinal,
          messages: transcriptForFinal,
          endedAt: new Date().toISOString(),
        },
      });
      console.log(
        `[handleDiscoveryFinalize] Chat ${chat.id} marked as ended for user ${email}`
      );
    }
  }

  // Clear intakeState transcript since report is completed
  if (existingDiagnostic) {
    await existingDiagnostic.update({
      data: {
        ...(existingDiagnostic.data || {}),
        intakeState: {
          ...(existingDiagnostic.data?.intakeState || {}),
          transcript: [], // Clear transcript after report generation
          completedAt: new Date().toISOString(),
          mode: null, // Clear mode
        },
      },
    });
  }

  // Check if user explicitly requested email - only email if they say "email report" or similar
  const lastUserMessage =
    req.body.messages?.filter((m) => m?.role === "user")?.slice(-1)[0]
      ?.content || "";
  const transcriptMessages =
    transcriptForFinal?.filter((m) => m?.role === "user") || [];
  const lastTranscriptMessage =
    transcriptMessages[transcriptMessages.length - 1]?.content || "";
  const userMessageToCheck = lastUserMessage || lastTranscriptMessage || "";
  const lowerMessage = userMessageToCheck.toLowerCase();

  // Only email if user explicitly says "email report" or "email me the report" etc.
  const explicitlyWantsEmail =
    /(email|send).*(me|the|my).*(report|it)/i.test(lowerMessage) ||
    /(email|send).*(report|it)/i.test(lowerMessage);

  // Don't email if they just said "end chat", "I'm good", "that's enough" or similar without mentioning email/report
  const justEndingChat =
    (/(end|finish|stop|done|close).*(chat|conversation)/i.test(lowerMessage) ||
      /(I'm good|that's enough|I'm done|that's it|we can stop|stop here).*(for now|with this|here)/i.test(
        lowerMessage
      )) &&
    !/(email|send|report)/i.test(lowerMessage);

  const shouldEmail = backgroundMode
    ? false
    : explicitlyWantsEmail && !justEndingChat; // Don't email in background mode

  // Generate report, PDF and email in background (don't await - fire and forget)
  (async () => {
    let discoveryReport = "";
    try {
      const aiDiscovery = await openai.chat.completions.create({
        model: "gpt-5.2",
        messages: [{ role: "user", content: discoveryPrompt }],
        temperature: 0.15,
        max_completion_tokens: 4500,
        timeout: 120000, // 2 minute timeout
      });
      discoveryReport =
        aiDiscovery?.choices?.[0]?.message?.content?.trim() || "";

      if (discoveryReport) {
        // Update discovery record with generated report
        const latestDiscovery = await Discovery.findOne({
          where: {
            userId: userForDiscovery?.id || existingDiagnostic?.userId || null,
            email: email,
          },
          order: [["createdAt", "DESC"]],
        });

        if (latestDiscovery) {
          await latestDiscovery.update({
            newReportSnippet: truncateForContext(discoveryReport, 1500),
            data: {
              ...(latestDiscovery.data || {}),
              newReport: discoveryReport, // Save full report in JSONB
            },
          });
        }
      }
    } catch (err) {
      console.error(
        "[discovery] failed to generate follow-up report (background):",
        err
      );
      return; // Exit early if report generation fails
    }

    if (discoveryReport) {
      try {
        const discoveryForPdf = {
          id: existingDiagnostic?.id || Date.now(),
          title: `Diagnostics Chat Report – ${name || email?.split("@")[0] || "User"
            }`,
          userId: userForDiscovery?.id || existingDiagnostic?.userId || null,
          data: {
            profile: {
              name: name || email?.split("@")[0] || "User",
              email: email,
            },
            aiReport: discoveryReport,
            metrics: diagnosticMetrics,
          },
        };

        let pdfPath = null;
        let pdfUrl = null;

        try {
          pdfPath = await generateDiagnosticPdf(discoveryForPdf);

          if (pdfPath) {
            const buffer = await fs.promises.readFile(pdfPath);
            const upload = await uploadBufferToSupabase({
              buffer,
              objectPath: `discoveries/discovery-${existingDiagnostic?.id || Date.now()
                }-${Date.now()}.pdf`,
              contentType: "application/pdf",
            });
            pdfUrl = upload.url || null;

            // Update discovery record with PDF URL
            const latestDiscovery = await Discovery.findOne({
              where: {
                userId:
                  userForDiscovery?.id || existingDiagnostic?.userId || null,
                email: email,
              },
              order: [["createdAt", "DESC"]],
            });

            if (latestDiscovery) {
              await latestDiscovery.update({
                pdfUrl: pdfUrl,
              });
            }
          }
        } catch (err) {
          console.error(
            "[discovery finalize] PDF generation/upload failed (background):",
            err
          );
        }

        // Send email in background ONLY if user explicitly requested it
        if (email && shouldEmail && pdfPath) {
          try {
            await sendEmail(
              email,
              "Your Discovery Report – Euphoriam AI",
              discoveryReportEmail(name || email?.split("@")[0] || "User"),
              pdfPath
            );
            console.log(
              "[discovery finalize] Email sent successfully (background)"
            );
          } catch (err) {
            console.error(
              "[discovery finalize] Email sending failed (background):",
              err
            );
          }
        } else if (email && !shouldEmail) {
          console.log(
            "[discovery finalize] Email not sent - user did not explicitly request it"
          );
        } else if (backgroundMode) {
          console.log(
            `[discovery finalize] Report generated and saved in background for user ${email} (no email sent)`
          );
        }
      } catch (err) {
        console.error("[discovery finalize] Background processing error:", err);
      }
    }
  })();

  // Background mode - already processing above, just return
  if (backgroundMode) {
    return;
  }

  // Send response if not in background mode
  return successResponse(res, "Discovery chat saved", {
    discovery: true,
    message: shouldEmail
      ? "Chat ended. Your discovery report is being generated and will be emailed to you shortly."
      : "Chat ended. Your discovery report is being generated and will be available in your account shortly.",
    discoveryReport: null, // Will be generated in background
    pdfPath: null, // Will be generated in background
    pdfUrl: null, // Will be updated after PDF is generated
    status: "processing",
    statusMessage:
      "Report generation in progress. This may take a few minutes.",
    userMessage: shouldEmail
      ? "Chat ended. Your discovery report is being generated and will be emailed to you shortly. This may take a few minutes."
      : "Chat ended. Your discovery report is being generated and will be available in your account shortly. This may take a few minutes.",
    emailed: false, // Will be updated in background
  });
};

/**
 * ============================================
 * DIAGNOSTIC FINALIZE HANDLER
 * ============================================
 * Handles diagnostic finalize requests (finalize=true without existing report)
 */
const handleDiagnosticFinalize = async ({
  req,
  res,
  email,
  name,
  transcriptForFinal,
  existingDiagnostic,
  priorReportSnippet,
  previousReports,
  appUser,
  existingState,
  introText,
  retrieved,
  backgroundMode = false, // If true, skip email and don't send response
}) => {
  if (!email || typeof email !== "string" || !email.includes("@")) {
    console.error("[diagnostic] Invalid email:", email);
    return errorResponse(res, "Invalid email address", 400);
  }

  const userName = name || email?.split("@")[0] || "User";

  // Get or create diagnostic record (without report yet)
  let diagnostic = existingDiagnostic;
  if (!diagnostic) {
    // Use safe find to avoid chatId column errors
    try {
      diagnostic = await Diagnostic.findOne({
        where: { email },
        attributes: [
          "id",
          "userId",
          "email",
          "title",
          "data",
          "createdAt",
          "updatedAt",
        ],
      });
    } catch (err) {
      // If still fails, try without attributes (will use model defaults)
      diagnostic = await Diagnostic.findOne({ where: { email } });
    }
  }

  // Save discovery record immediately (report will be generated in background)
  const userForFinal = diagnostic?.userId
    ? await User.findByPk(diagnostic.userId)
    : await User.findOne({ where: { email } });

  await persistDiscoveryRecord({
    userId: userForFinal?.id || diagnostic?.userId || null,
    email,
    title: `Euphoriam Diagnostic v3 (Freeform) – ${userName}`,
    transcript: transcriptForFinal,
    previousReport: null,
    newReport: null, // Will be updated after report is generated
    diagnosticId: diagnostic?.id || null,
    pdfUrl: null, // Will be updated after PDF is generated
  });

  // Mark chat as ended when report is generated
  if (appUser) {
    const chatType = "dignostic";
    // Find the latest incomplete chat for this user
    const chat = await Chat.findOne({
      where: {
        userId: appUser.id,
        chatType: chatType,
        isChatEnded: false,
        ...(diagnostic?.id ? { dignosticId: diagnostic.id } : {}),
      },
      order: [["createdAt", "DESC"]],
    });

    if (chat) {
      await chat.update({
        isChatEnded: true,
        data: {
          ...(chat.data || {}),
          transcript: transcriptForFinal,
          messages: transcriptForFinal,
          endedAt: new Date().toISOString(),
        },
      });
      console.log(
        `[handleDiagnosticFinalize] Chat ${chat.id} marked as ended for user ${email} (report generated)`
      );
    }
  }

  // Check if user explicitly requested email - only email if they say "email report" or similar
  const lastUserMessage =
    req.body.messages?.filter((m) => m?.role === "user")?.slice(-1)[0]
      ?.content || "";
  const transcriptMessages =
    transcriptForFinal?.filter((m) => m?.role === "user") || [];
  const lastTranscriptMessage =
    transcriptMessages[transcriptMessages.length - 1]?.content || "";
  const userMessageToCheck = lastUserMessage || lastTranscriptMessage || "";
  const lowerMessage = userMessageToCheck.toLowerCase();

  // Only email if user explicitly says "email report" or "email me the report" etc.
  const explicitlyWantsEmail =
    /(email|send).*(me|the|my).*(report|it)/i.test(lowerMessage) ||
    /(email|send).*(report|it)/i.test(lowerMessage);

  // Don't email if they just said "end chat", "I'm good", "that's enough" or similar without mentioning email/report
  const justEndingChat =
    (/(end|finish|stop|done|close).*(chat|conversation)/i.test(lowerMessage) ||
      /(I'm good|that's enough|I'm done|that's it|we can stop|stop here).*(for now|with this|here)/i.test(
        lowerMessage
      )) &&
    !/(email|send|report)/i.test(lowerMessage);

  const shouldEmail = backgroundMode
    ? false
    : explicitlyWantsEmail && !justEndingChat; // Don't email in background mode

  // Generate report, PDF and email in background (don't await - fire and forget)
  (async () => {
    const prompt = await getLatestPromptFromDb();
    const promptContent =
      typeof prompt === "string"
        ? prompt
        : prompt?.fullPrompt || prompt?.content || "";

    // Ensure promptContent is always a string, never null or undefined
    const safePromptContent =
      promptContent && typeof promptContent === "string" ? promptContent : "";

    const userPromptContent = buildFinalReportPrompt({
      customerContext: null,
      intakeAnswers: transcriptForFinal,
      introPageText: introText,
      retrieved,
      previousReport: priorReportSnippet,
    });

    // Ensure user content is always a string
    const safeUserContent =
      userPromptContent && typeof userPromptContent === "string"
        ? userPromptContent
        : "";

    if (!safePromptContent || !safeUserContent) {
      console.error(
        "[diagnostic] Invalid prompt or user content (background):",
        { promptContent: safePromptContent, userContent: safeUserContent }
      );
      return; // Exit early in background mode
    }

    let reportText = "";
    try {
      const aiResponse = await openai.chat.completions.create({
        model: "gpt-5.2",
        messages: [
          { role: "system", content: safePromptContent },
          {
            role: "user",
            content: safeUserContent,
          },
        ],
        temperature: 0.15,
        max_completion_tokens: 4500,
        timeout: 120000, // 2 minute timeout
      });

      reportText = (aiResponse?.choices?.[0]?.message?.content || "").trim();

      if (!reportText) {
        console.error(
          "[diagnostic] AI returned empty diagnostic report (background)"
        );
        return; // Exit early if report generation fails
      }

      // Update diagnostic with generated report
      const finalPayload = {
        userId: appUser.id || null,
        email: email.trim(),
        title: `Euphoriam Diagnostic v3 (Freeform) – ${userName}`,
        report: reportText, // Save report in report column
        data: {
          diagnosticVersion: 3,
          generatedAt: new Date(),
          profile: {
            name: userName,
            email: email.trim(),
          },
          metrics: {},
          previousReports,
          intakeTranscript: transcriptForFinal,
          aiReport: reportText,
          intakeState: {
            ...(existingState || {}),
            transcript: transcriptForFinal,
            finalizedAt: new Date().toISOString(),
          },
        },
      };

      if (diagnostic) {
        await diagnostic.update(finalPayload);
      } else {
        try {
          diagnostic = await Diagnostic.create(finalPayload);
        } catch (createError) {
          if (
            createError.name === "SequelizeUniqueConstraintError" ||
            createError.name === "ValidationError"
          ) {
            diagnostic = await Diagnostic.findOne({ where: { email } });
            if (diagnostic) {
              await diagnostic.update(finalPayload);
            }
          }
        }
      }

      // Update discovery record with generated report
      const latestDiscovery = await Discovery.findOne({
        where: {
          userId: userForFinal?.id || diagnostic?.userId || null,
          email: email,
        },
        order: [["createdAt", "DESC"]],
      });

      if (latestDiscovery) {
        await latestDiscovery.update({
          newReportSnippet: truncateForContext(reportText, 1500),
          data: {
            ...(latestDiscovery.data || {}),
            newReport: reportText, // Save full report in JSONB
          },
        });
      }
    } catch (err) {
      console.error(
        "[diagnostic] Failed to generate report (background):",
        err
      );
      return; // Exit early if report generation fails
    }

    if (reportText) {
      try {
        const pdfPath = await generateDiagnosticPdf(diagnostic);
        let pdf = { path: pdfPath, url: null };

        try {
          const buffer = await fs.promises.readFile(pdfPath);
          const upload = await uploadBufferToSupabase({
            buffer,
            objectPath: `diagnostics/${diagnostic.id || Date.now()}.pdf`,
            contentType: "application/pdf",
          });
          pdf = upload;
          console.log(
            "[diagnostic] PDF uploaded to Supabase (background)",
            upload
          );

          // Update diagnostic with PDF URL
          await diagnostic.update({
            pdfUrl: pdf.url || null,
            data: {
              ...(diagnostic.data || {}),
              pdf,
            },
          });

          // Update discovery record with PDF URL
          const latestDiscovery = await Discovery.findOne({
            where: {
              userId: userForFinal?.id || diagnostic?.userId || null,
              email: email,
            },
            order: [["createdAt", "DESC"]],
          });

          if (latestDiscovery) {
            await latestDiscovery.update({
              pdfUrl: pdf.url || null,
            });
          }
        } catch (err) {
          console.error(
            "[diagnostic] Failed to upload diagnostic PDF to Supabase (background)",
            err
          );
        }

        // Send email in background ONLY if user explicitly requested it
        if (shouldEmail && pdfPath) {
          try {
            await sendEmail(
              email,
              "Your Diagnostic Report – Euphoraum-AI",
              diagnosticReportEmail(userName),
              pdfPath
            );
            console.log("[diagnostic] Email sent successfully (background)");
          } catch (err) {
            console.error(
              "[diagnostic] Email sending failed (background):",
              err
            );
          }
        } else if (!shouldEmail) {
          console.log(
            "[diagnostic] Email not sent - user did not explicitly request it"
          );
        } else if (backgroundMode) {
          console.log(
            `[diagnostic] Report generated and saved in background for user ${email} (no email sent)`
          );
        }
      } catch (err) {
        console.error(
          "[diagnostic] PDF/email processing error (background):",
          err
        );
      }
    }
  })();

  // Background mode - already processing above, just return
  if (backgroundMode) {
    return;
  }

  // Send response if not in background mode
  return successResponse(res, "Chatbot diagnostic (freeform) generated", {
    diagnosticId: diagnostic?.id || null,
    diagnostic: diagnostic?.data || {},
    pdfPath: null, // Will be generated in background
    pdfUrl: null, // Will be updated after PDF is generated
    reportText: null, // Will be generated in background
    status: "processing",
    statusMessage:
      "Report generation in progress. This may take a few minutes.",
    userMessage: shouldEmail
      ? "Chat ended. Your diagnostic report is being generated and will be emailed to you shortly. This may take a few minutes."
      : "Chat ended. Your diagnostic report is being generated and will be available in your account shortly. This may take a few minutes.",
    emailed: false, // Will be updated in background
  });
};

/**
 * ============================================
 * DIAGNOSTIC MODE HANDLER
 * ============================================
 * Handles all diagnostic mode logic for first-time users or users requesting new diagnostics
 * This includes:
 * - 12-question intake flow
 * - Auto-finalization when all questions answered
 * - Diagnostic report generation
 */
const handleDiagnosticMode = async ({
  req,
  res,
  email,
  name,
  messages,
  transcript,
  updatedTranscript,
  existingDiagnostic,
  existingState,
  priorReportSnippet,
  previousReports,
  appUser,
  lastUser,
  lastAssistant,
  nextMessage,
  introText,
  targetCount,
  answeredCount,
  pendingQuestion,
  aiAnswered,
  distinctQuestionNumbers,
  maxQuestionNumber,
  distinctQuestionsAnswered,
  resumeNotice,
  wantsNewDiagnostic,
  hasExistingReport,
}) => {
  // Count questions in the ORIGINAL transcript (before nextMessage) to see what's been answered
  const {
    distinctQuestionNumbers: transcriptDistinctQuestionNumbers,
    maxQuestionNumber: transcriptMaxQuestionNumber,
    distinctQuestionsAnswered: transcriptDistinctQuestionsAnswered,
  } = trackQuestionNumbers(transcript);

  // Count questions in updatedTranscript to see if Q12 was just asked (not answered yet)
  const {
    distinctQuestionNumbers: updatedDistinctQuestionNumbers,
    maxQuestionNumber: updatedMaxQuestionNumber,
    distinctQuestionsAnswered: updatedDistinctQuestionsAnswered,
  } = trackQuestionNumbers(updatedTranscript);

  // CRITICAL: Only count questions that have been ANSWERED, not just asked
  // Use transcriptDistinctQuestionsAnswered (before nextMessage) to see what user has actually answered
  // If updatedTranscript has more questions, it means a new question was just asked but not answered yet
  const questionsAnswered = transcriptDistinctQuestionsAnswered;
  const newQuestionJustAsked =
    updatedDistinctQuestionsAnswered > transcriptDistinctQuestionsAnswered;

  // Check if we have 12 distinct questions ANSWERED (not just asked)
  const hasAllQuestionsAnswered = questionsAnswered >= targetCount;

  console.log("[diagnostic] Auto-finalization check:", {
    hasExistingReport,
    wantsNewDiagnostic,
    answeredCount,
    targetCount,
    pendingQuestion,
    aiAnswered,
    distinctQuestionsAnswered,
    questionsAnswered, // Questions actually answered by user
    transcriptDistinctQuestionsAnswered,
    updatedDistinctQuestionsAnswered,
    newQuestionJustAsked, // True if Q12 was just asked but not answered
    maxQuestionNumber: transcriptMaxQuestionNumber,
    updatedMaxQuestionNumber,
    hasAllQuestionsAnswered,
    transcriptLength: transcript.length,
    updatedTranscriptLength: updatedTranscript.length,
    lastUserContent: lastUser?.content,
    lastAssistantContent: lastAssistant?.content,
  });

  // Check if assistant's message indicates completion (fallback check)
  const assistantSaysComplete =
    nextMessage?.content &&
    typeof nextMessage.content === "string" &&
    /(I have|have enough|enough to generate|generate.*diagnostic|ready to generate|let me generate)/i.test(
      nextMessage.content
    );

  // Check if user explicitly requested to generate report (even if not detected as "answer")
  const {
    detectUserWantsToEndOrGenerateReport,
  } = require("../utils/validation");
  const userWantsToGenerateReport = lastUser?.content
    ? await detectUserWantsToEndOrGenerateReport({
      userMessage: lastUser.content,
      transcript: transcript,
    })
    : false;

  // CRITICAL: If assistant just said they're ready to generate AND we have 12+ questions answered,
  // we MUST finalize immediately - don't let the bot continue asking questions
  // This takes priority over everything else - if assistant says ready with 12+ questions, finalize NOW
  const assistantReadyAndQuestionsComplete =
    assistantSaysComplete && questionsAnswered >= 12;

  // Auto-finalization: If we've gathered all answers, auto-generate the diagnostic/PDF
  // Key conditions:
  // 1. We have 12+ distinct questions ANSWERED (not just asked) - ALWAYS require 12 for full diagnostic
  // 2. The last user message was a valid answer (aiAnswered = true) OR user explicitly requested to generate report
  // 3. There's no pending question (user has answered the last question) OR user explicitly requested to generate
  // 4. No new question was just asked (we want to wait for user to answer Q12)
  // OR if assistant explicitly says they have enough AND user has answered 12 questions
  //
  // Allow auto-finalization if:
  // - No existing report (new user) OR
  // - User wants new diagnostic OR
  // - User has answered 12 questions (regardless of existing report - generate discovery report)
  // IMPORTANT: Always require 12 questions for a full diagnostic, even if targetCount is 6 for discovery updates
  // CRITICAL: If assistant says they're ready to generate with 12+ questions, finalize immediately (highest priority)
  // CRITICAL: Otherwise, don't auto-finalize if user wants a NEW diagnostic (they want to start over, not generate current)
  const shouldAutoFinalize =
    // PRIORITY 1: If assistant says ready with 12+ questions, finalize immediately (ignore wantsNewDiagnostic)
    assistantReadyAndQuestionsComplete ||
    // PRIORITY 2: Normal auto-finalization (12 questions answered + normal conditions + not wanting new diagnostic)
    (!wantsNewDiagnostic && // Don't auto-finalize if user wants a NEW diagnostic (they want to start over, not generate current)
      questionsAnswered >= 12 && // ALWAYS require 12 questions
      (!hasExistingReport || wantsNewDiagnostic || questionsAnswered >= 12) && // Allow if new user, wants new diagnostic, OR answered 12 questions
      !newQuestionJustAsked && // Q12 wasn't just asked (wait for answer)
      (!pendingQuestion || userWantsToGenerateReport) && // User has answered the last question OR explicitly requested to generate
      (aiAnswered || userWantsToGenerateReport)); // The last user message was a valid answer OR user explicitly requested to generate

  if (shouldAutoFinalize) {
    console.log(
      "[diagnostic] ✅ Auto-finalization triggered - generating report",
      {
        transcriptDistinctQuestionsAnswered,
        updatedDistinctQuestionsAnswered,
        targetCount,
        pendingQuestion,
        aiAnswered,
        userWantsToGenerateReport,
        assistantReadyAndQuestionsComplete,
        hasAllQuestionsAnswered,
        questionsAnswered,
        assistantSaysComplete,
        nextMessagePreview: nextMessage?.content?.substring(0, 100),
      }
    );
    const metrics = {};

    const finalizeRetrieved = lastUser?.content
      ? await retrieveSimilarChunks({ query: lastUser.content, topK: 3 })
      : [];
    const prompt = await getLatestPromptFromDb();
    const promptContent =
      typeof prompt === "string"
        ? prompt
        : prompt?.fullPrompt || prompt?.content || "";

    // Ensure promptContent is always a string, never null or undefined
    const safePromptContent =
      promptContent && typeof promptContent === "string" ? promptContent : "";

    // Use updatedTranscript to include all messages, but filter out the assistant's "I have enough" message
    // if it's just an acknowledgment (we want the actual Q&A pairs)
    const transcriptForReport =
      updatedTranscript && updatedTranscript.length > 0
        ? updatedTranscript
        : transcript;

    console.log("[diagnostic] Using transcript for report generation:", {
      transcriptLength: transcript.length,
      updatedTranscriptLength: updatedTranscript.length,
      transcriptForReportLength: transcriptForReport.length,
    });

    const userPromptContent = buildFinalReportPrompt({
      customerContext: null,
      intakeAnswers: transcriptForReport,
      introPageText: introText,
      retrieved: finalizeRetrieved,
      previousReport: priorReportSnippet,
    });

    // Ensure user content is always a string
    const safeUserContent =
      userPromptContent && typeof userPromptContent === "string"
        ? userPromptContent
        : "";

    if (!safePromptContent || !safeUserContent) {
      console.error("[diagnostic] Invalid prompt or user content:", {
        promptContent: safePromptContent,
        userContent: safeUserContent,
      });
      return errorResponse(
        res,
        "Failed to generate diagnostic: missing prompt content",
        500
      );
    }

    const finalizeResponse = await openai.chat.completions.create({
      model: "gpt-5.2",
      messages: [
        { role: "system", content: safePromptContent },
        {
          role: "user",
          content: safeUserContent,
        },
      ],
      temperature: 0.15,
      max_completion_tokens: 4500,
    });

    let reportText = (
      finalizeResponse?.choices?.[0]?.message?.content || ""
    ).trim();

    // Extract metrics from the generated report text
    // First try to extract from METRICS_JSON block at the end
    let extractedMetrics = {};
    const metricsJsonMatch = reportText.match(
      /METRICS_JSON_START\s*([\s\S]*?)\s*METRICS_JSON_END/
    );
    if (metricsJsonMatch) {
      try {
        extractedMetrics = JSON.parse(metricsJsonMatch[1].trim());
        console.log(
          "[diagnostic] Extracted metrics from JSON block:",
          extractedMetrics
        );
        // Remove the JSON block from report text
        reportText = reportText
          .replace(/METRICS_JSON_START[\s\S]*?METRICS_JSON_END/, "")
          .trim();
      } catch (e) {
        console.error("[diagnostic] Failed to parse metrics JSON:", e);
      }
    }

    // If no JSON block, try regex extraction
    if (!extractedMetrics || Object.keys(extractedMetrics).length === 0) {
      const {
        extractMetricsFromReport,
      } = require("../helpers/euphoriamChatbot");
      extractedMetrics = extractMetricsFromReport(reportText);
      console.log(
        "[diagnostic] Extracted metrics from report text (regex):",
        extractedMetrics
      );
    }

    // Merge extracted metrics with any existing metrics
    const finalMetrics = {
      ...metrics,
      ...extractedMetrics,
      // Use extracted values if available, otherwise keep existing
      gravity: extractedMetrics.gravity ?? metrics.gravity,
      signalCoherence:
        extractedMetrics.signalCoherence ?? metrics.signalCoherence,
      signalOutput: extractedMetrics.signalOutput ?? metrics.signalOutput,
      consciousnessLevel:
        extractedMetrics.consciousnessLevel ?? metrics.consciousnessLevel,
      qgcActivation: extractedMetrics.qgcActivation ?? metrics.qgcActivation,
    };

    console.log("[diagnostic] Final metrics for saving:", {
      extractedMetrics,
      finalMetrics,
      reportTextLength: reportText.length,
    });

    reportText = sanitizeReportText(reportText, finalMetrics);

    if (!email || typeof email !== "string" || !email.includes("@")) {
      console.error("[diagnostic] Invalid email:", email);
      return errorResponse(res, "Invalid email address", 400);
    }

    const userName = name || email?.split("@")[0] || "User";

    const diagnosticPayload = {
      userId: appUser.id || null,
      email: email.trim(),
      title: `Euphoriam Diagnostic v3 (Freeform) – ${userName}`,
      data: {
        diagnosticVersion: 3,
        generatedAt: new Date(),
        profile: {
          name: userName,
          email: email.trim(),
        },
        metrics: finalMetrics, // Use extracted metrics
        previousReports,
        intakeTranscript: updatedTranscript,
        aiReport: reportText,
        intakeState: {
          ...existingState,
          finalizedAt: new Date().toISOString(),
        },
      },
    };

    let diagnostic = existingDiagnostic;
    if (!diagnostic) {
      // Use safe find to avoid chatId column errors
      try {
        diagnostic = await Diagnostic.findOne({
          where: { email },
          attributes: [
            "id",
            "userId",
            "email",
            "title",
            "data",
            "createdAt",
            "updatedAt",
          ],
        });
      } catch (err) {
        diagnostic = await Diagnostic.findOne({ where: { email } });
      }
    }

    if (wantsNewDiagnostic && diagnostic && diagnostic.data?.aiReport) {
      const oldReportEntry = {
        aiReport: diagnostic.data.aiReport,
        pdfUrl: diagnostic.data.pdf?.url || null,
        savedAt:
          diagnostic.updatedAt ||
          diagnostic.createdAt ||
          new Date().toISOString(),
      };
      diagnosticPayload.data.previousReports = Array.isArray(
        diagnostic.data.previousReports
      )
        ? [...diagnostic.data.previousReports, oldReportEntry]
        : [oldReportEntry];
    }

    if (diagnosticPayload.data.intakeState) {
      diagnosticPayload.data.intakeState.requestingNewDiagnostic = false;
    }

    if (diagnostic) {
      diagnostic = await diagnostic.update(diagnosticPayload);
    } else {
      try {
        diagnostic = await Diagnostic.create(diagnosticPayload);
      } catch (createError) {
        if (
          createError.name === "SequelizeUniqueConstraintError" ||
          createError.name === "ValidationError"
        ) {
          // Use safe find to avoid chatId column errors
          try {
            diagnostic = await Diagnostic.findOne({
              where: { email },
              attributes: [
                "id",
                "userId",
                "email",
                "title",
                "data",
                "createdAt",
                "updatedAt",
              ],
            });
          } catch (err) {
            diagnostic = await Diagnostic.findOne({ where: { email } });
          }
          if (diagnostic) {
            diagnostic = await diagnostic.update(diagnosticPayload);
          } else {
            throw createError;
          }
        } else {
          throw createError;
        }
      }
    }

    // Save discovery record immediately (before PDF/email)
    await persistDiscoveryRecord({
      userId: appUser?.id || diagnostic.userId || 0,
      email,
      title: diagnosticPayload.title,
      transcript: updatedTranscript,
      previousReport: null,
      newReport: reportText,
      diagnosticId: diagnostic.id,
      pdfUrl: null, // Will be updated after PDF is generated
    });

    // Mark chat as ended when report is generated
    if (appUser) {
      const chatType = "dignostic";
      // Find the latest incomplete chat for this user
      const chat = await Chat.findOne({
        where: {
          userId: appUser.id,
          chatType: chatType,
          isChatEnded: false,
          ...(diagnostic?.id ? { dignosticId: diagnostic.id } : {}),
        },
        order: [["createdAt", "DESC"]],
      });

      if (chat) {
        await chat.update({
          isChatEnded: true,
          data: {
            ...(chat.data || {}),
            transcript: updatedTranscript,
            messages: updatedTranscript,
            endedAt: new Date().toISOString(),
          },
        });
        console.log(
          `[chatbotDiagnosticFreeform] Chat ${chat.id} marked as ended for user ${email} (auto-finalized)`
        );
      }
    }

    // Check if user explicitly requested email - only email if they say "email report" or similar
    const lastUserMessage = lastUser?.content || "";
    const transcriptMessages =
      updatedTranscript?.filter((m) => m?.role === "user") || [];
    const lastTranscriptMessage =
      transcriptMessages[transcriptMessages.length - 1]?.content || "";
    const userMessageToCheck = lastUserMessage || lastTranscriptMessage || "";
    const lowerMessage = userMessageToCheck.toLowerCase();

    // Only email if user explicitly says "email report" or "email me the report" etc.
    const explicitlyWantsEmail =
      /(email|send).*(me|the|my).*(report|it)/i.test(lowerMessage) ||
      /(email|send).*(report|it)/i.test(lowerMessage);

    // Don't email if they just said "end chat" or similar without mentioning email/report
    const justEndingChat =
      /(end|finish|stop|done|close).*(chat|conversation)/i.test(lowerMessage) &&
      !/(email|send|report)/i.test(lowerMessage);

    // For auto-finalization after 12 questions, always email the report
    // User has completed the full intake, so they should receive their report
    const shouldEmail =
      explicitlyWantsEmail || (questionsAnswered >= 12 && !justEndingChat);

    console.log("[diagnostic] Auto-finalization email decision:", {
      explicitlyWantsEmail,
      questionsAnswered,
      shouldEmail,
      justEndingChat,
    });

    // Send response immediately - don't wait for PDF/email
    const response = successResponse(
      res,
      "Chatbot diagnostic (auto-finalized)",
      {
        diagnosticId: diagnostic.id,
        diagnostic: diagnostic.data,
        pdfPath: null, // Will be generated in background
        pdfUrl: null, // Will be updated after PDF is generated
        reportText,
        autoFinalized: true,
        resumeNotice,
        status: "completed",
        statusMessage: shouldEmail
          ? "Report generated. PDF and email processing in background."
          : "Report generated. PDF processing in background.",
        userMessage: shouldEmail
          ? "Your diagnostic report has been generated and will be emailed to you shortly. PDF is being processed in the background."
          : "Your diagnostic report has been generated and saved. PDF is being processed in the background. You can access it in your account anytime.",
        emailed: false, // Will be updated in background
      }
    );

    // Process PDF and email in background (don't await - fire and forget)
    (async () => {
      try {
        const pdfPath = await generateDiagnosticPdf(diagnostic);
        let pdf = { path: pdfPath, url: null };

        try {
          const buffer = await fs.promises.readFile(pdfPath);
          const upload = await uploadBufferToSupabase({
            buffer,
            objectPath: `diagnostics/${diagnostic.id || Date.now()}.pdf`,
            contentType: "application/pdf",
          });
          pdf = upload;
          console.log(
            "[diagnostic] PDF uploaded to Supabase (background)",
            upload
          );

          // Update diagnostic with PDF URL
          await diagnostic.update({
            pdfUrl: pdf.url || null,
            data: {
              ...(diagnostic.data || {}),
              pdf,
            },
          });

          // Update discovery record with PDF URL
          const latestDiscovery = await Discovery.findOne({
            where: {
              userId: appUser?.id || diagnostic.userId || 0,
              email: email,
            },
            order: [["createdAt", "DESC"]],
          });

          if (latestDiscovery) {
            await latestDiscovery.update({
              pdfUrl: pdf.url || null,
            });
          }
        } catch (err) {
          console.error(
            "[diagnostic] Failed to upload diagnostic PDF to Supabase (background)",
            err
          );
        }

        // Send email in background if user requested it OR if they completed 12 questions
        if (shouldEmail && pdfPath) {
          try {
            await sendEmail(
              email,
              "Your Diagnostic Report – Euphoraum-AI",
              diagnosticReportEmail(userName),
              pdfPath
            );
            console.log("[diagnostic] Email sent successfully (background)", {
              email,
              questionsAnswered,
              explicitlyWantsEmail,
              autoFinalized: true,
            });
          } catch (err) {
            console.error(
              "[diagnostic] Email sending failed (background):",
              err
            );
          }
        } else if (!shouldEmail) {
          console.log(
            "[diagnostic] Email not sent - user did not request it and questionsAnswered < 12",
            { questionsAnswered, explicitlyWantsEmail, autoFinalized: true }
          );
        } else if (!pdfPath) {
          console.error(
            "[diagnostic] Email not sent - PDF generation failed or path is missing",
            { autoFinalized: true }
          );
        }
      } catch (err) {
        console.error("[diagnostic] Background processing error:", err);
      }
    })();

    return response;
  }

  // Note: Chat saving is handled in chatbotDiagnosticFreeform to avoid duplicate saves
  // Don't save here to prevent creating multiple chat entries

  // Return regular diagnostic chat response
  return successResponse(res, "Next chatbot message", {
    nextMessage,
    introPageText: introText,
    transcript: updatedTranscript,
    intakeState: existingState,
    retrieved: [],
    resumeNotice,
    answeredCount,
    pendingQuestion,
    aiAnswered,
    status: "chatting",
    statusMessage: "Chatting in progress",
  });
};

const chatbotDiagnosticFreeform = async (req, res) => {
  const {
    email,
    name,
    messages = [],
    assessmentIds = [],
    finalize = false,
    introPageText,
    targetCount = 12,
  } = req.body || {};

  // Validate request
  const validation = validateChatbotRequest(req);
  if (!validation.valid) {
    return errorResponse(res, validation.error, validation.statusCode);
  }
  // Find user
  let appUser = await User.findOne({ where: { email, name } });
  // Load diagnostic state
  const {
    existingDiagnostic,
    existingState,
    existingReport,
    diagnosticMetrics,
  } = await loadDiagnosticState(email);

  // If no messages provided, check for incomplete chat and return it if exists
  const hasNoMessages = !messages || messages.length === 0;

  if (hasNoMessages && !finalize) {
    const hasExistingReport = Boolean(existingReport);
    const transcript = existingState?.transcript || [];
    const intakeState = existingState || {};

    // Load metrics for discovery mode (extract from report if needed)
    let metricsForResponse = diagnosticMetrics;
    if (hasExistingReport) {
      const { latestDiscoveryMetrics } = await loadLatestDiscoveryMetrics(
        existingDiagnostic,
        diagnosticMetrics
      );
      metricsForResponse = latestDiscoveryMetrics;
      console.log("[diagnostic] Loaded metrics for incomplete chat:", {
        hasExistingReport,
        diagnosticMetricsKeys: Object.keys(diagnosticMetrics || {}),
        latestDiscoveryMetricsKeys: Object.keys(latestDiscoveryMetrics || {}),
        metricsForResponseKeys: Object.keys(metricsForResponse || {}),
        hasReport: Boolean(existingDiagnostic?.data?.aiReport),
        reportLength: existingDiagnostic?.data?.aiReport?.length || 0,
      });
    }

    // Check if there's an incomplete chat (not completed)
    // A chat is completed if:
    // 1. completedAt or finalizedAt exists, OR
    // 2. All 12 questions are answered (distinctQuestionsAnswered >= 12)
    const isCompleted =
      intakeState?.completedAt || intakeState?.finalizedAt || false;

    // Count questions to check if all 12 are answered
    let allQuestionsAnswered = false;
    if (transcript && transcript.length > 0) {
      const { distinctQuestionsAnswered } = trackQuestionNumbers(transcript);
      allQuestionsAnswered = distinctQuestionsAnswered >= 12;

      // Also check if the last assistant message indicates report generation
      const lastAssistant = [...transcript]
        .reverse()
        .find((m) => m?.role === "assistant");
      const indicatesCompletion =
        lastAssistant?.content &&
        /(generate.*report|going to generate|full.*diagnostic.*report)/i.test(
          lastAssistant.content
        );

      if (indicatesCompletion && allQuestionsAnswered) {
        // Report generation was triggered but may not have completed
        // Still consider it completed for UI purposes
        console.log(
          "[diagnostic] Chat appears completed - all questions answered and report generation indicated"
        );
      }
    }

    const hasIncompleteChat =
      transcript &&
      transcript.length > 0 &&
      !isCompleted &&
      !allQuestionsAnswered;

    // If chat is completed (finalizedAt exists) or all 12 questions answered, check if report exists
    if (
      (isCompleted || allQuestionsAnswered) &&
      transcript &&
      transcript.length > 0
    ) {
      // Check if diagnostic has a report
      const hasReport =
        existingDiagnostic?.data?.aiReport || existingDiagnostic?.report;

      if (hasReport) {
        // Report exists - return completed status and clear transcript for discovery mode
        console.log(
          "[diagnostic] Chat completed with existing report - switching to discovery mode"
        );

        // Update intakeState in database to clear transcript and set mode to discovery
        if (existingDiagnostic) {
          const updatedIntakeState = {
            ...intakeState,
            transcript: [], // Clear transcript
            completedAt:
              intakeState?.finalizedAt ||
              intakeState?.completedAt ||
              new Date().toISOString(),
            mode: "discovery", // Set mode to discovery
          };

          await existingDiagnostic.update({
            data: {
              ...(existingDiagnostic.data || {}),
              intakeState: updatedIntakeState,
            },
          });
        }

        return successResponse(res, "Diagnostic completed", {
          hasIncompleteChat: false,
          hasExistingReport: true,
          mode: "discovery", // Switch to discovery mode since diagnostic is complete
          transcript: [], // Clear transcript - start fresh discovery session
          intakeState: {
            ...intakeState,
            transcript: [], // Clear transcript in intakeState too
            completedAt:
              intakeState?.finalizedAt ||
              intakeState?.completedAt ||
              new Date().toISOString(),
            mode: "discovery", // Set mode to discovery
          },
          diagnosticMetrics: metricsForResponse,
          canResume: false,
          status: "completed",
          statusMessage:
            "Your diagnostic report has been completed. You can start a new discovery session.",
        });
      } else if (allQuestionsAnswered && !isCompleted) {
        // All 12 questions answered but report not generated yet - trigger generation
        console.log(
          "[diagnostic] All 12 questions answered but report not generated - triggering generation"
        );
        // This will be handled by the normal flow below, which will trigger auto-finalization
      }
    }

    if (hasIncompleteChat) {
      const isIncompleteDiagnostic = !hasExistingReport;
      const isIncompleteDiscovery =
        hasExistingReport && intakeState.mode === "discovery";

      // If all 12 questions are answered or finalizedAt exists, switch to discovery mode
      // (diagnostic is complete, user can now do discovery sessions)
      const diagnosticComplete = allQuestionsAnswered || isCompleted;

      // Determine mode
      const mode = diagnosticComplete
        ? "discovery" // Diagnostic complete - switch to discovery mode
        : isIncompleteDiscovery
          ? "discovery"
          : isIncompleteDiagnostic
            ? "diagnostic"
            : hasExistingReport
              ? "discovery"
              : "diagnostic";

      // Calculate progress for diagnostic mode
      let answeredCount = 0;
      let pendingQuestion = false;
      let distinctQuestionNumbers = [];
      let maxQuestionNumber = 0;

      // Always calculate question count, not just for incomplete diagnostic
      const {
        distinctQuestionNumbers: questionNumbers,
        maxQuestionNumber: maxQNum,
        distinctQuestionsAnswered,
      } = trackQuestionNumbers(transcript);

      distinctQuestionNumbers = questionNumbers;
      maxQuestionNumber = maxQNum;
      answeredCount = distinctQuestionsAnswered || 0;

      if (isIncompleteDiagnostic) {
        const lastAssistant = [...transcript]
          .reverse()
          .find((m) => m?.role === "assistant");
        const lastUser = [...transcript]
          .reverse()
          .find((m) => m?.role === "user");

        if (lastAssistant && lastUser) {
          const aiAnswered = await isAiLikelyAnswer({
            question: lastAssistant.content,
            reply: lastUser.content,
          });
          pendingQuestion = !aiAnswered;
        } else if (lastAssistant) {
          pendingQuestion = true;
        }
      }

      // Return incomplete chat state
      return successResponse(res, "Incomplete chat loaded", {
        hasIncompleteChat: true,
        hasExistingReport,
        mode,
        transcript,
        intakeState: {
          ...intakeState,
          answeredCount,
          pendingQuestion,
          distinctQuestionNumbers,
          maxQuestionNumber,
        },
        diagnosticMetrics: metricsForResponse,
        canResume: true,
        status: "resumable",
        statusMessage:
          "Incomplete chat found. You can continue from where you left off.",
      });
    }
    // If no incomplete chat, continue with normal flow (will start new conversation)
  }

  // Load latest discovery metrics
  const { latestDiscovery, latestDiscoveryReport, latestDiscoveryMetrics } =
    await loadLatestDiscoveryMetrics(existingDiagnostic, diagnosticMetrics);

  // Extract report date
  reportDate = extractReportDate(latestDiscovery, existingDiagnostic);

  // Get full prior report (for saving to DB) and truncated snippet (for prompts)
  const fullPriorReport = latestDiscoveryReport || existingReport || null;
  const priorReportSnippet = fullPriorReport
    ? truncateForContext(fullPriorReport, 12000)
    : null;

  // Prepare previous reports
  const previousReports = preparePreviousReports(
    existingDiagnostic,
    existingReport
  );

  const hasExistingReport = Boolean(existingReport);

  // If a full report already exists and this is a finalize attempt without new data, short-circuit to avoid duplicate emails.
  if (finalize && existingReport) {
    return successResponse(res, "Existing diagnostic already completed", {
      message:
        "You already have a completed diagnostic. Start a new discovery chat to get an updated follow-up.",
      hasExistingReport: true,
      diagnosticId: existingDiagnostic?.id || null,
    });
  }

  // Prepare transcript
  const transcript = prepareTranscript(
    messages,
    existingState,
    hasExistingReport,
    false
  );
  const lastTurn = transcript[transcript.length - 1];
  const lastTurnAssistant = lastTurn?.role === "assistant";

  // Show resume notice when resuming after an assistant turn (only for diagnostic mode, not discovery).
  const resumeNotice =
    !hasExistingReport && transcript.length > 0 && lastTurnAssistant
      ? `Welcome back ${name}, let's continue where we left off.`
      : null;

  const introText = introPageText || DEFAULT_INTRO_PAGE_TEXT;
  const targetCountForRun = hasExistingReport
    ? Math.min(targetCount, 6)
    : targetCount;

  if (!finalize) {
    const lastUser = [...transcript].reverse().find((m) => m?.role === "user");

    // EARLY CHECK: If user wants to email/generate report in discovery mode, skip bot response and generate report immediately
    if (hasExistingReport && lastUser) {
      const {
        detectUserWantsToEndOrGenerateReport,
      } = require("../utils/validation");

      const wantsToEndOrGenerate = await detectUserWantsToEndOrGenerateReport({
        userMessage: lastUser.content,
        transcript: transcript,
      });

      if (wantsToEndOrGenerate) {
        // User wants report - generate it immediately without bot response
        const updatedTranscript = transcript;
        return await handleDiscoveryMode({
          req,
          res,
          email,
          name,
          messages,
          transcript,
          updatedTranscript,
          existingDiagnostic,
          existingState,
          priorReportSnippet,
          diagnosticMetrics,
          latestDiscoveryMetrics,
          reportDate,
          appUser,
          lastUser,
          lastAssistant: null, // No assistant message yet
          nextMessage: null, // Skip bot response
          introText,
          discoveryType: req.body.discoveryType || null,
        });
      }
    }

    const retrieved = lastUser?.content
      ? await retrieveSimilarChunks({ query: lastUser.content, topK: 3 })
      : [];

    const lastAssistant = [...transcript]
      .reverse()
      .find((m) => m?.role === "assistant");

    const hasAssistantTurn = Boolean(lastAssistant);
    const aiAnswered =
      hasAssistantTurn && lastUser
        ? await isAiLikelyAnswer({
          question: lastAssistant.content,
          reply: lastUser.content,
        })
        : false;

    // Track question numbers
    const {
      distinctQuestionNumbers,
      maxQuestionNumber,
      distinctQuestionsAnswered,
    } = trackQuestionNumbers(transcript);

    // Determine if the last user turn actually answered the last assistant question.
    const pendingQuestion = hasAssistantTurn && !aiAnswered;

    // Check if this is the first user interaction (no user messages in transcript yet)
    const isFirstUserInteraction =
      transcript.filter((m) => m?.role === "user").length === 0;

    // Check if user wants a new diagnostic (using LLM for context understanding)
    const { wantsNewDiagnostic, intakeInProgress } =
      await checkWantsNewDiagnostic(transcript, existingState);

    // If there's an existing report and this is the first user interaction,
    // show the welcome message with existing report first
    // Only start new intake if user explicitly requests it in their message OR intake is already in progress
    const shouldShowExistingReportFirst =
      hasExistingReport &&
      isFirstUserInteraction &&
      !wantsNewDiagnostic &&
      !intakeInProgress;

    // Determine chat mode
    // If we should show existing report first, use discovery mode
    const isDiscoveryMode =
      shouldShowExistingReportFirst ||
      determineChatMode(
        hasExistingReport,
        wantsNewDiagnostic,
        intakeInProgress
      );

    // EARLY CHECK: If in discovery mode and user wants to email/generate report, skip bot response and generate report immediately
    if (isDiscoveryMode && lastUser) {
      console.log(
        "[chatbotDiagnosticFreeform] 🔍 EARLY CHECK: Discovery mode - checking if user wants to end/generate report"
      );
      console.log(
        "[chatbotDiagnosticFreeform] Last user message:",
        lastUser.content?.substring(0, 100)
      );

      const {
        detectUserWantsToEndOrGenerateReport,
      } = require("../utils/validation");

      const wantsToEndOrGenerate = await detectUserWantsToEndOrGenerateReport({
        userMessage: lastUser.content,
        transcript: transcript,
      });

      console.log(
        "[chatbotDiagnosticFreeform] Early check result - wantsToEndOrGenerate:",
        wantsToEndOrGenerate
      );

      if (wantsToEndOrGenerate) {
        console.log(
          "[chatbotDiagnosticFreeform] ⚠️ EARLY CHECK TRIGGERED - User wants to end/generate report. Skipping bot response and generating report immediately."
        );
        // User wants report - generate it immediately without bot response
        const updatedTranscript = transcript;
        const lastAssistant = [...transcript]
          .reverse()
          .find((m) => m?.role === "assistant");

        return await handleDiscoveryMode({
          req,
          res,
          email,
          name,
          messages,
          transcript,
          updatedTranscript,
          existingDiagnostic,
          existingState,
          priorReportSnippet,
          diagnosticMetrics,
          latestDiscoveryMetrics,
          reportDate,
          appUser,
          lastUser,
          lastAssistant,
          nextMessage: null, // Skip bot response - generate report directly
          introText,
          discoveryType: req.body.discoveryType || null,
        });
      } else {
        console.log(
          "[chatbotDiagnosticFreeform] ✅ EARLY CHECK PASSED - User does NOT want to end/generate report. Continuing with normal chat flow."
        );
      }
    } else {
      console.log(
        "[chatbotDiagnosticFreeform] Skipping early check - not in discovery mode or no lastUser message"
      );
    }

    // Check if intake has started
    const intakeHasStarted = transcript.some(
      (m) => m.role === "assistant" && /Q\d+/i.test(m.content)
    );

    // Build prompts
    const discoveryType = req.body.discoveryType || null;
    const { userPrompt, systemPrompt } = await buildChatPrompts({
      isDiscoveryMode,
      transcript,
      targetCount: targetCountForRun,
      introText,
      name,
      retrieved,
      priorReportSnippet,
      lastTurnAssistant,
      resumeNotice,
      wantsNewDiagnostic,
      intakeHasStarted,
      distinctQuestionNumbers,
      discoveryType,
      latestDiscoveryMetrics,
      reportDate,
    });

    // Build messages array for AI (rename to avoid shadowing the messages parameter)
    // Ensure systemPrompt is a string
    const safeSystemPrompt =
      systemPrompt && typeof systemPrompt === "string" ? systemPrompt : "";
    if (!safeSystemPrompt) {
      console.error("[diagnostic] Invalid system prompt");
      return errorResponse(
        res,
        "Failed to generate response: missing system prompt",
        500
      );
    }

    let aiMessages = [{ role: "system", content: safeSystemPrompt }];

    // Include prior report in system context for both modes (needed for discovery mode to answer questions about it)
    if (priorReportSnippet) {
      const priorReportContent = isDiscoveryMode
        ? `Previous diagnostic report for ${name} (you have full access to this - use it to answer questions about what the report revealed, their patterns, insights, etc.):\n${priorReportSnippet}`
        : `Existing diagnostic report for ${name} (reference for continuity; do not re-emit the full report here):\n${priorReportSnippet}`;
      aiMessages.push({
        role: "system",
        content:
          priorReportContent && typeof priorReportContent === "string"
            ? priorReportContent
            : "",
      });
    }

    // Filter out messages with null/undefined content and ensure all content is strings
    const validTranscriptMessages = transcript
      .filter((m) => m && m.content && typeof m.content === "string")
      .map((m) => ({
        role: m.role === "assistant" ? "assistant" : "user",
        content: String(m.content), // Ensure it's a string
      }));

    // Ensure userPrompt is a string
    const safeUserPrompt =
      userPrompt && typeof userPrompt === "string" ? userPrompt : "";
    if (!safeUserPrompt) {
      console.error("[diagnostic] Invalid user prompt");
      return errorResponse(
        res,
        "Failed to generate response: missing user prompt",
        500
      );
    }

    aiMessages.push(...validTranscriptMessages, {
      role: "user",
      content: safeUserPrompt,
    });

    // Check if user is asking about diagnostic report (needs more tokens)
    const lastUserMsg =
      transcript.filter((m) => m.role === "user").slice(-1)[0]?.content || "";
    const lowerMsg = lastUserMsg.toLowerCase();
    const isAskingAboutReport =
      /diagnostic|report|reveal|show|find|pattern|insight/i.test(lastUserMsg);
    const isRequestingFullReport =
      /full report|entire report|everything|go deeper|in depth|where can i improve|improve|tell me all|what did.*reveal/i.test(
        lowerMsg
      );
    const maxTokens = isDiscoveryMode
      ? isRequestingFullReport
        ? 800
        : isAskingAboutReport
          ? 500
          : 300 // Brief summary for full report requests (800 tokens to avoid truncation)
      : 400;

    // Update system prompt for full report requests
    if (isDiscoveryMode && isRequestingFullReport && priorReportSnippet) {
      const updatedSystemPrompt = `You are Euphoriam AI. The user asked: "${lastUserMsg}"

You MUST write a brief summary of their diagnostic report. Start immediately with "**What Your Diagnostic Report Revealed:**"

Your response must include:
1. A 2-3 sentence overview
2. Key patterns, metrics (with numbers), daily manifestations, strengths, friction points, growth path
3. Section "**Where You Can Improve:**" with 3-5 actionable areas

Be concise (300-500 words). Extract details from the report in the system context. Write now - do not ask permission.`;

      // Update the system message in aiMessages array
      aiMessages[0] = { role: "system", content: updatedSystemPrompt };
    }

    // For full report requests, use lower temperature for more focused responses
    const temperature =
      isDiscoveryMode && isRequestingFullReport
        ? 0.3
        : isDiscoveryMode
          ? 0.7
          : 0.3;

    let aiResponse;
    let nextMessage;
    let retryCount = 0;
    const maxRetries = isDiscoveryMode && isRequestingFullReport ? 1 : 0; // Retry once for full report requests

    // Try to get response, with retry for full report requests
    while (retryCount <= maxRetries) {
      aiResponse = await openai.chat.completions.create({
        model: "gpt-5.2",
        messages: aiMessages,
        temperature,
        max_completion_tokens: maxTokens,
      });
      nextMessage = aiResponse?.choices?.[0]?.message;

      // If we got content, break
      if (nextMessage?.content && nextMessage.content.trim() !== "") {
        break;
      }

      // If empty and we should retry, try again with more direct prompt
      if (
        retryCount < maxRetries &&
        isRequestingFullReport &&
        priorReportSnippet
      ) {
        // Retry with even more direct prompt
        const retryMessages = [
          {
            role: "system",
            content: `You MUST provide a detailed breakdown of the diagnostic report. Start immediately with "**What Your Diagnostic Report Revealed:**"`,
          },
          {
            role: "system",
            content: `DIAGNOSTIC REPORT:\n${priorReportSnippet.substring(
              0,
              10000
            )}`,
          },
          ...transcript.slice(-3).map((m) => ({
            role: m.role === "assistant" ? "assistant" : "user",
            content: m.content,
          })),
          {
            role: "user",
            content: `Provide a comprehensive breakdown of my diagnostic report. Start with "**What Your Diagnostic Report Revealed:**" and then "**Where You Can Improve:**"`,
          },
        ];
        aiMessages = retryMessages;
        retryCount++;
        continue;
      }

      break;
    }

    // Handle empty responses with better fallback
    if (
      !nextMessage ||
      !nextMessage.content ||
      nextMessage.content.trim() === ""
    ) {
      if (isDiscoveryMode) {
        const lastUserMsg =
          transcript.filter((m) => m.role === "user").slice(-1)[0]?.content ||
          "";
        const lowerMsg = lastUserMsg.toLowerCase();
        const isRequestingFullReportFallback =
          /full report|entire report|everything|go deeper|in depth|where can i improve|improve|tell me all/i.test(
            lowerMsg
          );

        if (isRequestingFullReportFallback && priorReportSnippet) {
          // Try one more time with a very simple, direct prompt
          try {
            const simplePrompt = `Summarize this diagnostic report in 300-500 words. Start with "**What Your Diagnostic Report Revealed:**" then "**Where You Can Improve:**"

Report:
${priorReportSnippet.substring(0, 8000)}

Write the summary now.`;

            const fallbackResponse = await openai.chat.completions.create({
              model: "gpt-5.2",
              messages: [
                {
                  role: "system",
                  content:
                    "You are a helpful assistant. Provide concise summaries of diagnostic reports.",
                },
                { role: "user", content: simplePrompt },
              ],
              temperature: 0.3,
              max_completion_tokens: 800,
            });

            const fallbackMessage = fallbackResponse?.choices?.[0]?.message;
            if (
              fallbackMessage?.content &&
              fallbackMessage.content.trim() !== ""
            ) {
              nextMessage = fallbackMessage;
            } else {
              // Last resort - provide a helpful message
              nextMessage = {
                role: "assistant",
                content: `**What Your Diagnostic Report Revealed:**

I'm having trouble generating the summary right now. Your diagnostic report contains insights about your patterns, metrics, and growth areas. 

**Where You Can Improve:**

Please try asking again in a moment, or ask me about a specific area from your report (e.g., "what are my metrics?" or "where should I focus?").`,
              };
            }
          } catch (err) {
            console.error("[fallback] Error generating summary:", err);
            nextMessage = {
              role: "assistant",
              content: `**What Your Diagnostic Report Revealed:**

I'm having trouble generating the summary right now. Please try asking again, or ask about a specific area from your report.`,
            };
          }
        } else {
          // For discovery mode first message, use structure reflection fallback with actual metrics
          if (
            isDiscoveryMode &&
            transcript.length === 0 &&
            priorReportSnippet
          ) {
            // Use latestDiscoveryMetrics (from latest discovery report) if available, otherwise use diagnosticMetrics
            // This ensures we show the most recent metrics, not old diagnostic metrics
            const metricsToUse =
              latestDiscoveryMetrics &&
                Object.keys(latestDiscoveryMetrics).length > 0
                ? latestDiscoveryMetrics
                : diagnosticMetrics;

            console.log("[welcome message] Metrics being used:", {
              usingLatestDiscovery:
                latestDiscoveryMetrics &&
                Object.keys(latestDiscoveryMetrics).length > 0,
              latestDiscoveryMetrics,
              diagnosticMetrics,
              metricsToUse,
            });

            // Format metrics for fallback message
            // Validate and sanitize metric values to prevent negative or invalid values
            const gravity =
              typeof metricsToUse.gravity === "number" &&
                !isNaN(metricsToUse.gravity)
                ? Math.max(0, metricsToUse.gravity)
                : undefined;
            const signalCoherence =
              typeof metricsToUse.signalCoherence === "number" &&
                !isNaN(metricsToUse.signalCoherence)
                ? Math.max(0, metricsToUse.signalCoherence)
                : undefined;
            const signalOutput =
              typeof metricsToUse.signalOutput === "number" &&
                !isNaN(metricsToUse.signalOutput)
                ? Math.max(0, metricsToUse.signalOutput)
                : undefined;
            const consciousnessLevel =
              typeof metricsToUse.consciousnessLevel === "number" &&
                !isNaN(metricsToUse.consciousnessLevel)
                ? Math.max(0, metricsToUse.consciousnessLevel)
                : undefined;
            const qgcActivation =
              typeof metricsToUse.qgcActivation === "number" &&
                !isNaN(metricsToUse.qgcActivation)
                ? Math.max(0, metricsToUse.qgcActivation)
                : undefined;

            // Helper function to create progress bar
            const createProgressBar = (value, max = 100, length = 12) => {
              // Validate and sanitize input
              if (value === undefined || value === null || isNaN(value)) {
                value = 0;
              }
              // Ensure value is non-negative and within reasonable bounds
              value = Math.max(0, Math.min(value, max * 2)); // Allow up to 200% for edge cases
              const filled = Math.max(
                0,
                Math.min(Math.round((value / max) * length), length)
              );
              const empty = Math.max(0, length - filled);
              return "█".repeat(filled) + "░".repeat(empty);
            };

            const metricsSection =
              gravity !== undefined &&
                signalCoherence !== undefined &&
                signalOutput !== undefined &&
                consciousnessLevel !== undefined &&
                qgcActivation !== undefined
                ? `QGC Activation:
${createProgressBar(qgcActivation)}
${qgcActivation}%

Consciousness Level:
${createProgressBar((consciousnessLevel / 5) * 100)}
${Math.round((consciousnessLevel / 5) * 100)}%

Gravity:
${createProgressBar(gravity)}
${gravity}%

Signal Coherence:
${createProgressBar(signalCoherence)}
${signalCoherence}%

Signal Output:
${createProgressBar(signalOutput)}
${signalOutput}%

* Extremely high Gravity (${gravity}%) → the old identity has a powerful stabilising pull
* Perfect Signal Coherence (${signalCoherence}%) → no fragmentation, no inner chaos
* Very low Signal Output (${signalOutput}%) → not because of weakness, but because entry hadn't happened yet
* Consciousness Level (CL) ${consciousnessLevel} → stabilisation phase
* Quantum Genius Code (QGC) ${qgcActivation}% → genuine creative intelligence present but contained`
                : `
* **[Extract Gravity % from report]** → [what it means]
* **[Extract Signal Coherence % from report]** → [what it means]
* **[Extract Signal Output % from report]** → [what it means]
* **CL [Extract from report]** → [what phase]
* **QGC [Extract from report]%** → [what it indicates]`;

          // Try to extract key sentence and correction from report
          let keySentence = "";
          let correction = "";

          if (priorReportSnippet) {
            // First, try LLM-based extraction for more reliable results
            try {
              const llmExtraction = await extractKeySentenceAndCorrectionWithLLM(priorReportSnippet);
              if (llmExtraction.keySentence && llmExtraction.keySentence.length >= 15) {
                keySentence = llmExtraction.keySentence;
              }
              if (llmExtraction.correction && llmExtraction.correction.length >= 15) {
                correction = llmExtraction.correction;
              }
            } catch (error) {
              console.error("[discovery] LLM extraction failed, falling back to regex:", error);
            }

            // Fall back to regex extraction if LLM didn't find both (or if LLM failed)
            if (!keySentence || !correction) {
              // Look for key sentence patterns (quoted sentences, "I will..." patterns, etc.)
              // First try to find explicit "key sentence" or "distilled" markers with quotes
              // Allow sentences that start with capital or lowercase (might be continuation)
              // Increased max length to 500 to capture longer complete sentences
              // First, try to find the complete quoted sentence by matching the quote pair
              // Require the sentence to start with a capital letter to ensure it's complete
              const keySentenceWithQuotes = priorReportSnippet.match(
                /(?:key sentence|distilled|pattern|identity statement|structure type|primary structure)[\s\S]{0,500}(["'])([A-Z][^"']{20,500}?)\1/i
              );

              let explicitKeySentenceMatch = null;
              if (keySentenceWithQuotes && keySentenceWithQuotes[2]) {
                // Found a complete quoted sentence - use it directly
                explicitKeySentenceMatch = [null, keySentenceWithQuotes[2]];
              } else {
                // Fallback: try pattern that might catch partial quotes
                // Require capital letter start to avoid fragments
                explicitKeySentenceMatch = priorReportSnippet.match(
                  /(?:key sentence|distilled|pattern|identity statement|structure type|primary structure)[\s\S]{0,500}["']([A-Z][^"']{20,500}?)(?:\.|"|'|$)/i
                );
              }

              // Try to find structure type patterns in parentheses (e.g., "(Sensitivity-Sensitive Variant) — "Wrong-Avoidant Starter" subtype")
              // This handles cases where the key sentence starts with a parenthetical structure type
              const structureTypeMatch = priorReportSnippet.match(
                /\(([A-Z][^)]{10,80})\)\s*[—–-]\s*["']([^"']{10,80})["']/i
              );

              // Try to find quoted identity statements with "I will", "I must", etc.
              // Must start with capital letter
              // Increased max length to capture longer complete sentences
              const identityStatementMatch = priorReportSnippet.match(
                /["']([A-Z][^"']{10,500}(?:I will|I must|I can't|I won't|I need|I have to|I move when|I stay|answering|considering|but against|against any|redundancy|matured|verification|system doesn't)[^"']{0,200}(?:\.|"|'|$))["']?/i
              );

              // Try to find unquoted identity statements (complete sentences starting with capital)
              const unquotedIdentityMatch = priorReportSnippet.match(
                /(?:I will|I must|I can't|I won't|I need|I have to|I move when|I stay|Answering|Considering)[A-Za-z\s,:'"()-]{20,150}\./i
              );

              // Try to find key sentence in "Key refinement" section specifically
              // This section often contains the distilled pattern
              const keyRefinementMatch = priorReportSnippet.match(
                /(?:Key refinement|key refinement)[\s\S]{0,300}["']([^"']{20,500}?)(?:["']|\.)(?:\n\n|$)/i
              );

              // Try to find quoted text after "distilled" or "key sentence"
              const distilledQuotedMatch = priorReportSnippet.match(
                /(?:key sentence|distilled)[\s\S]{0,300}["']([^"']{20,500}?)["']/i
              );

              if (explicitKeySentenceMatch && explicitKeySentenceMatch[1]) {
                keySentence = explicitKeySentenceMatch[1].trim();
              } else if (distilledQuotedMatch && distilledQuotedMatch[1]) {
                keySentence = distilledQuotedMatch[1].trim();
              } else if (keyRefinementMatch && keyRefinementMatch[1]) {
                keySentence = keyRefinementMatch[1].trim();
              } else if (structureTypeMatch) {
                // Combine structure type pattern: "(Variant) — "Subtype""
                const variant = structureTypeMatch[1]?.trim() || "";
                const subtype = structureTypeMatch[2]?.trim() || "";
                if (variant && subtype) {
                  keySentence = `(${variant}) — "${subtype}"`;
                } else if (variant) {
                  keySentence = `(${variant})`;
                }
              } else if (identityStatementMatch && identityStatementMatch[1]) {
                keySentence = identityStatementMatch[1].trim();
              } else if (unquotedIdentityMatch && unquotedIdentityMatch[0]) {
                keySentence = unquotedIdentityMatch[0].trim();
              }

              // Validate key sentence - must be complete and meaningful
              if (keySentence) {
                // Clean up: remove trailing quotes, periods, etc. that might be part of the match
                keySentence = keySentence.replace(/["']+$/, "").trim();

                // Remove if too short, doesn't start with capital letter or parenthesis, or looks incomplete
                // Allow structure type patterns that start with parentheses
                // Reject fragments that start with lowercase (unless it's a structure type pattern)
                if (
                  keySentence.length < 15 ||
                  // Reject fragments that start with lowercase (unless it's a structure type pattern in parentheses)
                  (/^[a-z]/.test(keySentence) &&
                    !keySentence.startsWith("(")) ||
                  // Reject common fragment patterns
                  /^(ile|Updated|One sentence|Exact|while staying|ering|tes|ty-|ayer|d,\s*no|no\s*["']|,\s*no)/i.test(
                    keySentence
                  ) || // Common fragments/cropped text
                  // Reject if it starts with a comma or other punctuation (likely a fragment)
                  /^[,;:—–-]/.test(keySentence) ||
                  // Reject if it ends with incomplete punctuation
                  (/[)\]]$/.test(keySentence) &&
                    !/[.!?"']$/.test(keySentence) &&
                    !keySentence.includes("—") &&
                    keySentence.length < 50) // Ends with ) or ] but not sentence-ending punctuation and is short (unless it's a structure type pattern)
                ) {
                  keySentence = "";
                }
              }

              // No length limit - use full text

              // Look for correction section - stop before metrics sections
              // CRITICAL: Only extract from "First Correction" or "10. FIRST CORRECTION" section
              // DO NOT extract from "Key refinement" or other sections
              // Find correction text that ends before hitting metrics/FRICTION sections or "Key refinement"
              // Must start with capital letter to ensure it's a complete sentence
              // Exclude placeholder text like "One correction. Small. Structural. Repeatable."
              const correctionMatch =
                // First try: Look for "First Correction" or "10. FIRST CORRECTION" section header
                // Stop before "Key refinement", metrics, or other sections
                priorReportSnippet.match(
                  /(?:###?\s*10\.\s*FIRST\s+CORRECTION|###?\s*FIRST\s+CORRECTION|10\.\s*FIRST\s+CORRECTION)[\s\S]{0,200}?\n\n([A-Z][^█]{20,500}?)(?:\n\n|\n\*|Gravity|Signal|QGC|CL|Consciousness|FRICTION|METRICS|##|---|QGC Activation|Consciousness Level|One correction|Small\.|Structural\.|Repeatable\.|📄|PDF|Key refinement|key refinement)/i
                ) ||
                // Second try: Look for "First Correction" (not "Key refinement") followed by quoted text or direct text
                // Explicitly exclude "Key refinement" sections - use negative lookahead
                priorReportSnippet.match(
                  /(?:^|\n)(?:###?\s*)?(?:10\.\s*)?FIRST\s+CORRECTION(?!.*Key refinement)[\s\S]{0,500}?(?:One sentence\.\s*Exact\.\s*)?\n\n?>?\s*\*?\s*["']?([A-Z][^█"']{20,500}?)(?:["']|\.|$)(?:\n\n|\n\*|Gravity|Signal|QGC|CL|Consciousness|FRICTION|METRICS|##|---|QGC Activation|Consciousness Level|One correction|Small\.|Structural\.|Repeatable\.|📄|PDF|Key refinement|key refinement)/i
                ) ||
                // Third try: Look for correction keywords with quoted text, but only if NOT in "Key refinement" section
                // Match "When you feel" or "write one line" patterns that are specific to corrections
                priorReportSnippet.match(
                  /(?:When you feel|write one line|Before you type)[\s\S]{0,500}?["']([A-Z][^█"']{20,500}?)(?:["']|\.)(?:\n\n|\n\*|Gravity|Signal|QGC|CL|Consciousness|FRICTION|METRICS|##|---|QGC Activation|Consciousness Level|One correction|Small\.|Structural\.|Repeatable\.|📄|PDF|Key refinement|key refinement)/i
                );

              if (correctionMatch && correctionMatch[1]) {
                correction = correctionMatch[1].trim();

                // CRITICAL: Check if this correction came from "Key refinement" section
                // If it did, reject it - we only want corrections from "First Correction" section
                const correctionIndex = priorReportSnippet.indexOf(correction);
                if (correctionIndex !== -1) {
                  const beforeCorrection = priorReportSnippet.substring(
                    0,
                    correctionIndex
                  );
                  const keyRefinementIndex =
                    beforeCorrection.lastIndexOf("Key refinement");
                  const firstCorrectionIndex =
                    beforeCorrection.lastIndexOf("First Correction");

                  // If "Key refinement" appears after the last "First Correction" before this text, reject it
                  if (
                    keyRefinementIndex !== -1 &&
                    (firstCorrectionIndex === -1 ||
                      keyRefinementIndex > firstCorrectionIndex)
                  ) {
                    correction = ""; // Reject - this came from "Key refinement" section
                  }
                }

                // UPDATED: Prevent Key Sentence from being identical to Correction
                if (keySentence && correction && (keySentence.includes(correction) || correction.includes(keySentence))) {
                  console.log("[discovery] Key Sentence and Correction overlap detected. Clearing Key Sentence to force fallback.");
                  keySentence = "";
                }

                // Additional validation: ensure it doesn't contain metrics indicators
                if (
                  correction &&
                  /\█|Gravity|Signal|QGC|CL|Consciousness|FRICTION|METRICS|\d+%|↓|↑/i.test(
                    correction
                  )
                ) {
                  // Still contains metrics - try to extract just the text before metrics
                  const textOnly = correction.split(
                    /(?:Gravity|Signal|QGC|CL|Consciousness|FRICTION|METRICS|█|\d+%)/i
                  )[0];
                  if (textOnly && textOnly.trim().length >= 20) {
                    correction = textOnly.trim();
                  } else {
                    correction = ""; // Clear if we can't extract clean text
                  }
                }

                // Validate correction - must be complete and meaningful
                // Exclude placeholder text like "One correction. Small. Structural. Repeatable."
                if (correction) {
                  // Remove if too short, doesn't start with capital letter, or looks like placeholder/incomplete
                  if (
                    correction.length < 20 ||
                    !/^[A-Z]/.test(correction) || // Must start with capital letter
                    /^(Updated|One sentence|Exact|while staying|ile|ering|tes|One correction|Small|Structural|Repeatable)/i.test(
                      correction
                    ) || // Common fragments/placeholders/cropped text
                    /^[a-z]/.test(correction) || // Starts with lowercase = cropped
                    /\)\s*One sentence/i.test(correction) || // Pattern like "Updated) One sentence"
                    /One correction\.\s*Small\.\s*Structural\.\s*Repeatable/i.test(
                      correction
                    ) || // Placeholder pattern
                    (/[)\]]$/.test(correction) && !/[.!?]$/.test(correction)) // Ends with ) or ] but not sentence-ending punctuation
                  ) {
                    correction = ""; // Clear if it doesn't look valid
                  }
                }
              }
            }
            } // End of regex fallback block

            // If we can't extract key sentence, try to infer from report structure
            let keySentenceText = "";
            if (keySentence && keySentence.length >= 20) {
              keySentenceText = `> *"${keySentence}"*`;
            } else if (priorReportSnippet) {
              // Try to find structure type or identity description - be more specific
              // Look for "Structure Type" section or similar
              const structureTypeMatch = priorReportSnippet.match(
                /(?:Structure Type|Primary Structure|Your structure)[\s\S]{0,300}(?:is|means|indicates)[\s\S]{0,200}([^.\n]{20,120})/i
              );

              // Look for identity patterns in quotes
              const identityPatternMatch = priorReportSnippet.match(
                /(?:identity|structure)[\s\S]{0,200}["']([^"']{20,120})["']/i
              );

              if (structureTypeMatch && structureTypeMatch[1]) {
                const extracted = structureTypeMatch[1].trim();
                if (extracted.length >= 20 && extracted.length <= 120) {
                  keySentenceText = `> *"${extracted}"*`;
                }
              } else if (identityPatternMatch && identityPatternMatch[1]) {
                const extracted = identityPatternMatch[1].trim();
                if (extracted.length >= 20 && extracted.length <= 120) {
                  keySentenceText = `> *"${extracted}"*`;
                }
              } else {
                // Skip key sentence section if we truly can't extract it
                keySentenceText = "";
              }
            }

            // If we can't extract correction, try to infer from report recommendations
            let correctionText = "";
            if (correction && correction.length >= 15) {
              correctionText = `**${correction}**`;
            } else if (priorReportSnippet) {
              // Try to infer from report - look for action items or focus areas
              const actionMatch = priorReportSnippet.match(
                /(?:focus|work on|action|next step|correction is|recommendation is)[\s\S]{0,200}(.{30,500})/i
              );
              if (actionMatch && actionMatch[1]) {
                const extracted = actionMatch[1].trim();
                // Validate extracted text
                if (
                  extracted.length >= 30 &&
                  /^[a-zA-Z]/.test(extracted) &&
                  !/^(Updated|One sentence)/i.test(extracted)
                ) {
                  correctionText = `**${extracted}**`;
                }
              }
              // Don't use generic fallback - if we can't extract, skip the section
            }

            // Clean up correction text to ensure it ends properly (no truncation)
            const cleanCorrection = correction
              ? correction
                .replace(/[.*?]+$/, "") // Remove trailing special chars
                .replace(/\s+$/, "") // Remove trailing whitespace
                .trim()
              : "";

            const questionText = cleanCorrection
              ? `Since this report (${reportDate || "recently"
              }), have you made any progress on ${cleanCorrection}?`
              : `Since this report (${reportDate || "recently"
              }), what has changed or stayed the same?`;

            nextMessage = {
              role: "assistant",
              content: `Welcome back ${name}!. I've loaded your last report.

I want to reflect it back to you first — simply and cleanly — before we move anywhere.

Your structure at the last check-in was very clear:
${metricsSection}

${keySentenceText && keySentenceText.length > 20
                  ? `This is the key sentence from your map, distilled:

${keySentenceText}

`
                  : ""
                }${correction && correction.length >= 15
                  ? `Nothing in your report pointed to laziness, lack of capacity, or being "behind." It pointed to your structure — ${correction}.`
                  : ""
                }

${correctionText && correctionText.length > 20
                  ? `Your **entire correction** was about one thing only:
${correctionText}

`
                  : ""
                }Before I update anything, I need to check one thing — slowly.

**Since this report (${reportDate || "recently"}):**

${questionText}

Just answer that.`,
            };
          } else {
            // Don't use hardcoded fallback - if LLM returns empty, it should be handled upstream
            console.error(
              "[discovery] Empty response after cleanup - LLM response may be invalid"
            );
            nextMessage = null;
          }
        }
      } else {
        // For discovery mode first message, use structure reflection with actual metrics
        if (isDiscoveryMode && transcript.length === 0 && priorReportSnippet) {
          // Use latestDiscoveryMetrics (from latest discovery report) if available, otherwise use diagnosticMetrics
          // This ensures we show the most recent metrics, not old diagnostic metrics
          const metricsToUse =
            latestDiscoveryMetrics &&
              Object.keys(latestDiscoveryMetrics).length > 0
              ? latestDiscoveryMetrics
              : diagnosticMetrics;

          // Format metrics for fallback message
          // Validate and sanitize metric values to prevent negative or invalid values
          const gravity =
            typeof metricsToUse.gravity === "number" &&
              !isNaN(metricsToUse.gravity)
              ? Math.max(0, metricsToUse.gravity)
              : undefined;
          const signalCoherence =
            typeof metricsToUse.signalCoherence === "number" &&
              !isNaN(metricsToUse.signalCoherence)
              ? Math.max(0, metricsToUse.signalCoherence)
              : undefined;
          const signalOutput =
            typeof metricsToUse.signalOutput === "number" &&
              !isNaN(metricsToUse.signalOutput)
              ? Math.max(0, metricsToUse.signalOutput)
              : undefined;
          const consciousnessLevel =
            typeof metricsToUse.consciousnessLevel === "number" &&
              !isNaN(metricsToUse.consciousnessLevel)
              ? Math.max(0, metricsToUse.consciousnessLevel)
              : undefined;
          const qgcActivation =
            typeof metricsToUse.qgcActivation === "number" &&
              !isNaN(metricsToUse.qgcActivation)
              ? Math.max(0, metricsToUse.qgcActivation)
              : undefined;

          // Helper function to create progress bar
          const createProgressBar = (value, max = 100, length = 12) => {
            // Validate and sanitize input
            if (value === undefined || value === null || isNaN(value)) {
              value = 0;
            }
            // Ensure value is non-negative and within reasonable bounds
            value = Math.max(0, Math.min(value, max * 2)); // Allow up to 200% for edge cases
            const filled = Math.max(
              0,
              Math.min(Math.round((value / max) * length), length)
            );
            const empty = Math.max(0, length - filled);
            return "█".repeat(filled) + "░".repeat(empty);
          };

          const metricsSection =
            gravity !== undefined &&
              signalCoherence !== undefined &&
              signalOutput !== undefined &&
              consciousnessLevel !== undefined &&
              qgcActivation !== undefined
              ? `QGC Activation:
${createProgressBar(qgcActivation)}
${qgcActivation}%

Consciousness Level:
${createProgressBar((consciousnessLevel / 5) * 100)}
${Math.round((consciousnessLevel / 5) * 100)}%

Gravity:
${createProgressBar(gravity)}
${gravity}%

Signal Coherence:
${createProgressBar(signalCoherence)}
${signalCoherence}%

Signal Output:
${createProgressBar(signalOutput)}
${signalOutput}%

* Extremely high Gravity (${gravity}%) → the old identity has a powerful stabilising pull
* Perfect Signal Coherence (${signalCoherence}%) → no fragmentation, no inner chaos
* Very low Signal Output (${signalOutput}%) → not because of weakness, but because entry hadn't happened yet
* Consciousness Level (CL) ${consciousnessLevel} → stabilisation phase
* Quantum Genius Code (QGC) ${qgcActivation}% → genuine creative intelligence present but contained`
              : `
* **[Extract Gravity % from report]** → [what it means]
* **[Extract Signal Coherence % from report]** → [what it means]
* **[Extract Signal Output % from report]** → [what it means]
* **CL [Extract from report]** → [what phase]
* **QGC [Extract from report]%** → [what it indicates]`;

          // Try to extract key sentence and correction from report
          let keySentence = "";
          let correction = "";

          if (priorReportSnippet) {
            // First, try LLM-based extraction for more reliable results
            try {
              const llmExtraction = await extractKeySentenceAndCorrectionWithLLM(priorReportSnippet);
              if (llmExtraction.keySentence && llmExtraction.keySentence.length >= 15) {
                keySentence = llmExtraction.keySentence;
              }
              if (llmExtraction.correction && llmExtraction.correction.length >= 15) {
                correction = llmExtraction.correction;
              }
            } catch (error) {
              console.error("[discovery] LLM extraction failed, falling back to regex:", error);
            }

            // Fall back to regex extraction if LLM didn't find both
            if (!keySentence || !correction) {
              // Look for key sentence patterns (quoted sentences, "I will..." patterns, etc.)
            // First try to find explicit "key sentence" or "distilled" markers with quotes
            // Allow sentences that start with capital or lowercase (might be continuation)
            // Increased max length to 500 to capture longer complete sentences
            // First, try to find the complete quoted sentence by matching the quote pair
            // Require the sentence to start with a capital letter to ensure it's complete
            const keySentenceWithQuotes = priorReportSnippet.match(
              /(?:key sentence|distilled|pattern|identity statement)[\s\S]{0,500}(["'])([A-Z][^"']{20,500}?)\1/i
            );

            let explicitKeySentenceMatch = null;
            if (keySentenceWithQuotes && keySentenceWithQuotes[2]) {
              // Found a complete quoted sentence - use it directly
              explicitKeySentenceMatch = [null, keySentenceWithQuotes[2]];
            } else {
              // Fallback: try pattern that might catch partial quotes or unquoted sentences
              // Require capital letter start to avoid fragments
              // UPDATED: Handle markdown delimiters (> ** " ') and internal apostrophes
              // Greedy prefix consumption to handle > ** " prefix
              explicitKeySentenceMatch = priorReportSnippet.match(
                /(?:key sentence|distilled|pattern|identity statement)[\s\S]{0,500}?(?:[\s>:\-—*"'`\u2018\u2019\u201C\u201D]*)([A-Z](?:[^█\n]|['\u2019](?=[a-z]))+?)(?:\*\*|\*|["'\u2018\u2019\u201C\u201D]|\.|$)/i
              );
            }

            // Try to find quoted identity statements with "I will", "I must", etc.
            // Increased max length to capture longer complete sentences
            const identityStatementMatch = priorReportSnippet.match(
              /["']([A-Z][^"']{10,500}(?:I will|I must|I can't|I won't|I need|I have to|I move when|I stay|answering|considering|but against|against any|redundancy|matured|verification|system doesn't)[^"']{0,200}(?:\.|"|'|$))["']?/i
            );

            // Try to find unquoted identity statements (complete sentences starting with capital)
            const unquotedIdentityMatch = priorReportSnippet.match(
              /(?:I will|I must|I can't|I won't|I need|I have to|I move when|I stay|Answering|Considering)[A-Za-z\s,:'"()-]{20,150}\./i
            );

            // Try to find structural descriptions that might not be in quotes (e.g., "redundancy layer has matured...")
            // Look for patterns like "X has Y" or "X from Y into Z" that describe structural changes
            // Also look in "Key refinement" sections
            const structuralDescriptionMatch = priorReportSnippet.match(
              /(?:key sentence|distilled|pattern|structure|refinement|Key refinement)[\s\S]{0,500}["']?([a-z][^"']{20,500}?(?:has|from|into|matured|shifted|changed|doesn't|system|layer|verification|closure)[^"']{0,200}?[.;:])["']?/i
            );

            // Try to find key sentence in "Key refinement" section specifically
            // This section often contains the distilled pattern
            const keyRefinementMatch = priorReportSnippet.match(
              /(?:Key refinement|key refinement)[\s\S]{0,300}["']([^"']{20,500}?)(?:["']|\.)(?:\n\n|$)/i
            );

            // Try to find quoted text after "distilled" or "key sentence"
            const distilledQuotedMatch = priorReportSnippet.match(
              /(?:key sentence|distilled)[\s\S]{0,300}["']([^"']{20,500}?)["']/i
            );

            // Try to find structure type patterns in parentheses (e.g., "(Sensitivity-Sensitive Variant) — "Wrong-Avoidant Starter" subtype")
            const structureTypeMatch = priorReportSnippet.match(
              /\(([A-Z][^)]{10,80})\)\s*[—–-]\s*["']([^"']{10,80})["']/i
            );

            if (explicitKeySentenceMatch && explicitKeySentenceMatch[1]) {
              keySentence = explicitKeySentenceMatch[1].trim();
            } else if (distilledQuotedMatch && distilledQuotedMatch[1]) {
              keySentence = distilledQuotedMatch[1].trim();
            } else if (keyRefinementMatch && keyRefinementMatch[1]) {
              keySentence = keyRefinementMatch[1].trim();
            } else if (structureTypeMatch) {
              // Combine structure type pattern: "(Variant) — "Subtype""
              const variant = structureTypeMatch[1]?.trim() || "";
              const subtype = structureTypeMatch[2]?.trim() || "";
              if (variant && subtype) {
                keySentence = `(${variant}) — "${subtype}"`;
              } else if (variant) {
                keySentence = `(${variant})`;
              }
            } else if (identityStatementMatch && identityStatementMatch[1]) {
              keySentence = identityStatementMatch[1].trim();
            } else if (
              structuralDescriptionMatch &&
              structuralDescriptionMatch[1]
            ) {
              keySentence = structuralDescriptionMatch[1].trim();
            } else if (unquotedIdentityMatch && unquotedIdentityMatch[0]) {
              keySentence = unquotedIdentityMatch[0].trim();
            }

            // Validate key sentence - must be complete and meaningful
            if (keySentence) {
              // Clean up: remove trailing quotes, periods, etc. that might be part of the match
              keySentence = keySentence.replace(/["']+$/, "").trim();

              // Remove if too short, looks like a fragment, or is clearly incomplete
              if (
                keySentence.length < 15 ||
                // Reject fragments that start with lowercase (unless it's a structure type pattern in parentheses)
                (/^[a-z]/.test(keySentence) && !keySentence.startsWith("(")) ||
                // Reject common fragment patterns
                /^(ile|Updated|One sentence|Exact|while staying|ering|tes|ty-|ayer|d,\s*no|no\s*["']|,\s*no)/i.test(
                  keySentence
                ) || // Common fragments/cropped text
                // Reject if it starts with a comma or other punctuation (likely a fragment)
                /^[,;:—–-]/.test(keySentence) ||
                // Reject if it ends with incomplete punctuation
                (/[)\]]$/.test(keySentence) &&
                  !/[.!?"';]$/.test(keySentence) &&
                  !keySentence.includes("—") &&
                  keySentence.length < 50) // Ends with ) or ] but not sentence-ending punctuation and is short (unless it's a structure type pattern)
              ) {
                keySentence = "";
              }
            }

            // No length limit - use full text

            // Look for correction section - stop before metrics sections
            // CRITICAL: Only extract from "First Correction" or "10. FIRST CORRECTION" section
            // DO NOT extract from "Key refinement" or other sections
            // Find correction text that ends before hitting metrics/FRICTION sections or "Key refinement"
            // Must start with capital letter to ensure it's a complete sentence
            // Exclude placeholder text like "One correction. Small. Structural. Repeatable."
            const correctionMatch =
              // First try: Look for "First Correction" or "10. FIRST CORRECTION" section header
              // Stop before "Key refinement", metrics, or other sections
              priorReportSnippet.match(
                /(?:###?\s*10\.\s*FIRST\s+CORRECTION|###?\s*FIRST\s+CORRECTION|10\.\s*FIRST\s+CORRECTION)[\s\S]{0,200}?\n\n([A-Z][^█]{20,500}?)(?:\n\n|\n\*|Gravity|Signal|QGC|CL|Consciousness|FRICTION|METRICS|##|---|QGC Activation|Consciousness Level|One correction|Small\.|Structural\.|Repeatable\.|📄|PDF|Key refinement|key refinement)/i
              ) ||
              // Second try: Look for "First Correction" (not "Key refinement") followed by quoted text or direct text
              // Explicitly exclude "Key refinement" sections
              // Second try: Look for "First Correction" (not "Key refinement") followed by quoted text or direct text
              // Explicitly exclude "Key refinement" sections
              // UPDATED: Handle markdown delimiters and exclude boilerplate "One sentence. Exact."
              // Second try: Look for "First Correction" (not "Key refinement") followed by quoted text or direct text
              // Explicitly exclude "Key refinement" sections
              // UPDATED: Handle markdown delimiters, exclude boilerplate, capture multi-sentence text
              priorReportSnippet.match(
                /(?:FIRST\s+CORRECTION)(?:[\s\S]*?One sentence\.\s*Exact\.[\s\S]*?)?(?:[\n\r]+)(?:[\s>:\-—*"'`\u2018\u2019\u201C\u201D]*)([A-Z](?:[^█]|\n(?!\n))+?)(?:\*\*|\*|["'\u2018\u2019\u201C\u201D]|$)(?=\s*(?:\n\n|\n\*|Gravity|Signal|QGC|CL|###|$))/i
              ) ||
              // Third try: Look for correction keywords with quoted text, but only if NOT in "Key refinement" section
              // Match "When you feel" or "write one line" patterns that are specific to corrections
              priorReportSnippet.match(
                /(?:When you feel|write one line|Before you type)[\s\S]{0,500}?["']([A-Z][^█"']{20,500}?)(?:["']|\.)(?:\n\n|\n\*|Gravity|Signal|QGC|CL|Consciousness|FRICTION|METRICS|##|---|QGC Activation|Consciousness Level|One correction|Small\.|Structural\.|Repeatable\.|📄|PDF|Key refinement|key refinement)/i
              );

            if (correctionMatch && correctionMatch[1]) {
              correction = correctionMatch[1].trim();

              // CRITICAL: Check if this correction came from "Key refinement" section
              // If it did, reject it - we only want corrections from "First Correction" section
              const correctionIndex = priorReportSnippet.indexOf(correction);
              if (correctionIndex !== -1) {
                const beforeCorrection = priorReportSnippet.substring(
                  0,
                  correctionIndex
                );
                const keyRefinementIndex =
                  beforeCorrection.lastIndexOf("Key refinement");
                const firstCorrectionIndex =
                  beforeCorrection.lastIndexOf("First Correction");

                // If "Key refinement" appears after the last "First Correction" before this text, reject it
                if (
                  keyRefinementIndex !== -1 &&
                  (firstCorrectionIndex === -1 ||
                    keyRefinementIndex > firstCorrectionIndex)
                ) {
                  correction = ""; // Reject - this came from "Key refinement" section
                }
              }

              // Additional validation: ensure it doesn't contain metrics indicators
              if (
                correction &&
                /\█|Gravity|Signal|QGC|CL|Consciousness|FRICTION|METRICS|\d+%|↓|↑/i.test(
                  correction
                )
              ) {
                // Still contains metrics - try to extract just the text before metrics
                const textOnly = correction.split(
                  /(?:Gravity|Signal|QGC|CL|Consciousness|FRICTION|METRICS|█|\d+%)/i
                )[0];
                if (textOnly && textOnly.trim().length >= 20) {
                  correction = textOnly.trim();
                } else {
                  correction = ""; // Clear if we can't extract clean text
                }
              }

              // Validate correction - must be complete and meaningful
              // Exclude placeholder text like "One correction. Small. Structural. Repeatable."
              if (correction) {
                // Remove if too short, doesn't start with capital letter, or looks like placeholder/incomplete
                if (
                  correction.length < 20 ||
                  !/^[A-Z]/.test(correction) || // Must start with capital letter
                  /^(Updated|One sentence|Exact|while staying|ile|ering|tes|One correction|Small|Structural|Repeatable)/i.test(
                    correction
                  ) || // Common fragments/placeholders/cropped text
                  /^[a-z]/.test(correction) || // Starts with lowercase = cropped
                  /\)\s*One sentence/i.test(correction) || // Pattern like "Updated) One sentence"
                  /One correction\.\s*Small\.\s*Structural\.\s*Repeatable/i.test(
                    correction
                  ) || // Placeholder pattern
                  (/[)\]]$/.test(correction) && !/[.!?]$/.test(correction)) // Ends with ) or ] but not sentence-ending punctuation
                ) {
                  correction = ""; // Clear if it doesn't look valid
                }
              }
            }
            } // End of regex fallback block
          }

          // If we can't extract key sentence, try to infer from report structure
          let keySentenceText = "";
          if (keySentence && keySentence.length >= 15) {
            keySentenceText = `> *"${keySentence}"*`;
          } else if (priorReportSnippet) {
            // Try to find structure type or identity description - be more specific
            // Look for "Structure Type" section or similar
            const structureTypeMatch = priorReportSnippet.match(
              /(?:Structure Type|Primary Structure|Your structure)[\s\S]{0,300}(?:is|means|indicates)[\s\S]{0,200}([^.\n]{20,120})/i
            );

            // Look for identity patterns in quotes
            const identityPatternMatch = priorReportSnippet.match(
              /(?:identity|structure)[\s\S]{0,200}["']([^"']{20,120})["']/i
            );

            if (structureTypeMatch && structureTypeMatch[1]) {
              const extracted = structureTypeMatch[1].trim();
              if (extracted.length >= 20 && extracted.length <= 120) {
                keySentenceText = `> *"${extracted}"*`;
              }
            } else if (identityPatternMatch && identityPatternMatch[1]) {
              const extracted = identityPatternMatch[1].trim();
              if (extracted.length >= 20 && extracted.length <= 120) {
                keySentenceText = `> *"${extracted}"*`;
              }
            } else {
              // Skip key sentence section if we truly can't extract it
              keySentenceText = "";
            }
          }

          // If we can't extract correction, try to infer from report recommendations
          let correctionText = "";
          if (correction) {
            correctionText = `**${correction}**`;
          } else if (priorReportSnippet) {
            // Try to infer from report - look for action items or focus areas
            const actionMatch = priorReportSnippet.match(
              /(?:focus|work on|action|next step)[\s\S]{0,100}(.{30,100})/i
            );
            if (actionMatch) {
              correctionText = `**${actionMatch[1].trim()}**`;
            } else {
              // Use a generic but meaningful fallback
              correctionText = `**structural alignment and entry threshold work**`;
            }
          }

          // Clean up correction text to ensure it ends properly (no truncation)
          const cleanCorrection = correction
            ? correction
              .replace(/[.*?]+$/, "") // Remove trailing special chars
              .replace(/\s+$/, "") // Remove trailing whitespace
              .trim()
            : "";

          const questionText = cleanCorrection
            ? `Since this report (${reportDate || "recently"
            }), have you made any progress on ${cleanCorrection}?`
            : `Since this report (${reportDate || "recently"
            }), what has changed or stayed the same?`;

          nextMessage = {
            role: "assistant",
            content: `Welcome back ${name}. I've loaded your last report.

I want to reflect it back to you first — simply and cleanly — before we move anywhere.

Your structure at the last check-in was very clear:
${metricsSection}

${keySentenceText && keySentenceText.length > 20
                ? `This is the key sentence from your map, distilled:

${keySentenceText}

`
                : ""
              }${correction && correction.length >= 15
                ? `Nothing in your report pointed to laziness, lack of capacity, or being "behind." It pointed to your structure — ${correction}.`
                : ""
              }

${correctionText && correctionText.length > 20
                ? `Your **entire correction** was about one thing only:
${correctionText}

`
                : ""
              }Before I update anything, I need to check one thing — slowly.

**Since this report (${reportDate || "recently"}):**

${questionText}

Just answer that.`,
          };
        }
        // Note: Removed hardcoded fallback - if LLM returns empty, it should be handled upstream
      }
    }

    // Clean up numbered questions in discovery mode
    if (
      isDiscoveryMode &&
      nextMessage &&
      typeof nextMessage.content === "string"
    ) {
      nextMessage.content = nextMessage.content
        .replace(/^\s*Q\d+\s*[—–-]?\s*/gim, "") // Remove Q1 — at start
        .replace(/\*\*Q\d+\s*[—–-]?\s*\*\*/g, "") // Remove **Q1 —**
        .replace(/Q\d+\s*[—–-]?\s*/g, "") // Remove any Q1 — in text
        .replace(/Q\d+\)\s*/g, "") // Remove Q1) pattern
        .trim();

      // If cleanup results in empty content, this indicates an issue with the LLM response
      // Don't use hardcoded fallback - let it be handled upstream or retry LLM call
      if (!nextMessage.content || nextMessage.content.trim() === "") {
        console.error(
          "[discovery] Content became empty after cleanup - LLM response may be invalid"
        );
        // Set to null so upstream can handle it (retry or error)
        nextMessage = null;
      }
    }

    // Hard-prefix the resume notice if provided, last turn was assistant, and not already present (only for diagnostic mode).
    if (
      !isDiscoveryMode &&
      resumeNotice &&
      lastTurnAssistant &&
      nextMessage &&
      typeof nextMessage.content === "string" &&
      !nextMessage.content.includes(resumeNotice)
    ) {
      nextMessage = {
        ...nextMessage,
        content: `${resumeNotice}\n\n${nextMessage.content}`.trim(),
      };
    }

    // Strip any leading filler before the first Q-line; keep resume notice if present (only for diagnostic mode).
    if (
      !isDiscoveryMode &&
      nextMessage &&
      typeof nextMessage.content === "string"
    ) {
      const lines = nextMessage.content.split(/\r?\n/);
      // Only strip down to the Q-line when resuming after an assistant turn; otherwise keep acknowledgments.
      if (lastTurnAssistant) {
        const qIndex = lines.findIndex((ln) => /^\s*\**Q\d+/i.test(ln.trim()));
        if (qIndex > -1) {
          const kept = lines.slice(qIndex).join("\n").trim();
          const hasResume =
            resumeNotice && nextMessage.content.includes(resumeNotice);
          nextMessage = {
            ...nextMessage,
            content: hasResume ? `${resumeNotice}\n\n${kept}`.trim() : kept,
          };
        }
      }
    }

    // Build updated transcript including the assistant reply we just generated (for resume after refresh).
    const updatedTranscript = nextMessage
      ? [...transcript, nextMessage]
      : [...transcript];

    // Save chat incrementally to database (for chat history)
    if (appUser && updatedTranscript.length > 0) {
      const chatType = isDiscoveryMode ? "discovery" : "dignostic";
      // Only force new chat if this is truly a new session (first message in transcript)
      // Don't use wantsNewDiagnostic here - that's for diagnostic flow, not chat session management
      // A new diagnostic can happen within the same chat session
      const isFirstMessage =
        transcript.filter((m) => m?.role === "user").length <= 1;
      await saveChatIncrementally({
        userId: appUser.id,
        diagnosticId: existingDiagnostic?.id || null,
        discoveryId: null, // Will be set if discovery record exists
        chatType: chatType,
        transcript: updatedTranscript,
        isChatEnded: false,
        forceNewChat: false, // Let the function determine if it's a new session based on existing chats
      });
    }

    // Maintain accepted answers per distinct Q# to support resume.
    const acceptedAnswers = Array.isArray(existingState.acceptedAnswers)
      ? [...existingState.acceptedAnswers]
      : [];
    if (aiAnswered && lastAssistant) {
      const qNum = extractQuestionNumber(lastAssistant.content);
      if (qNum) {
        const idx = acceptedAnswers.findIndex(
          (a) => Number(a.questionNumber) === Number(qNum)
        );
        const entry = {
          questionNumber: qNum,
          questionText: lastAssistant.content,
          answerText: lastUser?.content || "",
        };
        if (idx >= 0) {
          acceptedAnswers[idx] = entry;
        } else {
          acceptedAnswers.push(entry);
        }
      }
    }

    // Compute distinct questions answered: count unique/distinct question numbers only, excluding the pending one.
    const answeredCount = distinctQuestionsAnswered
      ? distinctQuestionsAnswered - (pendingQuestion ? 1 : 0)
      : 0;

    // Persist intake progress (draft) so we can resume after refresh.
    const intakeState = {
      transcript: updatedTranscript,
      acceptedAnswers,
      answeredCount,
      lastQuestionNumber: maxQuestionNumber,
      pendingQuestion,
      updatedAt: new Date().toISOString(),
      // Persist the "requesting new diagnostic" flag so we stay in diagnostic mode
      // Clear it if we're showing existing report first (user can request new diagnostic explicitly after)
      requestingNewDiagnostic: shouldShowExistingReportFirst
        ? false // Clear flag when showing existing report first
        : wantsNewDiagnostic || existingState.requestingNewDiagnostic || false,
    };

    if (existingDiagnostic) {
      await existingDiagnostic.update({
        title:
          existingDiagnostic.title ||
          `Euphoriam Intake (Draft) – ${existingDiagnostic?.data?.profile?.name || name
          }`,
        data: {
          ...(existingDiagnostic.data || {}),
          intakeState,
        },
      });
    } else {
      await Diagnostic.create({
        userId: appUser.id || null,
        email,
        title: `Euphoriam Intake (Draft) – ${name}`,
        data: {
          profile: { name, email },
          intakeState,
        },
      });
    }

    // Route to appropriate handler based on mode
    if (isDiscoveryMode) {
      return await handleDiscoveryMode({
        req,
        res,
        email,
        name,
        messages,
        transcript,
        updatedTranscript,
        existingDiagnostic,
        existingState: intakeState,
        priorReportSnippet,
        diagnosticMetrics,
        latestDiscoveryMetrics,
        reportDate,
        appUser,
        lastUser,
        lastAssistant,
        nextMessage,
        introText,
        discoveryType,
      });
    } else {
      return await handleDiagnosticMode({
        req,
        res,
        email,
        name,
        messages,
        transcript,
        updatedTranscript,
        existingDiagnostic,
        existingState: intakeState,
        priorReportSnippet,
        previousReports,
        appUser,
        lastUser,
        lastAssistant,
        nextMessage,
        introText,
        targetCount: targetCountForRun,
        answeredCount,
        pendingQuestion,
        aiAnswered,
        distinctQuestionNumbers,
        maxQuestionNumber,
        distinctQuestionsAnswered,
        resumeNotice,
        wantsNewDiagnostic,
        hasExistingReport,
      });
    }
  }

  // ============================================
  // FINALIZE FLOW (finalize=true)
  // ============================================
  // Handle manual finalization requests
  // Check if user said "end chat" - if so, save chat immediately and return response

  const transcriptForFinal =
    (Array.isArray(existingState.transcript) && existingState.transcript.length
      ? existingState.transcript
      : transcript) || [];

  const lastUser = [...transcriptForFinal]
    .reverse()
    .find((m) => m?.role === "user");
  const lastUserMsg = lastUser?.content || "";
  const lowerMessage = lastUserMsg.toLowerCase();

  // Check if user just said "end chat" (not "email report")
  const justEndingChat =
    /(end|finish|stop|done|close).*(chat|conversation)/i.test(lowerMessage) &&
    !/(email|send|report)/i.test(lowerMessage);

  if (justEndingChat) {
    // User just wants to end chat - save immediately and return response
    // Report will be generated in background

    // Find or create chat record
    let chat = null;
    if (existingDiagnostic?.chatId) {
      chat = await Chat.findByPk(existingDiagnostic.chatId);
    }

    if (!chat) {
      // Find latest incomplete chat
      chat = await Chat.findOne({
        where: {
          userId: appUser.id,
          isChatEnded: false,
        },
        order: [["createdAt", "DESC"]],
      });
    }

    // Save chat with transcript and mark as ended
    if (chat) {
      await chat.update({
        isChatEnded: true,
        data: {
          ...(chat.data || {}),
          transcript: transcriptForFinal,
          messages: transcriptForFinal,
          endedAt: new Date().toISOString(),
        },
      });
      console.log(
        `[chatbotDiagnosticFreeform] Chat ${chat.id} saved and marked as ended for user ${email}`
      );
    } else {
      // Create new chat record if none exists
      const chatType = hasExistingReport ? "discovery" : "dignostic";
      chat = await Chat.create({
        userId: appUser.id,
        dignosticId: existingDiagnostic?.id || null,
        chatType: chatType,
        isChatEnded: true,
        data: {
          transcript: transcriptForFinal,
          messages: transcriptForFinal,
          endedAt: new Date().toISOString(),
        },
      });
      console.log(
        `[chatbotDiagnosticFreeform] New chat ${chat.id} created and marked as ended for user ${email}`
      );

      // Link chat to diagnostic if exists
      if (existingDiagnostic && !existingDiagnostic.chatId) {
        await existingDiagnostic.update({ chatId: chat.id });
      }
    }

    // Return response immediately
    const response = successResponse(res, "Chat ended and saved", {
      message: "Your chat is ended and saved.",
      status: "saved",
      statusMessage: "Chat saved. Report is being generated in the background.",
      userMessage:
        "Your chat has been ended and saved. Your report is being generated in the background and will be available in your account shortly.",
      chatId: chat.id,
      transcript: transcriptForFinal,
    });

    // Generate report in background (don't await - fire and forget)
    (async () => {
      try {
        const retrievedForBackground = lastUser?.content
          ? await retrieveSimilarChunks({ query: lastUser.content, topK: 3 })
          : [];

        if (hasExistingReport) {
          // DISCOVERY: Generate discovery follow-up report
          await handleDiscoveryFinalize({
            req,
            res: null, // No response needed - already sent
            email,
            name,
            transcriptForFinal,
            existingDiagnostic,
            priorReportSnippet,
            diagnosticMetrics,
            appUser,
            introText,
            backgroundMode: true, // Flag to skip email
          });
        } else {
          // DIAGNOSTIC: Generate full diagnostic report
          await handleDiagnosticFinalize({
            req,
            res: null, // No response needed - already sent
            email,
            name,
            transcriptForFinal,
            existingDiagnostic,
            priorReportSnippet,
            previousReports,
            appUser,
            existingState,
            introText,
            retrieved: retrievedForBackground,
            backgroundMode: true, // Flag to skip email
          });
        }
        console.log(
          `[chatbotDiagnosticFreeform] Report generated and saved in background for user ${email}`
        );
      } catch (err) {
        console.error(
          `[chatbotDiagnosticFreeform] Background report generation failed for user ${email}:`,
          err
        );
      }
    })();

    return response;
  }

  // If user wants email or report, use existing handlers
  if (hasExistingReport) {
    // DISCOVERY FINALIZE: User has existing report, generate discovery follow-up
    return await handleDiscoveryFinalize({
      req,
      res,
      email,
      name,
      transcriptForFinal,
      existingDiagnostic,
      priorReportSnippet,
      diagnosticMetrics,
      appUser,
      introText,
    });
  } else {
    // DIAGNOSTIC FINALIZE: First-time user, generate full diagnostic
    return await handleDiagnosticFinalize({
      req,
      res,
      email,
      name,
      transcriptForFinal,
      existingDiagnostic,
      priorReportSnippet,
      previousReports,
      appUser,
      existingState,
      introText,
      retrieved: lastUser?.content
        ? await retrieveSimilarChunks({ query: lastUser.content, topK: 3 })
        : [],
    });
  }
};

const listMine = async (req, res) => {
  const diagnostics = await Diagnostic.findAll({
    where: { email: req.body.email },
    order: [["createdAt", "DESC"]],
  });
  return successResponse(res, "Diagnostics fetched", diagnostics);
};

const listAll = async (_req, res) => {
  const diagnostics = await Diagnostic.findAll({
    order: [["createdAt", "DESC"]],
  });
  return successResponse(res, "Diagnostics fetched", diagnostics);
};

const getById = async (req, res) => {
  try {
    const diagnostic = await Discovery.findByPk(req.params.id);
    if (!diagnostic) {
      return errorResponse(res, "Diagnostic not found", 404);
    }

    return successResponse(res, "Diagnostic fetched", diagnostic);
  } catch (error) {
    console.error("[getById] Error:", error);
    if (error.name === "SequelizeConnectionError" || error.original?.code === "XX000") {
      return errorResponse(
        res,
        "Database connection pool exhausted. Please try again in a moment.",
        503
      );
    }
    return errorResponse(res, "Failed to fetch diagnostic", 500);
  }
};
const getDignosticById = async (req, res) => {
  const diagnostic = await Diagnostic.findByPk(req.params.id);
  if (!diagnostic) {
    return errorResponse(res, "Diagnostic not found", 404);
  }

  return successResponse(res, "Diagnostic fetched", diagnostic);
};
const getAllPdfUrls = async (req, res) => {
  const { email } = req.body || req.query || {};

  if (!email) {
    return errorResponse(res, "Email is required", 400);
  }

  try {
    const diagnostics = await Diagnostic.findAll({
      where: { email },
      order: [["createdAt", "DESC"]],
    });

    const discoveries = await Discovery.findAll({
      where: { email },
      order: [["createdAt", "DESC"]],
    });

    const allPdfUrls = [];

    // =========================
    // Diagnostics
    // =========================
    // diagnostics.forEach((diagnostic) => {
    //   const data = diagnostic.data || {};
    //   const diagnosticId = diagnostic.id;

    //   const resolvedDiscoveryId =
    //     diagnostic.discoveryId ||
    //     discoveryByDiagnosticId.get(diagnosticId)?.id ||
    //     null;

    //   // Current PDF
    //   if (data.pdf?.url) {
    //     allPdfUrls.push({
    //       type: "diagnostic",
    //       diagnosticId,
    //       discoveryId: resolvedDiscoveryId,
    //       title: diagnostic.title || `Diagnostic Report ${diagnosticId}`,
    //       url: data.pdf.url,
    //       createdAt: diagnostic.createdAt,
    //       isCurrent: true,
    //     });
    //   }

    //   // Historical PDFs
    //   if (Array.isArray(data.pdfUrls)) {
    //     data.pdfUrls.forEach((url, index) => {
    //       if (url !== data.pdf?.url) {
    //         allPdfUrls.push({
    //           type: "diagnostic",
    //           diagnosticId,
    //           discoveryId: resolvedDiscoveryId,
    //           title: `${
    //             diagnostic.title || `Diagnostic ${diagnosticId}`
    //           } - Version ${index + 1}`,
    //           url,
    //           createdAt: diagnostic.updatedAt || diagnostic.createdAt,
    //           isCurrent: false,
    //         });
    //       }
    //     });
    //   }

    //   // Previous reports
    //   if (Array.isArray(data.previousReports)) {
    //     data.previousReports.forEach((prevReport, index) => {
    //       if (prevReport.pdfUrl) {
    //         allPdfUrls.push({
    //           type: "diagnostic_previous",
    //           diagnosticId,
    //           discoveryId: resolvedDiscoveryId,
    //           title: `Previous Report ${index + 1} - ${
    //             diagnostic.title || `Diagnostic ${diagnosticId}`
    //           }`,
    //           url: prevReport.pdfUrl,
    //           createdAt: prevReport.savedAt
    //             ? new Date(prevReport.savedAt)
    //             : diagnostic.createdAt,
    //           isCurrent: false,
    //         });
    //       }
    //     });
    //   }
    // });

    // =========================
    // Discoveries
    // =========================
    discoveries.forEach((discovery) => {
      const pdfUrl = discovery.pdfUrl || discovery.data?.pdfUrl;

      if (pdfUrl) {
        allPdfUrls.push({
          type: "discovery",
          diagnosticId:
            discovery.diagnosticId || discovery.data?.diagnosticId || null,
          discoveryId: discovery.id,
          title: discovery.title || `Discovery Report ${discovery.id}`,
          url: pdfUrl,
          createdAt: discovery.createdAt,
          isCurrent: false,
        });
      }
    });

    // =========================
    // Sort + Deduplicate
    // =========================
    allPdfUrls.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    const uniqueUrls = [];
    const seenUrls = new Set();

    allPdfUrls.forEach((item) => {
      if (!seenUrls.has(item.url)) {
        seenUrls.add(item.url);
        uniqueUrls.push(item);
      }
    });

    return successResponse(res, "PDF URLs fetched", {
      total: uniqueUrls.length,
      pdfs: uniqueUrls,
    });
  } catch (error) {
    console.error("[getAllPdfUrls] Error:", error);
    if (error.name === "SequelizeConnectionError" || error.original?.code === "XX000") {
      return errorResponse(
        res,
        "Database connection pool exhausted. Please try again in a moment.",
        503
      );
    }
    return errorResponse(res, "Failed to fetch PDF URLs", 500);
  }
};
// Calculate bottleneck from metrics
const calculateBottleneck = (metrics = {}) => {
  const {
    gravity,
    signalOutput,
    signalCoherence,
    qgcActivation,
    consciousnessLevel,
    engagementScore,
    learningScore,
    commitmentScore,
  } = metrics;

  // Bottleneck is typically the highest gravity or lowest signal metric
  // Priority: gravity (highest), then lowest of signalOutput, signalCoherence, qgcActivation
  const metricValues = [
    { name: "gravity", value: gravity, isHigherWorse: true },
    { name: "signalOutput", value: signalOutput, isHigherWorse: false },
    { name: "signalCoherence", value: signalCoherence, isHigherWorse: false },
    { name: "qgcActivation", value: qgcActivation, isHigherWorse: false },
    {
      name: "consciousnessLevel",
      value: consciousnessLevel * 20,
      isHigherWorse: false,
    }, // Convert 1-5 scale to 0-100
  ];

  // Find the bottleneck (highest gravity or lowest positive metric)
  let bottleneck = metricValues[0]; // Default to gravity

  for (const metric of metricValues) {
    if (metric.isHigherWorse && metric.value > bottleneck.value) {
      bottleneck = metric;
    } else if (
      !metric.isHigherWorse &&
      !bottleneck.isHigherWorse &&
      metric.value < bottleneck.value
    ) {
      bottleneck = metric;
    } else if (metric.isHigherWorse && !bottleneck.isHigherWorse) {
      // Gravity always takes priority if it's high
      if (metric.value > 50) {
        bottleneck = metric;
      }
    }
  }

  // Interpretations for each bottleneck
  const interpretations = {
    gravity: {
      interpretation:
        "High gravity indicates strong resistance patterns and 3D vortex codes creating pull-back. Focus on identifying and releasing avoidance behaviors and structural patterns that create distortion.",
      focusAreas: [
        "Map avoidance behaviors and resistance patterns",
        "Identify 3D vortex codes creating gravity",
        "Work on structural patterns causing distortion",
        "Release inherited roles and hidden rules",
      ],
    },
    signalOutput: {
      interpretation:
        "Low signal output suggests misalignment between what you want to create and your current state. Focus on alignment work and connecting to your authentic genius.",
      focusAreas: [
        "Clarify desired reality and authentic genius",
        "Strengthen alignment between intention and action",
        "Increase coherence in your field",
        "Work on integration of all aspects",
      ],
    },
    signalCoherence: {
      interpretation:
        "Low signal coherence indicates inconsistency between engagement, learning, and commitment. Focus on creating alignment across all areas of your life.",
      focusAreas: [
        "Create consistency between different life areas",
        "Align actions with intentions",
        "Bridge gaps between engagement and learning",
        "Integrate commitment with authentic expression",
      ],
    },
    qgcActivation: {
      interpretation:
        "Low QGC activation suggests the quantum genius codes are not fully activated. Focus on commitment, coherence, and learning to activate your genius codes.",
      focusAreas: [
        "Increase commitment to growth work",
        "Strengthen signal coherence",
        "Deepen learning and integration",
        "Activate quantum genius codes",
      ],
    },
    consciousnessLevel: {
      interpretation:
        "Lower consciousness level indicates need for deeper learning and coherence. Focus on expanding awareness and integrating insights.",
      focusAreas: [
        "Deepen learning and understanding",
        "Increase signal coherence",
        "Expand consciousness through practice",
        "Integrate insights into daily life",
      ],
    },
  };

  const bottleneckInfo = interpretations[bottleneck.name] || {
    interpretation: "Review all metrics to identify focus areas.",
    focusAreas: [
      "Work on overall integration",
      "Focus on structure and vortex mapping",
    ],
  };

  return {
    metric: bottleneck.name,
    value: bottleneck.value,
    ...bottleneckInfo,
  };
};

// Get metrics with bottleneck for a diagnostic
const getMetrics = async (req, res) => {
  try {
    const { id } = req.params;
    const diagnostic = await Diagnostic.findByPk(id);

    if (!diagnostic) {
      return errorResponse(res, "Diagnostic not found", 404);
    }

    // Check authorization
    if (diagnostic.userId !== req.user?.sub && req.user?.role !== "admin") {
      return errorResponse(res, "Forbidden", 403);
    }

    const metrics = diagnostic.data?.metrics || {};
    const bottleneck = calculateBottleneck(metrics);

    return successResponse(res, "Metrics fetched", {
      metrics,
      bottleneck,
    });
  } catch (error) {
    console.error("[getMetrics] Error:", error);
    return errorResponse(res, "Failed to fetch metrics", 500);
  }
};

/**
 * Get latest metrics for a user (for dashboard)
 * Returns metrics from latest diagnostic, discoveries, and chats
 */
const getUserMetrics = async (req, res) => {
  try {
    const { email } = req.query;

    if (!email) {
      return errorResponse(res, "Email is required", 400);
    }

    // Load diagnostic state to get latest metrics
    const { existingDiagnostic, diagnosticMetrics } = await loadDiagnosticState(
      email
    );

    // Get latest discovery metrics
    const { latestDiscoveryMetrics } = await loadLatestDiscoveryMetrics(
      existingDiagnostic,
      diagnosticMetrics
    );

    // Get discovery counts by type
    const user = await User.findOne({ where: { email } });
    let discoveryCounts = {
      alignment: 0,
      freedom: 0,
      prosperity: 0,
      integrated: 0,
      total: 0,
    };

    if (user) {
      const discoveries = await Discovery.findAll({
        where: { userId: user.id },
        attributes: ["discoveryType"],
      });

      discoveries.forEach((d) => {
        const type = d.discoveryType || "integrated";
        if (discoveryCounts.hasOwnProperty(type)) {
          discoveryCounts[type]++;
        }
        discoveryCounts.total++;
      });
    }

    // Use latest discovery metrics if available, otherwise use diagnostic metrics
    const currentMetrics = latestDiscoveryMetrics || diagnosticMetrics || {};

    // Get UC module recommendations based on friction analysis
    // This would be calculated from metrics and friction analysis
    const ucRecommendations = getUCRecommendations(currentMetrics);

    return successResponse(res, "User metrics fetched", {
      metrics: {
        signalOutput: currentMetrics.signalOutput || 0,
        qgcActivation: currentMetrics.qgcActivation || 0,
        consciousnessLevel: currentMetrics.consciousnessLevel || 0,
        gravity: currentMetrics.gravity || 0,
        signalCoherence: currentMetrics.signalCoherence || 0,
        gravityDepth: currentMetrics.gravityDepth || 2,
        vortexSignature: currentMetrics.vortexSignature || null,
        eo: currentMetrics.eo || null,
        lack: currentMetrics.lack || null,
        avoid: currentMetrics.avoid || null,
      },
      discoveryCounts,
      ucRecommendations,
      lastUpdated:
        existingDiagnostic?.updatedAt || existingDiagnostic?.createdAt || null,
    });
  } catch (error) {
    console.error("[getUserMetrics] Error:", error);
    return errorResponse(res, "Failed to fetch user metrics", 500);
  }
};

/**
 * Get UC module recommendations based on metrics and friction analysis
 */
const getUCRecommendations = (metrics = {}) => {
  const recommendations = [];
  const gravityDepth = metrics.gravityDepth || 2;
  const lack = metrics.lack || null;
  const avoid = metrics.avoid || null;
  const eo = metrics.eo || null;

  // Recommend based on Lack channel
  if (lack === "C" || lack === "S" || lack === "P") {
    if (lack === "C") {
      recommendations.push({
        pillar: "Freedom",
        module: "Connection & Relationships",
        reason:
          "Addressing connection lack to reduce gravity and increase signal coherence",
      });
    }
    if (lack === "S") {
      recommendations.push({
        pillar: "Freedom",
        module: "Safety & Security",
        reason:
          "Addressing safety lack to stabilize signal and reduce gravity depth",
      });
    }
    if (lack === "P") {
      recommendations.push({
        pillar: "Alignment",
        module: "Purpose & Mission",
        reason:
          "Addressing purpose lack to activate QGC and increase signal output",
      });
    }
  }

  // Recommend based on Avoidance protector
  if (avoid === "F") {
    recommendations.push({
      pillar: "Freedom",
      module: "Overcoming Failure Protection",
      reason:
        "Addressing failure protector to reduce gravity and increase action capacity",
    });
  }
  if (avoid === "R") {
    recommendations.push({
      pillar: "Freedom",
      module: "Overcoming Rejection Protection",
      reason:
        "Addressing rejection protector to increase signal coherence and receiving capacity",
    });
  }

  // Recommend based on gravity depth
  if (gravityDepth === 3) {
    recommendations.push({
      pillar: "Freedom",
      module: "Template-Level Work",
      reason: "Deep template-level gravity requires specialized Freedom work",
    });
  }

  // Always recommend Alignment if QGC is low
  if ((metrics.qgcActivation || 0) < 50) {
    recommendations.push({
      pillar: "Alignment",
      module: "QGC Activation",
      reason: "Low QGC activation - focus on authentic genius and alignment",
    });
  }

  // Always recommend Prosperity if signal output is low
  if ((metrics.signalOutput || 0) < 50) {
    recommendations.push({
      pillar: "Prosperity",
      module: "Signal Output & Receiving",
      reason: "Low signal output - focus on integration and receiving capacity",
    });
  }

  return recommendations.slice(0, 3); // Return top 3 recommendations
};

/**
 * ============================================
 * GET CHAT HISTORY
 * ============================================
 * Retrieves all chat history for a user (both diagnostic and discovery)
 */

module.exports = {
  listMine,
  listAll,
  getById,
  chatbotDiagnosticFreeform,
  truncateForContext,
  persistDiscoveryRecord,
  getAllPdfUrls,
  getMetrics,
  getUserMetrics,
  calculateBottleneck,
  findOrCreateCreatorUser,
  getDignosticById,
};
