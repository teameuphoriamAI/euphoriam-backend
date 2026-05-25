const { Chat } = require("../models/chatModel");
const { successResponse, errorResponse } = require("../utils/response");
const aiService = require("../clients/aiService");
const { buildActiveGoalContext } = require("./stage1GoalContext");
const { loadMapResistancePromptBundle } = require("./stage1Prompts");

/**
 * Map Resistance chat turn via Python AI service (same response shape as diagnostics/chatbot-freeform).
 */
const mapResistanceChatViaPython = async (req, res, { user, domain, map, stage1 }) => {
  const messages = Array.isArray(req.body?.messages) ? req.body.messages : [];
  const activeGoalContext = buildActiveGoalContext(map, domain);
  const targetCount = req.body?.targetCount || 12;

  const prompts = await loadMapResistancePromptBundle();
  const data = await aiService.mapResistanceTurn({
    active_goal_context: activeGoalContext,
    transcript: messages,
    target_count: targetCount,
    user_name: user.name || user.email?.split("@")[0] || "there",
    prompts,
  });

  try {
    const mrChat = await Chat.findOne({
      where: { userId: user.id, isChatEnded: false },
      order: [["updatedAt", "DESC"]],
    });
    const transcript = data.transcript || data.messages || messages;
    const chatPayload = {
      stage1MapResistance: true,
      stage1MapResistanceDomain: domain,
      transcript,
      mode: "map_resistance",
    };
    if (mrChat?.data?.stage1MapResistance && mrChat?.data?.stage1MapResistanceDomain === domain) {
      await mrChat.update({ data: { ...mrChat.data, ...chatPayload } });
    } else {
      await Chat.create({
        userId: user.id,
        isChatEnded: false,
        data: chatPayload,
      });
    }
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
  });
};

module.exports = { mapResistanceChatViaPython };
