const fs = require("fs");
const { Diagnostic } = require("../models/diagnosticModel");
const { Discovery } = require("../models/discoveryModel");
const { Prompt } = require("../models/promptModel");
const { User } = require("../models/userModel");
const { Chat } = require("../models/chatModel");
const validate = require("../helpers/validate");
const openai = require("../config/openai");
const {
  discoveryReportEmail,
} = require("../utils/emailTemplate/initialDiscoveryReport");

const {
  buildFinalReportPrompt,
  DEFAULT_INTRO_PAGE_TEXT,
  sanitizeReportText,
  // Helper functions
  loadDiagnosticState,
  loadLatestDiscoveryMetrics,
  extractReportDate,
  preparePreviousReports,
  checkWantsNewDiagnostic,
  checkWantsEmail,
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
      model: "gpt-5.2",
      messages: [{ role: "user", content: prompt }],
      temperature: 0,
      max_completion_tokens: 20,
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
      email: email || null,
      diagnosticId: diagnosticId || null,
      transcript: transcript || null,
      previousReportSnippet: previousReport
        ? truncateForContext(previousReport, 1500)
        : null,
      newReportSnippet: newReport ? truncateForContext(newReport, 1500) : null,
      pdfUrl: pdfUrl || null,
      data: {
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

/**
 * ============================================
 * DISCOVERY MODE HANDLER
 * ============================================
 * Handles all discovery mode logic for users with existing reports
 * This includes:
 * - Discovery chat conversations
 * - Generating discovery follow-up reports
 * - Handling discovery finalize requests
 */
const handleDiscoveryMode = async ({
  req,
  res,
  email,
  name,
  messages,
  transcript,
  updatedTranscript,
  existingDiagnostic,
  existingState,
  priorReportSnippet,
  diagnosticMetrics,
  latestDiscoveryMetrics,
  reportDate,
  appUser,
  lastUser,
  lastAssistant,
  nextMessage,
  introText,
  discoveryType,
}) => {
  // Discovery mode: Check if user wants to end/generate report
  // If nextMessage is null, it means we're skipping bot response to generate report directly
  let wantsToEndOrGenerate = false;
  let conversationComplete = false;

  if (nextMessage === null && lastUser) {
    // Skip bot response - generate report immediately (already detected earlier)
    wantsToEndOrGenerate = true;
    conversationComplete = true;
  } else if (lastUser) {
    const {
      detectUserWantsToEndOrGenerateReport,
      detectConversationComplete,
      detectBotSignaledEnd,
    } = require("../utils/validation");

    wantsToEndOrGenerate = await detectUserWantsToEndOrGenerateReport({
      userMessage: lastUser.content,
      transcript: updatedTranscript,
    });

    let botPreviouslySignaledEnd = false;
    if (lastAssistant) {
      botPreviouslySignaledEnd = await detectBotSignaledEnd({
        lastAssistantMessage: lastAssistant,
        transcript: transcript,
      });
    }

    conversationComplete =
      botPreviouslySignaledEnd ||
      (await detectConversationComplete({
        transcript: updatedTranscript,
        lastUserMessage: lastUser,
        lastAssistantMessage: lastAssistant,
      }));
  }

  // If user wants to end/generate report OR conversation is complete, generate discovery report
  if (wantsToEndOrGenerate || conversationComplete) {
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

    // Generate discovery report
    const reportDate = new Date().toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
    const reportVersion = previousDiscovery ? "v3.2" : "v3.1";

    const discoveryPrompt = `
You are generating a FULL DISCOVERY REPORT in PDF format for Euphoriam AI.

Context: The user already has a completed diagnostic report and may have previous discovery sessions.

Previous diagnostic (reference):
${priorReportSnippet || "None"}

${
  previousDiscovery
    ? `Previous discovery report (reference):
${truncateForContext(
  previousDiscovery.newReportSnippet ||
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
Report Type: Structural Update Report
Date: ${reportDate}

CRITICAL: You MUST generate the report in the EXACT format shown below. This is a structural update report based on the conversation interaction.

Generate a FULL DISCOVERY REPORT following this EXACT format:

---

## EUPHORIAM™ STRUCTURAL UPDATE REPORT

**Client:** ${userName}
**Report Type:** Identity Authority Collapse + Gravity Shift (or appropriate type based on conversation)
**Version:** ${reportVersion}
**Date:** ${reportDate}
**Tone:** Warm / Grounded

---

### 1. STRUCTURE TYPE (Updated)

**Primary Structure:**
[Analyze their primary structure based on metrics and conversation - be specific about what changed]

**Key refinement:**
[Explain what has shifted or been refined in their structure based on the conversation]

---

### 2. AVOIDANCE BEHAVIOUR (Resolved Layer)

**Original Pattern:**
[What was the original avoidance pattern from previous report]

**Updated Reading:**
[How the avoidance has changed or been resolved based on the conversation - be specific about what shifted]

---

### 3. VORTEX STATUS

**Previous Vortex:**
[What was the previous vortex state]

**Current State:**
[Current vortex status - use ⚠️ if destabilized, ✅ if stable, etc.]

Why:
[Explain what changed and why based on the conversation]

---

### 4. GRAVITY (3D CODE)

**Previous Gravity:** ~${diagnosticMetrics.gravity || "N/A"}%
**Current Reading:** [Current gravity status - use ↓ if dropping, ↑ if increasing, or stable]

Critical insight:
[Explain what the gravity shift means based on the conversation]

---

### 5. CONSCIOUSNESS LEVEL (CL)

**Previous CL:** ~${diagnosticMetrics.consciousnessLevel || "N/A"}
**Current CL:** [Current CL level]

Marker of shift:
[Explain what changed and what it indicates]

---

### 6. QUANTUM GENIUS CODES (QGC)

**Previous QGC:** ~${diagnosticMetrics.qgcActivation || "N/A"}%
**Current Status:** [Current QGC status]

[Explain what changed and what it means]

---

### 7. SIGNAL COHERENCE

**Signal Coherence:** [Current status - use exact value: ${
      diagnosticMetrics.signalCoherence || "N/A"
    }%]

Important note:
[Explain what the coherence level indicates]

---

### 8. SIGNAL OUTPUT

**Previous Output:** ~${diagnosticMetrics.signalOutput || "N/A"}%
**Current Status:** [Current status]

This is crucial:
[Explain what changed and why]

---

### 9. ANGLE OF GROWTH (Updated)

**Current Angle:**
[Their updated growth axis based on the conversation]

Not:
[What it's NOT about]

---

### 10. FIRST CORRECTION (Updated)

One sentence. Exact.

> **[The exact correction based on the conversation]**

That's it.

---

## METRICS GAUGE (Current Snapshot)

* **QGC Activation:** ${renderGauge(diagnosticMetrics.qgcActivation || 0)}  ~${
      diagnosticMetrics.qgcActivation || "N/A"
    }%
* **Consciousness Level:** ${renderGauge(
      (diagnosticMetrics.consciousnessLevel || 0) * 20
    )}  ~${diagnosticMetrics.consciousnessLevel || "N/A"}
* **Gravity:** ${renderGauge(
      diagnosticMetrics.gravity || 0
    )}  [Current status with arrow if changed]
* **Signal Coherence:** ${renderGauge(
      diagnosticMetrics.signalCoherence || 0
    )}  ${diagnosticMetrics.signalCoherence || "N/A"}%
* **Signal Output:** ${renderGauge(
      diagnosticMetrics.signalOutput || 0
    )}  [Current status]

---

## UNLIMITED CREATOR / CREATOR CLUB RECOMMENDATIONS

Based on current metrics and collapse point:

### Primary Focus (now)

* **[Specific recommendation 1]**
* **[Specific recommendation 2]**
* **[Specific recommendation 3]**

Why:
[Explain why these are recommended]

### Deferred (not yet)

* [What should be deferred]
* [What should be deferred]

These come **after** [specific condition].

---

## EVOLUTION NOTE (Important)

What just happened is [rare/common] and [clean/complex]:

[Explain what structural shift occurred - be specific about what changed]

---

## FINAL SUMMARY

${userName}, [Personalized summary based on the conversation - what shifted, what it means, what's next]

---

### 📄 PDF STATUS

Your **Euphoriam Diagnostic PDF (${reportVersion})** has been generated and logged internally under your profile.

**Filename:**
\`${userName}_Euphoriam_Diagnostic_${new Date()
      .toISOString()
      .split("T")[0]
      .replace(/-/g, "")}_${reportVersion}.pdf\`

[Closing message based on the conversation]

We'll stop here.

---

Generate the full report in this exact format. Use actual insights from the conversation transcript, not placeholders.`;

    let discoveryReport = "";
    try {
      // Add timeout wrapper for OpenAI call
      const timeoutPromise = new Promise(
        (_, reject) =>
          setTimeout(() => reject(new Error("OpenAI request timeout")), 120000) // 2 minute timeout
      );

      const aiDiscoveryPromise = openai.chat.completions.create({
        model: "gpt-5.2",
        messages: [{ role: "user", content: discoveryPrompt }],
        temperature: 0.15,
        max_completion_tokens: 4500,
      });

      const aiDiscovery = await Promise.race([
        aiDiscoveryPromise,
        timeoutPromise,
      ]);
      discoveryReport =
        aiDiscovery?.choices?.[0]?.message?.content?.trim() || "";
    } catch (err) {
      console.error("[discovery] failed to generate follow-up report", err);
      // Return error response if report generation fails
      return errorResponse(
        res,
        "Failed to generate discovery report. Please try again.",
        500
      );
    }

    if (discoveryReport) {
      const discoveryTypeValue =
        discoveryType || req.body.discoveryType || "integrated";

      const userForDiscovery = existingDiagnostic?.userId
        ? await User.findByPk(existingDiagnostic.userId)
        : await User.findOne({ where: { email } });

      // Save discovery record immediately (before PDF/email)
      await persistDiscoveryRecord({
        userId: userForDiscovery?.id || existingDiagnostic?.userId || null,
        email,
        title: `Discovery Follow-up – ${userName}`,
        transcript: updatedTranscript,
        previousReport: priorReportSnippet,
        newReport: discoveryReport,
        diagnosticId: existingDiagnostic?.id || null,
        pdfUrl: null, // Will be updated after PDF is generated
        discoveryType: discoveryTypeValue,
      });

      // Clear intakeState transcript since report is completed
      if (existingDiagnostic) {
        await existingDiagnostic.update({
          data: {
            ...(existingDiagnostic.data || {}),
            intakeState: {
              ...(existingDiagnostic.data?.intakeState || {}),
              transcript: [], // Clear transcript after report generation
              completedAt: new Date().toISOString(),
              mode: null, // Clear mode
            },
          },
        });
      }

      const userWantsEmail = checkWantsEmail(
        updatedTranscript,
        lastUser?.content
      );
      let shouldEmail = userWantsEmail;

      // Send response immediately - don't wait for PDF/email
      const response = successResponse(res, "Discovery chat saved", {
        discovery: true,
        message:
          "Discovery report generated. PDF are being processed in the background.",
        discoveryReport: discoveryReport || null,
        pdfPath: null, // Will be generated in background
        pdfUrl: null, // Will be updated after PDF is generated
        autoGenerated: true,
        status: "completed",
        statusMessage:
          "Report generated. PDF and email processing in background.",
        userMessage: `Your discovery report has been generated. ${
          shouldEmail
            ? "Email will be sent shortly."
            : "You can access it in your account."
        }`,
        emailed: false, // Will be updated in background
      });

      // Process PDF and email in background (don't await - fire and forget)
      (async () => {
        try {
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
            // Generate PDF in background
            pdfPath = await generateDiagnosticPdf(discoveryForPdf);

            if (pdfPath) {
              // Upload PDF in background
              const buffer = await fs.promises.readFile(pdfPath);
              const upload = await uploadBufferToSupabase({
                buffer,
                objectPath: `discoveries/discovery-${
                  existingDiagnostic?.id || Date.now()
                }-${Date.now()}.pdf`,
                contentType: "application/pdf",
              });

              pdfUrl = upload.url || null;

              // Update discovery record with PDF URL
              const latestDiscovery = await Discovery.findOne({
                where: {
                  userId:
                    userForDiscovery?.id || existingDiagnostic?.userId || null,
                  email: email,
                },
                order: [["createdAt", "DESC"]],
              });

              if (latestDiscovery) {
                await latestDiscovery.update({
                  pdfUrl: pdfUrl,
                });
              }
            }
          } catch (err) {
            console.error(
              "[discovery] PDF generation/upload failed (background):",
              err
            );
          }

          // Send email in background if requested
          if (email && shouldEmail && pdfPath) {
            try {
              await sendEmail(
                email,
                "Your Discovery Report – Euphoriam AI",
                discoveryReportEmail(userName),
                pdfPath
              );
              console.log("[discovery] Email sent successfully (background)");
            } catch (err) {
              console.error(
                "[discovery] Email sending failed (background):",
                err
              );
            }
          }
        } catch (err) {
          console.error("[discovery] Background processing error:", err);
        }
      })();

      return response;
    }
  }

  // Save incomplete discovery conversation to intakeState so user can resume
  if (updatedTranscript && updatedTranscript.length > 0) {
    const discoveryIntakeState = {
      transcript: updatedTranscript,
      discoveryType: discoveryType || "integrated",
      updatedAt: new Date().toISOString(),
      mode: "discovery",
    };

    if (existingDiagnostic) {
      await existingDiagnostic.update({
        data: {
          ...(existingDiagnostic.data || {}),
          intakeState: {
            ...(existingDiagnostic.data?.intakeState || {}),
            ...discoveryIntakeState,
          },
        },
      });
    } else if (appUser) {
      // Create a diagnostic record to store discovery state if none exists
      await Diagnostic.create({
        userId: appUser.id || null,
        email,
        title: `Discovery Chat (Draft) – ${
          name || email?.split("@")[0] || "User"
        }`,
        data: {
          profile: { name, email },
          intakeState: discoveryIntakeState,
        },
      });
    }
  }

  // Get updated state after saving
  const updatedState = existingDiagnostic
    ? (await Diagnostic.findByPk(existingDiagnostic.id))?.data?.intakeState ||
      existingState
    : existingState;

  // Return regular discovery chat response
  return successResponse(res, "Next chatbot message", {
    nextMessage,
    introPageText: introText,
    transcript: updatedTranscript,
    intakeState: updatedState,
    retrieved: [],
    resumeNotice: null,
    answeredCount: 0,
    pendingQuestion: false,
    aiAnswered: false,
    status: "chatting",
    statusMessage: "Chatting in progress",
    canResume: true, // Always allow resuming
  });
};

/**
 * ============================================
 * DISCOVERY FINALIZE HANDLER
 * ============================================
 * Handles discovery finalize requests (finalize=true with existing report)
 */
const handleDiscoveryFinalize = async ({
  req,
  res,
  email,
  name,
  transcriptForFinal,
  existingDiagnostic,
  priorReportSnippet,
  diagnosticMetrics,
  appUser,
  introText,
  backgroundMode = false, // If true, skip email and don't send response
}) => {
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
  const reportDate = new Date().toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
  const reportVersion = previousDiscovery ? "v3.2" : "v3.1";
  const userName = name || email?.split("@")[0] || "User";

  const discoveryPrompt = `
You are generating a FULL DISCOVERY REPORT in PDF format for Euphoriam AI.

Context: The user already has a completed diagnostic report and may have previous discovery sessions.

Previous diagnostic (reference):
${priorReportSnippet || "None"}

${
  previousDiscovery
    ? `Previous discovery report (reference):
${truncateForContext(
  previousDiscovery.newReportSnippet ||
    previousDiscovery.data?.newReportSnippet ||
    previousDiscovery.data?.newReport ||
    "",
  4000
)}`
    : ""
}

New conversation transcript (latest messages last):
${JSON.stringify(transcriptForFinal, null, 2)}

Client Name: ${userName}
Client ID: N/A
Report Type: Structural Update Report
Date: ${reportDate}

CRITICAL: You MUST generate the report in the EXACT format shown below. This is a structural update report based on the conversation interaction.

Generate a FULL DISCOVERY REPORT following this EXACT format:

---

## EUPHORIAM™ STRUCTURAL UPDATE REPORT

**Client:** ${userName}
**Report Type:** Identity Authority Collapse + Gravity Shift (or appropriate type based on conversation)
**Version:** ${reportVersion}
**Date:** ${reportDate}
**Tone:** Warm / Grounded

---

### 1. STRUCTURE TYPE (Updated)

**Primary Structure:**
[Analyze their primary structure based on metrics and conversation - be specific about what changed]

**Key refinement:**
[Explain what has shifted or been refined in their structure based on the conversation]

---

### 2. AVOIDANCE BEHAVIOUR (Resolved Layer)

**Original Pattern:**
[What was the original avoidance pattern from previous report]

**Updated Reading:**
[How the avoidance has changed or been resolved based on the conversation - be specific about what shifted]

---

### 3. VORTEX STATUS

**Previous Vortex:**
[What was the previous vortex state]

**Current State:**
[Current vortex status - use ⚠️ if destabilized, ✅ if stable, etc.]

Why:
[Explain what changed and why based on the conversation]

---

### 4. GRAVITY (3D CODE)

**Previous Gravity:** ~${diagnosticMetrics.gravity || "N/A"}%
**Current Reading:** [Current gravity status - use ↓ if dropping, ↑ if increasing, or stable]

Critical insight:
[Explain what the gravity shift means based on the conversation]

---

### 5. CONSCIOUSNESS LEVEL (CL)

**Previous CL:** ~${diagnosticMetrics.consciousnessLevel || "N/A"}
**Current CL:** [Current CL level]

Marker of shift:
[Explain what changed and what it indicates]

---

### 6. QUANTUM GENIUS CODES (QGC)

**Previous QGC:** ~${diagnosticMetrics.qgcActivation || "N/A"}%
**Current Status:** [Current QGC status]

[Explain what changed and what it means]

---

### 7. SIGNAL COHERENCE

**Signal Coherence:** [Current status - use exact value: ${
    diagnosticMetrics.signalCoherence || "N/A"
  }%]

Important note:
[Explain what the coherence level indicates]

---

### 8. SIGNAL OUTPUT

**Previous Output:** ~${diagnosticMetrics.signalOutput || "N/A"}%
**Current Status:** [Current status]

This is crucial:
[Explain what changed and why]

---

### 9. ANGLE OF GROWTH (Updated)

**Current Angle:**
[Their updated growth axis based on the conversation]

Not:
[What it's NOT about]

---

### 10. FIRST CORRECTION (Updated)

One sentence. Exact.

> **[The exact correction based on the conversation]**

That's it.

---

## METRICS GAUGE (Current Snapshot)

* **QGC Activation:** ${renderGauge(diagnosticMetrics.qgcActivation || 0)}  ~${
    diagnosticMetrics.qgcActivation || "N/A"
  }%
* **Consciousness Level:** ${renderGauge(
    (diagnosticMetrics.consciousnessLevel || 0) * 20
  )}  ~${diagnosticMetrics.consciousnessLevel || "N/A"}
* **Gravity:** ${renderGauge(
    diagnosticMetrics.gravity || 0
  )}  [Current status with arrow if changed]
* **Signal Coherence:** ${renderGauge(
    diagnosticMetrics.signalCoherence || 0
  )}  ${diagnosticMetrics.signalCoherence || "N/A"}%
* **Signal Output:** ${renderGauge(
    diagnosticMetrics.signalOutput || 0
  )}  [Current status]

---

## UNLIMITED CREATOR / CREATOR CLUB RECOMMENDATIONS

Based on current metrics and collapse point:

### Primary Focus (now)

* **[Specific recommendation 1]**
* **[Specific recommendation 2]**
* **[Specific recommendation 3]**

Why:
[Explain why these are recommended]

### Deferred (not yet)

* [What should be deferred]
* [What should be deferred]

These come **after** [specific condition].

---

## EVOLUTION NOTE (Important)

What just happened is [rare/common] and [clean/complex]:

[Explain what structural shift occurred - be specific about what changed]

---

## FINAL SUMMARY

${userName}, [Personalized summary based on the conversation - what shifted, what it means, what's next]

---

### 📄 PDF STATUS

Your **Euphoriam Diagnostic PDF (${reportVersion})** has been generated and logged internally under your profile.

**Filename:**
\`${userName}_Euphoriam_Diagnostic_${new Date()
    .toISOString()
    .split("T")[0]
    .replace(/-/g, "")}_${reportVersion}.pdf\`

[Closing message based on the conversation]

We'll stop here.

---

Generate the full report in this exact format. Use actual insights from the conversation transcript, not placeholders.`;

  const discoveryType = req.body.discoveryType || "integrated";

  const userForDiscovery = existingDiagnostic?.userId
    ? await User.findByPk(existingDiagnostic.userId)
    : await User.findOne({ where: { email } });

  // Save discovery record immediately (report will be generated in background)
  await persistDiscoveryRecord({
    userId: userForDiscovery?.id || existingDiagnostic?.userId || null,
    email,
    title: `Discovery Follow-up – ${name || email?.split("@")[0] || "User"}`,
    transcript: transcriptForFinal,
    previousReport: priorReportSnippet,
    newReport: null, // Will be updated after report is generated
    diagnosticId: existingDiagnostic?.id || null,
    pdfUrl: null, // Will be updated after PDF is generated
    discoveryType,
  });

  // Clear intakeState transcript since report is completed
  if (existingDiagnostic) {
    await existingDiagnostic.update({
      data: {
        ...(existingDiagnostic.data || {}),
        intakeState: {
          ...(existingDiagnostic.data?.intakeState || {}),
          transcript: [], // Clear transcript after report generation
          completedAt: new Date().toISOString(),
          mode: null, // Clear mode
        },
      },
    });
  }

  // Check if user explicitly requested email - only email if they say "email report" or similar
  const lastUserMessage =
    req.body.messages?.filter((m) => m?.role === "user")?.slice(-1)[0]
      ?.content || "";
  const transcriptMessages =
    transcriptForFinal?.filter((m) => m?.role === "user") || [];
  const lastTranscriptMessage =
    transcriptMessages[transcriptMessages.length - 1]?.content || "";
  const userMessageToCheck = lastUserMessage || lastTranscriptMessage || "";
  const lowerMessage = userMessageToCheck.toLowerCase();

  // Only email if user explicitly says "email report" or "email me the report" etc.
  const explicitlyWantsEmail =
    /(email|send).*(me|the|my).*(report|it)/i.test(lowerMessage) ||
    /(email|send).*(report|it)/i.test(lowerMessage);

  // Don't email if they just said "end chat" or similar without mentioning email/report
  const justEndingChat =
    /(end|finish|stop|done|close).*(chat|conversation)/i.test(lowerMessage) &&
    !/(email|send|report)/i.test(lowerMessage);

  const shouldEmail = backgroundMode
    ? false
    : explicitlyWantsEmail && !justEndingChat; // Don't email in background mode

  // Generate report, PDF and email in background (don't await - fire and forget)
  (async () => {
    let discoveryReport = "";
    try {
      const aiDiscovery = await openai.chat.completions.create({
        model: "gpt-5.2",
        messages: [{ role: "user", content: discoveryPrompt }],
        temperature: 0.15,
        max_completion_tokens: 4500,
        timeout: 120000, // 2 minute timeout
      });
      discoveryReport =
        aiDiscovery?.choices?.[0]?.message?.content?.trim() || "";

      if (discoveryReport) {
        // Update discovery record with generated report
        const latestDiscovery = await Discovery.findOne({
          where: {
            userId: userForDiscovery?.id || existingDiagnostic?.userId || null,
            email: email,
          },
          order: [["createdAt", "DESC"]],
        });

        if (latestDiscovery) {
          await latestDiscovery.update({
            newReportSnippet: truncateForContext(discoveryReport, 1500),
          });
        }
      }
    } catch (err) {
      console.error(
        "[discovery] failed to generate follow-up report (background):",
        err
      );
      return; // Exit early if report generation fails
    }

    if (discoveryReport) {
      try {
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
            metrics: diagnosticMetrics,
          },
        };

        let pdfPath = null;
        let pdfUrl = null;

        try {
          pdfPath = await generateDiagnosticPdf(discoveryForPdf);

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

            // Update discovery record with PDF URL
            const latestDiscovery = await Discovery.findOne({
              where: {
                userId:
                  userForDiscovery?.id || existingDiagnostic?.userId || null,
                email: email,
              },
              order: [["createdAt", "DESC"]],
            });

            if (latestDiscovery) {
              await latestDiscovery.update({
                pdfUrl: pdfUrl,
              });
            }
          }
        } catch (err) {
          console.error(
            "[discovery finalize] PDF generation/upload failed (background):",
            err
          );
        }

        // Send email in background ONLY if user explicitly requested it
        if (email && shouldEmail && pdfPath) {
          try {
            await sendEmail(
              email,
              "Your Discovery Report – Euphoriam AI",
              discoveryReportEmail(name || email?.split("@")[0] || "User"),
              pdfPath
            );
            console.log(
              "[discovery finalize] Email sent successfully (background)"
            );
          } catch (err) {
            console.error(
              "[discovery finalize] Email sending failed (background):",
              err
            );
          }
        } else if (email && !shouldEmail) {
          console.log(
            "[discovery finalize] Email not sent - user did not explicitly request it"
          );
        } else if (backgroundMode) {
          console.log(
            `[discovery finalize] Report generated and saved in background for user ${email} (no email sent)`
          );
        }
      } catch (err) {
        console.error("[discovery finalize] Background processing error:", err);
      }
    }
  })();

  // Background mode - already processing above, just return
  if (backgroundMode) {
    return;
  }

  // Send response if not in background mode
  return successResponse(res, "Discovery chat saved", {
    discovery: true,
    message: shouldEmail
      ? "Chat ended. Your discovery report is being generated and will be emailed to you shortly."
      : "Chat ended. Your discovery report is being generated and will be available in your account shortly.",
    discoveryReport: null, // Will be generated in background
    pdfPath: null, // Will be generated in background
    pdfUrl: null, // Will be updated after PDF is generated
    status: "processing",
    statusMessage:
      "Report generation in progress. This may take a few minutes.",
    userMessage: shouldEmail
      ? "Chat ended. Your discovery report is being generated and will be emailed to you shortly. This may take a few minutes."
      : "Chat ended. Your discovery report is being generated and will be available in your account shortly. This may take a few minutes.",
    emailed: false, // Will be updated in background
  });
};

/**
 * ============================================
 * DIAGNOSTIC FINALIZE HANDLER
 * ============================================
 * Handles diagnostic finalize requests (finalize=true without existing report)
 */
const handleDiagnosticFinalize = async ({
  req,
  res,
  email,
  name,
  transcriptForFinal,
  existingDiagnostic,
  priorReportSnippet,
  previousReports,
  appUser,
  existingState,
  introText,
  retrieved,
  backgroundMode = false, // If true, skip email and don't send response
}) => {
  if (!email || typeof email !== "string" || !email.includes("@")) {
    console.error("[diagnostic] Invalid email:", email);
    return errorResponse(res, "Invalid email address", 400);
  }

  const userName = name || email?.split("@")[0] || "User";

  // Get or create diagnostic record (without report yet)
  let diagnostic = existingDiagnostic;
  if (!diagnostic) {
    // Use safe find to avoid chatId column errors
    try {
      diagnostic = await Diagnostic.findOne({
        where: { email },
        attributes: [
          "id",
          "userId",
          "email",
          "title",
          "data",
          "createdAt",
          "updatedAt",
        ],
      });
    } catch (err) {
      // If still fails, try without attributes (will use model defaults)
      diagnostic = await Diagnostic.findOne({ where: { email } });
    }
  }

  // Save discovery record immediately (report will be generated in background)
  const userForFinal = diagnostic?.userId
    ? await User.findByPk(diagnostic.userId)
    : await User.findOne({ where: { email } });

  await persistDiscoveryRecord({
    userId: userForFinal?.id || diagnostic?.userId || null,
    email,
    title: `Euphoriam Diagnostic v3 (Freeform) – ${userName}`,
    transcript: transcriptForFinal,
    previousReport: null,
    newReport: null, // Will be updated after report is generated
    diagnosticId: diagnostic?.id || null,
    pdfUrl: null, // Will be updated after PDF is generated
  });

  // Check if user explicitly requested email - only email if they say "email report" or similar
  const lastUserMessage =
    req.body.messages?.filter((m) => m?.role === "user")?.slice(-1)[0]
      ?.content || "";
  const transcriptMessages =
    transcriptForFinal?.filter((m) => m?.role === "user") || [];
  const lastTranscriptMessage =
    transcriptMessages[transcriptMessages.length - 1]?.content || "";
  const userMessageToCheck = lastUserMessage || lastTranscriptMessage || "";
  const lowerMessage = userMessageToCheck.toLowerCase();

  // Only email if user explicitly says "email report" or "email me the report" etc.
  const explicitlyWantsEmail =
    /(email|send).*(me|the|my).*(report|it)/i.test(lowerMessage) ||
    /(email|send).*(report|it)/i.test(lowerMessage);

  // Don't email if they just said "end chat" or similar without mentioning email/report
  const justEndingChat =
    /(end|finish|stop|done|close).*(chat|conversation)/i.test(lowerMessage) &&
    !/(email|send|report)/i.test(lowerMessage);

  const shouldEmail = backgroundMode
    ? false
    : explicitlyWantsEmail && !justEndingChat; // Don't email in background mode

  // Generate report, PDF and email in background (don't await - fire and forget)
  (async () => {
    const prompt = await getLatestPromptFromDb();
    const promptContent =
      typeof prompt === "string"
        ? prompt
        : prompt?.fullPrompt || prompt?.content;

    let reportText = "";
    try {
      const aiResponse = await openai.chat.completions.create({
        model: "gpt-5.2",
        messages: [
          { role: "system", content: promptContent },
          {
            role: "user",
            content: buildFinalReportPrompt({
              customerContext: null,
              intakeAnswers: transcriptForFinal,
              introPageText: introText,
              retrieved,
              previousReport: priorReportSnippet,
            }),
          },
        ],
        temperature: 0.15,
        max_completion_tokens: 4500,
        timeout: 120000, // 2 minute timeout
      });

      reportText = (aiResponse?.choices?.[0]?.message?.content || "").trim();

      if (!reportText) {
        console.error(
          "[diagnostic] AI returned empty diagnostic report (background)"
        );
        return; // Exit early if report generation fails
      }

      // Update diagnostic with generated report
      const finalPayload = {
        userId: appUser.id || null,
        email: email.trim(),
        title: `Euphoriam Diagnostic v3 (Freeform) – ${userName}`,
        report: reportText, // Save report in report column
        data: {
          diagnosticVersion: 3,
          generatedAt: new Date(),
          profile: {
            name: userName,
            email: email.trim(),
          },
          metrics: {},
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

      if (diagnostic) {
        await diagnostic.update(finalPayload);
      } else {
        try {
          diagnostic = await Diagnostic.create(finalPayload);
        } catch (createError) {
          if (
            createError.name === "SequelizeUniqueConstraintError" ||
            createError.name === "ValidationError"
          ) {
            diagnostic = await Diagnostic.findOne({ where: { email } });
            if (diagnostic) {
              await diagnostic.update(finalPayload);
            }
          }
        }
      }

      // Update discovery record with generated report
      const latestDiscovery = await Discovery.findOne({
        where: {
          userId: userForFinal?.id || diagnostic?.userId || null,
          email: email,
        },
        order: [["createdAt", "DESC"]],
      });

      if (latestDiscovery) {
        await latestDiscovery.update({
          newReportSnippet: truncateForContext(reportText, 1500),
        });
      }
    } catch (err) {
      console.error(
        "[diagnostic] Failed to generate report (background):",
        err
      );
      return; // Exit early if report generation fails
    }

    if (reportText) {
      try {
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
          console.log(
            "[diagnostic] PDF uploaded to Supabase (background)",
            upload
          );

          // Update diagnostic with PDF URL
          await diagnostic.update({
            pdfUrl: pdf.url || null,
            data: {
              ...(diagnostic.data || {}),
              pdf,
            },
          });

          // Update discovery record with PDF URL
          const latestDiscovery = await Discovery.findOne({
            where: {
              userId: userForFinal?.id || diagnostic?.userId || null,
              email: email,
            },
            order: [["createdAt", "DESC"]],
          });

          if (latestDiscovery) {
            await latestDiscovery.update({
              pdfUrl: pdf.url || null,
            });
          }
        } catch (err) {
          console.error(
            "[diagnostic] Failed to upload diagnostic PDF to Supabase (background)",
            err
          );
        }

        // Send email in background ONLY if user explicitly requested it
        if (shouldEmail && pdfPath) {
          try {
            await sendEmail(
              email,
              "Your Diagnostic Report – Euphoraum-AI",
              diagnosticReportEmail(userName),
              pdfPath
            );
            console.log("[diagnostic] Email sent successfully (background)");
          } catch (err) {
            console.error(
              "[diagnostic] Email sending failed (background):",
              err
            );
          }
        } else if (!shouldEmail) {
          console.log(
            "[diagnostic] Email not sent - user did not explicitly request it"
          );
        } else if (backgroundMode) {
          console.log(
            `[diagnostic] Report generated and saved in background for user ${email} (no email sent)`
          );
        }
      } catch (err) {
        console.error(
          "[diagnostic] PDF/email processing error (background):",
          err
        );
      }
    }
  })();

  // Background mode - already processing above, just return
  if (backgroundMode) {
    return;
  }

  // Send response if not in background mode
  return successResponse(res, "Chatbot diagnostic (freeform) generated", {
    diagnosticId: diagnostic?.id || null,
    diagnostic: diagnostic?.data || {},
    pdfPath: null, // Will be generated in background
    pdfUrl: null, // Will be updated after PDF is generated
    reportText: null, // Will be generated in background
    status: "processing",
    statusMessage:
      "Report generation in progress. This may take a few minutes.",
    userMessage: shouldEmail
      ? "Chat ended. Your diagnostic report is being generated and will be emailed to you shortly. This may take a few minutes."
      : "Chat ended. Your diagnostic report is being generated and will be available in your account shortly. This may take a few minutes.",
    emailed: false, // Will be updated in background
  });
};

/**
 * ============================================
 * DIAGNOSTIC MODE HANDLER
 * ============================================
 * Handles all diagnostic mode logic for first-time users or users requesting new diagnostics
 * This includes:
 * - 12-question intake flow
 * - Auto-finalization when all questions answered
 * - Diagnostic report generation
 */
const handleDiagnosticMode = async ({
  req,
  res,
  email,
  name,
  messages,
  transcript,
  updatedTranscript,
  existingDiagnostic,
  existingState,
  priorReportSnippet,
  previousReports,
  appUser,
  lastUser,
  lastAssistant,
  nextMessage,
  introText,
  targetCount,
  answeredCount,
  pendingQuestion,
  aiAnswered,
  distinctQuestionNumbers,
  maxQuestionNumber,
  distinctQuestionsAnswered,
  resumeNotice,
  wantsNewDiagnostic,
  hasExistingReport,
}) => {
  // Auto-finalization: If we've gathered all answers, auto-generate the diagnostic/PDF
  if (
    (!hasExistingReport || wantsNewDiagnostic) &&
    answeredCount >= targetCount &&
    !pendingQuestion &&
    aiAnswered
  ) {
    const metrics = {};

    const finalizeRetrieved = lastUser?.content
      ? await retrieveSimilarChunks({ query: lastUser.content, topK: 3 })
      : [];
    const prompt = await getLatestPromptFromDb();
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
            customerContext: null,
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

    if (!email || typeof email !== "string" || !email.includes("@")) {
      console.error("[diagnostic] Invalid email:", email);
      return errorResponse(res, "Invalid email address", 400);
    }

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
        metrics,
        previousReports,
        intakeTranscript: updatedTranscript,
        aiReport: reportText,
        intakeState: {
          ...existingState,
          finalizedAt: new Date().toISOString(),
        },
      },
    };

    let diagnostic = existingDiagnostic;
    if (!diagnostic) {
      // Use safe find to avoid chatId column errors
      try {
        diagnostic = await Diagnostic.findOne({
          where: { email },
          attributes: [
            "id",
            "userId",
            "email",
            "title",
            "data",
            "createdAt",
            "updatedAt",
          ],
        });
      } catch (err) {
        diagnostic = await Diagnostic.findOne({ where: { email } });
      }
    }

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

    if (diagnosticPayload.data.intakeState) {
      diagnosticPayload.data.intakeState.requestingNewDiagnostic = false;
    }

    if (diagnostic) {
      diagnostic = await diagnostic.update(diagnosticPayload);
    } else {
      try {
        diagnostic = await Diagnostic.create(diagnosticPayload);
      } catch (createError) {
        if (
          createError.name === "SequelizeUniqueConstraintError" ||
          createError.name === "ValidationError"
        ) {
          // Use safe find to avoid chatId column errors
          try {
            diagnostic = await Diagnostic.findOne({
              where: { email },
              attributes: [
                "id",
                "userId",
                "email",
                "title",
                "data",
                "createdAt",
                "updatedAt",
              ],
            });
          } catch (err) {
            diagnostic = await Diagnostic.findOne({ where: { email } });
          }
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

    // Save discovery record immediately (before PDF/email)
    await persistDiscoveryRecord({
      userId: appUser?.id || diagnostic.userId || 0,
      email,
      title: diagnosticPayload.title,
      transcript: updatedTranscript,
      previousReport: null,
      newReport: reportText,
      diagnosticId: diagnostic.id,
      pdfUrl: null, // Will be updated after PDF is generated
    });

    // Check if user explicitly requested email - only email if they say "email report" or similar
    const lastUserMessage = lastUser?.content || "";
    const transcriptMessages =
      updatedTranscript?.filter((m) => m?.role === "user") || [];
    const lastTranscriptMessage =
      transcriptMessages[transcriptMessages.length - 1]?.content || "";
    const userMessageToCheck = lastUserMessage || lastTranscriptMessage || "";
    const lowerMessage = userMessageToCheck.toLowerCase();

    // Only email if user explicitly says "email report" or "email me the report" etc.
    const explicitlyWantsEmail =
      /(email|send).*(me|the|my).*(report|it)/i.test(lowerMessage) ||
      /(email|send).*(report|it)/i.test(lowerMessage);

    // Don't email if they just said "end chat" or similar without mentioning email/report
    const justEndingChat =
      /(end|finish|stop|done|close).*(chat|conversation)/i.test(lowerMessage) &&
      !/(email|send|report)/i.test(lowerMessage);

    const shouldEmail = explicitlyWantsEmail && !justEndingChat;

    // Send response immediately - don't wait for PDF/email
    const response = successResponse(
      res,
      "Chatbot diagnostic (auto-finalized)",
      {
        diagnosticId: diagnostic.id,
        diagnostic: diagnostic.data,
        pdfPath: null, // Will be generated in background
        pdfUrl: null, // Will be updated after PDF is generated
        reportText,
        autoFinalized: true,
        resumeNotice,
        status: "completed",
        statusMessage: shouldEmail
          ? "Report generated. PDF and email processing in background."
          : "Report generated. PDF processing in background.",
        userMessage: shouldEmail
          ? "Your diagnostic report has been generated. PDF are being processed in the background. You'll receive an email shortly."
          : "Your diagnostic report has been generated and saved. PDF is being processed in the background. You can access it in your account anytime.",
        emailed: false, // Will be updated in background
      }
    );

    // Process PDF and email in background (don't await - fire and forget)
    (async () => {
      try {
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
          console.log(
            "[diagnostic] PDF uploaded to Supabase (background)",
            upload
          );

          // Update diagnostic with PDF URL
          await diagnostic.update({
            pdfUrl: pdf.url || null,
            data: {
              ...(diagnostic.data || {}),
              pdf,
            },
          });

          // Update discovery record with PDF URL
          const latestDiscovery = await Discovery.findOne({
            where: {
              userId: appUser?.id || diagnostic.userId || 0,
              email: email,
            },
            order: [["createdAt", "DESC"]],
          });

          if (latestDiscovery) {
            await latestDiscovery.update({
              pdfUrl: pdf.url || null,
            });
          }
        } catch (err) {
          console.error(
            "[diagnostic] Failed to upload diagnostic PDF to Supabase (background)",
            err
          );
        }

        // Send email in background ONLY if user explicitly requested it
        if (shouldEmail && pdfPath) {
          try {
            await sendEmail(
              email,
              "Your Diagnostic Report – Euphoraum-AI",
              diagnosticReportEmail(userName),
              pdfPath
            );
            console.log("[diagnostic] Email sent successfully (background)");
          } catch (err) {
            console.error(
              "[diagnostic] Email sending failed (background):",
              err
            );
          }
        } else if (!shouldEmail) {
          console.log(
            "[diagnostic] Email not sent - user did not explicitly request it"
          );
        }
      } catch (err) {
        console.error("[diagnostic] Background processing error:", err);
      }
    })();

    return response;
  }

  // Return regular diagnostic chat response
  return successResponse(res, "Next chatbot message", {
    nextMessage,
    introPageText: introText,
    transcript: updatedTranscript,
    intakeState: existingState,
    retrieved: [],
    resumeNotice,
    answeredCount,
    pendingQuestion,
    aiAnswered,
    status: "chatting",
    statusMessage: "Chatting in progress",
  });
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

  // If no messages provided, check for incomplete chat and return it if exists
  const hasNoMessages = !messages || messages.length === 0;

  if (hasNoMessages && !finalize) {
    const hasExistingReport = Boolean(existingReport);
    const transcript = existingState?.transcript || [];
    const intakeState = existingState || {};

    // Check if there's an incomplete chat (not completed)
    const isCompleted = intakeState?.completedAt || false;
    const hasIncompleteChat =
      transcript && transcript.length > 0 && !isCompleted;

    if (hasIncompleteChat) {
      const isIncompleteDiagnostic = !hasExistingReport;
      const isIncompleteDiscovery =
        hasExistingReport && intakeState.mode === "discovery";

      // Determine mode
      const mode = isIncompleteDiscovery
        ? "discovery"
        : isIncompleteDiagnostic
        ? "diagnostic"
        : hasExistingReport
        ? "discovery"
        : "diagnostic";

      // Calculate progress for diagnostic mode
      let answeredCount = 0;
      let pendingQuestion = false;
      let distinctQuestionNumbers = [];
      let maxQuestionNumber = 0;

      if (isIncompleteDiagnostic) {
        const {
          distinctQuestionNumbers: questionNumbers,
          maxQuestionNumber: maxQNum,
          distinctQuestionsAnswered,
        } = trackQuestionNumbers(transcript);

        distinctQuestionNumbers = questionNumbers;
        maxQuestionNumber = maxQNum;
        answeredCount = distinctQuestionsAnswered || 0;

        const lastAssistant = [...transcript]
          .reverse()
          .find((m) => m?.role === "assistant");
        const lastUser = [...transcript]
          .reverse()
          .find((m) => m?.role === "user");

        if (lastAssistant && lastUser) {
          const aiAnswered = await isAiLikelyAnswer({
            question: lastAssistant.content,
            reply: lastUser.content,
          });
          pendingQuestion = !aiAnswered;
        } else if (lastAssistant) {
          pendingQuestion = true;
        }
      }

      // Return incomplete chat state
      return successResponse(res, "Incomplete chat loaded", {
        hasIncompleteChat: true,
        hasExistingReport,
        mode,
        transcript,
        intakeState: {
          ...intakeState,
          answeredCount,
          pendingQuestion,
          distinctQuestionNumbers,
          maxQuestionNumber,
        },
        diagnosticMetrics,
        canResume: true,
        status: "resumable",
        statusMessage:
          "Incomplete chat found. You can continue from where you left off.",
      });
    }
    // If no incomplete chat, continue with normal flow (will start new conversation)
  }

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

    // EARLY CHECK: If user wants to email/generate report in discovery mode, skip bot response and generate report immediately
    if (hasExistingReport && lastUser) {
      const {
        detectUserWantsToEndOrGenerateReport,
      } = require("../utils/validation");

      const wantsToEndOrGenerate = await detectUserWantsToEndOrGenerateReport({
        userMessage: lastUser.content,
        transcript: transcript,
      });

      if (wantsToEndOrGenerate) {
        // User wants report - generate it immediately without bot response
        const updatedTranscript = transcript;
        return await handleDiscoveryMode({
          req,
          res,
          email,
          name,
          messages,
          transcript,
          updatedTranscript,
          existingDiagnostic,
          existingState,
          priorReportSnippet,
          diagnosticMetrics,
          latestDiscoveryMetrics,
          reportDate,
          appUser,
          lastUser,
          lastAssistant: null, // No assistant message yet
          nextMessage: null, // Skip bot response
          introText,
          discoveryType: req.body.discoveryType || null,
        });
      }
    }

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

    // Check if this is the first user interaction (no user messages in transcript yet)
    const isFirstUserInteraction =
      transcript.filter((m) => m?.role === "user").length === 0;

    // Check if user wants a new diagnostic
    const { wantsNewDiagnostic, intakeInProgress } = checkWantsNewDiagnostic(
      transcript,
      existingState
    );

    // If there's an existing report and this is the first user interaction,
    // show the welcome message with existing report first
    // Only start new intake if user explicitly requests it in their message OR intake is already in progress
    const shouldShowExistingReportFirst =
      hasExistingReport &&
      isFirstUserInteraction &&
      !wantsNewDiagnostic &&
      !intakeInProgress;

    // Determine chat mode
    // If we should show existing report first, use discovery mode
    const isDiscoveryMode =
      shouldShowExistingReportFirst ||
      determineChatMode(
        hasExistingReport,
        wantsNewDiagnostic,
        intakeInProgress
      );

    // EARLY CHECK: If in discovery mode and user wants to email/generate report, skip bot response and generate report immediately
    if (isDiscoveryMode && lastUser) {
      const {
        detectUserWantsToEndOrGenerateReport,
      } = require("../utils/validation");

      const wantsToEndOrGenerate = await detectUserWantsToEndOrGenerateReport({
        userMessage: lastUser.content,
        transcript: transcript,
      });

      if (wantsToEndOrGenerate) {
        // User wants report - generate it immediately without bot response
        const updatedTranscript = transcript;
        const lastAssistant = [...transcript]
          .reverse()
          .find((m) => m?.role === "assistant");

        return await handleDiscoveryMode({
          req,
          res,
          email,
          name,
          messages,
          transcript,
          updatedTranscript,
          existingDiagnostic,
          existingState,
          priorReportSnippet,
          diagnosticMetrics,
          latestDiscoveryMetrics,
          reportDate,
          appUser,
          lastUser,
          lastAssistant,
          nextMessage: null, // Skip bot response - generate report directly
          introText,
          discoveryType: req.body.discoveryType || null,
        });
      }
    }

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

    // Build messages array for AI (rename to avoid shadowing the messages parameter)
    let aiMessages = [{ role: "system", content: systemPrompt }];

    // Include prior report in system context for both modes (needed for discovery mode to answer questions about it)
    if (priorReportSnippet) {
      aiMessages.push({
        role: "system",
        content: isDiscoveryMode
          ? `Previous diagnostic report for ${name} (you have full access to this - use it to answer questions about what the report revealed, their patterns, insights, etc.):\n${priorReportSnippet}`
          : `Existing diagnostic report for ${name} (reference for continuity; do not re-emit the full report here):\n${priorReportSnippet}`,
      });
    }

    aiMessages.push(
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
        messages: aiMessages,
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
        aiMessages = retryMessages;
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
              // First try to find explicit "key sentence" or "distilled" markers with quotes
              const explicitKeySentenceMatch = priorReportSnippet.match(
                /(?:key sentence|distilled|pattern)[\s\S]{0,200}["']([^"']{15,150})["']/i
              );

              // Try to find quoted identity statements with "I will", "I must", etc.
              const identityStatementMatch = priorReportSnippet.match(
                /["']([^"']{20,120}(?:I will|I must|I can't|I won't|I need|I have to)[^"']{0,60})["']/i
              );

              // Try to find unquoted identity statements
              const unquotedIdentityMatch = priorReportSnippet.match(
                /(?:I will|I must|I can't|I won't|I need|I have to)[^.\n]{15,100}/i
              );

              if (explicitKeySentenceMatch && explicitKeySentenceMatch[1]) {
                keySentence = explicitKeySentenceMatch[1].trim();
              } else if (identityStatementMatch && identityStatementMatch[1]) {
                keySentence = identityStatementMatch[1].trim();
              } else if (unquotedIdentityMatch && unquotedIdentityMatch[0]) {
                keySentence = unquotedIdentityMatch[0].trim();
              }

              // Clean up the key sentence - remove if it's too short or doesn't make sense
              if (keySentence && keySentence.length < 15) {
                keySentence = "";
              }

              // Limit length
              if (keySentence) {
                keySentence = keySentence.substring(0, 120);
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
            if (keySentence && keySentence.length >= 15) {
              keySentenceText = `> *"${keySentence}"*`;
            } else if (priorReportSnippet) {
              // Try to find structure type or identity description - be more specific
              // Look for "Structure Type" section or similar
              const structureTypeMatch = priorReportSnippet.match(
                /(?:Structure Type|Primary Structure|Your structure)[\s\S]{0,300}(?:is|means|indicates)[\s\S]{0,200}([^.\n]{20,120})/i
              );

              // Look for identity patterns in quotes
              const identityPatternMatch = priorReportSnippet.match(
                /(?:identity|structure)[\s\S]{0,200}["']([^"']{20,120})["']/i
              );

              if (structureTypeMatch && structureTypeMatch[1]) {
                const extracted = structureTypeMatch[1].trim();
                if (extracted.length >= 20 && extracted.length <= 120) {
                  keySentenceText = `> *"${extracted}"*`;
                }
              } else if (identityPatternMatch && identityPatternMatch[1]) {
                const extracted = identityPatternMatch[1].trim();
                if (extracted.length >= 20 && extracted.length <= 120) {
                  keySentenceText = `> *"${extracted}"*`;
                }
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
              content: `Welcome back ${name}!. I've loaded your last report.

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
            // First try to find explicit "key sentence" or "distilled" markers with quotes
            const explicitKeySentenceMatch = priorReportSnippet.match(
              /(?:key sentence|distilled|pattern)[\s\S]{0,200}["']([^"']{15,150})["']/i
            );

            // Try to find quoted identity statements with "I will", "I must", etc.
            const identityStatementMatch = priorReportSnippet.match(
              /["']([^"']{20,120}(?:I will|I must|I can't|I won't|I need|I have to)[^"']{0,60})["']/i
            );

            // Try to find unquoted identity statements
            const unquotedIdentityMatch = priorReportSnippet.match(
              /(?:I will|I must|I can't|I won't|I need|I have to)[^.\n]{15,100}/i
            );

            if (explicitKeySentenceMatch && explicitKeySentenceMatch[1]) {
              keySentence = explicitKeySentenceMatch[1].trim();
            } else if (identityStatementMatch && identityStatementMatch[1]) {
              keySentence = identityStatementMatch[1].trim();
            } else if (unquotedIdentityMatch && unquotedIdentityMatch[0]) {
              keySentence = unquotedIdentityMatch[0].trim();
            }

            // Clean up the key sentence - remove if it's too short or doesn't make sense
            if (keySentence && keySentence.length < 15) {
              keySentence = "";
            }

            // Limit length
            if (keySentence) {
              keySentence = keySentence.substring(0, 120);
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
          if (keySentence && keySentence.length >= 15) {
            keySentenceText = `> *"${keySentence}"*`;
          } else if (priorReportSnippet) {
            // Try to find structure type or identity description - be more specific
            // Look for "Structure Type" section or similar
            const structureTypeMatch = priorReportSnippet.match(
              /(?:Structure Type|Primary Structure|Your structure)[\s\S]{0,300}(?:is|means|indicates)[\s\S]{0,200}([^.\n]{20,120})/i
            );

            // Look for identity patterns in quotes
            const identityPatternMatch = priorReportSnippet.match(
              /(?:identity|structure)[\s\S]{0,200}["']([^"']{20,120})["']/i
            );

            if (structureTypeMatch && structureTypeMatch[1]) {
              const extracted = structureTypeMatch[1].trim();
              if (extracted.length >= 20 && extracted.length <= 120) {
                keySentenceText = `> *"${extracted}"*`;
              }
            } else if (identityPatternMatch && identityPatternMatch[1]) {
              const extracted = identityPatternMatch[1].trim();
              if (extracted.length >= 20 && extracted.length <= 120) {
                keySentenceText = `> *"${extracted}"*`;
              }
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
            content: `Welcome back ${name}. I've loaded your last report.

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
      // Clear it if we're showing existing report first (user can request new diagnostic explicitly after)
      requestingNewDiagnostic: shouldShowExistingReportFirst
        ? false // Clear flag when showing existing report first
        : wantsNewDiagnostic || existingState.requestingNewDiagnostic || false,
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

    // Route to appropriate handler based on mode
    if (isDiscoveryMode) {
      return await handleDiscoveryMode({
        req,
        res,
        email,
        name,
        messages,
        transcript,
        updatedTranscript,
        existingDiagnostic,
        existingState: intakeState,
        priorReportSnippet,
        diagnosticMetrics,
        latestDiscoveryMetrics,
        reportDate,
        appUser,
        lastUser,
        lastAssistant,
        nextMessage,
        introText,
        discoveryType,
      });
    } else {
      return await handleDiagnosticMode({
        req,
        res,
        email,
        name,
        messages,
        transcript,
        updatedTranscript,
        existingDiagnostic,
        existingState: intakeState,
        priorReportSnippet,
        previousReports,
        appUser,
        lastUser,
        lastAssistant,
        nextMessage,
        introText,
        targetCount: targetCountForRun,
        answeredCount,
        pendingQuestion,
        aiAnswered,
        distinctQuestionNumbers,
        maxQuestionNumber,
        distinctQuestionsAnswered,
        resumeNotice,
        wantsNewDiagnostic,
        hasExistingReport,
      });
    }
  }

  // ============================================
  // FINALIZE FLOW (finalize=true)
  // ============================================
  // Handle manual finalization requests
  // Check if user said "end chat" - if so, save chat immediately and return response

  const transcriptForFinal =
    (Array.isArray(existingState.transcript) && existingState.transcript.length
      ? existingState.transcript
      : transcript) || [];

  const lastUser = [...transcriptForFinal]
    .reverse()
    .find((m) => m?.role === "user");
  const lastUserMsg = lastUser?.content || "";
  const lowerMessage = lastUserMsg.toLowerCase();

  // Check if user just said "end chat" (not "email report")
  const justEndingChat =
    /(end|finish|stop|done|close).*(chat|conversation)/i.test(lowerMessage) &&
    !/(email|send|report)/i.test(lowerMessage);

  if (justEndingChat) {
    // User just wants to end chat - save immediately and return response
    // Report will be generated in background

    // Find or create chat record
    let chat = null;
    if (existingDiagnostic?.chatId) {
      chat = await Chat.findByPk(existingDiagnostic.chatId);
    }

    if (!chat) {
      // Find latest incomplete chat
      chat = await Chat.findOne({
        where: {
          userId: appUser.id,
          isChatEnded: false,
        },
        order: [["createdAt", "DESC"]],
      });
    }

    // Save chat with transcript and mark as ended
    if (chat) {
      await chat.update({
        isChatEnded: true,
        data: {
          ...(chat.data || {}),
          transcript: transcriptForFinal,
          messages: transcriptForFinal,
          endedAt: new Date().toISOString(),
        },
      });
      console.log(
        `[chatbotDiagnosticFreeform] Chat ${chat.id} saved and marked as ended for user ${email}`
      );
    } else {
      // Create new chat record if none exists
      const chatType = hasExistingReport ? "discovery" : "dignostic";
      chat = await Chat.create({
        userId: appUser.id,
        dignosticId: existingDiagnostic?.id || null,
        chatType: chatType,
        isChatEnded: true,
        data: {
          transcript: transcriptForFinal,
          messages: transcriptForFinal,
          endedAt: new Date().toISOString(),
        },
      });
      console.log(
        `[chatbotDiagnosticFreeform] New chat ${chat.id} created and marked as ended for user ${email}`
      );

      // Link chat to diagnostic if exists
      if (existingDiagnostic && !existingDiagnostic.chatId) {
        await existingDiagnostic.update({ chatId: chat.id });
      }
    }

    // Return response immediately
    const response = successResponse(res, "Chat ended and saved", {
      message: "Your chat is ended and saved.",
      status: "saved",
      statusMessage: "Chat saved. Report is being generated in the background.",
      userMessage:
        "Your chat has been ended and saved. Your report is being generated in the background and will be available in your account shortly.",
      chatId: chat.id,
      transcript: transcriptForFinal,
    });

    // Generate report in background (don't await - fire and forget)
    (async () => {
      try {
        const retrievedForBackground = lastUser?.content
          ? await retrieveSimilarChunks({ query: lastUser.content, topK: 3 })
          : [];

        if (hasExistingReport) {
          // DISCOVERY: Generate discovery follow-up report
          await handleDiscoveryFinalize({
            req,
            res: null, // No response needed - already sent
            email,
            name,
            transcriptForFinal,
            existingDiagnostic,
            priorReportSnippet,
            diagnosticMetrics,
            appUser,
            introText,
            backgroundMode: true, // Flag to skip email
          });
        } else {
          // DIAGNOSTIC: Generate full diagnostic report
          await handleDiagnosticFinalize({
            req,
            res: null, // No response needed - already sent
            email,
            name,
            transcriptForFinal,
            existingDiagnostic,
            priorReportSnippet,
            previousReports,
            appUser,
            existingState,
            introText,
            retrieved: retrievedForBackground,
            backgroundMode: true, // Flag to skip email
          });
        }
        console.log(
          `[chatbotDiagnosticFreeform] Report generated and saved in background for user ${email}`
        );
      } catch (err) {
        console.error(
          `[chatbotDiagnosticFreeform] Background report generation failed for user ${email}:`,
          err
        );
      }
    })();

    return response;
  }

  // If user wants email or report, use existing handlers
  if (hasExistingReport) {
    // DISCOVERY FINALIZE: User has existing report, generate discovery follow-up
    return await handleDiscoveryFinalize({
      req,
      res,
      email,
      name,
      transcriptForFinal,
      existingDiagnostic,
      priorReportSnippet,
      diagnosticMetrics,
      appUser,
      introText,
    });
  } else {
    // DIAGNOSTIC FINALIZE: First-time user, generate full diagnostic
    return await handleDiagnosticFinalize({
      req,
      res,
      email,
      name,
      transcriptForFinal,
      existingDiagnostic,
      priorReportSnippet,
      previousReports,
      appUser,
      existingState,
      introText,
      retrieved: lastUser?.content
        ? await retrieveSimilarChunks({ query: lastUser.content, topK: 3 })
        : [],
    });
  }
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
      where: { email },
      order: [["createdAt", "DESC"]],
    });
    const discoveries = allDiscoveries;

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
      const pdfUrl = discovery.pdfUrl || discovery.data?.pdfUrl;
      if (pdfUrl) {
        allPdfUrls.push({
          type: "discovery",
          discoveryId: discovery.id,
          diagnosticId:
            discovery.diagnosticId || discovery.data?.diagnosticId || null,
          title: discovery.title || `Discovery Report ${discovery.id}`,
          url: pdfUrl,
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
