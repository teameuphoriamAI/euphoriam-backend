const { normalizeSuccessStrategy } = require("./stage1SuccessStrategy");
const { enrichProgressMetricsFromMap } = require("./stage1ProgressMetrics");

/** Failure strategy block for home/coach from a domain map row. */
const resolveFailureStrategyForMap = (map) => {
  if (!map || typeof map !== "object") return null;

  const fs = map.failure_strategy;
  if (fs && typeof fs === "object") {
    const rule = fs.rule || fs.protector_rule;
    const behaviours = Array.isArray(fs.behaviours) ? fs.behaviours.filter(Boolean) : [];
    if (rule?.trim() || behaviours.length) {
      return {
        title: fs.title || "Failure strategy",
        rule: rule ? String(rule).trim() : "",
        behaviours,
      };
    }
  }
  if (typeof fs === "string" && fs.trim()) {
    return { title: "Failure strategy", rule: fs.trim(), behaviours: [] };
  }

  const avoid = Array.isArray(map.top_3_avoidance_behaviours)
    ? map.top_3_avoidance_behaviours.filter((x) => x != null && String(x).trim())
    : [];
  const rule = map.protector_rule?.trim() || null;
  if (rule || avoid.length) {
    return {
      title: "Failure strategy",
      rule: rule || avoid[0] || "",
      behaviours: avoid.slice(0, 3),
    };
  }

  // Maps finalized with loose structure fields only (orbit, lack, avoid type)
  if (map.map_resistance_complete) {
    const orbit = map.orbit_pattern?.trim() || null;
    const lack = map.lack_channel?.trim() || null;
    const avoidType = map.avoid_type?.trim() || null;
    const eo = map.EO?.trim() || null;
    const parts = [orbit, lack, avoidType, eo].filter(Boolean);
    if (parts.length) {
      return {
        title: "Failure strategy",
        rule: parts.join(" · "),
        behaviours: orbit ? [orbit, ...avoid].slice(0, 3) : avoid.slice(0, 3),
      };
    }
  }

  return null;
};

/** Success strategy block when extraction saved only goal/rep fields. */
const resolveSuccessStrategyForMap = (map) => {
  const normalized = normalizeSuccessStrategy(map);
  if (normalized) return normalized;

  if (!map?.map_resistance_complete) return null;

  const rep = map.daily_rep;
  const repName =
    (rep && typeof rep === "object" && rep.name?.trim()) ||
    (typeof rep === "string" && rep.trim()) ||
    map.today_visible_action?.trim() ||
    null;

  const behaviour = map.opposite_behaviour?.trim() || map.opposite_behavior?.trim() || repName;
  const belief = map.opposite_belief?.trim() || map.desired_outcome?.trim() || null;
  const successRule =
    map.success_rule?.trim() ||
    map.proof_of_success?.trim() ||
    map.win_condition?.trim() ||
    (rep && typeof rep === "object" ? rep.win_condition?.trim() : null) ||
    null;

  if (behaviour || belief || successRule) {
    return {
      title: "Success strategy",
      behaviour: behaviour || "",
      belief: belief || undefined,
      success_rule: successRule || undefined,
      behaviours: [],
    };
  }

  return null;
};

/** Fill daily_rep.win_condition from proof_of_success when missing. */
const resolveDailyRepForMap = (map) => {
  const visible = map.today_visible_action?.trim() || null;
  let rep = map.daily_rep;
  if (!rep && visible) {
    rep = { name: visible, steps: [], win_condition: map.proof_of_success || map.win_condition || null };
  }
  if (rep && typeof rep === "object") {
    const win =
      rep.win_condition?.trim() ||
      map.win_condition?.trim() ||
      map.proof_of_success?.trim() ||
      null;
    if (win && !rep.win_condition) {
      rep = { ...rep, win_condition: win };
    }
  }
  return rep;
};

const structureHasMinimalContent = (structure) => {
  if (!structure || typeof structure !== "object") return false;
  if (resolveFailureStrategyForMap(structure)) return true;
  if (normalizeSuccessStrategy(structure)) return true;
  const rep = structure.daily_rep;
  if (rep && typeof rep === "object" && rep.name?.trim()) return true;
  if (typeof rep === "string" && rep.trim()) return true;
  if (structure.signature_id || structure.EO || structure.orbit_pattern) return true;
  return false;
};

/** Last-resort extraction when AI returns sparse JSON (still better than empty dashboard). */
const heuristicStructureFromTranscript = (transcript = [], activeGoalContext = {}) => {
  const userLines = (transcript || [])
    .filter((m) => m && m.role === "user")
    .map((m) => String(m.content || "").trim())
    .filter((c) => c.length >= 8);

  const avoid = userLines.slice(-3);
  const primaryRule = avoid[0] || null;
  const today =
    activeGoalContext.today_visible_action?.trim() ||
    activeGoalContext.todayVisibleAction?.trim() ||
    "";

  const structure = {
    top_3_avoidance_behaviours: avoid,
    protector_rule: primaryRule,
    map_resistance_complete: true,
  };

  if (primaryRule) {
    structure.failure_strategy = {
      title: "Failure strategy",
      rule: primaryRule,
      behaviours: avoid,
    };
  }

  const lastUser = userLines[userLines.length - 1];
  const success = normalizeSuccessStrategy({
    opposite_behaviour: lastUser,
    opposite_belief: activeGoalContext.desired_outcome || activeGoalContext.desiredOutcome,
  });
  if (success) structure.success_strategy = success;

  if (today) {
    structure.daily_rep = {
      name: today,
      steps: [],
      win_condition: activeGoalContext.win_condition || null,
    };
    structure.win_condition = activeGoalContext.win_condition || null;
  }

  structure.progress_metrics = enrichProgressMetricsFromMap(structure, {});
  return structure;
};

/** Attach resolved strategy/rep blocks for API clients (raw DB may have null objects). */
const enrichMapForClient = (map) => {
  if (!map || typeof map !== "object") return map;
  const failure_strategy = resolveFailureStrategyForMap(map);
  const success_strategy = resolveSuccessStrategyForMap(map);
  const daily_rep = resolveDailyRepForMap(map);
  return {
    ...map,
    failure_strategy: failure_strategy || map.failure_strategy,
    success_strategy: success_strategy || map.success_strategy,
    daily_rep: daily_rep || map.daily_rep,
    win_condition:
      (daily_rep && typeof daily_rep === "object" ? daily_rep.win_condition : null) ||
      map.win_condition ||
      map.proof_of_success ||
      null,
  };
};

module.exports = {
  resolveFailureStrategyForMap,
  resolveSuccessStrategyForMap,
  resolveDailyRepForMap,
  enrichMapForClient,
  structureHasMinimalContent,
  heuristicStructureFromTranscript,
};
