const { Op } = require("sequelize");
const { Diagnostic } = require("../models/diagnosticModel");
const { DomainGoal } = require("../models/domainGoalModel");
const { UserStage1Meta } = require("../models/userStage1MetaModel");
const { DOMAIN_LABELS } = require("../constants/domains");
const { getTier, getTierLimits } = require("./membershipDomains");

/** @typedef {"redline" | "map_resistance"} DiagnosticCategory */
/** @typedef {"free" | "bronze" | "silver" | "accelerate"} AdminMembershipTier */

const TIER_LABELS = Object.freeze({
  free: "Free",
  bronze: "Creator Club",
  silver: "Silver",
  accelerate: "Accelerate",
});

/**
 * @param {object | null | undefined} user
 * @returns {AdminMembershipTier}
 */
const resolveAdminMembershipTier = (user) => {
  const tier = getTier(user);
  return tier === "standard" ? "free" : tier;
};

/**
 * @param {object | null | undefined} user
 */
const formatMembershipForAdmin = (user) => {
  const tier = resolveAdminMembershipTier(user);
  const limits = getTierLimits(tier === "free" ? "standard" : tier);
  return {
    tier,
    label: TIER_LABELS[tier] || tier,
    maxActiveDomains: tier === "free" ? 0 : limits.maxActiveDomains,
    maxStoredGoals: tier === "free"
      ? 0
      : Number.isFinite(limits.maxStoredGoals)
        ? limits.maxStoredGoals
        : null,
    isPaid: tier !== "free",
  };
};

const countStoredGoals = (domainGoals = []) =>
  domainGoals.filter(
    (g) =>
      g.status !== "draft" &&
      (Boolean(g.goalTitle?.trim?.()) || Boolean(g.goalTitle) || Boolean(g.desiredOutcome?.trim?.()) || Boolean(g.desiredOutcome)),
  ).length;

const computeUserProgress = ({
  membership,
  stage1 = {},
  redlineCount = 0,
  goalsSetOverride,
  goalsCompleteOverride,
}) => {
  const domainGoals = stage1.domainGoals || [];
  const goalsSet = goalsSetOverride ?? countStoredGoals(domainGoals);
  const goalsComplete =
    goalsCompleteOverride ??
    domainGoals.filter((g) => g.goalsComplete).length;
  const mapResistanceComplete = stage1.mapResistanceCompleteCount || 0;
  const coachSessions = stage1.coachSessionCount || 0;
  const proofLogs = stage1.proofLogCount || 0;
  const activeDomains = Array.isArray(stage1.activeDomains) ? stage1.activeDomains.length : 0;

  let phase = "free";
  if (membership?.isPaid) {
    if (coachSessions > 0) phase = "coaching";
    else if (mapResistanceComplete > 0) phase = "map_resistance";
    else if (goalsComplete > 0 || goalsSet > 0) phase = "goals";
    else phase = "onboarding";
  } else if (redlineCount > 0) {
    phase = "redline";
  }

  const progressScore =
    mapResistanceComplete * 4 +
    coachSessions * 2 +
    proofLogs +
    goalsComplete * 2 +
    goalsSet +
    redlineCount;

  return {
    phase,
    goalsSet,
    goalsComplete,
    mapResistanceComplete,
    coachSessions,
    proofLogs,
    activeDomains,
    redlineReports: redlineCount,
    progressScore,
  };
};

/**
 * @param {{ report_type?: string; data?: Record<string, unknown> } | null | undefined} diagnostic
 * @returns {DiagnosticCategory}
 */
const classifyDiagnosticReport = (diagnostic) => {
  const data =
    diagnostic?.data && typeof diagnostic.data === "object" ? diagnostic.data : {};
  if (diagnostic?.report_type === "invisible_red_line") return "redline";
  if (data.map_resistance_domain) return "map_resistance";
  return null;
};

const diagnosticPdfUrl = (diagnostic) =>
  diagnostic?.pdfUrl ||
  (diagnostic?.data && typeof diagnostic.data === "object"
    ? diagnostic.data?.pdf?.url
    : null) ||
  null;

const userDiagnosticWhere = (user) => {
  const clauses = [{ userId: user.id }];
  if (user.email) clauses.push({ email: user.email });
  return { [Op.or]: clauses };
};

const mapResistanceCountForUser = async (userId) =>
  DomainGoal.count({
    where: { userId, mapResistanceComplete: true },
  });

const formatDomainGoalForAdmin = (row) => {
  const structure =
    row.structureJson && typeof row.structureJson === "object" ? row.structureJson : {};
  const eo = structure.EO || null;
  const lack = structure.lack_channel || null;
  const avoid = structure.avoid_type || null;
  return {
    domain: row.domain,
    domainLabel: DOMAIN_LABELS[row.domain] || row.domain,
    status: row.status,
    goalTitle: row.goalTitle,
    desiredOutcome: row.desiredOutcome,
    goalsComplete: row.goalsComplete,
    mapResistanceComplete: row.mapResistanceComplete,
    completedAt: structure.map_resistance_completed_at || row.updatedAt || null,
    signatureId: structure.signature_id || null,
    vortexSignature: eo && lack && avoid ? `${eo}+${lack}+${avoid}` : null,
    pdfUrl: structure.pdf_url || null,
    reportPreview:
      typeof structure.diagnostic_report === "string"
        ? structure.diagnostic_report.slice(0, 280)
        : null,
    transcriptTurns: Array.isArray(structure.map_resistance_transcript)
      ? structure.map_resistance_transcript.length
      : 0,
  };
};

const formatDiagnosticForAdmin = (diagnostic) => {
  const json = diagnostic.toJSON ? diagnostic.toJSON() : diagnostic;
  const category = classifyDiagnosticReport(json);
  const data = json.data && typeof json.data === "object" ? json.data : {};
  return {
    id: json.id,
    category,
    reportType: json.report_type || "full",
    title: json.title || null,
    domain: data.map_resistance_domain || null,
    domainLabel: data.map_resistance_domain
      ? DOMAIN_LABELS[data.map_resistance_domain] || data.map_resistance_domain
      : null,
    pdfUrl: diagnosticPdfUrl(json),
    createdAt: json.createdAt,
    updatedAt: json.updatedAt,
    hasReportText: Boolean(data.aiReport || data.report),
  };
};

const summarizeCoachSessions = (coachSessionLog = []) => {
  const sessions = Array.isArray(coachSessionLog) ? coachSessionLog : [];
  return sessions
    .slice()
    .sort((a, b) => {
      const aTs = new Date(a?.started_at || a?.created_at || 0).getTime();
      const bTs = new Date(b?.started_at || b?.created_at || 0).getTime();
      return bTs - aTs;
    })
    .slice(0, 20)
    .map((session) => ({
      sessionId: session.session_id || session.id || null,
      domain: session.domain || null,
      domainLabel: session.domain
        ? DOMAIN_LABELS[session.domain] || session.domain
        : null,
      startedAt: session.started_at || session.created_at || null,
      endedAt: session.ended_at || null,
      messageCount: Array.isArray(session.messages) ? session.messages.length : 0,
      status: session.status || (session.ended_at ? "ended" : "open"),
    }));
};

const summarizeProofLogs = (proofLogs = []) => {
  const logs = Array.isArray(proofLogs) ? proofLogs : [];
  return logs
    .slice()
    .sort((a, b) => new Date(b?.logged_at || b?.created_at || 0) - new Date(a?.logged_at || a?.created_at || 0))
    .slice(0, 15)
    .map((proof) => ({
      id: proof.id || null,
      domain: proof.domain || null,
      domainLabel: proof.domain ? DOMAIN_LABELS[proof.domain] || proof.domain : null,
      repName: proof.rep_name || proof.repName || null,
      loggedAt: proof.logged_at || proof.created_at || null,
      note: proof.note || proof.description || null,
    }));
};

const loadAdminUserStage1 = async (userId) => {
  const [domainGoals, stage1Meta] = await Promise.all([
    DomainGoal.findAll({ where: { userId }, order: [["domain", "ASC"]] }),
    UserStage1Meta.findOne({ where: { userId } }),
  ]);

  const formattedGoals = domainGoals.map(formatDomainGoalForAdmin);

  return {
    primaryDomain: stage1Meta?.primaryDomain || null,
    activeDomains: Array.isArray(stage1Meta?.activeDomains) ? stage1Meta.activeDomains : [],
    mapResistanceInProgress: Boolean(stage1Meta?.mapResistanceInProgress),
    domainGoals: formattedGoals,
    coachSessions: summarizeCoachSessions(stage1Meta?.coachSessionLog),
    proofLogs: summarizeProofLogs(stage1Meta?.proofLogs),
    coachSessionCount: Array.isArray(stage1Meta?.coachSessionLog)
      ? stage1Meta.coachSessionLog.length
      : 0,
    proofLogCount: Array.isArray(stage1Meta?.proofLogs) ? stage1Meta.proofLogs.length : 0,
    mapResistanceCompleteCount: domainGoals.filter((g) => g.mapResistanceComplete).length,
    goalsSetCount: countStoredGoals(formattedGoals),
    goalsCompleteCount: formattedGoals.filter((g) => g.goalsComplete).length,
  };
};

const countRedlineReportsForUser = async (user) => {
  const where = userDiagnosticWhere(user);
  return Diagnostic.count({
    where: {
      ...where,
      report_type: "invisible_red_line",
    },
  });
};

const countDiagnosticsByCategory = async (user) => {
  const where = userDiagnosticWhere(user);
  const diagnostics = await Diagnostic.findAll({
    where,
    attributes: ["id", "report_type", "data"],
    raw: true,
  });

  let redline = 0;
  let mapResistance = 0;
  for (const row of diagnostics) {
    const category = classifyDiagnosticReport(row);
    if (category === "redline") redline += 1;
    else if (category === "map_resistance") mapResistance += 1;
  }

  const mapResistanceFromDomains = await mapResistanceCountForUser(user.id);

  return {
    redline,
    mapResistance: Math.max(mapResistance, mapResistanceFromDomains),
    totalReports: redline + Math.max(mapResistance, mapResistanceFromDomains),
  };
};

module.exports = {
  classifyDiagnosticReport,
  diagnosticPdfUrl,
  userDiagnosticWhere,
  mapResistanceCountForUser,
  countRedlineReportsForUser,
  formatDomainGoalForAdmin,
  formatDiagnosticForAdmin,
  formatMembershipForAdmin,
  resolveAdminMembershipTier,
  computeUserProgress,
  countStoredGoals,
  summarizeCoachSessions,
  summarizeProofLogs,
  loadAdminUserStage1,
  countDiagnosticsByCategory,
  TIER_LABELS,
};
