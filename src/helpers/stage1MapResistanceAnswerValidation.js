const {
  isLikelyGibberishMessage,
  isAiLikelyAnswer,
} = require("./euphoriamChatbot");
const { progressFromTranscript } = require("./stage1MapResistanceResume");

function extractQuestionNumber(content) {
  if (!content || typeof content !== "string") return 0;
  const match =
    content.match(/\*\*Q(\d+)/i) || content.match(/\bQ(\d+)\s*[—–-]/i);
  return match ? Number(match[1]) : 0;
}

function findLastAssistantQuestion(transcript) {
  for (let i = transcript.length - 1; i >= 0; i--) {
    const m = transcript[i];
    if (m?.role === "assistant" && /Q\d+/i.test(m.content || "")) {
      return { content: m.content, number: extractQuestionNumber(m.content) };
    }
  }
  return null;
}

function isObviousGibberish(text) {
  const t = String(text || "").trim();
  if (t.length < 2) return true;
  const letters = t.replace(/[^a-zA-Z]/g, "");
  if (letters.length >= 5 && !/[aeiouAEIOU]/.test(letters)) return true;
  const words = t.match(/[a-zA-Z]{3,}/g) || [];
  if (words.length) {
    const vowelless = words.filter((w) => !/[aeiouAEIOU]/.test(w)).length;
    if (vowelless >= Math.max(1, Math.ceil(words.length / 2))) return true;
  }
  return false;
}

function buildInvalidAnswerReaskTurn(transcript, targetCount, validation) {
  const stayOnQ = validation.currentQuestionNumber || 1;
  const lastQ = findLastAssistantQuestion(transcript);
  const prevContent = lastQ?.content || "";
  const preview = String(validation.lastUserContent || "").slice(0, 80);

  const lead = validation.isGibberish
    ? preview
      ? `Hmm, that doesn't look like a response I can work with ("${preview}") — no worries, let me rephrase.`
      : "Hmm, that doesn't look like a response I can work with — no worries, let me rephrase."
    : "I'm not sure that answers the question — let me rephrase.";

  const titleMatch = prevContent.match(/\*\*Q\d+\s*[—–-]\s*([^*\n]+)/i);
  const title = titleMatch?.[1]?.replace(/\*\*/g, "").trim() || "This question";
  const bodyMatch = prevContent.match(/\*\*Q\d+[^*\n]*\*\*\s*\n?([\s\S]*)$/i);
  const body =
    bodyMatch?.[1]?.trim() ||
    "Try answering in plain language — even a short honest reply is enough.";

  const content = `${lead}\n\n**Q${stayOnQ} — ${title}**\n${body}`;
  const assistantMsg = { role: "assistant", content };
  const fullTranscript = [...transcript, assistantMsg];
  const prog = progressFromTranscript(fullTranscript, targetCount, {
    lastAnswerValid: false,
  });

  return {
    nextMessage: assistantMsg,
    transcript: fullTranscript,
    messages: fullTranscript,
    answeredCount: prog.answeredCount,
    pendingQuestion: prog.pendingQuestion,
    progress: {
      answered: prog.answered,
      total: prog.total,
      currentQuestion: prog.currentQuestion,
    },
    intakeState: {
      transcript: fullTranscript,
      answeredCount: prog.answeredCount,
      lastQuestionNumber: prog.lastQuestionNumber,
      pendingQuestion: prog.pendingQuestion,
      mode: "map_resistance",
    },
    finalize_ready: prog.finalizeReady,
  };
}

const { MAP_ADVANCE_FALLBACKS } = require("./stage1PromptSuite");

function buildCompletionTurn(transcript, targetCount, goalContext = {}) {
  const goal =
    goalContext.specific_goal ||
    goalContext.goal_name ||
    goalContext.measurable_outcome ||
    "your goal";
  const content = `Great work — you've answered all ${targetCount} questions about "${goal}".\n\nWhen you're ready, click **Complete mapping** below to extract your resistance structure and continue.`;
  const assistantMsg = { role: "assistant", content };
  const fullTranscript = [...transcript, assistantMsg];
  const prog = progressFromTranscript(fullTranscript, targetCount);

  return {
    nextMessage: assistantMsg,
    transcript: fullTranscript,
    messages: fullTranscript,
    answeredCount: targetCount,
    pendingQuestion: false,
    progress: {
      answered: targetCount,
      total: targetCount,
      currentQuestion: targetCount,
    },
    intakeState: {
      transcript: fullTranscript,
      answeredCount: targetCount,
      lastQuestionNumber: targetCount,
      pendingQuestion: false,
      mode: "map_resistance",
    },
    finalize_ready: true,
  };
}

/** Fallback when Python is unavailable but the user's answer was valid. */
function buildValidAnswerAdvanceTurn(
  transcript,
  targetCount,
  validation,
  goalContext = {},
  advanceFallbacks = MAP_ADVANCE_FALLBACKS,
) {
  const lastQNum = validation.currentQuestionNumber || 1;
  if (lastQNum >= targetCount) {
    return buildCompletionTurn(transcript, targetCount, goalContext);
  }
  const nextQ = lastQNum + 1;
  const goal =
    goalContext.specific_goal ||
    goalContext.goal_name ||
    goalContext.measurable_outcome ||
    "your goal";
  const ack = "Got it — I hear that. Thanks for sharing.";
  const idx = Math.max(0, Math.min(nextQ - 2, advanceFallbacks.length - 1));
  const [title, template] = advanceFallbacks[idx];
  const body = template
    .replace(/\{\{goal\}\}/g, `"${goal}"`)
    .replace(/\{goal\}/g, `"${goal}"`)
    .replace(/your goal/g, `"${goal}"`);
  const content = `${ack}\n\n**Q${nextQ} — ${title}**\n${body}`;
  const assistantMsg = { role: "assistant", content };
  const fullTranscript = [...transcript, assistantMsg];
  const prog = progressFromTranscript(fullTranscript, targetCount);

  return {
    nextMessage: assistantMsg,
    transcript: fullTranscript,
    messages: fullTranscript,
    answeredCount: prog.answeredCount,
    pendingQuestion: prog.pendingQuestion,
    progress: {
      answered: prog.answered,
      total: prog.total,
      currentQuestion: prog.currentQuestion,
    },
    intakeState: {
      transcript: fullTranscript,
      answeredCount: prog.answeredCount,
      lastQuestionNumber: prog.lastQuestionNumber,
      pendingQuestion: prog.pendingQuestion,
      mode: "map_resistance",
    },
    finalize_ready: prog.finalizeReady,
  };
}

/**
 * Validate the latest user reply against the current Map Resistance question.
 * Returns aiAnswered=false for gibberish or replies that do not address the question.
 */
async function validateMapResistanceLastAnswer(transcript) {
  const rows = Array.isArray(transcript) ? transcript : [];
  const last = rows[rows.length - 1];
  if (!last || last.role !== "user") {
    return {
      aiAnswered: true,
      isGibberish: false,
      currentQuestionNumber: 0,
      hasUserTurn: false,
    };
  }

  const lastQ = findLastAssistantQuestion(rows);
  if (!lastQ?.number) {
    return {
      aiAnswered: true,
      isGibberish: false,
      currentQuestionNumber: 0,
      hasUserTurn: true,
    };
  }

  const content = String(last.content || "").trim();
  if (!content) {
    return {
      aiAnswered: false,
      isGibberish: false,
      currentQuestionNumber: lastQ.number,
      hasUserTurn: true,
      lastUserContent: content,
    };
  }

  let isGibberish = isObviousGibberish(content);
  if (!isGibberish) {
    try {
      isGibberish = await isLikelyGibberishMessage(content);
    } catch {
      isGibberish = false;
    }
  }

  if (isGibberish) {
    return {
      aiAnswered: false,
      isGibberish: true,
      currentQuestionNumber: lastQ.number,
      hasUserTurn: true,
      lastUserContent: content,
    };
  }

  let aiAnswered = true;
  if (content.length >= 8) {
    try {
      aiAnswered = await isAiLikelyAnswer({
        question: lastQ.content,
        reply: content,
      });
    } catch {
      aiAnswered = true;
    }
  } else {
    aiAnswered = false;
  }

  return {
    aiAnswered,
    isGibberish: false,
    currentQuestionNumber: lastQ.number,
    hasUserTurn: true,
    lastUserContent: content,
  };
}

module.exports = {
  extractQuestionNumber,
  validateMapResistanceLastAnswer,
  buildInvalidAnswerReaskTurn,
  buildValidAnswerAdvanceTurn,
  buildCompletionTurn,
};
