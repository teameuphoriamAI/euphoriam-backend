const { Op } = require("sequelize");
const { withDbSlot } = require("../config/sequelize");
const { DomainGoal } = require("../models/domainGoalModel");
const { UserStage1Meta } = require("../models/userStage1MetaModel");
const { normalizeDomain } = require("../constants/domains");
const {
  emptyStage1State,
  mergeDomainMapPatch,
  defaultDomainMap,
  applyGoalsCompleteFlag,
  DOMAIN_MAP_STATUS,
  DEFAULT_PROGRESS_METRICS,
} = require("./stage1State");
const { normalizeSuccessStrategy } = require("./stage1SuccessStrategy");
const { enrichProgressMetricsFromMap } = require("./stage1ProgressMetrics");

const STRUCTURE_KEYS = [
  "signature_id",
  "EO",
  "lack_channel",
  "avoid_type",
  "orbit_pattern",
  "recovery_speed",
  "protector_rule",
  "failure_strategy",
  "top_3_avoidance_behaviours",
  "success_strategy",
  "opposite_belief",
  "opposite_behaviour",
  "success_rule",
  "recommended_resource",
  "daily_rep",
  "win_condition",
  "progress_metrics",
  "map_resistance_transcript",
  "map_resistance_completed_at",
];

const rowToDomainMap = (row) => {
  if (!row) return null;
  const structure = row.structureJson && typeof row.structureJson === "object"
    ? row.structureJson
    : {};
  return {
    domain: row.domain,
    status: row.status,
    goal_title: row.goalTitle,
    desired_outcome: row.desiredOutcome,
    target_date: row.targetDate,
    proof_of_success: row.proofOfSuccess,
    milestones: {
      day_7: row.milestoneDay7,
      day_30: row.milestoneDay30,
      day_90: row.milestoneDay90,
    },
    today_visible_action: row.todayVisibleAction,
    goals_complete: row.goalsComplete,
    map_resistance_complete: row.mapResistanceComplete,
    ...structure,
    success_strategy:
      normalizeSuccessStrategy(structure) ?? structure.success_strategy ?? null,
    progress_metrics: enrichProgressMetricsFromMap(
      {
        ...structure,
        domain: row.domain,
        map_resistance_complete: row.mapResistanceComplete,
        failure_strategy: structure.failure_strategy,
      },
      structure.progress_metrics || DEFAULT_PROGRESS_METRICS(),
    ),
    updatedAt: row.updatedAt?.toISOString?.() || new Date().toISOString(),
  };
};

const domainMapToRowFields = (map) => {
  const structure = {};
  for (const key of STRUCTURE_KEYS) {
    if (map[key] !== undefined) structure[key] = map[key];
  }
  const normalizedSuccess = normalizeSuccessStrategy(structure);
  if (normalizedSuccess) structure.success_strategy = normalizedSuccess;
  return {
    domain: map.domain,
    status: map.status || DOMAIN_MAP_STATUS.DRAFT,
    goalTitle: map.goal_title ?? null,
    desiredOutcome: map.desired_outcome ?? null,
    targetDate: map.target_date ?? null,
    proofOfSuccess: map.proof_of_success ?? null,
    milestoneDay7: map.milestones?.day_7 ?? null,
    milestoneDay30: map.milestones?.day_30 ?? null,
    milestoneDay90: map.milestones?.day_90 ?? null,
    todayVisibleAction: map.today_visible_action ?? null,
    goalsComplete: Boolean(map.goals_complete),
    mapResistanceComplete: Boolean(map.map_resistance_complete),
    structureJson: structure,
  };
};

const ensureMetaRow = async (userId) => {
  let meta = await withDbSlot(() => UserStage1Meta.findByPk(userId));
  if (!meta) {
    meta = await withDbSlot(() =>
      UserStage1Meta.create({
        userId,
        activeDomains: [],
      }),
    );
  }
  return meta;
};

const migrateLegacyFromMetadata = async (user, legacyStage1) => {
  const userId = user.id;
  if (!legacyStage1 || !Array.isArray(legacyStage1.domain_maps) || !legacyStage1.domain_maps.length) {
    return false;
  }

  const count = await withDbSlot(() =>
    DomainGoal.count({ where: { userId } }),
  );
  if (count > 0) return false;

  await withDbSlot(async () => {
    await ensureMetaRow(userId);
    await UserStage1Meta.update(
      {
        primaryDomain: legacyStage1.primary_domain || null,
        activeDomains: legacyStage1.active_domains || [],
        mapResistanceInProgress: Boolean(legacyStage1.map_resistance_in_progress),
        walkthroughCompleted: Boolean(legacyStage1.walkthrough_completed),
        walkthroughCompletedAt: legacyStage1.walkthrough_completed_at
          ? new Date(legacyStage1.walkthrough_completed_at)
          : null,
      },
      { where: { userId } },
    );

    for (const map of legacyStage1.domain_maps) {
      const d = normalizeDomain(map.domain);
      if (!d) continue;
      const merged = applyGoalsCompleteFlag({ ...defaultDomainMap(d), ...map, domain: d });
      await DomainGoal.create({
        userId,
        ...domainMapToRowFields(merged),
      });
    }

    const nextMeta = { ...(user.metadata || {}) };
    nextMeta.stage1 = {
      ...legacyStage1,
      domain_maps: [],
      _storage: "domain_goals_table",
    };
    const { User } = require("../models/userModel");
    await User.update({ metadata: nextMeta }, { where: { id: userId } });
  });

  console.log(
    `[stage1Repository] Migrated ${legacyStage1.domain_maps.length} goals to domain_goals for user ${userId}`,
  );
  return true;
};

/** Build in-memory stage1 shape from normalized tables (+ optional legacy metadata). */
const loadStage1ForUser = async (user) => {
  const userId = user.id;
  const legacy = user.metadata?.stage1;

  await migrateLegacyFromMetadata(user, legacy);

  const [meta, goals] = await Promise.all([
    withDbSlot(() => ensureMetaRow(userId)),
    withDbSlot(() => DomainGoal.findAll({ where: { userId }, order: [["domain", "ASC"]] })),
  ]);

  const { resolvePrimaryDomain } = require("./stage1State");
  const base = emptyStage1State();
  let stage1 = {
    ...base,
    primary_domain: meta.primaryDomain,
    active_domains: Array.isArray(meta.activeDomains) ? meta.activeDomains : [],
    map_resistance_in_progress: meta.mapResistanceInProgress,
    walkthrough_completed: meta.walkthroughCompleted,
    walkthrough_completed_at: meta.walkthroughCompletedAt
      ? meta.walkthroughCompletedAt.toISOString()
      : null,
    proof_logs: Array.isArray(meta.proofLogs) ? meta.proofLogs : [],
    domain_maps: goals.map(rowToDomainMap),
  };

  const resolvedPrimary = resolvePrimaryDomain(stage1);
  const needsMetaRepair =
    resolvedPrimary &&
    !meta.primaryDomain &&
    (!(meta.activeDomains || []).length) &&
    goals.some((g) => g.goalsComplete);

  if (needsMetaRepair) {
    stage1 = {
      ...stage1,
      primary_domain: resolvedPrimary,
      active_domains: [resolvedPrimary],
    };
    stage1 = await persistStage1ForUser(userId, stage1);
  }

  return stage1;
};

/** Persist full stage1 snapshot to normalized tables. */
const persistStage1ForUser = async (userId, stage1) => {
  const { resolvePrimaryDomain } = require("./stage1State");
  let activeDomains = Array.isArray(stage1.active_domains) ? stage1.active_domains : [];
  const primary = resolvePrimaryDomain(stage1);
  if (!activeDomains.length && primary) activeDomains = [primary];

  await withDbSlot(async () => {
    await ensureMetaRow(userId);
    await UserStage1Meta.update(
      {
        primaryDomain: primary || null,
        activeDomains,
        mapResistanceInProgress: Boolean(stage1.map_resistance_in_progress),
        walkthroughCompleted: Boolean(stage1.walkthrough_completed),
        walkthroughCompletedAt: stage1.walkthrough_completed_at
          ? new Date(stage1.walkthrough_completed_at)
          : null,
        proofLogs: Array.isArray(stage1.proof_logs) ? stage1.proof_logs : [],
      },
      { where: { userId } },
    );

    const maps = stage1.domain_maps || [];
    const domains = maps.map((m) => normalizeDomain(m.domain)).filter(Boolean);

    for (const map of maps) {
      const d = normalizeDomain(map.domain);
      if (!d) continue;
      const fields = domainMapToRowFields(map);
      const existing = await DomainGoal.findOne({ where: { userId, domain: d } });
      if (existing) {
        await existing.update(fields);
      } else {
        await DomainGoal.create({ userId, ...fields });
      }
    }

    if (domains.length) {
      await DomainGoal.destroy({
        where: {
          userId,
          domain: { [Op.notIn]: domains },
        },
      });
    }
  });

  return loadStage1ForUser({ id: userId, metadata: {} });
};

/** Upsert one domain goal row from API patch (merged with existing map). */
const upsertDomainGoalRow = async (userId, domain, patch, existingStage1) => {
  const d = normalizeDomain(domain);
  const existingMap = (existingStage1.domain_maps || []).find((m) => m.domain === d);
  const merged = mergeDomainMapPatch(existingMap, { ...patch, domain: d });

  await withDbSlot(async () => {
    const fields = domainMapToRowFields(merged);
    const row = await DomainGoal.findOne({ where: { userId, domain: d } });
    if (row) {
      await row.update(fields);
    } else {
      await DomainGoal.create({ userId, ...fields });
    }
  });

  return merged;
};

module.exports = {
  loadStage1ForUser,
  persistStage1ForUser,
  upsertDomainGoalRow,
  rowToDomainMap,
  migrateLegacyFromMetadata,
};
