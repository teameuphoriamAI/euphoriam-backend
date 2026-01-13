// import { kajabi } from "../config/kajabi.js";
import { createKajabiClient } from "../config/kajabi.js";
import { successResponse, errorResponse } from "../utils/response.js";

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

  // Try without include first, as the API might not support it
  const res = await kajabi.get(`/products/${productId}`, {});

  return res.data;
}
export function extractCourseIdFromProduct(productData) {
  // First, try to get course ID from relationships
  const relationships = productData?.data?.relationships || {};
  const courseRelationship = relationships.course || relationships.courses;
  
  if (courseRelationship?.data) {
    const courseId = Array.isArray(courseRelationship.data) 
      ? courseRelationship.data[0]?.id 
      : courseRelationship.data?.id;
    if (courseId) {
      console.log("🎓 Linked course from relationships:", courseId);
      return courseId;
    }
  }

  // Fallback: try to get from included array
  const included = productData.included || [];
  const course = included.find((i) => i.type === "courses");
  if (course?.id) {
    console.log("🎓 Linked course from included:", course.id);
    return course.id;
  }

  // Fallback: try to get from product attributes
  const attributes = productData?.data?.attributes || {};
  console.log("📋 Product attributes keys:", Object.keys(attributes));
  
  // Check various possible attribute names for course ID
  if (attributes.course_id) {
    console.log("🎓 Linked course from attributes.course_id:", attributes.course_id);
    return attributes.course_id;
  }
  if (attributes.courseId) {
    console.log("🎓 Linked course from attributes.courseId:", attributes.courseId);
    return attributes.courseId;
  }
  if (attributes.linked_course_id) {
    console.log("🎓 Linked course from attributes.linked_course_id:", attributes.linked_course_id);
    return attributes.linked_course_id;
  }

  console.log("🎓 No course found in product data");
  return null;
}

export async function findCourseByProductId(productId, productTitle) {
  try {
    const kajabi = await createKajabiClient();
    
    // First, try using the product ID directly as course ID
    // In Kajabi, sometimes the product ID IS the course ID
    try {
      console.log(`🔍 Trying product ID ${productId} as course ID...`);
      const testCourse = await kajabi.get(`/courses/${productId}`, {});
      if (testCourse.data?.data) {
        console.log(`✅ Product ID ${productId} is a valid course ID!`);
        return productId;
      }
    } catch (err) {
      console.log(`❌ Product ID ${productId} is not a valid course ID`);
    }
    
    // Try to get courses and filter by product or title
    const res = await kajabi.get("/courses", {
      params: {
        "page[size]": 100,
      },
    });

    const courses = res.data?.data || [];
    console.log(`🔍 Found ${courses.length} courses, searching...`);

    // Search through courses to find one linked to this product
    for (const course of courses) {
      const courseRelationships = course.relationships || {};
      const productRelationship = courseRelationships.product || courseRelationships.products;
      
      if (productRelationship?.data) {
        const linkedProductId = Array.isArray(productRelationship.data)
          ? productRelationship.data[0]?.id
          : productRelationship.data?.id;
        
        if (linkedProductId === String(productId) || linkedProductId === productId) {
          console.log(`✅ Found course ${course.id} linked to product ${productId}`);
          return course.id;
        }
      }
      
      // Also check if course title matches product title
      if (productTitle && course.attributes?.title) {
        const courseTitle = course.attributes.title.trim().toLowerCase();
        const searchTitle = productTitle.trim().toLowerCase();
        if (courseTitle === searchTitle || courseTitle.includes(searchTitle) || searchTitle.includes(courseTitle)) {
          console.log(`✅ Found course ${course.id} by title match: "${course.attributes.title}"`);
          return course.id;
        }
      }
    }

    console.log(`⚠️ No course found linked to product ${productId}`);
    return null;
  } catch (err) {
    console.error("Error finding course by product ID:", err.response?.data || err);
    throw err;
  }
}

export async function getCoursePosts(courseId) {
  try {
    const kajabi = await createKajabiClient();
    
    // Try to get posts for a course - this might use a different endpoint
    // Some APIs use /courses/{id}/posts
    try {
      const res = await kajabi.get(`/courses/${courseId}/posts`, {});
      return res.data?.data || [];
    } catch (err) {
      // If that endpoint doesn't exist, try /posts with course filter
      if (err.response?.status === 404) {
        const res = await kajabi.get("/posts", {
          params: {
            "filter[course_id]": courseId,
            "page[size]": 100,
          },
        });
        return res.data?.data || [];
      }
      throw err;
    }
  } catch (err) {
    console.error("Error fetching course posts:", err.response?.data || err);
    return [];
  }
}

export async function getCourseWithModulesAndLessons(courseId) {
  const kajabi = await createKajabiClient();

  console.log("📘 Fetching course with modules and lessons:", courseId);

  try {
    const res = await kajabi.get(`/courses/${courseId}`, {
      params: {
        include: "modules,lessons,lessons.media",
      },
    });

    console.log(`✅ Successfully fetched course with modules and lessons`);
    console.log("📦 Course API response keys:", Object.keys(res.data));
    console.log("📂 Included count:", res.data.included?.length || 0);

    return res.data;
  } catch (err) {
    console.error("Error fetching course with modules:", err.response?.data || err);
    throw err;
  }
}

export async function getCourseWithPosts(courseId) {
  const kajabi = await createKajabiClient();

  console.log("📘 Fetching course:", courseId);

  // Try different include formats
  const includeOptions = [
    "modules,lessons,lessons.media", // Try new format first
    "categories,posts",
    "posts",
    null, // no include
  ];

  for (const includeOption of includeOptions) {
    try {
      const params = includeOption ? { include: includeOption } : {};
      const res = await kajabi.get(`/courses/${courseId}`, { params });

      console.log(`✅ Successfully fetched course with include: ${includeOption || "none"}`);
      console.log("📦 Course API response keys:", Object.keys(res.data));
      console.log("📂 Included count:", res.data.included?.length || 0);

      // If we got the course but no posts in included, try to fetch posts separately
      const postsIncluded = res.data.included?.filter((item) => item.type === "posts") || [];
      
      if (postsIncluded.length === 0 && res.data?.data?.relationships?.posts) {
        const postsRel = res.data.data.relationships.posts;
        if (postsRel.data && postsRel.data.length > 0) {
          console.log(`📂 Found ${postsRel.data.length} post references, fetching posts separately...`);
          const posts = await getCoursePosts(courseId);
          
          // Add fetched posts to included array
          if (posts.length > 0) {
            if (!res.data.included) {
              res.data.included = [];
            }
            res.data.included.push(...posts.map((post) => ({
              type: "posts",
              id: post.id,
              attributes: post.attributes,
            })));
            console.log(`✅ Added ${posts.length} posts to course data`);
          }
        }
      }

      return res.data;
    } catch (err) {
      if (err.response?.status === 400 && includeOption) {
        console.log(`⚠️ Include '${includeOption}' failed, trying next option...`);
        continue;
      }
      // If it's not a 400 error or we're on the last option, throw
      throw err;
    }
  }

  // Should never reach here, but just in case
  throw new Error("Failed to fetch course with any include option");
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

export function extractVideosFromLessons(courseData) {
  const included = courseData.included || [];
  
  // Get modules, lessons, and media
  const modules = included.filter((item) => item.type === "modules");
  const lessons = included.filter((item) => item.type === "lessons");
  const media = included.filter((item) => item.type === "media");

  // Create a map of lesson ID to media
  const mediaMap = {};
  media.forEach((m) => {
    const lessonId = m.relationships?.lesson?.data?.id;
    if (lessonId) {
      mediaMap[lessonId] = m;
    }
  });

  // Create a map of module ID to module info
  const moduleMap = {};
  modules.forEach((m) => {
    moduleMap[m.id] = {
      id: m.id,
      title: m.attributes?.title || "",
      position: m.attributes?.position || 0,
    };
  });

  // Extract videos from lessons
  const videos = lessons
    .map((lesson) => {
      const attrs = lesson.attributes || {};
      const lessonMedia = mediaMap[lesson.id];
      const module = moduleMap[lesson.relationships?.module?.data?.id];

      // Build video URL - Kajabi lessons typically have a permalink
      // Format: https://{site}.kajabi.com/products/{product}/courses/{course}/lessons/{lesson}
      const lessonId = lesson.id;
      const courseId = courseData.data?.id;
      
      return {
        lessonId: lesson.id,
        name: attrs.title || "Untitled",
        title: attrs.title || "Untitled",
        url: `https://www.euphoriam.com/products/the-unlimited-creator/courses/${courseId}/lessons/${lessonId}`,
        duration: lessonMedia?.attributes?.duration_in_minutes || null,
        durationMinutes: lessonMedia?.attributes?.duration_in_minutes || null,
        position: attrs.position || 0,
        status: attrs.status,
        moduleId: module?.id,
        moduleTitle: module?.title || "",
        modulePosition: module?.position || 0,
        week: extractWeekFromTitle(attrs.title),
        theme: extractThemeFromTitle(attrs.title),
        rawAttributes: attrs,
      };
    })
    .sort((a, b) => a.position - b.position);

  return videos;
}

export function extractVideosFromCourse(courseData) {
  const included = courseData.included || [];

  // Check if we have modules/lessons structure (new format)
  const hasModules = included.some((item) => item.type === "modules");
  const hasLessons = included.some((item) => item.type === "lessons");

  if (hasModules && hasLessons) {
    return extractVideosFromLessons(courseData);
  }

  // Fallback to posts (old format)
  const posts = included.filter((item) => item.type === "posts");

  return posts
    .map((post) => {
      const attrs = post.attributes || {};

      // Return post information - in course context, posts are typically video lessons
      return {
        postId: post.id,
        name: attrs.title || "Untitled", // Video name
        title: attrs.title || "Untitled", // Keep for backward compatibility
        url: attrs.video_url || attrs.video_url_embed || attrs.url || attrs.permalink, // Video URL
        videoUrl: attrs.video_url || attrs.video_url_embed || attrs.url, // Keep for backward compatibility
        videoId: attrs.video_id,
        thumbnailUrl: attrs.thumbnail_url || attrs.image_url,
        description: attrs.description || attrs.body,
        duration: attrs.duration || attrs.video_duration,
        postType: attrs.post_type_name || attrs.content_type,
        createdAt: attrs.created_at,
        updatedAt: attrs.updated_at,
        position: attrs.position,
        week: extractWeekFromTitle(attrs.title),
        theme: extractThemeFromTitle(attrs.title),
        // Include all attributes for debugging/inspection
        rawAttributes: attrs,
      };
    })
    .filter((post) => {
      // Filter out assessment posts (those are quizzes, not videos)
      return !post.rawAttributes?.assessment_id;
    })
    .sort((a, b) => a.position - b.position);
}

// Helper function to extract week number from title
function extractWeekFromTitle(title) {
  if (!title) return null;
  
  const weekMatch = title.match(/week\s+(\d+)/i);
  if (weekMatch) {
    return parseInt(weekMatch[1], 10);
  }
  
  // Check for "Week One", "Week Two", etc.
  const weekNames = {
    one: 1, two: 2, three: 3, four: 4, five: 5, six: 6,
    seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12
  };
  
  for (const [name, num] of Object.entries(weekNames)) {
    if (title.toLowerCase().includes(`week ${name}`)) {
      return num;
    }
  }
  
  return null;
}

// Helper function to extract theme (Alignment/Freedom/Prosperity) from title
function extractThemeFromTitle(title) {
  if (!title) return null;
  
  const titleLower = title.toLowerCase();
  
  if (titleLower.includes("purpose") || titleLower.includes("alignment")) {
    return "Alignment";
  }
  if (titleLower.includes("freedom")) {
    return "Freedom";
  }
  if (titleLower.includes("prosperity")) {
    return "Prosperity";
  }
  
  // Map weeks to themes
  const week = extractWeekFromTitle(title);
  if (week >= 1 && week <= 3) return "Alignment";
  if (week >= 4 && week <= 8) return "Freedom";
  if (week >= 9 && week <= 12) return "Prosperity";
  
  return null;
}

export async function searchProductsByTitle(productTitle) {
  try {
    const kajabi = await createKajabiClient();

    const res = await kajabi.get("/products", {
      params: {
        "filter[title_contains]": productTitle,
        "page[size]": 100,
      },
    });

    return res.data?.data || [];
  } catch (err) {
    console.error("Error searching products:", err.response?.data || err);
    throw err;
  }
}

export async function getProductOffers(productId) {
  try {
    const kajabi = await createKajabiClient();
    
    // Get product to see its offers relationship
    const productData = await getProductWithCourse(productId);
    const relationships = productData?.data?.relationships || {};
    const offerIds = relationships.offers?.data?.map((o) => o.id) || [];
    
    if (offerIds.length === 0) {
      console.log(`📋 No offers found for product ${productId}`);
      return [];
    }
    
    console.log(`📋 Found ${offerIds.length} offers for product ${productId}`);
    
    // Fetch all offers
    const offers = await Promise.all(
      offerIds.map((id) => getOfferById(id))
    );
    
    return offers.map((offer) => ({
      id: offer.data?.id,
      title: offer.data?.attributes?.title,
      price: offer.data?.attributes?.price,
      data: offer.data,
    }));
  } catch (err) {
    console.error("Error getting product offers:", err.response?.data || err);
    return [];
  }
}

export async function getProductVideos(productTitle) {
  try {
    // Search for the product by title
    const products = await searchProductsByTitle(productTitle);

    if (products.length === 0) {
      throw new Error(`Product "${productTitle}" not found`);
    }

    // Find exact match (case-insensitive)
    const product = products.find(
      (p) => p.attributes?.title?.toLowerCase().trim() === productTitle.toLowerCase().trim()
    );
    
    if (!product) {
      throw new Error(
        `Product "${productTitle}" not found. Found ${products.length} similar products.`
      );
    }

    const productId = product.id;
    console.log(
      `📦 Found product: ${product.attributes.title} (ID: ${productId})`
    );

    // Get product offers
    const offers = await getProductOffers(productId);
    console.log(`📋 Found ${offers.length} offers for product`);

    // Get product with course relationship
    const productData = await getProductWithCourse(productId);
    
    // Debug: log product structure
    console.log("📦 Product data keys:", Object.keys(productData));
    console.log("📦 Product relationships:", productData?.data?.relationships);
    console.log("📦 Product included:", productData?.included?.length || 0);

    // Extract course ID from product
    let courseId = extractCourseIdFromProduct(productData);

    // If not found in product data, try to search for courses linked to this product
    if (!courseId) {
      console.log("🔍 Course not found in product data, searching courses by product ID...");
      courseId = await findCourseByProductId(productId, product.attributes?.title);
    }

    if (!courseId) {
      // Log product attributes for debugging
      const attributes = productData?.data?.attributes || {};
      console.log("📋 Product attributes:", JSON.stringify(attributes, null, 2));
      throw new Error(`No course linked to product "${productTitle}"`);
    }

    console.log(`📘 Fetching course ${courseId} for product videos`);

    // Try to get course with modules and lessons first
    let courseData;
    try {
      courseData = await getCourseWithModulesAndLessons(courseId);
    } catch (err) {
      console.log("⚠️ Failed to fetch with modules/lessons, trying posts format...");
      courseData = await getCourseWithPosts(courseId);
    }

    // Extract videos from course
    const videos = extractVideosFromCourse(courseData);

    // Format videos with name and url
    const formattedVideos = videos.map((video) => ({
      name: video.name || video.title,
      url: video.url || video.videoUrl,
      title: video.title, // Keep for compatibility
      videoUrl: video.videoUrl, // Keep for compatibility
      lessonId: video.lessonId,
      postId: video.postId,
      week: video.week,
      theme: video.theme,
      moduleTitle: video.moduleTitle,
      duration: video.duration || video.durationMinutes,
      thumbnailUrl: video.thumbnailUrl,
      description: video.description,
      position: video.position,
    }));

    return {
      product: {
        id: productId,
        title: product.attributes.title,
      },
      offers: offers.map((o) => ({
        id: o.id,
        title: o.title,
        price: o.price,
      })),
      courseId,
      videos: formattedVideos,
      totalVideos: formattedVideos.length,
    };
  } catch (err) {
    console.error("Error getting product videos:", err.message || err);
    throw err;
  }
}

// Recommend videos based on user's diagnostic state
export function recommendVideos(videos, diagnosticMetrics = {}) {
  if (!videos || videos.length === 0) {
    return [];
  }

  const {
    engagementScore = 0,
    learningScore = 0,
    commitmentScore = 0,
    gravity = 0,
    signalOutput = 0,
    signalCoherence = 0,
  } = diagnosticMetrics;

  // Determine user's current state/theme
  // Lower scores indicate need for earlier weeks
  // Higher gravity = need for Alignment (Purpose)
  // Lower signal coherence = need for Freedom
  // Lower commitment = need for Prosperity

  let recommendedTheme = "Alignment"; // Default to start
  let recommendedWeek = 1;

  // Determine theme based on metrics
  if (gravity > 70 || signalOutput < 30) {
    // High gravity or low signal = need Alignment/Purpose
    recommendedTheme = "Alignment";
    recommendedWeek = Math.min(3, Math.max(1, Math.ceil(gravity / 25)));
  } else if (signalCoherence < 50 || engagementScore < 40) {
    // Low coherence or engagement = need Freedom
    recommendedTheme = "Freedom";
    recommendedWeek = Math.min(8, Math.max(4, 4 + Math.ceil((50 - signalCoherence) / 10)));
  } else if (commitmentScore < 60 || learningScore < 50) {
    // Low commitment or learning = need Prosperity
    recommendedTheme = "Prosperity";
    recommendedWeek = Math.min(12, Math.max(9, 9 + Math.ceil((60 - commitmentScore) / 15)));
  }

  // Filter and sort videos
  const themeVideos = videos.filter((v) => {
    if (!v.theme) return false;
    return v.theme === recommendedTheme;
  });

  // Sort by week, then by position
  themeVideos.sort((a, b) => {
    if (a.week !== b.week) {
      return (a.week || 99) - (b.week || 99);
    }
    return (a.position || 0) - (b.position || 0);
  });

  // Get recommended videos starting from the recommended week
  const recommended = themeVideos.filter((v) => {
    if (!v.week) return false;
    return v.week >= recommendedWeek;
  });

  // If no videos found for recommended week, get first 3-5 videos from theme
  if (recommended.length === 0 && themeVideos.length > 0) {
    return themeVideos.slice(0, 5);
  }

  // Return first 5-7 recommended videos
  return recommended.slice(0, 7);
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
  if (!customerInfo) {
    return null;
  }
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

// Express route handlers

// Get all videos from "The Unlimited Creator" product
export async function getUnlimitedCreatorVideos(req, res) {
  try {
    const productTitle = "The Unlimited Creator ";
    const result = await getProductVideos(productTitle);
    return successResponse(
      res,
      `Successfully retrieved ${result.totalVideos} videos from ${productTitle}`,
      result
    );
  } catch (err) {
    console.error("Error in getUnlimitedCreatorVideos:", err);
    return errorResponse(
      res,
      err.message || "Failed to retrieve product videos",
      err.statusCode || 500
    );
  }
}

// Get videos from any product by title (query parameter)
export async function getProductVideosByTitle(req, res) {
  try {
    const { productTitle } = req.query;

    if (!productTitle) {
      return errorResponse(
        res,
        "productTitle query parameter is required",
        400
      );
    }

    const result = await getProductVideos(productTitle);
    return successResponse(
      res,
      `Successfully retrieved ${result.totalVideos} videos from ${productTitle}`,
      result
    );
  } catch (err) {
    console.error("Error in getProductVideosByTitle:", err);
    return errorResponse(
      res,
      err.message || "Failed to retrieve product videos",
      err.statusCode || 500
    );
  }
}

// Get recommended videos based on diagnostic metrics
export async function getRecommendedVideos(req, res) {
  try {
    const { productTitle, metrics } = req.query;
    const productName = productTitle || "The Unlimited Creator";

    // Get all videos for the product
    const result = await getProductVideos(productName);

    // Parse metrics if provided as JSON string
    let diagnosticMetrics = {};
    if (metrics) {
      try {
        diagnosticMetrics = typeof metrics === "string" ? JSON.parse(metrics) : metrics;
      } catch (e) {
        console.error("Error parsing metrics:", e);
      }
    }

    // Get recommended videos
    const recommended = recommendVideos(result.videos, diagnosticMetrics);

    return successResponse(
      res,
      `Successfully retrieved ${recommended.length} recommended videos`,
      {
        product: result.product,
        recommendedVideos: recommended,
        allVideos: result.videos,
        totalVideos: result.totalVideos,
        recommendationReason: getRecommendationReason(diagnosticMetrics),
      }
    );
  } catch (err) {
    console.error("Error in getRecommendedVideos:", err);
    return errorResponse(
      res,
      err.message || "Failed to retrieve recommended videos",
      err.statusCode || 500
    );
  }
}

// Helper function to explain recommendation reason
function getRecommendationReason(metrics = {}) {
  const { gravity = 0, signalOutput = 0, signalCoherence = 0, commitmentScore = 0 } = metrics;

  if (gravity > 70 || signalOutput < 30) {
    return "High gravity or low signal output detected. Focus on Alignment/Purpose videos to establish foundation.";
  }
  if (signalCoherence < 50) {
    return "Low signal coherence detected. Focus on Freedom videos to clear energetic blocks.";
  }
  if (commitmentScore < 60) {
    return "Low commitment score detected. Focus on Prosperity videos to integrate and manifest results.";
  }
  return "Based on your current metrics, these videos will help you progress through the program.";
}

async function getAllMembers(req, res) {
  try {
    // Placeholder - implement if needed
    return successResponse(res, "Members endpoint", []);
  } catch (err) {
    console.error("Error in getAllMembers route:", err);
    return errorResponse(res, err.message || "Failed to fetch members", 500);
  }
}
