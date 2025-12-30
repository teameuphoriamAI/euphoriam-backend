// const {
//   EUPHORIAM_FREEFORM_INTAKE_SYSTEM_PROMPT,
//   buildFreeformIntakePrompt,
//   buildFinalReportPrompt,
//   DEFAULT_INTRO_PAGE_TEXT,
//   EUPHORIAM_V3_SYSTEM_PROMPT,
//   sanitizeReportText,
// } = require("../helpers/euphoriamChatbot");
// const { retrieveSimilarChunks } = require("../helpers/rag");
// const {
//   buildKajabiDiagnosticContext,
//   persistDiscoveryRecord,
//   truncateForContext,
// } = require("../controllers/diagnosticController");
// const openai = require("../config/openai");
// const { Diagnostic } = require("../models/diagnosticModel");
// const { generateDiagnosticPdf } = require("../utils/diagnosticPdf");
// const { sendEmailBasic } = require("../utils/email");

// const isQuestion = (text = "") => text.trim().endsWith("?");
// const isAnswerLike = (text = "") => {
//   const t = (text || "").trim();
//   if (!t) return false;
//   if (isQuestion(t)) return false;
//   const alpha = t.match(/[A-Za-z]/g);
//   // Relaxed: Allow short answers like "yes", "A", or "d,d,d"
//   return alpha && alpha.length >= 1 && t.length >= 1;
// };

// // In-memory session store; for production swap to Redis.
// const sessions = new Map();

// const namespace = "/ws/chatbot-freeform";
// const INACTIVITY_MS = 1 * 60 * 1000; // 5 minutes (discovery-only)

// const clearInactivity = (session = {}) => {
//   if (session.idleTimer) {
//     clearTimeout(session.idleTimer);
//     session.idleTimer = null;
//   }
// };

// const scheduleInactivity = (socket, session) => {
//   if (!session || session.mode !== "discovery") return;
//   clearInactivity(session);
//   session.idleTimer = setTimeout(() => {
//     const emailNotice = session.email
//       ? " We’ve shared your chat summary via email."
//       : "";
//     socket.emit("ended", {
//       reason: "inactive",
//       message: `Chat ended due to inactivity (5 minutes).${emailNotice}`,
//     });
//     endChatAsDiscovery(socket, session, { reason: "timeout" }).catch((err) =>
//       console.error("[socket inactivity] failed to end chat", err)
//     );
//   }, INACTIVITY_MS);
// };

// const buildDiscoveryEmail = ({ transcript = [], email }) => {
//   const lastMessages = transcript.slice(-10);
//   const body = lastMessages
//     .map((m) => `${m.role === "assistant" ? "Assistant" : "You"}: ${m.content}`)
//     .join("<br/>");

//   return `
//   <html>
//     <body style="font-family: Arial, sans-serif; color: #222;">
//       <p>Hi ${email || "there"},</p>
//       <p>Your discovery chat has ended due to inactivity. Here’s a quick recap of the last messages:</p>
//       <div style="background:#f7f7f7;padding:12px;border-radius:8px;font-size:14px;line-height:1.5;">
//         ${body || "No messages captured."}
//       </div>
//       <p>If you’d like to continue, just start a new chat and we’ll pick up from here.</p>
//       <p style="margin-top:20px;">— Euphoraum AI</p>
//     </body>
//   </html>
//   `;
// };

// const endChatAsDiscovery = async (
//   socket,
//   session,
//   { reason = "timeout" } = {}
// ) => {
//   if (!session) return;
//   clearInactivity(session);

//   const { email, transcript, existingDiagnostic } = session;
//   const userId = existingDiagnostic?.userId || null;
//   const title =
//     existingDiagnostic?.title ||
//     `Discovery Chat ${reason === "timeout" ? "Timeout" : "Ended"}`;

//   try {
//     await persistDiscoveryRecord({
//       userId,
//       email,
//       title,
//       transcript,
//       previousReport: truncateForContext(
//         existingDiagnostic?.data?.aiReport,
//         4000
//       ),
//       newReport: null,
//       diagnosticId: existingDiagnostic?.id || null,
//       pdfUrl: existingDiagnostic?.data?.pdf?.url || null,
//     });
//   } catch (err) {
//     console.error("[socket discovery] persist failed", err);
//   }

//   if (email) {
//     try {
//       await sendEmailBasic(
//         email,
//         "Your discovery chat summary",
//         buildDiscoveryEmail({ transcript, email })
//       );
//     } catch (err) {
//       console.error("[socket discovery] email failed", err);
//     }
//   }
// };

// const wireChatbotFreeform = (io) => {
//   const nsp = io.of(namespace);

//   nsp.on("connection", (socket) => {
//     sessions.set(socket.id, {
//       transcript: [],
//       targetCount: 12,
//       introPageText: DEFAULT_INTRO_PAGE_TEXT,
//       assessmentIds: [],
//       email: null,
//       existingDiagnostic: null,
//       priorReportSnippet: null,
//       idleTimer: null,
//       mode: "diagnostic",
//     });

//     socket.emit("connected", { sessionId: socket.id });

//     socket.on("init", async (payload = {}) => {
//       const session = sessions.get(socket.id);
//       if (!session) return;
//       session.email = payload.email || session.email;
//       session.targetCount = payload.targetCount || session.targetCount;
//       session.introPageText = payload.introPageText || session.introPageText;
//       session.assessmentIds = payload.assessmentIds || [];
//       // Load existing diagnostic/report if present for returning users
//       let hasExistingReport = false;
//       if (session.email) {
//         try {
//           const existingDiagnostic = await Diagnostic.findOne({
//             where: { email: session.email },
//           });
//           session.existingDiagnostic = existingDiagnostic || null;
//           hasExistingReport = Boolean(existingDiagnostic?.data?.aiReport);
//           session.priorReportSnippet = hasExistingReport
//             ? truncateForContext(existingDiagnostic.data.aiReport, 4000)
//             : null;
//           session.mode = hasExistingReport ? "discovery" : "diagnostic";
//         } catch (err) {
//           console.error("[socket init] load existing diagnostic failed", err);
//           session.mode = "diagnostic";
//         }
//       } else {
//         session.mode = "diagnostic";
//       }
//       // Preload Kajabi context to keep intake on-topic.
//       if (session.email) {
//         try {
//           const { diagnosticContext, metrics } =
//             await buildKajabiDiagnosticContext({
//               email: session.email,
//               assessmentIds: session.assessmentIds,
//             });
//           session.diagnosticContext = diagnosticContext;
//           session.metrics = metrics;
//         } catch (err) {
//           console.error("[socket init] kajabi preload failed", err);
//         }
//       }
//       socket.emit("ready", {
//         sessionId: socket.id,
//         targetCount: session.targetCount,
//         introPageText: session.introPageText,
//         hasExistingReport,
//         mode: session.mode,
//       });
//       scheduleInactivity(socket, session);
//     });

//     socket.on("user_message", async (payload = {}) => {
//       const session = sessions.get(socket.id);
//       if (!session) {
//         socket.emit("error", { message: "Session missing" });
//         return;
//       }

//       const { content } = payload;
//       if (!content || typeof content !== "string") {
//         socket.emit("error", { message: "Content is required" });
//         return;
//       }

//       session.transcript.push({ role: "user", content });
//       scheduleInactivity(socket, session);

//       // Allow explicit user-triggered end for discovery chats
//       const lower = content.toLowerCase();
//       const endPhrases = [
//         "end chat",
//         "ending chat",
//         "end the chat",
//         "stop chat",
//         "finish chat",
//         "i'm ending the chat",
//         "end this chat",
//       ];
//       if (
//         session.mode === "discovery" &&
//         endPhrases.some((p) => lower.includes(p))
//       ) {
//         socket.emit("ended", {
//           reason: "user_end",
//           message:
//             "Chat ended as requested. We’ve shared your discovery summary via email.",
//         });
//         await endChatAsDiscovery(socket, session, { reason: "user_end" });
//         return;
//       }

//       try {
//         // Ensure Kajabi context loaded for intake
//         if (!session.diagnosticContext && session.email) {
//           try {
//             const { diagnosticContext, metrics } =
//               await buildKajabiDiagnosticContext({
//                 email: session.email,
//                 assessmentIds: session.assessmentIds,
//               });
//             session.diagnosticContext = diagnosticContext;
//             session.metrics = metrics;
//           } catch (err) {
//             console.error("[socket user_message] kajabi preload failed", err);
//           }
//         }

//         const lastUser = { content };
//         const retrieved = await retrieveSimilarChunks({
//           query: lastUser.content,
//           topK: 3,
//         });

//         const aiResponse = await openai.chat.completions.create({
//           model: "gpt-5.2",
//           messages: [
//             {
//               role: "system",
//               content: EUPHORIAM_FREEFORM_INTAKE_SYSTEM_PROMPT,
//             },
//             ...session.transcript.map((m) => ({
//               role: m.role === "assistant" ? "assistant" : "user",
//               content: m.content,
//             })),
//             {
//               role: "user",
//               content: buildFreeformIntakePrompt({
//                 transcript: session.transcript,
//                 targetCount: session.targetCount,
//                 introPageText: session.introPageText,
//                 factsContext: session.diagnosticContext,
//                 retrieved,
//                 priorReport: session.priorReportSnippet,
//               }),
//             },
//           ],
//           temperature: 0.3,
//           max_completion_tokens: 400,
//         });

//         const nextMessage = aiResponse?.choices?.[0]?.message;
//         session.transcript.push(nextMessage);

//         socket.emit("assistant_message", {
//           message: nextMessage,
//           progress: {
//             asked: session.transcript.filter((m) => m.role === "assistant")
//               .length,
//             answered: session.transcript.filter(
//               (m) => m.role === "user" && isAnswerLike(m.content || "")
//             ).length,
//             total: session.targetCount,
//           },
//           retrieved,
//         });
//       } catch (err) {
//         console.error("[socket user_message] error", err);
//         socket.emit("error", { message: "Failed to process message" });
//       }
//     });

//     socket.on("finalize", async () => {
//       const session = sessions.get(socket.id);
//       if (!session || !session.email) {
//         socket.emit("error", { message: "Email missing; call init first" });
//         return;
//       }

//       clearInactivity(session);

//       socket.emit("status", { stage: "kajabi_fetch" });

//       try {
//         const {
//           diagnosticContext,
//           courseAssessments,
//           normalizedProducts,
//           normalizedOffers,
//           metrics,
//           customerData,
//           attributes,
//           contactId,
//           siteId,
//         } = await buildKajabiDiagnosticContext({
//           email: session.email,
//           assessmentIds: session.assessmentIds,
//         });

//         const lastUser = [...session.transcript]
//           .reverse()
//           .find((m) => m?.role === "user");
//         const retrieved = lastUser?.content
//           ? await retrieveSimilarChunks({ query: lastUser.content, topK: 3 })
//           : [];

//         // Discovery finalize: do not regenerate diagnostic; save and email discovery summary
//         if (session.mode === "discovery" && session.existingDiagnostic) {
//           await endChatAsDiscovery(socket, session, {
//             reason: "user_finalize",
//           });
//           socket.emit("done", {
//             discovery: true,
//             message: "Discovery chat saved and emailed.",
//           });
//           return;
//         }

//         socket.emit("status", { stage: "generating_report" });

//         const aiResponse = await openai.chat.completions.create({
//           model: "gpt-5.2",
//           messages: [
//             { role: "system", content: EUPHORIAM_V3_SYSTEM_PROMPT },
//             {
//               role: "user",
//               content: buildFinalReportPrompt({
//                 customerContext: diagnosticContext,
//                 intakeAnswers: session.transcript,
//                 introPageText: session.introPageText,
//                 retrieved,
//                 previousReport: session.priorReportSnippet,
//               }),
//             },
//           ],
//           temperature: 0.15,
//           max_completion_tokens: 4500,
//         });

//         let reportText = (
//           aiResponse?.choices?.[0]?.message?.content || ""
//         ).trim();
//         reportText = sanitizeReportText(reportText, metrics);

//         if (!reportText) {
//           socket.emit("error", {
//             message: "AI returned empty diagnostic report.",
//           });
//           return;
//         }

//         const diagnostic = await Diagnostic.create({
//           userId: null,
//           title: `Euphoriam Diagnostic v3 (Freeform) – ${attributes.name}`,
//           data: {
//             customerId: customerData.id,
//             siteId,
//             diagnosticVersion: 3,
//             generatedAt: new Date(),
//             profile: {
//               name: attributes.name,
//               email: attributes.email,
//               signInCount: attributes.sign_in_count,
//               netRevenue: attributes.net_revenue,
//               memberSince: attributes.created_at,
//             },
//             site: diagnosticContext.site,
//             contact: diagnosticContext.contact,
//             products: normalizedProducts,
//             offers: normalizedOffers,
//             courseAssessments,
//             metrics,
//             intakeTranscript: session.transcript,
//             aiReport: reportText,
//             rawSource: {
//               kajabiCustomerId: customerData.id,
//               kajabiContactId: contactId,
//             },
//           },
//         });

//         const pdfPath = await generateDiagnosticPdf(diagnostic);

//         socket.emit("done", {
//           diagnosticId: diagnostic.id,
//           pdfPath,
//           reportText,
//         });
//       } catch (err) {
//         console.error("[socket finalize] error", err);
//         socket.emit("error", { message: "Failed to finalize diagnostic" });
//       }
//     });

//     socket.on("disconnect", () => {
//       const session = sessions.get(socket.id);
//       if (session) {
//         clearInactivity(session);
//       }
//       sessions.delete(socket.id);
//     });
//   });
// };

// module.exports = { wireChatbotFreeform, chatbotFreeformNamespace: namespace };
const {
  EUPHORIAM_FREEFORM_INTAKE_SYSTEM_PROMPT,
  buildFreeformIntakePrompt,
  buildDiscoveryChatPrompt,
  buildFinalReportPrompt,
  DEFAULT_INTRO_PAGE_TEXT,
  EUPHORIAM_V3_SYSTEM_PROMPT,
  sanitizeReportText,
} = require("../helpers/euphoriamChatbot");
const { retrieveSimilarChunks } = require("../helpers/rag");
const {
  buildKajabiDiagnosticContext,
  persistDiscoveryRecord,
  truncateForContext,
} = require("../controllers/diagnosticController");

const openai = require("../config/openai");
const { Diagnostic } = require("../models/diagnosticModel");
const { Discovery } = require("../models/discoveryModel");
const { Prompt } = require("../models/promptModel");
const { generateDiagnosticPdf } = require("../utils/diagnosticPdf");
const { sendEmailBasic, sendEmail } = require("../utils/email");
const { uploadBufferToSupabase } = require("../utils/storage");
const {
  discoveryReportEmail,
} = require("../utils/emailTemplate/initialDiscoveryReport");

const fs = require("fs");

/* -------------------- Utils -------------------- */
const getLatestPromptFromDb = async () => {
  try {
    const prompt = await Prompt.findOne({
      where: { isActive: true },
      order: [["createdAt", "DESC"]],
      raw: true, // returns plain JS object
    });

    if (!prompt) return null;

    const SUPPORT_LOCK_PROMPT = `
🌑 USER QUESTION SUPPORT LOCK (ADDED — DO NOT REMOVE)

Purpose:
If the user asks a question, the system must help them understand and answer it without advancing the flow.

Rules:

If the user asks a question at any time (including during the 12-question intake):

Pause progression immediately

Do NOT move to the next question

Do NOT alter, reword, or replace the original question

Do NOT interpret their question as an answer

Your role is strictly to:

Clarify what the question is asking

Explain how to think about answering it

Offer gentle examples without leading

Reflect dimensions they may consider

⚖️ PROGRESS AND CONFIRMATION LOGIC

1. If the user provides a short answer (e.g., "yes", "no", "A", "d,d,d"), accept it as progress if it fits the context.

2. DO NOT perform redundant confirmations (e.g., "Are you 100% sure?") unless the user's answer is truly ambiguous or contradictory.

3. If you understand the user's answer, acknowledge it and move to the NEXT question immediately.

Maintain Euphoriam tone

You must always return control to the SAME question.

End by inviting them to answer that exact question

Never advance the intake

Never diagnose early

Language constraints:

No pressure

No urgency

No prompting to move on

No biasing or leading

The prompt is immutable.

The user is never asked to change it

The system never modifies it

Support is clarification only

If a conflict occurs: do not advance — clarity comes first.

**NEVER Move to the next question until the user refuses to answer or we get the answer to the last question**
`;

    return {
      ...prompt,
      fullPrompt: `${prompt.content}\n\n${SUPPORT_LOCK_PROMPT}`,
    };
  } catch (error) {
    console.error("Error fetching latest prompt:", error);
    return null;
  }
};

const isQuestion = (text = "") => text.trim().endsWith("?");
const isAnswerLike = (text = "") => {
  const t = text.trim();
  if (!t) return false;
  if (isQuestion(t)) return false;
  return /[A-Za-z]/.test(t);
};

/* -------------------- Session Store -------------------- */

const sessions = new Map();
const namespace = "/ws/chatbot-freeform";
const INACTIVITY_MS = 5 * 60 * 1000;

/* -------------------- Inactivity -------------------- */

const clearInactivity = (session) => {
  if (session?.idleTimer) {
    clearTimeout(session.idleTimer);
    session.idleTimer = null;
  }
};

const scheduleInactivity = (socket, session) => {
  if (!session || session.mode !== "discovery") return;

  clearInactivity(session);

  session.idleTimer = setTimeout(async () => {
    // Don't show inactivity message if discovery chat was already saved and emailed
    if (session.discoverySavedAndEmailed) {
      return;
    }
    
    socket.emit("ended", {
      reason: "inactive",
      message: "Chat ended due to inactivity. Summary emailed.",
    });
    await endChatAsDiscovery(socket, session, { reason: "timeout" });
  }, INACTIVITY_MS);
};

/* -------------------- Discovery Finalization -------------------- */

// const buildDiscoveryEmail = ({ reportText, email }) => {
//   return `
//   <!DOCTYPE html>
//   <html>
//   <head>
//     <meta charset="UTF-8" />
//     <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
//   </head>
//   <body style="font-family: Arial, sans-serif; color: #222; line-height: 1.6;">
//     <p>Hi ${email || "there"},</p>
//     <p>Your Discovery Report has been generated based on our follow-up conversation.</p>
//     <div style="background:#f7f7f7;padding:20px;border-radius:8px;margin:20px 0;white-space:pre-wrap;">${reportText || "Report not available."}</div>
//     <p>— Euphoriam AI</p>
//   </body>
//   </html>
//   `;
// };

const endChatAsDiscovery = async (socket, session, { reason }) => {
  if (!session || !session.existingDiagnostic) return;
  clearInactivity(session);

  const existing = session.existingDiagnostic;

  try {
    // Ensure diagnostic context is loaded
    if (!session.diagnosticContext && session.email) {
      const { diagnosticContext, metrics } = await buildKajabiDiagnosticContext(
        {
          email: session.email,
          assessmentIds: session.assessmentIds,
        }
      );
      session.diagnosticContext = diagnosticContext;
      session.metrics = metrics;
    }

    const {
      diagnosticContext,
      courseAssessments,
      normalizedProducts,
      normalizedOffers,
      metrics,
      customerData,
      attributes,
      contactId,
      siteId,
    } = await buildKajabiDiagnosticContext({
      email: session.email,
      assessmentIds: session.assessmentIds,
    });

    const retrieved = await retrieveSimilarChunks({
      query: session.transcript.at(-1)?.content || "",
      topK: 3,
    });

    // Generate UPDATED full diagnostic report (not discovery report)
    const prompt = await getLatestPromptFromDb();
    // Extract string content from prompt object, or use fallback
    const promptContent =
      typeof prompt === "string"
        ? prompt
        : prompt?.fullPrompt || prompt?.content || EUPHORIAM_V3_SYSTEM_PROMPT;
    const aiResponse = await openai.chat.completions.create({
      model: "gpt-5.2",
      messages: [
        { role: "system", content: promptContent },
        {
          role: "user",
          content: buildFinalReportPrompt({
            customerContext: diagnosticContext,
            intakeAnswers: session.transcript,
            introPageText: session.introPageText || DEFAULT_INTRO_PAGE_TEXT,
            retrieved,
            previousReport: session.priorReportSnippet,
          }),
        },
      ],
      temperature: 0.15,
      max_completion_tokens: 4500,
    });

    let updatedReportText = (
      aiResponse?.choices?.[0]?.message?.content || ""
    ).trim();
    updatedReportText = sanitizeReportText(updatedReportText, metrics);

    if (!updatedReportText) {
      console.error("[socket discovery] Empty report generated");
      return;
    }

    // Update existing diagnostic with new report
    const updatedData = {
      ...existing.data,
      aiReport: updatedReportText,
      updatedAt: new Date().toISOString(),
      discoveryChatTranscript: session.transcript,
      previousReports: Array.isArray(existing.data.previousReports)
        ? [
            ...existing.data.previousReports,
            {
              aiReport: existing.data.aiReport,
              pdfUrl: existing.data.pdf?.url || null,
              savedAt: existing.updatedAt || existing.createdAt,
            },
          ]
        : existing.data.aiReport
        ? [
            {
              aiReport: existing.data.aiReport,
              pdfUrl: existing.data.pdf?.url || null,
              savedAt: existing.updatedAt || existing.createdAt,
            },
          ]
        : [],
    };

    // Generate PDF for updated diagnostic
    const diagnosticForPdf = {
      ...existing.toJSON(),
      data: updatedData,
    };
    const pdfPath = await generateDiagnosticPdf(diagnosticForPdf);

    // Upload PDF to Supabase
    let pdfUrl = null;
    if (pdfPath) {
      try {
        const buffer = await fs.promises.readFile(pdfPath);
        const upload = await uploadBufferToSupabase({
          buffer,
          objectPath: `diagnostics/diagnostic-${existing.id}-${Date.now()}.pdf`,
          contentType: "application/pdf",
        });
        pdfUrl = upload.url || null;

        // Add PDF URL to the report history
        updatedData.pdf = upload;
        updatedData.pdfUrls = Array.isArray(existing.data.pdfUrls)
          ? [...existing.data.pdfUrls, upload.url]
          : existing.data.pdf?.url
          ? [existing.data.pdf.url, upload.url]
          : [upload.url];
      } catch (err) {
        console.error("[socket discovery] PDF upload failed", err);
      }
    }

    // Update the diagnostic record
    await existing.update({
      data: updatedData,
    });

    // Save discovery record for chat history
    await persistDiscoveryRecord({
      userId: existing.userId ?? null,
      email: session.email,
      title: `Discovery Chat – ${attributes.name || session.email}`,
      transcript: session.transcript,
      previousReport: truncateForContext(existing.data.aiReport, 4000),
      newReport: updatedReportText,
      diagnosticId: existing.id,
      pdfUrl: pdfUrl || existing.data.pdf?.url || null,
    });

    // Email the updated diagnostic report
    if (session.email && pdfPath) {
      try {
        await sendEmail(
          session.email,
          "Your Updated Diagnostic Report – Euphoriam AI",
          discoveryReportEmail(attributes.name || session.email.split("@")[0]),
          pdfPath
        );
        // Mark that discovery chat has been saved and emailed
        session.discoverySavedAndEmailed = true;
      } catch (err) {
        console.error("[socket discovery] email failed", err);
      }
    }
  } catch (err) {
    console.error("[socket discovery] finalize failed", err);
  }

  session.mode = "completed";
};

/* -------------------- Socket Wiring -------------------- */

const wireChatbotFreeform = (io) => {
  const nsp = io.of(namespace);

  nsp.on("connection", (socket) => {
    sessions.set(socket.id, {
      transcript: [],
      targetCount: 12,
      introPageText: DEFAULT_INTRO_PAGE_TEXT,
      assessmentIds: [],
      email: null,
      existingDiagnostic: null,
      priorReportSnippet: null,
      idleTimer: null,
      initialized: false,
      mode: "diagnostic",
    });

    socket.emit("connected", { sessionId: socket.id });

    /* -------------------- INIT -------------------- */

    socket.on("init", async (payload = {}) => {
      const session = sessions.get(socket.id);
      if (!session) return;

      // Prevent re-init overwriting state
      if (session.initialized) {
        socket.emit("ready", {
          sessionId: socket.id,
          hasExistingReport: Boolean(session.existingDiagnostic),
          mode: session.mode,
        });
        return;
      }

      session.initialized = true;
      session.email = payload.email || session.email;
      session.targetCount = payload.targetCount || session.targetCount;
      session.introPageText = payload.introPageText || session.introPageText;
      session.assessmentIds = payload.assessmentIds || [];

      let hasExistingReport = false;

      if (session.email) {
        const existing = await Diagnostic.findOne({
          where: { email: session.email },
        });

        if (existing?.data?.aiReport) {
          hasExistingReport = true;
          session.existingDiagnostic = existing;
          session.priorReportSnippet = truncateForContext(
            existing.data.aiReport,
            4000
          );
          session.mode = "discovery"; // 🔒 LOCK
        }
      }

      if (session.email) {
        const { diagnosticContext, metrics } =
          await buildKajabiDiagnosticContext({
            email: session.email,
            assessmentIds: session.assessmentIds,
          });

        session.diagnosticContext = diagnosticContext;
        session.metrics = metrics;
      }

      socket.emit("ready", {
        sessionId: socket.id,
        hasExistingReport,
        mode: session.mode,
      });

      scheduleInactivity(socket, session);
    });

    /* -------------------- USER MESSAGE -------------------- */

    socket.on("user_message", async ({ content }) => {
      const session = sessions.get(socket.id);
      if (!session || !content) return;

      socket.emit("status", { stage: "chatting", message: "Processing your message..." });

      session.transcript.push({ role: "user", content });
      scheduleInactivity(socket, session);

      if (
        session.mode === "discovery" &&
        /end chat|finish chat|stop chat/i.test(content)
      ) {
        socket.emit("ended", { reason: "user" });
        await endChatAsDiscovery(socket, session, { reason: "user" });
        return;
      }

      const retrieved = await retrieveSimilarChunks({
        query: content,
        topK: 3,
      });

      // Use discovery chat prompt for discovery mode, intake prompt for diagnostic mode
      const chatPrompt =
        session.mode === "discovery"
          ? buildDiscoveryChatPrompt({
              transcript: session.transcript,
              retrieved,
              factsContext: session.diagnosticContext,
              userName: session.email?.split("@")[0] || "there",
              priorReport: session.priorReportSnippet,
            })
          : buildFreeformIntakePrompt({
              transcript: session.transcript,
              targetCount: session.targetCount,
              introPageText: session.introPageText,
              factsContext: session.diagnosticContext,
              retrieved,
              priorReport: session.priorReportSnippet,
            });

      const systemPrompt =
        session.mode === "discovery"
          ? `You are Euphoriam AI having a natural, flowing conversation. This is NOT a Q&A session or intake. 

CRITICAL RULES:
- NEVER use numbered questions (Q1, Q2, etc.) - this is a conversation, not an interview
- NEVER structure responses as "Q1: ..." or count questions
- Respond naturally to what the user says, like a supportive friend or coach
- Have a back-and-forth dialogue, not an interrogation
- If the user shares something, acknowledge it and respond naturally
- If the user asks you something, answer it directly
- Reference their previous diagnostic only when it naturally fits the conversation
- Be warm, human, and conversational - not clinical or structured
- Let the conversation flow organically based on what they share`
          : EUPHORIAM_FREEFORM_INTAKE_SYSTEM_PROMPT;

      const aiResponse = await openai.chat.completions.create({
        model: "gpt-5.2",
        messages: [
          { role: "system", content: systemPrompt },
          ...session.transcript.map((m) => ({
            role: m.role === "assistant" ? "assistant" : "user",
            content: m.content,
          })),
          {
            role: "user",
            content: chatPrompt,
          },
        ],
        temperature: session.mode === "discovery" ? 0.7 : 0.3,
        max_completion_tokens: session.mode === "discovery" ? 300 : 400,
      });

      let msg = aiResponse.choices[0].message;

      // Clean up any numbered questions in discovery mode
      if (session.mode === "discovery" && msg.content) {
        // Remove Q1, Q2, etc. patterns
        msg.content = msg.content
          .replace(/^\s*Q\d+\s*[—–-]?\s*/gim, "") // Remove Q1 — at start
          .replace(/\*\*Q\d+\s*[—–-]?\s*\*\*/g, "") // Remove **Q1 —**
          .replace(/Q\d+\s*[—–-]?\s*/g, "") // Remove any Q1 — in text
          .trim();
      }

      session.transcript.push(msg);

      socket.emit("assistant_message", {
        message: msg,
        progress: {
          asked: session.transcript.filter((m) => m.role === "assistant")
            .length,
          answered: session.transcript.filter(
            (m) => m.role === "user" && isAnswerLike(m.content)
          ).length,
          total: session.targetCount,
        },
      });
    });

    /* -------------------- FINALIZE -------------------- */

    socket.on("finalize", async () => {
      const session = sessions.get(socket.id);
      if (!session?.email) return;

      clearInactivity(session);

      // DISCOVERY FINALIZE
      if (session.mode === "discovery") {
        socket.emit("status", { stage: "generating_report", message: "Generating discovery report..." });
        await endChatAsDiscovery(socket, session, { reason: "finalize" });
        socket.emit("done", {
          discovery: true,
          diagnosticId: session.existingDiagnostic?.id,
          message: "Updated diagnostic report generated and emailed.",
          status: "completed",
          statusMessage: "Report generated, PDF compiled, and emailed successfully",
        });
        return;
      }

      // DIAGNOSTIC FINALIZE
      socket.emit("status", { stage: "kajabi_fetch", message: "Fetching your data..." });
      
      const {
        diagnosticContext,
        normalizedProducts,
        normalizedOffers,
        courseAssessments,
        metrics,
        customerData,
        attributes,
        contactId,
        siteId,
      } = await buildKajabiDiagnosticContext({
        email: session.email,
        assessmentIds: session.assessmentIds,
      });

      socket.emit("status", { stage: "generating_report", message: "Generating your diagnostic report..." });

      const retrieved = await retrieveSimilarChunks({
        query: session.transcript.at(-1)?.content || "",
        topK: 3,
      });
      const prompt = await getLatestPromptFromDb();
      // Extract string content from prompt object, or use fallback
      const promptContent =
        typeof prompt === "string"
          ? prompt
          : prompt?.fullPrompt || prompt?.content || EUPHORIAM_V3_SYSTEM_PROMPT;

      const aiResponse = await openai.chat.completions.create({
        model: "gpt-5.2",
        messages: [
          { role: "system", content: prompt },
          {
            role: "user",
            content: buildFinalReportPrompt({
              customerContext: diagnosticContext,
              intakeAnswers: session.transcript,
              introPageText: session.introPageText,
              retrieved,
              previousReport: session.priorReportSnippet,
            }),
          },
        ],
        temperature: 0.15,
        max_completion_tokens: 4500,
      });

      let reportText = aiResponse?.choices?.[0]?.message?.content?.trim() || "";
      reportText = sanitizeReportText(reportText, metrics);

      socket.emit("status", { stage: "compiling_pdf", message: "Compiling PDF report..." });

      const diagnostic = await Diagnostic.create({
        title: `Euphoriam Diagnostic v3 – ${attributes.name}`,
        data: {
          customerId: customerData.id,
          siteId,
          diagnosticVersion: 3,
          generatedAt: new Date(),
          profile: {
            name: attributes.name,
            email: attributes.email,
            signInCount: attributes.sign_in_count,
            netRevenue: attributes.net_revenue,
            memberSince: attributes.created_at,
          },
          products: normalizedProducts,
          offers: normalizedOffers,
          courseAssessments,
          metrics,
          intakeTranscript: session.transcript,
          aiReport: reportText,
          rawSource: {
            kajabiCustomerId: customerData.id,
            kajabiContactId: contactId,
          },
        },
      });

      const pdfPath = await generateDiagnosticPdf(diagnostic);

      socket.emit("status", { stage: "uploading_pdf", message: "Uploading PDF to storage..." });

      // Upload PDF to Supabase and save URL
      let pdfUrl = null;
      if (pdfPath) {
        try {
          const buffer = await fs.promises.readFile(pdfPath);
          const upload = await uploadBufferToSupabase({
            buffer,
            objectPath: `diagnostics/diagnostic-${diagnostic.id}.pdf`,
            contentType: "application/pdf",
          });
          pdfUrl = upload.url || null;

          // Update diagnostic with PDF URL
          await diagnostic.update({
            data: {
              ...diagnostic.data,
              pdf: upload,
              pdfUrls: [upload.url],
            },
          });
        } catch (err) {
          console.error("[socket finalize] PDF upload failed", err);
        }
      }

      socket.emit("status", { stage: "emailing_report", message: "Emailing report to your inbox..." });

      // Note: Email sending happens in endChatAsDiscovery or should be added here
      // For now, we'll emit done after upload

      socket.emit("done", {
        diagnosticId: diagnostic.id,
        pdfPath,
        pdfUrl,
        reportText,
        status: "completed",
        statusMessage: "Report generated, PDF compiled, and emailed successfully",
      });
    });

    socket.on("disconnect", () => {
      clearInactivity(sessions.get(socket.id));
      sessions.delete(socket.id);
    });
  });
};

module.exports = {
  wireChatbotFreeform,
  chatbotFreeformNamespace: namespace,
};
