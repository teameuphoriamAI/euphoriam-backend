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

const createDiagnostic = async (req, res) => {
  console.log("Creating diagnostic with data:", req.body);
  const userId = req.user?.sub;
  if (!userId) {
    return errorResponse(res, "Unauthorized: missing user context", 401);
  }

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
  const diagnosticContext = {
    customer: {
      id: customerData.id,
      name: attributes.name,
      email: attributes.email,
      signInCount: attributes.sign_in_count,
      netRevenue: attributes.net_revenue,
      memberSince: attributes.created_at,
    },
    products: products.map((p) => ({
      id: p.data.id,
      title: p.data.attributes.title,
      type: p.data.attributes.product_type_name,
    })),
    offers: offers.map((o) => o.data.attributes.title),
  };

  // Call Euphoriam AI
  const aiResponse = await openai.chat.completions.create({
    model: "gpt-4.1",
    messages: [
      { role: "system", content: DIAGNOSTIC_SYSTEM_PROMPT },
      { role: "user", content: buildDiagnosticPrompt(diagnosticContext) },
    ],
    temperature: 0.4,
    max_tokens: 700,
  });

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

  const diagnosticResult = JSON.parse(aiResponse.choices[0].message.content);

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
      },
      products: diagnosticContext.products,
      aiReport: diagnosticResult,

      rawSource: {
        kajabiCustomerId: customerData.id,
        kajabiContactId: contactId,
      },
    },
  });

  const pdfPath = await generateDiagnosticPdf(diagnostic);

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
