const { Op } = require("sequelize");
const crypto = require("crypto");
const Joi = require("joi");
const { FunnelAccess } = require("../models/funnelAccessModel");
const { Diagnostic } = require("../models/diagnosticModel");
const { User } = require("../models/userModel");
const { Chat } = require("../models/chatModel");
const { Prompt } = require("../models/promptModel");
const { withDbSlot } = require("../config/sequelize");
const { successResponse, errorResponse } = require("../utils/response");
const {
  generateFunnelToken,
  verifyFunnelToken,
  generateFunnelSessionToken,
} = require("../utils/funnelToken");
const { sendEmail } = require("../utils/email");
const { generateDiagnosticPdf } = require("../utils/diagnosticPdf");
const { uploadBufferToSupabase } = require("../utils/storage");
const fs = require("fs");

// ── Constants ─────────────────────────────────────────────────────────────────

const MAX_DIAGNOSTICS = 3;
const LINK_VALIDITY_DAYS = 10;
const ACCESS_WINDOW_DAYS = 7;
const UC_SALES_URL = process.env.UC_SALES_URL || `${process.env.FRONTEND_URL || ""}/upgrade`;

// ── Validation schemas ────────────────────────────────────────────────────────

const createTokenSchema = Joi.object({
  email: Joi.string().email().required(),
  kajabi_offer_source: Joi.string().max(255).optional().allow(null, ""),
  ip: Joi.string().max(64).optional().allow(null, ""),
});

const tokenBodySchema = Joi.object({
  token: Joi.string().required(),
});

// ── Internal helpers ──────────────────────────────────────────────────────────

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

  if (now >= new Date(record.link_expiry)) {
    return { valid: false, reason: "link_expired", diagnostics_remaining: 0, days_remaining: 0, can_start_new: false };
  }

  if (record.first_accessed_at && now >= new Date(record.expires_at)) {
    return { valid: false, reason: "access_expired", diagnostics_remaining: 0, days_remaining: 0, can_start_new: false };
  }

  if (record.diagnostics_completed_count >= MAX_DIAGNOSTICS) {
    return { valid: false, reason: "limit_reached", diagnostics_remaining: 0, days_remaining: 0, can_start_new: false };
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
  // Validate Kajabi webhook secret header
  const kajabiSecret = process.env.KAJABI_WEBHOOK_SECRET;
  if (kajabiSecret) {
    const provided = req.headers["x-kajabi-secret"];
    if (!provided || provided !== kajabiSecret) {
      return errorResponse(res, "Unauthorized", 401);
    }
  }

  const { error, value } = createTokenSchema.validate(req.body, {
    abortEarly: false,
    stripUnknown: true,
  });
  if (error) {
    return errorResponse(res, error.details.map((d) => d.message).join(", "), 400);
  }

  const { email, kajabi_offer_source = null } = value;
  const clientIp = getClientIp(req) || value.ip || null;
  const now = new Date();
  const nonce = crypto.randomUUID();

  const token = generateFunnelToken({ email, kajabi_offer_source, nonce });

  const linkExpiry = new Date(now.getTime() + LINK_VALIDITY_DAYS * 24 * 60 * 60 * 1000);

  const record = await withDbSlot(() =>
    FunnelAccess.create({
      email,
      link_token: token,
      link_created_at: now,
      link_expiry: linkExpiry,
      kajabi_offer_source,
      ip_at_creation: clientIp,
    })
  );

  const frontendUrl = process.env.FRONTEND_URL || "";
  const link = `${frontendUrl}/diagnostic/funnel?token=${encodeURIComponent(token)}`;

  return successResponse(res, "Funnel access token created", {
    token,
    link,
    expires_at: linkExpiry.toISOString(),
    funnel_access_id: record.id,
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

  // Find or create super-base User record (builds market research base)
  let user = await withDbSlot(() => User.findOne({ where: { email } }));
  if (!user) {
    const userName = email.split("@")[0];
    user = await withDbSlot(() =>
      User.create({ email, name: userName })
    );
  }

  // Create a Chat record for this funnel session
  const chat = await withDbSlot(() =>
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
    })
  );

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

  // ── Stage 1: Extract structured packet from Stage 1 report ───────────────
  // TODO (Phase 3): Replace stub with real call once structuredPacketExtractor.js is built.
  // const { extractStructuredPacket } = require("../helpers/structuredPacketExtractor");
  // const structuredPacket = await extractStructuredPacket({ reportText, transcript, existingMetrics: metrics });
  const structuredPacket = null; // Phase 3 stub

  // ── Stage 2: Generate Invisible Red Line Report ───────────────────────────
  // TODO (Phase 4): Replace stub with real call once irlReportGenerator.js is built.
  // const { generateInvisibleRedLineReport } = require("../helpers/irlReportGenerator");
  // const irlReport = await generateInvisibleRedLineReport({ ... structuredPacket, offer_config: defaultOfferConfig });
  const irlReport = reportText; // Phase 4 stub — use Stage 1 report until IRL generator is ready

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
      title: `Invisible Red Line Report – ${userName}`,
      data: {
        diagnosticVersion: 3,
        generatedAt: new Date().toISOString(),
        profile: { name: userName, email },
        metrics,
        intakeTranscript: transcript,
        aiReport: reportText,
        irlReport,
        structuredPacket,
        funnelMode: true,
      },
    })
  );

  // Generate PDF
  let pdfUrl = null;
  try {
    const pdfPath = await generateDiagnosticPdf(diagnostic);
    if (pdfPath) {
      const buffer = await fs.promises.readFile(pdfPath);
      const upload = await uploadBufferToSupabase({
        buffer,
        objectPath: `funnel-reports/irl-${diagnostic.id}-${Date.now()}.pdf`,
        contentType: "application/pdf",
      });
      pdfUrl = upload?.url || null;
      await withDbSlot(() =>
        diagnostic.update({ data: { ...diagnostic.data, pdf: upload, pdfUrl } })
      );
    }
  } catch (pdfErr) {
    console.error("[funnel] PDF generation failed:", pdfErr.message);
  }

  // Send report email
  try {
    await sendEmail(
      email,
      "Your Invisible Red Line Report – Euphoriam AI",
      buildIrlReportEmail({ name: userName, reportText: irlReport }),
      null
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

  // Mark chat as ended
  if (chat_id) {
    try {
      await withDbSlot(() =>
        Chat.update(
          { isChatEnded: true, data: { funnelMode: true, endedAt: new Date().toISOString() } },
          { where: { id: chat_id } }
        )
      );
    } catch {}
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
      "Your Invisible Red Line Report – Euphoriam AI (Resent)",
      buildIrlReportEmail({ name: userName, reportText: irlReport }),
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

// ── Email template helper ─────────────────────────────────────────────────────

const buildIrlReportEmail = ({ name, reportText }) => {
  const formattedReport = (reportText || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\n/g, "<br />");

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
</head>
<body style="font-family: Arial, sans-serif; color: #222; line-height: 1.7; max-width: 680px; margin: 0 auto; padding: 20px;">
  <h2 style="color: #1a1a1a;">Your Invisible Red Line Report</h2>
  <p>Hi ${name || "there"},</p>
  <p>Here is your personalised Invisible Red Line Report based on your Euphoriam AI Diagnostic.</p>
  <div style="background: #f9f9f9; padding: 24px; border-radius: 8px; margin: 24px 0; border-left: 4px solid #6b46c1; white-space: pre-wrap; font-size: 15px; line-height: 1.8;">
${formattedReport}
  </div>
  <p style="margin-top: 24px;">— Euphoriam AI</p>
</body>
</html>`;
};

module.exports = {
  createToken,
  validateToken,
  startDiagnostic,
  completeDiagnostic,
  getAccessStatus,
  getExpiredMessage,
  resendReport,
};
