const {
  buildFreeformIntakePrompt,
  buildDiscoveryChatPrompt,
  buildFinalReportPrompt,
  DEFAULT_INTRO_PAGE_TEXT,
  sanitizeReportText,
  SUPPORT_LOCK_PROMPT,
  checkWantsEmail,
  calculateDiagnosticConfidence,
  getLatestPromptFromDb,
  buildChatPrompts,
  isAiLikelyAnswer,
  isLikelyGibberishMessage,
} = require("../helpers/euphoriamChatbot");
const { loadLatestDiscoveryMetrics } = require("../helpers/euphoriamChatbot");
const { PromptType } = require("../utils/types");

const { retrieveSimilarChunks } = require("../helpers/rag");
const {
  persistDiscoveryRecord,
  truncateForContext,
} = require("../controllers/diagnosticController");
const { saveChatIncrementally } = require("../controllers/chatController");
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
const { detectDiscoveryEndIntents } = require("../utils/validation");
const { verifyFunnelSessionToken } = require("../utils/funnelToken");
const {
  stripFunnelCompleteTag,
  normalizeFunnelTranscriptRowsFromChatData,
  flattenTranscriptMessagesForPersist,
  normalizeFunnelStoredContent,
  normalizeFunnelStoredRole,
} = require("../utils/funnelTranscriptNormalize");
const { completeDiagnostic: completeFunnelDiagnostic } = require("../controllers/funnelController");
const { guardMessage } = require("../helpers/promptInjectionGuard");
const { isQuestionRateLimited } = require("../middleware/funnelRateLimit");

const fs = require("fs");

/* -------------------- Utils -------------------- */
const isQuestion = (text = "") => text.trim().endsWith("?");
const isAnswerLike = (text = "") => {
  const t = text.trim().toLowerCase();
  if (!t) return false;
  if (t.endsWith("?")) return false;

  const clarifyPhrases = [
    "elaborate",
    "clarify",
    "explain",
    "repeat",
    "don't understand",
    "do not understand",
    "not sure",
    "what do you mean",
    "rephrase",
  ];
  if (clarifyPhrases.some((p) => t.includes(p))) return false;

  return /[A-Za-z0-9]/.test(t);
};

const extractQuestionNumber = (text = "") => {
  const match = (text || "").match(/Q\s*(\d{1,2})/i);
  return match ? Number(match[1]) : null;
};

const stripQuestionHeader = (text = "") =>
  String(text || "")
    .replace(/^\s*\*{0,2}Q\s*\d{1,2}\s*[—–\-.:]\s*/i, "")
    .replace(/\*{1,2}/g, "")
    .trim();

const tokenSetForSimilarity = (text = "") => {
  const stop = new Set([
    "the",
    "a",
    "an",
    "and",
    "or",
    "to",
    "of",
    "in",
    "on",
    "for",
    "is",
    "are",
    "be",
    "you",
    "your",
    "if",
    "it",
    "this",
    "that",
    "with",
    "when",
    "what",
    "would",
    "rather",
    "than",
    "but",
    "not",
  ]);
  return new Set(
    stripQuestionHeader(text)
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w && w.length > 2 && !stop.has(w)),
  );
};

const jaccardSimilarity = (a, b) => {
  if (!a?.size || !b?.size) return 0;
  let intersection = 0;
  for (const t of a) {
    if (b.has(t)) intersection++;
  }
  const union = a.size + b.size - intersection;
  return union > 0 ? intersection / union : 0;
};

/**
 * Guards against asking semantically near-identical core questions with different Q numbers
 * (e.g. Q20 and Q25 phrased the same).
 */
const detectDuplicateCoreQuestionAcrossNumbers = (transcript = [], candidateContent = "") => {
  const candidateNum = extractQuestionNumber(candidateContent);
  if (!candidateNum || candidateNum < 1 || candidateNum > 25) return null;
  const candidateTokens = tokenSetForSimilarity(candidateContent);
  if (!candidateTokens.size) return null;

  let best = null;
  for (const m of transcript || []) {
    if (m?.role !== "assistant" || !m.content) continue;
    const n = extractQuestionNumber(m.content);
    if (!n || n === candidateNum || n < 1 || n > 25) continue;
    const sim = jaccardSimilarity(candidateTokens, tokenSetForSimilarity(m.content));
    if (!best || sim > best.similarity) {
      best = { similarity: sim, priorNumber: n, priorContent: m.content };
    }
  }
  return best && best.similarity >= 0.58 ? best : null;
};

const maxQuestionNumberInText = (text = "") => {
  let max = 0;
  const re = /Q\s*(\d{1,2})/gi;
  const s = String(text || "");
  let m;
  while ((m = re.exec(s)) !== null) {
    const n = parseInt(m[1], 10);
    if (n >= 1 && n <= 99) max = Math.max(max, n);
  }
  return max;
};

const maxCoreQuestionFromTranscript = (transcript, cap = 25) => {
  let max = 0;
  for (const m of transcript || []) {
    if (m?.role !== "assistant" || !m.content) continue;
    const n = maxQuestionNumberInText(m.content);
    max = Math.max(max, Math.min(n, cap));
  }
  return max;
};

/** True if this assistant bubble references the numbered question `cap` (e.g. 25), any common formatting. */
const assistantMessageMentionsQuestionCap = (content, cap) => {
  const re = /Q\s*(\d{1,2})/gi;
  const s = String(content || "");
  let m;
  while ((m = re.exec(s)) !== null) {
    if (parseInt(m[1], 10) === cap) return true;
  }
  return false;
};

const lastAssistantIndexMentioningQuestionCap = (transcript, cap) => {
  const t = transcript || [];
  for (let i = t.length - 1; i >= 0; i--) {
    const row = t[i];
    if (row?.role !== "assistant" || !row.content) continue;
    if (assistantMessageMentionsQuestionCap(row.content, cap)) return i;
  }
  return -1;
};

/**
 * Intake is complete only after a substantive user reply following the last assistant turn that mentions Q(cap).
 * Prevents `answered >= cap` from passing early when an extra user message exists (intro, duplicate, etc.)
 * while Q25 has just been asked and not yet answered.
 */
const funnelIntakeTranscriptComplete = (transcript, cap = 25) => {
  const t = transcript || [];
  let maxQ = maxCoreQuestionFromTranscript(t, cap);
  const hasAssistant = t.some((m) => m.role === "assistant");
  if (maxQ === 0 && hasAssistant) maxQ = 1;
  const answered = t.filter((m) => m.role === "user" && isAnswerLike(m.content)).length;
  if (answered < cap || maxQ < cap) return false;
  const capIdx = lastAssistantIndexMentioningQuestionCap(t, cap);
  if (capIdx < 0) return answered >= cap && maxQ >= cap;
  return t.slice(capIdx + 1).some((m) => m.role === "user" && isAnswerLike(m.content));
};

const buildFunnelSystemPromptAppend = (targetCount) => `
=== FUNNEL FREE DIAGNOSTIC — FLOW RULES (must follow) ===
- Work through Q1 to Q${targetCount} in order. Do not skip or merge numbered questions.
- If a reply is unclear, gibberish, or off-topic, re-ask the SAME Q number with fresh wording — never advance until you have a real answer.
- Funnel mode does NOT use clarifier questions. Never ask CB1/CB2/etc and never ask extra confidence questions after Q${targetCount}.
- As soon as the user gives a substantive answer to Q${targetCount}, end your reply with a new line containing exactly: [FUNNEL_INTAKE_COMPLETE]
- Do NOT output [FUNNEL_INTAKE_COMPLETE] before Q${targetCount} is fully answered.`;

const buildFunnelProgressPayload = (session, latestAssistantContentRaw = "") => {
  const t = session.transcript;
  const cap = session.targetCount || 25;
  let maxQ = maxCoreQuestionFromTranscript(t, cap);
  const hasAssistant = t.some((m) => m.role === "assistant");
  if (maxQ === 0 && hasAssistant) maxQ = 1;
  const answered = t.filter((m) => m.role === "user" && isAnswerLike(m.content)).length;
  // `asked` tracks the highest Q label seen in assistant text — it hits `cap` as soon as Q25 is *asked*,
  // not when it is *answered*. Gate on substantive answers AND a reply after the last Q(cap) ask.
  const intakeComplete = funnelIntakeTranscriptComplete(t, cap);
  // In funnel mode we finalize immediately after Q25 is answered (no CB clarifiers).
  const readyToFinalize = intakeComplete;
  return {
    asked: maxQ,
    answered,
    total: cap,
    readyToFinalize,
    canGenerateReport: intakeComplete,
  };
};

/**
 * Force OpenAI-shaped messages into { role, content } strings so JSONB + flatten persist reliably.
 */
const coerceFunnelMessageForSession = (msg, defaultRole = "assistant") => {
  if (!msg || typeof msg !== "object") return null;
  let role = normalizeFunnelStoredRole(msg);
  if (!role) {
    const dr = String(defaultRole || "").toLowerCase();
    if (dr === "user") role = "user";
    else if (dr === "assistant") role = "assistant";
  }
  if (role !== "assistant" && role !== "user") return null;
  let content = normalizeFunnelStoredContent(msg);
  if (!content && typeof msg.refusal === "string") content = msg.refusal.trim();
  if (!content) return null;
  content = stripFunnelCompleteTag(content);
  if (!content) return null;
  return { role, content };
};

/** Persist funnel thread to Chat row (existingChatId = funnel chat id). Best-effort; does not throw. */
const persistFunnelChatTranscript = async (session) => {
  if (!session?.isFunnelMode || !session?.funnel_chat_id || !session?.email) return;
  if (!Array.isArray(session.transcript) || session.transcript.length === 0) return;
  const toSave = flattenTranscriptMessagesForPersist(session.transcript);
  if (toSave.length === 0) {
    console.warn(
      "[funnel socket] persist skipped: flatten produced 0 rows (in-memory transcript length=%s)",
      session.transcript.length,
    );
    return;
  }
  try {
    const userName = session.email.split("@")[0] || "User";
    let appUser = await User.findOne({ where: { email: session.email } });
    if (!appUser) {
      appUser = await User.create({ email: session.email, name: userName });
    }
    const chatType = session.mode === "discovery" ? "Discovery" : "Diagnostic";
    await saveChatIncrementally({
      userId: appUser.id,
      diagnosticId: session.existingDiagnostic?.id || null,
      discoveryId: null,
      chatType,
      transcript: toSave,
      isChatEnded: false,
      existingChatId: session.funnel_chat_id,
    });
  } catch (err) {
    console.error("[funnel socket] persist transcript failed:", err);
  }
};

/**
 * Reload funnel Chat transcript into the socket session after refresh (same funnel_chat_id).
 */
const tryRestoreFunnelTranscript = async (socket, session) => {
  if (!session.funnel_chat_id) return false;
  try {
    const chat = await Chat.findByPk(session.funnel_chat_id, { attributes: ["id", "data"] });
    const rows = normalizeFunnelTranscriptRowsFromChatData(chat?.data || {});
    if (rows.length === 0) return false;
    session.transcript = rows.map((r) => ({ role: r.role, content: r.content }));
    const lastAssistant = [...rows].reverse().find((m) => m.role === "assistant");
    const progress = buildFunnelProgressPayload(session, lastAssistant?.content || "");
    socket.emit("session_restored", {
      messages: rows.map((m, i) => ({
        id: `r-${session.funnel_chat_id}-${i}`,
        role: m.role,
        content: m.content,
      })),
      progress,
    });
    return true;
  } catch (err) {
    console.error("[funnel socket] restore transcript failed:", err);
    return false;
  }
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

    // Run independent async operations in parallel
    const [retrieved, prompt] = await Promise.all([
      retrieveSimilarChunks({
        query: session.transcript.at(-1)?.content || "",
        topK: 3,
      }),
      getLatestPromptFromDb(),
    ]);
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
      model: "gpt-4o-mini",
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
          `[endChatAsDiscovery] Chat ${chat.id} marked as ended for user ${session.email} (socket) with PDF URL: ${pdfUrl || "none"}`,
        );
      }
    }

    // Check if user wants email
    const lastUserMessage =
      session.transcript?.filter((m) => m?.role === "user")?.slice(-1)[0]
        ?.content || "";
    const userWantsEmail = checkWantsEmail(
      session.transcript || [],
      lastUserMessage,
    );
    const shouldEmail = userWantsEmail;

    // Email the updated diagnostic report only if user requested it
    if (session.email && pdfPath && shouldEmail) {
      try {
        await sendEmail(
          session.email,
          "Your Updated Diagnostic Report – Euphoriam AI",
          discoveryReportEmail(userName),
          pdfPath,
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

/* -------------------- Funnel First Question -------------------- */

/**
 * Generates and emits the very first diagnostic question for a funnel session.
 * Called right after the "ready" event so the QA page doesn't stall waiting
 * for a user message that never arrives.
 */
const sendFirstFunnelQuestion = async (socket, session) => {
  try {
    const name = (session.email || "").split("@")[0] || "there";

    // Retrieve a small set of RAG chunks for context (best-effort, non-fatal)
    let retrieved = [];
    try {
      retrieved = await retrieveSimilarChunks({
        query: "diagnostic intake first question",
        topK: 2,
      });
    } catch {
      // RAG is optional for the first question
    }

    const { systemPrompt, userPrompt: chatPrompt } = await buildChatPrompts({
      isDiscoveryMode: false,
      transcript: [],
      targetCount: session.targetCount,
      introText: null,
      name,
      retrieved,
      priorReportSnippet: null,
      lastTurnAssistant: false,
      resumeNotice: null,
      wantsNewDiagnostic: false,
      intakeHasStarted: false,
      distinctQuestionNumbers: [],
      discoveryType: null,
      latestDiscoveryMetrics: {},
      reportDate: null,
      latestUserSession: null,
      confidenceResult: null,
      aiAnswered: true,
    });

    if (!systemPrompt || !chatPrompt) {
      socket.emit("error", {
        message: "Failed to load diagnostic prompts. Please refresh and try again.",
      });
      return;
    }

    const systemWithFunnel = `${systemPrompt}\n\n${buildFunnelSystemPromptAppend(session.targetCount)}`;

    const aiResponse = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: systemWithFunnel },
        { role: "user", content: chatPrompt },
      ],
      temperature: 0.3,
      max_completion_tokens: 400,
    });

    const raw = aiResponse.choices[0]?.message;
    const rawText =
      typeof raw?.content === "string"
        ? raw.content
        : raw
          ? normalizeFunnelStoredContent(raw) || ""
          : "";
    if (!rawText?.trim()) {
      socket.emit("error", { message: "Failed to generate first question. Please refresh and try again." });
      return;
    }

    const coerced = coerceFunnelMessageForSession({ ...raw, content: rawText }, "assistant");
    if (!coerced) {
      socket.emit("error", { message: "Failed to generate first question. Please refresh and try again." });
      return;
    }
    session.transcript.push(coerced);

    socket.emit("assistant_message", {
      message: coerced,
      progress: buildFunnelProgressPayload(session, rawText),
    });

    await persistFunnelChatTranscript(session);
  } catch (err) {
    console.error("[funnel socket] sendFirstFunnelQuestion error:", err);
    socket.emit("error", {
      message: "Failed to start your diagnostic session. Please refresh and try again.",
    });
  }
};

/* -------------------- Socket Wiring -------------------- */

const wireChatbotFreeform = (io) => {
  const nsp = io.of(namespace);

  nsp.on("connection", (socket) => {
    sessions.set(socket.id, {
      transcript: [],
      targetCount: 25, // 25 core questions in the Deep Intake Engine
      introPageText: DEFAULT_INTRO_PAGE_TEXT,
      assessmentIds: [],
      email: null,
      existingDiagnostic: null,
      priorReportSnippet: null,
      idleTimer: null,
      initialized: false,
      mode: "diagnostic",
      // Funnel-mode fields (set when payload.funnel_session_token is present)
      isFunnelMode: false,
      funnel_access_id: null,
      funnel_chat_id: null,
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

      // ── Funnel mode: activated by a funnel_session_token from startDiagnostic ──
      if (payload.funnel_session_token) {
        const decoded = verifyFunnelSessionToken(payload.funnel_session_token);
        if (!decoded) {
          socket.emit("error", { message: "Invalid or expired funnel session token. Please restart your diagnostic." });
          return;
        }
        session.isFunnelMode = true;
        session.email = decoded.email;
        session.funnel_access_id = decoded.funnel_access_id;
        const parsedChatId =
          decoded.chat_id != null ? parseInt(String(decoded.chat_id), 10) : NaN;
        if (!Number.isFinite(parsedChatId)) {
          socket.emit("error", {
            message: "Invalid funnel session (missing chat). Please go back and open your session again.",
          });
          return;
        }
        session.funnel_chat_id = parsedChatId;
        session.mode = "diagnostic"; // always diagnostic, never discovery
        const restored = await tryRestoreFunnelTranscript(socket, session);
        socket.emit("ready", {
          sessionId: socket.id,
          hasExistingReport: false,
          mode: "diagnostic",
          isFunnelMode: true,
          restored,
        });
        if (!restored) {
          await sendFirstFunnelQuestion(socket, session);
        }
        return;
      }

      // ── Standard (paid user) mode ─────────────────────────────────────────
      let hasExistingReport = false;

      if (session.email) {
        const existing = await Diagnostic.findOne({
          where: { email: session.email },
        });

        if (existing?.data?.aiReport) {
          hasExistingReport = true;
          session.existingDiagnostic = existing;

          // Load latest discovery to get updated metrics (vortex, pmatrice) and user session
          const discoveryRes = await loadLatestDiscoveryMetrics(
            existing,
            existing?.data?.metrics || {},
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

      // Funnel sessions: security guards + mode lock
      if (session.isFunnelMode) {
        // 1. Question-submission rate limit (per socket IP)
        const clientIp = socket.handshake?.headers?.["x-forwarded-for"]?.split(",")[0]?.trim()
          || socket.handshake?.address
          || "unknown";
        if (isQuestionRateLimited(clientIp)) {
          socket.emit("assistant_message", {
            message: {
              role: "assistant",
              content: "You're submitting answers too quickly. Please slow down and take your time.",
            },
            progress: buildFunnelProgressPayload(session, ""),
          });
          return;
        }

        // 2. Prompt injection detection
        const injectionCheck = guardMessage(content);
        if (injectionCheck.blocked) {
          socket.emit("assistant_message", {
            message: { role: "assistant", content: injectionCheck.response },
            progress: buildFunnelProgressPayload(session, ""),
          });
          return;
        }

        // 3. Lock to diagnostic mode — no discovery or open chat
        if (session.mode === "discovery") {
          session.mode = "diagnostic";
        }
        const lc = content.toLowerCase();
        const wantsDiscovery = /discovery|follow.?up|ongoing|chat|coaching|advice|consult/i.test(lc);
        if (wantsDiscovery) {
          socket.emit("assistant_message", {
            message: {
              role: "assistant",
              content: "Your free access is for the initial diagnostic only. To continue your journey and get ongoing coaching support, the next step is Unlimited Creator.",
            },
            progress: buildFunnelProgressPayload(session, ""),
          });
          return;
        }
      }

      socket.emit("status", {
        stage: "chatting",
        message: "Processing your message...",
      });

      // Check if user wants to start a new diagnostic report BEFORE processing
      const lowerContent = content.toLowerCase();
      const wantsNewDiagnostic =
        /(do|start|create|generate|redo|medo|new|another|fresh|again).*(diagnostic|report|dignostic)/i.test(
          lowerContent,
        ) ||
        /(diagnostic|report|dignostic).*(again|new|redo|medo|fresh|another|start over|over again)/i.test(
          lowerContent,
        ) ||
        /(want|need|would like|let's|let me).*(new|another|fresh|redo|medo).*(diagnostic|report|dignostic)/i.test(
          lowerContent,
        );

      const lastAssistant = [...session.transcript]
        .reverse()
        .find((m) => m.role === "assistant");
      const discoveryIntents = session.mode === "discovery"
        ? await detectDiscoveryEndIntents({
          userMessage: content,
          transcript: session.transcript,
          lastAssistantMessage: lastAssistant?.content || "",
        })
        : { endChat: false, generateReport: false };

      if (
        session.mode === "discovery" &&
        (discoveryIntents.endChat || discoveryIntents.generateReport) &&
        !wantsNewDiagnostic
      ) {
        socket.emit("ended", { reason: "user" });
        await endChatAsDiscovery(socket, session, { reason: "user" });
        return;
      }

      session.transcript.push({ role: "user", content });
      scheduleInactivity(socket, session);

      // If user wants new diagnostic, switch to diagnostic mode (keep full conversation, do not clear transcript)
      if (wantsNewDiagnostic && session.mode === "discovery") {
        session.mode = "diagnostic";
        session.requestingNewDiagnostic = true; // Set flag to persist through intake
        session.priorReportSnippet = null; // Don't reference old report for the new intake
        session.targetCount = 25; // Ensure 25 core questions
      }

      // Check if user previously requested a new diagnostic (persist through intake)
      // Also check if intake is in progress (answered questions but not completed)
      const previouslyRequestedNewDiagnostic =
        session.requestingNewDiagnostic === true;
      const assistantQuestions = session.transcript.filter(
        (m) => m.role === "assistant",
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
          (a, b) => a - b,
        );
      }

      // Run chunk retrieval and confidence calculation in parallel
      const needsConfidence = session.mode === "diagnostic" && distinctQuestionNumbers.length >= 25;
      if (needsConfidence) {
        console.log("[socket diagnostic] Calculating confidence for Q25+");
      }
      const [retrieved, confidenceResult] = await Promise.all([
        retrieveSimilarChunks({ query: content, topK: 3 }),
        needsConfidence
          ? calculateDiagnosticConfidence(session.transcript)
          : Promise.resolve(null),
      ]);

      // In diagnostic mode, use LLM to decide if user's message answers the last question (don't advance on greetings/goodbye/off-topic)
      let aiAnswered = true;
      let lastQuestionNumForEnforcement = null;
      if (session.mode === "diagnostic" && assistantQuestions > 0) {
        const lastAssistant = [...session.transcript]
          .reverse()
          .find((m) => m?.role === "assistant");
        if (lastAssistant?.content) {
          let funnelGibberish = false;
          if (session.isFunnelMode) {
            try {
              funnelGibberish = await isLikelyGibberishMessage(content);
            } catch (_) {
              funnelGibberish = false;
            }
          }
          if (funnelGibberish) {
            aiAnswered = false;
          } else {
            aiAnswered = await isAiLikelyAnswer({
              question: lastAssistant.content,
              reply: content,
            });
          }
          if (!aiAnswered) lastQuestionNumForEnforcement = extractQuestionNumber(lastAssistant.content);
        }
      }

      // Use robust buildChatPrompts helper to construct both system and user prompts
      const { systemPrompt, userPrompt: chatPrompt } = await buildChatPrompts({
        isDiscoveryMode: session.mode === "discovery",
        transcript: session.transcript,
        targetCount: session.targetCount,
        introText: session.introPageText,
        name: session.email?.split("@")[0] || "there",
        retrieved,
        priorReportSnippet: session.priorReportSnippet,
        lastTurnAssistant: assistantQuestions > 0,
        resumeNotice: previouslyRequestedNewDiagnostic ? "Starting a fresh diagnostic intake." : null,
        wantsNewDiagnostic: previouslyRequestedNewDiagnostic,
        intakeHasStarted: assistantQuestions > 0,
        distinctQuestionNumbers,
        discoveryType: null, // Default
        latestDiscoveryMetrics: session.latestDiscoveryMetrics || session.metrics || {},
        reportDate: session.existingDiagnostic?.updatedAt
          ? new Date(session.existingDiagnostic.updatedAt).toLocaleDateString("en-US", {
            month: "short",
            day: "numeric",
          })
          : null,
        latestUserSession: session.latestUserSession || null,
        confidenceResult,
        aiAnswered,
      });

      const safeSystemPrompt = systemPrompt || (session.mode === "discovery" ? "You are Euphoriam AI." : "EUPHORIAM_FREEFORM_INTAKE_SYSTEM_PROMPT");
      const safeChatPrompt = chatPrompt || "";

      // Filter out messages with null/undefined content and ensure all content is strings
      // Also deduplicate verbatim repetitions so the model doesn't copy-paste loops,
      // and hard-block the "here's the question again" phrasing from the history.
      const validTranscriptMessages = (() => {
        const filtered = session.transcript
          .filter((m) => m && m.content && typeof m.content === "string")
          .map((m) => ({
            role: m.role === "assistant" ? "assistant" : "user",
            content: String(m.content),
          }));

        const cleaned = [];
        let lastAssistantContent = null;

        for (const msg of filtered) {
          if (msg.role === "assistant") {
            const content = msg.content || "";
            const lower = content.toLowerCase();

            // Hard-block the "here's the question again" pattern
            if (
              lower.includes("here's the question again") ||
              lower.includes("here is the question again")
            ) {
              cleaned.push({
                role: "assistant",
                content:
                  "(The user's response was unclear. I need to rephrase this question using different, simpler words and add an example to help them answer.)",
              });
              lastAssistantContent = null;
              continue;
            }

            // Collapse verbatim repeated assistant messages
            if (lastAssistantContent && content === lastAssistantContent) {
              cleaned.push({
                role: "assistant",
                content:
                  "(The user's response was unclear. I need to rephrase this question using different, simpler words and add an example to help them answer.)",
              });
              lastAssistantContent = content;
              continue;
            }

            lastAssistantContent = content;
          }

          cleaned.push(msg);
        }

        return cleaned;
      })();

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

      const finalSystemPrompt = session.isFunnelMode
        ? `${safeSystemPrompt}\n\n${buildFunnelSystemPromptAppend(session.targetCount)}`
        : safeSystemPrompt;

      const aiResponse = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: finalSystemPrompt },
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

      // ENFORCE: User did not answer — if the model advanced to the next Q anyway, force re-ask same Q
      if (
        session.mode === "diagnostic" &&
        aiAnswered === false &&
        lastQuestionNumForEnforcement != null &&
        msg?.content
      ) {
        const nextQNum = lastQuestionNumForEnforcement + 1;
        const advancedToNextQ = new RegExp(
          `\\*\\*Q\\s*${nextQNum}\\s*[—–-]|Q\\s*${nextQNum}\\s*[—–-]`,
          "i",
        ).test(msg.content);
        if (advancedToNextQ) {
          const lastAssistant = [...session.transcript]
            .reverse()
            .find((m) => m?.role === "assistant");
          const qText = lastAssistant?.content || "";
          const reaskPrompt = `The user did NOT answer the question. They said: "${(content || "").slice(0, 300)}".
You MUST re-ask ONLY **Q${lastQuestionNumForEnforcement}** in completely different words. Do NOT ask Q${nextQNum}.
Output: (1) A brief acknowledgment that matches what they said: if they asked how you are / said hi → "Doing well, thanks!" or "Hi!". If they said something else (e.g. asked to pause, made a comment), acknowledge that in one short sentence (e.g. "No problem." or "Got it."). (2) Then **Q${lastQuestionNumForEnforcement} — [Title]** and the same question rephrased in new words.
Previous question text for reference: ${qText.slice(0, 400)}`;
          try {
            const reaskResp = await openai.chat.completions.create({
              model: "gpt-4o",
              messages: [
                { role: "system", content: "You re-ask the same diagnostic question in different words. Never advance to the next question number." },
                { role: "user", content: reaskPrompt },
              ],
              temperature: 0.3,
              max_completion_tokens: 350,
            });
            const reaskContent = reaskResp?.choices?.[0]?.message?.content;
            if (reaskContent && /Q\s*\d+/i.test(reaskContent)) {
              msg = { ...msg, content: reaskContent };
              console.log("[socket] Enforced re-ask same Q after model advanced on non-answer");
            }
          } catch (err) {
            console.error("[socket] Re-ask enforcement failed:", err);
          }
        }
      }

      // Clean up any numbered questions in discovery mode
      if (session.mode === "discovery" && msg.content) {
        // Remove Q1, Q2, etc. patterns
        msg.content = msg.content
          .replace(/^\s*Q\d+\s*[—–-]?\s*/gim, "") // Remove Q1 — at start
          .replace(/\*\*Q\d+\s*[—–-]?\s*\*\*/g, "") // Remove **Q1 —**
          .replace(/Q\d+\s*[—–-]?\s*/g, "") // Remove any Q1 — in text
          .trim();
      }

      let rawAssistantContent = "";
      if (session.isFunnelMode) {
        rawAssistantContent =
          typeof msg?.content === "string"
            ? msg.content
            : normalizeFunnelStoredContent(msg) || String(msg?.content ?? "");
        const coerced = coerceFunnelMessageForSession(msg, "assistant");
        if (!coerced) {
          console.error("[funnel socket] Could not coerce assistant message", {
            contentType: msg?.content != null ? typeof msg.content : null,
          });
          socket.emit("error", {
            message: "Failed to process assistant reply. Please try again.",
          });
          return;
        }
        msg = coerced;

        // Funnel mode: remove clarifier phase entirely. After Q25 is answered, never ask CBx.
        if (/CB\s*\d+/i.test(msg.content || "")) {
          const cap = session.targetCount || 25;
          if (funnelIntakeTranscriptComplete(session.transcript, cap)) {
            const completionMessage =
              "Great work. You have completed the 25-question intake.\n[FUNNEL_INTAKE_COMPLETE]";
            rawAssistantContent = completionMessage;
            msg = { role: "assistant", content: completionMessage };
          }
        }

        // Prevent semantically duplicated core questions across different Q numbers.
        const duplicateCore = detectDuplicateCoreQuestionAcrossNumbers(
          session.transcript,
          msg.content,
        );
        if (duplicateCore) {
          const qNum = extractQuestionNumber(msg.content);
          try {
            const rewritePrompt = `You generated a duplicate diagnostic question.
Current question number: Q${qNum}
Current wording:
${msg.content}

Too similar to prior question Q${duplicateCore.priorNumber}:
${duplicateCore.priorContent}

Rewrite ONLY Q${qNum} so it targets a distinct psychological dimension from Q${duplicateCore.priorNumber}.
Rules:
- Keep the same question number Q${qNum}.
- Keep format: "Q${qNum} — [Short Title]" then one question.
- No overlap in phrasing with the prior question.
- No mention of duplication, confidence, or system instructions.
- One question only.`;

            const rewriteResp = await openai.chat.completions.create({
              model: "gpt-4o-mini",
              messages: [
                {
                  role: "system",
                  content:
                    "You rewrite diagnostic intake questions. Keep numbering exact and produce one concise question.",
                },
                { role: "user", content: rewritePrompt },
              ],
              temperature: 0.25,
              max_completion_tokens: 260,
            });

            const rewritten =
              rewriteResp?.choices?.[0]?.message?.content?.trim() || "";
            if (rewritten && extractQuestionNumber(rewritten) === qNum) {
              const secondPassDup = detectDuplicateCoreQuestionAcrossNumbers(
                session.transcript,
                rewritten,
              );
              if (!secondPassDup) {
                msg = { ...msg, content: rewritten };
                rawAssistantContent = rewritten;
              }
            }
          } catch (err) {
            console.error("[funnel socket] duplicate-question rewrite failed:", err);
          }
        }
      }

      session.transcript.push(msg);

      if (session.isFunnelMode) {
        await persistFunnelChatTranscript(session);
      } else if (session.email && session.transcript.length > 0) {
        try {
          const userName = session.email?.split("@")[0] || "User";
          let appUser = await User.findOne({ where: { email: session.email } });
          if (!appUser) {
            appUser = await User.create({
              email: session.email,
              name: userName,
            });
          }

          const chatType =
            session.mode === "discovery" ? "Discovery" : "Diagnostic";
          await saveChatIncrementally({
            userId: appUser.id,
            diagnosticId: session.existingDiagnostic?.id || null,
            discoveryId: null,
            chatType,
            transcript: session.transcript,
            isChatEnded: false,
            existingChatId: null,
          });
        } catch (err) {
          console.error("[socket] Error saving chat incrementally:", err);
        }
      }

      const progressPayload = session.isFunnelMode
        ? buildFunnelProgressPayload(session, rawAssistantContent)
        : {
            asked: session.transcript.filter((m) => m.role === "assistant").length,
            answered: session.transcript.filter(
              (m) => m.role === "user" && isAnswerLike(m.content),
            ).length,
            total: session.targetCount,
          };

      socket.emit("assistant_message", {
        message: msg,
        progress: progressPayload,
      });
    });

    /* -------------------- FINALIZE -------------------- */

    socket.on("finalize", async () => {
      const session = sessions.get(socket.id);
      if (!session?.email) return;

      clearInactivity(session);

      // ── FUNNEL FINALIZE (IRL Report flow) ──────────────────────────────────
      if (session.isFunnelMode) {
        const cap = session.targetCount || 25;
        const maxQ = maxCoreQuestionFromTranscript(session.transcript, cap);
        const answered = session.transcript.filter(
          (m) => m.role === "user" && isAnswerLike(m.content),
        ).length;
        if (!funnelIntakeTranscriptComplete(session.transcript, cap)) {
          socket.emit("error", {
            message: `Please complete all ${cap} diagnostic questions before generating your report. (Progress: ${answered} answers, through Q${maxQ} of ${cap}.)`,
          });
          return;
        }

        socket.emit("status", {
          stage: "generating_report",
          message: "Generating your Invisible Red Line Report...",
        });

        try {
          const metrics = {};
          const [retrieved, prompt] = await Promise.all([
            retrieveSimilarChunks({ query: session.transcript.at(-1)?.content || "", topK: 3 }),
            getLatestPromptFromDb(),
          ]);

          const promptContent = typeof prompt === "string"
            ? prompt
            : prompt?.fullPrompt || prompt?.content || "";

          const userPromptContent = buildFinalReportPrompt({
            customerContext: null,
            intakeAnswers: session.transcript,
            introPageText: session.introPageText || DEFAULT_INTRO_PAGE_TEXT,
            retrieved,
            previousReport: null,
          });

          // Stage 1 report — used as input to completeFunnelDiagnostic (Phase 3/4 will run IRL on top)
          const stage1Response = await openai.chat.completions.create({
            model: "gpt-4o-mini",
            messages: [
              { role: "system", content: promptContent },
              { role: "user", content: userPromptContent },
            ],
            temperature: 0.15,
            max_completion_tokens: 4500,
          });

          const stage1ReportText = sanitizeReportText(
            stage1Response?.choices?.[0]?.message?.content?.trim() || "",
            metrics
          );

          socket.emit("status", {
            stage: "compiling_report",
            message: "Compiling your personalised report...",
          });

          const result = await completeFunnelDiagnostic({
            funnel_access_id: session.funnel_access_id,
            email: session.email,
            transcript: session.transcript,
            reportText: stage1ReportText,
            metrics,
            chat_id: session.funnel_chat_id,
          });

          socket.emit("done", {
            isFunnelMode: true,
            diagnosticId: result.diagnostic_id,
            pdfUrl: result.pdf_url,
            reportText: result.report_text,
            status: "completed",
            statusMessage: "Your Invisible Red Line Report has been generated and emailed.",
            userMessage: `Your Invisible Red Line Report has been generated and emailed to ${session.email}. Please check your inbox.`,
            emailed: true,
          });
        } catch (err) {
          console.error("[socket funnel] Finalize failed:", err);
          socket.emit("error", {
            message: "Failed to generate your report. Please try again.",
          });
        }
        return;
      }

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
          lastUserMessage,
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

      // Run independent async operations in parallel
      const [retrieved, prompt] = await Promise.all([
        retrieveSimilarChunks({
          query: session.transcript.at(-1)?.content || "",
          topK: 3,
        }),
        getLatestPromptFromDb(),
      ]);
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
        model: "gpt-4o-mini",
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
        lastUserMessage,
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
              session.email?.split("@")[0] || "User",
            ),
            pdfPath,
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

