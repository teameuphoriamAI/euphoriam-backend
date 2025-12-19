const { Diagnostic } = require("../models/diagnosticModel");
const validate = require("../helpers/validate");
const diagnosticSchema = require("../schemas/diagnosticSchema");
const openai = require("../config/openai");
const {
  DIAGNOSTIC_SYSTEM_PROMPT,
  buildDiagnosticPrompt,
} = require("../helpers/aiCommand");
const { successResponse, errorResponse } = require("../utils/response");
const {
  getCustomerByEmail,
  getCustomerFullDetails,
  getSiteById,
  getContactById,
  getOfferById,
  getProductById,
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

const createDiagnostic = async (req, res) => {
  console.log("Creating diagnostic with data:", req.body);
  const userId = req.user?.sub || null;

  const { Email } = req.body.payload;
  const assessmentIds = req.body.assessmentIds || [];

  // Fetch customer
  const customerInfo = await getCustomerByEmail(Email);
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

    // 1️⃣ Only process COURSE products
    if (productType !== "Course") {
      console.log(
        `⏭ Skipping non-course product: ${productData?.attributes?.title}`
      );
      continue;
    }

    // 2️⃣ Extract linked course ID (CRITICAL FIX)
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

    // 3️⃣ Fetch course with posts
    const courseData = await getCourseWithPosts(courseId);

    // 4️⃣ Extract assessments from posts
    const assessments = extractAssessmentsFromCourse(courseData);

    if (!assessments.length) {
      console.log(`ℹ️ No assessments found in course ${courseId}`);
      continue;
    }

    // 5️⃣ Get customer progress (completed / passed / failed)
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

  // Build AI input context
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

  // Call Euphoriam AI
  const callOpenAi = async (compact) =>
    openai.chat.completions.create({
      model: "gpt-4.1",
      messages: [
        { role: "system", content: DIAGNOSTIC_SYSTEM_PROMPT },
        {
          role: "user",
          content: buildDiagnosticPrompt(diagnosticContext, { compact }),
        },
      ],
      temperature: 0.2,
      max_tokens: 2200,
    });

  const aiResponse = await callOpenAi(true);

  // const aiResponse = {
  //   id: "chatcmpl-Cn62rORJFphottKJZdRGiDUe3jxHr",
  //   object: "chat.completion",
  //   created: 1765817345,
  //   model: "gpt-4.1-2025-04-14",
  //   choices: [
  //     {
  //       index: 0,
  //       message: {
  //         role: "assistant",
  //         content:
  //           '{\n  "readinessStage": "Stage 1",\n  "summary": "Aishah has actively engaged with Euphoriam offerings, including \'The Unlimited Creator\' course and community access. At this foundational stage, she is positioned to build strong habits and deepen her transformation journey.",\n  "strengths": [\n    "Consistent platform engagement",\n    "Investment in core learning and community resources",\n    "Openness to new experiences and growth opportunities"\n  ],\n  "currentChallenges": [\n    "Establishing a regular practice with course materials",\n    "Building connections within the community",\n    "Clarifying immediate personal goals for transformation"\n  ],\n  "recommendedFocus": [\n    "Set a weekly schedule for progressing through \'The Unlimited Creator\' modules",\n    "Participate in introductory threads and live calls to foster community ties",\n    "Reflect on key intentions and outcomes desired from this journey"\n  ],\n  "nextSteps": [\n    "Complete the orientation and first module of \'The Unlimited Creator\'",\n    "Introduce yourself in the Euphoriam Community and engage with at least one group discussion",\n    "Join the next available live call or explore the library for foundational content"\n  ],\n  "productGuidance": "Leverage \'The Unlimited Creator\' course as your structured pathway—progress at your own pace, but aim for regular engagement. Use the Euphoriam Community for support, accountability, and shared insights. Access the Live Calls/Library to deepen understanding and connect with others; these resources are especially valuable for early-stage momentum."\n}',
  //         refusal: null,
  //         annotations: [],
  //       },
  //       logprobs: null,
  //       finish_reason: "stop",
  //     },
  //   ],
  //   usage: {
  //     prompt_tokens: 373,
  //     completion_tokens: 313,
  //     total_tokens: 686,
  //     prompt_tokens_details: {
  //       cached_tokens: 0,
  //       audio_tokens: 0,
  //     },
  //     completion_tokens_details: {
  //       reasoning_tokens: 0,
  //       audio_tokens: 0,
  //       accepted_prediction_tokens: 0,
  //       rejected_prediction_tokens: 0,
  //     },
  //   },
  //   service_tier: "default",
  //   system_fingerprint: "fp_503841a4dc",
  // };

  const diagnosticText = (
    aiResponse?.choices?.[0]?.message?.content || ""
  ).trim();

  if (!diagnosticText) {
    return errorResponse(res, "AI returned empty output. Please retry.", 502);
  }

  // Store as a plain string. Do not rewrite bullets or unicode divider lines.

  // Save diagnostic to DB
  const diagnostic = await Diagnostic.create({
    userId,
    title: `Stage 1 Diagnostic – ${attributes.name}`,
    data: {
      customerId: customerData.id,
      siteId,
      diagnosticVersion: 1,
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
      products: diagnosticContext.products,
      offers: diagnosticContext.offers,
      courseAssessments,
      metrics,
      aiReport: diagnosticText,

      rawSource: {
        kajabiCustomerId: customerData.id,
        kajabiContactId: contactId,
      },
    },
  });

  const pdfPath = await generateDiagnosticPdf(diagnostic);
  await sendEmail(
    attributes.email,
    "Your Diagnostic Report – Euphoraum-AI",
    diagnosticReportEmail(attributes.name),
    pdfPath
  );
  // Return response
  return successResponse(res, "Diagnostic generated & saved", {
    diagnosticId: diagnostic,
    diagnostic: diagnostic.data,
    pdfPath,
    products,
    courseAssessments,
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

module.exports = { createDiagnostic, listMine, listAll, getById };
