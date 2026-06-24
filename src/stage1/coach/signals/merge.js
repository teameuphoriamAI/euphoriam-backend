/**
 * Merge flow-level signals from proof cycle, investigation, activation, structural, progression
 * into conversation_signals for Coach Brain.
 */

const mergeCoachingContext = (base = {}, patch = {}) => {
  if (!patch || typeof patch !== "object") return base;
  return { ...base, ...patch };
};

const pickDirective = (current, incoming) => {
  if (!incoming) return current || null;
  if (!current) return incoming;

  const priority = (directive) => {
    if (!directive) return 0;
    if (directive.includes("SIGNAL:user_showing_hope_depletion")) return 100;
    if (directive.includes("SIGNAL:execution_sustainability_issue")) return 90;
    if (directive.includes("SIGNAL:clarity_saturation")) return 85;
    if (directive.includes("SIGNAL:execution_confirmed")) return 80;
    if (directive.includes("SIGNAL:self_generated_clarity")) return 75;
    if (directive.includes("SIGNAL:assistant_advice_loop")) return 70;
    if (directive.includes("SIGNAL:proof_investigation")) return 30;
    if (directive.includes("SIGNAL:investigation_active")) return 25;
    if (directive.startsWith("SIGNAL:")) return 50;
    return 40;
  };

  return priority(incoming) >= priority(current) ? incoming : current;
};

const hasClarityRouting = (signals = {}) =>
  Boolean(
    signals.execution_sustainability_issue ||
      signals.clarity_saturation ||
      signals.self_generated_clarity ||
      signals.execution_confirmed ||
      signals.user_showing_hope_depletion ||
      signals.stop_discovery ||
      signals.coaching_context?.execution_clarity_established ||
      signals.coaching_context?.insufficient_data_for_analysis,
  );

const shouldBlockDiscoveryFlow = (flow, clarityLocked) => {
  if (!clarityLocked || !flow) return false;
  if (flow.conversation_signals?.investigation_active) return true;
  if (flow.conversation_signals?.user_expressed_uncertainty) return true;
  if (flow.structural_coaching_flow?.proof_investigation?.active) return true;
  if (flow.coaching_directive?.includes("SIGNAL:proof_investigation")) return true;
  if (flow.coaching_directive?.includes("SIGNAL:investigation_active")) return true;
  return false;
};

const mergeFlowSignals = (baseSignals = {}, flows = {}) => {
  const merged = { ...(baseSignals || {}) };
  let coaching_context = { ...(merged.coaching_context || {}) };
  let coaching_directive = merged.coaching_directive || null;
  const clarityLocked = hasClarityRouting(merged);

  const ordered = [
    flows.structuralFlow,
    flows.investigationFlow,
    flows.activationMomentFlow,
    flows.proofProgressionFlow,
    flows.proofCycleFlow,
    flows.firstSessionFlow,
  ].filter(Boolean);

  for (const flow of ordered) {
    if (shouldBlockDiscoveryFlow(flow, clarityLocked)) {
      continue;
    }
    if (flow.conversation_signals && typeof flow.conversation_signals === "object") {
      const patch = { ...flow.conversation_signals };
      if (clarityLocked) {
        delete patch.investigation_active;
        delete patch.user_expressed_uncertainty;
        delete patch.proof_diagnosis_update;
      }
      Object.assign(merged, patch);
    }
    coaching_context = mergeCoachingContext(coaching_context, flow.coaching_context);
    if (!shouldBlockDiscoveryFlow(flow, clarityLocked)) {
      coaching_directive = pickDirective(coaching_directive, flow.coaching_directive);
    }
  }

  if (clarityLocked) {
    merged.stop_discovery = true;
    merged.investigation_active = false;
    merged.user_expressed_uncertainty = false;
  }

  if (flows.proofProgressionFlow?.green_rep && !merged.suggested_green_rep) {
    merged.suggested_green_rep = flows.proofProgressionFlow.green_rep;
    merged.assign_green_rep = true;
    merged.assign_new_rep = true;
  }
  if (flows.activationMomentFlow?.green_rep && flows.activationMomentFlow?.assign_green_rep) {
    merged.suggested_green_rep = flows.activationMomentFlow.green_rep;
    merged.assign_green_rep = true;
    merged.assign_new_rep = true;
  }
  if (flows.structuralFlow?.suggested_milestone_rep && !merged.suggested_green_rep) {
    merged.suggested_milestone_rep = flows.structuralFlow.suggested_milestone_rep;
  }
  if (flows.proofCycleFlow?.block_green_rep) {
    merged.assign_green_rep = false;
    merged.assign_new_rep = false;
    merged.block_clarity_rep = true;
  }
  if (flows.activationMomentFlow?.block_green_rep) {
    merged.assign_green_rep = false;
    merged.assign_new_rep = false;
    merged.block_clarity_rep = true;
  }
  if (flows.structuralFlow?.block_green_rep) {
    merged.assign_green_rep = false;
    merged.assign_new_rep = false;
  }

  merged.coaching_context = Object.keys(coaching_context).length ? coaching_context : null;
  merged.coaching_directive = coaching_directive;

  return merged;
};

module.exports = { mergeFlowSignals };
