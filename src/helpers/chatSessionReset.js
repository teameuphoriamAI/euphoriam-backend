const { Op } = require("sequelize");
const openai = require("../config/openai");
const { Chat } = require("../models/chatModel");
const { Diagnostic } = require("../models/diagnosticModel");
const { deleteChatFromVectorDB } = require("../services/vectorStoreService");
const {
  getDiagnosticNewUserWelcomeMessage,
  getDiagnosticRepeatIntakeWelcomeMessage,
  diagnosticHasCompletedReport,
  loadLatestDiscoveryMetrics,
  extractReportDate,
} = require("./euphoriamChatbot");

const DIAGNOSTIC_CHAT_TYPES = ["dignostic", "Diagnostic", "Diagnostic Chat"];
const DISCOVERY_CHAT_TYPES = ["discovery", "Discovery"];

const truncateForContext = (text = "", max = 6000) => {
  if (!text || typeof text !== "string") return "";
  return text.length > max ? text.slice(0, max) : text;
};

const extractKeySentenceAndCorrectionWithLLM = async (reportText) => {
  if (!reportText || reportText.length < 100) {
    return { keySentence: "", correction: "" };
  }

  try {
    const reportSnippet =
      reportText.length > 8000 ? reportText.slice(-8000) : reportText;

    const prompt = `You are extracting two specific pieces of information from a Euphoriam diagnostic report.

REPORT TEXT:
${reportSnippet}

TASK:
Extract exactly two things from this report:

1. KEY SENTENCE: Find the "key sentence" or "distilled" pattern/statement.
2. CORRECTION: Find the "First Correction" or "10. FIRST CORRECTION" section.

OUTPUT FORMAT (JSON only, no other text):
{
  "keySentence": "complete sentence here or empty string if not found",
  "correction": "complete correction text here or empty string if not found"
}`;

    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content:
            "You are a precise text extraction tool. Extract only complete sentences. Return valid JSON only.",
        },
        { role: "user", content: prompt },
      ],
      temperature: 0.1,
      max_tokens: 500,
      response_format: { type: "json_object" },
    });

    const content = response.choices[0]?.message?.content?.trim();
    if (!content) return { keySentence: "", correction: "" };

    const parsed = JSON.parse(content);
    return {
      keySentence: parsed.keySentence?.trim() || "",
      correction: parsed.correction?.trim() || "",
    };
  } catch (error) {
    console.error("[chatSessionReset] LLM key sentence extraction failed:", error);
    return { keySentence: "", correction: "" };
  }
};

const chatTypesForMode = (mode) =>
  mode === "discovery" ? DISCOVERY_CHAT_TYPES : DIAGNOSTIC_CHAT_TYPES;

async function clearDiagnosticChatLink(chatId) {
  await Diagnostic.update({ chatId: null }, { where: { chatId } });
}

async function deleteOneOngoingChat(chat) {
  const id = chat.id;
  await clearDiagnosticChatLink(id);
  await chat.destroy();
  try {
    await deleteChatFromVectorDB(id);
  } catch (e) {
    console.warn(
      `[chatSessionReset] Vector DB cleanup failed for chat ${id}:`,
      e.message || e,
    );
  }
  console.log(
    `[chatSessionReset] Deleted ongoing chat id=${id} (userId=${chat.userId}, type=${chat.chatType})`,
  );
  return id;
}

/**
 * Remove incomplete chat row(s) for a user (PostgreSQL + ChromaDB).
 * @param {{ userId: number, mode: 'diagnostic'|'discovery', chatId?: number }} params
 */
async function deleteOngoingChatsForUser({ userId, mode, chatId }) {
  const types = chatTypesForMode(mode);
  const baseWhere = {
    userId,
    isChatEnded: false,
    chatType: { [Op.in]: types },
  };

  let chats = [];

  if (chatId != null && Number.isFinite(Number(chatId))) {
    const chat = await Chat.findByPk(chatId);
    if (!chat) return [];
    if (Number(chat.userId) !== Number(userId)) {
      throw Object.assign(new Error("Chat does not belong to this user"), {
        statusCode: 403,
      });
    }
    if (chat.isChatEnded) {
      throw Object.assign(new Error("Cannot reset an ended chat session"), {
        statusCode: 400,
      });
    }
    if (!types.includes(chat.chatType)) {
      throw Object.assign(
        new Error(`Chat type does not match reset mode "${mode}"`),
        { statusCode: 400 },
      );
    }
    chats = [chat];
  } else {
    chats = await Chat.findAll({
      where: baseWhere,
      order: [["updatedAt", "DESC"]],
    });
  }

  const deletedIds = [];
  for (const chat of chats) {
    deletedIds.push(await deleteOneOngoingChat(chat));
  }
  return deletedIds;
}

/**
 * Clear in-progress intake on the diagnostic row (keeps completed report / metrics).
 */
async function clearIntakeStateOnDiagnostic(diagnostic, mode) {
  if (!diagnostic) return;

  const data = diagnostic.data || {};
  const isDiagnosticRestart = mode !== "discovery";

  await diagnostic.update({
    chatId: null,
    data: {
      ...data,
      intakeState: {
        transcript: [],
        acceptedAnswers: [],
        answeredCount: 0,
        lastQuestionNumber: 0,
        pendingQuestion: false,
        mode: mode === "discovery" ? "discovery" : "diagnostic",
        // Fresh diagnostic Q&A after reset must not inherit "completed" — that forces discovery mode.
        ...(isDiagnosticRestart ? { requestingNewDiagnostic: true } : {}),
        updatedAt: new Date().toISOString(),
      },
    },
  });
}

async function buildDiscoveryWelcomeContent({
  displayName,
  priorReport,
  metrics = {},
  reportDate,
}) {
  const priorReportSnippet = priorReport
    ? truncateForContext(priorReport, 12000)
    : null;

  const gravity = metrics.gravity;
  const signalCoherence = metrics.signalCoherence;
  const signalOutput = metrics.signalOutput;
  const consciousnessLevel = metrics.consciousnessLevel;
  const qgcActivation = metrics.qgcActivation;

  const anyMetricPresent = [
    gravity,
    signalCoherence,
    signalOutput,
    consciousnessLevel,
    qgcActivation,
  ].some((v) => v !== undefined && v !== null && !Number.isNaN(v));

  const createProgressBar = (value, max = 100, length = 12) => {
    if (value === undefined || value === null || isNaN(value)) value = 0;
    value = Math.max(0, Math.min(value, max * 2));
    const filled = Math.max(
      0,
      Math.min(Math.round((value / max) * length), length),
    );
    const empty = Math.max(0, length - filled);
    return "█".repeat(filled) + "░".repeat(empty);
  };
  const formatPercentage = (v) =>
    v === undefined || v === null || Number.isNaN(v)
      ? "Unknown"
      : `${Math.round(v)}%`;
  const formatConsciousness = (cl) =>
    cl === undefined || cl === null || Number.isNaN(cl)
      ? "Unknown"
      : `${Math.round((cl / 5) * 100)}%`;

  const metricsSection = anyMetricPresent
    ? `QGC Activation:
${createProgressBar(qgcActivation)}
${formatPercentage(qgcActivation)}

Consciousness Level:
${createProgressBar((consciousnessLevel / 5) * 100)}
${formatConsciousness(consciousnessLevel)}

Gravity:
${createProgressBar(gravity)}
${formatPercentage(gravity)}

Signal Coherence:
${createProgressBar(signalCoherence)}
${formatPercentage(signalCoherence)}

Signal Output:
${createProgressBar(signalOutput)}
${formatPercentage(signalOutput)}`
    : `(Metrics loading failed. Please refer to your report dashboard.)`;

  let keySentence = "";
  let correction = "";
  if (priorReportSnippet) {
    try {
      const llmExt = await extractKeySentenceAndCorrectionWithLLM(
        priorReportSnippet,
      );
      if (llmExt.keySentence && llmExt.keySentence.length >= 15) {
        keySentence = llmExt.keySentence;
      }
      if (llmExt.correction && llmExt.correction.length >= 15) {
        correction = llmExt.correction;
      }
    } catch (e) {
      console.error("[chatSessionReset] Discovery welcome LLM extraction failed:", e);
    }
    if (!keySentence || !correction) {
      const ksMatch = priorReportSnippet.match(
        /(?:key sentence|distilled|pattern|identity statement)[\s\S]{0,500}(["'])([A-Z][^"']{20,500}?)\1/i,
      );
      if (ksMatch) keySentence = ksMatch[2].trim();
      const corrMatch = priorReportSnippet.match(
        /(?:###?\s*10\.\s*FIRST\s+CORRECTION|###?\s*FIRST\s+CORRECTION)[\s\S]{0,200}?\n\n([A-Z][^█]{20,500}?)(?:\n\n|\n\*|Gravity|Signal|QGC|CL|##|---|QGC Activation|Consciousness Level|One correction|Small\.|Structural\.|Repeatable\.|📄|PDF|Key refinement|key refinement)/i,
      );
      if (corrMatch) correction = corrMatch[1].trim();
    }
  }

  const welcomeReportDate = reportDate || "recently";
  const qText = correction
    ? `Since this report (${welcomeReportDate}), have you made any progress on ${correction}?`
    : `Since this report (${welcomeReportDate}), what has changed or stayed the same?`;

  return `Welcome back ${displayName}. I've loaded your last report.

I want to reflect it back to you first — simply and cleanly — before we move anywhere.

Your structure at the last check-in was very clear:

## METRICS GAUGE (Current Snapshot)

${metricsSection}

${
  keySentence
    ? `This is the key sentence from your map, distilled:
> *"${keySentence}"*

`
    : ""
}${
    correction
      ? `Your **entire correction** was about one thing only:
**${correction}**

`
      : ""
  }Before I update anything, I need to check one thing — slowly.

**Since this report (${welcomeReportDate}):**

${qText}

Take your time and share what feels true for you.`;
}

/**
 * Build the first assistant message after a reset (diagnostic Q1 or discovery welcome).
 */
async function buildWelcomeAfterReset({ name, email, mode, diagnostic }) {
  const displayName =
    typeof name === "string" && name.trim().length ? name.trim() : "there";

  if (mode === "discovery") {
    const priorReport =
      diagnostic?.data?.aiReport || diagnostic?.report || "";
    if (!priorReport) {
      const diagnosticWelcome = await getDiagnosticNewUserWelcomeMessage(name);
      if (diagnosticWelcome) {
        return { mode: "diagnostic", content: diagnosticWelcome };
      }
      return {
        mode: "diagnostic",
        content: `Hi ${displayName}, let's start with the 25-Question Deep Intake Engine™. One question at a time.`,
      };
    }

    const discoveryRes = await loadLatestDiscoveryMetrics(
      diagnostic,
      diagnostic?.data?.metrics || {},
    );
    const metrics =
      discoveryRes.latestDiscoveryMetrics ||
      diagnostic?.data?.metrics ||
      {};
    const reportDate = extractReportDate(
      discoveryRes.latestDiscovery,
      diagnostic,
    );

    return {
      mode: "discovery",
      content: await buildDiscoveryWelcomeContent({
        displayName,
        priorReport,
        metrics,
        reportDate,
      }),
    };
  }

  const hasPriorDiagnostic = diagnosticHasCompletedReport(diagnostic);

  if (hasPriorDiagnostic) {
    const repeatWelcome = await getDiagnosticRepeatIntakeWelcomeMessage(name);
    return {
      mode: "diagnostic",
      content:
        repeatWelcome ||
        `Hi ${displayName}, I've loaded your last diagnostic report on file. We're starting a fresh 25-Question Deep Intake Engine™ from the beginning — one question at a time.`,
    };
  }

  const welcome = await getDiagnosticNewUserWelcomeMessage(name);
  return {
    mode: "diagnostic",
    content:
      welcome ||
      `Hi ${displayName}, I don't have your intake on record yet, so we'll start with the 25-Question Deep Intake Engine™. One question at a time. No rushing. No fixing. Just mapping.`,
  };
}

module.exports = {
  deleteOngoingChatsForUser,
  clearIntakeStateOnDiagnostic,
  buildWelcomeAfterReset,
  DIAGNOSTIC_CHAT_TYPES,
  DISCOVERY_CHAT_TYPES,
};
