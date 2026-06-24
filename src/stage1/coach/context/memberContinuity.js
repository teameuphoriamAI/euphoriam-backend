/**
 * Build active coaching thread context for LLM continuity (returning members).
 */

const { findOpenSessionForDomain } = require("../persistence/history");
const { gatherSessionContinuity } = require("./sessionContinuity");
const { resolveLastGreenRep } = require("../legacy/checkInFlow");
const { listProofLogs } = require("../../../helpers/stage1Proof");

const buildActiveCoachingThread = ({
  stage1,
  map,
  domain,
  memory = {},
  continuity = null,
  openSession = null,
}) => {
  const c = continuity || gatherSessionContinuity(stage1, map, domain, memory);
  const rawOpen =
    openSession ||
    findOpenSessionForDomain(stage1?.coach_session_log || [], domain);
  const proofCycle = rawOpen?.proof_cycle;
  const lastRep = resolveLastGreenRep(memory, map);

  const parts = [];
  if (lastRep?.name) parts.push(`Active rep: ${lastRep.name}`);
  if (c.recent_proof?.[0]) parts.push(`Recent proof: ${c.recent_proof[0]}`);
  if (c.session_summary) parts.push(`Last session: ${String(c.session_summary).slice(0, 160)}`);
  if (c.last_user_snippet) parts.push(`They last said: "${String(c.last_user_snippet).slice(0, 100)}"`);
  if (c.active_resistance) parts.push(`Known resistance: ${c.active_resistance}`);
  if (proofCycle?.step === "awaiting_proof_log") {
    parts.push(`Waiting on proof log for ${proofCycle.rep_name || lastRep?.name || "current rep"}`);
  }
  if (proofCycle?.step === "integration_question") {
    parts.push(`In proof integration — asked: ${proofCycle.integration_question || "integration question"}`);
  }

  const proofs = listProofLogs(stage1, { domain, limit: 3 }).map((p) => p.action);

  return {
    is_returning_member: Boolean(c.is_returning_member),
    prior_session_count: c.prior_session_count || 0,
    do_not_reintroduce: Boolean(c.is_returning_member),
    last_session_summary: c.session_summary || memory.last_session_summary || null,
    last_green_rep: lastRep?.name || c.last_green_rep?.name || null,
    recent_proof_actions: proofs,
    last_user_snippet: c.last_user_snippet || null,
    active_resistance: c.active_resistance || null,
    open_session_messages: (rawOpen?.messages || []).slice(-6),
    proof_cycle_step: proofCycle?.step || null,
    thread_summary: parts.length ? parts.join(" | ") : null,
  };
};

module.exports = {
  buildActiveCoachingThread,
};
