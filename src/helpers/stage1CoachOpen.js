const { buildActiveGoalContext } = require("./stage1GoalContext");
const {
  ensureCoachingMemory,
  captureInitialDiagnosticIfNeeded,
  syncProofLogsToCoachingMemory,
  serializeCoachingMemoryForCoach,
} = require("./stage1CoachingMemory");
const { findOpenSessionForDomain } = require("./stage1CoachHistory");
const {
  buildCoachOpeningCheckin,
  collectRecentPatterns,
  resolveLastGreenRep,
} = require("./stage1CoachCheckInFlow");
const { gatherSessionContinuity } = require("./stage1CoachSessionContinuity");

const gatherCoachOpenPayload = (user, stage1, map, domain) => {
  let enriched = captureInitialDiagnosticIfNeeded(
    map,
    buildActiveGoalContext(map, domain),
    domain,
  );
  enriched = syncProofLogsToCoachingMemory(enriched, stage1?.proof_logs || []);
  const memory = ensureCoachingMemory(enriched);
  const coachContext = serializeCoachingMemoryForCoach(enriched, stage1, domain);
  const activeGoalContext = buildActiveGoalContext(enriched, domain);
  const firstName = (user?.name?.trim() || "Member").split(/\s+/)[0];

  const continuity = gatherSessionContinuity(stage1, enriched, domain, coachContext);

  return {
    map: enriched,
    memory,
    coachContext,
    activeGoalContext,
    continuity,
    opening_message: buildCoachOpeningCheckin({
      firstName,
      activeGoalContext,
      map: enriched,
      memory: { ...memory, ...coachContext },
      coachContext,
      continuity,
    }),
  };
};

/** True when open session exists and user has not replied yet after the opening check-in. */
const sessionAwaitingUserReply = (stage1, domain) => {
  const sessions = stage1?.coach_session_log || [];
  const open = findOpenSessionForDomain(sessions, domain);
  if (!open) return false;
  const msgs = Array.isArray(open.messages) ? open.messages : [];
  const hasUser = msgs.some((m) => m.role === "user" && String(m.content || "").trim());
  if (hasUser) return false;
  return msgs.some((m) => m.role === "assistant" && String(m.content || "").trim());
};

module.exports = {
  buildCoachOpeningCheckin,
  gatherCoachOpenPayload,
  sessionAwaitingUserReply,
  collectRecentPatterns,
  resolveLastGreenRep,
};
