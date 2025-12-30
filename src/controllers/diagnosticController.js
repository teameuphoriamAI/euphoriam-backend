const fs = require("fs");
const { Diagnostic } = require("../models/diagnosticModel");
const { Discovery } = require("../models/discoveryModel");
const { Prompt } = require("../models/promptModel");
const { User } = require("../models/userModel");
const validate = require("../helpers/validate");
const openai = require("../config/openai");

const {
  EUPHORIAM_V3_SYSTEM_PROMPT,
  buildFinalReportPrompt,
  DEFAULT_INTRO_PAGE_TEXT,
  EUPHORIAM_FREEFORM_INTAKE_SYSTEM_PROMPT,
  buildFreeformIntakePrompt,
  buildDiscoveryChatPrompt,
  sanitizeReportText,
} = require("../helpers/euphoriamChatbot");
const { retrieveSimilarChunks } = require("../helpers/rag");
const { successResponse, errorResponse } = require("../utils/response");
const {
  getCustomerByEmail,
  getCustomerFullDetails,
  getSiteById,
  getContactById,
  getOfferById,
  getAssessmentProgressForCustomer,
  getCourseWithPosts,
  extractAssessmentsFromCourse,
  getProductWithCourse,
  extractCourseIdFromProduct,
} = require("./kajabi");
const { generateDiagnosticPdf } = require("../utils/diagnosticPdf");
const { uploadBufferToSupabase } = require("../utils/storage");
const { sendEmail, sendEmailBasic } = require("../utils/email");
const {
  diagnosticReportEmail,
} = require("../utils/emailTemplate/initialDignosticReport");

const isQuestion = (text = "") => text.trim().endsWith("?");
const isAnswerLike = (text = "") => {
  const t = (text || "").trim();
  if (!t) return false;
  if (isQuestion(t)) return false;
  const alpha = t.match(/[A-Za-z]/g);
  // Relaxed: Allow short answers like "yes", "A", or "d,d,d"
  return alpha && alpha.length >= 1 && t.length >= 1;
};

// Extracts "Q<number>" from an assistant message to track distinct intake topics.
const extractQuestionNumber = (text = "") => {
  const match = (text || "").match(/Q\s*(\d{1,2})/i);
  return match ? Number(match[1]) : null;
};

const isCreatorClubMember = (context = {}) => {
  const hasProduct = (context.products || []).some((p) =>
    (p.title || "").toLowerCase().includes("creator club")
  );
  const hasOffer = (context.offers || []).some((o) =>
    (o.title || "").toLowerCase().includes("creator club")
  );
  return hasProduct || hasOffer;
};
const findOrCreateCreatorUser = async ({ email, name }) => {
  let user = await User.findOne({ where: { email } });

  if (!user) {
    user = await User.create({
      email,
      name,
    });
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

const clamp = (n, min, max) => Math.min(max, Math.max(min, n));

const summarizeCourseAssessments = (courseAssessments) => {
  const courses = Array.isArray(courseAssessments) ? courseAssessments : [];

  const totals = courses.reduce(
    (acc, c) => {
      acc.totalAssessments += Number(c.total || 0);
      acc.completed += Array.isArray(c.completed) ? c.completed.length : 0;
      acc.passed += Array.isArray(c.passed) ? c.passed.length : 0;
      acc.failed += Array.isArray(c.failed) ? c.failed.length : 0;
      acc.pending += Array.isArray(c.pending) ? c.pending.length : 0;
      return acc;
    },
    { totalAssessments: 0, completed: 0, passed: 0, failed: 0, pending: 0 }
  );

  const completionPercentage = totals.totalAssessments
    ? Math.round((totals.completed / totals.totalAssessments) * 100)
    : 0;

  const passRate = totals.completed
    ? Math.round((totals.passed / totals.completed) * 100)
    : 0;

  return {
    ...totals,
    completionPercentage,
    passRate,
    coursesCount: courses.length,
  };
};

const computeDiagnosticMetrics = ({
  signInCount = 0,
  netRevenue = 0,
  products = [],
  offers = [],
  courseAssessments = [],
}) => {
  const safeSignIns = Number(signInCount || 0);
  const safeRevenue = Number(netRevenue || 0);

  const productTypeCounts = (Array.isArray(products) ? products : []).reduce(
    (acc, p) => {
      const type = p?.type || "Unknown";
      acc[type] = (acc[type] || 0) + 1;
      return acc;
    },
    {}
  );

  const assessmentSummary = summarizeCourseAssessments(courseAssessments);

  // Reduced weight on engagement (log-ins) - focus more on life experience
  const engagementScore = clamp(Math.round(safeSignIns * 4), 0, 100); // Reduced from 6.25 to 4
  const learningScore = clamp(assessmentSummary.completionPercentage, 0, 100);
  const commitmentScore = clamp(
    Math.round(
      Math.min(100, safeRevenue / 10) +
        (Array.isArray(products) ? products.length : 0) * 8
    ),
    0,
    100
  );

  // Adjusted weights: less on engagement, more on learning and commitment (life results)
  const signalOutput = clamp(
    Math.round(
      0.3 * engagementScore + 0.4 * learningScore + 0.3 * commitmentScore
    ),
    0,
    100
  );

  const signalCoherence = clamp(
    Math.round(100 - Math.abs(engagementScore - learningScore) * 0.75),
    0,
    100
  );

  const gravity = clamp(100 - signalOutput, 0, 100);

  const consciousnessLevel = Number(
    (1 + (4 * (0.6 * learningScore + 0.4 * signalCoherence)) / 100).toFixed(1)
  ); // 1.0 - 5.0 proxy index

  const qgcActivation = clamp(
    Math.round(
      0.4 * commitmentScore + 0.35 * signalCoherence + 0.25 * learningScore
    ),
    0,
    100
  );

  return {
    engagementScore,
    learningScore,
    commitmentScore,
    gravity,
    signalOutput,
    signalCoherence,
    consciousnessLevel,
    qgcActivation,
    counts: {
      signInCount: safeSignIns,
      netRevenue: safeRevenue,
      productCount: Array.isArray(products) ? products.length : 0,
      offerCount: Array.isArray(offers) ? offers.length : 0,
      productTypeCounts,
    },
    assessments: assessmentSummary,
  };
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

const pick = (obj, keys) =>
  keys.reduce((acc, k) => {
    if (obj && obj[k] !== undefined) acc[k] = obj[k];
    return acc;
  }, {});

const normalizeKajabiOffer = (o) => {
  const data = o?.data;
  const attributes = data?.attributes || {};
  return {
    id: data?.id,
    title: attributes.title,
    price: attributes.price,
    createdAt: attributes.created_at,
  };
};

const normalizeKajabiProduct = (p) => {
  const data = p?.data;
  const attributes = data?.attributes || {};
  const links = p?.links || {};
  return {
    id: data?.id,
    title: attributes.title,
    type: attributes.product_type_name,
    status: attributes.status,
    publishStatus: attributes.publish_status,
    createdAt: attributes.created_at,
    url: attributes.url,
    thumbnailUrl: attributes.thumbnail_url,
    membersCount: attributes.members_aggregate_count,
    apiSelf: links.self,
  };
};

const normalizeKajabiSite = (s) => {
  const data = s?.data;
  const attributes = data?.attributes || {};
  return {
    id: data?.id,
    name: attributes.name,
    subdomain: attributes.subdomain,
  };
};

const normalizeKajabiContact = (c) => {
  const data = c?.data;
  const attributes = data?.attributes || {};
  return {
    id: data?.id,
    ...pick(attributes, ["first_name", "last_name", "email", "phone_number"]),
  };
};
// this function gives the full kajabi context for a given customer email
const buildKajabiDiagnosticContext = async ({ email, assessmentIds = [] }) => {
  const customerInfo = await getCustomerByEmail(email);
  const customerDetails = await getCustomerFullDetails(customerInfo.id);

  const customerData = customerDetails.data;
  const attributes = customerData.attributes;
  const rel = customerData.relationships;

  // Resolve relations
  const siteId = rel.site?.data?.id;
  const contactId = rel.contact?.data?.id;

  const offerIds = rel.offers?.data?.map((o) => o.id) || [];
  const productIds = rel.products?.data?.map((p) => p.id) || [];

  const site = siteId ? await getSiteById(siteId) : null;
  const contact = contactId ? await getContactById(contactId) : null;
  const offers = await Promise.all(offerIds.map((id) => getOfferById(id)));
  const products = await Promise.all(
    productIds.map((id) => getProductWithCourse(id))
  );

  const courseAssessments = [];

  for (const product of products) {
    const productData = product?.data;
    const productType = productData?.attributes?.product_type_name;

    // Only process COURSE products
    if (productType !== "Course") {
      console.log(
        `⏭ Skipping non-course product: ${productData?.attributes?.title}`
      );
      continue;
    }

    // Extract linked course ID
    const courseId = extractCourseIdFromProduct(product);

    if (!courseId) {
      console.log(
        `⚠️ No course linked to product: ${productData?.attributes?.title}`
      );
      continue;
    }

    console.log(
      `📘 Fetching course ${courseId} for product ${productData.attributes.title}`
    );

    // Fetch course with posts
    const courseData = await getCourseWithPosts(courseId);

    // Extract assessments from posts
    const assessments = extractAssessmentsFromCourse(courseData);

    if (!assessments.length) {
      console.log(`ℹ️ No assessments found in course ${courseId}`);
      continue;
    }

    // Get customer progress (completed / passed / failed)
    const progress = await getAssessmentProgressForCustomer(
      customerData.id,
      assessments
    );

    courseAssessments.push({
      courseId,
      courseTitle: productData.attributes.title,
      assessmentCount: assessments.length,
      ...progress,
    });
  }

  const normalizedProducts = products.map(normalizeKajabiProduct);
  const normalizedOffers = offers.map(normalizeKajabiOffer);
  const metrics = computeDiagnosticMetrics({
    signInCount: attributes.sign_in_count,
    netRevenue: attributes.net_revenue,
    products: normalizedProducts,
    offers: normalizedOffers,
    courseAssessments,
  });

  const diagnosticContext = {
    customer: {
      id: customerData.id,
      name: attributes.name,
      email: attributes.email,
      signInCount: attributes.sign_in_count,
      netRevenue: attributes.net_revenue,
      memberSince: attributes.created_at,
    },
    site: normalizeKajabiSite(site),
    contact: normalizeKajabiContact(contact),
    offers: normalizedOffers,
    products: normalizedProducts,
    courseAssessments,
    metrics,
  };

  return {
    diagnosticContext,
    courseAssessments,
    normalizedProducts,
    normalizedOffers,
    metrics,
    site,
    contact,
    customerData,
    attributes,
    contactId,
    siteId,
  };
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

  if (!email) {
    return errorResponse(res, "Email is required", 400);
  }
  if (!name) {
    return errorResponse(res, "Name is required", 400);
  }

  // Load any existing diagnostic/intake state for this email to support resume.
  const existingDiagnostic = await Diagnostic.findOne({ where: { email } });
  const existingState = existingDiagnostic?.data?.intakeState || {};
  const existingReport = existingDiagnostic?.data?.aiReport;
  // Extract metrics from diagnostic data
  const diagnosticMetrics = existingDiagnostic?.data?.metrics || {};
  // Extract report date
  const reportDate = existingDiagnostic?.data?.generatedAt
    ? new Date(existingDiagnostic.data.generatedAt).toLocaleDateString(
        "en-US",
        { month: "short", day: "numeric" }
      )
    : existingDiagnostic?.updatedAt
    ? new Date(existingDiagnostic.updatedAt).toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
      })
    : null;
  // Use larger limit to ensure full report is available for discovery conversations
  const priorReportSnippet = truncateForContext(existingReport, 12000);
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
  const previousReports = previousReportEntry
    ? [...existingPreviousReports, previousReportEntry]
    : existingPreviousReports;
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

  // Prefer request transcript; fall back to stored state if request is empty.
  // For completed diagnostics, start a fresh discovery transcript instead of reusing the intake transcript.
  const useExistingTranscript =
    !hasExistingReport &&
    Array.isArray(existingState.transcript) &&
    existingState.transcript.length;
  const transcript =
    Array.isArray(messages) && messages.length
      ? messages
      : useExistingTranscript
      ? existingState.transcript
      : [];
  const lastTurn = transcript[transcript.length - 1];
  const lastTurnAssistant = lastTurn?.role === "assistant";
  // Show resume notice when resuming after an assistant turn (only for diagnostic mode, not discovery).
  const baseResumeNotice =
    !hasExistingReport && transcript.length > 0 && lastTurnAssistant
      ? `Welcome back ${name}, let's continue where we left off.`
      : null;
  // Don't set returningReportNotice for discovery mode - let the discovery chat prompt handle the greeting naturally
  const resumeNotice = baseResumeNotice;

  const answered = transcript.filter(
    (m) => m?.role === "user" && isAnswerLike(m.content || "")
  ).length;
  const asked = transcript.filter((m) => m?.role === "assistant").length;
  const introText = introPageText || DEFAULT_INTRO_PAGE_TEXT;
  const targetCountForRun = hasExistingReport
    ? Math.min(targetCount, 6)
    : targetCount;

  if (!finalize) {
    // Pull Kajabi context even during intake to keep questions on-topic.
    const { diagnosticContext, metrics } = await buildKajabiDiagnosticContext({
      email,
      assessmentIds,
    });

    // Membership gate: require Creator Club
    if (!isCreatorClubMember(diagnosticContext)) {
      return errorResponse(
        res,
        "You are not a Creator Club member. Please subscribe or purchase to use the chatbot.",
        403
      );
    }

    const appUser = await findOrCreateCreatorUser({
      email,
      name,
    });

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

    // Track distinct question numbers asked so far to avoid skipping numbers on rephrases.
    const assistantQuestionNumbers = transcript
      .filter((m) => m?.role === "assistant")
      .map((m) => extractQuestionNumber(m.content))
      .filter((n) => typeof n === "number");
    const maxQuestionNumber =
      assistantQuestionNumbers.length > 0
        ? Math.max(...assistantQuestionNumbers)
        : 0;

    // Determine if the last user turn actually answered the last assistant question.
    const pendingQuestion = hasAssistantTurn && !aiAnswered;

    // Use discovery chat prompt for returning users with existing reports
    const isDiscoveryMode = hasExistingReport;

    let userPrompt;
    let systemPrompt;

    if (isDiscoveryMode) {
      // Discovery mode: freeform conversational chat
      // Determine discovery type from request or default to integrated
      const discoveryType = req.body.discoveryType || null; // 'alignment', 'freedom', 'prosperity', or null for integrated

      userPrompt = buildDiscoveryChatPrompt({
        transcript,
        retrieved,
        factsContext: diagnosticContext,
        userName: name,
        priorReport: priorReportSnippet,
        discoveryType,
        metrics: diagnosticMetrics, // Pass actual metrics data
        reportDate: reportDate, // Pass report date
      });

      systemPrompt = `You are Euphoriam AI working with structure-aware precision. This is discovery mode - working with their existing diagnostic.

🚨 ABSOLUTE RULE: NEVER output placeholder text like "[Extract metrics...]", "[Extract the key sentence...]", "[Ask ONE specific question...]", or any text in square brackets. Always use actual values, actual sentences, and actual questions.

🌑 CRITICAL APPROACH (Structure-Aware Discovery):

1. FIRST MESSAGE (if transcript is empty):
   - CRITICAL: You MUST start with structure reflection, NOT generic greetings
   - NEVER start with "I'm here" or "What would you like to explore today?"
   - NEVER output placeholder text in square brackets - always use actual values
   - ALWAYS start with: "Welcome back. I've loaded your last report."
   - Then: "I want to reflect it back to you first — simply and cleanly — before we move anywhere."
   - Use the ACTUAL metrics values provided in the user prompt (they are formatted and ready to use)
   - Extract and display: Gravity %, Signal Coherence %, Signal Output %, CL, QGC % with interpretations (use the actual numbers, not placeholders)
   - Identify the key sentence/pattern from their report (use quote format with the actual sentence)
   - State what their correction was about (what the report pointed to - use actual text, not placeholders)
   - THEN ask ONE specific, targeted question about progress since the report (formulate the actual question, don't use "[Ask...]")
   - Format: Use bullet points with bold metrics, quote the key sentence, then ask one question
   - Do NOT ask generic questions like "What would you like to explore?" - be precise and specific
   - DO NOT output any text in square brackets - always replace with actual content

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
    } else {
      // Diagnostic mode: structured intake
      userPrompt = !hasAssistantTurn
        ? buildFreeformIntakePrompt({
            transcript,
            targetCount: targetCountForRun,
            introPageText: introText,
            factsContext: diagnosticContext,
            retrieved,
            userName: name,
            lastMessageFromAssistant: lastTurnAssistant,
            resumeNotice,
            priorReport: priorReportSnippet,
          })
        : aiAnswered
        ? buildFreeformIntakePrompt({
            transcript,
            targetCount: targetCountForRun,
            introPageText: introText,
            factsContext: diagnosticContext,
            retrieved,
            userName: name,
            lastMessageFromAssistant: lastTurnAssistant,
            resumeNotice,
            priorReport: priorReportSnippet,
          })
        : `The user has NOT answered the last question. Do NOT move to the next question. 
Rephrase and clarify the SAME question only, briefly acknowledge their confusion, and invite them to answer that question now.

Last question: "${lastAssistant?.content || ""}"
User reply: "${lastUser?.content || ""}"

Return only the clarified form of that same question (plus a short acknowledgment), nothing else. 
Do NOT emit a new question number; stay on the same question.`;

      systemPrompt = EUPHORIAM_FREEFORM_INTAKE_SYSTEM_PROMPT;
    }

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
            
            const metricsSection = gravity !== undefined && signalCoherence !== undefined && signalOutput !== undefined && consciousnessLevel !== undefined && qgcActivation !== undefined
              ? `
* **${gravity >= 80 ? 'Extremely high' : gravity >= 60 ? 'High' : gravity >= 40 ? 'Moderate' : 'Low'} Gravity (${gravity}%)** → ${gravity >= 80 ? 'the old identity has a powerful stabilising pull' : gravity >= 60 ? 'the old identity has a strong pull' : 'the old identity has some pull'}
* **${signalCoherence >= 90 ? 'Perfect' : signalCoherence >= 70 ? 'High' : signalCoherence >= 50 ? 'Moderate' : 'Low'} Signal Coherence (${signalCoherence}%)** → ${signalCoherence >= 90 ? 'no fragmentation, no inner chaos' : signalCoherence >= 70 ? 'minimal fragmentation' : 'some fragmentation present'}
* **${signalOutput <= 10 ? 'Very low' : signalOutput <= 30 ? 'Low' : signalOutput <= 50 ? 'Moderate' : 'High'} Signal Output (${signalOutput}%)** → ${signalOutput <= 10 ? 'not because of weakness, but because entry hadn\'t happened yet' : signalOutput <= 30 ? 'entry is beginning but not fully established' : 'signal is flowing'}
* **CL ${consciousnessLevel}** → ${consciousnessLevel <= 2 ? 'early stabilisation phase, not expansion phase' : consciousnessLevel <= 3 ? 'stabilisation phase' : consciousnessLevel <= 4 ? 'expansion phase beginning' : 'expansion phase'}
* **QGC ${qgcActivation}%** → ${qgcActivation >= 60 ? 'genuine creative intelligence fully activated' : qgcActivation >= 40 ? 'genuine creative intelligence present but contained' : 'creative intelligence present but not yet activated'}`
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
              const keySentenceMatch = priorReportSnippet.match(
                /(?:key sentence|distilled|pattern)[\s\S]{0,200}["']([^"']{10,150})["']/i
              ) || priorReportSnippet.match(/["']([^"']{20,100}(?:will|must|can't|won't)[^"']{0,50})["']/i)
              || priorReportSnippet.match(/(?:I will|I must|I can't|I won't)[^.\n]{10,80}/i);
              
              if (keySentenceMatch) {
                keySentence = keySentenceMatch[1] || keySentenceMatch[0];
                keySentence = keySentence.trim().substring(0, 120);
              }
              
              // Look for correction section
              const correctionMatch = priorReportSnippet.match(
                /(?:First Correction|correction|recommendation)[\s\S]{0,300}(.{50,200})/i
              ) || priorReportSnippet.match(/(?:gentle|repeatable|entry|threshold|micro-correction)[\s\S]{0,200}(.{30,150})/i);
              
              if (correctionMatch) {
                correction = correctionMatch[1].trim().substring(0, 150);
              }
            }
            
            const keySentenceText = keySentence 
              ? `> *"${keySentence}"*`
              : `> *"[Extract the key sentence/pattern from the report]"*`;
            
            const correctionText = correction
              ? `**${correction}**`
              : `**[State what the report pointed to - their correction]**`;
            
            const questionText = correction
              ? `Since this report (${reportDate || 'recently'}), have you made any progress on ${correction.substring(0, 50)}?`
              : `Since this report (${reportDate || 'recently'}), what has changed or stayed the same?`;
            
            nextMessage = {
              role: "assistant",
              content: `Welcome back. I've loaded your last report.

I want to reflect it back to you first — simply and cleanly — before we move anywhere.

Your structure at the last check-in was very clear:
${metricsSection}

This is the key sentence from your map, distilled:

${keySentenceText}

${correction ? `Nothing in your report pointed to laziness, lack of capacity, or being "behind." It pointed to your structure — ${correction.substring(0, 100)}.` : ''}

Your **entire correction** was about one thing only:
${correctionText}

Before I update anything, I need to check one thing — slowly.

**Since this report (${reportDate || 'recently'}):**

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
          
          const metricsSection = gravity !== undefined && signalCoherence !== undefined && signalOutput !== undefined && consciousnessLevel !== undefined && qgcActivation !== undefined
            ? `
* **${gravity >= 80 ? 'Extremely high' : gravity >= 60 ? 'High' : gravity >= 40 ? 'Moderate' : 'Low'} Gravity (${gravity}%)** → ${gravity >= 80 ? 'the old identity has a powerful stabilising pull' : gravity >= 60 ? 'the old identity has a strong pull' : 'the old identity has some pull'}
* **${signalCoherence >= 90 ? 'Perfect' : signalCoherence >= 70 ? 'High' : signalCoherence >= 50 ? 'Moderate' : 'Low'} Signal Coherence (${signalCoherence}%)** → ${signalCoherence >= 90 ? 'no fragmentation, no inner chaos' : signalCoherence >= 70 ? 'minimal fragmentation' : 'some fragmentation present'}
* **${signalOutput <= 10 ? 'Very low' : signalOutput <= 30 ? 'Low' : signalOutput <= 50 ? 'Moderate' : 'High'} Signal Output (${signalOutput}%)** → ${signalOutput <= 10 ? 'not because of weakness, but because entry hadn\'t happened yet' : signalOutput <= 30 ? 'entry is beginning but not fully established' : 'signal is flowing'}
* **CL ${consciousnessLevel}** → ${consciousnessLevel <= 2 ? 'early stabilisation phase, not expansion phase' : consciousnessLevel <= 3 ? 'stabilisation phase' : consciousnessLevel <= 4 ? 'expansion phase beginning' : 'expansion phase'}
* **QGC ${qgcActivation}%** → ${qgcActivation >= 60 ? 'genuine creative intelligence fully activated' : qgcActivation >= 40 ? 'genuine creative intelligence present but contained' : 'creative intelligence present but not yet activated'}`
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
            const keySentenceMatch = priorReportSnippet.match(
              /(?:key sentence|distilled|pattern)[\s\S]{0,200}["']([^"']{10,150})["']/i
            ) || priorReportSnippet.match(/["']([^"']{20,100}(?:will|must|can't|won't)[^"']{0,50})["']/i)
            || priorReportSnippet.match(/(?:I will|I must|I can't|I won't)[^.\n]{10,80}/i);
            
            if (keySentenceMatch) {
              keySentence = keySentenceMatch[1] || keySentenceMatch[0];
              keySentence = keySentence.trim().substring(0, 120);
            }
            
            // Look for correction section
            const correctionMatch = priorReportSnippet.match(
              /(?:First Correction|correction|recommendation)[\s\S]{0,300}(.{50,200})/i
            ) || priorReportSnippet.match(/(?:gentle|repeatable|entry|threshold|micro-correction)[\s\S]{0,200}(.{30,150})/i);
            
            if (correctionMatch) {
              correction = correctionMatch[1].trim().substring(0, 150);
            }
          }
          
          const keySentenceText = keySentence 
            ? `> *"${keySentence}"*`
            : `> *"[Extract the key sentence/pattern from the report]"*`;
          
          const correctionText = correction
            ? `**${correction}**`
            : `**[State what the report pointed to - their correction]**`;
          
          const questionText = correction
            ? `Since this report (${reportDate || 'recently'}), have you made any progress on ${correction.substring(0, 50)}?`
            : `Since this report (${reportDate || 'recently'}), what has changed or stayed the same?`;

          nextMessage = {
            role: "assistant",
            content: `Welcome back. I've loaded your last report.

I want to reflect it back to you first — simply and cleanly — before we move anywhere.

Your structure at the last check-in was very clear:
${metricsSection}

This is the key sentence from your map, distilled:

${keySentenceText}

${correction ? `Nothing in your report pointed to laziness, lack of capacity, or being "behind." It pointed to your structure — ${correction.substring(0, 100)}.` : ''}

Your **entire correction** was about one thing only:
${correctionText}

Before I update anything, I need to check one thing — slowly.

**Since this report (${reportDate || 'recently'}):**

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

    // Compute distinct questions answered: count completed question numbers only, excluding the pending one.
    const answeredCount = maxQuestionNumber
      ? maxQuestionNumber - (pendingQuestion ? 1 : 0)
      : 0;

    // Persist intake progress (draft) so we can resume after refresh.
    const intakeState = {
      transcript: updatedTranscript,
      acceptedAnswers,
      answeredCount,
      lastQuestionNumber: maxQuestionNumber,
      pendingQuestion,
      updatedAt: new Date().toISOString(),
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

    // If we've gathered all answers, auto-generate the diagnostic/PDF (only for first-time diagnostics).
    if (
      !hasExistingReport &&
      answeredCount >= targetCount &&
      !pendingQuestion &&
      aiAnswered
    ) {
      const {
        courseAssessments,
        normalizedProducts,
        normalizedOffers,
        metrics,
        customerData,
        attributes,
        contactId,
        siteId,
      } = await buildKajabiDiagnosticContext({ email, assessmentIds });

      const finalizeRetrieved = lastUser?.content
        ? await retrieveSimilarChunks({ query: lastUser.content, topK: 3 })
        : [];
      const prompt = await getLatestPromptFromDb();
      // Extract string content from prompt object, or use fallback
      const promptContent =
        typeof prompt === "string"
          ? prompt
          : prompt?.fullPrompt || prompt?.content || EUPHORIAM_V3_SYSTEM_PROMPT;
      const finalizeResponse = await openai.chat.completions.create({
        model: "gpt-5.2",
        messages: [
          { role: "system", content: promptContent },
          {
            role: "user",
            content: buildFinalReportPrompt({
              customerContext: diagnosticContext,
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

      const diagnosticPayload = {
        userId: appUser.id || null,
        email: email.trim(),
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
          previousReports,
          intakeTranscript: updatedTranscript,
          aiReport: reportText,
          intakeState: {
            ...intakeState,
            finalizedAt: new Date().toISOString(),
          },
          rawSource: {
            kajabiCustomerId: customerData.id,
            kajabiContactId: contactId,
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
        attributes.email,
        "Your Diagnostic Report – Euphoraum-AI",
        diagnosticReportEmail(attributes.name),
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
        statusMessage: "Report generated, PDF compiled, and emailed successfully",
        userMessage: `Your new diagnostic report has been generated and emailed to ${email}. Please check your inbox.`,
      });
    }

    // For discovery mode: Check if user wants to end/generate report or has replied perfectly
    // Also check if the bot previously signaled the end and user just responded
    if (isDiscoveryMode && lastUser) {
      const { 
        detectUserWantsToEndOrGenerateReport, 
        detectConversationComplete,
        detectBotSignaledEnd 
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
      const conversationComplete = botPreviouslySignaledEnd || await detectConversationComplete({
        transcript: updatedTranscript,
        lastUserMessage: lastUser,
        lastAssistantMessage: lastAssistant, // Check the previous assistant message
      });

      // If user wants to end/generate report OR conversation is complete, generate discovery report
      if (wantsToEndOrGenerate || conversationComplete) {
        // Build Kajabi context to get attributes
        const {
          diagnosticContext: discoveryContext,
          attributes: discoveryAttributes,
        } = await buildKajabiDiagnosticContext({ email, assessmentIds });

        // Get previous discovery if exists
        const previousDiscoveries = await Discovery.findAll({
          where: { 
            userId: existingDiagnostic?.userId || appUser?.id || null 
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

${previousDiscovery ? `Previous discovery report (reference):
${truncateForContext(previousDiscovery.data?.newReportSnippet || previousDiscovery.data?.newReport || "", 4000)}` : ""}

New conversation transcript (latest messages last):
${JSON.stringify(updatedTranscript, null, 2)}

Client Name: ${discoveryAttributes?.name || name}
Client ID: ${discoveryContext?.customer?.id || "N/A"}
Report Type: Full Diagnostic (Updated)
Date: ${new Date().toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}

Generate a FULL DISCOVERY REPORT following this EXACT format:

EUPHORIAM™ FULL DIAGNOSTIC REPORT

Client: [Client Name]
Client ID: [Client ID]
Report Type: Full Diagnostic (Updated)
Prepared by: Euphoriam AI
Date: [Date]

BEFORE YOU READ THIS

This document is not feedback.
It is structural recognition.

Nothing here is asking you to improve, fix, or push.
It describes the forces governing your movement, your pauses, and your timing.

Your system does not respond to motivation.
It responds to safety, consent, and coherence.

Read slowly.
Let it land in the body, not the mind.

SECTION 1 — CORE STRUCTURE DETECTION
[Analyze their primary structure based on metrics and conversation]

SECTION 2 — AVOIDANCE BEHAVIOUR (REFINED)
[Identify their avoidance patterns from the conversation]

SECTION 3 — VORTEX MAPPING
[Map their vortex type and activation points]

SECTION 4 — SOMATIC CONFIRMATION
[Body data observed from the conversation]

SECTION 5 — GRAVITY (3D CODE)
[Gravity percentage and what it's doing]

SECTION 6 — CONSCIOUSNESS LEVEL
[CL level and interpretation]

SECTION 7 — QUANTUM GENIUS CODES (QGC)
[QGC activation percentage and what it looks like]

SECTION 8 — SIGNAL COHERENCE & OUTPUT
[Signal Coherence and Signal Output analysis]

SECTION 9 — ANGLE OF GROWTH (UPDATED)
[Their growth axis based on structure]

SECTION 10 — FIRST CORRECTION (COMPLETED)
[What corrections were made in this session]

SECTION 11 — UNLIMITED CREATOR ALIGNMENT
[Aligned work based on their structure]

FINAL SUMMARY
[Summary paragraph]

Use the exact metrics from the diagnostic:
- Gravity: ${diagnosticMetrics.gravity || "N/A"}%
- Signal Coherence: ${diagnosticMetrics.signalCoherence || "N/A"}%
- Signal Output: ${diagnosticMetrics.signalOutput || "N/A"}%
- CL: ${diagnosticMetrics.consciousnessLevel || "N/A"}
- QGC: ${diagnosticMetrics.qgcActivation || "N/A"}%

Generate the full report in this format.`;

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
            title: `Discovery Follow-up – ${discoveryAttributes?.name || name}`,
            userId: userForDiscovery?.id || existingDiagnostic?.userId || null,
            data: {
              profile: {
                name: discoveryAttributes?.name || name,
                email: email,
              },
              aiReport: discoveryReport,
              metrics: diagnosticMetrics,
              customerId: discoveryContext?.customer?.id || null,
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
                objectPath: `discoveries/discovery-${existingDiagnostic?.id || Date.now()}-${Date.now()}.pdf`,
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
            title: `Discovery Follow-up – ${discoveryAttributes?.name || name}`,
            transcript: updatedTranscript,
            previousReport: priorReportSnippet,
            newReport: discoveryReport,
            diagnosticId: existingDiagnostic?.id || null,
            pdfUrl: pdfUrl || existingDiagnostic?.data?.pdf?.url || null,
            discoveryType,
          });

          if (email) {
            const { discoveryReportEmail } = require("../utils/emailTemplate/initialDiscoveryReport");
            // Email with PDF attachment if available
            if (pdfPath) {
              await sendEmail(
                email,
                "Your Discovery Report – Euphoriam AI",
                discoveryReportEmail(discoveryAttributes?.name || name),
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
            statusMessage: "Report generated, PDF compiled, and emailed successfully",
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

  // Finalize: if existing report, save discovery summary; otherwise generate full diagnostic.
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
  } = await buildKajabiDiagnosticContext({ email, assessmentIds });

  if (!isCreatorClubMember(diagnosticContext)) {
    return errorResponse(
      res,
      "You are not a Creator Club member. Please subscribe or purchase to use the chatbot.",
      403
    );
  }

  // Find or create user for finalize path
  const appUser = await findOrCreateCreatorUser({
    email,
    name,
  });

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
        userId: existingDiagnostic?.userId || appUser?.id || null 
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

${previousDiscovery ? `Previous discovery report (reference):
${truncateForContext(previousDiscovery.data?.newReportSnippet || previousDiscovery.data?.newReport || "", 4000)}` : ""}

New conversation transcript (latest messages last):
${JSON.stringify(transcriptForFinal, null, 2)}

Client Name: ${attributes.name || name}
Client ID: ${customerData.id || "N/A"}
Report Type: Full Diagnostic (Updated)
Date: ${new Date().toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}

Generate a FULL DISCOVERY REPORT following this EXACT format:

EUPHORIAM™ FULL DIAGNOSTIC REPORT

Client: [Client Name]
Client ID: [Client ID]
Report Type: Full Diagnostic (Updated)
Prepared by: Euphoriam AI
Date: [Date]

BEFORE YOU READ THIS

This document is not feedback.
It is structural recognition.

Nothing here is asking you to improve, fix, or push.
It describes the forces governing your movement, your pauses, and your timing.

Your system does not respond to motivation.
It responds to safety, consent, and coherence.

Read slowly.
Let it land in the body, not the mind.

SECTION 1 — CORE STRUCTURE DETECTION
[Analyze their primary structure based on metrics and conversation]

SECTION 2 — AVOIDANCE BEHAVIOUR (REFINED)
[Identify their avoidance patterns from the conversation]

SECTION 3 — VORTEX MAPPING
[Map their vortex type and activation points]

SECTION 4 — SOMATIC CONFIRMATION
[Body data observed from the conversation]

SECTION 5 — GRAVITY (3D CODE)
[Gravity percentage and what it's doing]

SECTION 6 — CONSCIOUSNESS LEVEL
[CL level and interpretation]

SECTION 7 — QUANTUM GENIUS CODES (QGC)
[QGC activation percentage and what it looks like]

SECTION 8 — SIGNAL COHERENCE & OUTPUT
[Signal Coherence and Signal Output analysis]

SECTION 9 — ANGLE OF GROWTH (UPDATED)
[Their growth axis based on structure]

SECTION 10 — FIRST CORRECTION (COMPLETED)
[What corrections were made in this session]

SECTION 11 — UNLIMITED CREATOR ALIGNMENT
[Aligned work based on their structure]

FINAL SUMMARY
[Summary paragraph]

Use the exact metrics from the diagnostic:
- Gravity: ${metrics.gravity || "N/A"}%
- Signal Coherence: ${metrics.signalCoherence || "N/A"}%
- Signal Output: ${metrics.signalOutput || "N/A"}%
- CL: ${metrics.consciousnessLevel || "N/A"}
- QGC: ${metrics.qgcActivation || "N/A"}%

Generate the full report in this format.`;

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
          title: `Discovery Follow-up – ${attributes.name}`,
          userId: userForDiscovery?.id || existingDiagnostic?.userId || null,
          data: {
            profile: {
              name: attributes.name,
              email: email,
            },
            aiReport: discoveryReport,
            metrics: metrics,
            customerId: customerData.id || null,
          },
        };

        pdfPath = await generateDiagnosticPdf(discoveryForPdf);
        
        // Upload PDF to Supabase
        if (pdfPath) {
          const buffer = await fs.promises.readFile(pdfPath);
          const upload = await uploadBufferToSupabase({
            buffer,
            objectPath: `discoveries/discovery-${existingDiagnostic?.id || Date.now()}-${Date.now()}.pdf`,
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
      title: `Discovery Follow-up – ${attributes.name}`,
      transcript: transcriptForFinal,
      previousReport: priorReportSnippet,
      newReport: discoveryReport,
      diagnosticId: existingDiagnostic?.id || null,
      pdfUrl: pdfUrl || existingDiagnostic?.data?.pdf?.url || null,
      discoveryType,
    });

    if (email) {
      const { discoveryReportEmail } = require("../utils/emailTemplate/initialDiscoveryReport");
      // Email with PDF attachment if available
      if (pdfPath && discoveryReport) {
        await sendEmail(
          email,
          "Your Discovery Report – Euphoriam AI",
          discoveryReportEmail(attributes.name),
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

  const finalPayload = {
    userId: appUser.id || null,
    email: email.trim(),
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
      previousReports,
      intakeTranscript: transcriptForFinal,
      aiReport: reportText,
      intakeState: {
        ...(existingState || {}),
        transcript: transcriptForFinal,
        finalizedAt: new Date().toISOString(),
      },
      rawSource: {
        kajabiCustomerId: customerData.id,
        kajabiContactId: contactId,
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
    attributes.email,
    "Your Diagnostic Report – Euphoraum-AI",
    diagnosticReportEmail(attributes.name),
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

  if (
    diagnostic.userId !== req.user.sub &&
    req.user.role &&
    req.user.role !== "admin"
  ) {
    return errorResponse(res, "Forbidden", 403);
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
  buildKajabiDiagnosticContext,
  truncateForContext,
  persistDiscoveryRecord,
  getAllPdfUrls,
  getMetrics,
  calculateBottleneck,
};
