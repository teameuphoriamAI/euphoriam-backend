const { ensureCoachingMemory } = require("./coachingMemory");
const { isPositiveProofReport, isSetbackOrGapReport } = require("../signals/setback");

const looksLikeProof = (text) => isPositiveProofReport(text);

const DEVALUATION_SNIPPET =
  /\b(not enough|too little|less money|too less|too small|not good enough|so+ less|feels its not enough|did too little)\b/i;

const COLLAPSE_SNIPPET =
  /\b(no motivation|did nothing|didn't do|did not|lazy|no earning|gave up|idk)\b/i;

const WIN_SNIPPET =
  /\b(earned|made|generated|worked|got paid|\$\d+|\d+\s*(?:hrs?|hours?|hr|hour|dollar))/i;

const { isPlausibleGreenRepName } = require("../utils/greenRep");

const RELATIONSHIP_SNIPPET =
  /\b(overthink|no one|nobody|alone|relationship|trust|mirror|honest|visible|kindness|express|rep|proof|stuck|same thing|nothing special)\b/i;

const getLastMeaningfulCoachSession = (stage1, domain) => {
  const sessions = Array.isArray(stage1?.coach_session_log) ? stage1.coach_session_log : [];
  const candidates = sessions
    .filter((s) => s.domain === domain)
    .filter(
      (s) =>
        s.ended_at ||
        (s.turn_count || 0) >= 2 ||
        (Array.isArray(s.messages) && s.messages.length >= 4),
    )
    .sort(
      (a, b) =>
        new Date(b.updated_at || b.ended_at || b.started_at) -
        new Date(a.updated_at || a.ended_at || a.started_at),
    );
  return candidates[0] || null;
};

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

/** Win → devaluation → collapse chain from last session user messages. */
const extractSessionNarrative = (session) => {
  const snippets = extractUserSnippets(session, { max: 12 });
  if (!snippets.length) return null;

  const wins = snippets.filter((t) => WIN_SNIPPET.test(t));
  const devals = snippets.filter((t) => DEVALUATION_SNIPPET.test(t));
  const collapses = snippets.filter((t) => COLLAPSE_SNIPPET.test(t));

  if (wins.length && (devals.length || collapses.length)) {
    const win = wins[0].slice(0, 100);
    const deval = devals[0]?.slice(0, 80);
    const collapse = collapses[collapses.length - 1]?.slice(0, 80);
    if (deval && collapse) {
      return `you put in effort (${win}), judged it as not enough (${deval}), then motivation dropped (${collapse})`;
    }
    if (deval) {
      return `you put in effort (${win}), then judged it as not enough (${deval})`;
    }
    return `you put in effort (${win}), then action stopped (${collapse})`;
  }

  const substantive = [...snippets].reverse().find((t) => t.length >= 20);
  if (substantive) return substantive.slice(0, 160);

  const relationship = [...snippets].reverse().find((t) => RELATIONSHIP_SNIPPET.test(t));
  if (relationship) return relationship.slice(0, 160);

  return snippets[snippets.length - 1]?.slice(0, 160) || null;
};

const detectSessionPattern = (session) => {
  const snippets = extractUserSnippets(session, { max: 12 });
  const combined = snippets.join(" ").toLowerCase();
  const hasWin = WIN_SNIPPET.test(combined);
  const hasDeval = DEVALUATION_SNIPPET.test(combined);
  const hasCollapse = COLLAPSE_SNIPPET.test(combined);
  if (hasWin && hasDeval && hasCollapse) {
    return "proof_devaluation_collapse";
  }
  if (hasWin && hasDeval) return "proof_devaluation";
  if (hasDeval && hasCollapse) return "devaluation_collapse";
  return null;
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
  const lastMeaningful = lastEnded || getLastMeaningfulCoachSession(stage1, domain);
  const memorySessions = (coachContext?.coaching_sessions || memory.coaching_sessions || [])
    .filter((s) => !domain || s.domain === domain)
    .slice(-5);
  const lastMemorySession = [...memorySessions].reverse().find(
    (s) => s.session_summary || (s.turn_count || 0) >= 2 || s.ended_at,
  );

  const userSnippets = extractUserSnippets(lastMeaningful);
  const integration = lastMeaningful?.progress_integration || null;
  const lastSessionNarrative = extractSessionNarrative(lastMeaningful);
  const detectedPattern = detectSessionPattern(lastMeaningful);

  const proofFromSession = userSnippets.filter((t) => looksLikeProof(t));
  const setbackFromSession = userSnippets.filter((t) => isSetbackOrGapReport(t));
  const proofActions = [
    ...proofFromSession,
    integration?.answers?.acknowledge_note,
    lastSessionNarrative,
    ...proofLogs.map((p) => p.action),
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
  const recent_setback = dedupeProofLines(setbackFromSession).slice(0, 1);

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
  const repFromSession = isPlausibleGreenRepName(lastMeaningful?.green_rep_last?.name)
    ? lastMeaningful.green_rep_last
    : null;

  const meaningReflection = integration?.answers?.meaning_reflection || null;
  const hadDevaluationFlow =
    integration?.step === "meaning_reflection" ||
    integration?.step === "post_proof_devaluation" ||
    integration?.step === "complete" ||
    uniqueDevaluation.length > 0;

  const priorSessionCount =
    (stage1?.coach_session_log || []).filter(
      (s) => s.domain === domain && (s.ended_at || (s.turn_count || 0) > 1),
    ).length + memorySessions.filter((s) => s.ended_at || (s.turn_count || 0) > 1).length;

  const coachingSummaries = coachContext?.coaching_summaries || memory.coaching_summaries || [];
  const lastCoachingSummary = coachingSummaries.length
    ? coachingSummaries[coachingSummaries.length - 1]?.summary
    : null;

  const resolvedSummary =
    lastEnded?.session_summary ||
    lastMeaningful?.session_summary ||
    lastMemorySession?.session_summary ||
    coachContext?.last_session_summary ||
    lastCoachingSummary ||
    (lastSessionNarrative ? `Last session: ${lastSessionNarrative}` : null);

  const is_returning_member = Boolean(
    priorSessionCount > 0 ||
      lastEnded?.ended_at ||
      uniqueProof.length > 0 ||
      resolvedSummary ||
      (memory.green_rep_history || []).length > 0 ||
      coachingSummaries.length > 0,
  );

  const lastUserSnippet = userSnippets[userSnippets.length - 1] || null;

  return {
    last_session_id: lastMeaningful?.id || null,
    last_session_ended_at: lastEnded?.ended_at || lastMeaningful?.updated_at || null,
    recent_proof: uniqueProof,
    recent_setback: recent_setback,
    last_session_narrative: lastSessionNarrative,
    detected_pattern: detectedPattern,
    devaluation_notes: uniqueDevaluation,
    meaning_reflection: meaningReflection,
    had_proof: uniqueProof.length > 0 || Boolean(lastSessionNarrative),
    had_devaluation: uniqueDevaluation.length > 0 || hadDevaluationFlow,
    last_green_rep: repFromContext || repFromSession || lastValidRep || null,
    session_summary: resolvedSummary,
    prior_session_count: priorSessionCount,
    is_returning_member,
    last_user_snippet: lastUserSnippet,
    coaching_insights: (lastMemorySession?.coaching_insights || []).slice(-3),
    active_resistance:
      lastMemorySession?.current_resistance ||
      coachContext?.last_session_fear ||
      null,
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

/** Today-first opening question — continuity memory stays internal to the LLM. */
const buildContinuityOpeningQuestion = (continuity) => {
  if (continuity?.recent_setback?.length) {
    return "What's showing up today around that gap — and what's getting in the way?";
  }
  if (continuity?.had_proof && continuity?.had_devaluation) {
    return "What are we creating today — and is the 'not enough' feeling in the way?";
  }
  if (continuity?.last_green_rep?.name) {
    return "What are we creating today?";
  }
  if (continuity?.had_proof) {
    return "What are we creating today?";
  }
  return "What are we creating today?";
};

/** Auto-summary when user ends coach session */
const buildSessionSummaryFromCoachLog = (session) => {
  if (!session) return null;
  if (session.session_summary?.trim()) return session.session_summary.trim();

  const narrative = extractSessionNarrative(session);
  if (narrative) return narrative;

  const snippets = extractUserSnippets(session, { max: 12 });
  const integration = session.progress_integration;
  const parts = [];

  const proof =
    integration?.answers?.acknowledge_note ||
    snippets.find((t) => looksLikeProof(t) && !isSetbackOrGapReport(t));
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

  const repName = session?.green_rep_last?.name;
  if (isPlausibleGreenRepName(repName) && !parts.some((p) => p.includes(repName))) {
    parts.unshift(`Rep: ${repName}`);
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
  extractSessionNarrative,
  detectSessionPattern,
};
