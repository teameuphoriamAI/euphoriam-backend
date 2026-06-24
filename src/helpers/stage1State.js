const {
  DOMAINS,
  DOMAIN_LABELS,
  normalizeDomain,
} = require("../constants/domains");
const { getTier } = require("./membershipDomains");

const ONBOARDING_STATUS = Object.freeze({
  NONE: "none",
  GOALS_DRAFT: "goals_draft",
  GOALS_COMPLETE: "goals_complete",
  RESISTANCE_IN_PROGRESS: "resistance_in_progress",
  ACTIVE: "active",
});

const DOMAIN_MAP_STATUS = Object.freeze({
  DRAFT: "draft",
  STORED: "stored",
  ACTIVE: "active",
});

const DEFAULT_PROGRESS_METRICS = () => ({
  rep_completion_rate: 0,
  recovery_speed: null,
  avoidance_caught_count: 0,
  milestones_completed: 0,
});

const defaultDomainMap = (domain) => ({
  domain,
  status: DOMAIN_MAP_STATUS.DRAFT,
  goal_title: null,
  desired_outcome: null,
  target_date: null,
  proof_of_success: null,
  milestones: {
    day_7: null,
    day_30: null,
    day_90: null,
  },
  today_visible_action: null,
  notes: null,
  signature_id: null,
  EO: null,
  lack_channel: null,
  avoid_type: null,
  orbit_pattern: null,
  protector_rule: null,
  structure_type: null,
  contradiction_statement: null,
  structure_takeover_moment: null,
  flip_belief: null,
  flip_rule: null,
  flip_90_day_projection: null,
  contradiction_rate: null,
  failure_strategy: null,
  top_3_avoidance_behaviours: [],
  success_strategy: null,
  daily_rep: null,
  win_condition: null,
  progress_metrics: DEFAULT_PROGRESS_METRICS(),
  goals_complete: false,
  map_resistance_complete: false,
  updatedAt: new Date().toISOString(),
});

const emptyStage1State = () => ({
  version: 1,
  primary_domain: null,
  active_domains: [],
  map_resistance_in_progress: false,
  domain_maps: [],
  proof_logs: [],
  /** Product walkthrough — persisted in users.metadata.stage1 (JSONB) */
  walkthrough_completed: false,
  walkthrough_completed_at: null,
});

const getStage1FromUser = (user) => {
  const raw = user?.metadata?.stage1;
  if (!raw || typeof raw !== "object") return emptyStage1State();
  return {
    ...emptyStage1State(),
    ...raw,
    domain_maps: Array.isArray(raw.domain_maps) ? raw.domain_maps : [],
    active_domains: Array.isArray(raw.active_domains) ? raw.active_domains : [],
    proof_logs: Array.isArray(raw.proof_logs) ? raw.proof_logs : [],
  };
};

const isGoalsComplete = (map) => {
  if (!map || typeof map !== "object") return false;
  const m = map.milestones || {};
  return Boolean(
    map.goal_title?.trim() &&
      map.desired_outcome?.trim() &&
      map.target_date?.trim() &&
      map.proof_of_success?.trim() &&
      m.day_7?.trim() &&
      m.day_30?.trim() &&
      m.day_90?.trim() &&
      map.today_visible_action?.trim(),
  );
};

const applyGoalsCompleteFlag = (map) => {
  const complete = isGoalsComplete(map);
  return { ...map, goals_complete: complete };
};

const countStoredMaps = (domainMaps) =>
  domainMaps.filter(
    (m) =>
      m.goal_title?.trim() ||
      m.desired_outcome?.trim() ||
      m.status !== DOMAIN_MAP_STATUS.DRAFT,
  ).length;

const computeOnboardingStatus = (stage1) => {
  const maps = stage1.domain_maps || [];
  if (!maps.length) return ONBOARDING_STATUS.NONE;
  if (stage1.map_resistance_in_progress) return ONBOARDING_STATUS.RESISTANCE_IN_PROGRESS;

  const withResistanceDone = maps.filter((m) => m.map_resistance_complete && m.status === DOMAIN_MAP_STATUS.ACTIVE);
  if (withResistanceDone.length) return ONBOARDING_STATUS.ACTIVE;

  const activeMaps = maps.filter((m) => m.status === DOMAIN_MAP_STATUS.ACTIVE);
  if (activeMaps.some((m) => m.goals_complete)) return ONBOARDING_STATUS.GOALS_COMPLETE;
  if (maps.some((m) => m.goals_complete)) return ONBOARDING_STATUS.GOALS_COMPLETE;
  if (maps.some((m) => m.goal_title || m.desired_outcome)) return ONBOARDING_STATUS.GOALS_DRAFT;
  return ONBOARDING_STATUS.GOALS_DRAFT;
};

const listDomainStatuses = (stage1, tier) => {
  const mapsByDomain = Object.fromEntries(
    (stage1.domain_maps || []).map((m) => [m.domain, m]),
  );
  const activeSet = new Set(stage1.active_domains || []);

  return DOMAINS.map((domain) => {
    const map = mapsByDomain[domain];
    if (!map) {
      return { domain, label: DOMAIN_LABELS[domain], status: "available", map: null };
    }
    if (activeSet.has(domain) || map.status === DOMAIN_MAP_STATUS.ACTIVE) {
      return { domain, status: "active", map };
    }
    if (map.goals_complete || map.status === DOMAIN_MAP_STATUS.STORED) {
      return { domain, status: "stored", map };
    }
    return { domain, status: "draft", map };
  });
};

/** Primary for home: explicit meta → active list → active row → first completed goal */
const resolvePrimaryDomain = (stage1) => {
  if (stage1.primary_domain) return stage1.primary_domain;
  const activeList = stage1.active_domains || [];
  if (activeList.length) return activeList[0];
  const maps = stage1.domain_maps || [];
  const activeRow = maps.find((m) => m.status === DOMAIN_MAP_STATUS.ACTIVE);
  if (activeRow) return activeRow.domain;
  const complete = maps.find((m) => m.goals_complete);
  return complete?.domain || null;
};

const buildHomeDashboard = (stage1) => {
  const { normalizeSuccessStrategy } = require("./stage1SuccessStrategy");
  const primary = resolvePrimaryDomain(stage1);
  if (!primary) return null;

  const map = (stage1.domain_maps || []).find((m) => m.domain === primary);
  if (!map) return null;

  const ready =
    map.map_resistance_complete ||
    map.goals_complete ||
    (map.goal_title?.trim() && map.desired_outcome?.trim());
  if (!ready) return null;

  const { enrichProgressMetricsFromMap } = require("./stage1ProgressMetrics");
  const { applyProofMetricsToMap, listProofLogs } = require("./stage1Proof");
  const proof_logs_all = Array.isArray(stage1.proof_logs) ? stage1.proof_logs : [];

  // Always recompute from proof logs (stored map.progress_metrics can be stale).
  let mapWithMetrics = applyProofMetricsToMap({ ...map }, proof_logs_all);
  let progress_metrics = mapWithMetrics.progress_metrics || map.progress_metrics;

  if (map.map_resistance_complete) {
    progress_metrics = { ...progress_metrics };
    if (!progress_metrics.milestones_completed) progress_metrics.milestones_completed = 1;
    progress_metrics = enrichProgressMetricsFromMap(map, progress_metrics);
  }

  const visibleAction = map.today_visible_action?.trim() || null;
  const {
    resolveFailureStrategyForMap,
    resolveSuccessStrategyForMap,
    resolveDailyRepForMap,
  } = require("./stage1MapStructure");
  const daily_rep = resolveDailyRepForMap(map);
  const {
    buildCoachingHomeOverlay,
    applyCoachingToProgressMetrics,
  } = require("./stage1CoachingHomeOverlay");
  const { buildSuggestedTraining } = require("./stage1TrainingRecommendation");
  const coaching_progress = buildCoachingHomeOverlay(mapWithMetrics, {
    proof_logs: proof_logs_all,
    coach_session_log: stage1.coach_session_log || [],
  });
  progress_metrics = applyCoachingToProgressMetrics(progress_metrics, coaching_progress);

  return {
    active_domain: primary,
    goal_title: map.goal_title,
    desired_outcome: map.desired_outcome,
    target_date: map.target_date,
    proof_of_success: map.proof_of_success,
    milestones: map.milestones,
    today_visible_action: map.today_visible_action,
    failure_strategy_likely_today: resolveFailureStrategyForMap(map),
    success_strategy_to_install:
      resolveSuccessStrategyForMap(map) ||
      normalizeSuccessStrategy(map) ||
      map.success_strategy ||
      null,
    daily_rep,
    win_condition:
      (daily_rep && typeof daily_rep === "object" ? daily_rep.win_condition : null) ||
      map.win_condition ||
      map.proof_of_success ||
      null,
    goals_complete: map.goals_complete,
    map_resistance_complete: map.map_resistance_complete,
    progress_metrics,
    proof_logs: listProofLogs(stage1, { domain: primary, limit: 15 }),
    /** Rep completion % for domain ring (0–100). */
    progress_percent: Math.round(
      (Number(progress_metrics.rep_completion_rate) <= 1
        ? Number(progress_metrics.rep_completion_rate) * 100
        : Number(progress_metrics.rep_completion_rate)) || 0,
    ),
    top_3_avoidance_behaviours: map.top_3_avoidance_behaviours || [],
    orbit_pattern: map.orbit_pattern || null,
    lack_channel: map.lack_channel || null,
    EO: map.EO || null,
    avoid_type: map.avoid_type || null,
    signature_id: map.signature_id || null,
    recovery_speed: map.recovery_speed || progress_metrics.recovery_speed || null,
    coaching_progress,
    suggested_training:
      map.suggested_training ||
      buildSuggestedTraining({
        map,
        domain: primary,
      }),
    initial_diagnostic_snapshot: map.coaching_memory?.initial_diagnostic
      ? {
          captured_at: map.coaching_memory.initial_diagnostic.captured_at,
          failure_strategy: map.coaching_memory.initial_diagnostic.failure_strategy,
          success_strategy: map.coaching_memory.initial_diagnostic.success_strategy,
          daily_rep: map.coaching_memory.initial_diagnostic.daily_rep,
        }
      : null,
  };
};

const mergeDomainMapPatch = (existing, patch) => {
  const base = existing || defaultDomainMap(patch.domain);
  const milestones = {
    ...base.milestones,
    ...(patch.milestones && typeof patch.milestones === "object" ? patch.milestones : {}),
  };

  const merged = applyGoalsCompleteFlag({
    ...base,
    ...patch,
    domain: normalizeDomain(patch.domain) || base.domain,
    milestones,
    top_3_avoidance_behaviours: Array.isArray(patch.top_3_avoidance_behaviours)
      ? patch.top_3_avoidance_behaviours
      : base.top_3_avoidance_behaviours,
    updatedAt: new Date().toISOString(),
  });

  if (merged.goals_complete && merged.status === DOMAIN_MAP_STATUS.DRAFT) {
    merged.status = DOMAIN_MAP_STATUS.STORED;
  }

  return merged;
};

const upsertDomainMap = (stage1, domain, patch) => {
  const d = normalizeDomain(domain);
  const maps = [...(stage1.domain_maps || [])];
  const idx = maps.findIndex((m) => m.domain === d);
  const nextPatch = { ...patch, domain: d };
  if (idx >= 0) {
    maps[idx] = mergeDomainMapPatch(maps[idx], nextPatch);
  } else {
    maps.push(mergeDomainMapPatch(null, nextPatch));
  }
  return { ...stage1, domain_maps: maps };
};

const orderActiveDomains = (primary, activeList) => {
  const list = Array.isArray(activeList) ? activeList.filter(Boolean) : [];
  if (!primary || !list.includes(primary)) return list;
  return [primary, ...list.filter((x) => x !== primary)];
};

const setActiveDomain = (stage1, domain, tierLimits, options = {}) => {
  const setPrimary = options.setPrimary;
  const d = normalizeDomain(domain);
  const maxActive = tierLimits.maxActiveDomains;
  let maps = (stage1.domain_maps || []).map((m) => ({ ...m }));
  const targetIdx = maps.findIndex((m) => m.domain === d);
  if (targetIdx < 0) return { ok: false, error: "Domain map not found. Save goals first." };

  if (!maps[targetIdx].goals_complete) {
    return { ok: false, error: "Complete all goal fields before activating this domain." };
  }

  const activeBefore = maps
    .filter((m) => m.status === DOMAIN_MAP_STATUS.ACTIVE)
    .map((m) => m.domain);
  const alreadyActive = activeBefore.includes(d);

  if (!alreadyActive && activeBefore.length >= maxActive) {
    if (maxActive === 1) {
      maps = maps.map((m) =>
        m.domain === d
          ? { ...m, status: DOMAIN_MAP_STATUS.ACTIVE }
          : m.status === DOMAIN_MAP_STATUS.ACTIVE
            ? { ...m, status: DOMAIN_MAP_STATUS.STORED }
            : m,
      );
    } else {
      return {
        ok: false,
        error: `Your plan allows ${maxActive} active domain(s). Deactivate another domain first.`,
      };
    }
  } else if (!alreadyActive) {
    maps[targetIdx] = { ...maps[targetIdx], status: DOMAIN_MAP_STATUS.ACTIVE };
  }

  const activeList = maps
    .filter((m) => m.status === DOMAIN_MAP_STATUS.ACTIVE)
    .map((m) => m.domain);

  const wasFirstActive = !alreadyActive && activeBefore.length === 0;
  const bronzeSwap = maxActive === 1 && !alreadyActive;

  let nextPrimary = stage1.primary_domain || null;
  if (setPrimary === true) {
    nextPrimary = d;
  } else if (setPrimary === false) {
    if (!nextPrimary || wasFirstActive) nextPrimary = d;
  } else if (wasFirstActive || bronzeSwap || !nextPrimary || alreadyActive) {
    if (wasFirstActive || bronzeSwap || !nextPrimary) nextPrimary = d;
  }

  const active_domains = orderActiveDomains(nextPrimary, activeList);

  return {
    ok: true,
    stage1: {
      ...stage1,
      domain_maps: maps,
      active_domains,
      primary_domain: nextPrimary,
    },
  };
};

/** Set coached focus without changing active slots (domain must already be active). */
const setPrimaryDomain = (stage1, domain) => {
  const d = normalizeDomain(domain);
  if (!d) return { ok: false, error: "Invalid domain" };

  const map = (stage1.domain_maps || []).find((m) => m.domain === d);
  if (!map) return { ok: false, error: "Domain not found. Save goals first." };
  if (map.status !== DOMAIN_MAP_STATUS.ACTIVE) {
    return { ok: false, error: "Activate this domain before setting it as primary." };
  }

  const activeList = (stage1.domain_maps || [])
    .filter((m) => m.status === DOMAIN_MAP_STATUS.ACTIVE)
    .map((m) => m.domain);

  return {
    ok: true,
    stage1: {
      ...stage1,
      primary_domain: d,
      active_domains: orderActiveDomains(d, activeList),
    },
  };
};

/** Move an active domain back to stored (not coached until re-activated). */
const deactivateDomain = (stage1, domain) => {
  const d = normalizeDomain(domain);
  if (!d) return { ok: false, error: "Invalid domain" };

  let maps = (stage1.domain_maps || []).map((m) => ({ ...m }));
  const idx = maps.findIndex((m) => m.domain === d);
  if (idx < 0) return { ok: false, error: "Domain not found." };
  if (maps[idx].status !== DOMAIN_MAP_STATUS.ACTIVE) {
    return { ok: false, error: "This domain is not active." };
  }

  maps[idx] = { ...maps[idx], status: DOMAIN_MAP_STATUS.STORED };

  const activeList = maps
    .filter((m) => m.status === DOMAIN_MAP_STATUS.ACTIVE)
    .map((m) => m.domain);

  let nextPrimary = stage1.primary_domain;
  if (nextPrimary === d) {
    nextPrimary = activeList[0] || null;
  }

  return {
    ok: true,
    stage1: {
      ...stage1,
      domain_maps: maps,
      primary_domain: nextPrimary,
      active_domains: orderActiveDomains(nextPrimary, activeList),
    },
  };
};

const pickAllowedGoalFields = (body) => {
  const allowed = [
    "goal_title",
    "desired_outcome",
    "target_date",
    "proof_of_success",
    "milestones",
    "today_visible_action",
    "notes",
    "begin_map_resistance",
    "map_resistance_in_progress",
  ];
  const patch = {};
  for (const key of allowed) {
    if (body[key] !== undefined) patch[key] = body[key];
  }
  return patch;
};

/** After save: activate completed goal when plan allows; else set primary for home */
const ensurePrimaryAfterGoalSave = (stage1, domain, tierLimits) => {
  const d = normalizeDomain(domain);
  const map = (stage1.domain_maps || []).find((m) => m.domain === d);
  if (!map?.goals_complete) return stage1;

  const inActive = (stage1.active_domains || []).includes(d);
  const activeCount = (stage1.domain_maps || []).filter(
    (m) => m.status === DOMAIN_MAP_STATUS.ACTIVE,
  ).length;

  if (!inActive && activeCount < tierLimits.maxActiveDomains) {
    const result = setActiveDomain(stage1, d, tierLimits);
    if (result.ok) return result.stage1;
  }

  if (!stage1.primary_domain && !inActive) {
    return { ...stage1, primary_domain: d };
  }
  return stage1;
};

module.exports = {
  ONBOARDING_STATUS,
  DOMAIN_MAP_STATUS,
  DEFAULT_PROGRESS_METRICS,
  defaultDomainMap,
  emptyStage1State,
  getStage1FromUser,
  isGoalsComplete,
  applyGoalsCompleteFlag,
  computeOnboardingStatus,
  listDomainStatuses,
  buildHomeDashboard,
  resolvePrimaryDomain,
  ensurePrimaryAfterGoalSave,
  mergeDomainMapPatch,
  upsertDomainMap,
  setActiveDomain,
  setPrimaryDomain,
  deactivateDomain,
  orderActiveDomains,
  pickAllowedGoalFields,
  countStoredMaps,
};
