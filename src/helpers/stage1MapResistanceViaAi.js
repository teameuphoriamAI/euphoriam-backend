const { Chat } = require("../models/chatModel");
const { successResponse, errorResponse } = require("../utils/response");
const aiService = require("../clients/aiService");
const { MAP_RESISTANCE_TARGET_QUESTIONS } = require("../constants/mapResistance");
const { buildActiveGoalContext } = require("./stage1GoalContext");
const { loadMapResistancePromptBundle } = require("./stage1Prompts");
const { validateMapResistanceLastAnswer, buildInvalidAnswerReaskTurn, buildValidAnswerAdvanceTurn, buildCompletionTurn } = require("./stage1MapResistanceAnswerValidation");
const { resolveMapResistanceResume } = require("./stage1MapResistanceResume");
const { persistStage1ForUser } = require("./stage1Repository");
const { upsertDomainMap } = require("./stage1State");

/**
 * Map Resistance chat turn via Python AI service (same response shape as diagnostics/chatbot-freeform).
 */
const mapResistanceChatViaPython = async (req, res, { user, domain, map, stage1 }) => {
  let messages = Array.isArray(req.body?.messages) ? req.body.messages : [];
  const activeGoalContext = buildActiveGoalContext(map, domain);
  const targetCount = req.body?.targetCount || MAP_RESISTANCE_TARGET_QUESTIONS;

  if (messages.length === 0) {
    const resume = await resolveMapResistanceResume(
      user.id,
      domain,
      map,
      stage1,
      targetCount,
    );
    if (resume?.transcript?.length) {
      const last = resume.transcript[resume.transcript.length - 1];
      if (last?.role === "assistant") {
        return successResponse(res, "Resuming map resistance", {
          ...resume,
          aiAnswered: true,
        });
      }
      messages = resume.transcript;
    }
  }

  const validation = await validateMapResistanceLastAnswer(messages);
  const lastAnswerValid = validation.hasUserTurn ? validation.aiAnswered : true;

  if (validation.hasUserTurn && !validation.aiAnswered) {
    console.log("[mapResistanceChatViaPython] Rejected invalid answer", {
      preview: String(validation.lastUserContent || "").slice(0, 60),
      gibberish: validation.isGibberish,
      stayOnQ: validation.currentQuestionNumber,
    });
    const data = buildInvalidAnswerReaskTurn(messages, targetCount, validation);
    try {
      await persistMapResistanceTranscript(user, domain, map, stage1, data.transcript);
    } catch (chatErr) {
      console.warn("[mapResistanceChatViaPython] Re-ask persist:", chatErr.message);
    }
    return successResponse(res, "Map resistance re-ask", {
      ...data,
      aiAnswered: false,
    });
  }

  if (
    validation.hasUserTurn &&
    validation.aiAnswered &&
    validation.currentQuestionNumber >= targetCount
  ) {
    const data = buildCompletionTurn(messages, targetCount, activeGoalContext);
    try {
      await persistMapResistanceTranscript(user, domain, map, stage1, data.transcript);
    } catch (chatErr) {
      console.warn("[mapResistanceChatViaPython] Complete persist:", chatErr.message);
    }
    return successResponse(res, "Map resistance complete", {
      ...data,
      aiAnswered: true,
    });
  }

  let data;
  try {
    const prompts = await loadMapResistancePromptBundle();
    data = await aiService.mapResistanceTurn({
      active_goal_context: activeGoalContext,
      transcript: messages,
      target_count: targetCount,
      user_name: user.name || user.email?.split("@")[0] || "there",
      prompts,
      last_answer_valid: lastAnswerValid,
      stay_on_question: validation.currentQuestionNumber || undefined,
    });
  } catch (err) {
    console.warn("[mapResistanceChatViaPython] Python failed:", err.message);
    if (!validation.hasUserTurn) {
      throw err;
    }
    if (lastAnswerValid) {
      data = buildValidAnswerAdvanceTurn(
        messages,
        targetCount,
        validation,
        activeGoalContext,
      );
    } else {
      data = buildInvalidAnswerReaskTurn(messages, targetCount, validation);
    }
  }

  try {
    await persistMapResistanceTranscript(user, domain, map, stage1, data.transcript || data.messages || messages);
  } catch (chatErr) {
    console.warn("[mapResistanceChatViaPython] Chat persist:", chatErr.message);
  }

  return successResponse(res, "Next map resistance message", {
    nextMessage: data.nextMessage,
    transcript: data.transcript || data.messages,
    messages: data.messages || data.transcript,
    intakeState: data.intakeState,
    answeredCount: data.answeredCount,
    pendingQuestion: data.pendingQuestion,
    progress: data.progress,
    finalize_ready: data.finalize_ready,
    aiAnswered: lastAnswerValid,
  });
};

async function persistMapResistanceTranscript(user, domain, map, stage1, transcript) {
  if (!Array.isArray(transcript) || transcript.length === 0) {
    return;
  }
  const remapping =
    Boolean(map.map_resistance_complete) && Boolean(stage1.map_resistance_in_progress);
  if (map.map_resistance_complete && !remapping) {
    return;
  }
  const openChats = await Chat.findAll({
    where: { userId: user.id, isChatEnded: false },
    order: [["updatedAt", "DESC"]],
  });
  const mrChat = openChats.find(
    (c) =>
      c?.data?.stage1MapResistance &&
      c.data.stage1MapResistanceDomain === domain,
  );
  const chatPayload = {
    stage1MapResistance: true,
    stage1MapResistanceDomain: domain,
    transcript,
    mode: "map_resistance",
  };
  if (mrChat) {
    await mrChat.update({ data: { ...mrChat.data, ...chatPayload } });
  } else {
    await Chat.create({
      userId: user.id,
      isChatEnded: false,
      data: chatPayload,
    });
  }
  await persistStage1ForUser(
    user.id,
    upsertDomainMap(stage1, domain, {
      map_resistance_transcript: transcript,
    }),
  );
}

module.exports = { mapResistanceChatViaPython };
