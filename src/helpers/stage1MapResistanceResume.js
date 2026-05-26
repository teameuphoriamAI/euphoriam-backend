const { Chat } = require("../models/chatModel");

function extractQuestionNumber(content) {
  if (!content || typeof content !== "string") return 0;
  const match =
    content.match(/\*\*Q(\d+)/i) || content.match(/\bQ(\d+)\s*[—–-]/i);
  return match ? Number(match[1]) : 0;
}

/** Progress fields aligned with Python map_resistance _pack_turn + frontend progressFromApi. */
function progressFromTranscript(transcript, targetCount) {
  const answered = transcript.filter((m) => m?.role === "user").length;
  const last = transcript[transcript.length - 1];
  const pendingQuestion = last?.role === "assistant";

  let lastQuestionNumber = 0;
  for (let i = transcript.length - 1; i >= 0; i--) {
    if (transcript[i]?.role !== "assistant") continue;
    const n = extractQuestionNumber(transcript[i].content);
    if (n > 0) {
      lastQuestionNumber = n;
      break;
    }
  }

  const currentQuestion = lastQuestionNumber || (pendingQuestion ? 1 : 0);

  return {
    answered,
    answeredCount: answered,
    currentQuestion,
    lastQuestionNumber: currentQuestion,
    pendingQuestion,
    total: targetCount,
    finalizeReady: answered >= targetCount && !pendingQuestion,
  };
}

/**
 * Load in-progress Map Resistance transcript from Chat (same store as diagnostic resume).
 * Returns API payload or null if nothing to resume.
 */
async function buildMapResistanceResumePayload(userId, domain, targetCount) {
  const mrChat = await Chat.findOne({
    where: { userId, isChatEnded: false },
    order: [["updatedAt", "DESC"]],
  });

  if (
    !mrChat?.data?.stage1MapResistance ||
    mrChat.data.stage1MapResistanceDomain !== domain
  ) {
    return null;
  }

  const transcript = mrChat.data.transcript;
  if (!Array.isArray(transcript) || transcript.length === 0) {
    return null;
  }

  const prog = progressFromTranscript(transcript, targetCount);
  const lastMsg = transcript[transcript.length - 1];
  const nextMessage =
    lastMsg?.role === "assistant" ? lastMsg : null;

  return {
    nextMessage,
    transcript,
    messages: transcript,
    mode: "map_resistance",
    targetCount,
    answeredCount: prog.answeredCount,
    pendingQuestion: prog.pendingQuestion,
    progress: {
      answered: prog.answered,
      total: prog.total,
      currentQuestion: prog.currentQuestion,
    },
    intakeState: {
      transcript,
      mode: "map_resistance",
      activeDomain: domain,
      answeredCount: prog.answeredCount,
      lastQuestionNumber: prog.lastQuestionNumber,
      pendingQuestion: prog.pendingQuestion,
    },
    finalize_ready: prog.finalizeReady,
    status: "resumable",
    hasIncompleteChat: true,
    incompleteChatId: mrChat.id,
  };
}

module.exports = {
  buildMapResistanceResumePayload,
  progressFromTranscript,
};
