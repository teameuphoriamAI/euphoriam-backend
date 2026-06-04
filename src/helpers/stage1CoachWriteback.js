/**
 * Derive coaching-memory writeback from deterministic progress / wound-flip integration.
 * Does not modify map-level 25 Q&A fields.
 */

const deriveCoachingWritebackFromProgress = (progressIntegration, extraHints = {}) => {
  const hints =
    extraHints && typeof extraHints === "object" ? { ...extraHints } : {};
  if (!progressIntegration || typeof progressIntegration !== "object") return hints;

  const answers = progressIntegration.answers || {};

  if (answers.avoidance_rule) {
    hints.current_failure_strategy = {
      rule: String(answers.avoidance_rule).slice(0, 240),
    };
  } else if (answers.active_core_wound) {
    hints.current_failure_strategy = {
      rule: `Protecting wound: ${String(answers.active_core_wound).slice(0, 120)}`,
    };
  } else if (answers.devaluation_note) {
    hints.current_failure_strategy = {
      rule: String(answers.devaluation_note).slice(0, 200),
    };
  }

  if (answers.leverage_note) {
    hints.current_success_strategy = {
      behaviour: String(answers.leverage_note).slice(0, 240),
    };
  } else if (answers.meaning_reflection) {
    hints.current_success_strategy = {
      behaviour: String(answers.meaning_reflection).slice(0, 200),
    };
  }

  if (answers.reflect_note) {
    hints.coaching_insights = hints.coaching_insights || answers.reflect_note;
  }

  if (progressIntegration.proof_logged && answers.acknowledge_note) {
    hints.proof_note = String(answers.acknowledge_note).slice(0, 280);
  }

  if (answers.regression_note) {
    hints.current_resistance = String(answers.regression_note).slice(0, 200);
  }

  return hints;
};

module.exports = {
  deriveCoachingWritebackFromProgress,
};
