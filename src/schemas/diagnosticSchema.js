const Joi = require("joi");

module.exports = Joi.object({
  title: Joi.string().max(255).optional(),

  data: Joi.object({
    // ---- Identity ----
    customerId: Joi.string().required(),
    siteId: Joi.string().required(),

    diagnosticVersion: Joi.number().integer().min(1).required(),
    generatedAt: Joi.date().required(),

    // ---- Product Context ----
    productContext: Joi.array().items(Joi.string()).min(1).required(),

    // ---- Profile Snapshot ----
    profile: Joi.object({
      name: Joi.string().required(),
      email: Joi.string().email().required(),
      location: Joi.string().allow(null, "").optional(),
      customerSince: Joi.date().required(),
      signInCount: Joi.number().integer().min(0).required(),
      engagementLevel: Joi.string().valid("Low", "Medium", "High").required(),
    }).required(),

    // ---- Product Ownership ----
    products: Joi.object({
      offers: Joi.array().items(Joi.string()).min(1).required(),

      products: Joi.array()
        .items(
          Joi.object({
            id: Joi.string().required(),
            title: Joi.string().required(),
            type: Joi.string().required(),
          })
        )
        .min(1)
        .required(),
    }).required(),

    // ---- Financial Diagnostic ----
    investment: Joi.object({
      totalSpent: Joi.number().precision(2).min(0).required(),
      investmentLevel: Joi.string()
        .valid("Explorer", "Engaged", "Committed")
        .required(),
    }).required(),

    // ---- Readiness Assessment ----
    readiness: Joi.object({
      stage: Joi.string().required(),
      description: Joi.string().required(),
    }).required(),

    // ---- AI Guidance ----
    recommendations: Joi.array().items(Joi.string()).min(1).required(),

    // ---- Stage 2 / 3 Extension Points ----
    discoveries: Joi.array()
      .items(
        Joi.object({
          source: Joi.string().valid("Meditation", "Chat", "1:1 Session"),
          content: Joi.string().required(),
          createdAt: Joi.date().required(),
        })
      )
      .optional(),

    // ---- Raw System References ----
    rawSource: Joi.object({
      kajabiCustomerId: Joi.string().required(),
      kajabiContactId: Joi.string().allow(null),
    }).required(),
  }).required(),
});

