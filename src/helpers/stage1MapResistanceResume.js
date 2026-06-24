const { Chat } = require("../models/chatModel");
const { MAP_RESISTANCE_TARGET_QUESTIONS } = require("../constants/mapResistance");

function extractQuestionNumber(content) {
  if (!content || typeof content !== "string") return 0;
  const match =
    content.match(/\*\*Q(\d+)/i) || content.match(/\bQ(\d+)\s*[—–-]/i);
  return match ? Number(match[1]) : 0;
}

/** Highest Q with at least one user reply before the next assistant question. */
function countAnsweredQuestions(rows) {
  let highestCompleted = 0;
  let pendingQ = 0;
  let seenUserForPending = false;

  for (const m of rows) {
    if (m?.role === "assistant") {
      const q = extractQuestionNumber(m.content);
      if (q > 0) {
        if (seenUserForPending && pendingQ > 0) {
          highestCompleted = Math.max(highestCompleted, pendingQ);
        }
        pendingQ = q;
        seenUserForPending = false;
      }
    } else if (m?.role === "user") {
      seenUserForPending = true;
    }
  }

  if (seenUserForPending && pendingQ > 0) {
    highestCompleted = Math.max(highestCompleted, pendingQ);
  }

  return highestCompleted;
}

/**
 * Progress from transcript — counts completed questions, not raw user messages.
 * Re-asks and gibberish attempts on the same Q do not inflate answeredCount.
 */
function progressFromTranscript(transcript, targetCount, options = {}) {
  const { lastAnswerValid = true } = options;
  const rows = Array.isArray(transcript) ? transcript : [];
  const last = rows[rows.length - 1];
  const lastAssistantHasQuestion =
    last?.role === "assistant" && extractQuestionNumber(last.content) > 0;
  const pendingQuestion = Boolean(lastAssistantHasQuestion);

  let lastQuestionNumber = 0;
  for (let i = rows.length - 1; i >= 0; i--) {
    if (rows[i]?.role !== "assistant") continue;
    const n = extractQuestionNumber(rows[i].content);
    if (n > 0) {
      lastQuestionNumber = n;
      break;
    }
  }

  const currentQuestion = lastQuestionNumber || (pendingQuestion ? 1 : 0);
  let answered = countAnsweredQuestions(rows);

  if (!lastAnswerValid && pendingQuestion) {
    answered = Math.max(0, currentQuestion - 1);
  }

  return {
    answered,
    answeredCount: answered,
    currentQuestion,
    lastQuestionNumber: currentQuestion,
    pendingQuestion,
    total: targetCount,
    finalizeReady: answered >= targetCount,
  };
}

/** True when every target question has a valid user answer (ready to finalize). */
function isMapResistanceTranscriptComplete(
  transcript,
  targetCount = MAP_RESISTANCE_TARGET_QUESTIONS,
) {
  if (!Array.isArray(transcript) || transcript.length === 0) return false;
  return progressFromTranscript(transcript, targetCount).finalizeReady;
}

/**
 * Load in-progress Map Resistance transcript from Chat (same store as diagnostic resume).
 * Returns API payload or null if nothing to resume.
 */
async function buildMapResistanceResumePayload(userId, domain, targetCount) {
  const openChats = await Chat.findAll({
    where: { userId, isChatEnded: false },
    order: [["updatedAt", "DESC"]],
  });

  const mrChat = openChats.find(
    (c) =>
      c?.data?.stage1MapResistance &&
      c.data.stage1MapResistanceDomain === domain,
  );

  if (!mrChat) {
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

function normalizeTranscriptForCompare(transcript) {
  if (!Array.isArray(transcript)) return [];
  return transcript
    .filter((m) => m?.role && m?.content != null)
    .map((m) => ({
      role: String(m.role),
      content: String(m.content).trim(),
    }));
}

/** True when client transcript differs from saved map transcript (new remapping session). */
function transcriptsDiffer(incoming, saved) {
  const a = normalizeTranscriptForCompare(incoming);
  const b = normalizeTranscriptForCompare(saved);
  if (a.length < 4) return false;
  if (b.length === 0) return true;
  if (a.length !== b.length) return true;
  return JSON.stringify(a) !== JSON.stringify(b);
}

function resumePayloadFromTranscript(transcript, domain, targetCount) {
  const prog = progressFromTranscript(transcript, targetCount);
  const lastMsg = transcript[transcript.length - 1];
  return {
    nextMessage: lastMsg?.role === "assistant" ? lastMsg : null,
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
  };
}

/**
 * Load resumable Map Resistance payload from open chat or saved domain transcript.
 * Supports first-time mapping and in-progress remapping after a prior completion.
 */
async function resolveMapResistanceResume(
  userId,
  domain,
  map,
  stage1,
  targetCount = MAP_RESISTANCE_TARGET_QUESTIONS,
) {
  const remapping =
    Boolean(map?.map_resistance_complete) &&
    Boolean(stage1?.map_resistance_in_progress);
  const savedTranscript = Array.isArray(map?.map_resistance_transcript)
    ? map.map_resistance_transcript
    : [];
  const transcriptComplete = isMapResistanceTranscriptComplete(
    savedTranscript,
    targetCount,
  );

  if (map?.map_resistance_complete && transcriptComplete && !remapping) {
    return null;
  }

  let resume = await buildMapResistanceResumePayload(userId, domain, targetCount);
  if (!resume?.transcript?.length) {
    if (
      stage1?.map_resistance_in_progress &&
      savedTranscript.length > 0
    ) {
      resume = resumePayloadFromTranscript(savedTranscript, domain, targetCount);
    } else if (
      map?.map_resistance_complete &&
      !transcriptComplete &&
      savedTranscript.length > 0
    ) {
      // Finalized early with a partial transcript — still resumable.
      resume = resumePayloadFromTranscript(savedTranscript, domain, targetCount);
    }
  }
  return resume;
}

/** Summary for domain detail / resume CTAs (no transcript body). */
function summarizeMapResistanceSession(resume, targetCount, remapping = false) {
  if (!resume?.transcript?.length) return null;
  const prog = progressFromTranscript(resume.transcript, targetCount);
  const transcriptComplete = isMapResistanceTranscriptComplete(
    resume.transcript,
    targetCount,
  );
  return {
    resumable: true,
    answered_count: prog.answeredCount,
    total: prog.total,
    current_question: prog.currentQuestion,
    pending_question: prog.pendingQuestion,
    remapping: Boolean(remapping),
    incomplete: !transcriptComplete,
    fully_complete: transcriptComplete,
  };
}

module.exports = {
  buildMapResistanceResumePayload,
  resolveMapResistanceResume,
  resumePayloadFromTranscript,
  summarizeMapResistanceSession,
  isMapResistanceTranscriptComplete,
  progressFromTranscript,
  countAnsweredQuestions,
  transcriptsDiffer,
};
