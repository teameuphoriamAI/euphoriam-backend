const fs = require("fs");
const { Diagnostic } = require("../models/diagnosticModel");
const { Discovery } = require("../models/discoveryModel");
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

  const engagementScore = clamp(Math.round(safeSignIns * 6.25), 0, 100); // 16 sign-ins ~= 100
  const learningScore = clamp(assessmentSummary.completionPercentage, 0, 100);
  const commitmentScore = clamp(
    Math.round(
      Math.min(100, safeRevenue / 10) +
        (Array.isArray(products) ? products.length : 0) * 8
    ),
    0,
    100
  );

  const signalOutput = clamp(
    Math.round(
      0.5 * engagementScore + 0.3 * learningScore + 0.2 * commitmentScore
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
      userPrompt = buildDiscoveryChatPrompt({
        transcript,
        retrieved,
        factsContext: diagnosticContext,
        userName: name,
        priorReport: priorReportSnippet,
      });
      
      systemPrompt = `You are Euphoriam AI having a natural, flowing conversation. This is NOT a Q&A session or intake. 

CRITICAL RULES:
- NEVER use numbered questions (Q1, Q2, etc.) - this is a conversation, not an interview
- NEVER structure responses as "Q1: ..." or count questions
- Respond naturally to what the user says, like a supportive friend or coach
- Have a back-and-forth dialogue, not an interrogation
- If the user shares progress/updates (e.g., "I decreased phone usage", "I'm doing better"), acknowledge it in context of their diagnostic report - reference specific areas from the report
- If the user asks you something, answer it directly and helpfully
- If the user asks about their diagnostic report, you have full access to it in the system context - use it to answer their question with specific insights, patterns, and findings
- If the user asks for "full report", "where can I improve", "go deeper", or similar - provide a COMPREHENSIVE breakdown immediately. Do NOT ask what area to explore. Give them the full analysis.
- Reference their previous diagnostic when they share updates, ask about it, or when it naturally fits - connect their current state to patterns/areas mentioned in the report
- Be warm, human, and conversational - not clinical or structured
- Let the conversation flow organically based on what they share
- ALWAYS provide a meaningful response - never return empty content
- When user requests full report or improvements, deliver comprehensive insights organized clearly`;
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

    let messages = [
      { role: "system", content: systemPrompt },
    ];

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
    const lastUserMsg = transcript.filter((m) => m.role === "user").slice(-1)[0]?.content || "";
    const lowerMsg = lastUserMsg.toLowerCase();
    const isAskingAboutReport = /diagnostic|report|reveal|show|find|pattern|insight/i.test(lastUserMsg);
    const isRequestingFullReport = /full report|entire report|everything|go deeper|in depth|where can i improve|improve|tell me all|what did.*reveal/i.test(lowerMsg);
    const maxTokens = isDiscoveryMode 
      ? (isRequestingFullReport ? 800 : isAskingAboutReport ? 500 : 300) // Brief summary for full report requests (800 tokens to avoid truncation)
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
    const temperature = isDiscoveryMode && isRequestingFullReport ? 0.3 : (isDiscoveryMode ? 0.7 : 0.3);
    
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
      if (retryCount < maxRetries && isRequestingFullReport && priorReportSnippet) {
        // Retry with even more direct prompt
        const retryMessages = [
          { role: "system", content: `You MUST provide a detailed breakdown of the diagnostic report. Start immediately with "**What Your Diagnostic Report Revealed:**"` },
          { role: "system", content: `DIAGNOSTIC REPORT:\n${priorReportSnippet.substring(0, 10000)}` },
          ...transcript.slice(-3).map((m) => ({
            role: m.role === "assistant" ? "assistant" : "user",
            content: m.content,
          })),
          { role: "user", content: `Provide a comprehensive breakdown of my diagnostic report. Start with "**What Your Diagnostic Report Revealed:**" and then "**Where You Can Improve:**"` },
        ];
        messages = retryMessages;
        retryCount++;
        continue;
      }
      
      break;
    }

    // Handle empty responses with better fallback
    if (!nextMessage || !nextMessage.content || nextMessage.content.trim() === "") {
      if (isDiscoveryMode) {
        const lastUserMsg = transcript.filter((m) => m.role === "user").slice(-1)[0]?.content || "";
        const lowerMsg = lastUserMsg.toLowerCase();
        const isRequestingFullReportFallback = /full report|entire report|everything|go deeper|in depth|where can i improve|improve|tell me all/i.test(lowerMsg);
        
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
                { role: "system", content: "You are a helpful assistant. Provide concise summaries of diagnostic reports." },
                { role: "user", content: simplePrompt },
              ],
              temperature: 0.3,
              max_completion_tokens: 800,
            });
            
            const fallbackMessage = fallbackResponse?.choices?.[0]?.message;
            if (fallbackMessage?.content && fallbackMessage.content.trim() !== "") {
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
          nextMessage = {
            role: "assistant",
            content: `I'm here. ${lastUserMsg ? `You mentioned "${lastUserMsg}" - tell me more about that, or what's on your mind right now?` : "What would you like to explore today?"}`,
          };
        }
      } else {
        nextMessage = {
          role: "assistant",
          content: "I'm here. How can I help you today?",
        };
      }
    }

    // Clean up numbered questions in discovery mode
    if (isDiscoveryMode && nextMessage && typeof nextMessage.content === "string") {
      nextMessage.content = nextMessage.content
        .replace(/^\s*Q\d+\s*[—–-]?\s*/gim, "") // Remove Q1 — at start
        .replace(/\*\*Q\d+\s*[—–-]?\s*\*\*/g, "") // Remove **Q1 —**
        .replace(/Q\d+\s*[—–-]?\s*/g, "") // Remove any Q1 — in text
        .replace(/Q\d+\)\s*/g, "") // Remove Q1) pattern
        .trim();
      
      // Ensure we still have content after cleanup
      if (!nextMessage.content || nextMessage.content.trim() === "") {
        const lastUserMsg = transcript.filter((m) => m.role === "user").slice(-1)[0]?.content || "";
        nextMessage.content = `I hear you. ${lastUserMsg ? `You mentioned "${lastUserMsg}" - what's coming up for you around that?` : "What's on your mind?"}`;
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
    if (!isDiscoveryMode && nextMessage && typeof nextMessage.content === "string") {
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
        userId: req.user?.sub || null,
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

      const finalizeResponse = await openai.chat.completions.create({
        model: "gpt-5.2",
        messages: [
          { role: "system", content: EUPHORIAM_V3_SYSTEM_PROMPT },
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

      const diagnosticPayload = {
        userId: req.user?.sub || null,
        email,
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

      const diagnostic = existingDiagnostic
        ? await existingDiagnostic.update(diagnosticPayload)
        : await Diagnostic.create(diagnosticPayload);

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
        userId: existingDiagnostic?.id ?? 0,
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
      });
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
    // Generate a follow-up discovery report using prior diagnostic + new transcript
    const discoveryPrompt = `
You are generating a brief discovery follow-up report.
Context: The user already has a completed diagnostic report.

Previous diagnostic (reference):
${priorReportSnippet || "None"}

New conversation transcript (latest messages last):
${JSON.stringify(transcriptForFinal, null, 2)}

Produce a concise follow-up report (no PDF formatting needed) that:
- Opens with "Welcome back, <name>." (use the name from attributes)
- Acknowledges continuity from the prior diagnostic.
- Highlights changes since the prior report.
- Answers: "How is your stress?" and other relevant follow-ups inferred from the transcript.
- Recommends 3-5 focused next steps.
Keep it under 400 words. Plain text only.`;

    let discoveryReport = "";
    try {
      const aiDiscovery = await openai.chat.completions.create({
        model: "gpt-4.1-mini",
        messages: [{ role: "user", content: discoveryPrompt }],
        temperature: 0.35,
        max_completion_tokens: 800,
      });
      discoveryReport =
        aiDiscovery?.choices?.[0]?.message?.content?.trim() || "";
    } catch (err) {
      console.error("[discovery] failed to generate follow-up report", err);
    }

    await persistDiscoveryRecord({
      userId: existingDiagnostic?.id ?? null,
      email,
      title: `Discovery Follow-up – ${attributes.name}`,
      transcript: transcriptForFinal,
      previousReport: priorReportSnippet,
      newReport: discoveryReport,
      diagnosticId: existingDiagnostic?.id || null,
      pdfUrl: existingDiagnostic?.data?.pdf?.url || null,
    });

    if (email) {
      await sendEmailBasic(
        email,
        "Your discovery follow-up",
        discoveryReport
          ? discoveryReport.replace(/\n/g, "<br/>")
          : buildDiscoveryEmail({ transcript: transcriptForFinal, email })
      );
    }

    return successResponse(res, "Discovery chat saved", {
      discovery: true,
      message: "Discovery chat saved and emailed.",
      discoveryReport: discoveryReport || null,
    });
  }

  const aiResponse = await openai.chat.completions.create({
    model: "gpt-5.2",
    messages: [
      { role: "system", content: EUPHORIAM_V3_SYSTEM_PROMPT },
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

  const finalPayload = {
    userId: req.user?.sub || null,
    email,
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

  const diagnostic = existingDiagnostic
    ? await existingDiagnostic.update(finalPayload)
    : await Diagnostic.create(finalPayload);

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

  await persistDiscoveryRecord({
    userId: existingDiagnostic?.id ?? 0,
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
    const discoveries = allDiscoveries.filter(
      (d) => d.data?.email === email
    );

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
              title: `${diagnostic.title || `Diagnostic ${diagnostic.id}`} - Version ${index + 1}`,
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
              title: `Previous Report ${index + 1} - ${diagnostic.title || `Diagnostic ${diagnostic.id}`}`,
              url: prevReport.pdfUrl,
              createdAt: prevReport.savedAt ? new Date(prevReport.savedAt) : diagnostic.createdAt,
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

module.exports = {
  listMine,
  listAll,
  getById,
  chatbotDiagnosticFreeform,
  buildKajabiDiagnosticContext,
  truncateForContext,
  persistDiscoveryRecord,
  getAllPdfUrls,
};
