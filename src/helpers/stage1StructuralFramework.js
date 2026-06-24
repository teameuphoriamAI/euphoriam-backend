/**
 * Nathan 3-step framework for daily coach: MAP → DISRUPT → INSTALL.
 * MAP is complete before coach unlocks; daily coach alternates DISRUPT / INSTALL.
 */

const { resolveFailureStrategyForMap, resolveSuccessStrategyForMap } = require("./stage1MapStructure");
const { detectUncertaintySignal } = require("../stage1/coach/signals/investigation");

const STEPS = Object.freeze({
  MAP: "map",
  DISRUPT: "disrupt",
  INSTALL: "install",
});

const pickFailureLabel = (map) => {
  const fs = resolveFailureStrategyForMap(map);
  if (typeof fs === "string") return fs.trim();
  return (fs?.rule || fs?.title || map?.protector_rule || "").trim() || null;
};

const pickSuccessLabel = (map) => {
  const ss = resolveSuccessStrategyForMap(map);
  if (typeof ss === "string") return ss.trim();
  return (ss?.behaviour || ss?.behavior || ss?.title || map?.flip_rule || "").trim() || null;
};

/**
 * Awareness bundle — the "unfair advantage" Nathan describes.
 */
const buildStructuralAwareness = (map) => {
  if (!map?.map_resistance_complete) return null;

  return {
    goal: map.goal_title || null,
    desired_outcome: map.desired_outcome || null,
    contradiction: map.contradiction_statement || null,
    vortex_signature: map.signature_id || null,
    failure_strategy: pickFailureLabel(map),
    protector_rule: map.protector_rule || null,
    core_fear: map.core_fear || null,
    avoidance_behaviours: map.top_3_avoidance_behaviours || [],
    flip_belief: map.flip_belief || null,
    flip_rule: map.flip_rule || null,
    success_strategy: pickSuccessLabel(map),
    unfair_advantage_summary:
      "Member knows goal PLUS why/how/when they stop, what belief creates it, and what action interrupts it.",
  };
};

const isInstallMoment = ({ proofCycleFlow, transition, memoryCtx }) => {
  if (proofCycleFlow?.proof_integration_mode) return true;
  if (proofCycleFlow?.assign_green_rep) return true;
  if (transition?.coaching_brief?.assign_green_rep) return true;
  const phase = memoryCtx?.last_ended_session?.state || null;
  if (phase === "flip_install" || phase === "flip_leverage") return true;
  return false;
};

const isDisruptMoment = ({ userMessage, transition, memoryCtx, investigationFlow = null }) => {
  if (investigationFlow?.active) return false;
  if (detectUncertaintySignal(userMessage)) return false;
  const msg = String(userMessage || "");
  const avoidance =
    /\b(slept|avoid|stuck|didn't|did not|nothing|lazy|procrastinat|no progress|off track|same thing|you told me)\b/i.test(
      msg,
    );
  const phase = transition?.coaching_phase;
  if (phase === "execute" || phase === "directive") return true;
  if (avoidance) return true;
  if (memoryCtx?.recent_resistance_patterns?.length >= 1 && avoidance) return true;
  if (transition?.conversation_signals?.reports_stagnation) return true;
  if (transition?.conversation_signals?.coaching_repeat_complaint) return true;
  return false;
};

/**
 * @returns {{ step: 'map'|'disrupt'|'install', label: string, coach_directive: string, example_line: string|null }}
 */
const resolveStructuralStep = ({
  map,
  memoryCtx = {},
  userMessage = "",
  proofCycleFlow = null,
  transition = null,
  investigationFlow = null,
}) => {
  if (!map?.map_resistance_complete) {
    return {
      step: STEPS.MAP,
      label: "Map / Diagnose",
      coach_directive:
        "Member has not completed Map Resistance — do not coach daily reps; direct to finish mapping first.",
      example_line: null,
    };
  }

  const awareness = buildStructuralAwareness(map);
  const failure = awareness.failure_strategy || "your failure strategy";
  const protector = awareness.protector_rule || "your protector rule";
  const flip = awareness.flip_belief || awareness.success_strategy || "the flip";

  if (detectUncertaintySignal(userMessage) || investigationFlow?.active) {
    return {
      step: STEPS.DISRUPT,
      label: "Investigate bottleneck",
      coach_directive:
        "INVESTIGATION — narrow what's blocked before naming the map pattern. " +
        "One discovery question only. No failure-strategy lecture.",
      example_line: null,
      awareness,
    };
  }

  if (isInstallMoment({ proofCycleFlow, transition, memoryCtx })) {
    return {
      step: STEPS.INSTALL,
      label: "Install the Flip",
      coach_directive:
        `INSTALL phase — assign ONE green rep that physically practices the flip: "${String(flip).slice(0, 120)}". ` +
        "Rep must advance the active milestone — real-world behavior, not mirror/voice/generic visibility exercise. Proof logs matter.",
      example_line: `Today's install: one action that proves "${String(flip).slice(0, 80)}" is becoming real — not just understood.`,
      awareness,
    };
  }

  if (isDisruptMoment({ userMessage, transition, memoryCtx, investigationFlow })) {
    return {
      step: STEPS.DISRUPT,
      label: "Disrupt",
      coach_directive:
        `DISRUPT phase — name the pattern from the map (failure: ${failure}). ` +
        `Reference protector: ${String(protector).slice(0, 100)}. ` +
        "Interrupt the loop with one powerful question — not generic encouragement.",
      example_line: `You're running ${failure} again — that matches ${String(protector).slice(0, 80)}. What one move breaks that pattern today?`,
      awareness,
    };
  }

  return {
    step: STEPS.DISRUPT,
    label: "Disrupt",
    coach_directive:
      "Default DISRUPT — check what changed since last session; name resistance from map if it shows up.",
    example_line: null,
    awareness,
  };
};

const buildStructuralCoachBlock = (opts) => {
  const resolved = resolveStructuralStep(opts);
  return {
    framework: "map_disrupt_install",
    current_step: resolved.step,
    step_label: resolved.label,
    coach_directive: resolved.coach_directive,
    example_coaching_line: resolved.example_line,
    structural_awareness: resolved.awareness || buildStructuralAwareness(opts.map),
  };
};

module.exports = {
  STEPS,
  buildStructuralAwareness,
  resolveStructuralStep,
  buildStructuralCoachBlock,
};
