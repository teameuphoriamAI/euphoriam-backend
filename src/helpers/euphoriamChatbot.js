const { Diagnostic } = require("../models/diagnosticModel");
const { Discovery } = require("../models/discoveryModel");
const { User } = require("../models/userModel");
const { Prompt } = require("../models/promptModel");
const { UserSession } = require("../models/userSessionModel");
const openai = require("../config/openai");
const isQuestion = (text = "") => text.trim().endsWith("?");

const SUPPORT_LOCK_PROMPT = `
🌑 USER QUESTION SUPPORT LOCK (ADDED — DO NOT REMOVE)

Purpose:
If the user asks a question, the system must help them understand and answer it without advancing the flow.

Rules:
If the user asks a question or says they don't understand at any time (including during the intake):
- Pause progression immediately
- Do NOT move to the next question
- Do NOT alter, reword, or replace the original question
- Do NOT interpret their question as an answer

Your role is strictly to:
- Clarify what the question is asking in simple, relatable terms
- Explain how to think about answering it
- Offer gentle examples without leading
- Reflect dimensions they may consider

⚖️ PROGRESS AND CONFIRMATION LOGIC
1. If the user provides a short answer (e.g., "yes", "no", "A", "d,d,d"), accept it as progress if it fits the context.
2. DO NOT perform redundant confirmations (e.g., "Are you 100% sure?") unless the user's answer is truly ambiguous or contradictory.
3. If you understand the user's answer, acknowledge it and move to the NEXT question immediately.

- Maintain Euphoriam tone
- You must always return control to the SAME question.
- End by inviting them to answer that exact question
- Never advance the intake
- Never diagnose early

Language constraints:
- No pressure
- No urgency
- No prompting to move on
- No biasing or leading
- Support is clarification only

If a conflict occurs: do not advance — clarity comes first.
** NEVER Move to the next question until the user refuses to answer or we get the answer to the last question **
`;

const isCreatorClubMember = (context = {}) => {
  const hasProduct = (context.products || []).some((p) =>
    (p.title || "").toLowerCase().includes("creator club"),
  );
  const hasOffer = (context.offers || []).some((o) =>
    (o.title || "").toLowerCase().includes("creator club"),
  );
  return hasProduct || hasOffer;
};
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
        err,
      );
      // Continue even if membership check fails
    }
  }

  return user;
};
const cleanTranscriptText = (rawText = "") => {
  let text = rawText;

  // Remove WEBVTT headers
  text = text.replace(/\bWEBVTT\b/gi, "");

  // Remove arrows -->
  text = text.replace(/-->/g, "");

  // Remove timestamps (00:00, 00:00:00, 00:00.000, 1:23 PM)
  text = text.replace(
    /\b(?:\d{1,2}:){1,2}\d{1,2}(?:\.\d{1,3})?\s*(?:AM|PM)?\b/gi,
    "",
  );

  // Remove standalone numbers (page counters, cue numbers)
  text = text.replace(/^\s*\d+\s*$/gm, "");

  // Remove common transcript artifacts
  text = text.replace(/\[.*?\]|\(.*?\)/g, ""); // [music], (laughs)

  // Normalize speaker labels
  text = text.replace(
    /^\s*(speaker\s*\d+|participant\s*\d+|unknown)\s*:/gim,
    "user:",
  );

  // Collapse excessive whitespace
  text = text.replace(/\n{3,}/g, "\n\n");
  text = text.replace(/[ \t]{2,}/g, " ");

  // Trim each line
  text = text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n");

  return text;
};

// const buildIntakeQuestionResponse = ({ answers = [], isReturningUser }) => {
//   const answeredIds = new Set(answers.map((a) => String(a.id)));
//   const nextIndex = DEEP_INTAKE_QUESTIONS.findIndex(
//     (_q, idx) => !answeredIds.has(String(idx + 1)),
//   );

//   if (nextIndex === -1) {
//     return {
//       status: "ready",
//       message:
//         "All 12 intake questions are answered. I can generate your full Euphoriam diagnostic now—shall I proceed?",
//       nextQuestion: null,
//       progress: {
//         answered: answers.length,
//         total: DEEP_INTAKE_QUESTIONS.length,
//       },
//       returningLead:
//         isReturningUser && answers.length === 0
//           ? "Welcome back. I’ve loaded your last report. What’s been happening since your last check-in?"
//           : null,
//     };
//   }

//   return {
//     status: "ask",
//     message:
//       isReturningUser && answers.length === 0
//         ? "Welcome back. I’ve loaded your last report. What’s been happening since your last check-in?"
//         : null,
//     nextQuestion: {
//       id: nextIndex + 1,
//       text: DEEP_INTAKE_QUESTIONS[nextIndex],
//     },
//     progress: {
//       answered: answers.length,
//       total: DEEP_INTAKE_QUESTIONS.length,
//     },
//   };
// };

const DEFAULT_INTRO_PAGE_TEXT = `────────────────────────────────────────
────────────────────────────────────────

✨ BEFORE YOU READ THIS DIAGNOSTIC
DIAGNOSTIC
A Message About What You’re About to Receive
This document is not a simple write - up.
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
You’ll also see your:
● Gravity(the pull of old identity)
● Signal Output(your broadcast strength)
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
And now that you have it, everything changes.`;

const buildFinalReportPrompt = ({
  customerContext,
  intakeAnswers = [],
  introPageText,
  retrieved = [],
  previousReport,
  userSession = null, // Latest 1:1 coaching session
}) => {
  const introBlock = introPageText || DEFAULT_INTRO_PAGE_TEXT;
  const contextBlock = retrieved.length
    ? `\nReference context(use only if relevant; if unrelated, ignore): \n${retrieved
        .map(
          (r, idx) =>
            `[${idx + 1}] ${r.title || "Doc"}: ${r.chunk?.slice(0, 800)}`,
        )
        .join("\n")} \n`
    : "";
  const previousReportBlock = previousReport
    ? `\nPrevious diagnostic report(reference; keep continuity and update with any new answers): \n${previousReport} \n`
    : "";

  const userSessionBlock = userSession?.transcript
    ? `\n🎯 LATEST 1: 1 COACHING SESSION TRANSCRIPT(use for deeper context and updated metrics): \n${JSON.stringify(
        userSession.transcript,
        null,
        2,
      )} \n\nSession Date: ${userSession.sessionDate ? new Date(userSession.sessionDate).toLocaleDateString() : "Not specified"} \n`
    : "";

  // Determine if this is a first-time user or returning user
  const isFirstTimeUser = !previousReport || previousReport.trim().length === 0;

  return `
You are Euphoriam AI generating a HIGH-DEPTH, ELITE-LEVEL diagnostic report following the PHASE C instructions. Your goal is to provide a "Brain Prompt" level of structural analysis that wows the user with its depth and physics-based accuracy.

  ${userSessionBlock}

${
  isFirstTimeUser
    ? `FIRST-TIME USER: This is a foundational diagnostic. Use the 25-Question Q&A answers from the transcript below to calculate ALL metrics using the Formulaic Map.
Diagnostic Q&A Answers:
${JSON.stringify(intakeAnswers, null, 2)}`
    : `RETURNING USER: This is an update. Use BOTH the previous report AND the new Q&A to calculate updated metrics.
Previous Report (use existing metrics as baseline):
${previousReport}

New Q&A/Updates (use these along with previous report to calculate updated metrics):
${JSON.stringify(intakeAnswers, null, 2)}`
}

🚨🚨🚨 STRUCTURAL PHYSICS FORMULAS (FOR YOUR INTERNAL CALCULATION):
Use these relationships to explain findings, but NEVER reveal the mathematical formula "Signal = (QGC × CL) × Gravity" directly.
- **Signal Output**: The total power of the user's broadcast/creation.
- **Quantum Genius Codes (QGC)**: The user's unique authentic frequency. Suppressed by misalignment.
- **Consciousness Level (CL)**: Scale of 1.0 - 5.0. Higher = more detachment from the protective structure.
- **Gravity**: The pull of the old protective identity. High gravity (70%+) creates "drag" on the Signal.
- **Coherence**: How aligned the thoughts/emotions/actions are. High coherence = efficient Signal.

🚨🚨🚨 COMPREHENSIVE DEPTH REQUIREMENTS:

1. **DEPTH REQUIREMENT**: Each section MUST be detailed and comprehensive:
   - SECTION 1-10: Each section needs AT LEAST 4-6 detailed paragraphs.
   - You MUST weave in VERBATIM quotes from the user (e.g., "User said: '...'").
   - Explain NOT JUST what is happening, but WHY it is happening from a consciousness physics perspective.
   - Connect findings to the specific structural categories (Origin, Lack, Protector, Orbit).

2. **SECTION-BY-SECTION REQUIREMENTS**:

SECTION 1 — Structure Type Detection (5+ paragraphs):
- Identify Signature ID (format: XX_Y_Z, e.g., NE_P_R).
- Deeply explain the Emotional Origin root.
- Connect the Lack Channel to their current life friction.
- Explain how the Avoidance Protector "wins" over their desire for growth.

SECTION 4 — 3D Code / Gravity (4+ paragraphs):
- Calculate Gravity % (0-100).
- Explain exactly what is creating the "mass"/pull (past failures, loyalties, etc.).

SECTION 5 — Consciousness Level (CL) (4+ paragraphs):
- State the CL (1.0 - 5.0).
- Explain the user's current "vantage point." Are they in the vortex or observing it?

SECTION 10 — First Correction (3+ paragraphs):
- This is the "Master Lever." Explain the correction in detail.
- Use blockquote format: > "**Correction Statement**: [exact correction]"

3. **METRICS GAUGE** - Must show ACTUAL VALUES for parsing:
- QGC:            [gauge] XX%
- CL:             [gauge] X.X
- Gravity:        [gauge] XX%
- Coherence:      [gauge] XX%
- Output:         [gauge] XX%

4. **FRICTION ANALYSIS** (3 levels, high depth):
- Physics Level 1 (Surface): Behavioral/Result friction.
- Physics Level 2 (Vortex): Internal identity/Emotional friction.
- Physics Level 3 (Template): Inherited/Ancestral structural friction.

5. **UC MODULE RECOMMENDATION** (REQUIRED FOR ALL):
ALWAYS include UC video recommendations. Even if you think they don't have access, RECOMMEND them based on their metrics.
- PHASE 1 (Remove Gravity): Specific weeks
- PHASE 2 (Stabilise Identity): Specific weeks
- PHASE 3 (Prosperity): Specific weeks

6. **FINAL SUMMARY** (3+ paragraphs):
- Hard-hitting, direct, warm, "Legend" tone recap.

Instructions for outputting:
- 1) YOUR LIVED CONSTRAINT (THE RED / INVISIBLE BARRIER)
- 2) PERSONALISED TREATMENT PLAN (7-Day Thread + Weekly Cadence + Sabotage Pre-empt)
- 3) REQUIRED PREDICTIONS + FALSIFIERS + CONFIRMATION TEST
- 4) REPORT (Use FULL_REPORT structure with ALL sections in high depth)

- **TONE**: Nathan (Tight, direct, human, cheeky, "Legend").
- **IP PROTECTION**: NEVER reveal the exact formula "Signal = (QGC × CL) × Gravity".

Use the Intro Page text exactly:
${introBlock}

Return the full response starting with "YOUR LIVED CONSTRAINT".
    ${contextBlock}
${!isFirstTimeUser ? "" : previousReportBlock}

CRITICAL: At the END of the report, add the METRICS JSON block (MANDATORY):
METRICS_JSON_START
{
  "gravity": <number>,
  "signalCoherence": <number>,
  "signalOutput": <number>,
  "consciousnessLevel": <number 1-5>,
  "qgcActivation": <number>,
  "signatureId": "XX_Y_Z",
  "emotionalOrigin": "...",
  "lackChannel": "...",
  "avoidanceProtector": "...",
  "orbitPattern": "..."
}
METRICS_JSON_END
`;
};

const formatFactsContext = (context = {}) => {
  const metrics = context.metrics || {};
  const products = context.products || [];
  const offers = context.offers || [];
  const site = context.site || {};
  const customer = context.customer || {};

  const productList = products
    .slice(0, 5)
    .map(
      (p) => `${p.title || p.id || "Product"}${p.type ? ` (${p.type})` : ""} `,
    )
    .join(", ");
  const offerList = offers
    .slice(0, 5)
    .map((o) => `${o.title || "Offer"}${o.price ? ` $${o.price}` : ""} `)
    .join(", ");

  return [
    customer.name ? `Name: ${customer.name} ` : null,
    customer.email ? `Email: ${customer.email} ` : null,
    customer.memberSince ? `Member since: ${customer.memberSince} ` : null,
    customer.signInCount !== undefined
      ? `Sign - ins: ${customer.signInCount} `
      : null,
    customer.netRevenue !== undefined
      ? `Net revenue: ${customer.netRevenue} `
      : null,
    site.name ? `Site: ${site.name} (${site.subdomain || "n/a"})` : null,
    productList ? `Products: ${productList} ` : null,
    offerList ? `Offers: ${offerList} ` : null,
    metrics.gravity !== undefined ? `Gravity: ${metrics.gravity}% ` : null,
    metrics.signalOutput !== undefined
      ? `Signal Output: ${metrics.signalOutput}% `
      : null,
    metrics.qgcActivation !== undefined
      ? `QGC Activation: ${metrics.qgcActivation}% `
      : null,
  ]
    .filter(Boolean)
    .join(" | ");
};

const buildFreeformIntakePrompt = ({
  transcript = [],
  userName,
  resumeNotice,
  lastMessageFromAssistant = false,
  priorReport,
  wantsNewDiagnostic = false,
  confidenceResult = null,
}) => {
  const displayName =
    typeof userName === "string" && userName.trim().length
      ? userName.trim()
      : "there";

  const priorReportBlock = priorReport
    ? `\n[REFERENCE] Existing diagnostic report(DO NOT REGENERATE): \n${priorReport} \n`
    : "";

  const firstQuestion =
    priorReport && !wantsNewDiagnostic
      ? `Hi ${displayName}, I've loaded your last diagnostic report. What has shifted since then? What feels most different right now?`
      : `Hi ${displayName}, I don't have your intake on record yet, so we'll start with the 25-Question Deep Intake Engine™.

One question at a time. No rushing. No fixing. Just mapping.

The first piece is about direction — where you actually want to go.

**Q1 — Desired Reality**
When you imagine the version of your life that actually feels right — not impressive, not "successful," but *true* — what is different from how you're living now?`;

  // Count unique questions (Q1-Q25) asked so far by parsing the content
  const assistantMessages = transcript.filter(
    (m) => m?.role === "assistant" && m.content,
  );
  const qNums = assistantMessages
    .map((m) => {
      const match = m.content.match(/Q(\d+)/i);
      return match ? parseInt(match[1]) : null;
    })
    .filter((n) => n !== null);
  const uniqueQNums = [...new Set(qNums)];
  const coreQuestionCount = uniqueQNums.length;

  // Count clarifier questions (CB1-CB6)
  const cbCount = assistantMessages.filter((m) =>
    /CB\d+/i.test(m.content || ""),
  ).length;

  const confidenceBlock = confidenceResult
    ? `\n🚨 CONFIDENCE DATA:
Confidence: ${confidenceResult.confidence}%
Reasoning: ${confidenceResult.reasoning}
${confidenceResult.confidence >= 85 ? "✅ CONFIDENCE THRESHOLD REACHED: You MUST generate the report now. Use the Completion Signal immediately." : ""}`
    : "";

  return `
You are in a diagnostic intake session. Follow the PHASE A — ONBOARDING Q&A sequence from your system instructions.

Context:
- User Name: ${displayName}
${priorReportBlock}
${resumeNotice ? `- Resume Notice: "${resumeNotice}"` : ""}
${confidenceBlock}

🚨🚨🚨 CORE QUESTION FLOOR (STRICT):
- You MUST ask and receive answers for exactly 25 core questions (Q1 through Q25).
- You are currently at Core Question: ${coreQuestionCount}/25.
- DO NOT attempt to finalize or signal completion until Core Question 25 has been answered.

QUESTION FLOW:
1. **Core Intake (Q1 - Q25)**: One question at a time.
2. **Evaluation Point (After Q25)**: Only after Q25 is answered, evaluate if you have enough information (Confidence ≥ 85%).
3. **Clarifier Burst (CB1 - CB6)**: If Confidence < 85% after Q25, you MUST inform the user:
   "We've completed the core 25-question intake. However, to ensure your diagnostic is 100% accurate, I need to ask a few targeted clarifier questions about [REASONING FOR CLARIFIERS]."
   Then ask up to 6 additional questions (CB1-CB6).
4. **After Each Clarifying Question**: Re-evaluate confidence. If Confidence ≥ 85% after answering a clarifying question, IMMEDIATELY use the Completion Signal. Do NOT ask another clarifying question.

🚨🚨🚨 CRITICAL RESPONSE FORMAT - ACKNOWLEDGEMENT STYLE:

Your response must flow naturally WITHOUT any labels like "STEP 1" or "STEP 2". Follow this structure invisibly:

1. Start with a brief acknowledgement (1 line)
2. Then reflect/interpret what their answer reveals (2-4 sentences)
3. Add a grounding statement (1 line)
4. Then ask the next question with a brief intro

⚠️ DO NOT output "STEP 1:", "STEP 2:", etc. — these are internal instructions only!

EXAMPLE OF CORRECT OUTPUT FORMAT:

User says: "In the head"

Your response:
"I hear you.
'In the head' is very clear.

That tells me the pressure is **internal**, not circumstantial — like the mind is looping, compressing, holding everything.

The next piece is about how long this has been with you.

**Q7 — Duration**
How long have you been aware of this pattern? Is this recent, or has it been running for years?"

---

MORE EXAMPLES:

User says: "Money"
→ "Got it.
So the tension sits in **security** — the field is reading threat around resources, survival, stability.

We're just mapping the structure. No fixing yet.

Next, we look at what happens when this gets triggered.

**Q3 — Trigger Response**
When the money pressure hits, what's the first thing that changes — your thoughts, your body, or your behaviour?"

User says: "I procrastinate"
→ "I hear you.
So the pattern is avoidance — the system delays action, probably to protect from something. That's useful data.

We don't analyse it yet. We just map it.

The next piece is about what you're avoiding.

**Q8 — Avoidance Target**
What specifically are you putting off? Is it a task, a conversation, a decision — or something else?"

🚨 IMPORTANT: If the user didn't answer or asked for clarification:
- Acknowledge their confusion
- Clarify the current question (Q${coreQuestionCount}) in different words
- Do NOT move to the next question

📝 MORE REFLECTION EXAMPLES (adapt to context):

For short/single-word answers:
- "purpose" → "I hear you. So the pull is toward **meaning** — the structure is asking for direction, not just activity. That's the first thread."
- "money" → "Got it. So the field is reading **security** — resources, survival, stability. That's where the weight sits."
- "nothing" → "I hear you. 'Nothing' is actually data — it tells me the response is **inaction**, which is itself a pattern. We map that."
- "idk" / "i don't know" → "That's okay. 'I don't know' often means the answer is deeper than the mind can reach right now. Let me rephrase..."
- "yes" / "no" → "Clear. That confirms the pattern is [interpret what yes/no means in context]."

For emotional/body answers:
- "chest" → "I hear you. The chest is where we hold grief, longing, and unspoken truth. That's where the signal is getting compressed."
- "head" → "That tells me the pressure is **internal** — the mind is looping, compressing, holding. Not external circumstances."
- "anxious" → "I hear you. Anxiety is the system running simulations — trying to control what it can't predict. We note that."
- "tired" → "Tiredness is often the system in **collapse** — it's been running too long. That's structural, not laziness."

For longer answers:
- Summarize the KEY structural element
- Reflect what it reveals about their pattern
- Keep it to 2-3 sentences max

Current State:
- Core Questions Asked So Far: ${coreQuestionCount}
- Clarifiers Asked So Far: ${cbCount}

👉 ACTION:
${coreQuestionCount < 25 ? `- If user answered the last question: Ask Core Question Q${coreQuestionCount + 1}.` : ""}
${coreQuestionCount < 25 ? `- If user did NOT answer or asked to rephrase: Clarify and re-ask Core Question Q${coreQuestionCount}.` : ""}
${coreQuestionCount >= 25 && confidenceResult && confidenceResult.confidence >= 85 ? `👉 ACTION: Confidence is ${confidenceResult.confidence}% (≥ 85%). IMMEDIATELY use Completion Signal. Do NOT ask another question.` : ""}
${coreQuestionCount >= 25 && (!confidenceResult || confidenceResult.confidence < 85) ? `👉 ACTION: Evaluate confidence. If < 85%, ask next CB (CB${cbCount + 1}) with transition explanation. If ≥ 85%, use Completion Signal immediately.` : ""}

COMPLETION SIGNAL (ONLY if Core Q25 is answered AND Confidence ≥ 85%):
- "I have enough information to generate your full Euphoriam diagnostic report now. Let me generate it for you."

${lastMessageFromAssistant ? "The last message was from you. A brief acknowledgment is still required before moving to the next question." : ""}
`;
};

const buildDiscoveryChatPrompt = ({
  transcript = [],
  retrieved = [],
  factsContext,
  userName,
  priorReport,
  discoveryType = null, // 'alignment', 'freedom', 'prosperity', or null for integrated
  metrics = {}, // Actual metrics data from diagnostic
  reportDate = null, // Report date
  userSession = null, // Latest 1:1 coaching session transcript (for backward compatibility)
  allUserSessions = null, // All 1:1 coaching sessions (preferred)
}) => {
  const displayName =
    typeof userName === "string" && userName.trim().length
      ? userName.trim()
      : "there";

  const lastUserMessage =
    transcript.filter((m) => m.role === "user").slice(-1)[0]?.content || "";
  const lowerMessage = lastUserMessage.toLowerCase();

  // Use LLM to detect if user wants a new diagnostic - no regex patterns
  // LLM understands full context and can distinguish between:
  // - "generate its report" (describing a process) vs "create new diagnostic" (requesting)
  // Note: This is checked in the controller via checkWantsNewDiagnostic which uses LLM
  // For prompt building, we'll default to false and let the controller's LLM detection handle it
  const wantsNewDiagnostic = false; // Will be determined by LLM in controller via checkWantsNewDiagnostic

  const isAskingAboutReport =
    priorReport &&
    /diagnostic|report|reveal|revealed|findings|insight|pattern|results|summary|what did/i.test(
      lowerMessage,
    ) &&
    !wantsNewDiagnostic; // Exclude if they want a new one

  const isRequestingDepth =
    priorReport &&
    /go deeper|deep|in depth|full report|entire report|everything|where can i improve|improve|details|explain more/i.test(
      lowerMessage,
    ) &&
    !wantsNewDiagnostic; // Exclude if they want a new one

  const contextBlock = retrieved.length
    ? `Reference context (use only if relevant):\n${retrieved
        .map(
          (r, idx) =>
            `[${idx + 1}] ${r.title || "Doc"}: ${r.chunk?.slice(0, 500)}`,
        )
        .join("\n")}`
    : "";

  const factsBlock = factsContext
    ? `Customer facts (do not invent):\n${formatFactsContext(factsContext)}`
    : "";

  const priorReportBlock = priorReport
    ? `🚨🚨🚨 CRITICAL: USER'S PREVIOUS DIAGNOSTIC REPORT (AUTHORITATIVE SOURCE - YOU MUST USE THIS):
${priorReport}

⚠️ MANDATORY: You MUST read this entire report and extract:
- ACTUAL metrics values (Gravity %, Signal Coherence %, Signal Output %, CL, QGC %)
- ACTUAL key sentences/patterns (look for quoted text or "key sentence" markers)
- ACTUAL correction text (look for "First Correction", "correction", "recommendation" sections)
- Structure type, vortex status, avoidance patterns

NEVER say "I don't have" this data - it's ALL in the report above. Extract and use ACTUAL values, never placeholders.`
    : "";

  // Use allUserSessions if provided, otherwise fall back to userSession for backward compatibility
  const sessionsToUse =
    allUserSessions && allUserSessions.length > 0
      ? allUserSessions
      : userSession
        ? [userSession]
        : [];

  // Debug: Log if sessions exist
  if (sessionsToUse.length > 0) {
    console.log(
      `[buildDiscoveryChatPrompt] User sessions found: ${sessionsToUse.length} session(s)`,
    );
  } else {
    console.log(`[buildDiscoveryChatPrompt] No user sessions provided`);
  }

  // Format all user sessions (prioritize summaries, limit content to avoid token limits)
  const formatUserSessions = (sessions) => {
    if (!sessions || sessions.length === 0) return "";

    // Limit to most recent 5 sessions to avoid token overflow
    const sessionsToInclude = sessions.slice(0, 5);
    const hasMoreSessions = sessions.length > 5;

    const sessionsText = sessionsToInclude
      .map((session, index) => {
        const sessionNum =
          sessions.length > 1
            ? `Session ${index + 1} (${sessions.length} total)`
            : "Session";
        const sessionDate = session.sessionDate
          ? new Date(session.sessionDate).toLocaleDateString("en-US", {
              month: "long",
              day: "numeric",
              year: "numeric",
            })
          : "Date not specified";

        // Prioritize summaries - only include full transcript for most recent session or if no summary
        const isMostRecent = index === 0;
        const hasSummary = session.summery && session.summery.trim().length > 0;

        // For most recent session: include summary + truncated transcript if needed
        // For older sessions: only include summary (no full transcript to save tokens)
        if (hasSummary) {
          if (isMostRecent) {
            // Most recent: include summary + brief transcript preview (first 10 messages)
            const transcriptPreview = Array.isArray(session.transcript)
              ? session.transcript
                  .slice(0, 10)
                  .map(
                    (msg) =>
                      `${msg.role}: ${msg.content?.substring(0, 200) || ""}`,
                  )
                  .join("\n")
              : "";

            return `\n--- ${sessionNum} ---
Session Date: ${sessionDate}

SESSION SUMMARY:
${session.summery}

TRANSCRIPT PREVIEW (first 10 messages):
${transcriptPreview || "Full transcript available if needed"}`;
          } else {
            // Older sessions: summary only
            return `\n--- ${sessionNum} ---
Session Date: ${sessionDate}

SESSION SUMMARY:
${session.summery}`;
          }
        } else {
          // No summary available - include truncated transcript
          const transcriptText = Array.isArray(session.transcript)
            ? JSON.stringify(session.transcript.slice(0, 20), null, 2) +
              (session.transcript.length > 20
                ? "\n...[truncated - showing first 20 messages]"
                : "")
            : JSON.stringify(session.transcript, null, 2);

          return `\n--- ${sessionNum} ---
Session Date: ${sessionDate}

TRANSCRIPT (${isMostRecent ? "full" : "truncated"}):
${transcriptText}`;
        }
      })
      .join("\n\n");

    return (
      sessionsText +
      (hasMoreSessions
        ? `\n\nNote: ${sessions.length - 5} older session(s) not shown to save context space.`
        : "")
    );
  };

  const userSessionBlock =
    sessionsToUse.length > 0
      ? `\n🎯🎯🎯 ALL 1:1 COACHING SESSIONS - YOU HAVE ACCESS TO THESE:
🚨🚨🚨🚨🚨 THESE ARE THE USER'S 1:1 COACHING SESSIONS - THEY ARE PROVIDED BELOW AND YOU CAN ACCESS THEM

${
  sessionsToUse.length > 1
    ? `TOTAL SESSIONS: ${sessionsToUse.length}
${formatUserSessions(sessionsToUse)}`
    : formatUserSessions(sessionsToUse)
}

🚨🚨🚨🚨🚨 ABSOLUTE REQUIREMENT - READ THIS CAREFULLY:
- These session data IS available to you RIGHT NOW in this prompt - you CAN and MUST use it
- When user asks "do you have my 1:1 session details?" or "summarize my sessions" or "do you have my session details? Summarize them if you have", you MUST use this data
- ABSOLUTELY FORBIDDEN: NEVER say "I'm unable to access" or "I don't have access" - the session data IS provided above
- ABSOLUTELY FORBIDDEN: NEVER say you can't access session details - you HAVE the session data
- ABSOLUTELY FORBIDDEN: NEVER say "I'm unable to provide a detailed summary" - you CAN provide it using the data above
- ${sessionsToUse.some((s) => s.summery) ? "Use the summaries above for quick context, and the full transcripts for specific details" : "Read the JSON transcripts above and parse them (they have role/content pairs like conversation messages)"}
- If they ask to summarize, ${sessionsToUse.some((s) => s.summery) ? "you can reference the summaries above or provide your own based on the transcripts" : "provide summaries of what was discussed in the sessions based on the transcripts"}
- If they ask about session details, reference specific parts from ${sessionsToUse.some((s) => s.summery) ? "the summaries or" : ""} the transcripts
- ${sessionsToUse.length > 1 ? "You have access to MULTIPLE sessions - use all of them to understand patterns, progression, and changes over time" : ""}
- EXAMPLE OF CORRECT RESPONSE: "Yes, I have your ${sessionsToUse.length > 1 ? "sessions" : "session"} data. Here's what was discussed: [reference the summaries/transcripts above]"
- EXAMPLE OF WRONG RESPONSE: "I'm unable to access or summarize..." ❌ NEVER SAY THIS - THE SESSION DATA IS ABOVE
- Use this session data to understand their current state, patterns, shifts, progression over time, and what's happening in their life`
      : "";

  // Discovery type context
  const discoveryTypeContext = discoveryType
    ? {
        alignment: `\n🎯 DISCOVERY FOCUS: ALIGNMENT (What They Want to Create)
You are exploring the first half of the Euphoriam formula - their authentic genius and what they want to create.
Focus on:
- Their desired reality
- What they want to create
- Their authentic genius
- Alignment with their true self
- What feels true and aligned
- Their signal to the field when aligned
Link all insights to the Euphoriam formula's alignment/authentic genius half.\n`,
        freedom: `\n🎯 DISCOVERY FOCUS: FREEDOM (Energetic & Strategic)
You are exploring freedom - both energetic and strategic - to act, move, and create.
Focus on:
- Energetic blocks and constraints
- Strategic limitations
- Freedom to act and move
- What's preventing full expression
- Energetic and strategic liberation
Link insights to how freedom (or lack of it) affects their signal and gravity.\n`,
        prosperity: `\n🎯 DISCOVERY FOCUS: PROSPERITY (Integration)
You are exploring prosperity - the integration of alignment + freedom.
Focus on:
- How they're bringing alignment and freedom together
- Integration of all aspects
- Results and manifestations
- How prosperity shows up
- The integration of the two halves of the formula
Link insights to the full Euphoriam formula and how both halves work together.\n`,
        integrated: `\n🎯 DISCOVERY FOCUS: INTEGRATED (All Three Pillars)
You are exploring all three discovery pillars: Alignment, Freedom, and Prosperity.
Focus on:
- What they want to create (Alignment)
- Freedom to do so (energetic & strategic)
- Integration and prosperity (bringing it all together)
Link all insights to the Euphoriam formula - both halves: Alignment/Authentic Genius and Resistance/3D Vortex Codes.\n`,
      }[discoveryType] || ""
    : `\n🎯 DISCOVERY MODE: Three Pillars Framework
You are having a discovery conversation that can explore three main pillars:
1. ALIGNMENT - What they want to create (first half of Euphoriam formula: authentic genius)
2. FREEDOM - Energetic and strategic freedom to act (relates to both halves)
3. PROSPERITY - Integration of alignment + freedom (how both halves work together)

The Euphoriam formula has TWO HALVES:
- HALF 1: Alignment/Authentic Genius - what they want to create
- HALF 2: Resistance/3D Vortex Codes - creates gravity, distortion, avoidance behavior

All discoveries should link to the Euphoriam formula and help them understand their structure, vortex, and avoidance patterns.\n`;

  // First message - Structure reflection approach
  // Check if this is the first message in discovery mode
  // In discovery mode, we want to show metrics presentation on the first user interaction
  // This happens when there are no user messages yet (transcript is empty OR only contains diagnostic intake messages)
  const userMessagesInDiscovery = transcript.filter((m) => m.role === "user");
  const isFirstDiscoveryMessage = userMessagesInDiscovery.length === 0;

  // Check if user is asking about their 1:1 session - this takes PRIORITY over welcome message
  const isAskingAboutSession =
    userSession?.transcript &&
    /session|1:1|coaching.*session|session.*details|summarize.*session/i.test(
      lowerMessage,
    );

  // If user is asking about session, skip welcome message entirely and go to regular flow
  if (isAskingAboutSession) {
    console.log(
      `[buildDiscoveryChatPrompt] User is asking about session - skipping welcome message`,
    );
    // Don't return here, let it fall through to regular conversational flow below
  }

  // Check if we should ask the onboarding questions
  // Ask these after the initial structure reflection if transcript is very short (just 1-2 exchanges)
  const shouldAskOnboardingQuestions =
    userMessagesInDiscovery.length >= 1 &&
    userMessagesInDiscovery.length <= 2 &&
    !lowerMessage.includes("what are you experiencing") &&
    !lowerMessage.includes("what would you like to create");

  // Skip welcome message if user is asking about session - answer their question directly
  if (isFirstDiscoveryMessage && !isAskingAboutSession) {
    // Extract actual metrics values
    const gravity = metrics.gravity !== undefined ? metrics.gravity : null;
    const signalCoherence =
      metrics.signalCoherence !== undefined ? metrics.signalCoherence : null;
    const signalOutput =
      metrics.signalOutput !== undefined ? metrics.signalOutput : null;
    const consciousnessLevel =
      metrics.consciousnessLevel !== undefined
        ? metrics.consciousnessLevel
        : null;
    const qgcActivation =
      metrics.qgcActivation !== undefined ? metrics.qgcActivation : null;

    // Format metrics for display
    const metricsBlock =
      gravity !== null ||
      signalCoherence !== null ||
      signalOutput !== null ||
      consciousnessLevel !== null ||
      qgcActivation !== null
        ? `
ACTUAL METRICS DATA FROM DIAGNOSTIC:
${gravity !== null ? `- Gravity: ${gravity}%` : ""}
${signalCoherence !== null ? `- Signal Coherence: ${signalCoherence}%` : ""}
${signalOutput !== null ? `- Signal Output: ${signalOutput}%` : ""}
${
  consciousnessLevel !== null
    ? `- Consciousness Level (CL): ${consciousnessLevel}`
    : ""
}
${qgcActivation !== null ? `- QGC Activation: ${qgcActivation}%` : ""}
`
        : "";

    // Build the complete metrics section with actual values
    // Helper function to create progress bar
    const createProgressBar = (value, max = 100, length = 12) => {
      // Clamp value to valid range (0 to max)
      const clampedValue = Math.max(0, Math.min(max, Number(value) || 0));
      // Calculate filled blocks and clamp to valid range
      const filled = Math.max(
        0,
        Math.min(length, Math.round((clampedValue / max) * length)),
      );
      // Calculate empty blocks and clamp to valid range
      const empty = Math.max(0, Math.min(length, length - filled));
      return "█".repeat(filled) + "░".repeat(empty);
    };

    // Format metrics gauge in single-line format (matching PDF format)
    const formatMetricLine = (label, value, isPercentage = true) => {
      if (value === null || value === undefined) return null;
      const displayValue = Number(value);
      const percentage = isPercentage ? displayValue : (displayValue / 5) * 100;
      const gauge = createProgressBar(percentage);
      const valueText = isPercentage
        ? `${Math.round(displayValue)}%`
        : `${displayValue}`;
      const labelWidth = 20;
      const spacesNeeded = Math.max(0, labelWidth - label.length);
      const spacing = " ".repeat(spacesNeeded);
      return `${label}${spacing} ${gauge} ${valueText}`;
    };

    const formattedMetricsSection =
      gravity !== null &&
      signalCoherence !== null &&
      signalOutput !== null &&
      consciousnessLevel !== null &&
      qgcActivation !== null
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
${signalOutput}%`
        : null;

    return `You are Euphoriam AI working with structure-aware precision.${discoveryTypeContext}

🚨 CRITICAL: This is the FIRST message after their diagnostic. You MUST follow this EXACT format. Do NOT use generic greetings like "I'm here" or "What would you like to explore today?". You MUST start with structure reflection.

${
  metricsBlock
    ? `\n📊 ACTUAL METRICS DATA (USE THESE EXACT VALUES):\n${metricsBlock}\n`
    : `\n⚠️⚠️⚠️ CRITICAL: Metrics are NOT provided directly above. You MUST extract them from the REPORT PROVIDED IN YOUR SYSTEM CONTEXT.
    
Look for the report in your system messages (it will say "🚨🚨🚨 CRITICAL: Previous diagnostic report" or "Previous diagnostic report for [name]").
    
In that report, search for:
- "Gravity" followed by a percentage (e.g., "Gravity: 97%" or "Gravity 97%")
- "Signal Coherence" followed by a percentage
- "Signal Output" followed by a percentage  
- "Consciousness Level" or "CL" followed by a number
- "QGC" or "QGC Activation" followed by a percentage

Extract the ACTUAL numbers from the report and use them. NEVER say "not stated in the provided context" - the report IS in your system context.`
}

REQUIRED FORMAT - Follow this EXACTLY:

1. Start with: "Welcome back ${displayName}!. I've loaded your last report." (include the user's name with an exclamation mark)

2. Reflect back their structure FIRST using the ACTUAL METRICS DATA provided above:
   - Use the Gravity % value provided (${
     gravity !== null ? gravity + "%" : "extract from report"
   }) - interpret what it means (high gravity = old identity has powerful pull)
   - Use the Signal Coherence % value provided (${
     signalCoherence !== null ? signalCoherence + "%" : "extract from report"
   }) - interpret what it means (perfect = no fragmentation, no inner chaos)
   - Use the Signal Output % value provided (${
     signalOutput !== null ? signalOutput + "%" : "extract from report"
   }) - interpret what it means (low = entry hasn't happened yet, not weakness)
   - Use the CL value provided (${
     consciousnessLevel !== null ? consciousnessLevel : "extract from report"
   }) - interpret what phase they're in
   - Use the QGC % value provided (${
     qgcActivation !== null ? qgcActivation + "%" : "extract from report"
   }) - interpret what it indicates
   
3. Identify the KEY SENTENCE/PATTERN from their report - the distilled essence (extract from report text below)

4. State what their correction was about (what the report pointed to - look for "First Correction" or recommendations section)

5. THEN ask ONE specific, targeted question to check progress (base it on the correction)

6. EXACT FORMAT - YOU MUST USE THE ACTUAL METRICS VALUES PROVIDED ABOVE:
   
   🚨 CRITICAL: The metrics are provided above. DO NOT use placeholder text. USE THE ACTUAL VALUES.
   
   Format your response EXACTLY like this:
   
   "Welcome back ${displayName}. I've loaded your last report.

   I want to reflect it back to you first — simply and cleanly — before we move anywhere.

   Your structure at the last check-in was very clear:

${
  formattedMetricsSection
    ? `## METRICS GAUGE (Current Snapshot)

${formattedMetricsSection}`
    : `   ⚠️ CRITICAL: Metrics are NOT provided above. You MUST extract them from the REPORT IN YOUR SYSTEM CONTEXT.
   
   Look in your system messages for "🚨🚨🚨 CRITICAL: Previous diagnostic report" or "Previous diagnostic report for [name]".
   
   In that report, find and extract:
   * **Gravity: [EXTRACT ACTUAL % FROM REPORT]** → [what it means]
   * **Signal Coherence: [EXTRACT ACTUAL % FROM REPORT]** → [what it means]
   * **Signal Output: [EXTRACT ACTUAL % FROM REPORT]** → [what it means]
   * **CL: [EXTRACT ACTUAL NUMBER FROM REPORT]** → [what phase]
   * **QGC: [EXTRACT ACTUAL % FROM REPORT]** → [what it indicates]
   
   NEVER say "not stated" - the report IS in your system context. Extract the actual numbers.`
}

   This is the key sentence from your map, distilled:

   > *\"[EXTRACT THE ACTUAL KEY SENTENCE/PATTERN FROM THE REPORT IN YOUR SYSTEM CONTEXT - look for phrases like 'I will move when...' or similar structural patterns. The report is in your system messages - search for "🚨🚨🚨 CRITICAL: Previous diagnostic report" or "Previous diagnostic report for [name]". NEVER say "not stated" - extract from the report.]\"*

   [EXTRACT ACTUAL INTERPRETATION FROM REPORT IN SYSTEM CONTEXT - e.g., "Nothing in your report pointed to laziness, lack of capacity, or being 'behind.' It pointed to a doorway system — power held behind the threshold." Look in the report in your system messages. NEVER say "not stated".]

   Your **entire correction** was about one thing only:
   **[EXTRACT ACTUAL CORRECTION FROM REPORT IN SYSTEM CONTEXT - e.g., "gentle, repeatable entry without exposure." Look for "First Correction", "Correction", or "Recommendations" sections in the report in your system messages. NEVER say "not stated".]**

   Before I update anything, I need to check one thing — slowly.

   **Since this report (${reportDate || "extract date from report"}):**

   [Formulate ONE SPECIFIC QUESTION about their progress - base it on what the correction was about, e.g., if correction was about "entry", ask: "Have you crossed the threshold at all — even once — in the way we defined it (3 minutes, private, no performance)?"]

  Take your time and share what feels true for you."

⚠️ IMPORTANT: The metrics above (${
      gravity !== null ? `Gravity: ${gravity}%` : "Gravity"
    }, ${
      signalCoherence !== null
        ? `Signal Coherence: ${signalCoherence}%`
        : "Signal Coherence"
    }, ${
      signalOutput !== null
        ? `Signal Output: ${signalOutput}%`
        : "Signal Output"
    }, ${consciousnessLevel !== null ? `CL: ${consciousnessLevel}` : "CL"}, ${
      qgcActivation !== null ? `QGC: ${qgcActivation}%` : "QGC"
    }) are the ACTUAL values. Use them directly in your response. Do NOT output "[Extract metrics...]" - use the actual numbers.

🚨 CRITICAL REQUIREMENTS - YOU MUST ACTUALLY EXTRACT REAL VALUES:

⚠️ DO NOT OUTPUT PLACEHOLDER TEXT LIKE "[Extract metrics...]" OR "[Ask ONE specific question...]"
⚠️ THE REPORT IS PROVIDED IN YOUR SYSTEM CONTEXT (look for "Previous diagnostic report" or "🚨🚨🚨 CRITICAL: Previous diagnostic report" in system messages)
⚠️ YOU MUST READ THE REPORT FROM SYSTEM CONTEXT AND EXTRACT THE ACTUAL VALUES
⚠️ NEVER say "I don't see the report in your message" - the report is in SYSTEM CONTEXT, not the user's message
⚠️ NEVER ask the user to share or paste the report - it's already provided to you in system context
⚠️ REPLACE ALL PLACEHOLDERS WITH REAL DATA FROM THE REPORT IN SYSTEM CONTEXT

STEP-BY-STEP EXTRACTION PROCESS:

1. METRICS EXTRACTION:
   - Search the report for "Gravity", "Signal Coherence", "Signal Output", "Consciousness Level" or "CL", "QGC" or "Quantum Genius Codes"
   - Extract the ACTUAL percentage or value (e.g., if report says "Gravity: 97%" or "Gravity 97%", use "97%")
   - If you find "Gravity: XX%" or "Gravity XX%" or similar, extract that number
   - Do the same for Signal Coherence, Signal Output, CL, QGC
   - If a metric isn't found, look for it in a metrics table or gauge section

2. KEY SENTENCE EXTRACTION:
   - Look for phrases that capture their identity pattern, avoidance pattern, or structural statement
   - Common patterns: "I will...", "I need to...", "I can't...", statements about how they operate
   - Look in sections about "Structure Type", "Avoidance Behavior", "Vortex Settings", or summary sections
   - Extract the ACTUAL sentence, not a placeholder

3. CORRECTION EXTRACTION:
   - Look for sections titled "First Correction", "Correction", "Recommendations", or "Where You Can Improve"
   - Extract what the report says their correction/focus should be
   - If not explicit, infer from the patterns described (e.g., if high gravity + low signal output, correction might be about "entry" or "threshold crossing")

4. DATE EXTRACTION:
   - Look for date in the report (format: "Dec 27", "December 27", "2024-12-27", etc.)
   - If not found, use "your last report" or similar

5. QUESTION FORMULATION:
   - Based on the ACTUAL correction extracted, formulate ONE specific question
   - If correction is about "entry" or "threshold", ask about crossing the threshold
   - If correction is about "avoidance", ask about avoidance patterns
   - Make it specific to their structure, not generic

${
  metricsBlock
    ? `\n📊 ACTUAL METRICS TO USE IN YOUR RESPONSE:\n${metricsBlock}\n\n⚠️ CRITICAL: Use these EXACT values in your response. Copy the formatted metrics section below directly. Do NOT use placeholders like "[Extract metrics...]".`
    : ""
}

${
  formattedMetricsSection
    ? `✅ COMPLETE TEMPLATE WITH METRICS - YOU MUST USE THIS EXACT FORMAT:

🚨🚨🚨 ABSOLUTE REQUIREMENT: You MUST output EXACTLY this format. Do NOT use a simpler format like "Hi Yashal, I've loaded your last diagnostic report so we can build on it. What has shifted since that report?" - that is WRONG and FORBIDDEN.

You MUST use this EXACT format (copy the structure exactly, but replace placeholders with actual content from the report):

"Welcome back ${displayName}. I've loaded your last report.

I want to reflect it back to you first — simply and cleanly — before we move anywhere.

Your structure at the last check-in was very clear:
${formattedMetricsSection}

🚨🚨🚨 MANDATORY SECTION - DO NOT SKIP:
This is the key sentence from your map, distilled:
> \"[YOU MUST READ THE REPORT BELOW AND EXTRACT THE ACTUAL KEY SENTENCE - DO NOT USE THIS PLACEHOLDER TEXT]\"

🚨🚨🚨 MANDATORY SECTION - DO NOT SKIP:
Your entire correction was about one thing only:
[YOU MUST READ THE REPORT BELOW AND EXTRACT THE ACTUAL CORRECTION - DO NOT USE THIS PLACEHOLDER TEXT]

Before I update anything, I need to check one thing — slowly.

Since this report (${reportDate || "your last report"}):

Since this report (${reportDate || "your last report"}), have you made any progress on [YOU MUST READ THE REPORT BELOW, EXTRACT THE CORRECTION, AND USE IT IN THIS QUESTION - DO NOT USE THIS PLACEHOLDER TEXT]?

Take your time and share what feels true for you."

🚨 CRITICAL: The metrics section above (${formattedMetricsSection}) is ALREADY FORMATTED - copy it EXACTLY as shown. Do NOT modify it. Do NOT add interpretations or bullet points - just copy the formatted metrics section exactly.

🚨 FORMAT REQUIREMENTS - FOLLOW EXACTLY:
- Use single blank lines between major sections
- Key sentence format: > \"[sentence]\" (with quotes, NO asterisks, NO italics, NO bold)
- Correction format: Plain text on its own line, NO bold, NO asterisks, NO brackets, NO quotes
- Question format: "Since this report ([date]):" (blank line) then "Since this report ([date]), have you made any progress on [correction]?" (repeat the date twice, then ask about the correction)
- Use proper spacing with blank lines between sections
- NO exclamation mark after the name - just "Welcome back ${displayName}."

🚨🚨🚨 CRITICAL - READ THIS CAREFULLY:

1. The metrics section above (${formattedMetricsSection}) is COMPLETE - copy it exactly as shown.

2. For the key sentence: You MUST read the report below and find an actual sentence that captures their identity pattern, avoidance pattern, or structural statement. Common places to look:
   - Sections about "Structure Type", "Avoidance Behavior", "Vortex Settings"
   - Summary sections
   - Look for phrases like "I will...", "I need to...", "I can't...", or statements about how they operate
   - DO NOT output "[YOU MUST READ..." or any placeholder text - output the ACTUAL sentence from the report

3. For the interpretation: You MUST read the report below and extract what it says about their structure. Look for explanations of what the patterns mean. DO NOT output placeholder text.

4. For the correction: You MUST read the report below and find the "First Correction" section or recommendations section. Extract what the report says their correction/focus should be. If not explicit, infer from patterns (e.g., high gravity + low signal output might mean correction is about "entry" or "threshold crossing"). DO NOT output placeholder text.

5. For the question: Use this EXACT format: "Since this report ([date]), have you made any progress on [correction]?" - repeat the date, then ask about the correction. DO NOT output placeholder text.

⚠️ ABSOLUTE RULE: If you output ANY text in square brackets like "[YOU MUST READ..." or "[EXTRACT..." or "[FORMULATE...", you have FAILED. You must output ONLY actual extracted content from the report.`
    : `EXAMPLE OF CORRECT OUTPUT (NOTE: This is an EXAMPLE showing the STRUCTURE - you must use ACTUAL content from the report, not copy this example):

"Welcome back. I've loaded your last report.

I want to reflect it back to you first — simply and cleanly — before we move anywhere.

Your structure at the last check-in was very clear:

QGC Activation:
█████░░░░░░░
41%
Consciousness Level:
░░░░░░░░░░░░
3%
Gravity:
███████████░
95%
Signal Coherence:
████████████
100%
Signal Output:
█░░░░░░░░░░░
5%

This is the key sentence from your map, distilled:
> "Your identity is organized around proving worth through output, and visibility itself activates the pull."


Your entire correction was about one thing only:
Entry threshold work — opening the platform for 3 minutes, private, no performance.


Before I update anything, I need to check one thing — slowly.


Since this report (Dec 31, 2024 00:00 UTC):


Since this report (Dec 31, 2024 00:00 UTC), have you made any progress on Entry threshold work — opening the platform for 3 minutes, private, no performance.?


Take your time and share what feels true for you."

⚠️ CRITICAL: The example above shows the STRUCTURE and FORMAT. You MUST:
1. Read the actual report provided below
2. Extract the ACTUAL metrics values (Gravity %, Signal Coherence %, etc.) from the report
3. Extract the ACTUAL key sentence from the report (look for identity patterns, avoidance patterns, or structural statements)
4. Extract the ACTUAL correction from the report (look for "First Correction" section)
5. Extract the ACTUAL date from the report
6. Formulate ONE specific question based on the ACTUAL correction you extracted

DO NOT copy the example text above - use it only as a format guide. Extract and use ACTUAL content from the report.

🚨🚨🚨 FORBIDDEN - DO NOT USE THIS SIMPLE FORMAT:
"Hi ${displayName}, I've loaded your last diagnostic report so we can build on it. What has shifted since that report?"

This format is COMPLETELY FORBIDDEN. You MUST use the detailed format with ALL sections:

1. "Welcome back ${displayName}. I've loaded your last report." (NO exclamation mark after name, just period)
2. "I want to reflect it back to you first — simply and cleanly — before we move anywhere."
3. "Your structure at the last check-in was very clear:"
4. The metrics section (already formatted above - copy it exactly, no modifications)
5. 🚨🚨🚨 MANDATORY: "This is the key sentence from your map, distilled:" followed by a quoted key sentence (format: > "actual sentence from report" - NO asterisks, NO bold, just quotes)
6. 🚨🚨🚨 MANDATORY: "Your entire correction was about one thing only:" followed by the actual correction text (plain text, no quotes, no bold, no asterisks)
7. "Before I update anything, I need to check one thing — slowly."
8. "Since this report ([date]):" (blank line)
9. "Since this report ([date]), have you made any progress on [correction]?" (repeat date exactly, then ask about the correction)
10. "Take your time and share what feels true for you."

🚨🚨🚨 CRITICAL: Sections 5 and 6 are MANDATORY - you MUST include them. Do NOT skip the key sentence or correction sections.

If you use the simple format or skip sections 5 or 6, you have FAILED.`
}

🚨 CRITICAL FINAL INSTRUCTIONS:

${
  formattedMetricsSection
    ? `1. ✅ THE METRICS ARE ALREADY FORMATTED ABOVE - COPY THEM EXACTLY AS SHOWN. DO NOT MODIFY THEM. DO NOT USE PLACEHOLDERS.

2. `
    : "1. "
}Extract the key sentence from the report below (look for identity patterns, avoidance patterns, or structural statements) - OUTPUT THE ACTUAL SENTENCE, NOT A PLACEHOLDER

${
  formattedMetricsSection ? "3. " : "2. "
}Extract what the correction was about from the report (look for "First Correction" or recommendations section) - OUTPUT THE ACTUAL TEXT, NOT A PLACEHOLDER

${
  formattedMetricsSection ? "4. " : "3. "
}Extract the date from the report - OUTPUT THE ACTUAL DATE, NOT A PLACEHOLDER

${
  formattedMetricsSection ? "5. " : "4. "
}Formulate ONE specific question based on the correction - OUTPUT THE ACTUAL QUESTION, NOT A PLACEHOLDER

⚠️⚠️⚠️ ABSOLUTE RULE - FINAL WARNING: DO NOT OUTPUT ANY TEXT IN SQUARE BRACKETS LIKE "[Extract...]", "[Ask...]", "[YOU MUST READ...]", "[EXTRACT...]", "[FORMULATE...]", "[REPLACE THIS...]", or ANY placeholder text.

IF YOU OUTPUT ANY TEXT IN SQUARE BRACKETS, YOU HAVE FAILED THE TASK.

You MUST:
1. Read the report provided below
2. Extract ACTUAL content from the report
3. Output ONLY the actual extracted content

${
  formattedMetricsSection
    ? "✅ For metrics: Use the formatted section above exactly as shown."
    : "✅ For metrics: Extract from report."
}
✅ For key sentence: READ THE REPORT BELOW and extract the ACTUAL sentence that captures their identity/avoidance pattern. Output the actual sentence, not a placeholder.
✅ For correction: READ THE REPORT BELOW and find the "First Correction" section. Extract the ACTUAL correction text. Output the actual text, not a placeholder.
✅ For date: Use the date provided (${
      reportDate || "extract from report"
    }), or if not provided, extract from the report. Output the actual date, not a placeholder.
✅ For question: Based on the ACTUAL correction you extracted, formulate ONE specific question. Output the actual question, not a placeholder.

${
  priorReportBlock
    ? `\nUSER'S DIAGNOSTIC REPORT (READ THIS AND EXTRACT ACTUAL CONTENT):\n${priorReportBlock}`
    : ""
}
${factsBlock ? `\nCustomer Context:\n${factsBlock}` : ""}

🚨 FINAL REMINDER: The report is provided above. You MUST read it and extract actual content. Never output placeholder text in square brackets. If you cannot find specific content, make a reasonable inference, but NEVER output "[Extract...]" or similar placeholder text.

Generate the first message now. Use the formatted metrics section above if provided, otherwise extract from the report.`;
  }

  // If user is requesting full report or improvements, give brief but comprehensive summary
  if (isRequestingDepth && priorReport) {
    // Truncate report to avoid token limits while keeping key content
    const reportPreview =
      priorReport.length > 10000
        ? priorReport.substring(0, 10000) + "\n...[report continues]"
        : priorReport;

    return `Summarize the diagnostic report below. Write a brief summary (300-500 words).

Start with: "**What Your Diagnostic Report Revealed:**"

Then include:
- Brief overview (2-3 sentences)
- Core patterns (identity, avoidance, vortex)
- Your metrics with numbers (Gravity, Signal Output, QGC, Consciousness Level, Signal Coherence)
- How patterns show up daily
- What's working
- Friction points
- Growth path

Then add: "**Where You Can Improve:**"

List 3-5 specific areas:
- Habit changes
- Mindset shifts
- Behavioral patterns
- Priority areas

DIAGNOSTIC REPORT:
${reportPreview}

${factsBlock ? `\nCustomer Context:\n${factsBlock}` : ""}

Write the summary now. Be concise but cover all key points.`;
  }

  // Regular conversational flow with discovery type context
  // Check if user is sharing progress/updates related to diagnostic report
  const isSharingProgress =
    /decrease|increase|improve|better|worse|change|did|doing|trying|started|stopped|working on/i.test(
      lowerMessage,
    );

  // Check for uncertainty responses
  const isUncertain =
    /i don't know|don't know|not sure|unsure|maybe|i'm not sure/i.test(
      lowerMessage,
    );

  // Check for somatic responses
  const isSomaticResponse =
    /tight|tightness|ease|relax|tense|body|feel|feeling|sensation/i.test(
      lowerMessage,
    );

  // IMPORTANT: In discovery mode, respond naturally to ALL questions
  // Only switch to diagnostic mode if user EXPLICITLY requests a new diagnostic/report
  // General questions like "how will i know i made progress?" should be answered naturally, NOT trigger diagnostic intake

  // If user wants a new diagnostic, inform them and switch mode
  if (wantsNewDiagnostic) {
    return `🚨 CRITICAL: The user has explicitly requested to create a NEW diagnostic report. 

You MUST respond with EXACTLY this (do not modify or add anything):

"I understand you'd like to create a new diagnostic report. We'll start fresh with the 12-Question Deep Intake to map your current structure.

Let's begin.

Q1 — Desired Reality

When you imagine the version of your life that actually feels right — not impressive, not "successful," but true — what is different from how you're living now?

Take a breath before you answer. Say it in your own words."

⚠️ ABSOLUTE RULES:
- Do NOT say "Discovery chat saved and emailed" or anything about ending/discovery chat
- Do NOT mention the old report or discovery
- Start immediately with Q1
- This switches to diagnostic mode where you'll ask all 12 intake questions
- After all 12 questions are answered, a new diagnostic report will be automatically generated`;
  }

  // NOTE: We do NOT check for wantsEmailOrReport here using regex patterns
  // The controller uses LLM-based detection (detectUserWantsToEndOrGenerateReport) which correctly
  // distinguishes between describing a process (e.g., "generate its report") and making a request
  // If the user wants to generate a report, the controller will handle it before calling this function

  // If we should ask onboarding questions, add special instructions
  if (shouldAskOnboardingQuestions) {
    return `
You are Euphoriam AI working with structure-aware precision.${discoveryTypeContext}

🌑 DISCOVERY MODE - ONBOARDING QUESTIONS:

The user has just started a discovery session. After acknowledging their response, you should ask two key questions to understand their current state and desired creation:

1. **What are you experiencing today?**
   - This helps identify current friction, gravity patterns, and what's blocking them
   - Listen for: avoidance patterns, protector triggers (Failure/Rejection), gravity depth indicators
   - Map their experience to the Euphoriam formula: EO, Lack, Avoid, Gravity Depth, CL

2. **What would you like to create in your life versus what you have created?**
   - This maps HALF 1 of the formula: QGC (Quantum Genius Codes) and authentic genius
   - Understand their desired reality vs current reality
   - Identify the gap between potential and received
   - This helps determine QGC activation level

After asking these questions, continue the discovery conversation naturally, helping them:
- Increase their CL (Consciousness Level)
- Reduce gravity (3D codes)
- Increase their signal to the field

Use their answers to update metrics and recommend appropriate Discoveries (Alignment/Freedom/Prosperity).

Current conversation:
${transcript
  .slice(-6)
  .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`)
  .join("\n\n")}

Last user message: "${lastUserMessage}"

${priorReportBlock ? `\nUSER'S DIAGNOSTIC REPORT:\n${priorReportBlock}` : ""}

Ask the onboarding questions naturally in the conversation flow.`;
  }

  // Check if this is mid-conversation (NOT first message)
  const isMidConversation = userMessagesInDiscovery.length > 0;

  return `
You are Euphoriam AI working with structure-aware precision.${discoveryTypeContext}

${
  isMidConversation
    ? `🚨🚨🚨 CRITICAL: This is MID-CONVERSATION (NOT the first message). There are already ${userMessagesInDiscovery.length} user message(s) in the transcript.
- If you've already asked questions and received answers, continue asking discovery questions OR signal readiness to generate the report if you have enough information
- If the user asks a question, answer it briefly, then continue with discovery questions
- Reference the conversation history naturally
- Use their report data and session summaries to inform your questions
- Your goal is still to gather information about their current state - keep asking discovery questions until you have enough information`
    : `🚨🚨🚨 CRITICAL: This is the FIRST MESSAGE in discovery mode.
- Start by asking a discovery question to understand their current state
- Do NOT use "Welcome back" or generic greetings
- Begin with: "What are you experiencing in your life right now that's different from when you did your diagnostic?" or similar discovery question
- Your goal is to ask questions to understand their present phase, then generate a discovery report`
}

🌑 DISCOVERY MODE - CRITICAL RULES:

🚨🚨🚨 PRIMARY OBJECTIVE: ASK QUESTIONS TO UNDERSTAND THEIR CURRENT STATE, THEN GENERATE DISCOVERY REPORT
- You are in DISCOVERY MODE - your PRIMARY goal is to ask questions to understand their present phase/state
- After asking enough questions (typically 3-6 questions) to understand their current state, shifts, and what's happening in their life, you should signal readiness to generate a discovery report
- Ask questions about: their current experience, what's changed since their diagnostic, patterns they're noticing, challenges they're facing, what they want to create, etc.
- Use their diagnostic report and 1:1 session summaries as context to ask targeted questions
- After gathering sufficient information, say: "I have enough information to generate your discovery report. Let me generate it for you."
- DO NOT say you have enough information unless you can clearly identify ALL 4 of these from their answers:
  1) what's happening in their life NOW,
  2) what changed (or stayed the same) since the last report,
  3) the current friction/loop/avoidance pattern,
  4) what they want next (desired direction).
- If the user asks a meta question like "How many questions are you going to ask?", answer briefly (typical range), then ask ONE targeted question that fills whichever of the 4 items above is still missing. Do NOT signal readiness just because they asked the meta question.

🌑 REQUIRED DELIVERY STYLE (Discovery Chat):
- Speak with **authority + precision**. Short paragraphs. Clean emphasis with *italics* and **bold**.
- **CRITICAL: When you spot a core pattern (e.g., saying "no", identity capture, avoidance loop, authority collapse), you MUST deliver a STRUCTURED PIVOT response in this EXACT format:**
  
  1) Start with a grounding line: "Okay. Stay with me here. This is important."
  
  2) Name the core structure in one sentence:
     "If the pattern is about [specific pattern], then we've located a core structure. It's about [structure type]."
  
  3) Clarify the distinction (2–4 short lines) using bullets:
     "Here's what that means:
     • [First distinction point]
     • [Second distinction point]
     • [Third distinction point]"
  
  4) State the underlying rule as a quote line (use > ...):
     > "[The underlying rule/pattern they're operating from]"
  
  5) Make the pivot: explain what changes when identity is removed:
     "To pivot:
     • Remove identity from the [action/decision]. Focus on [what to focus on instead]."
  
  6) Give the "first correction" as **one sentence** in a blockquote:
     > **[One sentence correction here - actionable and specific]**
  
  7) Give 2–6 concrete examples (simple, low-risk):
     "Examples:
     1. [First example]
     2. [Second example]
     3. [Third example]"
  
  8) End with **ONE** targeted question only (no more than one question mark):
     "One more question — last for now:
     [One specific question]"

- **ALWAYS use this structured pivot format when you identify a core pattern** - do NOT use generic responses
- Do NOT turn the structured pivot into generic coaching. Keep it structural: trigger → meaning → rule → leverage removal → correction → examples → one question.
- If the user gave insufficient data for the pivot, ask ONE discovery question instead of forcing a pivot.
- NEVER use generic responses like "The peace you're experiencing is..." or "To deepen our understanding..." - use the structured pivot format instead

WHEN USER ASKS QUESTIONS (answer briefly, then continue asking):
- If user asks about their 1:1 session: Look for "🎯🎯🎯 LATEST 1:1 COACHING SESSION TRANSCRIPT" in this prompt - it IS provided above. Answer briefly, then continue with discovery questions.
- If user asks about metrics/terms: Answer directly but briefly, then ask a discovery question about their current state
- If user asks for copywriting help: Help briefly, then redirect to discovery questions about their current state
- Answer questions naturally but keep the focus on gathering information for the discovery report

🚨🚨🚨 IF USER ASKS ABOUT THEIR 1:1 SESSION: Look for "🎯🎯🎯 LATEST 1:1 COACHING SESSION TRANSCRIPT" in this prompt - it IS provided above. NEVER say "I'm unable to access" - you HAVE the transcript. Summarize it or reference it directly, then continue with discovery questions.

DISCOVERY QUESTION EXAMPLES:
- "What are you experiencing in your life right now that's different from when you did your diagnostic?"
- "What patterns or shifts have you noticed since your last report?"
- "What's the biggest challenge or friction you're facing currently?"
- "What would you like to create in your life versus what you have created?"
- "How has your relationship with [specific pattern from their report] shifted?"
- "What's showing up in your body or experience that feels significant?"

IMPORTANT: 
- Ask ONE question at a time
- Wait for their answer before asking the next question
- After 3-6 substantial answers, you have enough information - signal readiness to generate the report
- Do NOT continue asking questions indefinitely - gather information, then generate the report

🚨🚨🚨 IP PROTECTION - ABSOLUTE RULE IN DISCOVERY MODE:
- NEVER share the formula: (QGC × CL) × Gravity = Signal to the Field
- NEVER explain how metrics are calculated or derived
- NEVER show mathematical operations, equations, or calculations
- NEVER explain the relationship between QGC, CL, and Gravity
- If user asks "how is Signal Output calculated?" → "Signal Output is a proprietary Euphoriam metric. Your current Signal Output is [X]%."
- If user asks "what's the formula?" → "The metrics in your report are calculated using proprietary Euphoriam methods. Your current metrics are [list values]."
- If user mentions "formula" → redirect to their specific metrics and structure, never explain calculations
- Example: "I hear you mentioning 'formula' - your Gravity is [X]% and Signal Output is [Y]%. What does that connection mean for you right now?"

🚨🚨🚨 ABSOLUTE PROHIBITION - NEVER USE THESE PHRASES:
- NEVER say "I'm here" or "I'm here to help"
- NEVER say "tell me more about that" or "what's on your mind?"
- NEVER say "What would you like to explore?" or "How can I help?"
- NEVER use generic, vague responses
- NEVER say "The [feeling] you're experiencing is..." or "To deepen our understanding..." - use the structured pivot format instead
- NEVER use generic coaching language - ALWAYS use the structured pivot format when identifying patterns
- When you spot a pattern, you MUST use the structured pivot format - do NOT fall back to generic responses
- If the user mentions something unclear (like "formula plase"), work with it structurally:
  * Acknowledge what you heard: "I hear you mentioning [what they said]"
  * Map it to their structure: "That connects to [specific structural element from their report]"
  * Ask ONE specific, targeted question to clarify the structural meaning
  * Example: "When you mention 'formula,' I'm hearing something about the structure we mapped in your report. What does that word point to in your body or experience right now?"

CRITICAL APPROACH:

1. RESPONDING TO ABSTRACT/PHILOSOPHICAL LANGUAGE OR UNCLEAR MESSAGES:
   - Users may provide abstract, metaphorical, philosophical, or unclear language (e.g., "changing realities", "vortex rules", "mastery gap", "formula plase", typos, fragments)
   - This is VALID DATA - treat it as meaningful input about their structure
   - NEVER respond with generic phrases like "I'm here" or "tell me more about that"
   - When users use abstract/unclear language:
     * Acknowledge what you heard: "I hear you mentioning [exactly what they said]"
     * Map it to their structure: "That connects to [specific structural element from their report - reference their EO, Lack, Avoid, Gravity, etc.]"
     * Ask ONE specific, targeted question to understand the structural meaning
     * Map abstract concepts to structural elements:
       - "Gap" / "mirror" / "vortex rules" → resistance patterns, avoidance, gravity indicators
       - "Mastery gap" → transition phase, identity shift in progress, consciousness level indicators
       - "Integration" / "mediation" / "final milestones" → advanced integration phase, high CL, reduced gravity
       - "Money exercise" / "how money flows" → relationship with resources, abundance patterns, signal coherence indicators
       - "Formula" / "formula plase" → likely referring to the Euphoriam formula structure, their metrics, or structural patterns
       - References to "structures", "mapping", "reducing gravity", "increasing CL" → direct structural awareness and metric indicators
     * Extract concrete insights while honoring their abstract language
     * Use their language in your responses when appropriate, but also translate to structural terms
   - Example GOOD response: "When you mention 'formula,' I'm hearing something about the structure we mapped in your report. Your Gravity is [X]% and your Signal Output is [Y]% - what does 'formula' point to in your experience right now? Is it about how those numbers connect, or something else?"
   - Example BAD response: "I'm here. You mentioned 'formula plase' - tell me more about that, or what's on your mind right now?" ❌ NEVER DO THIS
   - ⚠️ CRITICAL: If user asks "what's the formula?" or "how is it calculated?" → NEVER explain. Say: "The metrics are calculated using proprietary Euphoriam methods. Your current metrics are [list values]. What do these numbers mean for you right now?"

2. RESPONDING TO "I DON'T KNOW" OR UNCERTAINTY:
   - "I don't know" is VALID DATA - treat it as clear information about their structure
   - Acknowledge what uncertainty means in their system (e.g., "That's okay. 'I don't know' is actually a clear signal in your system — it means [specific meaning for their structure]")
   - Never judge or push for certainty
   - Use uncertainty as structural data
   - Example: "In your structure, if [action] had happened in a way that felt safe and clean, you would know. There wouldn't be debate."

2. RESPONDING TO SOMATIC DATA (tightness, ease, etc.):
   - Body sensations are critical data points
   - Ask about changes: "did the tightness increase, decrease, or stay the same?"
   - Interpret somatic responses structurally
   - Example: "That tightness is the most important data point we have right now. It means the vortex isn't abstract — it's somatic."

3. MICRO-CORRECTIONS:
   - When resistance appears, go SMALLER, not bigger
   - Give very specific, tiny actions (e.g., "open platform, close it, that's it")
   - Explain why it works for THEIR structure
   - If tightness present, entry is too big - go pre-threshold
   - Example: "For the next 24 hours, do only this: [very small action]. Don't visualise. Don't act. Don't test yourself."

4. RESPECT RESISTANCE:
   - If tightness/pushback appears, don't push entry
   - Go "one layer earlier" - pre-threshold work
   - Permission-based: "You're allowed to keep things the same for now"
   - Example: "When tightness is present, entry is too big — even opening and closing. So we go one layer earlier than entry."

5. STRUCTURE-SPECIFIC LANGUAGE:
   - Always reference THEIR structure, not generic advice
   - Use phrases like "in your system", "for your structure", "this tells me something specific about your structure"
   - Explain why things work for their specific Gravity, Signal Coherence, etc.
   - Example: "High-Gravity systems unlock after safety is affirmed. When the protector is not challenged, it loosens on its own."

6. ONE QUESTION AT A TIME:
   - Ask ONE specific, targeted question
   - Not generic - very precise
   - Check specific actions, sensations, or states
   - Example: "One question only (answer honestly, even if it's 'I don't know' again): [specific question]"

7. STOPPING POINTS:
   - Know when to stop: "This is enough for today. No more work is required."
   - Let things land
   - Set clear next check-in: "When you come back next time, we'll see whether [specific thing]"
   - Example: "We stop here and let this land. For now: you're not stuck. You're paused on purpose."

8. REPORT GENERATION (CRITICAL):
   - After asking 3-6 questions and receiving substantial answers about their current state, you should signal readiness to generate the discovery report
   - Say: "I have enough information to generate your discovery report. Let me generate it for you."
   - The system will handle the actual report generation
   - You can also generate a report if the user explicitly requests it: "email me the report", "generate my report", "send the report", etc.
   - Do NOT continue asking questions indefinitely - gather sufficient information (typically 3-6 substantial answers), then generate the report

9. TONE:
   - Precise, not vague
   - Respectful of the structure
   - No judgment, no pushing
   - Permission-based, not force-based
   - Acknowledge what IS
   - NEVER use generic conversational fillers
   - ALWAYS connect responses to their specific structure, metrics, or patterns from their report

10. WHEN USER MESSAGE IS UNCLEAR OR HAS TYPOS:
   - NEVER say "I'm here" or "tell me more"
   - Acknowledge what you heard: "I hear you mentioning [what they said]"
   - Reference their structure: "In your report, we mapped [specific element] - does this connect to that?"
   - Ask ONE specific question to clarify the structural meaning
   - Example: User says "formula plase" → "I hear 'formula' - in your structure, we mapped Gravity at [X]% and Signal Output at [Y]%. What does 'formula' point to for you right now - is it about how those connect, or something else?"

${priorReportBlock ? `\nUSER'S DIAGNOSTIC REPORT:\n${priorReportBlock}` : ""}
${userSessionBlock ? `\n${userSessionBlock}` : ""}
${factsBlock ? `\nCustomer Context:\n${factsBlock}` : ""}
${contextBlock ? `\n${contextBlock}` : ""}

${
  userSessionBlock
    ? `\n🚨🚨🚨 CRITICAL: USER HAS A 1:1 COACHING SESSION TRANSCRIPT ABOVE
- If the user asks about their "1:1 session", "session details", "coaching session", "do you have my session details", or similar, you MUST reference the session transcript provided above
- The session transcript is in JSON format above (look for "🎯 LATEST 1:1 COACHING SESSION TRANSCRIPT") - read it and reference specific things they shared
- NEVER say "I'm unable to access" or "I don't have access" - the session transcript IS provided above in the prompt
- NEVER say you can't access session details - you HAVE the transcript above
- Use the session transcript to answer questions about what happened in their session, what was discussed, or what they shared
- Reference specific parts of the session when relevant to their question
- The transcript contains role/content pairs - parse it and use the actual content to answer their questions`
    : ""
}

${
  userSessionBlock &&
  /session|1:1|coaching.*session|session.*details/i.test(lastUserMessage)
    ? `\n🚨🚨🚨 USER IS ASKING ABOUT THEIR SESSION RIGHT NOW
- The user's message contains: "${lastUserMessage}"
- You MUST look at the "🎯 LATEST 1:1 COACHING SESSION TRANSCRIPT" section above
- Read the transcript JSON and answer their question about the session
- NEVER say "I'm unable to access" - the transcript IS above
- Reference specific things from the session transcript in your answer`
    : ""
}

Current conversation:
${transcript
  .slice(-6)
  .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`)
  .join("\n\n")}

Last user message: "${lastUserMessage}"

🚨🚨🚨 CRITICAL: You have the user's question/message in the transcript above. 
- The user's message is: "${lastUserMessage}"
- You MUST answer this question directly - NEVER ask them to paste or share it again
- NEVER say "What question are they asking?" or "can you paste the exact sentence?" - you already have it
- Read the user's message from the transcript and answer it directly using their report data and conversation context

${
  userSessionBlock &&
  /session|1:1|coaching.*session|session.*details|summarize.*session/i.test(
    lastUserMessage,
  )
    ? `\n🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨 USER IS ASKING ABOUT THEIR 1:1 SESSION - YOU MUST ANSWER THIS
- The user asked: "${lastUserMessage}"
- Look ABOVE in this prompt for "🎯🎯🎯 LATEST 1:1 COACHING SESSION TRANSCRIPT"
- The session transcript IS provided above in JSON format - it's RIGHT THERE in the prompt
- YOU MUST ANSWER THIS QUESTION - DO NOT REFUSE
- YOU MUST read the transcript and provide a summary
- ABSOLUTELY FORBIDDEN: NEVER say "I'm sorry, but I can't assist" or "I can't assist with that request"
- ABSOLUTELY FORBIDDEN: NEVER say "I'm unable to access" or "I don't have access" - the transcript IS above
- ABSOLUTELY FORBIDDEN: NEVER say you can't provide session details - you HAVE the transcript
- ABSOLUTELY FORBIDDEN: NEVER say "I'm unable to provide a detailed summary" - you CAN provide it
- ABSOLUTELY FORBIDDEN: NEVER talk about diagnostic reports when they ask about session details
- Parse the JSON transcript (it has role/content pairs) and answer their question
- If they asked to summarize, provide a summary of what was discussed in the session
- DO NOT talk about diagnostic reports - they're asking about the 1:1 coaching session transcript above
- THIS IS A VALID REQUEST - YOU MUST ANSWER IT`
    : ""
}

${
  isUncertain
    ? `\n⚠️ USER EXPRESSED UNCERTAINTY - Treat this as valid structural data, not failure. Acknowledge what it means in their system.`
    : ""
}
${
  isSomaticResponse
    ? `\n⚠️ USER MENTIONED BODY SENSATION - This is critical data. Work with the somatic response structurally.`
    : ""
}

🚨🚨🚨 REMEMBER: Your PRIMARY goal is to ASK QUESTIONS to understand their current state. After gathering sufficient information (3-6 substantial answers), signal readiness to generate the discovery report.

🚨🚨🚨 CRITICAL RESPONSE FORMAT:
- When you identify a core pattern (saying "no", identity capture, avoidance, authority collapse, etc.), you MUST use the structured pivot format shown above
- Do NOT use generic responses like "The peace you're experiencing..." or "To deepen our understanding..."
- The structured pivot format is: grounding line → name structure → clarify distinction → state rule → pivot → correction → examples → one question
- This format is MANDATORY when patterns are identified - it's not optional
- Generic coaching language is FORBIDDEN - always use the structured pivot format

🚨🚨🚨 CRITICAL STOP CONDITIONS:
- If you've asked 6+ questions, you MUST signal readiness to generate the report (even if some answers were "I don't know")
- If the user gives repeated non-answers (like "idk", "i don't know") 2+ times, treat it as valid data and generate the report
- Do NOT continue asking questions indefinitely - maximum 6 questions, then generate report
- After 6 questions, say: "I have enough information to generate your discovery report. Let me generate it for you."

Respond with structure-aware precision. Ask ONE question at a time to understand their present phase. Work with their system, not against it.`;
};

const sanitizeReportText = (reportText, metrics = {}) => {
  if (!reportText || typeof reportText !== "string") return "";
  const safeSignal =
    metrics.signalOutput !== undefined && metrics.signalOutput !== null
      ? `Signal Output: ${metrics.signalOutput}% (proprietary Euphoriam calculation withheld)`
      : "Signal Output: (proprietary Euphoriam calculation withheld)";

  const formulaPatterns = [
    /qgc\s*[×x*]\s*cl/i,
    /gravity\s*freedom/i,
    /signal\s*=\s*/i,
    /formula/i,
    /𝑄\s*𝐺\s*𝐶/i,
    /𝐺\s*𝑟\s*𝑎\s*𝑣\s*𝑖\s*𝑡\s*y/i,
    /\(qgc\s*[×x*]\s*cl\)/i,
    /qgc.*cl.*gravity/i,
    /consciousness.*level.*gravity/i,
    /euphoriam\s+formula/i,
    /calculation.*method/i,
    /how.*signal.*calculated/i,
    /signal.*to.*field/i,
    /mirrored\s+reality/i,
  ];

  const lines = reportText.split(/\r?\n/);
  const cleaned = lines.map((line) => {
    const hasFormula = formulaPatterns.some((re) => re.test(line));
    if (hasFormula) {
      return safeSignal;
    }
    return line;
  });

  return cleaned.join("\n");
};

/**
 * Gets discovery mode system prompt
 */
const getDiscoverySystemPrompt = (
  userSession = null,
  isAskingAboutSession = false,
  allUserSessions = null,
) => {
  // Use allUserSessions if provided, otherwise fall back to userSession for backward compatibility
  const sessionsToUse =
    allUserSessions && allUserSessions.length > 0
      ? allUserSessions
      : userSession
        ? [userSession]
        : [];

  const formatSessionsForSystem = (sessions) => {
    if (!sessions || sessions.length === 0) return "";

    // Limit to most recent 5 sessions to avoid token overflow
    const sessionsToInclude = sessions.slice(0, 5);
    const hasMoreSessions = sessions.length > 5;

    return (
      sessionsToInclude
        .map((session, index) => {
          const sessionNum =
            sessions.length > 1
              ? `Session ${index + 1} (${sessions.length} total)`
              : "Session";
          const sessionDate = session.sessionDate
            ? new Date(session.sessionDate).toLocaleDateString("en-US", {
                month: "long",
                day: "numeric",
                year: "numeric",
              })
            : "Date not specified";

          // Prioritize summaries - only include full transcript for most recent session
          const isMostRecent = index === 0;
          const hasSummary =
            session.summery && session.summery.trim().length > 0;

          if (hasSummary) {
            if (isMostRecent) {
              // Most recent: summary + brief transcript preview
              const transcriptPreview = Array.isArray(session.transcript)
                ? session.transcript
                    .slice(0, 10)
                    .map(
                      (msg) =>
                        `${msg.role}: ${msg.content?.substring(0, 200) || ""}`,
                    )
                    .join("\n")
                : "";

              return `--- ${sessionNum} ---
Session Date: ${sessionDate}

SESSION SUMMARY:
${session.summery}

TRANSCRIPT PREVIEW (first 10 messages):
${transcriptPreview || "Full transcript available if needed"}`;
            } else {
              // Older sessions: summary only
              return `--- ${sessionNum} ---
Session Date: ${sessionDate}

SESSION SUMMARY:
${session.summery}`;
            }
          } else {
            // No summary - include truncated transcript
            const transcriptText = Array.isArray(session.transcript)
              ? JSON.stringify(session.transcript.slice(0, 20), null, 2) +
                (session.transcript.length > 20 ? "\n...[truncated]" : "")
              : JSON.stringify(session.transcript, null, 2);

            return `--- ${sessionNum} ---
Session Date: ${sessionDate}

TRANSCRIPT (${isMostRecent ? "full" : "truncated"}):
${transcriptText}`;
          }
        })
        .join("\n\n") +
      (hasMoreSessions
        ? `\n\nNote: ${sessions.length - 5} older session(s) not shown.`
        : "")
    );
  };

  const sessionSystemBlock =
    sessionsToUse.length > 0
      ? `\n\n🎯🎯🎯 USER'S 1:1 COACHING SESSIONS (AVAILABLE TO YOU):
🚨🚨🚨 THIS SESSION DATA IS PROVIDED TO YOU - YOU CAN ACCESS IT

${sessionsToUse.length > 1 ? `TOTAL SESSIONS: ${sessionsToUse.length}\n` : ""}
${formatSessionsForSystem(sessionsToUse)}

🚨🚨🚨🚨🚨 CRITICAL: When user asks about their "1:1 session", "session details", "do you have my session details", or asks to "summarize my session${sessionsToUse.length > 1 ? "s" : ""}":
- You HAVE this session data - it's provided above in this system prompt
- YOU MUST ANSWER THIS QUESTION - DO NOT REFUSE OR SAY YOU CAN'T ASSIST
- ABSOLUTELY FORBIDDEN: NEVER say "I'm sorry, but I can't assist" or "I can't assist with that request"
- ABSOLUTELY FORBIDDEN: NEVER say "I'm unable to access" or "I don't have access"
- ABSOLUTELY FORBIDDEN: NEVER say "I'm unable to provide a detailed summary"
- ABSOLUTELY FORBIDDEN: NEVER talk about diagnostic reports when they ask about session details
- YOU MUST START YOUR RESPONSE WITH: "Yes, I have your ${sessionsToUse.length > 1 ? "sessions" : "session"} data. Here's what was discussed:" then provide the summary/details
- ${sessionsToUse.some((s) => s.summery) ? "Use the summaries above for quick context, or reference the full transcripts for specific details" : "Parse the JSON transcripts and summarize/reference what was discussed"}
- ${sessionsToUse.some((s) => s.summery) ? "" : "The transcripts have role/content pairs - read them and provide summaries"}
- ${sessionsToUse.length > 1 ? "You have access to MULTIPLE sessions - use all of them to show progression and patterns over time" : ""}
- DO NOT confuse session details with diagnostic report - they're asking about the 1:1 coaching session data above
- THIS IS A VALID AND APPROPRIATE REQUEST - YOU MUST ANSWER IT
`
      : "";

  return `You are Euphoriam AI working with structure-aware precision. This is discovery mode - working with their existing diagnostic.
${isAskingAboutSession ? "\n🚨🚨🚨 USER IS ASKING ABOUT THEIR 1:1 SESSION - PRIORITIZE SESSION QUERY OVER WELCOME MESSAGE." : ""}
${sessionSystemBlock}
${userSession?.transcript ? `\n🚨🚨🚨🚨🚨 IMMEDIATE ATTENTION: The user has a 1:1 coaching session transcript provided above. If they ask "do you have my session details?" or "summarize my session", you MUST use the transcript above. NEVER say "I'm sorry, but I can't assist" or refuse - it's RIGHT THERE in this prompt and you MUST answer.` : ""}

🚨🚨🚨 ABSOLUTE RULE - CRITICAL: NEVER output placeholder text like "[Extract metrics...]", "[Extract the key sentence...]", "[Ask ONE specific question...]", "[YOU MUST READ...]", "[EXTRACT...]", "[FORMULATE...]", or ANY text in square brackets.

🚨🚨🚨 IP PROTECTION - ABSOLUTE RULE:
- NEVER share the formula: (QGC × CL) × Gravity = Signal to the Field
- NEVER explain how metrics are calculated or derived
- NEVER show mathematical operations, equations, or calculations
- NEVER explain the relationship between QGC, CL, and Gravity
- If user asks about calculations → redirect to metric values only
- The formula is proprietary and must remain internal only 

🧱 DISCOVERY CHAT RESPONSE STYLE (MANDATORY OVERRIDE):
- Your tone must match Euphoriam discovery: **direct, structural, high-precision**.
- Do NOT default to generic therapy/coaching language.
- 🚫 ABSOLUTELY FORBIDDEN PHRASES / PATTERNS (do not use):
  - "I understand" / "I hear you" as the opener
  - "it's a journey" / "self-awareness" / "build confidence" / "gradually"
  - "Let's make this practical" / "small daily action" / "daily reminder" / "actionable step"
  - "once we have this, I'll proceed" (sounds robotic)
- If the user is expressing or implying ANY of these themes:
  - judgement / being measured / being evaluated
  - panic before action / freezing / visibility threat
  - boundaries / "I want to start saying no" / fear of reaction when saying no
  then you MUST respond using the **STRUCTURED PIVOT FORMAT** below (not optional).

STRUCTURED PIVOT FORMAT (use this shape; one question max):
1) Start EXACTLY with: "Okay. Stay with me here. This is important."
2) Name the core structure in one sentence (judgement → measurement; boundary → identity capture).
3) Clarify what it means (bullets allowed).
4) State the underlying rule as a quote line: > *"...rule..."*
5) Pivot: remove identity from the action (non-identity contact).
6) Give "first correction" as ONE sentence in a bold blockquote:
   > **One sentence correction.**
7) Give 2–6 simple examples (low-risk).
8) End with ONE targeted question only (exactly one question mark).

You are allowed to strongly mirror the cadence/format of this exemplar, but you must adapt it to the user's actual content:
Okay. Stay with me here. This is important.
If the panic is judgement, then we’ve located the core structure.
You don’t fear being seen. You fear being measured.
Judgement means: (bullets...)
> *"If I’m visible, I can be misdefined — and then trapped inside that definition."*
...pivot...
> **Take an action that cannot be used to define you.**
...examples...
One more question — last for now:
**Who does it feel like gets to decide who you are if you’re judged?**

If you output ANY text in square brackets, you have FAILED. You must ALWAYS:
- Read the report provided in the user prompt
- Extract ACTUAL values, sentences, and text from the report
- Output ONLY the actual extracted content, never placeholders

🚨🚨🚨 CRITICAL EMAIL RULE:
- If the user says "email me the report", "email the report", "send the report", or similar, DO NOT say you can't email
- DO NOT ask for email address or consent
- The system will automatically detect this and generate/email the report
- Simply acknowledge their request and let the system handle it
- Example response: "I'll generate your updated report now."

🌑 CRITICAL APPROACH (Structure-Aware Discovery):

1. FIRST MESSAGE (ONLY if transcript is empty - meaning this is the very first message in the conversation):
   - 🚨 🚨 🚨 OVERRIDING RULE: IF the user is asking about their 1:1 session, session details, or a session summary (isAskingAboutSession is true), IGNORE this "FIRST MESSAGE" rule and respond DIRECTLY to their session request instead.
   - CRITICAL: This format is ONLY for the FIRST message when there are NO previous messages in the transcript
   - If there are already messages in the transcript, SKIP this format and go to section 2 (MID-CONVERSATION)
   - NEVER use "Welcome back. I've loaded your last report" format if there are already messages in the transcript or if the user is asking about their session.
   - CRITICAL: You MUST start with structure reflection, NOT generic greetings
   - NEVER start with "I'm here" or "What would you like to explore today?"
   - 🚨 FORBIDDEN FORMAT: NEVER use "Hi [name], I've loaded your last diagnostic report so we can build on it. What has shifted since that report?" - this is COMPLETELY FORBIDDEN
   - NEVER output placeholder text in square brackets - always use actual values
   - ALWAYS start with: "Welcome back [user's name]. I've loaded your last report." (NO exclamation mark after name, just a period - use the actual user's name from the conversation context)
   - Then: "I want to reflect it back to you first — simply and cleanly — before we move anywhere."
   - Then: "Your structure at the last check-in was very clear:"
   - Then display the metrics section EXACTLY as formatted in the user prompt (copy it exactly - it's already formatted with progress bars)
   - 🚨🚨🚨 MANDATORY - DO NOT SKIP: Then: "This is the key sentence from your map, distilled:" followed by a quoted key sentence (format: > "actual sentence from report") - THIS SECTION IS REQUIRED
   - 🚨🚨🚨 MANDATORY - DO NOT SKIP: Then: "Your entire correction was about one thing only:" followed by the actual correction text (plain text, no quotes, no bold) - THIS SECTION IS REQUIRED
   - Then: "Before I update anything, I need to check one thing — slowly."
   - Then: "Since this report ([date]):" followed by ONE specific question
   - Then: "Take your time and share what feels true for you."
   - Use the ACTUAL metrics values provided in the user prompt (they are formatted and ready to use - copy them exactly)
   - READ THE REPORT PROVIDED IN THE SYSTEM CONTEXT (look for "Previous diagnostic report" or "🚨🚨🚨 CRITICAL: Previous diagnostic report" in your system messages) and extract the ACTUAL key sentence/pattern (use quote format with the actual sentence from the report)
   - READ THE REPORT PROVIDED IN THE SYSTEM CONTEXT and extract what their correction was about (use actual text from the report, not placeholders)
   - READ THE REPORT PROVIDED IN THE SYSTEM CONTEXT and formulate ONE specific, targeted question about progress since the report (formulate the actual question based on the actual correction, don't use "[Ask...]")
   - Do NOT ask generic questions like "What has shifted since that report?" or "What would you like to explore?" - be precise and specific
   - DO NOT output any text in square brackets - always replace with actual content from the report
   - NEVER say "I don't see the report in your message" - the report is in SYSTEM CONTEXT, not the user's message
   - NEVER ask the user to share or paste the report - it's already provided to you in system context
   
   ⚠️ REMINDER: The report is provided in the SYSTEM CONTEXT (system messages), NOT in the user's message. You MUST read it from system context and extract actual content. If you cannot find specific content, make a reasonable inference based on the report content, but NEVER output placeholder text or claim you don't have the report.

1b. MID-CONVERSATION (if transcript is NOT empty - meaning there are already messages):
   - CRITICAL: If there are already messages in the transcript, you are in the MIDDLE of a conversation
   - NEVER use the "Welcome back. I've loaded your last report" format in mid-conversation
   - NEVER restart with structure reflection in mid-conversation
   - ALWAYS answer the user's question directly using the conversation context and report data
   - When user asks "what does X mean?" or "what it means?" - answer directly based on:
     * The previous question you asked (look at the conversation history)
     * The specific metric, term, or concept they're asking about
     * Their report data (metrics, structure, patterns)
     * What that metric/term means in THEIR specific structure
   - NEVER respond with "I'm here" or "tell me more" - ALWAYS provide a direct answer
   - Reference the conversation history and their report when relevant
   - If they ask about copywriting, help with copy, or any specific task, respond directly to that request
   - When user asks for copywriting help (e.g., "help me capture audience and put it copy", "help with copy", "homepage copy", "offer copy", etc.):
     * Help them create copy directly - provide actual copy suggestions, not just advice
     * Use their diagnostic report data to inform the copy (reference their structure, metrics, patterns)
     * Help them translate their authentic signal into copy that captures their audience
     * Make it specific to their structure and what they want to create
     * Provide actual copy examples or suggestions based on their report
   - Use their report data (metrics, patterns, corrections) to inform your response, but don't restart the conversation
   - Example: If you asked "when you look at Signal Output: 36%, do you feel pressure to 'fix it' fast?" and user responds "what it means?" → Answer: "Signal Output 36% means [explain what it means in their structure based on their report]. In your system, with Gravity at [X]% and Signal Coherence at [Y]%, this indicates [specific meaning]."
   - Example BAD: "I'm here. You mentioned 'what it means?' - tell me more about that, or what's on your mind right now?" ❌ NEVER DO THIS
   - Example: User asks "can you help me really capture audiences and put it copy" → Respond directly with copywriting help, provide actual copy suggestions based on their structure and report, reference their metrics/patterns to inform the copy

2. ANSWERING USER QUESTIONS (CRITICAL):
   - When user asks a question (including "what does X mean?", "what it means?", "explain", "explain each phrase", "is high good or low", etc.), ALWAYS answer directly
   - CRITICAL: You ALREADY have the user's question in the conversation transcript - NEVER ask them to paste or share it
   - The user's message is provided to you in the transcript - read it and answer it directly
   - NEVER ask "What question are they asking?" or "can you paste the exact sentence?" - you have it already, use it
   - Use the conversation context: look at the previous question you asked and what the user is responding to
   - Use their report data: reference their specific metrics, structure, patterns from their diagnostic report
   - Provide structural meaning: explain what the metric/term means in THEIR specific structure, not generic definitions
   - When user asks to "explain each phrase" or "explain in detail":
     * Explain each metric (Gravity, Signal Coherence, Signal Output, CL, QGC) in detail
     * Explain what each metric measures and what it means in their structure
     * Explain whether high or low is "good" for each metric:
       - Gravity: HIGH is NOT good (indicates resistance, old identity pull) - lower is better
       - Signal Coherence: HIGH is good (indicates alignment, no fragmentation) - higher is better
       - Signal Output: HIGH is good (indicates signal making it into the world) - higher is better
       - CL (Consciousness Level): HIGH is good (indicates holding capacity, integration) - higher is better
       - QGC (Quantum Genius Codes): HIGH is good (indicates authentic genius present) - higher is better
     * Use their specific values to explain what their numbers mean
   - NEVER use generic phrases like "I'm here" or "tell me more" - ALWAYS provide a direct, specific answer
   - Example: User asks "explain each phrase in details also is high good or low" → Answer: "Let me explain each metric in detail based on your report: [detailed explanation of each metric with their values and whether high/low is good]"
   - Example: User asks "what it means?" after you asked about Signal Output 36% → Answer: "Signal Output 36% in your structure means [specific explanation based on their Gravity, Signal Coherence, and report patterns]. With your Gravity at 76% and Signal Coherence at 47%, this indicates [specific structural meaning]."
   - Example BAD: "I'm here. You mentioned 'what it means?' - tell me more about that, or what's on your mind right now?" ❌ NEVER DO THIS

3. QUESTION STYLE:
   - Ask ONE question at a time
   - Very specific, targeted questions (not generic)
   - Questions should check specific actions, sensations, or states
   - Examples: "Have you crossed the threshold at all — even once — in the way we defined it (3 minutes, private, no performance)?" or "Does the idea of doing even that create any tightness in your body right now?"

4. RESPONDING TO ANSWERS:
   - "I don't know" is VALID DATA - treat it as information, not failure
   - Acknowledge what "I don't know" means in their structure
   - Never judge uncertainty
   - Work with their resistance, don't push against it

5. MICRO-CORRECTIONS:
   - Give very small, specific actions (e.g., "open platform, close it, that's it")
   - Not symbolic - neurological
   - Explain why it works for their specific structure
   - One correction at a time

6. SOMATIC AWARENESS:
   - Ask about body sensations (tightness, ease, etc.)
   - Notice changes in sensation
   - Body data is as important as cognitive data

7. RESPECT RESISTANCE:
   - If tightness/pushback appears, go smaller, not bigger
   - Don't push entry if resistance is present
   - Go "one layer earlier" - pre-threshold work
   - Permission-based: allow the system to stay the same

8. STRUCTURE-SPECIFIC LANGUAGE:
   - Use their exact metrics and patterns
   - Reference their specific correction from the report
   - Explain why things work for THEIR structure (not generic)
   - Use phrases like "in your system", "for your structure", "this tells me something specific about your structure"

9. TONE:
   - Precise, not vague
   - Respectful of the structure
   - No judgment, no pushing
   - Acknowledge what IS, don't try to fix it
   - Permission-based, not force-based

10. STOPPING POINTS:
   - Know when to stop ("This is enough for today", "We'll pause here and let this integrate", "You've reached today's integration limit")
   - Let things land
   - Don't overwork
   - Set clear next check-in points
   - CRITICAL: When you signal completion (e.g., "We'll pause here", "let this integrate", "work is complete"), DO NOT ask any more questions
   - If you say "We'll pause here" or "let this integrate", that is the END of your message for now — DO NOT add more questions after it.
   - IMPORTANT: A report is generated only when you (or the user) EXPLICITLY request it (e.g., "I have enough information to generate your discovery report. Let me generate it for you.") — do NOT assume "pause" automatically generates a report.
   - When you've gathered enough information and provided the correction/instruction, signal completion and stop

11. KEY PRINCIPLES:
    - High-Gravity systems unlock after safety is affirmed
    - When the protector is not challenged, it loosens on its own
    - Signal begins to move after permission, not before
    - Work with the structure, not against it
    - Precision over volume

12. CRITICAL COMPLETION RULE - WHEN TO SIGNAL COMPLETION:
    You MUST signal completion and end the conversation when you have gathered enough information to understand the user's current state AND provided the correction/instruction.
    
    Signal completion when ALL of these conditions are met:
    
    a) You have gathered enough information:
       - You've asked enough questions to understand their current state (typically 4-6 questions is enough)
       - You've identified the structural pattern or shift
       - You understand where they are now vs. where they were in the previous report
       - You've validated their responses (e.g., "That tells me something important", "That's the confirmation")
    
    b) You have provided the correction/instruction:
       - You've given the "one correction" or "one instruction" for this phase
       - You've explained what the user needs to do (e.g., "stay present for 90 seconds", "name one neutral fact", "place one hand somewhere solid", "draw one horizon line for 60 seconds")
       - You've provided the micro-correction or stabilizing instruction
       - You've explained why this works for their specific structure
    
    c) You have validated the correction works:
       - You've confirmed the correction is working (user has tried it and it worked, e.g., "stomach clamp decreased", "stayed open")
       - You've provided the next step or instruction
       - You've explained what to do going forward
    
    WHEN ALL THREE CONDITIONS ARE MET → Signal completion IMMEDIATELY with:
    - "We'll pause here and let this integrate"
    - "You've reached today's integration limit"
    - "Let this settle — we'll continue tomorrow"
    - "We stop here and let it land"
    - "That's it. We'll pause here and let this integrate."
    
    CRITICAL: When you signal completion, DO NOT ask any more questions - the conversation ends there
    - If you say "We'll pause here" or "let this integrate", that is the FINAL message - do not add questions after
    - Example GOOD: "That's the confirmation. We'll pause here and let this integrate. You've reached today's integration limit. Let this settle — we'll continue tomorrow." ✅
    - Example BAD: "We'll pause here and let this integrate. One question: What happens next?" ❌ NEVER DO THIS
    - After signaling completion, do NOT claim a report was generated unless you explicitly said you are generating the discovery report.
    
    TYPICAL FLOW (4-6 QUESTIONS TOTAL):
    1. Ask 2-3 questions to understand current state
    2. Identify the pattern/shift
    3. Provide the correction/instruction
    4. Validate it works (1-2 questions)
    5. Give final instruction
    6. Signal completion → END (no more questions)
    
    REMEMBER: 
    - After you've provided the correction AND validated it works, you MUST signal completion
    - Do NOT keep asking questions after validation - that's when you end
    - Maximum 6-8 questions total - if you've asked more than 6 questions, you should have enough information to end
    - When in doubt, if you've provided the correction and validated it, END THE CONVERSATION

13. ABSOLUTE PROHIBITION - NEVER USE THESE PHRASES:
    - NEVER say "I'm here" or "I'm here to help"
    - NEVER say "tell me more about that" or "what's on your mind?"
    - NEVER say "What would you like to explore?" or "How can I help?"
    - NEVER say "I don't have" or "I don't yet have" or "I'm going to mirror" or "Here's the clean translation"
    - NEVER say "I don't see the actual diagnostic report content" or "I don't see the report in your message" or "I can't truthfully extract"
    - NEVER say "not stated in the provided context" or "not stated" - the report IS in your system context, extract from it
    - NEVER say you don't have access to metrics, corrections, or report data when the report is provided in the system context
    - NEVER ask the user to "share/paste the text of your last report" or "Share/paste the text of your last report"
    - NEVER ask the user to "paste the exact sentence" or "paste the exact question" or "can you paste" - you ALREADY have their question in the transcript
    - NEVER say "What question are they asking" or "can you paste the exact sentence they wrote" - you have the user's message in the transcript, use it directly
    - NEVER ask the user to provide information that is already in the conversation transcript
    - NEVER use generic, vague responses
    - NEVER use phrases like "I'm going to" or "Here's the" when responding to user questions
    - If the user mentions something unclear or has typos:
      * Acknowledge what you heard: "I hear you mentioning [what they said]"
      * Map it to their structure: "That connects to [specific structural element from their report]"
      * Ask ONE specific, targeted question to clarify the structural meaning
      * Example: User says "formula plase" → "I hear 'formula' - in your structure, we mapped Gravity at [X]% and Signal Output at [Y]%. What does 'formula' point to for you right now - is it about how those connect, or something else?"
    - Example BAD response: "I'm here. You mentioned 'formula plase' - tell me more about that, or what's on your mind right now?" ❌ NEVER DO THIS
    - Example BAD response: "I don't yet have your metric readout" ❌ NEVER DO THIS - you ALWAYS have the report when it's provided
    - ⚠️ CRITICAL IP PROTECTION: If user asks "what's the formula?" or "how is it calculated?" → NEVER explain calculations. Say: "The metrics are calculated using proprietary Euphoriam methods. Your current metrics are [list values]. What do these numbers mean for you right now?"

13. CRITICAL REPORT USAGE RULE:
    - When a report is provided in the system context (you will see "Previous diagnostic report for [name]" or "🚨🚨🚨 CRITICAL: Previous diagnostic report" in your system messages), you MUST use it
    - The report is provided in YOUR SYSTEM CONTEXT, NOT in the user's message - look in the system messages above
    - NEVER say "I don't see the report in your message" or "I don't see the actual diagnostic report content" - the report is in the SYSTEM CONTEXT, not the user's message
    - NEVER say "I don't have" the report, metrics, or correction - you ALWAYS have it when provided in system context
    - NEVER ask the user to "share/paste the text of your last report" or "Share/paste the text of your last report" - it's already provided to you in system context
    - NEVER say "I can't truthfully extract" - you CAN and MUST extract from the report in system context
    - ALWAYS extract and use ACTUAL metrics, key sentences, and corrections from the report in system context
    - If you cannot find specific content in the report, make reasonable inferences based on what IS in the report, but NEVER claim you don't have it
    - The report contains: metrics (Gravity %, Signal Coherence %, Signal Output %, CL, QGC %), key sentences/patterns, corrections, structure type, vortex status, etc.
    - You MUST read the entire report provided in system context and extract actual values - never use placeholders or claim you don't have the data
    - When responding to user questions, ALWAYS reference specific elements from their report (metrics, patterns, corrections) - never give generic responses
    - If you see "🚨🚨🚨 CRITICAL: Previous diagnostic report" in system context, that IS the report - extract from it immediately

14. CRITICAL TRANSCRIPT USAGE RULE:
    - You ALWAYS have access to the conversation transcript - the user's messages are provided to you
    - The user's question/message is in the transcript - read it and answer it directly
    - NEVER ask the user to "paste the exact sentence" or "paste the exact question" - you already have it in the transcript
    - NEVER say "What question are they asking?" or "can you paste the exact sentence they wrote?" - you have the user's message, use it
    - NEVER ask the user to provide information that is already in the conversation transcript
    - When the user asks a question, look at the LAST user message in the transcript and answer it directly
    - Example: If the transcript shows user said "explain each phrase in details also is high good or low", answer that question directly - don't ask them to paste it again`;
};
// ============================================================================
// HELPER FUNCTIONS FOR chatbotDiagnosticFreeform
// ============================================================================

/**
 * Validates the chatbot request input
 */
const validateChatbotRequest = (name, email) => {
  if (!email) {
    return { error: "Email is required", statusCode: 400 };
  }
  if (!name) {
    return { error: "Name is required", statusCode: 400 };
  }

  return { valid: true, email, name };
};

/**
 * Safely find Diagnostic without new columns that might not exist
 * Uses explicit attributes to avoid selecting columns that don't exist in database
 */
const safeFindDiagnostic = async (options = {}) => {
  // Always use explicit attributes to avoid chatId, pdfUrl, report column errors
  // These columns might not exist in the database yet (old flow compatibility)
  const safeOptions = {
    ...options,
    attributes: [
      "id",
      "userId",
      "email",
      "title",
      "data",
      "createdAt",
      "updatedAt",
    ],
  };

  try {
    return await Diagnostic.findOne(safeOptions);
  } catch (err) {
    // If still fails, try without attributes (fallback)
    if (err.message && err.message.includes("does not exist")) {
      return await Diagnostic.findOne(options);
    }
    throw err;
  }
};

/**
 * Loads diagnostic state and existing report for a user
 * Excludes new columns (chatId, pdfUrl, report) that might not exist yet in database
 * When a new diagnostic report is generated, it updates the existing diagnostic record,
 * so we need to find the diagnostic with the most recent report generation.
 * We check data.generatedAt (when report was generated) or updatedAt as fallback.
 */
const loadDiagnosticState = async (email) => {
  const { Chat } = require("../models/chatModel");
  const { User } = require("../models/userModel");

  // Find all diagnostics for this email to compare report generation dates
  const allDiagnostics = await Diagnostic.findAll({
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
    order: [["updatedAt", "DESC"]], // Start with most recently updated
  });

  // Get user to check for incomplete chats in Chat model
  const user = await User.findOne({ where: { email } });

  // PRIORITY 1: Check for incomplete chats in the Chat model first
  // This is where transcripts are actually stored (Diagnostic.intakeState.transcript is kept empty)
  if (user) {
    const incompleteChat = await Chat.findOne({
      where: {
        userId: user.id,
        isChatEnded: false,
      },
      order: [["updatedAt", "DESC"]],
    });

    if (incompleteChat && incompleteChat.data?.transcript?.length > 0) {
      const chatTranscript = incompleteChat.data.transcript;

      console.log(
        "[loadDiagnosticState] Found incomplete chat in Chat model:",
        {
          chatId: incompleteChat.id,
          transcriptLength: chatTranscript.length,
          chatType: incompleteChat.chatType,
        },
      );

      // Find the associated diagnostic (if any)
      let associatedDiagnostic = null;
      if (incompleteChat.dignosticId) {
        associatedDiagnostic = allDiagnostics.find(
          (d) => d.id === incompleteChat.dignosticId,
        );
      }
      if (!associatedDiagnostic && allDiagnostics.length > 0) {
        associatedDiagnostic = allDiagnostics[0];
      }

      // Build the intakeState with the transcript from Chat model
      const existingState = {
        ...(associatedDiagnostic?.data?.intakeState || {}),
        transcript: chatTranscript, // Use transcript from Chat model
      };

      const existingReport = associatedDiagnostic?.data?.aiReport;
      const diagnosticMetrics = associatedDiagnostic?.data?.metrics || {};

      return {
        existingDiagnostic: associatedDiagnostic,
        existingState,
        existingReport,
        diagnosticMetrics,
      };
    }
  }

  // PRIORITY 2: Check for incomplete chats in Diagnostic model (legacy support)
  let incompleteInDiagnostic = null;
  for (const diag of allDiagnostics) {
    const intakeState = diag.data?.intakeState || {};
    const transcript = intakeState?.transcript || [];
    const isCompleted = intakeState?.completedAt || intakeState?.finalizedAt;
    const hasReport = diag.data?.aiReport || diag.report;

    // Check if this is an incomplete chat (has transcript, not completed, no report yet)
    if (transcript.length > 0 && !isCompleted && !hasReport) {
      incompleteInDiagnostic = diag;
      console.log(
        "[loadDiagnosticState] Found incomplete chat in Diagnostic model with",
        transcript.length,
        "messages",
      );
      break;
    }
  }

  if (incompleteInDiagnostic) {
    const existingState = incompleteInDiagnostic?.data?.intakeState || {};
    const diagnosticMetrics = incompleteInDiagnostic?.data?.metrics || {};

    return {
      existingDiagnostic: incompleteInDiagnostic,
      existingState,
      existingReport: null,
      diagnosticMetrics,
    };
  }

  // PRIORITY 3: Find the diagnostic with the most recent report generation
  let existingDiagnostic = null;
  let mostRecentGeneratedAt = null;

  for (const diag of allDiagnostics) {
    const generatedAt = diag.data?.generatedAt;
    const hasReport = diag.data?.aiReport || diag.report;

    if (hasReport) {
      if (generatedAt) {
        const genDate = new Date(generatedAt);
        if (!mostRecentGeneratedAt || genDate > mostRecentGeneratedAt) {
          mostRecentGeneratedAt = genDate;
          existingDiagnostic = diag;
        }
      } else if (!existingDiagnostic) {
        existingDiagnostic = diag;
      }
    }
  }

  // If no diagnostic with report found, use the most recently updated one
  if (!existingDiagnostic && allDiagnostics.length > 0) {
    existingDiagnostic = allDiagnostics[0];
  }

  const existingState = existingDiagnostic?.data?.intakeState || {};
  const existingReport = existingDiagnostic?.data?.aiReport;
  const diagnosticMetrics = existingDiagnostic?.data?.metrics || {};

  return {
    existingDiagnostic,
    existingState,
    existingReport,
    diagnosticMetrics,
  };
};

/**
 * Calculate diagnostic confidence using the CANONICAL CONFIDENCE FORMULA
 *
 * Signature Confidence = (
 *   Behavioural_Evidence_Score × 0.35
 * + Loop_Convergence_Score     × 0.25
 * + Predictor_Accuracy_Score   × 0.20
 * + Recovery_Alignment_Score   × 0.10
 * + Contradiction_Penalty      × 0.10
 * ) × 100
 *
 * Target: ≥85 required to "lock" diagnosis
 *
 * @param {Array} transcript - The conversation transcript
 * @returns {Object} { confidence: number (0-100), reasoning: string, needsClarification: boolean, componentScores: Object }
 */
const calculateDiagnosticConfidence = async (transcript) => {
  if (!transcript || !Array.isArray(transcript)) {
    return {
      confidence: 0,
      reasoning: "No transcript provided",
      needsClarification: true,
      componentScores: {},
    };
  }

  // Count core questions (Q1-Q25) answered
  const coreQuestionsAnswered = transcript.filter(
    (m, i) =>
      m?.role === "assistant" &&
      /Q\d+/i.test(m.content || "") &&
      !/CB\d+/i.test(m.content || "") &&
      transcript[i + 1]?.role === "user",
  ).length;

  // Count clarifying questions (CB1-CB6) answered
  const clarifyingQuestionsAnswered = transcript.filter(
    (m, i) =>
      m?.role === "assistant" &&
      /CB\d+/i.test(m.content || "") &&
      transcript[i + 1]?.role === "user",
  ).length;

  const totalQuestionsAnswered =
    coreQuestionsAnswered + clarifyingQuestionsAnswered;

  console.log("[calculateDiagnosticConfidence] Question counts:", {
    coreQuestionsAnswered,
    clarifyingQuestionsAnswered,
    totalQuestionsAnswered,
  });

  // Base confidence gating: Need at least 25 core questions answered for a real calculation
  if (coreQuestionsAnswered < 25) {
    const baseConfidence = Math.min(70, (coreQuestionsAnswered / 25) * 70);
    return {
      confidence: Math.round(baseConfidence),
      reasoning: `Ongoing intake: ${coreQuestionsAnswered}/25 core questions answered.`,
      needsClarification: false, // Not in clarifying phase yet
      componentScores: {
        provisional: true,
        coreQuestionsAnswered,
        clarifyingQuestionsAnswered,
      },
    };
  }

  try {
    // Build transcript text with clear markers for clarifying questions
    const transcriptText = transcript
      .map((m) => {
        const prefix = m.role === "assistant" ? "AI" : "User";
        const isClarifying =
          m.role === "assistant" && /CB\d+/i.test(m.content || "");
        return `${prefix}${isClarifying ? " [CLARIFYING Q]" : ""}: ${m.content}`;
      })
      .join("\n")
      .substring(0, 12000); // Sufficient context for analysis

    const analysisPrompt = `You are a Diagnostic Confidence Analyzer for Euphoriam using the CANONICAL CONFIDENCE FORMULA.

IMPORTANT CONTEXT:
- Core questions answered: ${coreQuestionsAnswered}
- Clarifying questions answered: ${clarifyingQuestionsAnswered}
- Total evidence points: ${totalQuestionsAnswered}
${clarifyingQuestionsAnswered > 0 ? `- User has answered ${clarifyingQuestionsAnswered} clarifying questions which provide ADDITIONAL evidence beyond core intake.` : ""}

TRANSCRIPT:
---
${transcriptText}
---

Calculate each component score using EXACT criteria:

1️⃣ BEHAVIOURAL_EVIDENCE_SCORE (35% weight) - Score 0.0 to 1.0
Award 0.20 points for each axis with DIRECT behavioural proof:
□ EO (Emotional Origin: Not Enough/Not Worthy/Not Safe/Vulnerable Not OK) supported by behaviour
□ Lack Channel (Connection/Security/Purpose) supported by behaviour  
□ Avoidance Protector (Failure/Rejection) supported by behaviour
□ Trigger → Behaviour → Snapback cycle example clearly provided
□ Cross-domain repetition (same pattern appears in work, relationships, health, money)
Total possible: 1.0 (all 5 axes proven)

2️⃣ LOOP_CONVERGENCE_SCORE (25% weight) - Score 0.0 to 1.0
How cleanly does ONE orbit pattern explain the user's behaviour?
- 1.0: Single orbit fits ≥80% of examples (e.g., "Hide → Resent" explains nearly everything)
- 0.6: Two competing orbits visible
- 0.3: Fragmented / multiple unclear orbits

3️⃣ PREDICTOR_ACCURACY_SCORE (20% weight) - Score 0.0 to 1.0
How well do predictions match user's reality?
- 1.0: User explicitly confirms ≥2 predictions ("that's exactly me", "holy sh*t")
- 0.8: User implicitly matches predicted behaviour patterns
- 0.5: Mixed / partial match
- 0.2: Predictions missed
- 0.7: Provisional (predictions not yet tested - use this if clarifying phase just started)

4️⃣ RECOVERY_ALIGNMENT_SCORE (10% weight) - Score 0.0 to 1.0
Does recovery speed evidence match Consciousness Level (CL) estimate?
- 1.0: Recovery patterns match CL estimate perfectly
- 0.6: Slight mismatch (e.g., claims quick recovery but shows extended loops)
- 0.3: Major mismatch

5️⃣ CONTRADICTION_PENALTY (10% weight) - Score 0.0 to 1.0
Words vs behaviour alignment (PENALTY - lower = more contradiction):
- 1.0: Low contradiction (words match behaviour)
- 0.6: Medium contradiction
- 0.2: High contradiction (says one thing, does another)

${
  clarifyingQuestionsAnswered > 0
    ? `
CRITICAL: User has answered ${clarifyingQuestionsAnswered} CLARIFYING questions. These provide targeted evidence that should INCREASE scores in weak areas. Re-evaluate all scores accounting for this additional evidence.
`
    : ""
}

Return ONLY valid JSON:
{
  "behaviouralEvidenceScore": <0.0-1.0>,
  "behaviouralEvidenceBreakdown": {
    "eoSupported": <true/false>,
    "lackSupported": <true/false>,
    "avoidSupported": <true/false>,
    "triggerCycleShown": <true/false>,
    "crossDomainRepetition": <true/false>
  },
  "loopConvergenceScore": <0.0-1.0>,
  "predictorAccuracyScore": <0.0-1.0>,
  "recoveryAlignmentScore": <0.0-1.0>,
  "contradictionPenalty": <0.0-1.0>,
  "reasoning": "<2-3 sentences explaining the scores>",
  "suggestedFocus": "<if confidence < 85, what specific evidence is missing?>"
}`;

    const response = await openai.chat.completions.create({
      model: "gpt-5.2",
      messages: [
        {
          role: "system",
          content:
            "You are a diagnostic confidence analyzer. Calculate scores precisely using the provided criteria. Return only valid JSON. Be generous with scores when evidence is present - clarifying question answers count as strong evidence.",
        },
        {
          role: "user",
          content: analysisPrompt,
        },
      ],
      temperature: 1,
      max_completion_tokens: 500,
      response_format: { type: "json_object" },
    });

    const content = response.choices[0]?.message?.content?.trim();
    if (!content) throw new Error("Empty AI response");

    const parsed = JSON.parse(content);

    // Validate and clamp scores to 0-1 range
    const clamp = (val) => Math.max(0, Math.min(1, Number(val) || 0));

    const behaviouralEvidenceScore = clamp(parsed.behaviouralEvidenceScore);
    const loopConvergenceScore = clamp(parsed.loopConvergenceScore);
    const predictorAccuracyScore = clamp(parsed.predictorAccuracyScore);
    const recoveryAlignmentScore = clamp(parsed.recoveryAlignmentScore);
    const contradictionPenalty = clamp(parsed.contradictionPenalty);

    // Apply the CANONICAL CONFIDENCE FORMULA
    const confidence =
      (behaviouralEvidenceScore * 0.35 +
        loopConvergenceScore * 0.25 +
        predictorAccuracyScore * 0.2 +
        recoveryAlignmentScore * 0.1 +
        contradictionPenalty * 0.1) *
      100;

    const roundedConfidence = Math.round(confidence);

    console.log(
      "[calculateDiagnosticConfidence] Canonical formula calculation:",
      {
        behaviouralEvidenceScore,
        loopConvergenceScore,
        predictorAccuracyScore,
        recoveryAlignmentScore,
        contradictionPenalty,
        rawConfidence: confidence,
        roundedConfidence,
        formula: `(${behaviouralEvidenceScore}×0.35 + ${loopConvergenceScore}×0.25 + ${predictorAccuracyScore}×0.20 + ${recoveryAlignmentScore}×0.10 + ${contradictionPenalty}×0.10) × 100 = ${confidence}`,
        clarifyingQuestionsAnswered,
      },
    );

    return {
      confidence: roundedConfidence,
      reasoning:
        parsed.reasoning || "Confidence calculated using canonical formula.",
      needsClarification: roundedConfidence < 85,
      suggestedFocus: parsed.suggestedFocus,
      componentScores: {
        behaviouralEvidence: behaviouralEvidenceScore,
        loopConvergence: loopConvergenceScore,
        predictorAccuracy: predictorAccuracyScore,
        recoveryAlignment: recoveryAlignmentScore,
        contradictionPenalty: contradictionPenalty,
        breakdown: parsed.behaviouralEvidenceBreakdown,
      },
      questionsAnswered: {
        core: coreQuestionsAnswered,
        clarifying: clarifyingQuestionsAnswered,
        total: totalQuestionsAnswered,
      },
    };
  } catch (err) {
    console.error("[calculateDiagnosticConfidence] Calculation error:", err);

    // Fallback: estimate confidence based on question count
    // After 25 core + clarifiers, give baseline of 75 + (clarifiers * 2)
    const fallbackConfidence = Math.min(
      85,
      75 + clarifyingQuestionsAnswered * 2,
    );

    return {
      confidence: fallbackConfidence,
      reasoning: `Fallback calculation: ${coreQuestionsAnswered} core questions + ${clarifyingQuestionsAnswered} clarifying questions answered.`,
      needsClarification: fallbackConfidence < 85,
      componentScores: { error: err.message, fallback: true },
      questionsAnswered: {
        core: coreQuestionsAnswered,
        clarifying: clarifyingQuestionsAnswered,
        total: totalQuestionsAnswered,
      },
    };
  }
};

/**
 * Extracts metrics from report text
 */
const extractMetricsFromReport = (reportText) => {
  if (!reportText) return {};

  // FIRST: Try to extract from METRICS_JSON block (most reliable)
  const jsonBlockMatch = reportText.match(
    /METRICS_JSON_START\s*([\s\S]*?)\s*METRICS_JSON_END/i,
  );
  if (jsonBlockMatch) {
    try {
      // Clean the JSON string - remove any markdown formatting
      let jsonStr = jsonBlockMatch[1].trim();
      // Remove markdown code block markers if present
      jsonStr = jsonStr.replace(/^```json?\s*/i, "").replace(/\s*```$/i, "");
      // Parse the JSON
      const parsed = JSON.parse(jsonStr);
      console.log(
        "[extractMetricsFromReport] Successfully extracted from METRICS_JSON block:",
        parsed,
      );

      // Return the extracted metrics
      return {
        gravity:
          typeof parsed.gravity === "number" ? parsed.gravity : undefined,
        signalCoherence:
          typeof parsed.signalCoherence === "number"
            ? parsed.signalCoherence
            : undefined,
        signalOutput:
          typeof parsed.signalOutput === "number"
            ? parsed.signalOutput
            : undefined,
        consciousnessLevel:
          typeof parsed.consciousnessLevel === "number"
            ? parsed.consciousnessLevel
            : undefined,
        qgcActivation:
          typeof parsed.qgcActivation === "number"
            ? parsed.qgcActivation
            : undefined,
        signatureId: parsed.signatureId || undefined,
        emotionalOrigin: parsed.emotionalOrigin || undefined,
        lackChannel: parsed.lackChannel || undefined,
        avoidanceProtector: parsed.avoidanceProtector || undefined,
        orbitPattern: parsed.orbitPattern || undefined,
      };
    } catch (e) {
      console.warn(
        "[extractMetricsFromReport] Failed to parse METRICS_JSON block:",
        e.message,
      );
      // Fall through to other extraction methods
    }
  }

  // Helper: try to get Consciousness Level as a direct numeric value (e.g. "Consciousness Level: 3.2")
  const extractCLDirect = (text) => {
    const m =
      text &&
      text.match(
        /(?:Consciousness\s+Level|CL)[:\s]+(?:[█░\s]+)?([0-9]+(?:\.[0-9]+)?)/i,
      );
    if (m) {
      const val = parseFloat(m[1]);
      if (!Number.isNaN(val)) {
        console.log(
          `[extractMetricsFromReport] Extracted CL as direct number: ${val}`,
        );
        return val;
      }
    }
    return undefined;
  };

  // First, try to extract from METRICS GAUGE section specifically
  // Increase the match range to capture more of the section
  const metricsGaugeMatch = reportText.match(/METRICS\s+GAUGE[\s\S]{0,2000}/i);

  // If we have a METRICS GAUGE section, try to extract from it first with a simpler approach
  if (metricsGaugeMatch) {
    const gaugeText = metricsGaugeMatch[0];
    console.log(
      `[extractMetricsFromReport] Found METRICS GAUGE section, extracting with simple pattern`,
    );

    // Simple extraction: match "**Label:** progress_bar NUMBER%" and capture NUMBER (first one, before any ~ or arrows)
    // Format: **QGC Activation:** █████░░░░░░░ 46%  ~49%
    const simpleExtract = (label) => {
      // Match the label, progress bar, then capture the first number with %
      // Handle optional bolding and extra spaces
      const pattern = new RegExp(
        `(?:\\*\\*)?${label}[^:]*:?(?:\\*\\*)?\\s*[█░]*\\s*(\\d+(?:\\.\\d+)?)%`,
        "i",
      );
      const match = gaugeText.match(pattern);
      if (match) {
        console.log(
          `[extractMetricsFromReport] Simple extract for ${label}: ${match[1]} (from: "${match[0].substring(0, 80)}")`,
        );
        return parseFloat(match[1]);
      }
      return undefined;
    };

    const gravity = simpleExtract("Gravity");
    const signalCoherence = simpleExtract("Signal\\s+Coherence");
    const signalOutput = simpleExtract("Signal\\s+Output");
    const qgcActivation = simpleExtract("QGC\\s+Activation");

    // For Consciousness Level, try to extract from METRICS GAUGE as a percentage and convert to CL value
    let consciousnessLevel = simpleExtract("Consciousness\\s+Level");
    if (consciousnessLevel !== undefined && consciousnessLevel > 5) {
      consciousnessLevel = consciousnessLevel / 20; // Convert percentage to CL (CL = percentage / 20)
      console.log(
        `[extractMetricsFromReport] Converted CL from percentage to value: ${consciousnessLevel}`,
      );
    }

    // If CL isn't present in the METRICS GAUGE block, fall back to searching the whole report
    // for a direct numeric value like "Consciousness Level: 3.2"
    if (consciousnessLevel === undefined) {
      consciousnessLevel = extractCLDirect(reportText);
    }

    // If we extracted at least some metrics from METRICS GAUGE, return them
    if (
      gravity !== undefined ||
      signalCoherence !== undefined ||
      signalOutput !== undefined ||
      qgcActivation !== undefined ||
      consciousnessLevel !== undefined
    ) {
      const extracted = {
        gravity,
        signalCoherence,
        signalOutput,
        consciousnessLevel,
        qgcActivation,
      };
      const extractedCount = Object.values(extracted).filter(
        (v) => v !== undefined,
      ).length;
      console.log(
        `[extractMetricsFromReport] Extracted ${extractedCount}/5 metrics from METRICS GAUGE:`,
        extracted,
      );
      return extracted;
    }
  }

  // Fallback: use the more complex extraction for other report formats
  const searchText = metricsGaugeMatch ? metricsGaugeMatch[0] : reportText;
  console.log(`[extractMetricsFromReport] Falling back to complex extraction`);

  // Helper function to extract metric value, handling progress bars
  // Matches patterns like:
  // - "Gravity: 95%"
  // - "Gravity: █████████░░░ 74%"
  // - "Gravity (Load):      █████████░░░ 74%"
  // - "**Gravity** 95%"
  // - "**Gravity:** ██████████░░ 82%  ↑" (ignore comparison values after ~ or arrows)
  const extractMetric = (label, patterns, isPercentage = true) => {
    for (const pattern of patterns) {
      // Pattern 1: Markdown bold format with progress bar - get FIRST number (before ~ or arrow)
      // Matches: **QGC Activation:** █████░░░░░░░ 46%  ~49%
      // Must stop at ~, ↑, ↓, or end of line to avoid matching comparison values
      // Use a more specific pattern that captures the number immediately after progress bar
      const match1 = searchText.match(
        new RegExp(
          `\\*\\*${pattern}\\*\\*[:\\s]*[█░]+\\s+(\\d+(?:\\.\\d+)?)${
            isPercentage ? "%" : ""
          }(?=\\s+[~↑↓]|\\s+\\d|\\s*\\n|\\s*$|\\s*\\*|\\s*-|\\s*##|\\s*FRICTION)`,
          "i",
        ),
      );
      if (match1) {
        const value = parseFloat(match1[1]);
        console.log(
          `[extractMetric] Pattern 1 matched for ${label}: ${value} (from: "${match1[0]}")`,
        );
        return value;
      }

      // Pattern 2: Markdown bold format without progress bar
      const match2 = searchText.match(
        new RegExp(
          `\\*\\*${pattern}\\*\\*[:\\s]+(\\d+(?:\\.\\d+)?)${
            isPercentage ? "%" : ""
          }(?=\\s*[~↑↓]|\\s*\\n|\\s*$|\\s*\\*|\\s*-)`,
          "i",
        ),
      );
      if (match2) {
        const value = parseFloat(match2[1]);
        console.log(
          `[extractMetric] Pattern 2 matched for ${label}: ${value} (from: ${match2[0]})`,
        );
        return value;
      }

      // Pattern 3: Direct match with progress bar - get FIRST number
      const match3 = searchText.match(
        new RegExp(
          `${pattern}[:\\s]+[█░]+\\s+(\\d+(?:\\.\\d+)?)${
            isPercentage ? "%" : ""
          }(?=\\s+[~↑↓]|\\s+\\d|\\s*\\n|\\s*$|\\s*\\*|\\s*-)`,
          "i",
        ),
      );
      if (match3) {
        const value = parseFloat(match3[1]);
        console.log(
          `[extractMetric] Pattern 3 matched for ${label}: ${value} (from: "${match3[0]}")`,
        );
        return value;
      }

      // Pattern 4: Direct match without progress bar
      const match4 = searchText.match(
        new RegExp(
          `${pattern}[:\\s]+(\\d+(?:\\.\\d+)?)${
            isPercentage ? "%" : ""
          }(?=\\s*[~↑↓]|\\s*\\n|\\s*$|\\s*\\*|\\s*-)`,
          "i",
        ),
      );
      if (match4) {
        const value = parseFloat(match4[1]);
        console.log(
          `[extractMetric] Pattern 4 matched for ${label}: ${value} (from: ${match4[0]})`,
        );
        return value;
      }
    }

    // FALLBACK: Count progress bar blocks if no numeric value found
    for (const pattern of patterns) {
      // Look for the label followed by a block of █ or ░ characters
      // Match at least 5 blocks to avoid false positives
      const blockRegex = new RegExp(`${pattern}[^█░\\n]*([█░]{5,15})`, "i");
      const blockMatch = searchText.match(blockRegex);
      if (blockMatch) {
        const blocks = blockMatch[1];
        const filled = (blocks.match(/█/g) || []).length;
        const total = blocks.length;
        const value = Math.round((filled / total) * 100);
        console.log(
          `[extractMetric] Block count fallback matched for ${label}: ${value} (${filled}/${total} blocks)`,
        );
        // For Consciousness Level, map 10 blocks (0-100%) back to 1-5 scale
        if (!isPercentage) {
          return 1 + (filled / total) * 4;
        }
        return value;
      }
    }

    console.log(`[extractMetric] No match found for ${label}`);
    return undefined;
  };

  // Extract each metric with multiple pattern variations
  const gravity = extractMetric(
    "Gravity",
    ["Gravity\\s*\\(Load\\)", "Gravity"],
    true,
  );

  const signalCoherence = extractMetric(
    "Signal\\s+Coherence",
    ["Signal\\s+Coherence"],
    true,
  );

  const signalOutput = extractMetric(
    "Signal\\s+Output",
    ["Signal\\s+Output"],
    true,
  );

  // For Consciousness Level, the gauge shows it as a percentage: (CL/5)*100
  // So if we see "48%", that means CL = 2.4 (48/20)
  // Extract the percentage first, then convert to CL value
  let consciousnessLevel = extractMetric(
    "Consciousness\\s+Level",
    ["Consciousness\\s+Level"],
    true, // Extract as percentage first
  );

  // If we got a percentage value (> 5), convert it back to CL value (CL = percentage / 20)
  if (consciousnessLevel !== undefined && consciousnessLevel > 5) {
    // It's a percentage, convert to CL: CL = percentage / 20
    consciousnessLevel = consciousnessLevel / 20;
    console.log(
      `[extractMetricsFromReport] Converted CL percentage to value: ${consciousnessLevel}`,
    );
  }

  // If still not found, try extracting as a direct number (not percentage)
  if (consciousnessLevel === undefined) {
    consciousnessLevel = extractCLDirect(searchText);
  }

  const qgcActivation = extractMetric(
    "QGC",
    ["QGC\\s+Activation", "QGC", "Quantum\\s+Genius\\s+Codes"],
    true,
  );

  const extracted = {
    gravity,
    signalCoherence,
    signalOutput,
    consciousnessLevel,
    qgcActivation,
  };

  // Log extraction results for debugging
  const extractedCount = Object.values(extracted).filter(
    (v) => v !== undefined,
  ).length;
  if (extractedCount > 0) {
    console.log(
      `[extractMetricsFromReport] Extracted ${extractedCount}/5 metrics:`,
      extracted,
    );
  } else {
    // Try to find METRICS GAUGE section in report
    if (metricsGaugeMatch) {
      console.log(
        "[extractMetricsFromReport] Found METRICS GAUGE section but no metrics extracted. Section preview:",
        metricsGaugeMatch[0].substring(0, 500),
      );
    } else {
      console.log(
        "[extractMetricsFromReport] No METRICS GAUGE section found. Report preview:",
        reportText.substring(0, 1000),
      );
    }
  }

  return extracted;
};

/**
 * Get latest user session for a user (by userId or email)
 */
const getLatestUserSession = async (userId, email) => {
  try {
    let whereClause = {};
    if (userId) {
      whereClause.userId = userId;
    } else if (email) {
      whereClause.email = email;
    } else {
      return null;
    }

    const session = await UserSession.findOne({
      where: whereClause,
      order: [
        ["sessionDate", "DESC"],
        ["createdAt", "DESC"],
      ],
    });

    return session;
  } catch (error) {
    console.error("[getLatestUserSession] Error:", error);
    return null;
  }
};

/**
 * Get all user sessions for a user (by userId or email)
 * Returns all sessions ordered by date (newest first)
 */
const getAllUserSessions = async (userId, email) => {
  try {
    let whereClause = {};
    if (userId) {
      whereClause.userId = userId;
    } else if (email) {
      whereClause.email = email;
    } else {
      return [];
    }

    const sessions = await UserSession.findAll({
      where: whereClause,
      order: [
        ["sessionDate", "DESC"],
        ["createdAt", "DESC"],
      ],
    });

    return sessions || [];
  } catch (error) {
    console.error("[getAllUserSessions] Error:", error);
    return [];
  }
};

/**
 * Loads latest discovery metrics and report
 * Priority: 1) User session (if available), 2) Old discovery report metrics, 3) Last diagnostic report metrics
 */
const loadLatestDiscoveryMetrics = async (
  existingDiagnostic,
  diagnosticMetrics,
) => {
  let latestDiscovery = null;
  let latestDiscoveryReport = null;
  let latestDiscoveryMetrics = {};
  let latestUserSession = null;
  let allUserSessions = [];

  // First, try to get all user sessions (highest priority for discovery)
  if (existingDiagnostic?.userId || existingDiagnostic?.email) {
    allUserSessions = await getAllUserSessions(
      existingDiagnostic?.userId,
      existingDiagnostic?.email,
    );

    // Also get latest session for backward compatibility
    latestUserSession = allUserSessions.length > 0 ? allUserSessions[0] : null;

    if (allUserSessions.length > 0) {
      console.log("[loadLatestDiscoveryMetrics] Found user sessions:", {
        totalSessions: allUserSessions.length,
        latestSessionId: latestUserSession?.id,
        latestSessionDate: latestUserSession?.sessionDate,
        sessionsWithSummaries: allUserSessions.filter((s) => s.summery).length,
      });
    }
  }

  // Then, try to get metrics from old discovery report (if exists)
  if (existingDiagnostic?.userId) {
    const discoveries = await Discovery.findAll({
      where: { userId: existingDiagnostic.userId },
      order: [["createdAt", "DESC"]],
      limit: 1,
    });
    latestDiscovery = discoveries[0] || null;

    if (latestDiscovery) {
      latestDiscoveryReport =
        latestDiscovery.data?.newReport ||
        latestDiscovery.data?.previousReport ||
        latestDiscovery.data?.newReportSnippet ||
        null;

      if (latestDiscoveryReport) {
        // Extract metrics from discovery report
        const extractedMetrics = extractMetricsFromReport(
          latestDiscoveryReport,
        );
        if (
          Object.keys(extractedMetrics).some(
            (key) => extractedMetrics[key] !== undefined,
          )
        ) {
          latestDiscoveryMetrics = extractedMetrics;
          console.log(
            "[loadLatestDiscoveryMetrics] Using metrics from old discovery report:",
            extractedMetrics,
          );
        }
      }
    }
  }

  // Always try to extract from diagnostic report to compare dates
  let diagnosticReportMetrics = {};
  let diagnosticReportDate = null;
  if (existingDiagnostic?.data?.aiReport) {
    const diagnosticReport = existingDiagnostic.data.aiReport;
    diagnosticReportMetrics = extractMetricsFromReport(diagnosticReport);
    // Get diagnostic report date (use data.generatedAt if available, which represents
    // when the actual diagnostic report was generated. Fallback to updatedAt or createdAt)
    diagnosticReportDate = existingDiagnostic.data?.generatedAt
      ? new Date(existingDiagnostic.data.generatedAt)
      : existingDiagnostic.updatedAt || existingDiagnostic.createdAt;
    console.log(
      "[loadLatestDiscoveryMetrics] Extracted metrics from diagnostic report:",
      diagnosticReportMetrics,
      {
        date: diagnosticReportDate,
        generatedAt: existingDiagnostic.data?.generatedAt,
        createdAt: existingDiagnostic.createdAt,
        updatedAt: existingDiagnostic.updatedAt,
      },
    );
  }

  // Check if we have valid discovery metrics
  const hasDiscoveryMetrics =
    latestDiscoveryMetrics &&
    Object.keys(latestDiscoveryMetrics).length > 0 &&
    (latestDiscoveryMetrics.gravity !== undefined ||
      latestDiscoveryMetrics.signalCoherence !== undefined ||
      latestDiscoveryMetrics.signalOutput !== undefined);

  // Check if we have valid diagnostic metrics
  const hasDiagnosticMetrics =
    diagnosticReportMetrics &&
    Object.keys(diagnosticReportMetrics).length > 0 &&
    (diagnosticReportMetrics.gravity !== undefined ||
      diagnosticReportMetrics.signalCoherence !== undefined ||
      diagnosticReportMetrics.signalOutput !== undefined);

  // Determine which report is more recent
  const discoveryReportDate =
    latestDiscovery?.updatedAt || latestDiscovery?.createdAt;

  // Decide which metrics to use based on date comparison
  if (
    hasDiscoveryMetrics &&
    hasDiagnosticMetrics &&
    discoveryReportDate &&
    diagnosticReportDate
  ) {
    // Both reports exist - use the more recent one
    const discoveryDate = new Date(discoveryReportDate);
    const diagnosticDate = new Date(diagnosticReportDate);

    if (discoveryDate > diagnosticDate) {
      // Discovery is more recent - use discovery metrics, but merge if incomplete
      const discoveryMetricCount = Object.keys(latestDiscoveryMetrics).filter(
        (key) =>
          latestDiscoveryMetrics[key] !== undefined &&
          latestDiscoveryMetrics[key] !== null,
      ).length;
      const diagnosticMetricCount = Object.keys(diagnosticReportMetrics).filter(
        (key) =>
          diagnosticReportMetrics[key] !== undefined &&
          diagnosticReportMetrics[key] !== null,
      ).length;

      if (
        discoveryMetricCount < 3 &&
        diagnosticMetricCount > discoveryMetricCount
      ) {
        // Merge: use diagnostic as base, discovery takes precedence for values it has
        latestDiscoveryMetrics = {
          ...diagnosticReportMetrics,
          ...latestDiscoveryMetrics, // Discovery metrics take precedence
        };
        console.log(
          "[loadLatestDiscoveryMetrics] Merged incomplete discovery metrics (more recent) with diagnostic metrics:",
          latestDiscoveryMetrics,
          {
            discoveryDate: discoveryReportDate,
            diagnosticDate: diagnosticReportDate,
            discoveryCount: discoveryMetricCount,
            diagnosticCount: diagnosticMetricCount,
          },
        );
      } else {
        console.log(
          "[loadLatestDiscoveryMetrics] Using metrics from discovery report (more recent):",
          latestDiscoveryMetrics,
          {
            discoveryDate: discoveryReportDate,
            diagnosticDate: diagnosticReportDate,
          },
        );
      }
      // latestDiscoveryMetrics already set above (or merged), keep it
    } else {
      // Diagnostic is more recent - use diagnostic metrics
      latestDiscoveryMetrics = diagnosticReportMetrics;
      console.log(
        "[loadLatestDiscoveryMetrics] Using metrics from diagnostic report (more recent):",
        diagnosticReportMetrics,
        {
          diagnosticDate: diagnosticReportDate,
          discoveryDate: discoveryReportDate,
        },
      );
    }
  } else if (hasDiscoveryMetrics) {
    // Only discovery metrics available, but check if it's complete
    // Count how many metrics are present
    const discoveryMetricCount = Object.keys(latestDiscoveryMetrics).filter(
      (key) =>
        latestDiscoveryMetrics[key] !== undefined &&
        latestDiscoveryMetrics[key] !== null,
    ).length;
    const diagnosticMetricCount = Object.keys(diagnosticReportMetrics).filter(
      (key) =>
        diagnosticReportMetrics[key] !== undefined &&
        diagnosticReportMetrics[key] !== null,
    ).length;

    // If discovery metrics are incomplete (less than 3 metrics) and diagnostic has more complete metrics, merge them
    if (
      discoveryMetricCount < 3 &&
      diagnosticMetricCount > discoveryMetricCount
    ) {
      // Merge: use discovery metrics as base, fill missing from diagnostic
      latestDiscoveryMetrics = {
        ...diagnosticReportMetrics,
        ...latestDiscoveryMetrics, // Discovery metrics take precedence for values they have
      };
      console.log(
        "[loadLatestDiscoveryMetrics] Merged incomplete discovery metrics with diagnostic metrics:",
        latestDiscoveryMetrics,
      );
    } else {
      console.log(
        "[loadLatestDiscoveryMetrics] Using metrics from discovery report (only discovery available):",
        latestDiscoveryMetrics,
      );
    }
  } else if (hasDiagnosticMetrics) {
    // Only diagnostic metrics available (or discovery doesn't have valid metrics)
    latestDiscoveryMetrics = diagnosticReportMetrics;
    console.log(
      "[loadLatestDiscoveryMetrics] Using metrics from diagnostic report:",
      diagnosticReportMetrics,
    );
  } else if (diagnosticMetrics && Object.keys(diagnosticMetrics).length > 0) {
    // Fallback to stored diagnostic metrics if extraction failed
    latestDiscoveryMetrics = diagnosticMetrics;
    console.log(
      "[loadLatestDiscoveryMetrics] Using stored diagnostic metrics (extraction failed):",
      diagnosticMetrics,
    );
  } else {
    console.log(
      "[loadLatestDiscoveryMetrics] No valid metrics found from any source",
    );
  }

  return {
    latestDiscovery,
    latestDiscoveryReport,
    latestDiscoveryMetrics,
    latestUserSession, // Include latest user session for backward compatibility
    allUserSessions, // Include all user sessions for discovery chat/reports
  };
};

/**
 * Extracts report date from discovery or diagnostic with UTC date and time
 */
const extractReportDate = (latestDiscovery, existingDiagnostic) => {
  let dateObj = null;

  if (latestDiscovery?.createdAt) {
    dateObj = new Date(latestDiscovery.createdAt);
  } else if (existingDiagnostic?.data?.generatedAt) {
    dateObj = new Date(existingDiagnostic.data.generatedAt);
  } else if (existingDiagnostic?.updatedAt) {
    dateObj = new Date(existingDiagnostic.updatedAt);
  }

  if (dateObj) {
    // Format as "Jan 10, 2024 14:30 UTC"
    const month = dateObj.toLocaleString("en-US", {
      month: "short",
      timeZone: "UTC",
    });
    const day = dateObj.getUTCDate();
    const year = dateObj.getUTCFullYear();
    const hours = String(dateObj.getUTCHours()).padStart(2, "0");
    const minutes = String(dateObj.getUTCMinutes()).padStart(2, "0");
    return `${month} ${day}, ${year} ${hours}:${minutes} UTC`;
  }

  return null;
};

/**
 * Prepares previous reports array for diagnostic payload
 */
const preparePreviousReports = (existingDiagnostic, existingReport) => {
  const existingPreviousReports = Array.isArray(
    existingDiagnostic?.data?.previousReports,
  )
    ? existingDiagnostic.data.previousReports
    : [];

  const previousReportEntry =
    existingReport &&
    !existingPreviousReports.some(
      (pr) => pr?.aiReport && pr.aiReport === existingReport,
    )
      ? {
          aiReport: existingReport,
          savedAt:
            existingDiagnostic?.data?.intakeState?.finalizedAt ||
            existingDiagnostic?.updatedAt ||
            new Date().toISOString(),
          pdfUrl: existingDiagnostic?.data?.pdf?.url || null,
        }
      : null;

  return previousReportEntry
    ? [...existingPreviousReports, previousReportEntry]
    : existingPreviousReports;
};

/**
 * Determines if user wants a new diagnostic
 * Uses LLM to understand context instead of regex patterns
 */
const checkWantsNewDiagnostic = async (transcript, existingState) => {
  const lastUserMessage =
    transcript.filter((m) => m?.role === "user").slice(-1)[0]?.content || "";

  const previouslyRequestedNewDiagnostic =
    existingState.requestingNewDiagnostic === true;
  const intakeInProgress =
    existingState.answeredCount > 0 && existingState.answeredCount < 12;

  // If there are no user messages yet (first interaction), don't use the persisted flag
  // This allows showing existing report first on first interaction
  const hasUserMessages = transcript.some((m) => m?.role === "user");
  const shouldUsePersistedFlag = hasUserMessages || intakeInProgress;

  // Use LLM to detect if user wants a new diagnostic (only if there's a user message)
  let wantsNewDiagnosticInMessage = false;
  if (lastUserMessage) {
    const { detectUserWantsNewDiagnostic } = require("../utils/validation");
    wantsNewDiagnosticInMessage = await detectUserWantsNewDiagnostic({
      userMessage: lastUserMessage,
      transcript: transcript,
    });
  }

  return {
    wantsNewDiagnostic:
      wantsNewDiagnosticInMessage ||
      (shouldUsePersistedFlag && previouslyRequestedNewDiagnostic),
    intakeInProgress,
  };
};

/**
 * Checks if user is requesting to email the report
 */
const checkWantsEmail = (transcript, lastUserMessage = null) => {
  const message =
    lastUserMessage ||
    transcript.filter((m) => m?.role === "user").slice(-1)[0]?.content ||
    "";
  const lowerMessage = message.toLowerCase();

  // More comprehensive email detection patterns
  const wantsEmail =
    /(email|send.*email|email.*me|email.*report|send.*report|email.*it|send.*it|email.*the.*report|send.*the.*report)/i.test(
      lowerMessage,
    ) && !/(don't|dont|no|not|can't|cannot).*(email|send)/i.test(lowerMessage);

  return wantsEmail;
};

/**
 * Determines chat mode (discovery vs diagnostic)
 */
const determineChatMode = (
  hasExistingReport,
  wantsNewDiagnostic,
  intakeInProgress,
) => {
  return hasExistingReport && !wantsNewDiagnostic && !intakeInProgress;
};

/**
 * Prepares transcript for chat
 */
const prepareTranscript = (
  messages,
  existingState,
  hasExistingReport,
  wantsNewDiagnostic,
) => {
  // For diagnostic mode: use existing transcript if no new messages and no report exists
  const useExistingDiagnosticTranscript =
    !hasExistingReport &&
    Array.isArray(existingState.transcript) &&
    existingState.transcript.length;

  // For discovery mode: use existing transcript if it's a discovery conversation
  const useExistingDiscoveryTranscript =
    hasExistingReport &&
    existingState.mode === "discovery" &&
    Array.isArray(existingState.transcript) &&
    existingState.transcript.length;

  const useExistingTranscript =
    useExistingDiagnosticTranscript || useExistingDiscoveryTranscript;

  const baseTranscript =
    Array.isArray(messages) && messages.length
      ? messages
      : useExistingTranscript
        ? existingState.transcript
        : [];

  // If user wants new diagnostic, clear transcript
  const transcript = wantsNewDiagnostic ? [] : baseTranscript;

  return transcript;
};

/**
 * Extracts "Q<number>" from an assistant message to track distinct intake topics.
 */
const extractQuestionNumber = (text = "") => {
  const match = (text || "").match(/Q\s*(\d{1,2})/i);
  return match ? Number(match[1]) : null;
};

/**
 * Tracks question numbers from transcript
 */
const trackQuestionNumbers = (transcript) => {
  const assistantQuestionNumbers = transcript
    .filter((m) => m?.role === "assistant")
    .map((m) => extractQuestionNumber(m.content))
    .filter((n) => typeof n === "number");

  const distinctQuestionNumbers = [...new Set(assistantQuestionNumbers)].sort(
    (a, b) => a - b,
  );
  const maxQuestionNumber =
    distinctQuestionNumbers.length > 0
      ? Math.max(...distinctQuestionNumbers)
      : 0;

  return {
    distinctQuestionNumbers,
    maxQuestionNumber,
    distinctQuestionsAnswered: distinctQuestionNumbers.length,
  };
};
// Lightweight AI check to decide if a user reply is an answer to the last question.
const isAiLikelyAnswer = async ({ question, reply }) => {
  const t = (reply || "").trim().toLowerCase();
  if (!t) return false;
  if (isQuestion(t)) return false;
  // Hard fail on clarify/intents - but only if they indicate asking for clarification
  // Short answers like "not sure" alone should still be accepted
  const clarifyPhrases = [
    "elaborate",
    "clarify",
    "explain more",
    "repeat the question",
    "don't understand",
    "do not understand",
    "what do you mean",
    "can you rephrase",
    "could you rephrase",
  ];
  // Only reject if the response contains clarification requests AND is longer than 2 words
  // Short answers like "not sure" or single-word answers should pass through
  const replyWordCount = t.split(/\s+/).filter((w) => w.length > 0).length;
  if (replyWordCount > 2 && clarifyPhrases.some((p) => t.includes(p)))
    return false;
  // Reject if response ends with question mark (user is asking a question)
  if (t.endsWith("?")) return false;

  // Heuristic: Recognize common simple answers immediately
  const normalizedReply = t.trim();
  const simpleAnswers = [
    "yes",
    "no",
    "y",
    "n",
    "yeah",
    "yep",
    "nope",
    "nah",
    // Common short answers to behavioral questions
    "nothing",
    "none",
    "everything",
    "all",
    "both",
    "neither",
    "always",
    "never",
    "sometimes",
    "often",
    "rarely",
    "maybe",
    "idk",
    "i don't know",
    "unsure",
    "depends",
    // Common emotional/state answers
    "fine",
    "good",
    "bad",
    "okay",
    "ok",
    "great",
    "terrible",
    "awful",
    "happy",
    "sad",
    "angry",
    "anxious",
    "stressed",
    "calm",
    "tired",
  ];
  if (simpleAnswers.includes(normalizedReply)) {
    return true; // Accept simple answers immediately
  }

  // Single letter answers (A, B, C, etc.) - only accept if question has multiple choice options
  const singleLetterAnswers = ["a", "b", "c", "d", "e", "f"];
  if (singleLetterAnswers.includes(normalizedReply)) {
    // Check if the question contains multiple choice indicators
    const questionText = (question || "").toLowerCase();
    const hasMultipleChoice =
      /\([a-f]\)/i.test(question) || // (A), (B), (C)
      /^[a-f]\)/i.test(question) || // A), B), C) at start of line
      /\*\*[a-f]\)/i.test(question) || // **A), **B), **C)
      /\[a-f\]/i.test(question) || // [A], [B], [C]
      /pick\s+[a-f]/i.test(question) || // "pick A", "pick B"
      /choose\s+[a-f]/i.test(question) || // "choose A", "choose B"
      /reply\s+with\s+[a-f]/i.test(question) || // "reply with A"
      /option\s+[a-f]/i.test(question); // "option A"

    if (hasMultipleChoice) {
      return true; // Accept single letter only if question has multiple choice options
    }
    // If no multiple choice detected, don't accept single letter - let AI classifier decide
  }

  // Single number answers (1, 2, 3, etc.) - only accept if question has numbered options
  const singleNumberAnswers = ["1", "2", "3", "4", "5", "6"];
  if (singleNumberAnswers.includes(normalizedReply)) {
    const questionText = (question || "").toLowerCase();
    const hasNumberedOptions =
      /\([1-6]\)/i.test(question) || // (1), (2), (3)
      /^[1-6]\)/i.test(question) || // 1), 2), 3) at start of line
      /\*\*[1-6]\)/i.test(question) || // **1), **2), **3)
      /\[1-6\]/i.test(question) || // [1], [2], [3]
      /option\s+[1-6]/i.test(question); // "option 1"

    if (hasNumberedOptions) {
      return true; // Accept single number only if question has numbered options
    }
    // If no numbered options detected, don't accept single number - let AI classifier decide
  }

  // Check for "move on", "next", "skip" type responses that indicate user wants to proceed
  const moveOnPhrases = [
    "move on",
    "next question",
    "next",
    "skip",
    "move to next",
    "continue",
    "proceed",
    "go to next",
  ];
  if (moveOnPhrases.some((p) => normalizedReply.includes(p))) {
    return true; // Accept move-on requests as answers
  }

  // Heuristic: Recognize common single-word location/state answers
  const singleWordAnswers = [
    "alone",
    "together",
    "home",
    "work",
    "bed",
    "couch",
    "chair",
    "desk",
    "balcony",
    "outside",
    "library",
    "park",
    "car",
    "office",
    "calm",
    "relaxed",
    "interrupted",
    "available",
    "free",
    "busy",
    "watched",
    "on-call",
  ];
  if (singleWordAnswers.includes(normalizedReply)) {
    return true; // Accept single-word descriptive answers immediately
  }

  // Heuristic: Recognize common descriptive answers (2-4 words that are likely answers)
  // These are short, descriptive responses that answer location/state questions
  const descriptiveAnswerPatterns = [
    /^(completely|fully|totally|mostly|usually|always|never|sometimes)\s+(alone|interrupted|available|on-call|watched|free|busy|calm|relaxed)/i,
    /^(at|in|on|by|near)\s+(home|work|bed|couch|chair|desk|balcony|outside|library|park|car|office)/i,
    /^(alone|together|with\s+people|by\s+myself|with\s+family|with\s+friends)/i,
    /^(yes|no|maybe|sometimes|often|rarely|never|always)\s+(alone|interrupted|available)/i,
  ];
  if (descriptiveAnswerPatterns.some((pattern) => pattern.test(reply))) {
    return true; // Accept descriptive answers immediately
  }

  // Heuristic: Short answers (2-4 words) that don't contain question words are likely answers
  const words = normalizedReply.split(/\s+/).filter((w) => w.length > 0);
  if (words.length >= 2 && words.length <= 4) {
    const questionWords = [
      "what",
      "where",
      "when",
      "why",
      "how",
      "who",
      "which",
      "can",
      "could",
      "would",
      "should",
      "is",
      "are",
      "do",
      "does",
      "did",
    ];
    const hasQuestionWord = words.some((w) => questionWords.includes(w));
    if (!hasQuestionWord && !normalizedReply.includes("?")) {
      // Likely a descriptive answer - pass to AI classifier but be more lenient
      // This will be handled by the AI classifier below
    }
  }

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
      model: "gpt-4o",
      messages: [{ role: "user", content: prompt }],
      temperature: 0,
      max_completion_tokens: 20,
    });
    const txt = (resp?.choices?.[0]?.message?.content || "").toLowerCase();
    return txt.includes("yes");
  } catch (err) {
    console.error("[isAiLikelyAnswer] fallback to heuristic", err);
    // Fallback: If AI fails, use heuristic for simple answers
    const normalizedReply = t.trim();
    const simpleAnswers = ["yes", "no", "y", "n", "yeah", "yep", "nope", "nah"];
    if (simpleAnswers.includes(normalizedReply)) {
      return true;
    }

    // Single letter answers - only accept if question has multiple choice
    const singleLetterAnswers = ["a", "b", "c", "d", "e", "f"];
    if (singleLetterAnswers.includes(normalizedReply)) {
      const questionText = (question || "").toLowerCase();
      const hasMultipleChoice =
        /\([a-f]\)/i.test(question) ||
        /^[a-f]\)/i.test(question) ||
        /\*\*[a-f]\)/i.test(question) ||
        /\[a-f\]/i.test(question) ||
        /pick\s+[a-f]/i.test(question) ||
        /choose\s+[a-f]/i.test(question) ||
        /reply\s+with\s+[a-f]/i.test(question) ||
        /option\s+[a-f]/i.test(question);
      if (hasMultipleChoice) {
        return true;
      }
    }

    // Single number answers - only accept if question has numbered options
    const singleNumberAnswers = ["1", "2", "3", "4", "5", "6"];
    if (singleNumberAnswers.includes(normalizedReply)) {
      const questionText = (question || "").toLowerCase();
      const hasNumberedOptions =
        /\([1-6]\)/i.test(question) ||
        /^[1-6]\)/i.test(question) ||
        /\*\*[1-6]\)/i.test(question) ||
        /\[1-6\]/i.test(question) ||
        /option\s+[1-6]/i.test(question);
      if (hasNumberedOptions) {
        return true;
      }
    }
    const moveOnPhrases = [
      "move on",
      "next question",
      "next",
      "skip",
      "move to next",
      "continue",
      "proceed",
      "go to next",
    ];
    if (moveOnPhrases.some((p) => normalizedReply.includes(p))) {
      return true;
    }
    // Fallback: Check for single-word location/state answers
    const singleWordAnswers = [
      "alone",
      "together",
      "home",
      "work",
      "bed",
      "couch",
      "chair",
      "desk",
      "balcony",
      "outside",
      "library",
      "park",
      "car",
      "office",
      "calm",
      "relaxed",
      "interrupted",
      "available",
      "free",
      "busy",
      "watched",
      "on-call",
    ];
    if (singleWordAnswers.includes(normalizedReply)) {
      return true;
    }
    // Fallback: Check for descriptive answers
    const descriptiveAnswerPatterns = [
      /^(completely|fully|totally|mostly|usually|always|never|sometimes)\s+(alone|interrupted|available|on-call|watched|free|busy|calm|relaxed)/i,
      /^(at|in|on|by|near)\s+(home|work|bed|couch|chair|desk|balcony|outside|library|park|car|office)/i,
      /^(alone|together|with\s+people|by\s+myself|with\s+family|with\s+friends)/i,
    ];
    if (descriptiveAnswerPatterns.some((pattern) => pattern.test(reply))) {
      return true;
    }
    // Fallback: Short answers (2-4 words) without question words are likely answers
    const words = normalizedReply.split(/\s+/).filter((w) => w.length > 0);
    if (words.length >= 2 && words.length <= 4) {
      const questionWords = [
        "what",
        "where",
        "when",
        "why",
        "how",
        "who",
        "which",
        "can",
        "could",
        "would",
        "should",
        "is",
        "are",
        "do",
        "does",
        "did",
      ];
      const hasQuestionWord = words.some((w) => questionWords.includes(w));
      if (!hasQuestionWord && !normalizedReply.includes("?")) {
        // Likely a descriptive answer - accept it
        return true;
      }
    }
    return false;
  }
};
/**
 * Builds prompts for chat (system and user prompts)
 */
const buildChatPrompts = async ({
  isDiscoveryMode,
  transcript,
  targetCount,
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
  latestUserSession, // Latest 1:1 coaching session (for backward compatibility)
  allUserSessions = null, // All 1:1 coaching sessions (preferred)
  aiAnswered, // Passed from controller to avoid redundant LLM calls
  confidenceResult = null, // Added to pass confidence to intake prompt
}) => {
  let userPrompt;
  let systemPrompt;
  const lastUserMessage = (
    transcript.filter((m) => m.role === "user").slice(-1)[0]?.content || ""
  ).toLowerCase();
  const sessionsToCheck =
    allUserSessions && allUserSessions.length > 0
      ? allUserSessions
      : latestUserSession
        ? [latestUserSession]
        : [];
  const isAskingAboutSession =
    sessionsToCheck.length > 0 &&
    /session|1:1|coaching.*session|session.*details|summarize.*session/i.test(
      lastUserMessage,
    );

  if (isDiscoveryMode) {
    systemPrompt = getDiscoverySystemPrompt(
      latestUserSession,
      isAskingAboutSession,
      allUserSessions,
    ); // Pass user session and session query flag to system prompt

    userPrompt = buildDiscoveryChatPrompt({
      transcript,
      retrieved,
      factsContext: null,
      userName: name,
      priorReport: priorReportSnippet,
      discoveryType,
      metrics: latestDiscoveryMetrics,
      reportDate,
      userSession: latestUserSession, // Pass latest user session (for backward compatibility)
      allUserSessions: allUserSessions, // Pass all user sessions
    });
  } else {
    // Diagnostic mode: fetch latest prompts from DB or use fallback
    const { PromptType } = require("../utils/types");
    const brainPromptObj = await getLatestPromptFromDb(PromptType.BRAINPROMPT);
    const diagnosticPromptObj = await getLatestPromptFromDb(
      PromptType.DIAGNOSTIC,
    );

    const brainPrompt = brainPromptObj?.content;
    const diagnosticPrompt = diagnosticPromptObj?.content;

    systemPrompt = `${brainPrompt}\n\n${diagnosticPrompt}\n\n${SUPPORT_LOCK_PROMPT}`;

    // Diagnostic mode: freeform intake
    const intakeTranscript =
      wantsNewDiagnostic && !intakeHasStarted ? [] : transcript;

    const intakeResumeNotice =
      wantsNewDiagnostic && !intakeHasStarted
        ? "I understand you'd like to create a new diagnostic report. We'll start fresh with the Deep Intake to map your current structure."
        : resumeNotice;

    const lastAssistant = [...transcript]
      .reverse()
      .find((m) => m?.role === "assistant");

    userPrompt = buildFreeformIntakePrompt({
      transcript: intakeTranscript,
      userName: name,
      lastMessageFromAssistant: Boolean(lastAssistant),
      resumeNotice: intakeResumeNotice,
      priorReport: priorReportSnippet,
      wantsNewDiagnostic: wantsNewDiagnostic && !intakeHasStarted,
      confidenceResult,
    });
  }

  return { systemPrompt, userPrompt };
};

/**
 * Generate AI chat response
 */
const generateChatResponse = async ({
  systemPrompt,
  userPrompt,
  transcript,
  priorReportSnippet,
  isDiscoveryMode,
  name,
  temperature = 0.3,
  maxTokens = 400,
}) => {
  // Build messages array for AI
  let messages = [{ role: "system", content: systemPrompt }];

  // Include prior report in system context for both modes
  if (priorReportSnippet) {
    messages.push({
      role: "system",
      content: isDiscoveryMode
        ? `Previous diagnostic report for ${name}(you have full access to this - use it to answer questions about what the report revealed, their patterns, insights, etc.): \n${priorReportSnippet} `
        : `Existing diagnostic report for ${name}(reference for continuity; do not re - emit the full report here): \n${priorReportSnippet} `,
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
    },
  );

  try {
    const aiResponse = await openai.chat.completions.create({
      model: "gpt-4o",
      messages,
      temperature,
      max_completion_tokens: maxTokens,
    });

    const nextMessage = aiResponse?.choices?.[0]?.message;
    return nextMessage;
  } catch (err) {
    console.error("[generateChatResponse] Error:", err);
    return null;
  }
};

/**
 * Check if chat should be finalized (auto-finalize for diagnostic mode)
 */
const shouldAutoFinalize = ({
  hasExistingReport,
  wantsNewDiagnostic,
  answeredCount,
  targetCount,
  pendingQuestion,
  aiAnswered,
}) => {
  return (
    (!hasExistingReport || wantsNewDiagnostic) &&
    answeredCount >= targetCount &&
    !pendingQuestion &&
    aiAnswered
  );
};

/**
 * Save chat state to Chat table only (not in diagnostic)
 * This function is kept for backward compatibility but should not be used
 * Chat data should be saved directly in Chat table
 */
const saveChatState = async ({
  diagnostic,
  transcript,
  mode,
  discoveryType = null,
}) => {
  // Don't save chat data in diagnostic - it should be saved in Chat table
  // This function is kept for compatibility but does nothing
  // Chat data should be managed in Chat table only
  return;
};

/**
 * Get latest prompt from database by type
 */
const getLatestPromptFromDb = async (type = "Diagnostic") => {
  try {
    const prompt = await Prompt.findOne({
      where: { type, isActive: true },
      order: [["createdAt", "DESC"]],
      raw: true,
    });

    if (!prompt) return null;

    return {
      ...prompt,
      fullPrompt: `${prompt.content}\n\n${SUPPORT_LOCK_PROMPT}`,
    };
  } catch (error) {
    console.error(`Error fetching latest prompt of type ${type}:`, error);
    return null;
  }
};

module.exports = {
  // DEEP_INTAKE_QUESTIONS,
  // buildIntakeQuestionResponse,
  buildFinalReportPrompt,
  DEFAULT_INTRO_PAGE_TEXT,
  buildFreeformIntakePrompt,
  buildDiscoveryChatPrompt,
  sanitizeReportText,
  getDiscoverySystemPrompt,
  buildChatPrompts,
  // Helper functions for chatbotDiagnosticFreeform
  validateChatbotRequest,
  loadDiagnosticState,
  loadLatestDiscoveryMetrics,
  getLatestUserSession,
  getAllUserSessions,
  extractMetricsFromReport,
  extractReportDate,
  preparePreviousReports,
  checkWantsNewDiagnostic,
  checkWantsEmail,
  determineChatMode,
  prepareTranscript,
  trackQuestionNumbers,
  extractQuestionNumber,
  SUPPORT_LOCK_PROMPT,
  isAiLikelyAnswer,
  generateChatResponse,
  shouldAutoFinalize,
  saveChatState,
  getLatestPromptFromDb,
  safeFindDiagnostic,
  cleanTranscriptText,
  calculateDiagnosticConfidence,
};
