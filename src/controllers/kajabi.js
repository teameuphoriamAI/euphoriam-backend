// import { kajabi } from "../config/kajabi.js";
import { createKajabiClient } from "../config/kajabi.js";

export async function getCustomerByEmail(email) {
  try {
    const kajabi = await createKajabiClient();

    const res = await kajabi.get("/customers", {
      params: {
        "filter[email_contains]": email,
        "fields[customers]": "name,email",
        "page[size]": 1,
      },
    });
    const customers = res.data?.data || [];
    return customers.length > 0 ? customers[0] : null;
  } catch (err) {
    console.error("Error fetching Kajabi customer:", err.response?.data || err);
    throw err;
  }
}

export async function getCustomerFullDetails(customerId) {
  try {
    const kajabi = await createKajabiClient();

    const res = await kajabi.get(`/customers/${customerId}`, {
      // params: {
      //   include: "products,offers,tags,subscriptions,assessments",
      // },
    });

    return res.data;
  } catch (err) {
    console.error(
      "Error fetching customer details:",
      err.response?.data || err
    );
    throw err;
  }
}
export async function getSiteById(siteId, fields = "name,subdomain") {
  try {
    const kajabi = await createKajabiClient();

    const res = await kajabi.get(`/sites/${siteId}`, {
      // params: {
      //   "fields[sites]": fields,
      // },
    });

    return res.data;
  } catch (err) {
    console.error("Error fetching site:", err.response?.data || err);
    throw err;
  }
}
export async function getProductById(productId) {
  try {
    const kajabi = await createKajabiClient();

    const res = await kajabi.get(`/products/${productId}`, {});

    return res.data;
  } catch (err) {
    console.error("Error fetching product:", err.response?.data || err);
    throw err;
  }
}
export async function getCourseById(courseId, include = "categories,posts") {
  try {
    const kajabi = await createKajabiClient();

    const res = await kajabi.get(`/courses/${courseId}`, {
      params: {},
    });

    return res.data;
  } catch (err) {
    console.error("Error fetching course:", err.response?.data || err);
    throw err;
  }
}
export async function getOfferById(offerId, fields = "title,price,created_at") {
  try {
    const kajabi = await createKajabiClient();

    const res = await kajabi.get(`/offers/${offerId}`, {
      params: {
        "fields[offers]": fields,
      },
    });

    return res.data;
  } catch (err) {
    console.error("Error fetching offer:", err.response?.data || err);
    throw err;
  }
}

export async function getPurchaseById(
  purchaseId,
  fields = "status,created_at,expires_at"
) {
  try {
    const kajabi = await createKajabiClient();

    const res = await kajabi.get(`/purchases/${purchaseId}`, {
      params: {
        "fields[purchases]": fields,
      },
    });

    return res.data;
  } catch (err) {
    console.error("Error fetching purchase:", err.response?.data || err);
    throw err;
  }
}
export async function getContactById(contactId) {
  try {
    const kajabi = await createKajabiClient();

    const res = await kajabi.get(`/contacts/${contactId}`, {
      // params: {
      //   "fields[contacts]": fields,
      // },
    });

    return res.data;
  } catch (err) {
    console.error("Error fetching contact:", err.response?.data || err);
    throw err;
  }
}

export async function getCustomersByCompletedAssessment(assessmentId) {
  const kajabi = await createKajabiClient();

  const res = await kajabi.get("/customers", {
    params: {
      "filter[completed_assessment_id]": assessmentId,
      "fields[customers]": "id,email",
      "page[size]": 100,
    },
  });

  return res.data?.data || [];
}

export async function getCustomersByPassedAssessment(assessmentId) {
  const kajabi = await createKajabiClient();

  const res = await kajabi.get("/customers", {
    params: {
      "filter[passed_assessment_id]": assessmentId,
      "fields[customers]": "id,email",
      "page[size]": 100,
    },
  });

  return res.data?.data || [];
}

export async function getCustomersByFailedAssessment(assessmentId) {
  const kajabi = await createKajabiClient();

  const res = await kajabi.get("/customers", {
    params: {
      "filter[failed_assessment_id]": assessmentId,
      "fields[customers]": "id,email",
      "page[size]": 100,
    },
  });

  return res.data?.data || [];
}
export async function getProductWithCourse(productId) {
  const kajabi = await createKajabiClient();

  const res = await kajabi.get(`/products/${productId}`, {
    // params: {
    //   include: "courses",
    // },
  });

  return res.data;
}
export function extractCourseIdFromProduct(productData) {
  const included = productData.included || [];

  const course = included.find((i) => i.type === "courses");

  console.log("🎓 Linked course:", course?.id || "NONE");

  return course?.id || null;
}

export async function getCourseWithPosts(courseId) {
  const kajabi = await createKajabiClient();

  console.log("📘 Fetching course:", courseId);

  const res = await kajabi.get(`/courses/${courseId}`, {
    params: {
      include: "categories,posts",
    },
  });

  console.log("📦 Course API response keys:", Object.keys(res.data));
  console.log("📂 Included count:", res.data.included?.length || 0);

  return res.data;
}

export function extractAssessmentsFromCourse(courseData) {
  const included = courseData.included || [];

  return included
    .filter((item) => item.type === "posts" && item.attributes?.assessment_id)
    .map((post) => ({
      postId: post.id,
      assessmentId: post.attributes.assessment_id,
      title: post.attributes.title,
    }));
}
export async function getAssessmentProgressForCustomer(
  customerId,
  assessments
) {
  const completed = [];
  const passed = [];
  const failed = [];

  for (const assessment of assessments) {
    const [completedCustomers, passedCustomers, failedCustomers] =
      await Promise.all([
        getCustomersByCompletedAssessment(assessment.assessmentId),
        getCustomersByPassedAssessment(assessment.assessmentId),
        getCustomersByFailedAssessment(assessment.assessmentId),
      ]);

    if (completedCustomers.some((c) => c.id === customerId)) {
      completed.push(assessment);
    }

    if (passedCustomers.some((c) => c.id === customerId)) {
      passed.push(assessment);
    }

    if (failedCustomers.some((c) => c.id === customerId)) {
      failed.push(assessment);
    }
  }

  const pending = assessments.filter(
    (a) => !completed.some((c) => c.assessmentId === a.assessmentId)
  );

  return {
    total: assessments.length,
    completed,
    passed,
    failed,
    pending,
    completionPercentage: assessments.length
      ? Math.round((completed.length / assessments.length) * 100)
      : 0,
  };
}
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

const pick = (obj, keys) =>
  keys.reduce((acc, k) => {
    if (obj && obj[k] !== undefined) acc[k] = obj[k];
    return acc;
  }, {});
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

// this function gives the full kajabi context for a given customer email

export async function buildKajabiDiagnosticContext({
  email,
  assessmentIds = [],
}) {
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
}
