const { isObviouslyGibberish } = require("./funnelAnswerValidation");

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
    "what do you mean",
    "rephrase",
  ];
  if (clarifyPhrases.some((p) => t.includes(p))) return false;

  return /[A-Za-z0-9]/.test(t);
};

const isSubstantiveFunnelAnswer = (text = "") =>
  isAnswerLike(text) && !isObviouslyGibberish(text);

const maxQuestionNumberInText = (text = "") => {
  const s = String(text || "");
  let max = 0;
  const bump = (raw) => {
    const n = parseInt(raw, 10);
    if (Number.isFinite(n) && n >= 1 && n <= 99) max = Math.max(max, n);
  };
  let m;
  const reQ = /Q\s*(\d{1,2})\b/gi;
  while ((m = reQ.exec(s)) !== null) bump(m[1]);
  const reQHash = /\bquestion\s*#?\s*(\d{1,2})\b/gi;
  while ((m = reQHash.exec(s)) !== null) bump(m[1]);
  const reQWord = /\bquestion\s+(\d{1,2})(?:\s*[—–\-:]|\/|\s+of)\b/gi;
  while ((m = reQWord.exec(s)) !== null) bump(m[1]);
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

const assistantMessageMentionsQuestionCap = (content, cap) => {
  const s = String(content || "");
  if (new RegExp(`Q\\s*${cap}\\b`, "i").test(s)) return true;
  if (new RegExp(`\\bquestion\\s*#?\\s*${cap}\\b`, "i").test(s)) return true;
  if (
    new RegExp(`\\bquestion\\s+${cap}(?:\\s*[—–\\-:]|\\s+of)\\b`, "i").test(s)
  )
    return true;
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

const lastAnsweredCoreQuestion = (transcript, cap = 25) => {
  let last = 0;
  for (let i = 0; i < (transcript || []).length - 1; i++) {
    const curr = transcript[i];
    const next = transcript[i + 1];
    if (
      curr?.role === "assistant" &&
      next?.role === "user" &&
      /Q\d+/i.test(curr.content || "") &&
      !/CB\d+/i.test(curr.content || "")
    ) {
      const match = (curr.content || "").match(/Q(\d+)/i);
      if (match && isSubstantiveFunnelAnswer(next.content)) {
        last = Math.max(last, parseInt(match[1], 10));
      }
    }
  }
  return Math.min(last, cap);
};

/**
 * Intake is complete only after a substantive user reply following the last assistant turn that mentions Q(cap).
 */
const funnelIntakeTranscriptComplete = (transcript, cap = 25) => {
  const t = transcript || [];
  let maxQ = maxCoreQuestionFromTranscript(t, cap);
  const hasAssistant = t.some((m) => m.role === "assistant");
  if (maxQ === 0 && hasAssistant) maxQ = 1;
  const lastAnswered = lastAnsweredCoreQuestion(t, cap);
  if (lastAnswered < cap || maxQ < cap) return false;
  const capIdx = lastAssistantIndexMentioningQuestionCap(t, cap);
  if (capIdx < 0) return lastAnswered >= cap && maxQ >= cap;
  return t
    .slice(capIdx + 1)
    .some((m) => m.role === "user" && isSubstantiveFunnelAnswer(m.content));
};

const funnelIntakeTranscriptCompleteOrLegacy = (transcript, cap = 25) =>
  funnelIntakeTranscriptComplete(transcript, cap);

module.exports = {
  isAnswerLike,
  isSubstantiveFunnelAnswer,
  maxCoreQuestionFromTranscript,
  lastAnsweredCoreQuestion,
  funnelIntakeTranscriptComplete,
  funnelIntakeTranscriptCompleteOrLegacy,
  maxQuestionNumberInText,
};
