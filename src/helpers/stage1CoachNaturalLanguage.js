/**
 * Human-facing coach copy — no report headers, no framework jargon in user chat.
 */

const FRAMEWORK_TERM_PATTERN =
  /\b(vortex|signature\s*id|EO\b|lack\s*channel|avoidance\s*channel|QGC|CL\s*estimate|consciousness\s*level|gravity\s*depth|orbit\s*pattern|abducted\s*by\s*vortex|friction\s*level)\b/gi;

const REPORT_HEADER_PATTERN =
  /^(current\s+goal|current\s+milestone|last\s+green\s+rep|recent\s+patterns|last\s+session|loading|context\s+loaded)\s*:/gim;

const sanitizeCoachUserFacingText = (text, { stripGreetingName = null } = {}) => {
  if (!text || typeof text !== "string") return text;
  let out = text.replace(REPORT_HEADER_PATTERN, "").trim();
  out = out.replace(FRAMEWORK_TERM_PATTERN, (match) => {
    const lower = match.toLowerCase();
    if (lower.includes("vortex")) return "old pattern";
    if (lower.includes("gravity")) return "pull";
    if (lower.includes("friction")) return "resistance";
    return "pattern";
  });
  if (stripGreetingName) {
    const name = String(stripGreetingName).trim();
    if (name) {
      const greeting = new RegExp(`^\\s*hey\\s+${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*[,!.—-]*\\s*`, "i");
      out = out.replace(greeting, "").trim();
    }
  }
  out = out.replace(/\n{3,}/g, "\n\n").trim();
  return out;
};

const humanizePattern = (raw) => {
  const t = String(raw || "").trim();
  if (!t) return null;
  if (FRAMEWORK_TERM_PATTERN.test(t)) return null;
  return t
    .replace(/\b(EO|QGC|CL)\b/gi, "")
    .replace(/\s+/g, " ")
    .trim();
};

const pickNoticedPattern = (map, coachContext) => {
  const candidates = [
    map?.failure_strategy?.rule,
    map?.failure_strategy?.title,
    map?.core_fear,
    ...(map?.top_3_avoidance_behaviours || []),
    ...(map?.failure_strategy?.behaviours || []),
    ...(coachContext?.recent_patterns || []),
  ];
  for (const c of candidates) {
    const h = humanizePattern(c);
    if (h && h.length > 8 && h.length < 120) return h;
  }
  return null;
};

const formatGoalPhrase = (goal, milestone) => {
  const g = String(goal || "").trim();
  const m = String(milestone || "").trim();
  if (g && m && m !== "—" && m.toLowerCase() !== g.toLowerCase()) {
    return `${g} with a focus on ${m}`;
  }
  if (g) return g;
  if (m && m !== "—") return m;
  return "your goal";
};

const buildResistanceEvolutionNarrative = (resistanceEvolution = []) => {
  const edges = [];
  const seen = new Set();
  for (const row of resistanceEvolution) {
    const label = humanizePattern(row.fear || row.resistance);
    if (!label || seen.has(label.toLowerCase())) continue;
    seen.add(label.toLowerCase());
    edges.push({ at: row.at, label });
  }
  if (edges.length < 2) return null;

  const recent = edges.slice(-3);
  const parts = recent.map((e) => e.label);
  if (parts.length === 2) {
    return `Last time the edge was ${parts[0].toLowerCase()}. Before that it was ${parts[1].toLowerCase()}.`;
  }
  return `I'm noticing your edge has shifted — from ${parts[0].toLowerCase()} to ${parts[parts.length - 1].toLowerCase()} over recent sessions.`;
};

const buildHumanCoachOpening = ({
  firstName,
  activeGoalContext,
  map,
  memory,
  coachContext,
  continuity = null,
}) => {
  const name = firstName?.trim() || "there";
  const goal =
    activeGoalContext?.goal_name ||
    activeGoalContext?.specific_goal ||
    map?.goal_title ||
    "your goal";
  const milestone =
    activeGoalContext?.current_milestone ||
    activeGoalContext?.milestones?.day_7 ||
    null;
  const goalPhrase = formatGoalPhrase(goal, milestone);

  const priorSessions =
    (coachContext?.coaching_sessions || memory?.coaching_sessions || []).filter(
      (s) => s.ended_at || (s.turn_count || 0) > 1,
    );
  const isFirstCoachSession =
    priorSessions.length === 0 &&
    !continuity?.last_session_ended_at &&
    !continuity?.had_proof &&
    !continuity?.session_summary;

  const lines = [];
  lines.push(`Hey ${name}, good to see you.`);

  if (isFirstCoachSession) {
    lines.push("");
    lines.push(`Remember we're working on ${goalPhrase}.`);
    lines.push("");
    lines.push("How are things going today?");
    return lines.join("\n");
  }

  lines.push("");
  lines.push(`Remember we're working on ${goalPhrase}.`);

  if (continuity?.session_summary) {
    lines.push("");
    const summary = String(continuity.session_summary).trim();
    lines.push(
      summary.toLowerCase().startsWith("last session")
        ? summary.charAt(0).toUpperCase() + summary.slice(1)
        : `Last time we talked: ${summary.charAt(0).toLowerCase() + summary.slice(1)}.`,
    );
  } else if (continuity?.last_session_narrative) {
    lines.push("");
    lines.push(`Last time: ${continuity.last_session_narrative}.`);
  } else if (continuity?.recent_proof?.length) {
    lines.push("");
    lines.push(`Last time you logged: "${continuity.recent_proof[0]}".`);
  }

  const patterns = [];
  const pattern = pickNoticedPattern(map, coachContext);
  if (pattern) patterns.push(pattern.toLowerCase());
  for (const p of (coachContext?.recent_patterns || []).slice(0, 2)) {
    const h = humanizePattern(p);
    if (h && !patterns.includes(h.toLowerCase())) patterns.push(h.toLowerCase());
  }
  if (patterns.length) {
    lines.push("");
    lines.push(
      `Your recent pattern has been ${patterns.slice(0, 3).join(" and ")}.`,
    );
  }

  lines.push("");
  lines.push("How are things going today?");

  return sanitizeCoachUserFacingText(lines.join("\n"));
};

const buildNaturalOpeningQuestion = (continuity, { hadRep = false } = {}) => {
  if (continuity?.had_proof && continuity?.had_devaluation) {
    return "How have things been since then — is the 'not enough' feeling still showing up, or did something shift?";
  }
  if (continuity?.had_proof) {
    return "How have things been since you took that step?";
  }
  if (hadRep) {
    return "How have things been since we last spoke?";
  }
  return "What's been happening since we last spoke?";
};

const buildHumanAcknowledgment = (userMessage, signals = null) => {
  const text = String(userMessage || "").trim();
  if (signals?.isStrong || signals?.hasProof) {
    if (/\$|\d+\s*(?:hr|hour|dollar)/i.test(text)) {
      return "Nice — that's real progress.";
    }
    if (/\b(completed|finished|did it|reached out|sent)\b/i.test(text)) {
      return "Good — you took action.";
    }
    return "That matters — I hear the movement.";
  }
  if (text.length > 120) return "Thanks for laying that out — I'm with you.";
  if (/\b(stuck|hard|difficult|afraid|fear|avoid)\b/i.test(text)) {
    return "I hear you.";
  }
  return text ? "Got it." : "Thanks.";
};

const buildAdaptiveFollowUpQuestion = (answers, context = {}) => {
  const text = String(answers?.since_last_session || "").trim();
  const lastRepName = context.lastRepName;

  if (lastRepName && !mentionsGreenRep(text, lastRepName)) {
    return `How did "${lastRepName}" go?`;
  }
  if (/\b(stuck|blocked|avoid|hard|difficult)\b/i.test(text)) {
    return "What feels like the sharpest edge in that for you right now?";
  }
  return "What feels like the main thing in your way right now?";
};

const mentionsGreenRep = (text, repName) => {
  const t = String(text || "").toLowerCase();
  const r = String(repName || "").toLowerCase();
  if (!t || !r) return false;
  if (t.includes(r)) return true;
  const keywords = r.split(/\s+/).filter((w) => w.length > 4);
  return keywords.some((w) => t.includes(w));
};

const isSubstantiveCheckInAnswer = (text, signals = null) => {
  const t = String(text || "").trim();
  if (!t) return false;
  if (signals?.isStrong || signals?.hasProof) return true;
  if (t.length >= 90) return true;
  if (/\b(stuck|fear|avoid|hard|difficult|resist|anxious|generated|earned|completed|finished|client|outreach|reached)\b/i.test(t)) {
    return true;
  }
  return false;
};

/** @deprecated use resolveCoachingTransition from stage1CoachTransition */
const inferCoachingPhase = (messages, userMessage) => {
  const { inferCoachingPhase: infer } = require("./stage1CoachTransition");
  return infer(messages, userMessage);
};

module.exports = {
  sanitizeCoachUserFacingText,
  humanizePattern,
  buildHumanCoachOpening,
  buildNaturalOpeningQuestion,
  buildHumanAcknowledgment,
  buildAdaptiveFollowUpQuestion,
  buildResistanceEvolutionNarrative,
  mentionsGreenRep,
  isSubstantiveCheckInAnswer,
  inferCoachingPhase,
};
