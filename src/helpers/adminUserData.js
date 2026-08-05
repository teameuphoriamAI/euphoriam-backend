const { Op, literal } = require("sequelize");
const { Diagnostic } = require("../models/diagnosticModel");
const { DomainGoal } = require("../models/domainGoalModel");
const { UserStage1Meta } = require("../models/userStage1MetaModel");
const { Chat } = require("../models/chatModel");
const { FunnelAccess } = require("../models/funnelAccessModel");
const { DOMAIN_LABELS } = require("../constants/domains");
const { getTier, getTierLimits } = require("./membershipDomains");
const { MAX_DIAGNOSTICS } = require("./funnelConstants");

const resolveFunnelMaxDiagnostics = (row) => {
  const raw = row?.metadata?.max_diagnostics;
  const parsed = Number(raw);
  if (Number.isFinite(parsed) && parsed >= 0) return Math.floor(parsed);
  return MAX_DIAGNOSTICS;
};

const normalizeTranscriptMessages = (transcript = []) => {
  if (!Array.isArray(transcript)) return [];
  return transcript
    .filter((m) => m && (m.content || m.message))
    .map((m) => ({
      role: m.role === "user" || m.role === "human" ? "user" : "assistant",
      content: String(m.content || m.message || ""),
    }))
    .filter((m) => m.content.trim());
};

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
  const transcript = Array.isArray(structure.map_resistance_transcript)
    ? structure.map_resistance_transcript
    : [];
  const diagnosticReport =
    typeof structure.diagnostic_report === "string" ? structure.diagnostic_report : null;

  return {
    domain: row.domain,
    domainLabel: DOMAIN_LABELS[row.domain] || row.domain,
    status: row.status,
    goalTitle: row.goalTitle,
    desiredOutcome: row.desiredOutcome,
    proofOfSuccess: row.proofOfSuccess || null,
    notes: structure.notes || null,
    todayVisibleAction: row.todayVisibleAction || null,
    goalsComplete: row.goalsComplete,
    mapResistanceComplete: row.mapResistanceComplete,
    completedAt: structure.map_resistance_completed_at || row.updatedAt || null,
    signatureId: structure.signature_id || null,
    vortexSignature: eo && lack && avoid ? `${eo}+${lack}+${avoid}` : null,
    vortex: {
      eo: eo || null,
      lack: lack || null,
      avoid: avoid || null,
      orbit: structure.orbit_pattern || null,
      recoverySpeed: structure.recovery_speed || null,
      protectorRule: structure.protector_rule || null,
      gravityDepth: structure.gravity_depth ?? null,
      clEstimate: structure.CL_estimate ?? structure.cl_estimate ?? null,
    },
    failureStrategy: structure.failure_strategy || null,
    successStrategy: structure.success_strategy || null,
    dailyRep: structure.daily_rep || null,
    winCondition: structure.win_condition || null,
    flipBelief: structure.flip_belief || null,
    flipRule: structure.flip_rule || null,
    flip90DayProjection: structure.flip_90_day_projection || null,
    milestones: {
      day7: row.milestoneDay7 || null,
      day30: row.milestoneDay30 || null,
      day90: row.milestoneDay90 || null,
    },
    progressMetrics: structure.progress_metrics || null,
    pdfUrl: structure.pdf_url || null,
    diagnosticReport,
    reportPreview: diagnosticReport ? diagnosticReport.slice(0, 280) : null,
    transcript,
    transcriptTurns: transcript.length,
  };
};

const formatDiagnosticForAdmin = (diagnostic) => {
  const json = diagnostic.toJSON ? diagnostic.toJSON() : diagnostic;
  const category = classifyDiagnosticReport(json);
  const data = json.data && typeof json.data === "object" ? json.data : {};
  const reportText =
    (typeof data.irlReport === "string" && data.irlReport) ||
    (typeof data.aiReport === "string" && data.aiReport) ||
    (typeof data.report === "string" && data.report) ||
    (typeof json.report === "string" && json.report) ||
    null;
  const transcript = normalizeTranscriptMessages(
    data.intakeTranscript || data.transcript || [],
  );
  const packet =
    data.structuredPacket && typeof data.structuredPacket === "object"
      ? data.structuredPacket
      : null;

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
    hasReportText: Boolean(reportText),
    funnelAccessId: json.funnel_access_id || data.funnel_access_id || null,
    reportText,
    reportPreview: reportText ? reportText.slice(0, 320) : null,
    transcript,
    transcriptTurns: transcript.length,
    profileName: data.profile?.name || null,
    profileEmail: data.profile?.email || json.email || null,
    metrics: data.metrics || null,
    generatedAt: data.generatedAt || null,
    structuredSummary: packet
      ? {
          primaryDomain: packet.domain_primary || packet.primary_domain || null,
          constraint:
            packet.primary_constraint ||
            packet.constraint ||
            packet.hidden_constraint ||
            null,
          outcome: packet.desired_outcome || packet.outcome || null,
        }
      : null,
  };
};

/**
 * Load free-tier funnel access + diagnosis chat sessions for an admin user view.
 */
const loadAdminFunnelData = async (user) => {
  const email = String(user?.email || "")
    .trim()
    .toLowerCase();
  if (!email && !user?.id) {
    return { funnelAccess: null, diagnosisSessions: [] };
  }

  const funnelAccessRows = email
    ? await FunnelAccess.findAll({
        where: { email: { [Op.iLike]: email } },
        order: [["createdAt", "DESC"]],
        limit: 5,
      }).catch(() => [])
    : [];

  const funnelAccess = funnelAccessRows[0] || null;
  const funnelAccessIds = funnelAccessRows.map((r) => r.id).filter(Boolean);

  const escape = (value) =>
    Diagnostic.sequelize.escape(String(value || "").toLowerCase());

  const identityClauses = [];
  if (user?.id) identityClauses.push({ userId: user.id });
  if (email) {
    identityClauses.push(
      literal(`LOWER(COALESCE(data->>'email','')) = ${escape(email)}`),
    );
  }
  for (const fid of funnelAccessIds) {
    identityClauses.push(
      literal(
        `data->>'funnel_access_id' = ${Diagnostic.sequelize.escape(String(fid))}`,
      ),
    );
  }

  const chats = identityClauses.length
    ? await Chat.findAll({
        where: {
          [Op.and]: [
            { [Op.or]: identityClauses },
            {
              [Op.or]: [
                literal(`data->>'phase' = 'funnel'`),
                literal(`data ? 'funnel_access_id'`),
                literal(`(data->>'funnelMode')::text = 'true'`),
              ],
            },
          ],
        },
        order: [["createdAt", "DESC"]],
        limit: 20,
      }).catch(() => [])
    : [];

  const diagnosisSessions = chats.map((chat) => {
    const json = chat.toJSON ? chat.toJSON() : chat;
    const data = json.data && typeof json.data === "object" ? json.data : {};
    const transcript = normalizeTranscriptMessages(data.transcript || []);
    const diagnosticId = json.dignosticId || data.diagnostic_id || null;
    const answered = transcript.filter((m) => m.role === "user").length;
    return {
      chatId: json.id,
      diagnosticId,
      funnelAccessId: data.funnel_access_id || null,
      status: json.isChatEnded
        ? diagnosticId
          ? "completed"
          : "ended"
        : "in_progress",
      email: data.email || email || null,
      startedAt: json.createdAt,
      endedAt: data.endedAt || (json.isChatEnded ? json.updatedAt : null),
      targetCount: Number(data.targetCount) || 25,
      answeredCount: answered,
      messageCount: transcript.length,
      transcript,
    };
  });

  const funnelAccessSummary = funnelAccess
    ? {
        id: funnelAccess.id,
        email: funnelAccess.email,
        diagnosticsCompleted: funnelAccess.diagnostics_completed_count || 0,
        reportsGenerated: funnelAccess.report_generated_count || 0,
        maxDiagnostics: resolveFunnelMaxDiagnostics(funnelAccess),
        expiresAt: funnelAccess.expires_at || null,
        firstAccessedAt: funnelAccess.first_accessed_at || null,
        lastDiagnosticAt: funnelAccess.last_diagnostic_at || null,
        isBlocked: Boolean(funnelAccess.is_blocked),
        blockReason: funnelAccess.block_reason || null,
        kajabiOfferSource: funnelAccess.kajabi_offer_source || null,
      }
    : null;

  return { funnelAccess: funnelAccessSummary, diagnosisSessions };
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
    .slice(0, 40)
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
      messages: Array.isArray(session.messages)
        ? session.messages
            .filter((m) => m?.role && m?.content)
            .map((m) => ({
              role: m.role === "user" ? "user" : "assistant",
              content: String(m.content),
            }))
        : [],
      // Lightweight message snippets for proof source matching (not sent to client)
      userMessagePreviews: Array.isArray(session.messages)
        ? session.messages
            .filter((m) => m?.role === "user" && m?.content)
            .map((m) => String(m.content).trim().slice(0, 500))
            .filter(Boolean)
        : [],
    }));
};

/**
 * Classify proof as from coaching chat vs user Progress form.
 * Uses explicit `source` when present; otherwise matches action text to coach user messages.
 */
const classifyProofSource = (proof, coachSessions = []) => {
  const explicit = String(proof?.source || "").toLowerCase();
  if (explicit === "coach" || explicit === "coaching" || explicit === "coach_session") {
    return "coach";
  }
  if (explicit === "user" || explicit === "manual" || explicit === "progress") {
    return "user";
  }

  const action = String(proof?.action || proof?.note || "").trim();
  if (!action) return "user";

  const domain = proof?.domain || null;
  for (const session of coachSessions) {
    if (domain && session.domain && session.domain !== domain) continue;
    const previews = session.userMessagePreviews || [];
    for (const preview of previews) {
      if (preview === action || preview.startsWith(action) || action.startsWith(preview.slice(0, 80))) {
        return "coach";
      }
    }
  }
  return "user";
};

const summarizeProofLogs = (proofLogs = [], coachSessions = []) => {
  const logs = Array.isArray(proofLogs) ? proofLogs : [];
  return logs
    .slice()
    .sort(
      (a, b) =>
        new Date(b?.created_at || b?.logged_at || 0).getTime() -
        new Date(a?.created_at || a?.logged_at || 0).getTime(),
    )
    .slice(0, 200)
    .map((proof) => {
      const source = classifyProofSource(proof, coachSessions);
      return {
        id: proof.id || null,
        domain: proof.domain || null,
        domainLabel: proof.domain
          ? DOMAIN_LABELS[proof.domain] || proof.domain
          : null,
        action: proof.action || proof.note || proof.description || null,
        type: proof.type || "action",
        repName: proof.green_rep_name || proof.rep_name || proof.repName || null,
        loggedAt: proof.created_at || proof.logged_at || null,
        note: proof.note || proof.description || null,
        source,
      };
    });
};

const loadAdminUserStage1 = async (userId) => {
  const [domainGoals, stage1Meta] = await Promise.all([
    DomainGoal.findAll({ where: { userId }, order: [["domain", "ASC"]] }),
    UserStage1Meta.findOne({ where: { userId } }),
  ]);

  const formattedGoals = domainGoals.map(formatDomainGoalForAdmin);
  const coachSessions = summarizeCoachSessions(stage1Meta?.coachSessionLog);
  // Strip heavy previews before sending to client
  const coachSessionsForClient = coachSessions.map(
    ({ userMessagePreviews: _previews, ...rest }) => rest,
  );
  const proofLogs = summarizeProofLogs(stage1Meta?.proofLogs, coachSessions);

  return {
    primaryDomain: stage1Meta?.primaryDomain || null,
    activeDomains: Array.isArray(stage1Meta?.activeDomains) ? stage1Meta.activeDomains : [],
    mapResistanceInProgress: Boolean(stage1Meta?.mapResistanceInProgress),
    domainGoals: formattedGoals,
    coachSessions: coachSessionsForClient,
    proofLogs,
    coachProofLogs: proofLogs.filter((p) => p.source === "coach"),
    userProofLogs: proofLogs.filter((p) => p.source === "user"),
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

/**
 * Batch redline + map-resistance diagnostic counts for many users (one query).
 * Matches by userId or email, same as userDiagnosticWhere.
 * @param {Array<{ id: number, email?: string }>} users
 * @returns {Promise<Record<number, { redline: number, mapResistance: number }>>}
 */
const batchDiagnosticCountsForUsers = async (users) => {
  const countsByUserId = {};
  for (const user of users) {
    countsByUserId[user.id] = { redline: 0, mapResistance: 0 };
  }
  if (!users.length) return countsByUserId;

  const userIds = users.map((u) => u.id);
  const emails = users.map((u) => u.email).filter(Boolean);
  const emailToUserId = new Map(
    users
      .filter((u) => u.email)
      .map((u) => [String(u.email).toLowerCase(), u.id]),
  );

  const identityClauses = [{ userId: { [Op.in]: userIds } }];
  if (emails.length) {
    identityClauses.push({ email: { [Op.in]: emails } });
  }

  // Only redline + map-resistance rows; skip heavy JSON blobs
  const diagnostics = await Diagnostic.findAll({
    where: {
      [Op.and]: [
        { [Op.or]: identityClauses },
        {
          [Op.or]: [
            { report_type: "invisible_red_line" },
            literal("(data->>'map_resistance_domain') IS NOT NULL"),
          ],
        },
      ],
    },
    attributes: [
      "userId",
      "email",
      "report_type",
      [literal("data->>'map_resistance_domain'"), "mapResistanceDomain"],
    ],
    raw: true,
  });

  for (const row of diagnostics) {
    let uid = row.userId;
    if (uid == null && row.email) {
      uid = emailToUserId.get(String(row.email).toLowerCase());
    }
    if (uid == null || !countsByUserId[uid]) continue;

    if (row.report_type === "invisible_red_line") {
      countsByUserId[uid].redline += 1;
    } else if (row.mapResistanceDomain) {
      countsByUserId[uid].mapResistance += 1;
    }
  }

  return countsByUserId;
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
  loadAdminFunnelData,
  countDiagnosticsByCategory,
  batchDiagnosticCountsForUsers,
  TIER_LABELS,
};
