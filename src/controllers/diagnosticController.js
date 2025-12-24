const { Diagnostic } = require("../models/diagnosticModel");
const validate = require("../helpers/validate");
const openai = require("../config/openai");

const {
  EUPHORIAM_V3_SYSTEM_PROMPT,
  buildFinalReportPrompt,
  DEFAULT_INTRO_PAGE_TEXT,
  EUPHORIAM_FREEFORM_INTAKE_SYSTEM_PROMPT,
  buildFreeformIntakePrompt,
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
const { sendEmail } = require("../utils/email");
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

  const transcript = Array.isArray(messages) ? messages : [];
  const answered = transcript.filter(
    (m) => m?.role === "user" && isAnswerLike(m.content || "")
  ).length;
  const asked = transcript.filter((m) => m?.role === "assistant").length;
  const introText = introPageText || DEFAULT_INTRO_PAGE_TEXT;

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

    const userPrompt = !hasAssistantTurn
      ? buildFreeformIntakePrompt({
        transcript,
        targetCount,
        introPageText: introText,
        factsContext: diagnosticContext,
        retrieved,
      })
      : aiAnswered
        ? buildFreeformIntakePrompt({
          transcript,
          targetCount,
          introPageText: introText,
          factsContext: diagnosticContext,
          retrieved,
        })
        : `The user has NOT answered the last question. Do NOT move to the next question. 
Rephrase and clarify the SAME question only, briefly acknowledge their confusion, and invite them to answer that question now.

Last question: "${lastAssistant?.content || ""}"
User reply: "${lastUser?.content || ""}"

Return only the clarified form of that same question (plus a short acknowledgment), nothing else. 
Do NOT emit a new question number; stay on the same question.`;

    const aiResponse = await openai.chat.completions.create({
      model: "gpt-5.2",
      messages: [
        { role: "system", content: EUPHORIAM_FREEFORM_INTAKE_SYSTEM_PROMPT },
        ...transcript.map((m) => ({
          role: m.role === "assistant" ? "assistant" : "user",
          content: m.content,
        })),
        {
          role: "user",
          content: userPrompt,
        },
      ],
      temperature: 0.3,
      max_completion_tokens: 400,
    });
    const nextMessage = aiResponse?.choices?.[0]?.message;

    // Compute distinct questions answered: count completed question numbers only, excluding the pending one.
    const answeredCount = maxQuestionNumber
      ? maxQuestionNumber - (pendingQuestion ? 1 : 0)
      : 0;

    // If we've gathered all answers, auto-generate the diagnostic/PDF.
    if (answeredCount >= targetCount) {
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

      const diagnostic = await Diagnostic.create({
        userId: req.user?.sub || null,
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
          intakeTranscript: transcript,
          aiReport: reportText,
          rawSource: {
            kajabiCustomerId: customerData.id,
            kajabiContactId: contactId,
          },
        },
      });

      const pdfPath = await generateDiagnosticPdf(diagnostic);

      // Email the user their report
      await sendEmail(
        attributes.email,
        "Your Diagnostic Report – Euphoraum-AI",
        diagnosticReportEmail(attributes.name),
        pdfPath
      );

      return successResponse(res, "Chatbot diagnostic (auto-finalized)", {
        diagnosticId: diagnostic.id,
        diagnostic: diagnostic.data,
        pdfPath,
        reportText,
        autoFinalized: true,
      });
    }

    return successResponse(res, "Next chatbot message", {
      nextMessage,
      introPageText: introText,
      transcript,
      retrieved,
    });
  }

  // Finalize: fetch Kajabi context, then generate the full report using the transcript.
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

  const lastUser = [...transcript].reverse().find((m) => m?.role === "user");
  const retrieved = lastUser?.content
    ? await retrieveSimilarChunks({ query: lastUser.content, topK: 3 })
    : [];

  const aiResponse = await openai.chat.completions.create({
    model: "gpt-5.2",
    messages: [
      { role: "system", content: EUPHORIAM_V3_SYSTEM_PROMPT },
      {
        role: "user",
        content: buildFinalReportPrompt({
          customerContext: diagnosticContext,
          intakeAnswers: transcript,
          introPageText: introText,
          retrieved,
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

  const diagnostic = await Diagnostic.create({
    userId: req.user?.sub || null,
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
      intakeTranscript: transcript,
      aiReport: reportText,
      rawSource: {
        kajabiCustomerId: customerData.id,
        kajabiContactId: contactId,
      },
    },
  });

  const pdfPath = await generateDiagnosticPdf(diagnostic);

  return successResponse(res, "Chatbot diagnostic (freeform) generated", {
    diagnosticId: diagnostic.id,
    diagnostic: diagnostic.data,
    pdfPath,
    reportText,
  });
};

const listMine = async (req, res) => {
  const diagnostics = await Diagnostic.findAll({
    where: { userId: req.user.sub },
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

module.exports = {
  listMine,
  listAll,
  getById,
  chatbotDiagnosticFreeform,
  buildKajabiDiagnosticContext,
};
