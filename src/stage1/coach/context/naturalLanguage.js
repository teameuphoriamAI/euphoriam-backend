/**
 * Human-facing coach copy — no report headers, no framework jargon in user chat.
 */

const FRAMEWORK_TERM_PATTERN =
  /\b(vortex|signature\s*id|EO\b|lack\s*channel|avoidance\s*channel|QGC|CL\s*estimate|consciousness\s*level|gravity\s*depth|orbit\s*pattern|abducted\s*by\s*vortex|friction\s*level)\b/gi;

const REPORT_HEADER_PATTERN =
  /^(current\s+goal|current\s+milestone|last\s+green\s+rep|recent\s+patterns|last\s+session|loading|context\s+loaded)\s*:/gim;

const COACH_TEMPLATE_LABEL_BLOCK =
  /\n\s*\*\*(?:Pattern|Cost|Failure\s+Strategy|Success\s+Strategy|Today'?s?\s+Green\s+Rep|Win\s+Condition)\s*:\*\*[\s\S]*$/i;

const HOLLOW_COACH_PHRASES = [
  /\byou'?re doing great by staying engaged[^.!?\n]*[.!?]?\s*/gi,
  /\bkeep going!\s*/gi,
  /\bkeep it up!\s*/gi,
  /\bone step at a time[.!?]?\s*/gi,
  /\bi understand that feeling[^.!?\n]*[.!?]?\s*/gi,
  /\bthis can make it seem like you'?re alone, even when you'?re not[^.!?\n]*[.!?]?\s*/gi,
  /^(?:great|good) to see you here[,.]?\s*/i,
  /\bremember, expressing your truth[^.!?\n]*[.!?]?\s*/gi,
  /\beach time you practice this[^.!?\n]*[.!?]?\s*/gi,
  /\byou'?ve already taken steps by expressing your truth to yourself and to someone you trust[^.!?\n]*[.!?]?\s*/gi,
  /\beach small step is a victory[^.!?\n]*[.!?]?\s*/gi,
  /\bchallenging the (?:old )?belief that you need to be perfect[^.!?\n]*[.!?]?\s*/gi,
  /\bsmall steps you'?re taking are still valuable[^.!?\n]*[.!?]?\s*/gi,
  /\bit sounds like you'?re feeling stuck[^.!?\n]*[.!?]?\s*/gi,
  /\byou'?re staying financially invisible[^.!?\n]*[.!?]?\s*/gi,
  /\bit sounds like you'?re staying financially invisible[^.!?\n]*[.!?]?\s*/gi,
  /\bit sounds like the pattern of[^.!?\n]*[.!?]?\s*/gi,
  /\bthis pattern tends to keep you[^.!?\n]*[.!?]?\s*/gi,
  /\bremember, the strategy to counter[^.!?\n]*[.!?]?\s*/gi,
  /\blet'?s revisit the core strategy[^.!?\n]*[.!?]?\s*/gi,
  /\bthis helps build the muscle of[^.!?\n]*[.!?]?\s*/gi,
  /\bthe resistance often shows up as[^.!?\n]*[.!?]?\s*/gi,
  /\bfor example, you could practice stating your rate[^.!?\n]*[.!?]?\s*/gi,
];

const INLINE_REP_WORKSHEET =
  /(?:here'?s what to do|your next step is|next step is the)[\s\S]*?(?=\n\n[A-Z]|$)/gi;

const unwrapCoachAssistantMessage = (raw) => {
  if (raw == null) return raw;
  if (typeof raw === "object" && raw.assistant_message)
    return String(raw.assistant_message);
  const s = String(raw).trim();
  if (!s.startsWith("{") || !s.includes('"assistant_message"')) return s;
  try {
    const parsed = JSON.parse(s);
    return typeof parsed.assistant_message === "string"
      ? parsed.assistant_message
      : s;
  } catch {
    return s;
  }
};

const stripInlineRepWorksheet = (text, greenRep = null) => {
  if (!text || !greenRep?.name) return text;
  let out = String(text);
  out = out.replace(INLINE_REP_WORKSHEET, "").trim();
  out = out.replace(/^\d+\.\s+.+$/gm, (line) => {
    return /notes app|voice memo|read it|save it|mirror|honest sentence/i.test(
      line,
    )
      ? ""
      : line;
  });
  return out.replace(/\n{3,}/g, "\n\n").trim();
};

const sanitizeCoachUserFacingText = (
  text,
  { stripGreetingName = null, noTrustedPerson = false, greenRep = null } = {},
) => {
  let out = unwrapCoachAssistantMessage(text);
  if (!out || typeof out !== "string") return out;
  out = out.replace(REPORT_HEADER_PATTERN, "").trim();
  out = out.replace(COACH_TEMPLATE_LABEL_BLOCK, "").trim();
  const patterns = [...HOLLOW_COACH_PHRASES];
  if (noTrustedPerson) {
    patterns.push(/\bsomeone you trust\b[^.!?\n]*[.!?]?\s*/gi);
    patterns.push(
      /\bexpressing your truth to yourself and to someone\b[^.!?\n]*[.!?]?\s*/gi,
    );
  }
  for (const pattern of patterns) {
    out = out.replace(pattern, "").trim();
  }
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
      const greeting = new RegExp(
        `^\\s*hey\\s+${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*[,!.—-]*\\s*`,
        "i",
      );
      out = out.replace(greeting, "").trim();
    }
  }
  out = out.replace(/\n{3,}/g, "\n\n").trim();
  out = stripInlineRepWorksheet(out, greenRep);
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
const { buildContinuityOpeningQuestion } = require("./sessionContinuity");
const { buildFirstSessionOpening, isFirstCoachSession } = require("../signals/firstSession");
const { isSetbackOrGapReport } = require("../signals/setback");
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

  const isFirstCoachSessionFlag = isFirstCoachSession(continuity, coachContext, memory);

  const lines = [];

  if (isFirstCoachSessionFlag) {
    return buildFirstSessionOpening({
      firstName: name,
      map,
      activeGoalContext,
    });
  }

  lines.push(`Hey ${name}.`);
  lines.push("");
  lines.push(`We're still on ${goalPhrase}.`);

  const repName =
    continuity?.last_green_rep?.name ||
    coachContext?.last_green_rep_assigned?.name ||
    null;
  if (repName) {
    lines.push(`Last rep in play: ${repName}.`);
  }

  if (continuity?.recent_proof?.length) {
    const positiveOnly = continuity.recent_proof.filter((p) => !isSetbackOrGapReport(p));
    if (positiveOnly.length) {
      lines.push(`Recent proof: ${positiveOnly[0]}.`);
    }
  } else if (continuity?.recent_setback?.length) {
    lines.push(`Last named gap: ${continuity.recent_setback[0]}.`);
  } else if (continuity?.session_summary) {
    const summary = String(continuity.session_summary).trim();
    lines.push(
      summary.toLowerCase().startsWith("last session")
        ? summary.charAt(0).toUpperCase() + summary.slice(1)
        : `Last time: ${summary.charAt(0).toLowerCase() + summary.slice(1)}`,
    );
  }

  lines.push("");
  const followUp =
    buildContinuityOpeningQuestion(continuity) ||
    buildNaturalOpeningQuestion(continuity, { hadRep: Boolean(repName) });
  lines.push(followUp);

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
  if (
    /\b(stuck|fear|avoid|hard|difficult|resist|anxious|generated|earned|completed|finished|client|outreach|reached)\b/i.test(
      t,
    )
  ) {
    return true;
  }
  return false;
};

/** @deprecated use resolveCoachingTransition from stage1CoachTransition */
const inferCoachingPhase = (messages, userMessage) => {
  const { inferCoachingPhase: infer } = require("../flows/transition");
  return infer(messages, userMessage);
};

module.exports = {
  sanitizeCoachUserFacingText,
  unwrapCoachAssistantMessage,
  stripInlineRepWorksheet,
  humanizePattern,
  formatGoalPhrase,
  buildHumanCoachOpening,
  buildNaturalOpeningQuestion,
  buildHumanAcknowledgment,
  buildAdaptiveFollowUpQuestion,
  buildResistanceEvolutionNarrative,
  mentionsGreenRep,
  isSubstantiveCheckInAnswer,
  inferCoachingPhase,
};
