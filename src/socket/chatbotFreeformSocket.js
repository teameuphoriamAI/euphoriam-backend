const {
  EUPHORIAM_FREEFORM_INTAKE_SYSTEM_PROMPT,
  buildFreeformIntakePrompt,
  buildDiscoveryChatPrompt,
  buildFinalReportPrompt,
  DEFAULT_INTRO_PAGE_TEXT,
  sanitizeReportText,
  SUPPORT_LOCK_PROMPT,
  checkWantsEmail,
} = require("../helpers/euphoriamChatbot");
const { retrieveSimilarChunks } = require("../helpers/rag");
const {
  persistDiscoveryRecord,
  truncateForContext,
  saveChatIncrementally,
} = require("../controllers/diagnosticController");
const openai = require("../config/openai");
const { Diagnostic } = require("../models/diagnosticModel");
const { Discovery } = require("../models/discoveryModel");
const { Prompt } = require("../models/promptModel");
const { Chat } = require("../models/chatModel");
const { User } = require("../models/userModel");
const { generateDiagnosticPdf } = require("../utils/diagnosticPdf");
const { sendEmailBasic, sendEmail } = require("../utils/email");
const { uploadBufferToSupabase } = require("../utils/storage");
const {
  discoveryReportEmail,
} = require("../utils/emailTemplate/initialDiscoveryReport");

const fs = require("fs");

/* -------------------- Utils -------------------- */
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

const isQuestion = (text = "") => text.trim().endsWith("?");
const isAnswerLike = (text = "") => {
  const t = text.trim();
  if (!t) return false;
  if (isQuestion(t)) return false;
  return /[A-Za-z]/.test(t);
};

const extractQuestionNumber = (text = "") => {
  const match = (text || "").match(/Q\s*(\d{1,2})/i);
  return match ? Number(match[1]) : null;
};

/* -------------------- Session Store -------------------- */

const sessions = new Map();
const namespace = "/ws/chatbot-freeform";
const INACTIVITY_MS = 10 * 60 * 1000;

/* -------------------- Inactivity -------------------- */

const clearInactivity = (session) => {
  if (session?.idleTimer) {
    clearTimeout(session.idleTimer);
    session.idleTimer = null;
  }
};

const scheduleInactivity = (socket, session) => {
  if (!session || session.mode !== "discovery") return;

  clearInactivity(session);

  session.idleTimer = setTimeout(async () => {
    // Don't show inactivity message if discovery chat was already saved and emailed
    if (session.discoverySavedAndEmailed) {
      return;
    }

    socket.emit("ended", {
      reason: "inactive",
      message: "Chat ended due to inactivity. Summary emailed.",
    });
    await endChatAsDiscovery(socket, session, { reason: "timeout" });
  }, INACTIVITY_MS);
};

/* -------------------- Discovery Finalization -------------------- */

// const buildDiscoveryEmail = ({ reportText, email }) => {
//   return `
//   <!DOCTYPE html>
//   <html>
//   <head>
//     <meta charset="UTF-8" />
//     <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
//   </head>
//   <body style="font-family: Arial, sans-serif; color: #222; line-height: 1.6;">
//     <p>Hi ${email || "there"},</p>
//     <p>Your Discovery Report has been generated based on our follow-up conversation.</p>
//     <div style="background:#f7f7f7;padding:20px;border-radius:8px;margin:20px 0;white-space:pre-wrap;">${reportText || "Report not available."}</div>
//     <p>— Euphoriam AI</p>
//   </body>
//   </html>
//   `;
// };

const endChatAsDiscovery = async (socket, session, { reason }) => {
  if (!session || !session.existingDiagnostic) return;
  clearInactivity(session);

  const existing = session.existingDiagnostic;

  try {
    // Get metrics from existing diagnostic (if available), otherwise use empty metrics
    const metrics = existing?.data?.metrics || {};

    const retrieved = await retrieveSimilarChunks({
      query: session.transcript.at(-1)?.content || "",
      topK: 3,
    });

    // Generate UPDATED full diagnostic report (not discovery report)
    const prompt = await getLatestPromptFromDb();
    // Extract string content from prompt object, or use fallback
    const promptContent =
      typeof prompt === "string"
        ? prompt
        : prompt?.fullPrompt || prompt?.content || "";

    // Ensure promptContent is always a string, never null or undefined
    const safePromptContent =
      promptContent && typeof promptContent === "string" ? promptContent : "";

    const userPromptContent = buildFinalReportPrompt({
      // customerContext: diagnosticContext, // Commented out - not using Kajabi data for now
      customerContext: null, // Not using Kajabi data for now
      intakeAnswers: session.transcript,
      introPageText: session.introPageText || DEFAULT_INTRO_PAGE_TEXT,
      retrieved,
      previousReport: session.priorReportSnippet,
    });

    // Ensure user content is always a string
    const safeUserContent =
      userPromptContent && typeof userPromptContent === "string"
        ? userPromptContent
        : "";

    if (!safePromptContent || !safeUserContent) {
      console.error("[socket] Invalid prompt or user content:", {
        promptContent: safePromptContent,
        userContent: safeUserContent,
      });
      socket.emit("error", {
        message: "Failed to generate diagnostic: missing prompt content",
      });
      return;
    }

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
    });

    let updatedReportText = (
      aiResponse?.choices?.[0]?.message?.content || ""
    ).trim();
    updatedReportText = sanitizeReportText(updatedReportText, metrics);

    if (!updatedReportText) {
      console.error("[socket discovery] Empty report generated");
      return;
    }

    // Update existing diagnostic with new report
    const updatedData = {
      ...existing.data,
      aiReport: updatedReportText,
      updatedAt: new Date().toISOString(),
      discoveryChatTranscript: session.transcript,
      previousReports: Array.isArray(existing.data.previousReports)
        ? [
          ...existing.data.previousReports,
          {
            aiReport: existing.data.aiReport,
            pdfUrl: existing.data.pdf?.url || null,
            savedAt: existing.updatedAt || existing.createdAt,
          },
        ]
        : existing.data.aiReport
          ? [
            {
              aiReport: existing.data.aiReport,
              pdfUrl: existing.data.pdf?.url || null,
              savedAt: existing.updatedAt || existing.createdAt,
            },
          ]
          : [],
    };

    // Generate PDF for updated diagnostic
    const diagnosticForPdf = {
      ...existing.toJSON(),
      data: updatedData,
    };
    const pdfPath = await generateDiagnosticPdf(diagnosticForPdf);

    // Upload PDF to Supabase
    let pdfUrl = null;
    if (pdfPath) {
      try {
        const buffer = await fs.promises.readFile(pdfPath);
        const upload = await uploadBufferToSupabase({
          buffer,
          objectPath: `diagnostics/diagnostic-${existing.id}-${Date.now()}.pdf`,
          contentType: "application/pdf",
        });
        pdfUrl = upload.url || null;

        // Add PDF URL to the report history
        updatedData.pdf = upload;
        updatedData.pdfUrls = Array.isArray(existing.data.pdfUrls)
          ? [...existing.data.pdfUrls, upload.url]
          : existing.data.pdf?.url
            ? [existing.data.pdf.url, upload.url]
            : [upload.url];
      } catch (err) {
        console.error("[socket discovery] PDF upload failed", err);
      }
    }

    // Update the diagnostic record
    await existing.update({
      data: updatedData,
    });

    // Save discovery record for chat history
    const userName =
      existing?.data?.profile?.name ||
      session.email?.split("@")[0] ||
      session.email;
    await persistDiscoveryRecord({
      userId: existing.userId ?? null,
      email: session.email,
      title: `Discovery Chat Report – ${userName}`,
      transcript: session.transcript,
      previousReport: existing.data.aiReport || null, // Pass full report, not truncated
      newReport: updatedReportText, // Full new report
      diagnosticId: existing.id,
      pdfUrl: pdfUrl || existing.data.pdf?.url || null,
    });

    // Mark chat as ended when report is generated
    if (existing.userId) {
      const chatType = "discovery";
      // Find the latest incomplete chat for this user
      const chat = await Chat.findOne({
        where: {
          userId: existing.userId,
          chatType: chatType,
          isChatEnded: false,
          ...(existing.id ? { dignosticId: existing.id } : {}),
        },
        order: [["createdAt", "DESC"]],
      });

      if (chat) {
        await chat.update({
          isChatEnded: true,
          data: {
            ...(chat.data || {}),
            transcript: session.transcript,
            messages: session.transcript,
            endedAt: new Date().toISOString(),
            pdfUrl: pdfUrl || existing.data.pdf?.url || null,
            pdfGeneratedAt: pdfUrl ? new Date().toISOString() : null,
          },
        });
        console.log(
          `[endChatAsDiscovery] Chat ${chat.id} marked as ended for user ${session.email} (socket) with PDF URL: ${pdfUrl || 'none'}`
        );
      }
    }

    // Check if user wants email
    const lastUserMessage =
      session.transcript?.filter((m) => m?.role === "user")?.slice(-1)[0]
        ?.content || "";
    const userWantsEmail = checkWantsEmail(
      session.transcript || [],
      lastUserMessage
    );
    const shouldEmail = userWantsEmail;

    // Email the updated diagnostic report only if user requested it
    if (session.email && pdfPath && shouldEmail) {
      try {
        await sendEmail(
          session.email,
          "Your Updated Diagnostic Report – Euphoriam AI",
          discoveryReportEmail(userName),
          pdfPath
        );
        // Mark that discovery chat has been saved and emailed
        session.discoverySavedAndEmailed = true;
      } catch (err) {
        console.error("[socket discovery] email failed", err);
      }
    }
  } catch (err) {
    console.error("[socket discovery] finalize failed", err);
  }

  session.mode = "completed";
};

/* -------------------- Socket Wiring -------------------- */

const wireChatbotFreeform = (io) => {
  const nsp = io.of(namespace);

  nsp.on("connection", (socket) => {
    sessions.set(socket.id, {
      transcript: [],
      targetCount: 12,
      introPageText: DEFAULT_INTRO_PAGE_TEXT,
      assessmentIds: [],
      email: null,
      existingDiagnostic: null,
      priorReportSnippet: null,
      idleTimer: null,
      initialized: false,
      mode: "diagnostic",
    });

    socket.emit("connected", { sessionId: socket.id });

    /* -------------------- INIT -------------------- */

    socket.on("init", async (payload = {}) => {
      const session = sessions.get(socket.id);
      if (!session) return;

      // Prevent re-init overwriting state
      if (session.initialized) {
        socket.emit("ready", {
          sessionId: socket.id,
          hasExistingReport: Boolean(session.existingDiagnostic),
          mode: session.mode,
        });
        return;
      }

      session.initialized = true;
      session.email = payload.email || session.email;
      session.targetCount = payload.targetCount || session.targetCount;
      session.introPageText = payload.introPageText || session.introPageText;
      session.assessmentIds = payload.assessmentIds || [];

      let hasExistingReport = false;

      if (session.email) {
        const existing = await Diagnostic.findOne({
          where: { email: session.email },
        });

        if (existing?.data?.aiReport) {
          hasExistingReport = true;
          session.existingDiagnostic = existing;

          // Load latest discovery to get updated metrics (vortex, pmatrice) and user session
          const { loadLatestDiscoveryMetrics } = require("../helpers/euphoriamChatbot");
          const discoveryRes = await loadLatestDiscoveryMetrics(
            existing,
            existing?.data?.metrics || {}
          );
          const latestDiscoveryMetrics = discoveryRes.latestDiscoveryMetrics;
          const latestDiscoveryReport = discoveryRes.latestDiscoveryReport;
          const latestUserSession = discoveryRes.latestUserSession; // Get latest user session

          // Use latest discovery report if available, otherwise use diagnostic report
          session.priorReportSnippet = latestDiscoveryReport
            ? truncateForContext(latestDiscoveryReport, 4000)
            : truncateForContext(existing.data.aiReport, 4000);
          
          // Store latest user session in session for discovery chat
          session.latestUserSession = latestUserSession;

          // Store latest discovery metrics for use in chat prompts (always set, even if same as diagnostic)
          session.latestDiscoveryMetrics = latestDiscoveryMetrics;
          session.mode = "discovery"; // 🔒 LOCK
        }
      }

      // Use metrics from existing diagnostic or latest discovery, no Kajabi fetch needed
      if (session.existingDiagnostic) {
        session.metrics =
          session.latestDiscoveryMetrics ||
          session.existingDiagnostic?.data?.metrics ||
          {};
      }

      socket.emit("ready", {
        sessionId: socket.id,
        hasExistingReport,
        mode: session.mode,
      });

      scheduleInactivity(socket, session);
    });

    /* -------------------- USER MESSAGE -------------------- */

    socket.on("user_message", async ({ content }) => {
      const session = sessions.get(socket.id);
      if (!session || !content) return;

      socket.emit("status", {
        stage: "chatting",
        message: "Processing your message...",
      });

      // Check if user wants to start a new diagnostic report BEFORE processing
      const lowerContent = content.toLowerCase();
      const wantsNewDiagnostic =
        /(do|start|create|generate|redo|medo|new|another|fresh|again).*(diagnostic|report|dignostic)/i.test(
          lowerContent
        ) ||
        /(diagnostic|report|dignostic).*(again|new|redo|medo|fresh|another|start over|over again)/i.test(
          lowerContent
        ) ||
        /(want|need|would like|let's|let me).*(new|another|fresh|redo|medo).*(diagnostic|report|dignostic)/i.test(
          lowerContent
        );

      // If user wants new diagnostic, don't end chat - switch to diagnostic mode instead
      if (
        session.mode === "discovery" &&
        /end chat|finish chat|stop chat/i.test(content) &&
        !wantsNewDiagnostic
      ) {
        socket.emit("ended", { reason: "user" });
        await endChatAsDiscovery(socket, session, { reason: "user" });
        return;
      }

      session.transcript.push({ role: "user", content });
      scheduleInactivity(socket, session);

      const retrieved = await retrieveSimilarChunks({
        query: content,
        topK: 3,
      });

      // If user wants new diagnostic, switch to diagnostic mode
      if (wantsNewDiagnostic && session.mode === "discovery") {
        session.mode = "diagnostic";
        session.requestingNewDiagnostic = true; // Set flag to persist through intake
        // Keep the request message but clear previous discovery chat
        session.transcript = [{ role: "user", content }]; // Start fresh with just the request
        session.priorReportSnippet = null; // Don't reference old report
        session.targetCount = 12; // Ensure 12 questions
      }

      // Check if user previously requested a new diagnostic (persist through intake)
      // Also check if intake is in progress (answered questions but not completed)
      const previouslyRequestedNewDiagnostic =
        session.requestingNewDiagnostic === true;
      const assistantQuestions = session.transcript.filter(
        (m) => m.role === "assistant"
      ).length;
      const intakeInProgress =
        assistantQuestions > 0 && assistantQuestions < session.targetCount;

      // Stay in diagnostic mode if user requested new diagnostic OR intake is in progress
      if (
        (previouslyRequestedNewDiagnostic || intakeInProgress) &&
        session.mode === "discovery"
      ) {
        session.mode = "diagnostic";
        session.requestingNewDiagnostic = true;
      }

      // Track distinct question numbers for diagnostic mode
      let distinctQuestionNumbers = [];
      if (session.mode === "diagnostic") {
        const assistantQuestionNumbers = session.transcript
          .filter((m) => m?.role === "assistant")
          .map((m) => extractQuestionNumber(m.content))
          .filter((n) => typeof n === "number");
        distinctQuestionNumbers = [...new Set(assistantQuestionNumbers)].sort(
          (a, b) => a - b
        );
      }

      // Use discovery chat prompt for discovery mode, intake prompt for diagnostic mode
      const chatPrompt =
        session.mode === "discovery"
          ? buildDiscoveryChatPrompt({
            transcript: session.transcript,
            retrieved,
            // factsContext: session.diagnosticContext, // Commented out - not using Kajabi data for now
            factsContext: null, // Not using Kajabi data for now
            userName: session.email?.split("@")[0] || "there",
            priorReport: session.priorReportSnippet,
            metrics: session.latestDiscoveryMetrics || session.metrics || {}, // Use latest discovery metrics (includes updated vortex, pmatrice)
            reportDate: session.existingDiagnostic?.updatedAt
              ? new Date(
                session.existingDiagnostic.updatedAt
              ).toLocaleDateString("en-US", {
                month: "short",
                day: "numeric",
              })
              : null,
            userSession: session.latestUserSession || null, // Pass latest user session
          })
          : buildFreeformIntakePrompt({
            transcript: session.transcript,
            targetCount: session.targetCount,
            introPageText: session.introPageText,
            // factsContext: session.diagnosticContext, // Commented out - not using Kajabi data for now
            factsContext: null, // Not using Kajabi data for now
            retrieved,
            priorReport: session.priorReportSnippet,
            distinctQuestionNumbers: distinctQuestionNumbers, // Pass distinct question numbers
          });

      const sessionSystemBlock = session.latestUserSession?.transcript
        ? `\n\n🎯🎯🎯 USER'S 1:1 COACHING SESSION TRANSCRIPT (AVAILABLE TO YOU):
🚨🚨🚨 THIS TRANSCRIPT IS PROVIDED TO YOU - YOU CAN ACCESS IT

Session Date: ${session.latestUserSession.sessionDate ? new Date(session.latestUserSession.sessionDate).toLocaleDateString() : "Not specified"}

FULL SESSION TRANSCRIPT:
${JSON.stringify(session.latestUserSession.transcript, null, 2)}

🚨🚨🚨🚨🚨 CRITICAL: When user asks about their "1:1 session", "session details", "do you have my session details", or asks to "summarize my session":
- You HAVE this transcript - it's provided above in this system prompt
- ABSOLUTELY FORBIDDEN: NEVER say "I'm unable to access" or "I don't have access"
- ABSOLUTELY FORBIDDEN: NEVER say "I'm unable to provide a detailed summary"
- ABSOLUTELY FORBIDDEN: NEVER talk about diagnostic reports when they ask about session details
- Parse the JSON transcript and summarize/reference what was discussed
- The transcript has role/content pairs - read them and provide a summary
- DO NOT confuse session details with diagnostic report - they're asking about the 1:1 coaching session transcript above
`
        : "";

      const systemPrompt =
        session.mode === "discovery"
          ? `You are Euphoriam AI having a natural, flowing conversation. This is NOT a Q&A session or intake. 
${sessionSystemBlock}
CRITICAL RULES:
- NEVER use numbered questions (Q1, Q2, etc.) - this is a conversation, not an interview
- NEVER structure responses as "Q1: ..." or count questions
- Respond naturally to what the user says, like a supportive friend or coach
- Have a back-and-forth dialogue, not an interrogation
- If the user shares something, acknowledge it and respond naturally
- If the user asks you something, answer it directly
- Reference their previous diagnostic only when it naturally fits the conversation
- Be warm, human, and conversational - not clinical or structured
- Let the conversation flow organically based on what they share`
          : EUPHORIAM_FREEFORM_INTAKE_SYSTEM_PROMPT;

      // Filter out messages with null/undefined content and ensure all content is strings
      const validTranscriptMessages = session.transcript
        .filter((m) => m && m.content && typeof m.content === "string")
        .map((m) => ({
          role: m.role === "assistant" ? "assistant" : "user",
          content: String(m.content), // Ensure it's a string
        }));

      // Ensure systemPrompt and chatPrompt are strings
      const safeSystemPrompt =
        systemPrompt && typeof systemPrompt === "string" ? systemPrompt : "";
      const safeChatPrompt =
        chatPrompt && typeof chatPrompt === "string" ? chatPrompt : "";

      if (!safeSystemPrompt || !safeChatPrompt) {
        console.error("[socket] Invalid system or chat prompt:", {
          systemPrompt: safeSystemPrompt,
          chatPrompt: safeChatPrompt,
        });
        socket.emit("error", {
          message: "Failed to generate response: missing prompt content",
        });
        return;
      }

      const aiResponse = await openai.chat.completions.create({
        model: "gpt-5.2",
        messages: [
          { role: "system", content: safeSystemPrompt },
          ...validTranscriptMessages,
          {
            role: "user",
            content: safeChatPrompt,
          },
        ],
        temperature: session.mode === "discovery" ? 0.7 : 0.3,
        max_completion_tokens: session.mode === "discovery" ? 1500 : 400,
      });

      let msg = aiResponse.choices[0].message;

      // Clean up any numbered questions in discovery mode
      if (session.mode === "discovery" && msg.content) {
        // Remove Q1, Q2, etc. patterns
        msg.content = msg.content
          .replace(/^\s*Q\d+\s*[—–-]?\s*/gim, "") // Remove Q1 — at start
          .replace(/\*\*Q\d+\s*[—–-]?\s*\*\*/g, "") // Remove **Q1 —**
          .replace(/Q\d+\s*[—–-]?\s*/g, "") // Remove any Q1 — in text
          .trim();
      }

      session.transcript.push(msg);

      // Save chat incrementally to database (for chat history)
      if (session.email && session.transcript.length > 0) {
        try {
          // Find or create user
          const userName = session.email?.split("@")[0] || "User";
          let appUser = await User.findOne({ where: { email: session.email } });
          if (!appUser) {
            appUser = await User.create({
              email: session.email,
              name: userName,
            });
          }

          const chatType =
            session.mode === "discovery" ? "discovery" : "dignostic";
          await saveChatIncrementally({
            userId: appUser.id,
            diagnosticId: session.existingDiagnostic?.id || null,
            discoveryId: null,
            chatType: chatType,
            transcript: session.transcript,
            isChatEnded: false,
          });
        } catch (err) {
          console.error("[socket] Error saving chat incrementally:", err);
          // Don't break the flow if saving fails
        }
      }

      socket.emit("assistant_message", {
        message: msg,
        progress: {
          asked: session.transcript.filter((m) => m.role === "assistant")
            .length,
          answered: session.transcript.filter(
            (m) => m.role === "user" && isAnswerLike(m.content)
          ).length,
          total: session.targetCount,
        },
      });
    });

    /* -------------------- FINALIZE -------------------- */

    socket.on("finalize", async () => {
      const session = sessions.get(socket.id);
      if (!session?.email) return;

      clearInactivity(session);

      // DISCOVERY FINALIZE
      if (session.mode === "discovery") {
        socket.emit("status", {
          stage: "generating_report",
          message: "Generating discovery report...",
        });
        await endChatAsDiscovery(socket, session, { reason: "finalize" });

        // Check if user wants email
        const lastUserMessage =
          session.transcript?.filter((m) => m?.role === "user")?.slice(-1)[0]
            ?.content || "";
        const userWantsEmail = checkWantsEmail(
          session.transcript || [],
          lastUserMessage
        );
        const shouldEmail = userWantsEmail;

        const statusMessage = shouldEmail
          ? "Report generated, PDF compiled, and emailed successfully"
          : "Report generated and updated in your account";

        const userMessage = shouldEmail
          ? "Updated diagnostic report generated and emailed."
          : "Updated diagnostic report generated and updated in your account. You can access it anytime. If you'd like it emailed, just ask!";

        socket.emit("done", {
          discovery: true,
          diagnosticId: session.existingDiagnostic?.id,
          message: userMessage,
          status: "completed",
          statusMessage,
          emailed: shouldEmail,
        });
        return;
      }

      // DIAGNOSTIC FINALIZE
      socket.emit("status", {
        stage: "generating_report",
        message: "Generating your diagnostic report...",
      });

      // Generate metrics from user's input (transcript) - not from Kajabi
      // For now, use empty metrics - they will be calculated by AI from the user's answers
      const metrics = {};

      const retrieved = await retrieveSimilarChunks({
        query: session.transcript.at(-1)?.content || "",
        topK: 3,
      });
      const prompt = await getLatestPromptFromDb();
      // Extract string content from prompt object, or use fallback
      const promptContent =
        typeof prompt === "string"
          ? prompt
          : prompt?.fullPrompt || prompt?.content || "";

      // Ensure promptContent is always a string, never null or undefined
      const safePromptContent =
        promptContent && typeof promptContent === "string" ? promptContent : "";

      const userPromptContent = buildFinalReportPrompt({
        // customerContext: diagnosticContext, // Commented out - not using Kajabi data for now
        customerContext: null, // Not using Kajabi data for now
        intakeAnswers: session.transcript,
        introPageText: session.introPageText,
        retrieved,
        previousReport: session.priorReportSnippet,
      });

      // Ensure user content is always a string
      const safeUserContent =
        userPromptContent && typeof userPromptContent === "string"
          ? userPromptContent
          : "";

      if (!safePromptContent || !safeUserContent) {
        console.error("[socket] Invalid prompt or user content (background):", {
          promptContent: safePromptContent,
          userContent: safeUserContent,
        });
        return; // Exit early in background mode
      }

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
      });

      let reportText = aiResponse?.choices?.[0]?.message?.content?.trim() || "";
      reportText = sanitizeReportText(reportText, metrics);

      socket.emit("status", {
        stage: "compiling_pdf",
        message: "Compiling PDF report...",
      });

      // Extract name from email or use email as name
      const userName = session.email?.split("@")[0] || session.email || "User";

      const diagnostic = await Diagnostic.create({
        email: session.email,
        title: `Euphoriam Diagnostic v3 – ${userName}`,
        data: {
          diagnosticVersion: 3,
          generatedAt: new Date(),
          profile: {
            name: userName,
            email: session.email,
          },
          metrics, // Metrics will be extracted from the report by AI
          intakeTranscript: session.transcript,
          aiReport: reportText,
        },
      });

      const pdfPath = await generateDiagnosticPdf(diagnostic);

      socket.emit("status", {
        stage: "uploading_pdf",
        message: "Uploading PDF to storage...",
      });

      // Upload PDF to Supabase and save URL
      let pdfUrl = null;
      if (pdfPath) {
        try {
          const buffer = await fs.promises.readFile(pdfPath);
          const upload = await uploadBufferToSupabase({
            buffer,
            objectPath: `diagnostics/diagnostic-${diagnostic.id}.pdf`,
            contentType: "application/pdf",
          });
          pdfUrl = upload.url || null;

          // Update diagnostic with PDF URL
          await diagnostic.update({
            data: {
              ...diagnostic.data,
              pdf: upload,
              pdfUrls: [upload.url],
            },
          });
        } catch (err) {
          console.error("[socket finalize] PDF upload failed", err);
        }
      }

      // Check if user wants email or if it's first-time user
      const isFirstTimeUser = !session.existingDiagnostic;
      const lastUserMessage =
        session.transcript?.filter((m) => m?.role === "user")?.slice(-1)[0]
          ?.content || "";
      const userWantsEmail = checkWantsEmail(
        session.transcript || [],
        lastUserMessage
      );
      const shouldEmail = isFirstTimeUser || userWantsEmail;

      if (shouldEmail) {
        socket.emit("status", {
          stage: "emailing_report",
          message: "Emailing report to your inbox...",
        });

        try {
          await sendEmail(
            session.email,
            "Your Diagnostic Report – Euphoriam AI",
            require("../utils/emailTemplate/initialDignosticReport").diagnosticReportEmail(
              session.email?.split("@")[0] || "User"
            ),
            pdfPath
          );
        } catch (err) {
          console.error("[socket finalize] Email sending failed", err);
        }
      }

      // Clear the requestingNewDiagnostic flag after report is generated
      if (session) {
        session.requestingNewDiagnostic = false;
      }

      const statusMessage = shouldEmail
        ? "Report generated, PDF compiled, and emailed successfully"
        : "Report generated and updated in your account";

      const userMessage = shouldEmail
        ? `Your diagnostic report has been generated and emailed to ${session.email}. Please check your inbox.`
        : `Your diagnostic report has been generated and updated in your account. You can access it anytime.${userWantsEmail ? "" : " If you'd like it emailed, just ask!"
        }`;

      socket.emit("done", {
        diagnosticId: diagnostic.id,
        pdfPath,
        pdfUrl,
        reportText,
        status: "completed",
        statusMessage,
        userMessage,
        emailed: shouldEmail,
      });
    });

    socket.on("disconnect", () => {
      clearInactivity(sessions.get(socket.id));
      sessions.delete(socket.id);
    });
  });
};

module.exports = {
  wireChatbotFreeform,
  chatbotFreeformNamespace: namespace,
};
