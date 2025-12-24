const {
  EUPHORIAM_FREEFORM_INTAKE_SYSTEM_PROMPT,
  buildFreeformIntakePrompt,
  buildFinalReportPrompt,
  DEFAULT_INTRO_PAGE_TEXT,
  EUPHORIAM_V3_SYSTEM_PROMPT,
  sanitizeReportText,
} = require("../helpers/euphoriamChatbot");
const { retrieveSimilarChunks } = require("../helpers/rag");
const { buildKajabiDiagnosticContext } = require("../controllers/diagnosticController");
const openai = require("../config/openai");
const { Diagnostic } = require("../models/diagnosticModel");
const { generateDiagnosticPdf } = require("../utils/diagnosticPdf");

const isQuestion = (text = "") => text.trim().endsWith("?");
const isAnswerLike = (text = "") => {
  const t = (text || "").trim();
  if (!t) return false;
  if (isQuestion(t)) return false;
  const alpha = t.match(/[A-Za-z]/g);
  // Relaxed: Allow short answers like "yes", "A", or "d,d,d"
  return alpha && alpha.length >= 1 && t.length >= 1;
};

// In-memory session store; for production swap to Redis.
const sessions = new Map();

const namespace = "/ws/chatbot-freeform";

const wireChatbotFreeform = (io) => {
  const nsp = io.of(namespace);

  nsp.on("connection", (socket) => {
    sessions.set(socket.id, {
      transcript: [],
      targetCount: 12,
      introPageText: DEFAULT_INTRO_PAGE_TEXT,
      assessmentIds: [],
      email: null,
    });

    socket.emit("connected", { sessionId: socket.id });

    socket.on("init", async (payload = {}) => {
      const session = sessions.get(socket.id);
      if (!session) return;
      session.email = payload.email || session.email;
      session.targetCount = payload.targetCount || session.targetCount;
      session.introPageText = payload.introPageText || session.introPageText;
      session.assessmentIds = payload.assessmentIds || [];
      // Preload Kajabi context to keep intake on-topic.
      if (session.email) {
        try {
          const { diagnosticContext, metrics } =
            await buildKajabiDiagnosticContext({
              email: session.email,
              assessmentIds: session.assessmentIds,
            });
          session.diagnosticContext = diagnosticContext;
          session.metrics = metrics;
        } catch (err) {
          console.error("[socket init] kajabi preload failed", err);
        }
      }
      socket.emit("ready", {
        sessionId: socket.id,
        targetCount: session.targetCount,
        introPageText: session.introPageText,
      });
    });

    socket.on("user_message", async (payload = {}) => {
      const session = sessions.get(socket.id);
      if (!session) {
        socket.emit("error", { message: "Session missing" });
        return;
      }

      const { content } = payload;
      if (!content || typeof content !== "string") {
        socket.emit("error", { message: "Content is required" });
        return;
      }

      session.transcript.push({ role: "user", content });

      try {
        // Ensure Kajabi context loaded for intake
        if (!session.diagnosticContext && session.email) {
          try {
            const { diagnosticContext, metrics } =
              await buildKajabiDiagnosticContext({
                email: session.email,
                assessmentIds: session.assessmentIds,
              });
            session.diagnosticContext = diagnosticContext;
            session.metrics = metrics;
          } catch (err) {
            console.error("[socket user_message] kajabi preload failed", err);
          }
        }

        const lastUser = { content };
        const retrieved = await retrieveSimilarChunks({
          query: lastUser.content,
          topK: 3,
        });

        const aiResponse = await openai.chat.completions.create({
          model: "gpt-5.2",
          messages: [
            {
              role: "system",
              content: EUPHORIAM_FREEFORM_INTAKE_SYSTEM_PROMPT,
            },
            ...session.transcript.map((m) => ({
              role: m.role === "assistant" ? "assistant" : "user",
              content: m.content,
            })),
            {
              role: "user",
              content: buildFreeformIntakePrompt({
                transcript: session.transcript,
                targetCount: session.targetCount,
                introPageText: session.introPageText,
                factsContext: session.diagnosticContext,
                retrieved,
              }),
            },
          ],
          temperature: 0.3,
          max_completion_tokens: 400,
        });

        const nextMessage = aiResponse?.choices?.[0]?.message;
        session.transcript.push(nextMessage);

        socket.emit("assistant_message", {
          message: nextMessage,
          progress: {
            asked: session.transcript.filter((m) => m.role === "assistant")
              .length,
            answered: session.transcript.filter(
              (m) => m.role === "user" && isAnswerLike(m.content || "")
            ).length,
            total: session.targetCount,
          },
          retrieved,
        });
      } catch (err) {
        console.error("[socket user_message] error", err);
        socket.emit("error", { message: "Failed to process message" });
      }
    });

    socket.on("finalize", async () => {
      const session = sessions.get(socket.id);
      if (!session || !session.email) {
        socket.emit("error", { message: "Email missing; call init first" });
        return;
      }

      socket.emit("status", { stage: "kajabi_fetch" });

      try {
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

        const lastUser = [...session.transcript]
          .reverse()
          .find((m) => m?.role === "user");
        const retrieved = lastUser?.content
          ? await retrieveSimilarChunks({ query: lastUser.content, topK: 3 })
          : [];

        socket.emit("status", { stage: "generating_report" });

        const aiResponse = await openai.chat.completions.create({
          model: "gpt-5.2",
          messages: [
            { role: "system", content: EUPHORIAM_V3_SYSTEM_PROMPT },
            {
              role: "user",
              content: buildFinalReportPrompt({
                customerContext: diagnosticContext,
                intakeAnswers: session.transcript,
                introPageText: session.introPageText,
                retrieved,
              }),
            },
          ],
          temperature: 0.15,
          max_completion_tokens: 4500,
        });

        let reportText = (
          aiResponse?.choices?.[0]?.message?.content || ""
        ).trim();
        reportText = sanitizeReportText(reportText, metrics);

        if (!reportText) {
          socket.emit("error", {
            message: "AI returned empty diagnostic report.",
          });
          return;
        }

        const diagnostic = await Diagnostic.create({
          userId: null,
          title: `Euphoriam Diagnostic v3 (Freeform) – ${attributes.name}`,
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
            site: diagnosticContext.site,
            contact: diagnosticContext.contact,
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

        socket.emit("done", {
          diagnosticId: diagnostic.id,
          pdfPath,
          reportText,
        });
      } catch (err) {
        console.error("[socket finalize] error", err);
        socket.emit("error", { message: "Failed to finalize diagnostic" });
      }
    });

    socket.on("disconnect", () => {
      sessions.delete(socket.id);
    });
  });
};

module.exports = { wireChatbotFreeform, chatbotFreeformNamespace: namespace };
