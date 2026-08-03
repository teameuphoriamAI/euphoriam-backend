/**
 * Stage 1 Daily Coach — public module surface.
 *
 * signals/   — detection only (flags + coaching_context)
 * flows/     — turn orchestration (proof cycle, transition, structural)
 * context/   — LLM payload (memory, open, natural language)
 * persistence/ — sessions, vector memory, writebacks
 * utils/     — progress, evolution, green rep, milestone rep
 * legacy/    — older check-in paths (audit for removal)
 */

module.exports = {
  // signals
  ...require("./signals/conversation"),
  buildClarityExecutionSignals: require("./signals/clarity").buildClarityExecutionSignals,
  buildClarityExecutionFlow: require("./signals/clarity").buildClarityExecutionFlow,
  buildEvidenceContradictionSignals: require("./signals/evidence").buildEvidenceContradictionSignals,
  buildEvidenceContradictionFlow: require("./signals/evidence").buildEvidenceContradictionFlow,
  resolveActivationMomentFlow: require("./signals/activation").resolveActivationMomentFlow,
  resolveInvestigationTurnFlow: require("./signals/investigation").resolveInvestigationTurnFlow,
  resolveFirstSessionTurnFlow: require("./signals/firstSession").resolveFirstSessionTurnFlow,
  resolveProofProgressionFlow: require("./signals/bottleneckProgression").resolveProofProgressionFlow,
  mergeFlowSignals: require("./signals/merge").mergeFlowSignals,
  formatOutcomeDirective: require("./signals/directive").formatOutcomeDirective,

  // flows
  resolveCoachingTransition: require("./flows/transition").resolveCoachingTransition,
  resolveCoachTurnMode: require("./flows/turnMode").resolveCoachTurnMode,
  applyCoachTurnMode: require("./flows/turnMode").applyCoachTurnMode,
  resolveStructuralCoachingFlow: require("./flows/structural").resolveStructuralCoachingFlow,
  resolveProofCycleFlow: require("./flows/proofCycle").resolveProofCycleFlow,
  onGreenRepAssigned: require("./flows/proofCycle").onGreenRepAssigned,
  resolveProofProgressionFlowAsync: require("./flows/proofDiagnosis").resolveProofProgressionFlowAsync,

  // context
  buildCoachMemoryContext: require("./context/memory").buildCoachMemoryContext,
  buildCoachUserContext: require("./context/userContext").buildCoachUserContext,
  gatherCoachOpenPayload: require("./context/open").gatherCoachOpenPayload,
  sanitizeCoachUserFacingText: require("./context/naturalLanguage").sanitizeCoachUserFacingText,
  unwrapCoachAssistantMessage: require("./context/naturalLanguage").unwrapCoachAssistantMessage,

  // persistence
  recordCoachCheckin: require("./persistence/history").recordCoachCheckin,
  indexCoachSession: require("./persistence/vectorMemory").indexCoachSession,

  // utils
  detectProgressSignals: require("./utils/progress").detectProgressSignals,
  maybeAutoLogProof: require("./utils/progress").maybeAutoLogProof,
  sanitizeCoachGreenRep: require("./utils/progress").sanitizeCoachGreenRep,
  deriveEvolutionWritebackFromTurn: require("./utils/milestoneRep").deriveEvolutionWritebackFromTurn,
};
