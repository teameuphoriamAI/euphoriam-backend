const fs = require("fs");
const { Diagnostic } = require("../models/diagnosticModel");
const { Discovery } = require("../models/discoveryModel");
const { Prompt } = require("../models/promptModel");
const { User } = require("../models/userModel");
const validate = require("../helpers/validate");
const openai = require("../config/openai");
const {
  discoveryReportEmail,
} = require("../utils/emailTemplate/initialDiscoveryReport");

const {
  buildFinalReportPrompt,
  DEFAULT_INTRO_PAGE_TEXT,
  // Helper functions
  loadDiagnosticState,
  loadLatestDiscoveryMetrics,
  extractReportDate,
  preparePreviousReports,
  checkWantsNewDiagnostic,
  determineChatMode,
  prepareTranscript,
  trackQuestionNumbers,
  buildChatPrompts,
  extractQuestionNumber,
  validateChatbotRequest,
  SUPPORT_LOCK_PROMPT,
} = require("../helpers/euphoriamChatbot");
const { retrieveSimilarChunks } = require("../helpers/rag");
const { successResponse, errorResponse } = require("../utils/response");
const { buildKajabiDiagnosticContext } = require("./kajabi");
const { generateDiagnosticPdf } = require("../utils/diagnosticPdf");
const { uploadBufferToSupabase } = require("../utils/storage");
const { sendEmail, sendEmailBasic } = require("../utils/email");
const {
  diagnosticReportEmail,
} = require("../utils/emailTemplate/initialDignosticReport");

const isQuestion = (text = "") => text.trim().endsWith("?");

const isCreatorClubMember = (context = {}) => {
  const hasProduct = (context.products || []).some((p) =>
    (p.title || "").toLowerCase().includes("creator club")
  );
  const hasOffer = (context.offers || []).some((o) =>
    (o.title || "").toLowerCase().includes("creator club")
  );
  return hasProduct || hasOffer;
};

/**
 * Finds or creates a user and checks/updates their Creator Club membership status
 * This is the ONLY place we call buildKajabiDiagnosticContext - just for membership checking
 * Always checks latest status from Kajabi and updates the database
 */
const findOrCreateCreatorUser = async ({ email, name, assessmentIds = [] }) => {
  let user = await User.findOne({ where: { email } });

  if (!user) {
    user = await User.create({ email, name });
  }

  // If membership is missing or user is not a Creator Club member
  if (!user.membership?.isCreatorClub) {
    try {
      const { diagnosticContext } = await buildKajabiDiagnosticContext({
        email,
        assessmentIds,
      });

      const isCreatorClub = isCreatorClubMember(diagnosticContext);

      const membership = {
        isCreatorClub,
        lastUpdated: new Date().toISOString(),
        products: diagnosticContext.products || [],
        offers: diagnosticContext.offers || [],
      };

      await user.update({ membership });
      user = await user.reload(); // Reload to get updated data
    } catch (err) {
      console.error(
        "[findOrCreateCreatorUser] Failed to check membership:",
        err
      );
      // Continue even if membership check fails
    }
  }

  return user;
};

// Lightweight AI check to decide if a user reply is an answer to the last question.
const isAiLikelyAnswer = async ({ question, reply }) => {
  const t = (reply || "").trim().toLowerCase();
  if (!t) return false;
  if (isQuestion(t)) return false;
  // Hard fail on clarify/intents
  const clarifyPhrases = [
    "elaborate",
    "clarify",
    "explain",
    "repeat",
    "don't understand",
    "do not understand",
    "not sure",
    "what do you mean",
    "?", // ends with question mark
  ];
  if (clarifyPhrases.some((p) => t.includes(p))) return false;
  const alpha = t.match(/[A-Za-z]/g);
  // Relaxed: Allow short answers to pass to the AI classifier
  if (!alpha || alpha.length < 1) return false;

  const prompt = `
You are a binary classifier. Decide if the user's reply is an *answer* to the given question.

Question: "${question || "N/A"}"
Reply: "${reply}"

Rules:
- Reply only "yes" or "no".
- "yes" if the reply attempts to answer; "no" if it is just a question, "I don't know", or unrelated.
`;
  try {
    const resp = await openai.chat.completions.create({
      model: "gpt-4.1-mini",
      messages: [{ role: "user", content: prompt }],
      temperature: 0,
      max_tokens: 3,
    });
    const txt = (resp?.choices?.[0]?.message?.content || "").toLowerCase();
    return txt.includes("yes");
  } catch (err) {
    console.error("[isAiLikelyAnswer] fallback to heuristic", err);
    return false;
  }
};

const truncateForContext = (text = "", max = 6000) => {
  const safe = String(text || "");
  if (!safe) return "";
  return safe.length > max ? `${safe.slice(0, max)}\n...[truncated]` : safe;
};

const buildDiscoveryEmail = ({ transcript = [], email }) => {
  const lastMessages = transcript.slice(-10);
  const body = lastMessages
    .map((m) => `${m.role === "assistant" ? "Assistant" : "You"}: ${m.content}`)
    .join("<br/>");

  return `
  <html>
    <body style="font-family: Arial, sans-serif; color: #222;">
      <p>Hi ${email || "there"},</p>
      <p>Your discovery chat has been saved. Here’s a quick recap of the last messages:</p>
      <div style="background:#f7f7f7;padding:12px;border-radius:8px;font-size:14px;line-height:1.5;">
        ${body || "No messages captured."}
      </div>
      <p>If you’d like to continue, start a new chat and we’ll build on this.</p>
      <p style="margin-top:20px;">— Euphoraum AI</p>
    </body>
  </html>
  `;
};

const persistDiscoveryRecord = async ({
  userId,
  email,
  title,
  transcript,
  previousReport,
  newReport,
  diagnosticId,
  pdfUrl,
  discoveryType = null, // 'alignment', 'freedom', 'prosperity', or 'integrated'
}) => {
  const safeUserId =
    userId !== undefined && userId !== null && userId !== 0 ? userId : null;

  if (!safeUserId) {
    console.warn(
      "[diagnostic] Skipping discovery persist because userId is missing"
    );
    return;
  }

  try {
    await Discovery.create({
      userId: safeUserId,
      title: title || `Diagnostic Follow-up – ${email || "client"}`,
      discoveryType: discoveryType || "integrated", // Default to integrated if not specified
      data: {
        email,
        diagnosticId,
        transcript,
        previousReportSnippet: truncateForContext(previousReport, 1500),
        newReportSnippet: truncateForContext(newReport, 1500),
        pdfUrl: pdfUrl || null,
        createdAt: new Date().toISOString(),
        type: "diagnostic_followup",
      },
    });
  } catch (err) {
    console.error("[diagnostic] Failed to persist discovery record", err);
  }
};

// Helper function to render metrics gauge for discovery reports
const renderGauge = (value) => {
  const v = Math.max(0, Math.min(100, Number(value || 0)));
  const totalBlocks = 12;
  const filled = Math.round((v / 100) * totalBlocks);
  const empty = totalBlocks - filled;
  const filledBlock = "█".repeat(filled);
  const emptyBlock = "░".repeat(empty);
  return `${filledBlock}${emptyBlock} ${v}%`;
};
//get latest promt from db
const getLatestPromptFromDb = async () => {
  try {
    const prompt = await Prompt.findOne({
      where: { isActive: true },
      order: [["createdAt", "DESC"]],
      raw: true, // returns plain JS object
    });

    if (!prompt) return null;

    return {
      ...prompt,
      fullPrompt: `${prompt.content}\n\n${SUPPORT_LOCK_PROMPT}`,
    };
  } catch (error) {
    console.error("Error fetching latest prompt:", error);
    return null;
  }
};

const chatbotDiagnosticFreeform = async (req, res) => {
  const {
    email,
    name,
    messages = [],
    assessmentIds = [],
    finalize = false,
    introPageText,
    targetCount = 12,
  } = req.body || {};

  // Validate request
  const validation = validateChatbotRequest(req);
  if (!validation.valid) {
    return errorResponse(res, validation.error, validation.statusCode);
  }
  // Find or create user and check/update Creator Club membership
  const appUser = await findOrCreateCreatorUser({
    email,
    name,
    assessmentIds,
  });
  // Load diagnostic state
  const {
    existingDiagnostic,
    existingState,
    existingReport,
    diagnosticMetrics,
  } = await loadDiagnosticState(email);

  // Load latest discovery metrics
  const { latestDiscovery, latestDiscoveryReport, latestDiscoveryMetrics } =
    await loadLatestDiscoveryMetrics(existingDiagnostic, diagnosticMetrics);

  // Extract report date
  const reportDate = extractReportDate(latestDiscovery, existingDiagnostic);

  // Prepare prior report snippet
  const priorReportSnippet = latestDiscoveryReport
    ? truncateForContext(latestDiscoveryReport, 12000)
    : truncateForContext(existingReport, 12000);

  // Prepare previous reports
  const previousReports = preparePreviousReports(
    existingDiagnostic,
    existingReport
  );

  const hasExistingReport = Boolean(existingReport);

  // If a full report already exists and this is a finalize attempt without new data, short-circuit to avoid duplicate emails.
  if (finalize && existingReport) {
    return successResponse(res, "Existing diagnostic already completed", {
      message:
        "You already have a completed diagnostic. Start a new discovery chat to get an updated follow-up.",
      hasExistingReport: true,
      diagnosticId: existingDiagnostic?.id || null,
    });
  }

  // Prepare transcript
  const transcript = prepareTranscript(
    messages,
    existingState,
    hasExistingReport,
    false
  );
  const lastTurn = transcript[transcript.length - 1];
  const lastTurnAssistant = lastTurn?.role === "assistant";

  // Show resume notice when resuming after an assistant turn (only for diagnostic mode, not discovery).
  const resumeNotice =
    !hasExistingReport && transcript.length > 0 && lastTurnAssistant
      ? `Welcome back ${name}, let's continue where we left off.`
      : null;

  const introText = introPageText || DEFAULT_INTRO_PAGE_TEXT;
  const targetCountForRun = hasExistingReport
    ? Math.min(targetCount, 6)
    : targetCount;

  if (!finalize) {
    const lastUser = [...transcript].reverse().find((m) => m?.role === "user");
    const retrieved = lastUser?.content
      ? await retrieveSimilarChunks({ query: lastUser.content, topK: 3 })
      : [];

    const lastAssistant = [...transcript]
      .reverse()
      .find((m) => m?.role === "assistant");

    const hasAssistantTurn = Boolean(lastAssistant);
    const aiAnswered =
      hasAssistantTurn && lastUser
        ? await isAiLikelyAnswer({
            question: lastAssistant.content,
            reply: lastUser.content,
          })
        : false;

    // Track question numbers
    const {
      distinctQuestionNumbers,
      maxQuestionNumber,
      distinctQuestionsAnswered,
    } = trackQuestionNumbers(transcript);

    // Determine if the last user turn actually answered the last assistant question.
    const pendingQuestion = hasAssistantTurn && !aiAnswered;

    // Check if user wants a new diagnostic
    const { wantsNewDiagnostic, intakeInProgress } = checkWantsNewDiagnostic(
      transcript,
      existingState
    );

    // Determine chat mode
    const isDiscoveryMode = determineChatMode(
      hasExistingReport,
      wantsNewDiagnostic,
      intakeInProgress
    );

    // Check if intake has started
    const intakeHasStarted = transcript.some(
      (m) => m.role === "assistant" && /Q\d+/i.test(m.content)
    );

    // Build prompts
    const discoveryType = req.body.discoveryType || null;
    const { userPrompt, systemPrompt } = await buildChatPrompts({
      isDiscoveryMode,
      transcript,
      targetCount: targetCountForRun,
      introText,
      name,
      retrieved,
      priorReportSnippet,
      lastTurnAssistant,
      resumeNotice,
      wantsNewDiagnostic,
      intakeHasStarted,
      distinctQuestionNumbers,
      discoveryType,
      latestDiscoveryMetrics,
      reportDate,
    });

    // Build messages array for AI
    let messages = [{ role: "system", content: systemPrompt }];

    // Include prior report in system context for both modes (needed for discovery mode to answer questions about it)
    if (priorReportSnippet) {
      messages.push({
        role: "system",
        content: isDiscoveryMode
          ? `Previous diagnostic report for ${name} (you have full access to this - use it to answer questions about what the report revealed, their patterns, insights, etc.):\n${priorReportSnippet}`
          : `Existing diagnostic report for ${name} (reference for continuity; do not re-emit the full report here):\n${priorReportSnippet}`,
      });
    }

    messages.push(
      ...transcript.map((m) => ({
        role: m.role === "assistant" ? "assistant" : "user",
        content: m.content,
      })),
      {
        role: "user",
        content: userPrompt,
      }
    );

    // Check if user is asking about diagnostic report (needs more tokens)
    const lastUserMsg =
      transcript.filter((m) => m.role === "user").slice(-1)[0]?.content || "";
    const lowerMsg = lastUserMsg.toLowerCase();
    const isAskingAboutReport =
      /diagnostic|report|reveal|show|find|pattern|insight/i.test(lastUserMsg);
    const isRequestingFullReport =
      /full report|entire report|everything|go deeper|in depth|where can i improve|improve|tell me all|what did.*reveal/i.test(
        lowerMsg
      );
    const maxTokens = isDiscoveryMode
      ? isRequestingFullReport
        ? 800
        : isAskingAboutReport
        ? 500
        : 300 // Brief summary for full report requests (800 tokens to avoid truncation)
      : 400;

    // Update system prompt for full report requests
    if (isDiscoveryMode && isRequestingFullReport && priorReportSnippet) {
      systemPrompt = `You are Euphoriam AI. The user asked: "${lastUserMsg}"

You MUST write a brief summary of their diagnostic report. Start immediately with "**What Your Diagnostic Report Revealed:**"

Your response must include:
1. A 2-3 sentence overview
2. Key patterns, metrics (with numbers), daily manifestations, strengths, friction points, growth path
3. Section "**Where You Can Improve:**" with 3-5 actionable areas

Be concise (300-500 words). Extract details from the report in the system context. Write now - do not ask permission.`;
    }

    // For full report requests, use lower temperature for more focused responses
    const temperature =
      isDiscoveryMode && isRequestingFullReport
        ? 0.3
        : isDiscoveryMode
        ? 0.7
        : 0.3;

    let aiResponse;
    let nextMessage;
    let retryCount = 0;
    const maxRetries = isDiscoveryMode && isRequestingFullReport ? 1 : 0; // Retry once for full report requests

    // Try to get response, with retry for full report requests
    while (retryCount <= maxRetries) {
      aiResponse = await openai.chat.completions.create({
        model: "gpt-5.2",
        messages,
        temperature,
        max_completion_tokens: maxTokens,
      });
      nextMessage = aiResponse?.choices?.[0]?.message;

      // If we got content, break
      if (nextMessage?.content && nextMessage.content.trim() !== "") {
        break;
      }

      // If empty and we should retry, try again with more direct prompt
      if (
        retryCount < maxRetries &&
        isRequestingFullReport &&
        priorReportSnippet
      ) {
        // Retry with even more direct prompt
        const retryMessages = [
          {
            role: "system",
            content: `You MUST provide a detailed breakdown of the diagnostic report. Start immediately with "**What Your Diagnostic Report Revealed:**"`,
          },
          {
            role: "system",
            content: `DIAGNOSTIC REPORT:\n${priorReportSnippet.substring(
              0,
              10000
            )}`,
          },
          ...transcript.slice(-3).map((m) => ({
            role: m.role === "assistant" ? "assistant" : "user",
            content: m.content,
          })),
          {
            role: "user",
            content: `Provide a comprehensive breakdown of my diagnostic report. Start with "**What Your Diagnostic Report Revealed:**" and then "**Where You Can Improve:**"`,
          },
        ];
        messages = retryMessages;
        retryCount++;
        continue;
      }

      break;
    }

    // Handle empty responses with better fallback
    if (
      !nextMessage ||
      !nextMessage.content ||
      nextMessage.content.trim() === ""
    ) {
      if (isDiscoveryMode) {
        const lastUserMsg =
          transcript.filter((m) => m.role === "user").slice(-1)[0]?.content ||
          "";
        const lowerMsg = lastUserMsg.toLowerCase();
        const isRequestingFullReportFallback =
          /full report|entire report|everything|go deeper|in depth|where can i improve|improve|tell me all/i.test(
            lowerMsg
          );

        if (isRequestingFullReportFallback && priorReportSnippet) {
          // Try one more time with a very simple, direct prompt
          try {
            const simplePrompt = `Summarize this diagnostic report in 300-500 words. Start with "**What Your Diagnostic Report Revealed:**" then "**Where You Can Improve:**"

Report:
${priorReportSnippet.substring(0, 8000)}

Write the summary now.`;

            const fallbackResponse = await openai.chat.completions.create({
              model: "gpt-5.2",
              messages: [
                {
                  role: "system",
                  content:
                    "You are a helpful assistant. Provide concise summaries of diagnostic reports.",
                },
                { role: "user", content: simplePrompt },
              ],
              temperature: 0.3,
              max_completion_tokens: 800,
            });

            const fallbackMessage = fallbackResponse?.choices?.[0]?.message;
            if (
              fallbackMessage?.content &&
              fallbackMessage.content.trim() !== ""
            ) {
              nextMessage = fallbackMessage;
            } else {
              // Last resort - provide a helpful message
              nextMessage = {
                role: "assistant",
                content: `**What Your Diagnostic Report Revealed:**

I'm having trouble generating the summary right now. Your diagnostic report contains insights about your patterns, metrics, and growth areas. 

**Where You Can Improve:**

Please try asking again in a moment, or ask me about a specific area from your report (e.g., "what are my metrics?" or "where should I focus?").`,
              };
            }
          } catch (err) {
            console.error("[fallback] Error generating summary:", err);
            nextMessage = {
              role: "assistant",
              content: `**What Your Diagnostic Report Revealed:**

I'm having trouble generating the summary right now. Please try asking again, or ask about a specific area from your report.`,
            };
          }
        } else {
          // For discovery mode first message, use structure reflection fallback with actual metrics
          if (
            isDiscoveryMode &&
            transcript.length === 0 &&
            priorReportSnippet
          ) {
            // Format metrics for fallback message
            const gravity = diagnosticMetrics.gravity;
            const signalCoherence = diagnosticMetrics.signalCoherence;
            const signalOutput = diagnosticMetrics.signalOutput;
            const consciousnessLevel = diagnosticMetrics.consciousnessLevel;
            const qgcActivation = diagnosticMetrics.qgcActivation;

            // Helper function to create progress bar
            const createProgressBar = (value, max = 100, length = 12) => {
              const filled = Math.round((value / max) * length);
              const empty = length - filled;
              return "█".repeat(filled) + "░".repeat(empty);
            };

            const metricsSection =
              gravity !== undefined &&
              signalCoherence !== undefined &&
              signalOutput !== undefined &&
              consciousnessLevel !== undefined &&
              qgcActivation !== undefined
                ? `QGC Activation:
${createProgressBar(qgcActivation)}
${qgcActivation}%

Consciousness Level:
${createProgressBar((consciousnessLevel / 5) * 100)}
${Math.round((consciousnessLevel / 5) * 100)}%

Gravity:
${createProgressBar(gravity)}
${gravity}%

Signal Coherence:
${createProgressBar(signalCoherence)}
${signalCoherence}%

Signal Output:
${createProgressBar(signalOutput)}
${signalOutput}%

* Extremely high Gravity (${gravity}%) → the old identity has a powerful stabilising pull
* Perfect Signal Coherence (${signalCoherence}%) → no fragmentation, no inner chaos
* Very low Signal Output (${signalOutput}%) → not because of weakness, but because entry hadn't happened yet
* CL ${consciousnessLevel} → stabilisation phase
* QGC ${qgcActivation}% → genuine creative intelligence present but contained`
                : `
* **[Extract Gravity % from report]** → [what it means]
* **[Extract Signal Coherence % from report]** → [what it means]
* **[Extract Signal Output % from report]** → [what it means]
* **CL [Extract from report]** → [what phase]
* **QGC [Extract from report]%** → [what it indicates]`;

            // Try to extract key sentence and correction from report
            let keySentence = "";
            let correction = "";

            if (priorReportSnippet) {
              // Look for key sentence patterns (quoted sentences, "I will..." patterns, etc.)
              const keySentenceMatch =
                priorReportSnippet.match(
                  /(?:key sentence|distilled|pattern)[\s\S]{0,200}["']([^"']{10,150})["']/i
                ) ||
                priorReportSnippet.match(
                  /["']([^"']{20,100}(?:will|must|can't|won't)[^"']{0,50})["']/i
                ) ||
                priorReportSnippet.match(
                  /(?:I will|I must|I can't|I won't)[^.\n]{10,80}/i
                );

              if (keySentenceMatch) {
                keySentence = keySentenceMatch[1] || keySentenceMatch[0];
                keySentence = keySentence.trim().substring(0, 120);
              }

              // Look for correction section
              const correctionMatch =
                priorReportSnippet.match(
                  /(?:First Correction|correction|recommendation)[\s\S]{0,300}(.{50,200})/i
                ) ||
                priorReportSnippet.match(
                  /(?:gentle|repeatable|entry|threshold|micro-correction)[\s\S]{0,200}(.{30,150})/i
                );

              if (correctionMatch) {
                correction = correctionMatch[1].trim().substring(0, 150);
              }
            }

            // If we can't extract key sentence, try to infer from report structure
            let keySentenceText = "";
            if (keySentence) {
              keySentenceText = `> *"${keySentence}"*`;
            } else if (priorReportSnippet) {
              // Try to infer from report content - look for structural patterns
              const structureMatch = priorReportSnippet.match(
                /(?:structure|identity|pattern)[\s\S]{0,100}(.{30,100})/i
              );
              if (structureMatch) {
                keySentenceText = `> *"${structureMatch[1]
                  .trim()
                  .substring(0, 100)}"*`;
              } else {
                // Skip key sentence section if we truly can't extract it
                keySentenceText = "";
              }
            }

            // If we can't extract correction, try to infer from report recommendations
            let correctionText = "";
            if (correction) {
              correctionText = `**${correction}**`;
            } else if (priorReportSnippet) {
              // Try to infer from report - look for action items or focus areas
              const actionMatch = priorReportSnippet.match(
                /(?:focus|work on|action|next step)[\s\S]{0,100}(.{30,100})/i
              );
              if (actionMatch) {
                correctionText = `**${actionMatch[1]
                  .trim()
                  .substring(0, 100)}**`;
              } else {
                // Use a generic but meaningful fallback
                correctionText = `**structural alignment and entry threshold work**`;
              }
            }

            const questionText = correction
              ? `Since this report (${
                  reportDate || "recently"
                }), have you made any progress on ${correction.substring(
                  0,
                  50
                )}?`
              : `Since this report (${
                  reportDate || "recently"
                }), what has changed or stayed the same?`;

            nextMessage = {
              role: "assistant",
              content: `WelcomesS back ${name}!. I've loaded your last report.

I want to reflect it back to you first — simply and cleanly — before we move anywhere.

Your structure at the last check-in was very clear:
${metricsSection}

${
  keySentenceText
    ? `This is the key sentence from your map, distilled:

${keySentenceText}

`
    : ""
}${
                correction
                  ? `Nothing in your report pointed to laziness, lack of capacity, or being "behind." It pointed to your structure — ${correction.substring(
                      0,
                      100
                    )}.`
                  : ""
              }

${
  correctionText
    ? `Your **entire correction** was about one thing only:
${correctionText}

`
    : ""
}Before I update anything, I need to check one thing — slowly.

**Since this report (${reportDate || "recently"}):**

${questionText}

Just answer that.`,
            };
          } else {
            nextMessage = {
              role: "assistant",
              content: `I'm here. ${
                lastUserMsg
                  ? `You mentioned "${lastUserMsg}" - tell me more about that, or what's on your mind right now?`
                  : "What would you like to explore today?"
              }`,
            };
          }
        }
      } else {
        // For discovery mode first message, use structure reflection with actual metrics
        if (isDiscoveryMode && transcript.length === 0 && priorReportSnippet) {
          // Format metrics for fallback message
          const gravity = diagnosticMetrics.gravity;
          const signalCoherence = diagnosticMetrics.signalCoherence;
          const signalOutput = diagnosticMetrics.signalOutput;
          const consciousnessLevel = diagnosticMetrics.consciousnessLevel;
          const qgcActivation = diagnosticMetrics.qgcActivation;

          // Helper function to create progress bar
          const createProgressBar = (value, max = 100, length = 12) => {
            const filled = Math.round((value / max) * length);
            const empty = length - filled;
            return "█".repeat(filled) + "░".repeat(empty);
          };

          const metricsSection =
            gravity !== undefined &&
            signalCoherence !== undefined &&
            signalOutput !== undefined &&
            consciousnessLevel !== undefined &&
            qgcActivation !== undefined
              ? `QGC Activation:
${createProgressBar(qgcActivation)}
${qgcActivation}%

Consciousness Level:
${createProgressBar((consciousnessLevel / 5) * 100)}
${Math.round((consciousnessLevel / 5) * 100)}%

Gravity:
${createProgressBar(gravity)}
${gravity}%

Signal Coherence:
${createProgressBar(signalCoherence)}
${signalCoherence}%

Signal Output:
${createProgressBar(signalOutput)}
${signalOutput}%

* Extremely high Gravity (${gravity}%) → the old identity has a powerful stabilising pull
* Perfect Signal Coherence (${signalCoherence}%) → no fragmentation, no inner chaos
* Very low Signal Output (${signalOutput}%) → not because of weakness, but because entry hadn't happened yet
* CL ${consciousnessLevel} → stabilisation phase
* QGC ${qgcActivation}% → genuine creative intelligence present but contained`
              : `
* **[Extract Gravity % from report]** → [what it means]
* **[Extract Signal Coherence % from report]** → [what it means]
* **[Extract Signal Output % from report]** → [what it means]
* **CL [Extract from report]** → [what phase]
* **QGC [Extract from report]%** → [what it indicates]`;

          // Try to extract key sentence and correction from report
          let keySentence = "";
          let correction = "";

          if (priorReportSnippet) {
            // Look for key sentence patterns (quoted sentences, "I will..." patterns, etc.)
            const keySentenceMatch =
              priorReportSnippet.match(
                /(?:key sentence|distilled|pattern)[\s\S]{0,200}["']([^"']{10,150})["']/i
              ) ||
              priorReportSnippet.match(
                /["']([^"']{20,100}(?:will|must|can't|won't)[^"']{0,50})["']/i
              ) ||
              priorReportSnippet.match(
                /(?:I will|I must|I can't|I won't)[^.\n]{10,80}/i
              );

            if (keySentenceMatch) {
              keySentence = keySentenceMatch[1] || keySentenceMatch[0];
              keySentence = keySentence.trim().substring(0, 120);
            }

            // Look for correction section
            const correctionMatch =
              priorReportSnippet.match(
                /(?:First Correction|correction|recommendation)[\s\S]{0,300}(.{50,200})/i
              ) ||
              priorReportSnippet.match(
                /(?:gentle|repeatable|entry|threshold|micro-correction)[\s\S]{0,200}(.{30,150})/i
              );

            if (correctionMatch) {
              correction = correctionMatch[1].trim().substring(0, 150);
            }
          }

          // If we can't extract key sentence, try to infer from report structure
          let keySentenceText = "";
          if (keySentence) {
            keySentenceText = `> *"${keySentence}"*`;
          } else if (priorReportSnippet) {
            // Try to infer from report content - look for structural patterns
            const structureMatch = priorReportSnippet.match(
              /(?:structure|identity|pattern)[\s\S]{0,100}(.{30,100})/i
            );
            if (structureMatch) {
              keySentenceText = `> *"${structureMatch[1]
                .trim()
                .substring(0, 100)}"*`;
            } else {
              // Skip key sentence section if we truly can't extract it
              keySentenceText = "";
            }
          }

          // If we can't extract correction, try to infer from report recommendations
          let correctionText = "";
          if (correction) {
            correctionText = `**${correction}**`;
          } else if (priorReportSnippet) {
            // Try to infer from report - look for action items or focus areas
            const actionMatch = priorReportSnippet.match(
              /(?:focus|work on|action|next step)[\s\S]{0,100}(.{30,100})/i
            );
            if (actionMatch) {
              correctionText = `**${actionMatch[1].trim().substring(0, 100)}**`;
            } else {
              // Use a generic but meaningful fallback
              correctionText = `**structural alignment and entry threshold work**`;
            }
          }

          const questionText = correction
            ? `Since this report (${
                reportDate || "recently"
              }), have you made any progress on ${correction.substring(0, 50)}?`
            : `Since this report (${
                reportDate || "recently"
              }), what has changed or stayed the same?`;

          nextMessage = {
            role: "assistant",
            content: `Welcomee back${name}. I've loaded your last report.

I want to reflect it back to you first — simply and cleanly — before we move anywhere.

Your structure at the last check-in was very clear:
${metricsSection}

${
  keySentenceText
    ? `This is the key sentence from your map, distilled:

${keySentenceText}

`
    : ""
}${
              correction
                ? `Nothing in your report pointed to laziness, lack of capacity, or being "behind." It pointed to your structure — ${correction.substring(
                    0,
                    100
                  )}.`
                : ""
            }

${
  correctionText
    ? `Your **entire correction** was about one thing only:
${correctionText}

`
    : ""
}Before I update anything, I need to check one thing — slowly.

**Since this report (${reportDate || "recently"}):**

${questionText}

Just answer that.`,
          };
        } else {
          nextMessage = {
            role: "assistant",
            content: "I'm here. How can I help you today?",
          };
        }
      }
    }

    // Clean up numbered questions in discovery mode
    if (
      isDiscoveryMode &&
      nextMessage &&
      typeof nextMessage.content === "string"
    ) {
      nextMessage.content = nextMessage.content
        .replace(/^\s*Q\d+\s*[—–-]?\s*/gim, "") // Remove Q1 — at start
        .replace(/\*\*Q\d+\s*[—–-]?\s*\*\*/g, "") // Remove **Q1 —**
        .replace(/Q\d+\s*[—–-]?\s*/g, "") // Remove any Q1 — in text
        .replace(/Q\d+\)\s*/g, "") // Remove Q1) pattern
        .trim();

      // Ensure we still have content after cleanup
      if (!nextMessage.content || nextMessage.content.trim() === "") {
        const lastUserMsg =
          transcript.filter((m) => m.role === "user").slice(-1)[0]?.content ||
          "";
        nextMessage.content = `I hear you. ${
          lastUserMsg
            ? `You mentioned "${lastUserMsg}" - what's coming up for you around that?`
            : "What's on your mind?"
        }`;
      }
    }

    // Hard-prefix the resume notice if provided, last turn was assistant, and not already present (only for diagnostic mode).
    if (
      !isDiscoveryMode &&
      resumeNotice &&
      lastTurnAssistant &&
      nextMessage &&
      typeof nextMessage.content === "string" &&
      !nextMessage.content.includes(resumeNotice)
    ) {
      nextMessage = {
        ...nextMessage,
        content: `${resumeNotice}\n\n${nextMessage.content}`.trim(),
      };
    }

    // Strip any leading filler before the first Q-line; keep resume notice if present (only for diagnostic mode).
    if (
      !isDiscoveryMode &&
      nextMessage &&
      typeof nextMessage.content === "string"
    ) {
      const lines = nextMessage.content.split(/\r?\n/);
      // Only strip down to the Q-line when resuming after an assistant turn; otherwise keep acknowledgments.
      if (lastTurnAssistant) {
        const qIndex = lines.findIndex((ln) => /^\s*\**Q\d+/i.test(ln.trim()));
        if (qIndex > -1) {
          const kept = lines.slice(qIndex).join("\n").trim();
          const hasResume =
            resumeNotice && nextMessage.content.includes(resumeNotice);
          nextMessage = {
            ...nextMessage,
            content: hasResume ? `${resumeNotice}\n\n${kept}`.trim() : kept,
          };
        }
      }
    }

    // Build updated transcript including the assistant reply we just generated (for resume after refresh).
    const updatedTranscript = nextMessage
      ? [...transcript, nextMessage]
      : [...transcript];

    // Maintain accepted answers per distinct Q# to support resume.
    const acceptedAnswers = Array.isArray(existingState.acceptedAnswers)
      ? [...existingState.acceptedAnswers]
      : [];
    if (aiAnswered && lastAssistant) {
      const qNum = extractQuestionNumber(lastAssistant.content);
      if (qNum) {
        const idx = acceptedAnswers.findIndex(
          (a) => Number(a.questionNumber) === Number(qNum)
        );
        const entry = {
          questionNumber: qNum,
          questionText: lastAssistant.content,
          answerText: lastUser?.content || "",
        };
        if (idx >= 0) {
          acceptedAnswers[idx] = entry;
        } else {
          acceptedAnswers.push(entry);
        }
      }
    }

    // Compute distinct questions answered: count unique/distinct question numbers only, excluding the pending one.
    const answeredCount = distinctQuestionsAnswered
      ? distinctQuestionsAnswered - (pendingQuestion ? 1 : 0)
      : 0;

    // Persist intake progress (draft) so we can resume after refresh.
    const intakeState = {
      transcript: updatedTranscript,
      acceptedAnswers,
      answeredCount,
      lastQuestionNumber: maxQuestionNumber,
      pendingQuestion,
      updatedAt: new Date().toISOString(),
      // Persist the "requesting new diagnostic" flag so we stay in diagnostic mode
      // Clear it only after all 12 questions are answered and report is generated
      requestingNewDiagnostic:
        wantsNewDiagnostic || existingState.requestingNewDiagnostic || false,
    };

    if (existingDiagnostic) {
      await existingDiagnostic.update({
        title:
          existingDiagnostic.title ||
          `Euphoriam Intake (Draft) – ${
            existingDiagnostic?.data?.profile?.name || name
          }`,
        data: {
          ...(existingDiagnostic.data || {}),
          intakeState,
        },
      });
    } else {
      await Diagnostic.create({
        userId: appUser.id || null,
        email,
        title: `Euphoriam Intake (Draft) – ${name}`,
        data: {
          profile: { name, email },
          intakeState,
        },
      });
    }

    // If we've gathered all answers, auto-generate the diagnostic/PDF
    // This applies to both first-time diagnostics and new diagnostics requested by user
    if (
      (!hasExistingReport || wantsNewDiagnostic) &&
      answeredCount >= targetCount &&
      !pendingQuestion &&
      aiAnswered
    ) {
      // Use cached Kajabi data (already fetched once at the beginning)
      // Generate metrics from user's input (transcript) - not from Kajabi
      // Metrics will be calculated by AI from the user's answers
      const metrics = {};

      const finalizeRetrieved = lastUser?.content
        ? await retrieveSimilarChunks({ query: lastUser.content, topK: 3 })
        : [];
      const prompt = await getLatestPromptFromDb();
      // Extract string content from prompt object, or use fallback
      const promptContent =
        typeof prompt === "string"
          ? prompt
          : prompt?.fullPrompt || prompt?.content;
      const finalizeResponse = await openai.chat.completions.create({
        model: "gpt-5.2",
        messages: [
          { role: "system", content: promptContent },
          {
            role: "user",
            content: buildFinalReportPrompt({
              // customerContext: diagnosticContext, // Commented out - not using Kajabi data for now
              customerContext: null, // Not using Kajabi data for now
              intakeAnswers: transcript,
              introPageText: introText,
              retrieved: finalizeRetrieved,
              previousReport: priorReportSnippet,
            }),
          },
        ],
        temperature: 0.15,
        max_completion_tokens: 4500,
      });

      let reportText = (
        finalizeResponse?.choices?.[0]?.message?.content || ""
      ).trim();
      reportText = sanitizeReportText(reportText, metrics);

      // Ensure email is valid and data is not null
      if (!email || typeof email !== "string" || !email.includes("@")) {
        console.error("[diagnostic] Invalid email:", email);
        return errorResponse(res, "Invalid email address", 400);
      }

      // Extract name from email or use provided name
      const userName = name || email?.split("@")[0] || "User";

      const diagnosticPayload = {
        userId: appUser.id || null,
        email: email.trim(),
        title: `Euphoriam Diagnostic v3 (Freeform) – ${userName}`,
        data: {
          diagnosticVersion: 3,
          generatedAt: new Date(),
          profile: {
            name: userName,
            email: email.trim(),
          },
          metrics, // Metrics will be extracted from the report by AI
          previousReports,
          intakeTranscript: updatedTranscript,
          aiReport: reportText,
          intakeState: {
            ...intakeState,
            finalizedAt: new Date().toISOString(),
          },
        },
      };

      // Always try to find existing diagnostic first to avoid unique constraint violations
      let diagnostic = existingDiagnostic;
      if (!diagnostic) {
        // Try to find by email in case existingDiagnostic was null but one exists
        diagnostic = await Diagnostic.findOne({ where: { email } });
      }

      // If user requested a new diagnostic and one exists, preserve the old report in previousReports
      if (wantsNewDiagnostic && diagnostic && diagnostic.data?.aiReport) {
        const oldReportEntry = {
          aiReport: diagnostic.data.aiReport,
          pdfUrl: diagnostic.data.pdf?.url || null,
          savedAt:
            diagnostic.updatedAt ||
            diagnostic.createdAt ||
            new Date().toISOString(),
        };
        diagnosticPayload.data.previousReports = Array.isArray(
          diagnostic.data.previousReports
        )
          ? [...diagnostic.data.previousReports, oldReportEntry]
          : [oldReportEntry];
      }

      // Clear the requestingNewDiagnostic flag after report is generated
      if (diagnosticPayload.data.intakeState) {
        diagnosticPayload.data.intakeState.requestingNewDiagnostic = false;
      }

      if (diagnostic) {
        diagnostic = await diagnostic.update(diagnosticPayload);
      } else {
        try {
          diagnostic = await Diagnostic.create(diagnosticPayload);
        } catch (createError) {
          // If creation fails due to unique constraint, try to find and update
          if (
            createError.name === "SequelizeUniqueConstraintError" ||
            createError.name === "ValidationError"
          ) {
            diagnostic = await Diagnostic.findOne({ where: { email } });
            if (diagnostic) {
              diagnostic = await diagnostic.update(diagnosticPayload);
            } else {
              throw createError;
            }
          } else {
            throw createError;
          }
        }
      }

      const pdfPath = await generateDiagnosticPdf(diagnostic);
      let pdf = { path: pdfPath, url: null };
      try {
        const buffer = await fs.promises.readFile(pdfPath);
        const upload = await uploadBufferToSupabase({
          buffer,
          objectPath: `diagnostics/${diagnostic.id || Date.now()}.pdf`,
          contentType: "application/pdf",
        });
        pdf = upload;
        console.log("[diagnostic] PDF uploaded to Supabase", upload);
        await diagnostic.update({
          data: {
            ...(diagnostic.data || {}),
            pdf,
          },
        });
      } catch (err) {
        console.error(
          "[diagnostic] Failed to upload diagnostic PDF to Supabase",
          err
        );
      }

      // Email the user their report
      await sendEmail(
        email,
        "Your Diagnostic Report – Euphoraum-AI",
        diagnosticReportEmail(userName),
        pdfPath
      );

      await persistDiscoveryRecord({
        userId: appUser?.id || diagnostic.userId || 0,
        email,
        title: diagnosticPayload.title,
        transcript: updatedTranscript,
        previousReport: existingReport,
        newReport: reportText,
        diagnosticId: diagnostic.id,
        pdfUrl: pdf.url || null,
      });

      return successResponse(res, "Chatbot diagnostic (auto-finalized)", {
        diagnosticId: diagnostic.id,
        diagnostic: diagnostic.data,
        pdfPath,
        pdfUrl: pdf.url || null,
        reportText,
        autoFinalized: true,
        resumeNotice,
        status: "completed",
        statusMessage:
          "Report generated, PDF compiled, and emailed successfully",
        userMessage: `Your new diagnostic report has been generated and emailed to ${email}. Please check your inbox.`,
      });
    }

    // For discovery mode: Check if user wants to end/generate report or has replied perfectly
    // Also check if the bot previously signaled the end and user just responded
    if (isDiscoveryMode && lastUser) {
      const {
        detectUserWantsToEndOrGenerateReport,
        detectConversationComplete,
        detectBotSignaledEnd,
      } = require("../utils/validation");

      const wantsToEndOrGenerate = await detectUserWantsToEndOrGenerateReport({
        userMessage: lastUser.content,
        transcript: updatedTranscript,
      });

      // Check if the bot's PREVIOUS message (before user's response) signaled the end
      // If bot signaled end in previous message and user just responded, conversation is complete
      let botPreviouslySignaledEnd = false;
      if (lastAssistant) {
        botPreviouslySignaledEnd = await detectBotSignaledEnd({
          lastAssistantMessage: lastAssistant,
          transcript: transcript, // Use original transcript, not updated (before nextMessage)
        });
      }

      // If bot previously signaled end and user just responded, conversation is complete
      const conversationComplete =
        botPreviouslySignaledEnd ||
        (await detectConversationComplete({
          transcript: updatedTranscript,
          lastUserMessage: lastUser,
          lastAssistantMessage: lastAssistant, // Check the previous assistant message
        }));

      // If user wants to end/generate report OR conversation is complete, generate discovery report
      if (wantsToEndOrGenerate || conversationComplete) {
        // No Kajabi data needed - use user input only
        const userName = name || email?.split("@")[0] || "User";

        // Get previous discovery if exists
        const previousDiscoveries = await Discovery.findAll({
          where: {
            userId: existingDiagnostic?.userId || appUser?.id || null,
          },
          order: [["createdAt", "DESC"]],
          limit: 1,
        });
        const previousDiscovery = previousDiscoveries[0];

        // Generate discovery report using old diagnostic + previous discovery if exists
        // Format should match the full diagnostic PDF format
        const discoveryPrompt = `
You are generating a FULL DISCOVERY REPORT in PDF format for Euphoriam AI.

Context: The user already has a completed diagnostic report and may have previous discovery sessions.

Previous diagnostic (reference):
${priorReportSnippet || "None"}

${
  previousDiscovery
    ? `Previous discovery report (reference):
${truncateForContext(
  previousDiscovery.data?.newReportSnippet ||
    previousDiscovery.data?.newReport ||
    "",
  4000
)}`
    : ""
}

New conversation transcript (latest messages last):
${JSON.stringify(updatedTranscript, null, 2)}

Client Name: ${userName}
Client ID: N/A
Report Type: Full Diagnostic (Updated)
Date: ${new Date().toLocaleDateString("en-US", {
          month: "short",
          day: "numeric",
          year: "numeric",
        })}

CRITICAL: You MUST generate the report in the EXACT format that matches the diagnostic report format. The report MUST start with the intro page format below.

Generate a FULL DISCOVERY REPORT following this EXACT format (start with divider lines and intro page):

----------------------------------------

✨ BEFORE YOU READ THIS DIAGNOSTIC
A Message About What You're About to Receive
This document is not a simple write-up.
It is a map of the structures governing your inner reality.
It outlines:
● the architecture of your identity
● the gravitational pulls in your field
● the multidimensional coding you carry
● the vortex behind your resistance
● the subatomic themes you inherited
● the patterns that shape your outcomes
● and the version of you trying to emerge
This is not about psychology.
This is not about mindset.
This is not about behaviour.
It is about consciousness physics — the forces beneath your thoughts, choices, and reality.
Inside this diagnostic, you will see:
● the hidden rules your identity has been obeying
● the roles you inherited without choosing
● the avoidance strategies that protect your deeper power
● the structural reasons your expansion has looped
● and the exact levers that move your destiny timeline
You'll also see your:
● Gravity (the pull of old identity)
● Signal Output (your broadcast strength)
● Quantum Genius Codes
● Consciousness Level
● Signal Coherence
● Vortex
Read this slowly.
Let each section land in your body.
This is not new information.
This is recognition.
Your deeper identity already knows every word.
Once you see your structure clearly — reality reorganises around it.
This is your map.
And now that you have it, everything changes.

----------------------------------------

SECTION 1 — Structure Type Detection
[Analyze their primary structure based on metrics and conversation]

SECTION 2 — Avoidance Behaviour Mapping
[Identify their avoidance patterns from the conversation]

SECTION 3 — Vortex Settings
[Map their vortex type and activation points]

SECTION 4 — 3D Code (Gravity %)
[Gravity percentage and what it's doing - use exact value: ${
          diagnosticMetrics.gravity || "N/A"
        }%]

SECTION 5 — Consciousness Level (CL)
[CL level and interpretation - use exact value: ${
          diagnosticMetrics.consciousnessLevel || "N/A"
        }]

SECTION 6 — Quantum Genius Codes (QGC)
[QGC activation percentage and what it looks like - use exact value: ${
          diagnosticMetrics.qgcActivation || "N/A"
        }%]

SECTION 7 — Signal Coherence
[Signal Coherence analysis - use exact value: ${
          diagnosticMetrics.signalCoherence || "N/A"
        }%]

SECTION 8 — Signal Output (IP-Protected)
[Signal Output analysis - use exact value: ${
          diagnosticMetrics.signalOutput || "N/A"
        }%]

SECTION 9 — Angle of Growth
[Their growth axis based on structure]

SECTION 10 — First Correction
[What corrections were made in this session]

Metrics Gauge
QGC Activation:     ${renderGauge(diagnosticMetrics.qgcActivation || 0)}
Consciousness Level: ${renderGauge(
          (diagnosticMetrics.consciousnessLevel || 0) * 20
        )}
Gravity:             ${renderGauge(diagnosticMetrics.gravity || 0)}
Signal Coherence:    ${renderGauge(diagnosticMetrics.signalCoherence || 0)}
Signal Output:       ${renderGauge(diagnosticMetrics.signalOutput || 0)}

Unlimited Creator Recommendations
[Recommendations based on their structure]

Evolution Notes
[Notes on their evolution and progress]

Final Summary
[Summary paragraph]

End of Report

Generate the full report in this exact format.`;

        let discoveryReport = "";
        try {
          const aiDiscovery = await openai.chat.completions.create({
            model: "gpt-5.2",
            messages: [{ role: "user", content: discoveryPrompt }],
            temperature: 0.15,
            max_completion_tokens: 4500,
          });
          discoveryReport =
            aiDiscovery?.choices?.[0]?.message?.content?.trim() || "";
        } catch (err) {
          console.error("[discovery] failed to generate follow-up report", err);
        }

        if (discoveryReport) {
          // Determine discovery type from request or default to integrated
          const discoveryType = req.body.discoveryType || "integrated";

          // Get user ID from diagnostic or find by email
          const userForDiscovery = existingDiagnostic?.userId
            ? await User.findByPk(existingDiagnostic.userId)
            : await User.findOne({ where: { email } });

          // Generate PDF for discovery report
          // Create a diagnostic-like object for PDF generation
          const discoveryForPdf = {
            id: existingDiagnostic?.id || Date.now(),
            title: `Discovery Follow-up – ${userName}`,
            userId: userForDiscovery?.id || existingDiagnostic?.userId || null,
            data: {
              profile: {
                name: userName,
                email: email,
              },
              aiReport: discoveryReport,
              metrics: diagnosticMetrics,
            },
          };

          let pdfPath = null;
          let pdfUrl = null;
          try {
            pdfPath = await generateDiagnosticPdf(discoveryForPdf);

            // Upload PDF to Supabase
            if (pdfPath) {
              const buffer = await fs.promises.readFile(pdfPath);
              const upload = await uploadBufferToSupabase({
                buffer,
                objectPath: `discoveries/discovery-${
                  existingDiagnostic?.id || Date.now()
                }-${Date.now()}.pdf`,
                contentType: "application/pdf",
              });
              pdfUrl = upload.url || null;
            }
          } catch (err) {
            console.error("[discovery] PDF generation/upload failed", err);
          }

          await persistDiscoveryRecord({
            userId: userForDiscovery?.id || existingDiagnostic?.userId || null,
            email,
            title: `Discovery Follow-up – ${userName}`,
            transcript: updatedTranscript,
            previousReport: priorReportSnippet,
            newReport: discoveryReport,
            diagnosticId: existingDiagnostic?.id || null,
            pdfUrl: pdfUrl || existingDiagnostic?.data?.pdf?.url || null,
            discoveryType,
          });

          if (email) {
            // Email with PDF attachment if available
            if (pdfPath) {
              await sendEmail(
                email,
                "Your Discovery Report – Euphoriam AI",
                discoveryReportEmail(userName),
                pdfPath
              );
            } else {
              // Fallback to basic email if PDF generation failed
              await sendEmailBasic(
                email,
                "Your discovery follow-up",
                discoveryReport.replace(/\n/g, "<br/>")
              );
            }
          }

          return successResponse(res, "Discovery chat saved", {
            discovery: true,
            message: "Discovery chat saved and emailed.",
            discoveryReport: discoveryReport || null,
            pdfPath: pdfPath || null,
            pdfUrl: pdfUrl || null,
            autoGenerated: true,
            status: "completed",
            statusMessage:
              "Report generated, PDF compiled, and emailed successfully",
            userMessage: `Your new discovery report has been generated and emailed to ${email}. Please check your inbox.`,
          });
        }
      }
    }

    return successResponse(res, "Next chatbot message", {
      nextMessage,
      introPageText: introText,
      transcript: updatedTranscript,
      intakeState,
      retrieved,
      resumeNotice,
      answeredCount,
      pendingQuestion,
      aiAnswered,
      status: "chatting",
      statusMessage: "Chatting in progress",
    });
  }

  const transcriptForFinal =
    (Array.isArray(existingState.transcript) && existingState.transcript.length
      ? existingState.transcript
      : transcript) || [];

  const lastUser = [...transcriptForFinal]
    .reverse()
    .find((m) => m?.role === "user");
  const retrieved = lastUser?.content
    ? await retrieveSimilarChunks({ query: lastUser.content, topK: 3 })
    : [];

  if (hasExistingReport) {
    // Get previous discovery if exists
    const previousDiscoveries = await Discovery.findAll({
      where: {
        userId: existingDiagnostic?.userId || appUser?.id || null,
      },
      order: [["createdAt", "DESC"]],
      limit: 1,
    });
    const previousDiscovery = previousDiscoveries[0];

    // Generate a FULL discovery report using prior diagnostic + new transcript
    const discoveryPrompt = `
You are generating a FULL DISCOVERY REPORT in PDF format for Euphoriam AI.

Context: The user already has a completed diagnostic report and may have previous discovery sessions.

Previous diagnostic (reference):
${priorReportSnippet || "None"}

${
  previousDiscovery
    ? `Previous discovery report (reference):
${truncateForContext(
  previousDiscovery.data?.newReportSnippet ||
    previousDiscovery.data?.newReport ||
    "",
  4000
)}`
    : ""
}

New conversation transcript (latest messages last):
${JSON.stringify(transcriptForFinal, null, 2)}

Client Name: ${name || email?.split("@")[0] || "User"}
Client ID: N/A
Report Type: Full Diagnostic (Updated)
Date: ${new Date().toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
    })}

CRITICAL: You MUST generate the report in the EXACT format that matches the diagnostic report format. The report MUST start with the intro page format below.

Generate a FULL DISCOVERY REPORT following this EXACT format (start with divider lines and intro page):

----------------------------------------

✨ BEFORE YOU READ THIS DIAGNOSTIC
A Message About What You're About to Receive
This document is not a simple write-up.
It is a map of the structures governing your inner reality.
It outlines:
● the architecture of your identity
● the gravitational pulls in your field
● the multidimensional coding you carry
● the vortex behind your resistance
● the subatomic themes you inherited
● the patterns that shape your outcomes
● and the version of you trying to emerge
This is not about psychology.
This is not about mindset.
This is not about behaviour.
It is about consciousness physics — the forces beneath your thoughts, choices, and reality.
Inside this diagnostic, you will see:
● the hidden rules your identity has been obeying
● the roles you inherited without choosing
● the avoidance strategies that protect your deeper power
● the structural reasons your expansion has looped
● and the exact levers that move your destiny timeline
You'll also see your:
● Gravity (the pull of old identity)
● Signal Output (your broadcast strength)
● Quantum Genius Codes
● Consciousness Level
● Signal Coherence
● Vortex
Read this slowly.
Let each section land in your body.
This is not new information.
This is recognition.
Your deeper identity already knows every word.
Once you see your structure clearly — reality reorganises around it.
This is your map.
And now that you have it, everything changes.

----------------------------------------

SECTION 1 — Structure Type Detection
[Analyze their primary structure based on metrics and conversation]

SECTION 2 — Avoidance Behaviour Mapping
[Identify their avoidance patterns from the conversation]

SECTION 3 — Vortex Settings
[Map their vortex type and activation points]

SECTION 4 — 3D Code (Gravity %)
[Gravity percentage and what it's doing - use exact value: ${
      metrics.gravity || "N/A"
    }%]

SECTION 5 — Consciousness Level (CL)
[CL level and interpretation - use exact value: ${
      metrics.consciousnessLevel || "N/A"
    }]

SECTION 6 — Quantum Genius Codes (QGC)
[QGC activation percentage and what it looks like - use exact value: ${
      metrics.qgcActivation || "N/A"
    }%]

SECTION 7 — Signal Coherence
[Signal Coherence analysis - use exact value: ${
      metrics.signalCoherence || "N/A"
    }%]

SECTION 8 — Signal Output (IP-Protected)
[Signal Output analysis - use exact value: ${metrics.signalOutput || "N/A"}%]

SECTION 9 — Angle of Growth
[Their growth axis based on structure]

SECTION 10 — First Correction
[What corrections were made in this session]

Metrics Gauge
QGC Activation:     ${renderGauge(metrics.qgcActivation || 0)}
Consciousness Level: ${renderGauge((metrics.consciousnessLevel || 0) * 20)}
Gravity:             ${renderGauge(metrics.gravity || 0)}
Signal Coherence:    ${renderGauge(metrics.signalCoherence || 0)}
Signal Output:       ${renderGauge(metrics.signalOutput || 0)}

Unlimited Creator Recommendations
[Recommendations based on their structure]

Evolution Notes
[Notes on their evolution and progress]

Final Summary
[Summary paragraph]

End of Report

Generate the full report in this exact format.`;

    let discoveryReport = "";
    try {
      const aiDiscovery = await openai.chat.completions.create({
        model: "gpt-5.2",
        messages: [{ role: "user", content: discoveryPrompt }],
        temperature: 0.15,
        max_completion_tokens: 4500,
      });
      discoveryReport =
        aiDiscovery?.choices?.[0]?.message?.content?.trim() || "";
    } catch (err) {
      console.error("[discovery] failed to generate follow-up report", err);
    }

    // Determine discovery type from request or default to integrated
    const discoveryType = req.body.discoveryType || "integrated";

    // Get user ID from diagnostic or find by email
    const userForDiscovery = existingDiagnostic?.userId
      ? await User.findByPk(existingDiagnostic.userId)
      : await User.findOne({ where: { email } });

    // Generate PDF for discovery report
    let pdfPath = null;
    let pdfUrl = null;
    if (discoveryReport) {
      try {
        // Create a diagnostic-like object for PDF generation
        const discoveryForPdf = {
          id: existingDiagnostic?.id || Date.now(),
          title: `Discovery Follow-up – ${
            name || email?.split("@")[0] || "User"
          }`,
          userId: userForDiscovery?.id || existingDiagnostic?.userId || null,
          data: {
            profile: {
              name: name || email?.split("@")[0] || "User",
              email: email,
            },
            aiReport: discoveryReport,
            metrics: diagnosticMetrics, // Use metrics from existing diagnostic
          },
        };

        pdfPath = await generateDiagnosticPdf(discoveryForPdf);

        // Upload PDF to Supabase
        if (pdfPath) {
          const buffer = await fs.promises.readFile(pdfPath);
          const upload = await uploadBufferToSupabase({
            buffer,
            objectPath: `discoveries/discovery-${
              existingDiagnostic?.id || Date.now()
            }-${Date.now()}.pdf`,
            contentType: "application/pdf",
          });
          pdfUrl = upload.url || null;
        }
      } catch (err) {
        console.error("[discovery finalize] PDF generation/upload failed", err);
      }
    }

    await persistDiscoveryRecord({
      userId: userForDiscovery?.id || existingDiagnostic?.userId || null,
      email,
      title: `Discovery Follow-up – ${name || email?.split("@")[0] || "User"}`,
      transcript: transcriptForFinal,
      previousReport: priorReportSnippet,
      newReport: discoveryReport,
      diagnosticId: existingDiagnostic?.id || null,
      pdfUrl: pdfUrl || existingDiagnostic?.data?.pdf?.url || null,
      discoveryType,
    });

    if (email) {
      // Email with PDF attachment if available
      if (pdfPath && discoveryReport) {
        await sendEmail(
          email,
          "Your Discovery Report – Euphoriam AI",
          discoveryReportEmail(name || email?.split("@")[0] || "User"),
          pdfPath
        );
      } else {
        // Fallback to basic email if PDF generation failed
        await sendEmailBasic(
          email,
          "Your discovery follow-up",
          discoveryReport
            ? discoveryReport.replace(/\n/g, "<br/>")
            : buildDiscoveryEmail({ transcript: transcriptForFinal, email })
        );
      }
    }

    return successResponse(res, "Discovery chat saved", {
      discovery: true,
      message: "Discovery chat saved and emailed.",
      discoveryReport: discoveryReport || null,
      pdfPath: pdfPath || null,
      pdfUrl: pdfUrl || null,
      status: "completed",
      statusMessage: "Report generated, PDF compiled, and emailed successfully",
      userMessage: `Your new discovery report has been generated and emailed to ${email}. Please check your inbox.`,
    });
  }
  const prompt = await getLatestPromptFromDb();
  // Extract string content from prompt object, or use fallback
  const promptContent =
    typeof prompt === "string" ? prompt : prompt?.fullPrompt || prompt?.content;

  const aiResponse = await openai.chat.completions.create({
    model: "gpt-5.2",
    messages: [
      { role: "system", content: promptContent },
      {
        role: "user",
        content: buildFinalReportPrompt({
          // customerContext: diagnosticContext, // Commented out - not using Kajabi data for now
          customerContext: null, // Not using Kajabi data for now
          intakeAnswers: transcriptForFinal,
          introPageText: introText,
          retrieved,
          previousReport: priorReportSnippet,
        }),
      },
    ],
    temperature: 0.15,
    max_completion_tokens: 4500,
  });

  const reportText = (aiResponse?.choices?.[0]?.message?.content || "").trim();

  if (!reportText) {
    return errorResponse(
      res,
      "AI returned empty diagnostic report. Please retry.",
      502
    );
  }

  // Ensure email is valid and data is not null
  if (!email || typeof email !== "string" || !email.includes("@")) {
    console.error("[diagnostic] Invalid email:", email);
    return errorResponse(res, "Invalid email address", 400);
  }

  // Extract name from email or use provided name
  const userName = name || email?.split("@")[0] || "User";

  const finalPayload = {
    userId: appUser.id || null,
    email: email.trim(),
    title: `Euphoriam Diagnostic v3 (Freeform) – ${userName}`,
    data: {
      diagnosticVersion: 3,
      generatedAt: new Date(),
      profile: {
        name: userName,
        email: email.trim(),
      },
      metrics, // Metrics will be extracted from the report by AI
      previousReports,
      intakeTranscript: transcriptForFinal,
      aiReport: reportText,
      intakeState: {
        ...(existingState || {}),
        transcript: transcriptForFinal,
        finalizedAt: new Date().toISOString(),
      },
    },
  };

  // Always try to find existing diagnostic first to avoid unique constraint violations
  let diagnostic = existingDiagnostic;
  if (!diagnostic) {
    // Try to find by email in case existingDiagnostic was null but one exists
    diagnostic = await Diagnostic.findOne({ where: { email } });
  }

  if (diagnostic) {
    diagnostic = await diagnostic.update(finalPayload);
  } else {
    try {
      diagnostic = await Diagnostic.create(finalPayload);
    } catch (createError) {
      // If creation fails due to unique constraint, try to find and update
      if (
        createError.name === "SequelizeUniqueConstraintError" ||
        createError.name === "ValidationError"
      ) {
        diagnostic = await Diagnostic.findOne({ where: { email } });
        if (diagnostic) {
          diagnostic = await diagnostic.update(finalPayload);
        } else {
          throw createError;
        }
      } else {
        throw createError;
      }
    }
  }

  const pdfPath = await generateDiagnosticPdf(diagnostic);
  let pdf = { path: pdfPath, url: null };
  try {
    const buffer = await fs.promises.readFile(pdfPath);
    const upload = await uploadBufferToSupabase({
      buffer,
      objectPath: `diagnostics/${diagnostic.id || Date.now()}.pdf`,
      contentType: "application/pdf",
    });
    pdf = upload;
    console.log("[diagnostic] PDF uploaded to Supabase", upload);
    await diagnostic.update({
      data: {
        ...(diagnostic.data || {}),
        pdf,
      },
    });
  } catch (err) {
    console.error(
      "[diagnostic] Failed to upload diagnostic PDF to Supabase",
      err
    );
  }

  // Email the user their updated report
  await sendEmail(
    email,
    "Your Diagnostic Report – Euphoraum-AI",
    diagnosticReportEmail(userName),
    pdfPath
  );

  // Get user ID from diagnostic or find by email
  const userForFinal = diagnostic?.userId
    ? await User.findByPk(diagnostic.userId)
    : await User.findOne({ where: { email } });

  await persistDiscoveryRecord({
    userId: userForFinal?.id || diagnostic?.userId || null,
    email,
    title: finalPayload.title,
    transcript: transcriptForFinal,
    previousReport: existingReport,
    newReport: reportText,
    diagnosticId: diagnostic.id,
    pdfUrl: pdf.url || null,
  });

  return successResponse(res, "Chatbot diagnostic (freeform) generated", {
    diagnosticId: diagnostic.id,
    diagnostic: diagnostic.data,
    pdfPath,
    pdfUrl: pdf.url || null,
    reportText,
    status: "completed",
    statusMessage: "Report generated, PDF compiled, and emailed successfully",
    userMessage: `Your new diagnostic report has been generated and emailed to ${email}. Please check your inbox.`,
  });
};

const listMine = async (req, res) => {
  const diagnostics = await Diagnostic.findAll({
    where: { email: req.body.email },
    order: [["createdAt", "DESC"]],
  });
  return successResponse(res, "Diagnostics fetched", diagnostics);
};

const listAll = async (_req, res) => {
  const diagnostics = await Diagnostic.findAll({
    order: [["createdAt", "DESC"]],
  });
  return successResponse(res, "Diagnostics fetched", diagnostics);
};

const getById = async (req, res) => {
  const diagnostic = await Diagnostic.findByPk(req.params.id);
  if (!diagnostic) {
    return errorResponse(res, "Diagnostic not found", 404);
  }

  return successResponse(res, "Diagnostic fetched", diagnostic);
};

const getAllPdfUrls = async (req, res) => {
  const { email } = req.body || req.query || {};

  if (!email) {
    return errorResponse(res, "Email is required", 400);
  }

  try {
    // Get all diagnostics for this email
    const diagnostics = await Diagnostic.findAll({
      where: { email },
      order: [["createdAt", "DESC"]],
    });

    // Get all discoveries for this email (query all and filter by email in data field)
    const allDiscoveries = await Discovery.findAll({
      order: [["createdAt", "DESC"]],
    });
    const discoveries = allDiscoveries.filter((d) => d.data?.email === email);

    const allPdfUrls = [];

    // Extract PDF URLs from diagnostics
    diagnostics.forEach((diagnostic) => {
      const data = diagnostic.data || {};

      // Current PDF URL
      if (data.pdf?.url) {
        allPdfUrls.push({
          type: "diagnostic",
          diagnosticId: diagnostic.id,
          title: diagnostic.title || `Diagnostic Report ${diagnostic.id}`,
          url: data.pdf.url,
          createdAt: diagnostic.createdAt,
          isCurrent: true,
        });
      }

      // PDF URLs array
      if (Array.isArray(data.pdfUrls)) {
        data.pdfUrls.forEach((url, index) => {
          // Skip if it's the same as current PDF
          if (url !== data.pdf?.url) {
            allPdfUrls.push({
              type: "diagnostic",
              diagnosticId: diagnostic.id,
              title: `${
                diagnostic.title || `Diagnostic ${diagnostic.id}`
              } - Version ${index + 1}`,
              url: url,
              createdAt: diagnostic.updatedAt || diagnostic.createdAt,
              isCurrent: false,
            });
          }
        });
      }

      // Previous reports PDF URLs
      if (Array.isArray(data.previousReports)) {
        data.previousReports.forEach((prevReport, index) => {
          if (prevReport.pdfUrl) {
            allPdfUrls.push({
              type: "diagnostic_previous",
              diagnosticId: diagnostic.id,
              title: `Previous Report ${index + 1} - ${
                diagnostic.title || `Diagnostic ${diagnostic.id}`
              }`,
              url: prevReport.pdfUrl,
              createdAt: prevReport.savedAt
                ? new Date(prevReport.savedAt)
                : diagnostic.createdAt,
              isCurrent: false,
            });
          }
        });
      }
    });

    // Extract PDF URLs from discoveries
    discoveries.forEach((discovery) => {
      const data = discovery.data || {};
      if (data.pdfUrl) {
        allPdfUrls.push({
          type: "discovery",
          discoveryId: discovery.id,
          diagnosticId: data.diagnosticId || null,
          title: discovery.title || `Discovery Report ${discovery.id}`,
          url: data.pdfUrl,
          createdAt: discovery.createdAt,
          isCurrent: false,
        });
      }
    });

    // Sort by creation date (newest first)
    allPdfUrls.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    // Remove duplicates based on URL
    const uniqueUrls = [];
    const seenUrls = new Set();
    allPdfUrls.forEach((item) => {
      if (!seenUrls.has(item.url)) {
        seenUrls.add(item.url);
        uniqueUrls.push(item);
      }
    });

    return successResponse(res, "PDF URLs fetched", {
      total: uniqueUrls.length,
      pdfs: uniqueUrls,
    });
  } catch (error) {
    console.error("[getAllPdfUrls] Error:", error);
    return errorResponse(res, "Failed to fetch PDF URLs", 500);
  }
};

// Calculate bottleneck from metrics
const calculateBottleneck = (metrics = {}) => {
  const {
    gravity,
    signalOutput,
    signalCoherence,
    qgcActivation,
    consciousnessLevel,
    engagementScore,
    learningScore,
    commitmentScore,
  } = metrics;

  // Bottleneck is typically the highest gravity or lowest signal metric
  // Priority: gravity (highest), then lowest of signalOutput, signalCoherence, qgcActivation
  const metricValues = [
    { name: "gravity", value: gravity, isHigherWorse: true },
    { name: "signalOutput", value: signalOutput, isHigherWorse: false },
    { name: "signalCoherence", value: signalCoherence, isHigherWorse: false },
    { name: "qgcActivation", value: qgcActivation, isHigherWorse: false },
    {
      name: "consciousnessLevel",
      value: consciousnessLevel * 20,
      isHigherWorse: false,
    }, // Convert 1-5 scale to 0-100
  ];

  // Find the bottleneck (highest gravity or lowest positive metric)
  let bottleneck = metricValues[0]; // Default to gravity

  for (const metric of metricValues) {
    if (metric.isHigherWorse && metric.value > bottleneck.value) {
      bottleneck = metric;
    } else if (
      !metric.isHigherWorse &&
      !bottleneck.isHigherWorse &&
      metric.value < bottleneck.value
    ) {
      bottleneck = metric;
    } else if (metric.isHigherWorse && !bottleneck.isHigherWorse) {
      // Gravity always takes priority if it's high
      if (metric.value > 50) {
        bottleneck = metric;
      }
    }
  }

  // Interpretations for each bottleneck
  const interpretations = {
    gravity: {
      interpretation:
        "High gravity indicates strong resistance patterns and 3D vortex codes creating pull-back. Focus on identifying and releasing avoidance behaviors and structural patterns that create distortion.",
      focusAreas: [
        "Map avoidance behaviors and resistance patterns",
        "Identify 3D vortex codes creating gravity",
        "Work on structural patterns causing distortion",
        "Release inherited roles and hidden rules",
      ],
    },
    signalOutput: {
      interpretation:
        "Low signal output suggests misalignment between what you want to create and your current state. Focus on alignment work and connecting to your authentic genius.",
      focusAreas: [
        "Clarify desired reality and authentic genius",
        "Strengthen alignment between intention and action",
        "Increase coherence in your field",
        "Work on integration of all aspects",
      ],
    },
    signalCoherence: {
      interpretation:
        "Low signal coherence indicates inconsistency between engagement, learning, and commitment. Focus on creating alignment across all areas of your life.",
      focusAreas: [
        "Create consistency between different life areas",
        "Align actions with intentions",
        "Bridge gaps between engagement and learning",
        "Integrate commitment with authentic expression",
      ],
    },
    qgcActivation: {
      interpretation:
        "Low QGC activation suggests the quantum genius codes are not fully activated. Focus on commitment, coherence, and learning to activate your genius codes.",
      focusAreas: [
        "Increase commitment to growth work",
        "Strengthen signal coherence",
        "Deepen learning and integration",
        "Activate quantum genius codes",
      ],
    },
    consciousnessLevel: {
      interpretation:
        "Lower consciousness level indicates need for deeper learning and coherence. Focus on expanding awareness and integrating insights.",
      focusAreas: [
        "Deepen learning and understanding",
        "Increase signal coherence",
        "Expand consciousness through practice",
        "Integrate insights into daily life",
      ],
    },
  };

  const bottleneckInfo = interpretations[bottleneck.name] || {
    interpretation: "Review all metrics to identify focus areas.",
    focusAreas: [
      "Work on overall integration",
      "Focus on structure and vortex mapping",
    ],
  };

  return {
    metric: bottleneck.name,
    value: bottleneck.value,
    ...bottleneckInfo,
  };
};

// Get metrics with bottleneck for a diagnostic
const getMetrics = async (req, res) => {
  try {
    const { id } = req.params;
    const diagnostic = await Diagnostic.findByPk(id);

    if (!diagnostic) {
      return errorResponse(res, "Diagnostic not found", 404);
    }

    // Check authorization
    if (diagnostic.userId !== req.user?.sub && req.user?.role !== "admin") {
      return errorResponse(res, "Forbidden", 403);
    }

    const metrics = diagnostic.data?.metrics || {};
    const bottleneck = calculateBottleneck(metrics);

    return successResponse(res, "Metrics fetched", {
      metrics,
      bottleneck,
    });
  } catch (error) {
    console.error("[getMetrics] Error:", error);
    return errorResponse(res, "Failed to fetch metrics", 500);
  }
};

module.exports = {
  listMine,
  listAll,
  getById,
  chatbotDiagnosticFreeform,
  truncateForContext,
  persistDiscoveryRecord,
  getAllPdfUrls,
  getMetrics,
  calculateBottleneck,
};
