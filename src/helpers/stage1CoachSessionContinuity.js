const { ensureCoachingMemory } = require("./stage1CoachingMemory");

const looksLikeProof = (text) => {
  const t = String(text || "").trim();
  if (t.length < 3) return false;
  return (
    /\d+\s*dollar|\$|\/hr|an hr|generated|earned|competed|completed|outreach|reached out/i.test(
      t,
    ) || /\bi did it\b/i.test(t)
  );
};

const DEVALUATION_SNIPPET =
  /\b(not enough|less money|too less|too small|not good enough|so+ less)\b/i;

const { isPlausibleGreenRepName } = require("./stage1CoachGreenRepUtils");

const getLastEndedCoachSession = (stage1, domain) => {
  const sessions = Array.isArray(stage1?.coach_session_log) ? stage1.coach_session_log : [];
  const ended = sessions
    .filter((s) => s.domain === domain && s.ended_at)
    .sort((a, b) => new Date(b.ended_at) - new Date(a.ended_at));
  return ended[0] || null;
};

const extractUserSnippets = (session, { max = 8 } = {}) => {
  const msgs = Array.isArray(session?.messages) ? session.messages : [];
  return msgs
    .filter((m) => m?.role === "user" && String(m.content || "").trim())
    .map((m) => String(m.content).trim())
    .slice(-max);
};

/**
 * Build cross-session continuity from proof logs, ended coach sessions, and coaching_memory.
 */
const gatherSessionContinuity = (stage1, map, domain, coachContext = {}) => {
  const memory = ensureCoachingMemory(map);
  const proofLogs = [
    ...(memory.proof_logs || []),
    ...(Array.isArray(stage1?.proof_logs)
      ? stage1.proof_logs.filter((p) => p.domain === domain)
      : []),
  ]
    .filter((p, i, arr) => arr.findIndex((x) => x.id === p.id || x.action === p.action) === i)
    .sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0))
    .slice(0, 5);

  const lastEnded = getLastEndedCoachSession(stage1, domain);
  const userSnippets = extractUserSnippets(lastEnded);
  const integration = lastEnded?.progress_integration || null;

  const proofFromSession = userSnippets.filter((t) => looksLikeProof(t));
  const proofActions = [
    integration?.answers?.acknowledge_note,
    ...proofLogs.map((p) => p.action),
    ...proofFromSession,
  ]
    .filter(Boolean)
    .map((t) => String(t).trim().slice(0, 200));

  const dedupeProofLines = (lines) => {
    const out = [];
    const seen = new Set();
    for (const line of lines) {
      const key = String(line)
        .toLowerCase()
        .replace(/\d+/g, "n")
        .replace(/[^\w\s]/g, "")
        .trim();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push(line);
    }
    return out;
  };

  const uniqueProof = dedupeProofLines(proofActions).slice(0, 2);

  const devaluationNotes = [
    integration?.answers?.devaluation_note,
    integration?.answers?.not_enough_feeling,
    ...userSnippets.filter((t) => DEVALUATION_SNIPPET.test(t)),
  ]
    .filter(Boolean)
    .map((t) => String(t).trim().slice(0, 160));

  const uniqueDevaluation = [...new Set(devaluationNotes)].slice(0, 3);

  const lastValidRep = [...(memory.green_rep_history || [])]
    .reverse()
    .find((g) => isPlausibleGreenRepName(g?.name));

  const assigned = coachContext?.last_green_rep_assigned;
  const repFromContext = isPlausibleGreenRepName(assigned?.name) ? assigned : null;
  const repFromSession = isPlausibleGreenRepName(lastEnded?.green_rep_last?.name)
    ? lastEnded.green_rep_last
    : null;

  const meaningReflection = integration?.answers?.meaning_reflection || null;
  const hadDevaluationFlow =
    integration?.step === "meaning_reflection" ||
    integration?.step === "post_proof_devaluation" ||
    integration?.step === "complete" ||
    uniqueDevaluation.length > 0;

  return {
    last_session_id: lastEnded?.id || null,
    last_session_ended_at: lastEnded?.ended_at || null,
    recent_proof: uniqueProof,
    devaluation_notes: uniqueDevaluation,
    meaning_reflection: meaningReflection,
    had_proof: uniqueProof.length > 0,
    had_devaluation: uniqueDevaluation.length > 0 || hadDevaluationFlow,
    last_green_rep: repFromContext || repFromSession || lastValidRep || null,
    session_summary: lastEnded?.session_summary || coachContext?.last_session_summary || null,
  };
};

const buildContinuityRecapLines = (continuity) => {
  if (!continuity?.had_proof && !continuity?.had_devaluation && !continuity?.session_summary) {
    return [];
  }
  const lines = ["Last session (carried forward):"];
  for (const p of continuity.recent_proof || []) {
    lines.push(`• Proof: ${p}`);
  }
  for (const d of continuity.devaluation_notes || []) {
    lines.push(`• You named: "${d}"`);
  }
  if (continuity.had_devaluation && continuity.meaning_reflection) {
    lines.push(`• Meaning you named: "${continuity.meaning_reflection}"`);
  } else if (continuity.had_devaluation) {
    lines.push("• We worked on value distortion — letting the win count before chasing 'more'.");
  }
  if (continuity.session_summary && !continuity.recent_proof?.length) {
    lines.push(`• ${continuity.session_summary}`);
  }
  return lines;
};

const buildContinuityOpeningQuestion = (continuity) => {
  if (continuity?.had_proof && continuity?.had_devaluation) {
    return "Since that session — is more of the 'not enough' feeling showing up again, or did something shift?";
  }
  if (continuity?.had_proof) {
    return "Since you logged that proof — what's shifted, even a little?";
  }
  return "What happened since our last session?";
};

/** Auto-summary when user ends coach session */
const buildSessionSummaryFromCoachLog = (session) => {
  if (!session) return null;
  const snippets = extractUserSnippets(session, { max: 12 });
  const integration = session.progress_integration;
  const parts = [];

  const proof =
    integration?.answers?.acknowledge_note ||
    snippets.find((t) => looksLikeProof(t));
  if (proof) parts.push(`Proof: ${String(proof).slice(0, 120)}`);

  const deval = integration?.answers?.devaluation_note || integration?.answers?.not_enough_feeling;
  if (deval) parts.push(`Downplay feeling: ${String(deval).slice(0, 80)}`);

  const devalMsgs = snippets.filter((t) => DEVALUATION_SNIPPET.test(t));
  for (const d of devalMsgs.slice(0, 2)) {
    if (!parts.some((p) => p.includes(d.slice(0, 20)))) {
      parts.push(`Said: "${d.slice(0, 80)}"`);
    }
  }

  if (integration?.answers?.meaning_reflection) {
    parts.push(`Meaning: ${String(integration.answers.meaning_reflection).slice(0, 80)}`);
  }
  if (integration?.answers?.active_core_wound) {
    parts.push(`Core wound: ${integration.answers.active_core_wound}`);
  }
  if (integration?.answers?.avoidance_rule) {
    parts.push(`Protecting rule: ${String(integration.answers.avoidance_rule).slice(0, 80)}`);
  }
  if (integration?.answers?.leverage_note) {
    parts.push(`Flip leverage: ${String(integration.answers.leverage_note).slice(0, 80)}`);
  }

  if (!parts.length && snippets.length) {
    parts.push(`Last note: ${snippets[snippets.length - 1].slice(0, 100)}`);
  }

  return parts.length ? parts.join(" | ") : null;
};

module.exports = {
  isPlausibleGreenRepName,
  getLastEndedCoachSession,
  gatherSessionContinuity,
  buildContinuityRecapLines,
  buildContinuityOpeningQuestion,
  buildSessionSummaryFromCoachLog,
};
