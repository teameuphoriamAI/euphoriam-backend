const { Chat } = require("../models/chatModel");
const { Diagnostic } = require("../models/diagnosticModel");
const { withDbSlot } = require("../config/sequelize");
const { successResponse, errorResponse } = require("../utils/response");
const { ChatType } = require("../utils/types");
const { signFunnelSession } = require("../helpers/funnelToken");
const {
  ensureFunnelAccess,
  resolveFunnelAccessFromToken,
  markFirstAccess,
  computeAccessStatus,
  issueSessionForAccess,
  listFunnelDiagnostics,
} = require("../helpers/funnelAccess");
const { generateDiagnosticPdf } = require("../utils/diagnosticPdf");
const { uploadBufferToSupabase } = require("../utils/storage");
const { sendEmail } = require("../utils/email");
const { diagnosticReportEmail } = require("../utils/emailTemplate/initialDignosticReport");
const fs = require("fs").promises;

/** GET /api/funnel/access-status */
const getAccessStatus = async (req, res) => {
  const status = computeAccessStatus(req.funnelAccess);
  return successResponse(res, "Funnel access status", status);
};

/** POST /api/funnel/validate-token */
const validateToken = async (req, res) => {
  const raw = req.body?.token || req.query?.token;
  if (!raw) return errorResponse(res, "token is required", 400);

  let row = await resolveFunnelAccessFromToken(raw);
  if (!row) return errorResponse(res, "Invalid or expired link", 401);

  if (!row.first_accessed_at) {
    row = (await markFirstAccess(row.id)) || row;
  }

  const session = issueSessionForAccess(row);
  const status = computeAccessStatus(row);

  return successResponse(res, "Token valid", {
    ...session,
    ...status,
  });
};

/** GET /api/funnel/diagnostics */
const listDiagnostics = async (req, res) => {
  const diagnostics = await listFunnelDiagnostics(req.funnelAccess);
  return successResponse(res, "Funnel diagnostics", { diagnostics });
};

/** POST /api/funnel/start-diagnostic */
const startDiagnostic = async (req, res) => {
  const status = computeAccessStatus(req.funnelAccess);
  if (!status.can_start_new) {
    return errorResponse(
      res,
      status.reason === "limit_reached"
        ? "You have used all free diagnostics."
        : "Free access is not available.",
      403,
      { reason: status.reason || "not_allowed" },
    );
  }

  const email = req.funnelAccess.email;
  const chat = await withDbSlot(() =>
    Chat.create({
      userId: null,
      chatType: ChatType.DIAGNOSTIC,
      isChatEnded: false,
      data: {
        email,
        funnel_access_id: req.funnelAccess.id,
        phase: "funnel",
        transcript: [],
        targetCount: 25,
      },
    }),
  );

  const session_token = signFunnelSession({
    funnel_access_id: req.funnelAccess.id,
    email,
    chat_id: chat.id,
  });

  return successResponse(res, "Diagnostic session started", {
    session_token,
    chat_id: chat.id,
    email,
  });
};

/** POST /api/funnel/socket-session */
const socketSession = async (req, res) => {
  const chatId = Number(req.body?.chat_id);
  if (!chatId) return errorResponse(res, "chat_id is required", 400);

  const chat = await withDbSlot(() => Chat.findByPk(chatId));
  if (!chat) return errorResponse(res, "Chat not found", 404);

  const data = chat.data || {};
  if (
    data.funnel_access_id &&
    data.funnel_access_id !== req.funnelAccess.id
  ) {
    return errorResponse(res, "Chat does not belong to this funnel user", 403);
  }

  const session_token = signFunnelSession({
    funnel_access_id: req.funnelAccess.id,
    email: req.funnelAccess.email,
    chat_id: chatId,
  });

  return successResponse(res, "Socket session", {
    session_token,
    chat_id: chatId,
  });
};

/** GET /api/funnel/chats */
const listChats = async (req, res) => {
  const rows = await withDbSlot(() =>
    Chat.findAll({
      where: { chatType: ChatType.DIAGNOSTIC },
      order: [["updatedAt", "DESC"]],
      limit: 30,
      raw: true,
    }),
  );

  const chats = rows
    .filter((c) => {
      const d = c.data || {};
      return (
        d.funnel_access_id === req.funnelAccess.id ||
        (d.email &&
          String(d.email).toLowerCase() === req.funnelAccess.email.toLowerCase())
      );
    })
    .map((c) => {
      const d = c.data || {};
      const transcript = Array.isArray(d.transcript) ? d.transcript : [];
      return {
        id: c.id,
        created_at: c.createdAt,
        updated_at: c.updatedAt,
        ended: Boolean(c.isChatEnded),
        message_count: transcript.length,
        title: d.title || `Diagnostic #${c.id}`,
      };
    });

  return successResponse(res, "Funnel chats", { chats });
};

/** GET /api/funnel/chat/:chatId */
const getChat = async (req, res) => {
  const chatId = Number(req.params.chatId);
  const chat = await withDbSlot(() => Chat.findByPk(chatId));
  if (!chat) return errorResponse(res, "Chat not found", 404);

  const data = chat.data || {};
  if (
    data.funnel_access_id &&
    data.funnel_access_id !== req.funnelAccess.id
  ) {
    return errorResponse(res, "Forbidden", 403);
  }

  const transcript = Array.isArray(data.transcript) ? data.transcript : [];
  return successResponse(res, "Chat transcript", {
    chat_id: chat.id,
    transcript,
    ended: Boolean(chat.isChatEnded),
    email: data.email || req.funnelAccess.email,
  });
};

/** GET /api/funnel/report/:diagnosticId */
const getReport = async (req, res) => {
  const id = Number(req.params.diagnosticId);
  const diagnostic = await withDbSlot(() => Diagnostic.findByPk(id));
  if (!diagnostic) return errorResponse(res, "Report not found", 404);

  const emailMatch =
    diagnostic.email &&
    String(diagnostic.email).toLowerCase() === req.funnelAccess.email.toLowerCase();

  if (!emailMatch) {
    return errorResponse(res, "Report not found", 404);
  }

  const data = diagnostic.data || {};
  const reportHtml =
    data.aiReport || data.report || data.irl_report || diagnostic.report || "";

  if (req.query.format === "pdf" && diagnostic.pdfUrl) {
    return res.redirect(diagnostic.pdfUrl);
  }

  return successResponse(res, "Report", {
    diagnostic_id: diagnostic.id,
    email: diagnostic.email,
    pdf_url: diagnostic.pdfUrl,
    report: reportHtml,
    report_text: reportHtml,
    created_at: diagnostic.createdAt,
    data,
  });
};

/**
 * Persist funnel diagnostic after Q1–Q25 + full report generation (socket finalize).
 */
const completeDiagnostic = async ({
  funnel_access_id,
  email,
  transcript = [],
  reportText = "",
  metrics = {},
  chat_id = null,
}) => {
  const userName = email?.split("@")[0] || "User";
  const diagnostic = await withDbSlot(() =>
    Diagnostic.create({
      email,
      funnel_access_id: funnel_access_id || null,
      title: `Euphoriam Diagnostic — ${userName}`,
      data: {
        diagnosticVersion: 3,
        generatedAt: new Date(),
        profile: { name: userName, email },
        metrics,
        intakeTranscript: transcript,
        aiReport: reportText,
        funnelMode: true,
      },
    }),
  );

  if (funnel_access_id) {
    await withDbSlot(() =>
      require("../config/sequelize").sequelize.query(
        `UPDATE funnel_access
         SET diagnostics_completed_count = COALESCE(diagnostics_completed_count, 0) + 1,
             report_generated_count = COALESCE(report_generated_count, 0) + 1,
             "updatedAt" = NOW()
         WHERE id = :id`,
        { replacements: { id: funnel_access_id } },
      ),
    );
  }

  let pdfUrl = null;
  try {
    const pdfPath = await generateDiagnosticPdf(diagnostic);
    if (pdfPath) {
      const buffer = await fs.readFile(pdfPath);
      const upload = await uploadBufferToSupabase({
        buffer,
        objectPath: `funnel-reports/diagnostic-${diagnostic.id}.pdf`,
        contentType: "application/pdf",
      });
      pdfUrl = upload.url || null;
      await diagnostic.update({
        pdfUrl,
        data: {
          ...diagnostic.data,
          pdf: upload,
          pdfUrls: pdfUrl ? [pdfUrl] : [],
        },
      });
      try {
        await sendEmail(
          email,
          "Your Diagnostic Report – Euphoriam AI",
          diagnosticReportEmail(userName),
          pdfPath,
        );
      } catch (emailErr) {
        console.warn("[completeDiagnostic] Email failed:", emailErr.message);
      }
    }
  } catch (pdfErr) {
    console.warn("[completeDiagnostic] PDF failed:", pdfErr.message);
  }

  if (chat_id) {
    const chat = await withDbSlot(() => Chat.findByPk(chat_id));
    if (chat) {
      await chat.update({
        isChatEnded: true,
        dignosticId: diagnostic.id,
        data: {
          ...(chat.data || {}),
          transcript,
          endedAt: new Date().toISOString(),
          diagnostic_id: diagnostic.id,
        },
      });
    }
  }

  return {
    diagnostic_id: diagnostic.id,
    pdf_url: pdfUrl,
    report_text: reportText,
  };
};

/** GET /api/funnel/report/:diagnosticId/pdf */
const getReportPdf = async (req, res) => {
  const id = Number(req.params.diagnosticId);
  const diagnostic = await withDbSlot(() => Diagnostic.findByPk(id));
  if (!diagnostic) return errorResponse(res, "Report not found", 404);

  const emailMatch =
    diagnostic.email &&
    String(diagnostic.email).toLowerCase() === req.funnelAccess.email.toLowerCase();

  if (!emailMatch) return errorResponse(res, "Report not found", 404);
  if (!diagnostic.pdfUrl) return errorResponse(res, "PDF not available", 404);

  return res.redirect(diagnostic.pdfUrl);
};

/** POST /api/funnel/resend-report */
const resendReport = async (_req, res) => {
  return errorResponse(res, "Resend report is not configured yet", 501);
};

/** GET /api/funnel/expired */
const getExpiredCopy = async (_req, res) => {
  return successResponse(res, "Expired", {
    title: "Free access ended",
    message:
      "Your 7-day window or 3 free diagnostics have been used. Upgrade to Unlimited Creator to continue.",
    cta_url: process.env.UC_SALES_URL || null,
  });
};

/** Helper for checkUser — free tier funnel link */
const buildFreeFunnelCheckUserResult = async (email) => {
  const row = await ensureFunnelAccess(email);
  const session = issueSessionForAccess(row);
  return {
    funnel_redirect: true,
    link: session.link,
    token: session.token,
    expires_at: session.expires_at,
  };
};

module.exports = {
  getAccessStatus,
  validateToken,
  listDiagnostics,
  startDiagnostic,
  socketSession,
  listChats,
  getChat,
  getReport,
  getReportPdf,
  resendReport,
  getExpiredCopy,
  buildFreeFunnelCheckUserResult,
  completeDiagnostic,
};
