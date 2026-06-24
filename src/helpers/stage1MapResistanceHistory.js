const { Op } = require("sequelize");
const { withDbSlot } = require("../config/sequelize");
const { Chat } = require("../models/chatModel");
const { DOMAIN_LABELS, normalizeDomain } = require("../constants/domains");
const { MAP_RESISTANCE_TARGET_QUESTIONS } = require("../constants/mapResistance");
const { loadStage1ForUser } = require("./stage1Repository");
const { isMapResistanceTranscriptComplete } = require("./stage1MapResistanceResume");

const summarizeTranscript = (transcript = []) => {
  const userCount = transcript.filter((m) => m?.role === "user").length;
  const lastUser = [...transcript].reverse().find((m) => m?.role === "user");
  return {
    exchange_count: userCount,
    last_user_preview: lastUser?.content
      ? String(lastUser.content).slice(0, 120)
      : null,
  };
};

/** List map resistance sessions for a user (newest first). Includes incomplete mappings. */
const listMapResistanceHistory = async (user, { domain: domainFilter } = {}) => {
  const stage1 = await loadStage1ForUser(user);
  const filterDomain = domainFilter ? normalizeDomain(domainFilter) : null;

  const entries = (stage1.domain_maps || [])
    .filter((m) => {
      const transcript = Array.isArray(m.map_resistance_transcript)
        ? m.map_resistance_transcript
        : [];
      if (filterDomain && m.domain !== filterDomain) return false;
      return (
        m.map_resistance_complete ||
        (stage1.map_resistance_in_progress && transcript.length > 0)
      );
    })
    .map((m) => {
      const transcript = Array.isArray(m.map_resistance_transcript)
        ? m.map_resistance_transcript
        : [];
      const completedAt =
        m.map_resistance_completed_at || m.updatedAt || new Date().toISOString();
      const fullyComplete =
        Boolean(m.map_resistance_complete) &&
        isMapResistanceTranscriptComplete(
          transcript,
          MAP_RESISTANCE_TARGET_QUESTIONS,
        );
      return {
        id: `${m.domain}-${completedAt}`,
        domain: m.domain,
        domain_label: DOMAIN_LABELS[m.domain] || m.domain,
        goal_title: m.goal_title,
        desired_outcome: m.desired_outcome,
        completed_at: completedAt,
        transcript,
        failure_strategy: m.failure_strategy || null,
        success_strategy: m.success_strategy || null,
        daily_rep: m.daily_rep || null,
        win_condition: m.win_condition || null,
        signature_id: m.signature_id || null,
        incomplete: !fullyComplete,
        fully_complete: fullyComplete,
        ...summarizeTranscript(transcript),
      };
    });

  const needsBackfill = entries.filter((e) => !e.transcript?.length);
  if (needsBackfill.length && user?.id) {
    const chats = await withDbSlot(() =>
      Chat.findAll({
        where: {
          userId: user.id,
          isChatEnded: true,
          updatedAt: { [Op.gte]: new Date(Date.now() - 365 * 24 * 60 * 60 * 1000) },
        },
        order: [["updatedAt", "DESC"]],
        limit: 50,
      }),
    );

    for (const chat of chats) {
      const data = chat.data || {};
      if (!data.stage1MapResistance) continue;
      const d = normalizeDomain(data.stage1MapResistanceDomain);
      if (!d) continue;
      const entry = entries.find((e) => e.domain === d && !e.transcript?.length);
      if (entry && Array.isArray(data.transcript) && data.transcript.length) {
        entry.transcript = data.transcript;
        Object.assign(entry, summarizeTranscript(data.transcript));
      }
    }
  }

  entries.sort(
    (a, b) => new Date(b.completed_at).getTime() - new Date(a.completed_at).getTime(),
  );

  return entries;
};

module.exports = { listMapResistanceHistory };
