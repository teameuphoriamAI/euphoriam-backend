const { Op } = require("sequelize");
const crypto = require("crypto");
const Joi = require("joi");
const { FunnelAccess } = require("../models/funnelAccessModel");
const { Diagnostic } = require("../models/diagnosticModel");
const { User } = require("../models/userModel");
const { Chat } = require("../models/chatModel");
const { Prompt } = require("../models/promptModel");
const { IntegrationEvent } = require("../models/integrationEventModel");
const { sequelize, withDbSlot } = require("../config/sequelize");
const { successResponse, errorResponse } = require("../utils/response");
const {
  generateFunnelToken,
  verifyFunnelToken,
  generateFunnelSessionToken,
} = require("../utils/funnelToken");
const { extractStructuredPacket } = require("../helpers/structuredPacketExtractor");
const { generateInvisibleRedLineReport } = require("../helpers/irlReportGenerator");
const { sendEmail, sendEmailBasic } = require("../utils/email");
const { irlReportEmail } = require("../utils/emailTemplate/irlReportEmail");
const { funnelAccessEmail } = require("../utils/emailTemplate/funnelAccessEmail");
const { generateIrlReportPdf } = require("../utils/irlPdf");
const { uploadBufferToSupabase } = require("../utils/storage");
const { normalizeFunnelTranscriptRowsFromChatData } = require("../utils/funnelTranscriptNormalize");
const { IRL_REPORT_PUBLIC_TITLE } = require("../constants/irlBranding");
const { deleteChatFromVectorDB } = require("../services/vectorStoreService");
const fs = require("fs");

// ── Constants ─────────────────────────────────────────────────────────────────

const MAX_DIAGNOSTICS = 3;
const LINK_VALIDITY_DAYS = 10;
const ACCESS_WINDOW_DAYS = 7;
const UC_SALES_URL = process.env.UC_SALES_URL || `${process.env.FRONTEND_URL || ""}/upgrade`;

const IP_ABUSE_THRESHOLD = 10; // distinct emails per IP per 24h before flagging

/** Diagnostic id from Chat row (`dignosticId` column typo) and/or JSON `data.diagnostic_id`. */
const funnelChatLinkedDiagnosticId = (chat) => {
  if (!chat) return null;
  const top = chat.dignosticId != null ? Number(chat.dignosticId) : NaN;
  if (Number.isFinite(top) && top > 0) return top;
  const raw = chat.data?.diagnostic_id;
  const n = raw != null && raw !== "" ? Number(raw) : NaN;
  if (Number.isFinite(n) && n > 0) return n;
  return null;
};

// ── Validation schemas ────────────────────────────────────────────────────────

const createTokenSchema = Joi.object({
  email: Joi.string().email().required(),
  kajabi_offer_source: Joi.string().max(255).optional().allow(null, ""),
  ip: Joi.string().max(64).optional().allow(null, ""),
  // Option B: when Kajabi cannot embed the link, pass send_email: true to trigger backend delivery
  send_email: Joi.boolean().optional().default(false),
  first_name: Joi.string().max(100).optional().allow(null, ""),
});

const tokenBodySchema = Joi.object({
  token: Joi.string().required(),
});

// ── Internal helpers ──────────────────────────────────────────────────────────

/**
 * Check whether a given IP has created/validated tokens for more than
 * IP_ABUSE_THRESHOLD distinct emails in the last 24 hours.
 *
 * If suspicious:
 *  - Logs a warning to console
 *  - Writes an IntegrationEvent record for audit trail
 *  - Returns true (caller should return 429)
 *
 * @param {string|null} ip
 * @param {string} context - "create_token" | "validate_token"
 * @returns {Promise<boolean>} true = abusive, false = ok
 */
const checkIpAbuse = async (ip, context = "funnel") => {
  if (!ip) return false;

  try {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);

    // Count distinct emails tied to this IP in the last 24h
    const records = await withDbSlot(() =>
      FunnelAccess.findAll({
        attributes: ["email"],
        where: {
          [Op.or]: [
            { ip_at_creation: ip },
            { ip_at_first_access: ip },
          ],
          createdAt: { [Op.gte]: since },
        },
        raw: true,
      })
    );

    const distinctEmails = new Set(records.map((r) => r.email)).size;

    if (distinctEmails > IP_ABUSE_THRESHOLD) {
      console.warn(
        `[funnel] IP abuse detected: ${ip} — ${distinctEmails} distinct emails in 24h (context: ${context})`
      );

      // Write audit event (best-effort — never crash the main flow)
      try {
        await withDbSlot(() =>
          IntegrationEvent.create({
            source: "funnel_abuse_monitor",
            externalId: `${ip}_${Date.now()}`,
            status: "flagged",
            payload: { ip, distinctEmails, context, detectedAt: new Date().toISOString() },
          })
        );
      } catch (logErr) {
        console.error("[funnel] Failed to write abuse audit event:", logErr.message);
      }

      return true;
    }
  } catch (err) {
    // Non-fatal — abuse detection should never block normal flow on errors
    console.error("[funnel] IP abuse check failed (non-fatal):", err.message);
  }

  return false;
};

/**
 * Extract the calling IP from the request, preferring forwarded header.
 */
const getClientIp = (req) =>
  (req.headers["x-forwarded-for"] || "").split(",")[0].trim() ||
  req.ip ||
  null;

/**
 * Extract token from request body or Authorization: Bearer header.
 */
const extractToken = (req) =>
  req.body?.token ||
  (req.headers.authorization?.startsWith("Bearer ")
    ? req.headers.authorization.slice(7)
    : null);

/**
 * Run all four access checks against a FunnelAccess record.
 * Returns { valid, reason, diagnostics_remaining, days_remaining, can_start_new }.
 */
const checkAccess = (record) => {
  const now = new Date();

  if (record.is_blocked) {
    return { valid: false, reason: "blocked", diagnostics_remaining: 0, days_remaining: 0, can_start_new: false };
  }

  // Quota is terminal for new diagnostics, but users should still be able to log in
  // and view/download their existing reports/chats.
  if (record.diagnostics_completed_count >= MAX_DIAGNOSTICS) {
    return { valid: false, reason: "limit_reached", diagnostics_remaining: 0, days_remaining: 0, can_start_new: false };
  }

  if (now >= new Date(record.link_expiry)) {
    return { valid: false, reason: "link_expired", diagnostics_remaining: 0, days_remaining: 0, can_start_new: false };
  }

  if (record.first_accessed_at && now >= new Date(record.expires_at)) {
    return { valid: false, reason: "access_expired", diagnostics_remaining: 0, days_remaining: 0, can_start_new: false };
  }

  const diagnostics_remaining = MAX_DIAGNOSTICS - record.diagnostics_completed_count;

  let days_remaining = null;
  if (record.expires_at) {
    const diffMs = new Date(record.expires_at) - now;
    days_remaining = Math.max(0, Math.ceil(diffMs / (1000 * 60 * 60 * 24)));
  } else {
    // Not yet activated — remaining = full window
    days_remaining = ACCESS_WINDOW_DAYS;
  }

  return {
    valid: true,
    reason: "ok",
    diagnostics_remaining,
    days_remaining,
    can_start_new: diagnostics_remaining > 0,
  };
};

/**
 * Look up a FunnelAccess record by raw token string.
 * Verifies JWT signature first, then does a DB lookup by link_token.
 * Returns { record, decoded } or throws on failure.
 */
const resolveToken = async (token) => {
  if (!token) {
    const err = new Error("Token is required");
    err.status = 400;
    throw err;
  }

  const decoded = verifyFunnelToken(token);
  if (!decoded) {
    const err = new Error("Invalid or expired token");
    err.status = 401;
    throw err;
  }

  const record = await withDbSlot(() =>
    FunnelAccess.findOne({ where: { link_token: token } })
  );

  if (!record) {
    const err = new Error("Access record not found");
    err.status = 404;
    throw err;
  }

  return { record, decoded };
};

// ── Controller functions ──────────────────────────────────────────────────────

/**
 * POST /api/funnel/create-token
 * Called by Kajabi after a user opts in to generate a secure funnel access link.
 */
const createToken = async (req, res) => {
  const { error, value } = createTokenSchema.validate(req.body, {
    abortEarly: false,
    stripUnknown: true,
  });
  if (error) {
    return errorResponse(res, error.details.map((d) => d.message).join(", "), 400);
  }

  const { email, kajabi_offer_source = null, send_email = false, first_name = null } = value;
  const clientIp = getClientIp(req) || value.ip || null;

  // IP abuse check
  if (await checkIpAbuse(clientIp, "create_token")) {
    return errorResponse(res, "Too many requests from this location. Please try again later.", 429);
  }
  const now = new Date();
  const nonce = crypto.randomUUID();

  const token = generateFunnelToken({ email, kajabi_offer_source, nonce });

  const linkExpiry = new Date(now.getTime() + LINK_VALIDITY_DAYS * 24 * 60 * 60 * 1000);

  const signupName =
    first_name && String(first_name).trim() ? String(first_name).trim() : null;
  const metadata = signupName ? { signup_name: signupName } : {};

  const record = await withDbSlot(() =>
    FunnelAccess.create({
      email,
      link_token: token,
      link_created_at: now,
      link_expiry: linkExpiry,
      kajabi_offer_source,
      ip_at_creation: clientIp,
      metadata,
    })
  );

  const frontendUrl = process.env.FRONTEND_URL || "";
  const link = `${frontendUrl}/diagnostic/funnel?token=${encodeURIComponent(token)}`;

  // Option B: send funnel access link via email when Kajabi cannot embed it directly
  if (send_email) {
    const displayName = first_name || email.split("@")[0];
    const emailHtml = funnelAccessEmail(displayName, link, LINK_VALIDITY_DAYS);
    try {
      await sendEmailBasic(
        email,
        "Your Free Euphoriam AI Diagnosis is ready",
        emailHtml
      );
    } catch (emailErr) {
      // Non-fatal — log but still return the token so Kajabi receives it
      console.error("[funnelController] createToken: failed to send access email:", emailErr.message);
    }
  }

  return successResponse(res, "Funnel access token created", {
    token,
    link,
    expires_at: linkExpiry.toISOString(),
    funnel_access_id: record.id,
    email_sent: send_email,
  });
};

/**
 * POST /api/funnel/validate-token
 * Validates a funnel access token, runs all 4 access checks, and activates
 * the 7-day window on first use.
 */
const validateToken = async (req, res) => {
  const token = extractToken(req);
  const clientIp = getClientIp(req);

  // IP abuse check
  if (await checkIpAbuse(clientIp, "validate_token")) {
    return errorResponse(res, "Too many requests from this location. Please try again later.", 429);
  }

  let record, decoded;
  try {
    ({ record, decoded } = await resolveToken(token));
  } catch (err) {
    return errorResponse(
      res,
      err.message,
      err.status || 401,
      { valid: false, reason: "invalid_token" }
    );
  }

  // Activate window on first use
  if (!record.first_accessed_at) {
    const now = new Date();
    const expiresAt = new Date(now.getTime() + ACCESS_WINDOW_DAYS * 24 * 60 * 60 * 1000);
    await withDbSlot(() =>
      record.update({
        first_accessed_at: now,
        expires_at: expiresAt,
        ip_at_first_access: clientIp,
      })
    );
  }

  const status = checkAccess(record);

  return successResponse(res, "Token validated", {
    ...status,
    email: decoded.email,
    kajabi_offer_source: decoded.kajabi_offer_source,
    first_accessed_at: record.first_accessed_at,
    expires_at: record.expires_at,
  });
};

/**
 * POST /api/funnel/start-diagnostic
 * Validates the access token, finds/creates a super-base User record, creates
 * a Chat record, and returns a short-lived session token for the Socket.IO connection.
 */
const startDiagnostic = async (req, res) => {
  const token = extractToken(req);
  const clientIp = getClientIp(req);

  let record, decoded;
  try {
    ({ record, decoded } = await resolveToken(token));
  } catch (err) {
    return errorResponse(res, err.message, err.status || 401);
  }

  // Activate window on first use
  if (!record.first_accessed_at) {
    const now = new Date();
    const expiresAt = new Date(now.getTime() + ACCESS_WINDOW_DAYS * 24 * 60 * 60 * 1000);
    await withDbSlot(() =>
      record.update({
        first_accessed_at: now,
        expires_at: expiresAt,
        ip_at_first_access: clientIp,
      })
    );
  }

  const status = checkAccess(record);
  if (!status.valid) {
    return errorResponse(res, `Access denied: ${status.reason}`, 403, { reason: status.reason });
  }

  const { email } = decoded;

  const meta = record.metadata && typeof record.metadata === "object" ? record.metadata : {};
  const signupName =
    typeof meta.signup_name === "string" && meta.signup_name.trim()
      ? meta.signup_name.trim()
      : "";
  const emailLocal = (email || "").split("@")[0]?.trim() || "";

  // Find or create super-base User record (builds market research base)
  let user = await withDbSlot(() => User.findOne({ where: { email } }));
  if (!user) {
    const userName = signupName || emailLocal || "User";
    user = await withDbSlot(() =>
      User.create({ email, name: userName })
    );
  } else if (signupName && emailLocal && user.name === emailLocal) {
    // Backfill display name when row was created before signup_name existed (name was email local part)
    await withDbSlot(() => user.update({ name: signupName }));
  }

  const accessIdStr = String(record.id);

  const funnelChatLiteral = sequelize.literal(
    `("Chat"."data"->>'funnel_access_id') = ${sequelize.escape(accessIdStr)} AND (("Chat"."data"->>'funnelMode') = 'true' OR ("Chat"."data"->>'report_type') = ${sequelize.escape("invisible_red_line")})`,
  );

  // Reuse an in-progress funnel Q&A for this access + user so refresh / re-entry via
  // /start does not abandon the current session or spawn duplicate chats.
  const existingIncomplete = await withDbSlot(() =>
    Chat.findOne({
      where: {
        userId: user.id,
        isChatEnded: false,
        [Op.and]: funnelChatLiteral,
      },
      order: [["updatedAt", "DESC"]],
    }),
  );

  const chat =
    existingIncomplete ||
    (await withDbSlot(() =>
      Chat.create({
        userId: user.id,
        chatType: "Diagnostic",
        data: {
          funnelMode: true,
          funnel_access_id: record.id,
          report_type: "invisible_red_line",
          startedAt: new Date().toISOString(),
        },
        isChatEnded: false,
      }),
    ));

  // Issue a short-lived session token for the Socket.IO connection
  const sessionToken = generateFunnelSessionToken({
    email,
    funnel_access_id: record.id,
    chat_id: chat.id,
  });

  return successResponse(res, "Diagnostic session started", {
    session_token: sessionToken,
    email,
    chat_id: chat.id,
    funnel_access_id: record.id,
    diagnostics_remaining: status.diagnostics_remaining,
    days_remaining: status.days_remaining,
  });
};

/**
 * POST /api/funnel/complete-diagnostic
 * Called internally by the socket finalize flow for funnel sessions.
 * Runs the two-stage pipeline (Stage 1 extraction → Stage 2 IRL report),
 * saves the report, increments counters, generates PDF, sends email.
 *
 * NOTE: Stage 1 (extractStructuredPacket) and Stage 2 (generateInvisibleRedLineReport)
 * helpers are built in Phase 3 and Phase 4 respectively. Stubs are used until then.
 */
const completeDiagnostic = async ({
  funnel_access_id,
  email,
  transcript,
  reportText,
  metrics = {},
  chat_id = null,
}) => {
  // Reload access record to verify it's still valid
  const record = await withDbSlot(() =>
    FunnelAccess.findOne({ where: { id: funnel_access_id } })
  );
  if (!record) throw new Error("FunnelAccess record not found");

  const status = checkAccess(record);
  if (!status.valid) {
    throw new Error(`Access denied: ${status.reason}`);
  }

  // ── Stage 1: Extract structured packet from the Stage 1 report ──────────
  let structuredPacket = null;
  try {
    structuredPacket = await extractStructuredPacket({
      reportText,
      transcript,
      existingMetrics: metrics,
    });
    console.log("[funnel] Stage 1 structured packet extracted, structure_type:", structuredPacket?.diagnostic_packet?.structure_type);
  } catch (extractErr) {
    console.error("[funnel] Stage 1 extraction failed (non-fatal):", extractErr.message);
  }

  // ── Stage 2: Generate your hidden structure map ──────────────────────────
  // Build offer_config from env vars (overridable per-request in future)
  const offer_config = {
    uc_offer_name: process.env.UC_OFFER_NAME || "Unlimited Creator",
    uc_offer_price_string: process.env.UC_OFFER_PRICE || null,
    include_price_compare: process.env.UC_INCLUDE_PRICE_COMPARE === "true",
    include_button_cta: process.env.UC_INCLUDE_BUTTON_CTA !== "false",
    cta_text: process.env.UC_CTA_TEXT || "Upgrade for Full Access",
  };

  let irlReport = reportText; // Fallback to Stage 1 report if Stage 2 fails
  try {
    const userName = email?.split("@")[0] || "there";
    const dp = structuredPacket?.diagnostic_packet || {};
    const cp = structuredPacket?.constraint_packet || {};
    const oi = structuredPacket?.optional_inputs || {};
    const timezone =
      (metrics && (metrics.timezone || metrics.user_timezone || metrics.tz)) || null;

    const { reportText: generatedReport, wordCount, irlRetryUsed } =
      await generateInvisibleRedLineReport({
      user: { first_name: userName, timezone },
      diagnostic_packet: dp,
      constraint_packet: cp,
      optional_inputs: oi,
      access_flags: {
        UC: false,
        CreatorClub: false,
        ChangingRealities: false,
        LiveCalls: false,
        Mastery: false,
      },
      offer_config,
    });

    irlReport = generatedReport;
    console.log(
      `[funnel] Stage 2 IRL report generated: ${wordCount} words` +
        (irlRetryUsed ? " (after length expand retry)" : "")
    );
  } catch (stage2Err) {
    console.error(
      "[IRL_QA] stage2_failed",
      JSON.stringify({
        event: "stage2_failed",
        message: stage2Err?.message || String(stage2Err),
        funnel_access_id,
        at: new Date().toISOString(),
      })
    );
    console.error("[funnel] Stage 2 IRL generation failed (falling back to Stage 1 report):", stage2Err.message);
  }

  const userName = email?.split("@")[0] || "User";

  // Find or create user
  let user = await withDbSlot(() => User.findOne({ where: { email } }));
  if (!user) {
    user = await withDbSlot(() => User.create({ email, name: userName }));
  }

  // Create Diagnostic record (email left null to avoid unique-constraint conflict)
  const diagnostic = await withDbSlot(() =>
    Diagnostic.create({
      userId: user.id,
      funnel_access_id,
      report_type: "invisible_red_line",
      title: `${IRL_REPORT_PUBLIC_TITLE} – ${userName}`,
      data: {
        diagnosticVersion: 3,
        generatedAt: new Date().toISOString(),
        profile: { name: userName, email },
        metrics,
        intakeTranscript: transcript,
        aiReport: reportText,       // Stage 1 full report
        irlReport,                  // Stage 2 IRL report (Phase 4 stub = same as Stage 1 until built)
        structuredPacket,           // Stage 1 extraction — available for market research (Phase 8)
        funnelMode: true,
      },
    })
  );

  // Generate PDF
  let pdfUrl = null;
  let pdfLocalPath = null;
  let pdfUpload = null;
  try {
    pdfLocalPath = await generateIrlReportPdf(diagnostic);
    if (pdfLocalPath) {
      const buffer = await fs.promises.readFile(pdfLocalPath);
      pdfUpload = await uploadBufferToSupabase({
        buffer,
        objectPath: `funnel-reports/irl-${diagnostic.id}-${Date.now()}.pdf`,
        contentType: "application/pdf",
      });
      pdfUrl = pdfUpload?.url || null;
    }
  } catch (pdfErr) {
    console.error("[funnel] PDF generation failed:", pdfErr.message);
  }

  // Persist PDF URLs on both JSON `data` and top-level `pdfUrl` (hub + paid-style queries)
  await withDbSlot(() =>
    diagnostic.update({
      chatId: chat_id || diagnostic.chatId,
      pdfUrl: pdfUrl || diagnostic.pdfUrl,
      data: {
        ...diagnostic.data,
        ...(pdfUpload ? { pdf: pdfUpload, pdfUrl } : {}),
      },
    })
  );

  // Send report email (attach local PDF if available)
  try {
    await sendEmail(
      email,
      `${IRL_REPORT_PUBLIC_TITLE} – Euphoriam AI`,
      irlReportEmail(userName),
      pdfLocalPath || null
    );
  } catch (emailErr) {
    console.error("[funnel] Report email failed:", emailErr.message);
  }

  // Update funnel access counters
  await withDbSlot(() =>
    record.update({
      diagnostics_completed_count: record.diagnostics_completed_count + 1,
      last_diagnostic_at: new Date(),
      report_generated_count: record.report_generated_count + 1,
      report_last_sent_at: new Date(),
    })
  );

  // Mark chat as ended — merge `data` so transcript / funnel_access_id are preserved
  if (chat_id) {
    try {
      await withDbSlot(async () => {
        const ch = await Chat.findByPk(chat_id);
        if (!ch) return;
        await ch.update({
          isChatEnded: true,
          dignosticId: diagnostic.id,
          data: {
            ...(ch.data || {}),
            funnelMode: true,
            funnel_access_id: ch.data?.funnel_access_id || funnel_access_id,
            endedAt: new Date().toISOString(),
            diagnostic_id: String(diagnostic.id),
            pdfUrl: pdfUrl || ch.data?.pdfUrl || null,
          },
        });
      });
    } catch (e) {
      console.error("[funnel] Chat end update failed:", e.message);
    }
  }

  return {
    report_text: irlReport,
    pdf_url: pdfUrl,
    diagnostic_id: diagnostic.id,
  };
};

/**
 * GET /api/funnel/access-status
 * Returns the current access window status for the UI access-status bar.
 */
const getAccessStatus = async (req, res) => {
  const token = extractToken(req) || req.query.token;

  let record, decoded;
  try {
    ({ record, decoded } = await resolveToken(token));
  } catch (err) {
    return errorResponse(res, err.message, err.status || 401);
  }

  const status = checkAccess(record);

  return successResponse(res, "Access status", {
    ...status,
    email: decoded.email,
    first_accessed_at: record.first_accessed_at,
    expires_at: record.expires_at,
    report_generated_count: record.report_generated_count,
  });
};

/**
 * GET /api/funnel/expired
 * Returns the expiry reason and UC upgrade CTA for the expired page.
 */
const getExpiredMessage = async (req, res) => {
  const token = extractToken(req) || req.query.token;
  if (!token) {
    return successResponse(res, "Access expired", {
      reason: "no_token",
      message: "Your free diagnostic access has now expired.",
      uc_url: UC_SALES_URL,
    });
  }

  // Attempt DB lookup even if token is JWT-expired, so we can give a specific reason
  const decoded = verifyFunnelToken(token);
  let reason = "link_expired";

  if (decoded) {
    const record = await withDbSlot(() =>
      FunnelAccess.findOne({ where: { link_token: token } })
    );
    if (record) {
      const status = checkAccess(record);
      reason = status.reason === "ok" ? "not_expired" : status.reason;
    }
  }

  const messages = {
    link_expired: "Your free diagnostic link has expired. If you'd like to go deeper, the next step is Unlimited Creator.",
    access_expired: "Your 7-day free diagnostic access has expired. If you'd like ongoing access and deeper support, the next step is Unlimited Creator.",
    limit_reached: "You've used the free diagnostics included with this offer. If you'd like ongoing access, deeper support, and the full system, the next step is Unlimited Creator.",
    blocked: "Your access to the free diagnostic has been restricted. Please contact support if you believe this is an error.",
    not_expired: "Your access is still active.",
  };

  return successResponse(res, "Expiry status", {
    reason,
    message: messages[reason] || messages.link_expired,
    uc_url: UC_SALES_URL,
  });
};

/**
 * POST /api/funnel/resend-report
 * Re-sends the previously generated IRL report PDF to the user's email.
 */
const resendReport = async (req, res) => {
  const token = extractToken(req);

  let record, decoded;
  try {
    ({ record, decoded } = await resolveToken(token));
  } catch (err) {
    return errorResponse(res, err.message, err.status || 401);
  }

  if (record.report_generated_count === 0) {
    return errorResponse(res, "No report has been generated yet for this access", 404);
  }

  // Find the latest funnel diagnostic for this access record
  const diagnostic = await withDbSlot(() =>
    Diagnostic.findOne({
      where: {
        funnel_access_id: record.id,
        report_type: "invisible_red_line",
      },
      order: [["createdAt", "DESC"]],
    })
  );

  if (!diagnostic) {
    return errorResponse(res, "No diagnostic report found for this access", 404);
  }

  const email = decoded.email;
  const userName = email.split("@")[0];
  const irlReport = diagnostic.data?.irlReport || diagnostic.data?.aiReport || "";
  const pdfPath = diagnostic.data?.pdf?.path || null;

  try {
    await sendEmail(
      email,
      `${IRL_REPORT_PUBLIC_TITLE} – Euphoriam AI (Resent)`,
      irlReportEmail(userName),
      pdfPath
    );
  } catch (emailErr) {
    return errorResponse(res, `Failed to send email: ${emailErr.message}`, 500);
  }

  // Update last sent timestamp
  await withDbSlot(() =>
    record.update({ report_last_sent_at: new Date() })
  );

  return successResponse(res, "Report resent successfully", { sent: true });
};

/**
 * GET /api/funnel/report/:diagnosticId
 * Returns the sanitised IRL report for display on the frontend report page.
 *
 * Security: Only returns data if the requesting funnel token belongs to the
 * same FunnelAccess record that created this diagnostic.
 *
 * Never exposes: structuredPacket, raw transcript, system prompts, aiReport (Stage 1 internal).
 */
const getReport = async (req, res) => {
  const token = extractToken(req) || req.query.token;
  const { diagnosticId } = req.params;

  if (!diagnosticId) {
    return errorResponse(res, "diagnosticId is required", 400);
  }

  let record, decoded;
  try {
    ({ record, decoded } = await resolveToken(token));
  } catch (err) {
    return errorResponse(res, err.message, err.status || 401);
  }

  const diagnostic = await withDbSlot(() =>
    Diagnostic.findOne({
      where: {
        id: diagnosticId,
        funnel_access_id: record.id, // Ensures the token owner matches this diagnostic
        report_type: "invisible_red_line",
      },
    })
  );

  if (!diagnostic) {
    return errorResponse(res, "Report not found or access denied", 404);
  }

  // Return only the fields the frontend needs — never expose internal data
  return successResponse(res, "Report retrieved", {
    diagnostic_id: diagnostic.id,
    report_text: diagnostic.data?.irlReport || diagnostic.data?.aiReport || "",
    pdf_url: diagnostic.data?.pdfUrl || diagnostic.data?.pdf?.url || null,
    created_at: diagnostic.createdAt,
    // Safe summary fields (no EO/lack/avoid specifics, no constraint packet)
    structure_type: diagnostic.data?.structuredPacket?.diagnostic_packet?.structure_type || null,
    domain_primary: diagnostic.data?.structuredPacket?.diagnostic_packet?.domain_primary || null,
  });
};

/**
 * GET /api/funnel/report/:diagnosticId/pdf
 * Streams a freshly generated IRL PDF to ensure formatting fixes are applied,
 * even if an older PDF was previously uploaded and cached.
 */
const downloadReportPdf = async (req, res) => {
  const token = extractToken(req) || req.query.token;
  const { diagnosticId } = req.params;

  if (!diagnosticId) {
    return errorResponse(res, "diagnosticId is required", 400);
  }

  let record;
  try {
    ({ record } = await resolveToken(token));
  } catch (err) {
    return errorResponse(res, err.message, err.status || 401);
  }

  const diagnostic = await withDbSlot(() =>
    Diagnostic.findOne({
      where: {
        id: diagnosticId,
        funnel_access_id: record.id,
        report_type: "invisible_red_line",
      },
    })
  );

  if (!diagnostic) {
    return errorResponse(res, "Report not found or access denied", 404);
  }

  let localPath;
  try {
    localPath = await generateIrlReportPdf(diagnostic);
  } catch (err) {
    return errorResponse(res, `Failed to generate PDF: ${err.message}`, 500);
  }

  try {
    const filenameSafe = `irl-${diagnostic.id}.pdf`;
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${filenameSafe}"`);

    const stat = fs.statSync(localPath);
    res.setHeader("Content-Length", String(stat.size));

    // Stream the generated PDF file
    fs.createReadStream(localPath).pipe(res);
  } catch (err) {
    return errorResponse(res, `Failed to stream PDF: ${err.message}`, 500);
  }
};

/**
 * GET /api/funnel/diagnostics
 * Returns the list of completed IRL diagnostics for the current funnel user.
 * Used by the funnel hub page to show "Your Reports".
 */
const getMyDiagnostics = async (req, res) => {
  const token = extractToken(req) || req.query.token;

  let record, decoded;
  try {
    ({ record, decoded } = await resolveToken(token));
  } catch (err) {
    return errorResponse(res, err.message, err.status || 401);
  }

  const diagnostics = await withDbSlot(() =>
    Diagnostic.findAll({
      where: {
        funnel_access_id: record.id,
        report_type: "invisible_red_line",
      },
      order: [["createdAt", "DESC"]],
      attributes: ["id", "createdAt", "data", "pdfUrl", "chatId"],
    })
  );

  const list = diagnostics.map((d) => ({
    id: d.id,
    created_at: d.createdAt,
    pdf_url: d.pdfUrl || d.data?.pdfUrl || d.data?.pdf?.url || null,
    structure_type: d.data?.structuredPacket?.diagnostic_packet?.structure_type || null,
    domain_primary: d.data?.structuredPacket?.diagnostic_packet?.domain_primary || null,
  }));

  return successResponse(res, "Diagnostics retrieved", { diagnostics: list });
};

/**
 * GET /api/funnel/chats
 * Sidebar history: load chats by userId (same idea as paid getChatHistory), keep funnel IRL rows for
 * this access only, and omit open sessions with no persisted transcript (avoids startDiagnostic stubs).
 */
const getMyFunnelChats = async (req, res) => {
  const token = extractToken(req) || req.query.token;

  let record;
  let decoded;
  try {
    ({ record, decoded } = await resolveToken(token));
  } catch (err) {
    return errorResponse(res, err.message, err.status || 401);
  }

  const user = await withDbSlot(() => User.findOne({ where: { email: decoded.email } }));
  if (!user) {
    return successResponse(res, "Chats retrieved", { chats: [] });
  }

  const accessId = String(record.id);

  const allChats = await withDbSlot(() =>
    Chat.findAll({
      where: { userId: user.id },
      order: [["createdAt", "DESC"]],
      limit: 100,
      attributes: [
        "id",
        "userId",
        "dignosticId",
        "discoveryId",
        "chatType",
        "isChatEnded",
        "data",
        "createdAt",
        "updatedAt",
      ],
    }),
  );

  const funnelForAccess = allChats.filter((c) => {
    const d = c.data || {};
    const funnelModeOn = d.funnelMode === true || d.funnelMode === "true";
    const irl = d.report_type === "invisible_red_line";
    if (!(funnelModeOn || irl)) return false;
    return String(d.funnel_access_id ?? "") === accessId;
  });

  const withSidebarTranscript = funnelForAccess.filter((c) => {
    const msgCount = normalizeFunnelTranscriptRowsFromChatData(c.data || {}).length;
    if (msgCount > 0) return true;
    if (c.isChatEnded) return true;
    return false;
  });

  const incomplete = withSidebarTranscript.filter((c) => !c.isChatEnded);
  const complete = withSidebarTranscript.filter((c) => c.isChatEnded);
  incomplete.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
  complete.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  // At most one open thread per access (legacy duplicates collapse to the latest).
  const deduped = [...(incomplete.length ? [incomplete[0]] : []), ...complete].slice(0, 25);

  const list = deduped.map((c) => {
    const diagnostic_id = funnelChatLinkedDiagnosticId(c);
    return {
      id: c.id,
      created_at: c.createdAt,
      updated_at: c.updatedAt,
      /** Q&A closed and a diagnostic report row is linked (sidebar complete). */
      ended: Boolean(c.isChatEnded && diagnostic_id != null),
      /** Raw DB flag: false = messages can still be appended for this thread. */
      is_chat_ended: Boolean(c.isChatEnded),
      diagnostic_id,
      message_count: normalizeFunnelTranscriptRowsFromChatData(c.data || {}).length,
    };
  });

  return successResponse(res, "Chats retrieved", { chats: list });
};

/**
 * DELETE /api/funnel/chats/:chatId
 * Remove an in-progress funnel Q&A row, or a closed thread that has no linked report yet.
 * Same auth as GET /api/funnel/chat/:chatId. Cannot delete once a diagnostic is linked.
 */
const deleteFunnelChat = async (req, res) => {
  const token = extractToken(req) || req.query.token;
  const rawId = req.params.chatId;
  const chatId = rawId != null ? parseInt(String(rawId), 10) : NaN;

  if (!token) {
    return errorResponse(res, "Token is required", 401);
  }
  if (!Number.isFinite(chatId)) {
    return errorResponse(res, "chatId is required", 400);
  }

  let record;
  let decoded;
  try {
    ({ record, decoded } = await resolveToken(token));
  } catch (err) {
    return errorResponse(res, err.message, err.status || 401);
  }

  const user = await withDbSlot(() => User.findOne({ where: { email: decoded.email } }));
  if (!user) {
    return errorResponse(res, "User not found", 404);
  }

  const outcome = await withDbSlot(async () => {
    const chat = await Chat.findByPk(chatId);
    if (!chat) return "not_found";
    if (Number(chat.userId) !== Number(user.id)) return "forbidden";
    const d = chat.data || {};
    if (String(d.funnel_access_id) !== String(record.id)) return "forbidden";
    if (d.funnelMode !== true && d.report_type !== "invisible_red_line") return "not_funnel";
    const diagnosticId = funnelChatLinkedDiagnosticId(chat);
    if (chat.isChatEnded && diagnosticId != null) return "has_report";
    await Diagnostic.update({ chatId: null }, { where: { chatId: chat.id } });
    await chat.destroy();
    return "ok";
  });

  if (outcome === "not_found") {
    return errorResponse(res, "Chat not found", 404);
  }
  if (outcome === "forbidden") {
    return errorResponse(res, "Access denied", 403);
  }
  if (outcome === "not_funnel") {
    return errorResponse(res, "Not a funnel diagnostic chat", 403);
  }
  if (outcome === "has_report") {
    return errorResponse(
      res,
      "This session already has a linked report and cannot be deleted. Open it from Past Reports.",
      400
    );
  }

  try {
    await deleteChatFromVectorDB(chatId);
  } catch (e) {
    console.warn("[deleteFunnelChat] Vector DB cleanup failed:", e.message || e);
  }

  return successResponse(res, "Chat deleted", { id: chatId });
};

/**
 * POST /api/funnel/socket-session
 * Issue a short-lived funnel_session JWT for an existing in-progress chat so the
 * client can reconnect Socket.IO and continue Q&A (same chat_id as paid flow pattern).
 */
const issueFunnelSocketSession = async (req, res) => {
  const token = extractToken(req);
  const rawId = req.body?.chat_id ?? req.body?.chatId;
  const chatId = rawId != null ? parseInt(String(rawId), 10) : NaN;

  if (!token) {
    return errorResponse(res, "Token is required", 401);
  }
  if (!Number.isFinite(chatId)) {
    return errorResponse(res, "chat_id is required", 400);
  }

  let record;
  let decoded;
  try {
    ({ record, decoded } = await resolveToken(token));
  } catch (err) {
    return errorResponse(res, err.message, err.status || 401);
  }

  const user = await withDbSlot(() => User.findOne({ where: { email: decoded.email } }));
  if (!user) {
    return errorResponse(res, "User not found", 404);
  }

  const chat = await withDbSlot(() => Chat.findByPk(chatId));
  if (!chat) {
    return errorResponse(res, "Chat not found", 404);
  }
  if (chat.userId !== user.id) {
    return errorResponse(res, "Access denied", 403);
  }
  const d = chat.data || {};
  if (String(d.funnel_access_id) !== String(record.id)) {
    return errorResponse(res, "Access denied", 403);
  }
  if (d.funnelMode !== true && d.report_type !== "invisible_red_line") {
    return errorResponse(res, "Not a funnel diagnostic chat", 403);
  }
  if (chat.isChatEnded && funnelChatLinkedDiagnosticId(chat) != null) {
    return errorResponse(res, "This Q&A session is already complete. Open the report from Past Reports.", 400);
  }

  const sessionToken = generateFunnelSessionToken({
    email: decoded.email,
    funnel_access_id: record.id,
    chat_id: chat.id,
  });

  return successResponse(res, "Socket session issued", {
    session_token: sessionToken,
    chat_id: chat.id,
  });
};

/**
 * GET /api/funnel/chat/:chatId
 * Read-only transcript for one funnel chat (token must own the session).
 */
const getFunnelChatTranscript = async (req, res) => {
  const token = extractToken(req) || req.query.token;
  const chatId = req.params.chatId;

  let record;
  let decoded;
  try {
    ({ record, decoded } = await resolveToken(token));
  } catch (err) {
    return errorResponse(res, err.message, err.status || 401);
  }

  if (!chatId) {
    return errorResponse(res, "chatId is required", 400);
  }

  const user = await withDbSlot(() => User.findOne({ where: { email: decoded.email } }));
  if (!user) {
    return errorResponse(res, "User not found", 404);
  }

  const chat = await withDbSlot(() => Chat.findByPk(chatId));
  if (!chat) {
    return errorResponse(res, "Chat not found", 404);
  }

  if (chat.userId !== user.id) {
    return errorResponse(res, "Access denied", 403);
  }

  const chatAccessId = chat.data?.funnel_access_id;
  if (String(chatAccessId) !== String(record.id)) {
    return errorResponse(res, "Access denied", 403);
  }

  const transcript = normalizeFunnelTranscriptRowsFromChatData(chat.data || {});
  const diagnostic_id = funnelChatLinkedDiagnosticId(chat);
  const ended = Boolean(chat.isChatEnded && diagnostic_id != null);

  return successResponse(res, "Chat transcript", {
    id: chat.id,
    created_at: chat.createdAt,
    ended,
    is_chat_ended: Boolean(chat.isChatEnded),
    diagnostic_id,
    transcript,
  });
};

module.exports = {
  createToken,
  validateToken,
  startDiagnostic,
  completeDiagnostic,
  getAccessStatus,
  getExpiredMessage,
  resendReport,
  getReport,
  downloadReportPdf,
  getMyDiagnostics,
  getMyFunnelChats,
  deleteFunnelChat,
  getFunnelChatTranscript,
  issueFunnelSocketSession,
};
