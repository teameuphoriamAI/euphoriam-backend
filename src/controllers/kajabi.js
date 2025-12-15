// import { kajabi } from "../config/kajabi.js";
import { getKajabiAccessToken, createKajabiClient } from "../config/kajabi.js";
// export async function getAllMembers() {
//   try {
//     console.log("here");

//     const res = await kajabi.get("/site_members");

//     return res.data;
//   } catch (err) {
//     console.error("Error fetching Kajabi members:", err.response?.data || err);
//     throw err;
//   }
// }
export async function getCustomerByEmail(email) {
  try {
    const accessToken = await getKajabiAccessToken();
    const kajabi = createKajabiClient(accessToken);
    console.log("kajabi", kajabi);

    const res = await kajabi.get("/customers", {
      params: {
        "filter[email_contains]": email,
        "fields[customers]": "name,email",
        "page[size]": 1,
      },
    });
    console.log("response", res.data);

    const customers = res.data?.data || [];
    return customers.length > 0 ? customers[0] : null;
  } catch (err) {
    console.error("Error fetching Kajabi customer:", err.response?.data || err);
    throw err;
  }
}

export async function getCustomerFullDetails(customerId) {
  try {
    const accessToken = await getKajabiAccessToken();
    const kajabi = createKajabiClient(accessToken);
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
    const token = await getKajabiAccessToken();
    const kajabi = createKajabiClient(token);

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
    const token = await getKajabiAccessToken();
    const kajabi = createKajabiClient(token);

    const res = await kajabi.get(`/products/${productId}`, {});

    return res.data;
  } catch (err) {
    console.error("Error fetching product:", err.response?.data || err);
    throw err;
  }
}
export async function getCourseById(courseId, include = "categories,posts") {
  try {
    const token = await getKajabiAccessToken();
    const kajabi = createKajabiClient(token);

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
    const token = await getKajabiAccessToken();
    const kajabi = createKajabiClient(token);

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
    const token = await getKajabiAccessToken();
    const kajabi = createKajabiClient(token);

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
    const token = await getKajabiAccessToken();
    const kajabi = createKajabiClient(token);

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
  const token = await getKajabiAccessToken();
  const kajabi = createKajabiClient(token);

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
  const token = await getKajabiAccessToken();
  const kajabi = createKajabiClient(token);

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
  const token = await getKajabiAccessToken();
  const kajabi = createKajabiClient(token);

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
  const token = await getKajabiAccessToken();
  const kajabi = createKajabiClient(token);

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
  const token = await getKajabiAccessToken();
  const kajabi = createKajabiClient(token);

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
