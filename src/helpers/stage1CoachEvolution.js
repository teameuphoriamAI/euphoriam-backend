/**
 * Coaching evolution — refine strategies and avoid cross-session diagnosis repetition.
 */

const { resolveFailureStrategyForMap, resolveSuccessStrategyForMap } = require("./stage1MapStructure");
const { bottleneckLabel } = require("./stage1CoachBottleneck");

const diagnosisFingerprint = (text) =>
  String(text || "")
    .toLowerCase()
    .replace(/[^\w\s]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 100);

const loadCoachingJourney = (memoryCtx = null, map = null, openSession = null) => {
  const sessions = memoryCtx?.coaching_sessions || [];
  const lastSession = sessions[sessions.length - 1] || null;
  const repHistory = memoryCtx?.green_rep_history || [];

  return {
    active_bottleneck:
      openSession?.structural_coaching_flow?.current_bottleneck ||
      lastSession?.active_bottleneck ||
      null,
    progression_stage:
      openSession?.structural_coaching_flow?.progression_stage ||
      lastSession?.progression_stage ||
      null,
    evolved_failure: lastSession?.current_failure_strategy || null,
    evolved_success: lastSession?.current_success_strategy || null,
    current_resistance: lastSession?.current_resistance || null,
    last_green_rep: lastSession?.green_rep_assigned?.name || repHistory[repHistory.length - 1]?.name || null,
    reps_used: repHistory.map((r) => r?.name).filter(Boolean).slice(-8),
    diagnosis_history: sessions
      .map((s) => s.session_summary || s.current_resistance)
      .filter(Boolean)
      .slice(-5)
      .map(diagnosisFingerprint),
    proof_count: (memoryCtx?.recent_proofs || memoryCtx?.proof_logs || []).length,
  };
};

const wouldRepeatCrossSessionDiagnosis = (proposedText, journey = null) => {
  const fp = diagnosisFingerprint(proposedText);
  if (!fp || fp.length < 12) return false;
  return (journey?.diagnosis_history || []).some(
    (h) => h === fp || (h.length > 20 && fp.includes(h)) || (fp.length > 20 && h.includes(fp)),
  );
};

const evolveStrategiesFromProof = ({
  userMessage = "",
  map = null,
  journey = null,
  bottleneck = null,
  proofAction = null,
}) => {
  const hints = {};
  const t = String(userMessage || proofAction || "").trim();
  if (!t) return hints;

  const failureBase =
    journey?.evolved_failure?.rule ||
    resolveFailureStrategyForMap(map)?.rule ||
    map?.protector_rule ||
    null;
  const successBase =
    journey?.evolved_success?.behaviour ||
    resolveSuccessStrategyForMap(map)?.behaviour ||
    map?.success_strategy?.behaviour ||
    null;

  hints.progress_note = t.slice(0, 280);
  hints.coaching_insights = `Proof landed: ${t.slice(0, 160)}`;

  if (bottleneck?.type) {
    hints.active_bottleneck = bottleneck;
  }

  if (/\b(sent|messaged|reached|contacted|listed|identified|built|created|posted|booked)\b/i.test(t)) {
    hints.current_resistance =
      journey?.current_resistance && !/\bweakened\b/i.test(journey.current_resistance)
        ? `${journey.current_resistance} — interrupted by proof`
        : `Prior block interrupted: ${t.slice(0, 100)}`;
    if (failureBase) {
      hints.current_failure_strategy = {
        rule: `${failureBase} — less active after proof; watch for snapback`,
      };
    }
    if (successBase) {
      hints.current_success_strategy = {
        behaviour: `${successBase} — evidenced today`,
      };
    }
  }

  return hints;
};

const evolveStrategiesFromBottleneck = ({ bottleneck, map, journey = null }) => {
  const hints = { active_bottleneck: bottleneck };
  if (!bottleneck?.type) return hints;

  const failureBase =
    journey?.evolved_failure?.rule ||
    resolveFailureStrategyForMap(map)?.rule ||
    map?.protector_rule;

  if (bottleneck.type === "strategy_gap" || bottleneck.type === "knowledge_gap") {
    hints.current_resistance = `Active bottleneck: ${bottleneckLabel(bottleneck.type)} — not primary avoidance`;
    hints.current_failure_strategy = {
      rule: failureBase
        ? `${failureBase} — secondary; primary block is ${bottleneckLabel(bottleneck.type)}`
        : `Primary block is ${bottleneckLabel(bottleneck.type)}`,
    };
  } else if (bottleneck.type === "resistance_gap") {
    hints.current_resistance = bottleneck.evidence || "Resistance running the day";
    if (failureBase) hints.current_failure_strategy = { rule: failureBase };
  }

  return hints;
};

const buildJourneyContextDirective = (journey = null, bottleneck = null) => {
  const parts = [];
  if (journey?.evolved_failure?.rule) {
    parts.push(`Evolved failure strategy: ${journey.evolved_failure.rule.slice(0, 120)}`);
  }
  if (journey?.evolved_success?.behaviour) {
    parts.push(`Evolved success strategy: ${journey.evolved_success.behaviour.slice(0, 120)}`);
  }
  if (bottleneck?.type) {
    parts.push(`Active bottleneck: ${bottleneckLabel(bottleneck.type)}`);
  }
  if (journey?.last_green_rep) {
    parts.push(`Last rep: "${journey.last_green_rep}" — do NOT repeat unless proof shows progression needed`);
  }
  if (journey?.reps_used?.length >= 2) {
    parts.push(`Reps already used: ${journey.reps_used.slice(-3).join(", ")}`);
  }
  if (!parts.length) return "";
  return `COACHING JOURNEY: ${parts.join(". ")}. Evolve — do not reset to map defaults.`;
};

module.exports = {
  loadCoachingJourney,
  wouldRepeatCrossSessionDiagnosis,
  evolveStrategiesFromProof,
  evolveStrategiesFromBottleneck,
  buildJourneyContextDirective,
  diagnosisFingerprint,
};
