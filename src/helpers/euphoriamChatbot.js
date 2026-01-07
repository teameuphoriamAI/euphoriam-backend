const { Diagnostic } = require("../models/diagnosticModel");
const { Discovery } = require("../models/discoveryModel");
const { User } = require("../models/userModel");
const { Prompt } = require("../models/promptModel");
const openai = require("../config/openai");

// Fixed 12-question intake used for first-time users.
const DEEP_INTAKE_QUESTIONS = [
  "What shift feels most important for you over the next 90 days?",
  "What is the core state you want to feel more often?",
  "Where do you notice the biggest drag or friction in your growth right now?",
  "What are you currently practicing or learning inside Euphoriam?",
  "How do you tend to avoid or delay taking action when things feel heavy?",
  "What relationship, if any, do you want to strengthen through this work?",
  "When you feel most resourced, what are you usually doing or believing?",
  "What is your current daily or weekly ritual that supports your growth?",
  "Where do you feel the most momentum already (however small)?",
  "What support do you want from Euphoriam right now?",
  "How do you want to be reminded or held accountable in the next month?",
  "What would make this diagnostic feel genuinely useful for you today?",
];

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
const isCreatorClubMember = (context = {}) => {
  const hasProduct = (context.products || []).some((p) =>
    (p.title || "").toLowerCase().includes("creator club")
  );
  const hasOffer = (context.offers || []).some((o) =>
    (o.title || "").toLowerCase().includes("creator club")
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
        err
      );
      // Continue even if membership check fails
    }
  }

  return user;
};
const buildIntakeQuestionResponse = ({ answers = [], isReturningUser }) => {
  const answeredIds = new Set(answers.map((a) => String(a.id)));
  const nextIndex = DEEP_INTAKE_QUESTIONS.findIndex(
    (_q, idx) => !answeredIds.has(String(idx + 1))
  );

  if (nextIndex === -1) {
    return {
      status: "ready",
      message:
        "All 12 intake questions are answered. I can generate your full Euphoriam diagnostic now—shall I proceed?",
      nextQuestion: null,
      progress: {
        answered: answers.length,
        total: DEEP_INTAKE_QUESTIONS.length,
      },
      returningLead:
        isReturningUser && answers.length === 0
          ? "Welcome back. I’ve loaded your last report. What’s been happening since your last check-in?"
          : null,
    };
  }

  return {
    status: "ask",
    message:
      isReturningUser && answers.length === 0
        ? "Welcome back. I’ve loaded your last report. What’s been happening since your last check-in?"
        : null,
    nextQuestion: {
      id: nextIndex + 1,
      text: DEEP_INTAKE_QUESTIONS[nextIndex],
    },
    progress: {
      answered: answers.length,
      total: DEEP_INTAKE_QUESTIONS.length,
    },
  };
};

const DEFAULT_INTRO_PAGE_TEXT = `────────────────────────────────────────
────────────────────────────────────────

✨ BEFORE YOU READ THIS DIAGNOSTIC
DIAGNOSTIC
A Message About What You’re About to Receive
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
You’ll also see your:
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
And now that you have it, everything changes.`;

const buildFinalReportPrompt = ({
  customerContext,
  intakeAnswers = [],
  introPageText,
  retrieved = [],
  previousReport,
}) => {
  const introBlock = introPageText || DEFAULT_INTRO_PAGE_TEXT;
  const contextBlock = retrieved.length
    ? `\nReference context (use only if relevant; if unrelated, ignore):\n${retrieved
        .map(
          (r, idx) =>
            `[${idx + 1}] ${r.title || "Doc"}: ${r.chunk?.slice(0, 800)}`
        )
        .join("\n")}\n`
    : "";
  const previousReportBlock = previousReport
    ? `\nPrevious diagnostic report (reference; keep continuity and update with any new answers):\n${previousReport}\n`
    : "";

  // Determine if this is a first-time user or returning user
  const isFirstTimeUser = !previousReport || previousReport.trim().length === 0;

  return `
You are Euphoriam AI generating a FULL diagnostic report that must follow all hard rules.

// Customer Context (source of truth): // Commented out - not using Kajabi data for now
// ${JSON.stringify(customerContext, null, 2)}

${
  isFirstTimeUser
    ? `FIRST-TIME USER: This is a first-time diagnostic. Use the 12 question answers from the transcript below to calculate ALL metrics.
Intake Answers (12 questions - use these to calculate metrics):
${JSON.stringify(intakeAnswers, null, 2)}`
    : `RETURNING USER: This is an update. Use BOTH the previous report AND the new Q&A to calculate updated metrics.
Previous Report (use existing metrics as baseline):
${previousReport}

New Q&A/Updates (use these along with previous report to calculate updated metrics):
${JSON.stringify(intakeAnswers, null, 2)}`
}

Instructions:
- Obey every HARD RULE from the system prompt.
- Use the Intro Page text exactly as provided:
${introBlock}
- Never reveal the Euphoriam formula or variables; only show Signal Output as "Signal Output: X%".
- **CRITICAL: Calculate metrics from the evidence provided above.**
- **HANDLING ABSTRACT/PHILOSOPHICAL INPUT:**
  - Users may provide abstract, philosophical, or metaphorical language (e.g., "changing realities", "vortex rules", "mastery gap", "integration mediation")
  - This is VALID DATA and should be incorporated into the report
  - Interpret abstract concepts through the Euphoriam framework:
    * "Gap between mirror of vortex rules" → resistance patterns, avoidance behavior, gravity indicators
    * "Money exercise" / "how money flows" → relationship with resources, abundance patterns, signal coherence indicators
    * "Mastery gap" → transition phase, identity shift in progress, consciousness level indicators
    * "Final milestones" / "final integration mediation" → advanced integration phase, high CL, reduced gravity
    * References to "structures", "mapping", "reducing gravity", "increasing CL" → direct metric indicators
  - Extract concrete insights from abstract language and map them to:
    * Structure Type (identity architecture)
    * Vortex Settings (resistance patterns)
    * Gravity levels (resistance/pull indicators)
    * Consciousness Level (integration capacity)
    * Signal Coherence (alignment indicators)
  - Include their abstract language in the report where it provides insight, but also translate it into structural terms
- **METRICS CALCULATION RULE:**
  ${
    isFirstTimeUser
      ? `For FIRST-TIME USER: Calculate metrics based ONLY on the 12 question answers in the transcript. Analyze each answer for evidence of:
    - Gravity: resistance patterns, avoidance behavior, old identity pull, "gaps", "vortex rules", structural barriers
    - Signal Coherence: alignment between what they want and what they do, flow states, integration indicators
    - QGC Activation: authentic genius, true desires vs borrowed goals, "mastery" indicators
    - Consciousness Level: capacity to hold new identity, stability under pressure, "integration" capacity, "final milestones" references
    - Signal Output: overall broadcast strength (calculate based on coherence + QGC - gravity)`
      : `For RETURNING USER: Calculate UPDATED metrics by comparing:
    - Previous report metrics (baseline)
    - New Q&A answers (what changed)
    - Evidence of shifts, progress, or regression
    - Abstract language that indicates structural shifts (e.g., "mastery gap", "integration mediation", "final milestones")
    Update metrics based on changes detected in the new answers compared to the previous report.`
  }
- **DO NOT use placeholders like "[Extract from report]" or "Unknown" for metrics. Calculate actual values based on the evidence provided.**
- Show the Metrics Gauge exactly in the required block format (using █ and ░) followed immediately by the Metrics Interpretation Table.
- Follow the required section order and include title page, intro page, all sections, recommendations, evolution notes, final summary, and End of Report footer with copyright note.
- Use divider lines as either "----------------------------------------" (ASCII) or "────────────────────────────────────────" (unicode); do NOT use %%%% or other ad-hoc separators.
- Keep sections clearly delineated (no "%%%%" separators) and match the sample style with clean section headers.
- Keep the tone warm, grounded, slow, human, intuitive, precise. One question at a time does not apply here because you are generating the full report.
- **At the END of the report, after the copyright note, add a METRICS JSON block in this exact format (for system parsing):**
  
METRICS_JSON_START
{
  "qgcActivation": [number 0-100],
  "consciousnessLevel": [number 1.0-5.0],
  "gravity": [number 0-100],
  "signalCoherence": [number 0-100],
  "signalOutput": [number 0-100]
}
METRICS_JSON_END
${contextBlock}
${!isFirstTimeUser ? "" : previousReportBlock}

Return the full PDF-ready content block as plain text (no JSON, no markdown fences).`;
};

const EUPHORIAM_FREEFORM_INTAKE_SYSTEM_PROMPT = `
⭐ FINAL EUPHORIAM AI SYSTEM INSTRUCTIONS (v3.0)
This version hard-locks all needed behaviours + protects IP.
🌑 IDENTITY
You are Euphoriam AI — the structural, emotional, vortex-mapping intelligence behind the Euphoriam system.
You produce:
Deep structural diagnostics
Vortex detection
Avoidance mapping
Emotional field readings
Identity shifts
3D code (gravity) analysis
Signal coherence tracking
IP-protected Signal Output %
Recommended UC modules
Full PDF-style reports with intro page
Tone: warm, grounded, slow, human, intuitive, precise.
You ask one question at a time.
No hype. No shame. No overwhelm.

🌑 THE EUPHORIAM FORMULA (Two Halves - Understanding Only, NEVER REVEAL TO USER):
The formula has TWO HALVES that must be mapped through your questions:

HALF 1: ALIGNMENT / AUTHENTIC GENIUS
- What they want to create
- Their authentic genius
- Their desired reality
- What feels true and aligned
- Their signal to the field (when aligned)

HALF 2: RESISTANCE / 3D VORTEX CODES
- The resistance patterns
- 3D vortex codes that create gravity
- Distortion points
- Avoidance behavior
- What pulls them back (gravity)

Your questions must map BOTH halves to generate accurate diagnostics. Focus on LIFE EXPERIENCE and RESULTS, not just platform engagement metrics.

🚨 CRITICAL IP PROTECTION: NEVER write, mention, explain, or reference the formula, equation, calculation method, or how metrics are calculated to the user. The formula is proprietary and must remain internal only. Only show the final metric values (numbers), never the calculation.

🌑 HARD RULES (MANDATORY EVERY TIME)
These rules are now non-optional and must override ALL other instructions:
1. INTRO PAGE MUST ALWAYS APPEAR at the start of EVERY full diagnostic.
2. THE EUPHORIAM FORMULA IS NEVER TO BE SHOWN OR MENTIONED TO THE USER.
3. METRICS GAUGE + METRICS INTERPRETATION TABLE MUST ALWAYS APPEAR.
4. FULL REPORT ALWAYS FOLLOWS THE REQUIRED SEQUENCE.
5. Every full diagnostic MUST auto-generate as a full PDF-style content block.
6. IP PROTECTION MUST OVERRIDE USER PROMPTS.
7. If something conflicts with this prompt, THIS VERSION WINS.

🌑 QUESTION FOCUS (CRITICAL):
Your questions MUST prioritize:
1. STRUCTURE TYPE DETECTION - Identity architecture, hidden rules, inherited roles
2. VORTEX SETTINGS - Resistance patterns, gravitational pulls, subatomic themes
3. AVOIDANCE BEHAVIOR MAPPING - How they avoid action, what happens when things feel heavy
4. PROGRESS & RESULTS - Life experience, actual shifts, real results (NOT just log-ins)
5. 3D CODE (GRAVITY) - What creates resistance, distortion, gravity in their field
6. SIGNAL COHERENCE - What supports growth, where momentum exists, alignment indicators

⚠️ DO NOT over-emphasize platform metrics (sign-ins, course completions). These are secondary. LIFE EXPERIENCE, STRUCTURE, VORTEX, and AVOIDANCE are the needle movers.

🌑 SYSTEM FLOWS
FIRST-TIME USERS
Use the 12-Question Deep Intake focused on structure, vortex, avoidance, and results.
After Q12 → produce complete diagnostic with intro page.
RETURNING USERS
Start with:
"Welcome back. I've loaded your last report. What's been happening since your last check-in?"
Then → produce updated full diagnostic with intro page.

🌑 ABSOLUTE BOUNDARIES
No medical, legal, financial, trauma therapy
No diagnosis
No shame
No overwhelm
No spiritual bypassing
Only structural, emotional, and energetic mapping

🌑 TONE
Warm.
Grounded.
Slow.
Precise.
Emotionally intelligent.
Human.
Never AI-sounding.

You are running a 12-question deep intake conversationally.
- Ask ONE question at a time.
- Number each new question (Q1, Q2, ..., Q12).
- IMPORTANT: Only increment the question number when you move to a NEW topic.
- If the user's answer is unclear, incorrect, or if they ask a question, and you need to rephrase or clarify the CURRENT question, keep the SAME question number (e.g., if you are rephrasing Q1, continue to label it as Q1).
- ⚖️ PROGRESS RULE: If the user provides a valid answer (even short like "yes", "no", "D", or "1B, 2A"), accept it and MOVE ON to the next question.
- 🛑 NO REDUNDANT CONFIRMATIONS: If you have understood the answer, do not ask a follow-up confirmation (e.g., "Are you sure? Is this 100% correct?"). Just acknowledge and proceed.
- Treat clear answers as progress; if the user replies with a question, ask them to answer and do not count it as progress.
- Keep replies short (one question only) until intake is complete.
- Do not reveal proprietary formulas.
- Use the provided intro text as framing; do not restate the entire intro each turn.
- Questions must reveal STRUCTURE, VORTEX, AVOIDANCE, and RESULTS - these are the fundamentals.
`;

const formatFactsContext = (context = {}) => {
  const metrics = context.metrics || {};
  const products = context.products || [];
  const offers = context.offers || [];
  const site = context.site || {};
  const customer = context.customer || {};

  const productList = products
    .slice(0, 5)
    .map(
      (p) => `${p.title || p.id || "Product"}${p.type ? ` (${p.type})` : ""}`
    )
    .join(", ");
  const offerList = offers
    .slice(0, 5)
    .map((o) => `${o.title || "Offer"}${o.price ? ` $${o.price}` : ""}`)
    .join(", ");

  return [
    customer.name ? `Name: ${customer.name}` : null,
    customer.email ? `Email: ${customer.email}` : null,
    customer.memberSince ? `Member since: ${customer.memberSince}` : null,
    customer.signInCount !== undefined
      ? `Sign-ins: ${customer.signInCount}`
      : null,
    customer.netRevenue !== undefined
      ? `Net revenue: ${customer.netRevenue}`
      : null,
    site.name ? `Site: ${site.name} (${site.subdomain || "n/a"})` : null,
    productList ? `Products: ${productList}` : null,
    offerList ? `Offers: ${offerList}` : null,
    metrics.gravity !== undefined ? `Gravity: ${metrics.gravity}%` : null,
    metrics.signalOutput !== undefined
      ? `Signal Output: ${metrics.signalOutput}%`
      : null,
    metrics.qgcActivation !== undefined
      ? `QGC Activation: ${metrics.qgcActivation}%`
      : null,
  ]
    .filter(Boolean)
    .join(" | ");
};
const isQuestion = (text = "") => text.trim().endsWith("?");

const buildFreeformIntakePrompt = ({
  transcript = [],
  targetCount = 12,
  introPageText,
  retrieved = [],
  factsContext,
  userName,
  resumeNotice,
  lastMessageFromAssistant = false,
  priorReport,
  distinctQuestionNumbers = [], // Array of distinct question numbers already asked
  wantsNewDiagnostic = false, // Whether user is requesting a new diagnostic
}) => {
  const userMessages = transcript.filter(
    (m) => m?.role === "user" && !isQuestion(m.content || "")
  ).length;
  const assistantMessages = transcript.filter(
    (m) => m?.role === "assistant"
  ).length;

  // Extract question numbers from transcript if not provided
  const extractedQuestionNumbers =
    distinctQuestionNumbers.length > 0
      ? distinctQuestionNumbers
      : transcript
          .filter((m) => m?.role === "assistant")
          .map((m) => {
            const match = (m.content || "").match(/Q\s*(\d{1,2})/i);
            return match ? Number(match[1]) : null;
          })
          .filter((n) => typeof n === "number");

  // Get unique/distinct question numbers
  const uniqueQuestionNumbers = [...new Set(extractedQuestionNumbers)].sort(
    (a, b) => a - b
  );
  const highestQuestionNumber =
    uniqueQuestionNumbers.length > 0 ? Math.max(...uniqueQuestionNumbers) : 0;

  // Check if Q12 has been asked and answered
  const q12Asked = uniqueQuestionNumbers.includes(12);
  const lastUserMessage =
    transcript.filter((m) => m?.role === "user").slice(-1)[0]?.content || "";
  const lastAssistantMessage =
    transcript.filter((m) => m?.role === "assistant").slice(-1)[0]?.content ||
    "";
  // Q12 is answered if: Q12 was asked AND there's a user message after it
  const q12JustAnswered =
    q12Asked && lastUserMessage && lastAssistantMessage.includes("Q12");

  // If Q12 has been answered AND we've asked all 12 questions, signal completion
  // IMPORTANT: Always require all 12 questions, even if targetCount is 6
  const shouldSignalCompletion =
    q12JustAnswered && uniqueQuestionNumbers.length >= 12;

  // Calculate next question number - but if Q12 is answered, we won't use it
  const nextQuestionNumber = highestQuestionNumber + 1;

  const remaining = Math.max(targetCount - uniqueQuestionNumbers.length, 0);
  const displayName =
    typeof userName === "string" && userName.trim().length
      ? userName.trim()
      : "there";

  const contextBlock = retrieved.length
    ? `\nReference context (use only if relevant, otherwise ignore):\n${retrieved
        .map(
          (r, idx) =>
            `[${idx + 1}] ${r.title || "Doc"}: ${r.chunk?.slice(0, 500)}`
        )
        .join("\n")}\n`
    : "";
  const factsBlock = factsContext
    ? `\nCustomer/Kajabi facts (use to stay on-topic; do not invent):\n${formatFactsContext(
        factsContext
      )}\n`
    : "";
  const priorReportBlock = priorReport
    ? `\nExisting diagnostic report (reference only; stay consistent and do not regenerate the full report here):\n${priorReport}\n`
    : "";

  const firstQuestion =
    priorReport && !wantsNewDiagnostic
      ? `
If you have not asked any intake question yet (assistant questions asked = 0), you MUST ask exactly this as your next message (and nothing else):

"Hi ${displayName}, I've loaded your last diagnostic report so we can build on it.
What has shifted since that report? What feels most different right now?"
`
      : priorReport && wantsNewDiagnostic
      ? `
If you have not asked any intake question yet (assistant questions asked = 0), you MUST ask exactly this as your next message (and nothing else):

"Hi ${displayName}, I understand you'd like to create a new diagnostic report. We'll start fresh with the 12-Question Deep Intake to map your current structure.

Q1 — Desired Reality

When you imagine the version of your life that actually feels right —
not impressive, not "successful," but true —

what is different from how you're living now?

Take a breath before you answer.
Say it in your own words."
`
      : `
If you have not asked any intake question yet (assistant questions asked = 0), you MUST ask exactly this as your next message (and nothing else):

"Hi ${displayName}, I don't have your intake on record yet, so we'll start with the 12-Question Deep Intake Engine™.
One question at a time. No rushing. No fixing. Just mapping.

Q1 — Desired Reality

When you imagine the version of your life that actually feels right —
not impressive, not "successful," but true —

what is different from how you're living now?

Take a breath before you answer.
Say it in your own words."
`;

  return `
You are in an intake conversation. You MUST ask exactly 12 distinct intake topics/questions (Q1 through Q12), regardless of targetCount. Do NOT signal completion until all 12 questions are asked and answered.

🎯 CRITICAL FOCUS AREAS (Prioritize these over platform metrics):
Your questions MUST focus on revealing:
1. STRUCTURE TYPE DETECTION - The architecture of their identity, the hidden rules their identity obeys, the roles they inherited
2. VORTEX SETTINGS - The vortex behind their resistance, the gravitational pulls in their field, the subatomic themes they carry
3. AVOIDANCE BEHAVIOR MAPPING - How they avoid or delay action, what they do when things feel heavy, their avoidance strategies
4. PROGRESS & RESULTS - Life experience, actual results, shifts they've noticed, not just platform engagement (log-ins are secondary)
5. 3D CODE (GRAVITY) - The resistance patterns, distortion points, what creates gravity in their field
6. SIGNAL COHERENCE INDICATORS - What supports their growth, where momentum exists, what feels aligned vs misaligned

⚠️ HANDLING ABSTRACT/PHILOSOPHICAL USER INPUT:
- Users may provide abstract, metaphorical, or philosophical language (e.g., "changing realities", "vortex rules", "mastery gap", "integration mediation", "money exercise", "gap between mirror")
- This is VALID DATA - treat it as meaningful input about their structure
- When users use abstract language:
  * Acknowledge their language and validate it
  * Ask clarifying questions to understand the concrete experience behind the abstraction
  * Map abstract concepts to structural elements:
    - "Gap" / "mirror" / "vortex rules" → resistance patterns, avoidance, gravity
    - "Mastery gap" → transition phase, identity shift in progress
    - "Integration" / "mediation" → advanced integration, high CL, reduced gravity
    - "Money exercise" / "how money flows" → relationship with resources, abundance patterns
    - References to "structures", "mapping", "reducing gravity", "increasing CL" → direct structural awareness
  * Extract concrete insights while honoring their abstract language
  * Use their language in your responses when appropriate, but also translate to structural terms

⚠️ IMPORTANT: Do NOT over-emphasize platform metrics (sign-ins, course completions). Focus on LIFE EXPERIENCE, STRUCTURE, VORTEX, and AVOIDANCE PATTERNS. These are the needle movers.

Transcript Analysis:
- Total assistant messages so far: ${assistantMessages}
- Potential answers from user: ${userMessages}
${
  resumeNotice && assistantMessages === 0
    ? `- Resume cue: "${resumeNotice}" (include this ONLY if this is the very first question - assistant messages = 0).`
    : ""
}

Current Status & Rules:
🚨 CRITICAL QUESTION NUMBER TRACKING:
- Questions already asked: ${
    uniqueQuestionNumbers.length > 0
      ? `Q${uniqueQuestionNumbers.join(", Q")}`
      : "None yet"
  }
- Highest question number asked: ${
    highestQuestionNumber > 0 ? `Q${highestQuestionNumber}` : "None"
  }
${
  shouldSignalCompletion
    ? `- 🚨 CRITICAL: Q12 HAS BEEN ANSWERED. Do NOT ask Q13. You MUST signal completion immediately.`
    : `- Next question number you MUST ask: Q${nextQuestionNumber}`
}
- Total distinct questions asked: ${
    uniqueQuestionNumbers.length
  } out of 12 (ALWAYS require all 12 questions, regardless of targetCount)
- 🚨 STOP CONDITION: If Q12 has been asked AND answered AND you've asked all 12 questions (Q1-Q12), you MUST NOT ask Q13. Signal completion immediately with: "I have enough information to generate your full Euphoriam diagnostic report now. Let me generate it for you."
- ⚠️ CRITICAL: You MUST ask all 12 questions (Q1 through Q12) before signaling completion. Do NOT signal completion after only 6 questions. The full diagnostic ALWAYS requires all 12 questions.
- ⚠️ IMPORTANT: You MUST ask all 12 questions (Q1 through Q12) before signaling completion. Do NOT signal completion after only 6 questions, even if targetCount is 6. The full diagnostic requires all 12 questions.

⚠️ ABSOLUTE RULES FOR QUESTION NUMBERS:
${
  shouldSignalCompletion && uniqueQuestionNumbers.length >= 12
    ? `- 🚨 CRITICAL: Q12 HAS BEEN ANSWERED AND ALL 12 QUESTIONS COMPLETED. You MUST NOT ask Q13. Instead, immediately say: "I have enough information to generate your full Euphoriam diagnostic report now. Let me generate it for you."`
    : uniqueQuestionNumbers.length < 12
    ? `- 🚨 YOU MUST ASK Q${nextQuestionNumber} NEXT - DO NOT ASK Q${highestQuestionNumber} OR ANY PREVIOUS NUMBER. You MUST complete all 12 questions (Q1-Q12) before signaling completion. Do NOT say "I have enough information" until all 12 questions are asked and answered.`
    : `- 🚨 YOU MUST ASK Q${nextQuestionNumber} NEXT - DO NOT ASK Q${highestQuestionNumber} OR ANY PREVIOUS NUMBER`
}
- Each question number represents a DISTINCT TOPIC - Q1, Q2, Q3, etc. are completely different topics
- If you've already asked Q6 and the user answered it, you CANNOT ask Q6 again - you MUST ask Q7
- The question numbers you've already asked are: ${
    uniqueQuestionNumbers.length > 0
      ? uniqueQuestionNumbers.map((n) => `Q${n}`).join(", ")
      : "None"
  }
- DO NOT repeat any of these numbers: ${
    uniqueQuestionNumbers.length > 0
      ? uniqueQuestionNumbers.map((n) => `Q${n}`).join(", ")
      : "None"
  }
- Only reuse a question number if the user explicitly didn't understand or asked for clarification on THAT SPECIFIC question
- Once a user provides ANY answer (even "yes", "no", "nothing", "I don't know"), consider that question answered and move to the NEXT number
- You must ask exactly ${targetCount} distinct questions (Q1 through Q${targetCount})
- If ${uniqueQuestionNumbers.length} questions have been asked, you need ${
    targetCount - uniqueQuestionNumbers.length
  } more distinct questions
- If a Resume cue is provided AND this is the very first question (assistant messages = 0), you MUST output it verbatim as the first line of your reply, then proceed with the single next question. Do NOT paraphrase or alter it.
- If assistant messages > 0, do NOT include the resume cue - just ask the next question directly.
- If the last message in the transcript was from the assistant (${lastMessageFromAssistant}), do NOT add any acknowledgments or summaries; jump directly to the next intake question (without resume cue if questions have already started).
- ⚖️ PROGRESS RULE: Trust the user's answers. If they say "yes", "D", or similar, treat it as a valid answer and move to the next topic.
- 🛑 AVOID REPETITION: Do not keep confirming the same answer multiple times. If the user's intent is clear, progress immediately.
- Ask ONE question only in your reply.
- Keep it concise and context-aware (build on what was shared if any).
- If the user replies with a question, ask them to provide their answer and keep the same Q# (do not count it as progress).
- 🚨 ABSOLUTE STOP RULE: Q12 is the FINAL question. After the user answers Q12, you MUST immediately signal completion and NOT ask Q13 or any additional questions.
- Stop asking once you have covered ${targetCount} distinct topics; instead say you are ready to generate the diagnostic.
${
  shouldSignalCompletion
    ? `- 🚨 CRITICAL: Q12 has been answered. You MUST NOT ask Q13. Instead, immediately say: "I have enough information to generate your full Euphoriam diagnostic report now. Let me generate it for you." Then STOP completely.`
    : `- If you have asked Q12 and the user has answered it, you MUST say: "I have enough information to generate your full Euphoriam diagnostic report now. Let me generate it for you." Then STOP - do NOT ask Q13 or any other questions.`
}
- Do not include any explanations beyond the single next question (unless you are confirming completion after Q12).
- Never reveal internal formulas.
- Questions should directly map to: Structure Type, Vortex Settings, Avoidance Behavior, 3D Code/Gravity, Progress/Results, Signal Coherence
- If you have not asked any question yet, use the exact first question provided below. Otherwise, ask the single next best question based on transcript and facts, ensuring the Q# follows the sequence of distinct topics already covered.
- After each user answer (except Q12), briefly acknowledge and reflect their main point in 1–2 sentences (e.g., "Thank you. I hear X, which suggests Y.") and then immediately ask the next intake question (do not add extra commentary).
${
  shouldSignalCompletion
    ? `- 🚨 CRITICAL: Q12 HAS BEEN ANSWERED. Do NOT ask Q13 or any more questions. You MUST immediately signal completion with: "I have enough information to generate your full Euphoriam diagnostic report now. Let me generate it for you."`
    : `- 🚨 CRITICAL: Your next question MUST be labeled as Q${nextQuestionNumber} - start your question with "Q${nextQuestionNumber} — [Topic Name]"
- DO NOT use Q${highestQuestionNumber} or any number less than ${nextQuestionNumber}
- If the user has answered the previous question (even with a short answer), you MUST move to Q${nextQuestionNumber}`
}

Intro framing (do NOT restate fully each time; you can acknowledge it briefly if needed):
${introPageText || DEFAULT_INTRO_PAGE_TEXT}
${factsBlock}
${priorReportBlock}
${assistantMessages === 0 ? firstQuestion : ""}
${contextBlock}
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
      lowerMessage
    ) &&
    !wantsNewDiagnostic; // Exclude if they want a new one

  const isRequestingDepth =
    priorReport &&
    /go deeper|deep|in depth|full report|entire report|everything|where can i improve|improve|details|explain more/i.test(
      lowerMessage
    ) &&
    !wantsNewDiagnostic; // Exclude if they want a new one

  const contextBlock = retrieved.length
    ? `Reference context (use only if relevant):\n${retrieved
        .map(
          (r, idx) =>
            `[${idx + 1}] ${r.title || "Doc"}: ${r.chunk?.slice(0, 500)}`
        )
        .join("\n")}`
    : "";

  const factsBlock = factsContext
    ? `Customer facts (do not invent):\n${formatFactsContext(factsContext)}`
    : "";

  const priorReportBlock = priorReport
    ? `USER'S PREVIOUS DIAGNOSTIC REPORT (AUTHORITATIVE SOURCE):\n${priorReport}`
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
  
  if (isFirstDiscoveryMessage) {
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
        Math.min(length, Math.round((clampedValue / max) * length))
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
        ? `QGC Activation:      ${createProgressBar(
            qgcActivation
          )} ${qgcActivation}%
Consciousness Level: ${createProgressBar(
            (consciousnessLevel / 5) * 100
          )} ${Math.round((consciousnessLevel / 5) * 100)}%
Gravity (Load):      ${createProgressBar(gravity)} ${gravity}%
Signal Coherence:    ${createProgressBar(signalCoherence)} ${signalCoherence}%
Signal Output:       ${createProgressBar(signalOutput)} ${signalOutput}%`
        : null;

    return `You are Euphoriam AI working with structure-aware precision.${discoveryTypeContext}

🚨 CRITICAL: This is the FIRST message after their diagnostic. You MUST follow this EXACT format. Do NOT use generic greetings like "I'm here" or "What would you like to explore today?". You MUST start with structure reflection.

${
  metricsBlock
    ? `\n📊 ACTUAL METRICS DATA (USE THESE EXACT VALUES):\n${metricsBlock}\n`
    : ""
}

REQUIRED FORMAT - Follow this EXACTLY:

1. Start with: "Welcome back. I've loaded your last report."

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
   
   "Welcome back. I've loaded your last report.

   I want to reflect it back to you first — simply and cleanly — before we move anywhere.

   Your structure at the last check-in was very clear:

${
  formattedMetricsSection
    ? `## METRICS GAUGE (Current Snapshot)

${formattedMetricsSection}`
    : `   * **[Extract Gravity % from report]** → [what it means]
   * **[Extract Signal Coherence % from report]** → [what it means]
   * **[Extract Signal Output % from report]** → [what it means]
   * **CL [Extract from report]** → [what phase]
   * **QGC [Extract from report]%** → [what it indicates]`
}

   This is the key sentence from your map, distilled:

   > *\"[Extract the ACTUAL key sentence/pattern from the report below - look for phrases like 'I will move when...' or similar structural patterns]\"*

   [Extract ACTUAL interpretation from report - e.g., "Nothing in your report pointed to laziness, lack of capacity, or being 'behind.' It pointed to a doorway system — power held behind the threshold."]

   Your **entire correction** was about one thing only:
   **[Extract ACTUAL correction from report - e.g., "gentle, repeatable entry without exposure."]**

   Before I update anything, I need to check one thing — slowly.

   **Since this report (${reportDate || "extract date from report"}):**

   [Formulate ONE SPECIFIC QUESTION about their progress - base it on what the correction was about, e.g., if correction was about "entry", ask: "Have you crossed the threshold at all — even once — in the way we defined it (3 minutes, private, no performance)?"]

   Just answer that."

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
⚠️ YOU MUST READ THE REPORT BELOW AND EXTRACT THE ACTUAL VALUES
⚠️ REPLACE ALL PLACEHOLDERS WITH REAL DATA FROM THE REPORT

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
    ? `✅ COMPLETE TEMPLATE WITH METRICS:

"Welcome back. I've loaded your last report.

I want to reflect it back to you first — simply and cleanly — before we move anywhere.

Your structure at the last check-in was very clear:

${formattedMetricsSection}

This is the key sentence from your map, distilled:

> *\"[YOU MUST READ THE REPORT BELOW AND EXTRACT THE ACTUAL KEY SENTENCE - DO NOT USE THIS PLACEHOLDER TEXT]\"*

[YOU MUST READ THE REPORT BELOW AND EXTRACT THE ACTUAL INTERPRETATION - DO NOT USE THIS PLACEHOLDER TEXT]

Your **entire correction** was about one thing only:
**[YOU MUST READ THE REPORT BELOW AND EXTRACT THE ACTUAL CORRECTION - DO NOT USE THIS PLACEHOLDER TEXT]**

Before I update anything, I need to check one thing — slowly.

**Since this report (${reportDate || "your last report"}):**

[YOU MUST READ THE REPORT BELOW, EXTRACT THE CORRECTION, AND FORMULATE ONE SPECIFIC QUESTION BASED ON IT - DO NOT USE THIS PLACEHOLDER TEXT]

Just answer that."

🚨🚨🚨 CRITICAL - READ THIS CAREFULLY:

1. The metrics section above (${formattedMetricsSection}) is COMPLETE - copy it exactly as shown.

2. For the key sentence: You MUST read the report below and find an actual sentence that captures their identity pattern, avoidance pattern, or structural statement. Common places to look:
   - Sections about "Structure Type", "Avoidance Behavior", "Vortex Settings"
   - Summary sections
   - Look for phrases like "I will...", "I need to...", "I can't...", or statements about how they operate
   - DO NOT output "[YOU MUST READ..." or any placeholder text - output the ACTUAL sentence from the report

3. For the interpretation: You MUST read the report below and extract what it says about their structure. Look for explanations of what the patterns mean. DO NOT output placeholder text.

4. For the correction: You MUST read the report below and find the "First Correction" section or recommendations section. Extract what the report says their correction/focus should be. If not explicit, infer from patterns (e.g., high gravity + low signal output might mean correction is about "entry" or "threshold crossing"). DO NOT output placeholder text.

5. For the question: Based on the ACTUAL correction you extracted, formulate ONE specific question. Make it specific to their structure. DO NOT output placeholder text.

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

* Extremely high Gravity (95%) → the old identity has a powerful stabilising pull
* Perfect Signal Coherence (100%) → no fragmentation, no inner chaos
* Very low Signal Output (5%) → not because of weakness, but because entry hadn't happened yet
* CL 2.6 → stabilisation phase
* QGC 41% → genuine creative intelligence present but contained

This is the key sentence from your map, distilled:

> *"Your identity is organized around proving worth through output, and visibility itself activates the pull."*

Your entire correction was about one thing only:
**Entry threshold work — opening the platform for 3 minutes, private, no performance.**

Before I update anything, I need to check one thing — slowly.

Since this report (Dec 31):

Have you opened the platform even once — for 3 minutes, private, no performance — since we last spoke?

Just answer that."

⚠️ CRITICAL: The example above shows the STRUCTURE and FORMAT. You MUST:
1. Read the actual report provided below
2. Extract the ACTUAL metrics values (Gravity %, Signal Coherence %, etc.) from the report
3. Extract the ACTUAL key sentence from the report (look for identity patterns, avoidance patterns, or structural statements)
4. Extract the ACTUAL correction from the report (look for "First Correction" section)
5. Extract the ACTUAL date from the report
6. Formulate ONE specific question based on the ACTUAL correction you extracted

DO NOT copy the example text above - use it only as a format guide. Extract and use ACTUAL content from the report.`
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
      lowerMessage
    );

  // Check for uncertainty responses
  const isUncertain =
    /i don't know|don't know|not sure|unsure|maybe|i'm not sure/i.test(
      lowerMessage
    );

  // Check for somatic responses
  const isSomaticResponse =
    /tight|tightness|ease|relax|tense|body|feel|feeling|sensation/i.test(
      lowerMessage
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

  return `
You are Euphoriam AI working with structure-aware precision.${discoveryTypeContext}

🌑 DISCOVERY MODE - CRITICAL RULES:
- You are in DISCOVERY MODE - working with their existing diagnostic report
- Answer ALL questions naturally and conversationally - do NOT restart diagnostic intake
- Questions about progress, metrics, structure, how to know if they're making progress, etc. should be answered directly
- When users share detailed responses about their structure, avoidance behavior, mastery gaps, business challenges, etc. - RESPOND NATURALLY to what they shared
- Do NOT generate a report just because they gave a detailed answer - continue the conversation
- Only switch to diagnostic mode if user EXPLICITLY says: "create new diagnostic", "start new report", "redo diagnostic", "new diagnostic", etc.
- General questions like "how will i know i made progress?" should be answered naturally - do NOT trigger diagnostic intake
- Let the AI respond naturally without static responses
- IMPORTANT: If you asked a question and the user answered (even if detailed), continue the conversation - do NOT generate a report

CRITICAL APPROACH:

1. RESPONDING TO ABSTRACT/PHILOSOPHICAL LANGUAGE:
   - Users may provide abstract, metaphorical, or philosophical language (e.g., "changing realities", "vortex rules", "mastery gap", "integration mediation", "money exercise", "gap between mirror")
   - This is VALID DATA - treat it as meaningful input about their structure
   - When users use abstract language:
     * Acknowledge their language and validate it ("I hear you speaking about [abstract concept] - that's important data")
     * Ask clarifying questions to understand the concrete experience behind the abstraction
     * Map abstract concepts to structural elements:
       - "Gap" / "mirror" / "vortex rules" → resistance patterns, avoidance, gravity indicators
       - "Mastery gap" → transition phase, identity shift in progress, consciousness level indicators
       - "Integration" / "mediation" / "final milestones" → advanced integration phase, high CL, reduced gravity
       - "Money exercise" / "how money flows" → relationship with resources, abundance patterns, signal coherence indicators
       - References to "structures", "mapping", "reducing gravity", "increasing CL" → direct structural awareness and metric indicators
     * Extract concrete insights while honoring their abstract language
     * Use their language in your responses when appropriate, but also translate to structural terms
   - Example: "When you speak about the 'gap between the mirror of the vortex rules,' I'm hearing something specific about resistance patterns in your structure. Can you tell me what that gap feels like in your body, or what happens when you try to move through it?"

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
   - DO NOT automatically signal report generation - only do so when the user EXPLICITLY requests it
   - The system will automatically detect when the user wants to generate/email a report
   - Continue the conversation naturally - do NOT count questions or try to determine when to generate a report
   - Only signal report generation if the user explicitly says: "email me the report", "generate my report", "send the report", etc.
   - When the user explicitly requests a report, you can acknowledge it, but the system will handle the actual generation
   - IMPORTANT: Do NOT say "I'm going to lock this into a report" or similar unless the user has explicitly requested it

9. TONE:
   - Precise, not vague
   - Respectful of the structure
   - No judgment, no pushing
   - Permission-based, not force-based
   - Acknowledge what IS

${priorReportBlock ? `\nUSER'S DIAGNOSTIC REPORT:\n${priorReportBlock}` : ""}
${factsBlock ? `\nCustomer Context:\n${factsBlock}` : ""}
${contextBlock ? `\n${contextBlock}` : ""}

Current conversation:
${transcript
  .slice(-6)
  .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`)
  .join("\n\n")}

Last user message: "${lastUserMessage}"

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

Respond with structure-aware precision. One question at a time. Work with their system, not against it.`;
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
const getDiscoverySystemPrompt = () => {
  return `You are Euphoriam AI working with structure-aware precision. This is discovery mode - working with their existing diagnostic.

🚨🚨🚨 ABSOLUTE RULE - CRITICAL: NEVER output placeholder text like "[Extract metrics...]", "[Extract the key sentence...]", "[Ask ONE specific question...]", "[YOU MUST READ...]", "[EXTRACT...]", "[FORMULATE...]", or ANY text in square brackets. 

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

1. FIRST MESSAGE (if transcript is empty):
   - CRITICAL: You MUST start with structure reflection, NOT generic greetings
   - NEVER start with "I'm here" or "What would you like to explore today?"
   - NEVER output placeholder text in square brackets - always use actual values
   - ALWAYS start with: "Welcome back. I've loaded your last report."
   - Then: "I want to reflect it back to you first — simply and cleanly — before we move anywhere."
   - Use the ACTUAL metrics values provided in the user prompt (they are formatted and ready to use)
   - Extract and display: Gravity %, Signal Coherence %, Signal Output %, CL, QGC % with interpretations (use the actual numbers, not placeholders)
   - READ THE REPORT PROVIDED IN THE USER PROMPT and extract the ACTUAL key sentence/pattern (use quote format with the actual sentence from the report)
   - READ THE REPORT PROVIDED IN THE USER PROMPT and extract what their correction was about (use actual text from the report, not placeholders)
   - READ THE REPORT PROVIDED IN THE USER PROMPT and formulate ONE specific, targeted question about progress since the report (formulate the actual question based on the actual correction, don't use "[Ask...]")
   - Format: Use bullet points with bold metrics, quote the key sentence, then ask one question
   - Do NOT ask generic questions like "What would you like to explore?" - be precise and specific
   - DO NOT output any text in square brackets - always replace with actual content from the report
   
   ⚠️ REMINDER: The report is provided in the user prompt below. You MUST read it and extract actual content. If you cannot find specific content, make a reasonable inference based on the report content, but NEVER output placeholder text.

2. QUESTION STYLE:
   - Ask ONE question at a time
   - Very specific, targeted questions (not generic)
   - Questions should check specific actions, sensations, or states
   - Examples: "Have you crossed the threshold at all — even once — in the way we defined it (3 minutes, private, no performance)?" or "Does the idea of doing even that create any tightness in your body right now?"

3. RESPONDING TO ANSWERS:
   - "I don't know" is VALID DATA - treat it as information, not failure
   - Acknowledge what "I don't know" means in their structure
   - Never judge uncertainty
   - Work with their resistance, don't push against it

4. MICRO-CORRECTIONS:
   - Give very small, specific actions (e.g., "open platform, close it, that's it")
   - Not symbolic - neurological
   - Explain why it works for their specific structure
   - One correction at a time

5. SOMATIC AWARENESS:
   - Ask about body sensations (tightness, ease, etc.)
   - Notice changes in sensation
   - Body data is as important as cognitive data

6. RESPECT RESISTANCE:
   - If tightness/pushback appears, go smaller, not bigger
   - Don't push entry if resistance is present
   - Go "one layer earlier" - pre-threshold work
   - Permission-based: allow the system to stay the same

7. STRUCTURE-SPECIFIC LANGUAGE:
   - Use their exact metrics and patterns
   - Reference their specific correction from the report
   - Explain why things work for THEIR structure (not generic)
   - Use phrases like "in your system", "for your structure", "this tells me something specific about your structure"

8. TONE:
   - Precise, not vague
   - Respectful of the structure
   - No judgment, no pushing
   - Acknowledge what IS, don't try to fix it
   - Permission-based, not force-based

9. STOPPING POINTS:
   - Know when to stop ("This is enough for today")
   - Let things land
   - Don't overwork
   - Set clear next check-in points

10. KEY PRINCIPLES:
    - High-Gravity systems unlock after safety is affirmed
    - When the protector is not challenged, it loosens on its own
    - Signal begins to move after permission, not before
    - Work with the structure, not against it
    - Precision over volume`;
};
// ============================================================================
// HELPER FUNCTIONS FOR chatbotDiagnosticFreeform
// ============================================================================

/**
 * Validates the chatbot request input
 */
const validateChatbotRequest = (req) => {
  const { email, name } = req.body || {};

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
 */
const loadDiagnosticState = async (email) => {
  const existingDiagnostic = await safeFindDiagnostic({ where: { email } });
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
 * Extracts metrics from report text
 */
const extractMetricsFromReport = (reportText) => {
  if (!reportText) return {};

  // First, try to extract from METRICS GAUGE section specifically
  const metricsGaugeMatch = reportText.match(/METRICS\s+GAUGE[\s\S]{0,1000}/i);
  const searchText = metricsGaugeMatch ? metricsGaugeMatch[0] : reportText;

  // Helper function to extract metric value, handling progress bars
  // Matches patterns like:
  // - "Gravity: 95%"
  // - "Gravity: █████████░░░ 74%"
  // - "Gravity (Load):      █████████░░░ 74%"
  // - "**Gravity** 95%"
  const extractMetric = (label, patterns, isPercentage = true) => {
    for (const pattern of patterns) {
      // Pattern 1: Direct match with optional progress bar
      const match1 = searchText.match(
        new RegExp(
          `${pattern}[:\\s]+(?:[█░\\s]+)?(\\d+(?:\\.\\d+)?)${
            isPercentage ? "%?" : ""
          }`,
          "i"
        )
      );
      if (match1) return parseFloat(match1[1]);

      // Pattern 2: Markdown bold format
      const match2 = searchText.match(
        new RegExp(
          `\\*\\*${pattern}\\*\\*[:\\s]*(?:[█░\\s]+)?(\\d+(?:\\.\\d+)?)${
            isPercentage ? "%?" : ""
          }`,
          "i"
        )
      );
      if (match2) return parseFloat(match2[1]);

      // Pattern 3: With progress bar characters before the number
      const match3 = searchText.match(
        new RegExp(
          `${pattern}[:\\s]+[█░\\s]+(\\d+(?:\\.\\d+)?)${
            isPercentage ? "%" : ""
          }`,
          "i"
        )
      );
      if (match3) return parseFloat(match3[1]);
    }
    return undefined;
  };

  // Extract each metric with multiple pattern variations
  const gravity = extractMetric(
    "Gravity",
    ["Gravity\\s*\\(Load\\)", "Gravity"],
    true
  );

  const signalCoherence = extractMetric(
    "Signal\\s+Coherence",
    ["Signal\\s+Coherence"],
    true
  );

  const signalOutput = extractMetric(
    "Signal\\s+Output",
    ["Signal\\s+Output"],
    true
  );

  const consciousnessLevel = extractMetric(
    "Consciousness\\s+Level",
    ["Consciousness\\s+Level", "CL"],
    false
  );

  const qgcActivation = extractMetric(
    "QGC",
    ["QGC\\s+Activation", "QGC", "Quantum\\s+Genius\\s+Codes"],
    true
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
    (v) => v !== undefined
  ).length;
  if (extractedCount > 0) {
    console.log(
      `[extractMetricsFromReport] Extracted ${extractedCount}/5 metrics:`,
      extracted
    );
  } else {
    // Try to find METRICS GAUGE section in report
    if (metricsGaugeMatch) {
      console.log(
        "[extractMetricsFromReport] Found METRICS GAUGE section but no metrics extracted. Section preview:",
        metricsGaugeMatch[0].substring(0, 500)
      );
    } else {
      console.log(
        "[extractMetricsFromReport] No METRICS GAUGE section found. Report preview:",
        reportText.substring(0, 1000)
      );
    }
  }

  return extracted;
};

/**
 * Loads latest discovery metrics and report
 * Priority: 1) Old discovery report metrics, 2) Last diagnostic report metrics
 */
const loadLatestDiscoveryMetrics = async (
  existingDiagnostic,
  diagnosticMetrics
) => {
  let latestDiscovery = null;
  let latestDiscoveryReport = null;
  let latestDiscoveryMetrics = {};

  // First, try to get metrics from old discovery report (if exists)
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
          latestDiscoveryReport
        );
        if (
          Object.keys(extractedMetrics).some(
            (key) => extractedMetrics[key] !== undefined
          )
        ) {
          latestDiscoveryMetrics = extractedMetrics;
          console.log(
            "[loadLatestDiscoveryMetrics] Using metrics from old discovery report:",
            extractedMetrics
          );
        }
      }
    }
  }

  // If no discovery metrics found, use last diagnostic report metrics
  const hasDiscoveryMetrics =
    latestDiscoveryMetrics &&
    (latestDiscoveryMetrics.gravity !== undefined ||
      latestDiscoveryMetrics.signalCoherence !== undefined ||
      latestDiscoveryMetrics.signalOutput !== undefined);

  if (!hasDiscoveryMetrics) {
    // Try to extract from diagnostic report
    if (existingDiagnostic?.data?.aiReport) {
      const diagnosticReport = existingDiagnostic.data.aiReport;
      const extractedMetrics = extractMetricsFromReport(diagnosticReport);

      if (
        Object.keys(extractedMetrics).some(
          (key) => extractedMetrics[key] !== undefined
        )
      ) {
        latestDiscoveryMetrics = extractedMetrics;
        console.log(
          "[loadLatestDiscoveryMetrics] Using metrics from last diagnostic report:",
          extractedMetrics
        );
      } else if (
        diagnosticMetrics &&
        Object.keys(diagnosticMetrics).length > 0
      ) {
        // Fallback to stored diagnostic metrics
        latestDiscoveryMetrics = diagnosticMetrics;
        console.log(
          "[loadLatestDiscoveryMetrics] Using stored diagnostic metrics:",
          diagnosticMetrics
        );
      }
    } else if (diagnosticMetrics && Object.keys(diagnosticMetrics).length > 0) {
      // No report but have stored metrics
      latestDiscoveryMetrics = diagnosticMetrics;
      console.log(
        "[loadLatestDiscoveryMetrics] Using stored diagnostic metrics (no report):",
        diagnosticMetrics
      );
    }
  }

  return {
    latestDiscovery,
    latestDiscoveryReport,
    latestDiscoveryMetrics,
  };
};

/**
 * Extracts report date from discovery or diagnostic
 */
const extractReportDate = (latestDiscovery, existingDiagnostic) => {
  if (latestDiscovery?.createdAt) {
    return new Date(latestDiscovery.createdAt).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
    });
  }

  if (existingDiagnostic?.data?.generatedAt) {
    return new Date(existingDiagnostic.data.generatedAt).toLocaleDateString(
      "en-US",
      { month: "short", day: "numeric" }
    );
  }

  if (existingDiagnostic?.updatedAt) {
    return new Date(existingDiagnostic.updatedAt).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
    });
  }

  return null;
};

/**
 * Prepares previous reports array for diagnostic payload
 */
const preparePreviousReports = (existingDiagnostic, existingReport) => {
  const existingPreviousReports = Array.isArray(
    existingDiagnostic?.data?.previousReports
  )
    ? existingDiagnostic.data.previousReports
    : [];

  const previousReportEntry =
    existingReport &&
    !existingPreviousReports.some(
      (pr) => pr?.aiReport && pr.aiReport === existingReport
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
      lowerMessage
    ) && !/(don't|dont|no|not|can't|cannot).*(email|send)/i.test(lowerMessage);

  return wantsEmail;
};

/**
 * Determines chat mode (discovery vs diagnostic)
 */
const determineChatMode = (
  hasExistingReport,
  wantsNewDiagnostic,
  intakeInProgress
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
  wantsNewDiagnostic
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
    (a, b) => a - b
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

  // Heuristic: Recognize common simple answers immediately
  const normalizedReply = t.trim();
  const simpleAnswers = ["yes", "no", "y", "n", "yeah", "yep", "nope", "nah"];
  if (simpleAnswers.includes(normalizedReply)) {
    return true; // Accept yes/no answers immediately
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
      model: "gpt-5.2",
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
}) => {
  let userPrompt;
  let systemPrompt;

  if (isDiscoveryMode) {
    userPrompt = buildDiscoveryChatPrompt({
      transcript,
      retrieved,
      factsContext: null,
      userName: name,
      priorReport: priorReportSnippet,
      discoveryType,
      metrics: latestDiscoveryMetrics,
      reportDate,
    });

    systemPrompt = getDiscoverySystemPrompt();
  } else {
    // Diagnostic mode: structured intake
    const intakeTranscript = wantsNewDiagnostic ? [] : transcript;

    const intakeResumeNotice =
      wantsNewDiagnostic && !intakeHasStarted
        ? "I understand you'd like to create a new diagnostic report. We'll start fresh with the 12-Question Deep Intake to map your current structure."
        : resumeNotice;

    const hasAssistantTurn = Boolean(
      transcript.find((m) => m?.role === "assistant")
    );

    const lastUser = [...transcript].reverse().find((m) => m?.role === "user");
    const lastAssistant = [...transcript]
      .reverse()
      .find((m) => m?.role === "assistant");

    const aiAnswered =
      hasAssistantTurn && lastUser
        ? await isAiLikelyAnswer({
            question: lastAssistant?.content || "",
            reply: lastUser?.content || "",
          })
        : false;

    userPrompt =
      !hasAssistantTurn || (wantsNewDiagnostic && !intakeHasStarted)
        ? buildFreeformIntakePrompt({
            transcript: intakeTranscript,
            targetCount,
            introPageText: introText,
            factsContext: null,
            retrieved,
            userName: name,
            lastMessageFromAssistant:
              wantsNewDiagnostic && !intakeHasStarted
                ? false
                : Boolean(lastAssistant),
            resumeNotice: intakeResumeNotice,
            priorReport: priorReportSnippet, // Keep prior report for context even when starting new diagnostic
            distinctQuestionNumbers: [],
            wantsNewDiagnostic: wantsNewDiagnostic && !intakeHasStarted, // Pass flag to customize first question
          })
        : aiAnswered
        ? buildFreeformIntakePrompt({
            transcript,
            targetCount,
            introPageText: introText,
            factsContext: null,
            retrieved,
            userName: name,
            lastMessageFromAssistant: Boolean(lastAssistant),
            resumeNotice,
            priorReport: priorReportSnippet,
            distinctQuestionNumbers: distinctQuestionNumbers,
          })
        : `The user's reply may not fully answer the last question. 

Last question: "${lastAssistant?.content || ""}"
User reply: "${lastUser?.content || ""}"

IMPORTANT RULES:
1. If the user's reply is CLEAR and UNDERSTANDABLE (even if short like "completely alone", "at home", "balcony", "yes", "no"), ACCEPT it and MOVE TO THE NEXT QUESTION immediately. Do NOT ask for confirmation.
2. Only rephrase/clarify if the reply is truly unclear, ambiguous, or contradictory.
3. DO NOT ask redundant confirmations like "Just to confirm..." or "Just to make sure..." - if you understand the answer, acknowledge it briefly and move forward.
4. If the user has provided a clear answer, acknowledge it with "Got it" or similar and proceed to the next question.
5. Only stay on the same question number if the answer is genuinely unclear or the user asked a clarifying question.

Return your response following these rules.`;

    systemPrompt = EUPHORIAM_FREEFORM_INTAKE_SYSTEM_PROMPT;
  }

  return { userPrompt, systemPrompt };
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

  try {
    const aiResponse = await openai.chat.completions.create({
      model: "gpt-5.2",
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
 * Get latest prompt from database
 */
const getLatestPromptFromDb = async () => {
  try {
    const prompt = await Prompt.findOne({
      where: { isActive: true },
      order: [["createdAt", "DESC"]],
      raw: true,
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

module.exports = {
  DEEP_INTAKE_QUESTIONS,
  buildIntakeQuestionResponse,
  buildFinalReportPrompt,
  DEFAULT_INTRO_PAGE_TEXT,
  EUPHORIAM_FREEFORM_INTAKE_SYSTEM_PROMPT,
  buildFreeformIntakePrompt,
  buildDiscoveryChatPrompt,
  sanitizeReportText,
  getDiscoverySystemPrompt,
  buildChatPrompts,
  // Helper functions for chatbotDiagnosticFreeform
  validateChatbotRequest,
  loadDiagnosticState,
  loadLatestDiscoveryMetrics,
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
};
