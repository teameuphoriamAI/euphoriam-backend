const {
  DOMAIN_ENUM,
  domainMapSchema,
  milestonesSchema,
  progressMetricsSchema,
  apiSuccessEnvelope,
  apiErrorEnvelope,
  bearerSecurity,
} = require("../common");

const goalBodySchema = {
  type: "object",
  required: ["domain"],
  properties: {
    domain: { type: "string", enum: DOMAIN_ENUM, example: "income" },
    goal_title: { type: "string", example: "Launch diagnostic funnel + masterclass" },
    desired_outcome: { type: "string", example: "Consistent lead flow + 25 UC sales" },
    target_date: { type: "string", example: "90 days" },
    proof_of_success: { type: "string", example: "25 UC sales in Stripe" },
    milestones: {
      type: "object",
      properties: {
        day_7: { type: "string" },
        day_30: { type: "string" },
        day_90: { type: "string" },
      },
    },
    today_visible_action: { type: "string", example: "Send launch date to Lee" },
    begin_map_resistance: { type: "boolean" },
  },
};

const homeResultSchema = {
  type: "object",
  properties: {
    membership_tier: { type: "string" },
    onboarding_status: {
      type: "string",
      enum: ["none", "goals_draft", "goals_complete", "resistance_in_progress", "active"],
    },
    primary_domain: { type: "string", nullable: true },
    active_domains: { type: "array", items: { type: "string" } },
    map_resistance_in_progress: { type: "boolean" },
    show_create_goals_cta: { type: "boolean" },
    dashboard: { type: "object", nullable: true },
  },
};

const domainParam = {
  name: "domain",
  in: "path",
  required: true,
  schema: { type: "string", enum: DOMAIN_ENUM },
  example: "income",
};

/** @returns {import('openapi-types').OpenAPIV3.PathsObject} */
const stage1Paths = {
  "/stage1/home": {
    get: {
      tags: ["Stage 1 — Home"],
      summary: "Home dashboard (NEW — frontend will use for Create Goals)",
      description:
        "Next.js proxy: *not wired yet* — call `GET {BACKEND}/stage1/home` when Stage 1 UI ships.\n\nNew user vs existing user flow (high level):\n\n- New user: no goals yet → frontend shows Create Goals CTA → POST `/stage1/domains` to create goals → onboarding_status moves from `none` → `goals_draft` → `goals_complete` → optionally begin map resistance → `resistance_in_progress` → `active`.\n- Existing (returning) user: has stored goals → GET `/stage1/domains` to list domains → GET `/stage1/domains/{domain}` to view/edit → PATCH `/stage1/domains/{domain}/activate` to activate according to membership limits.\n\nThis endpoint returns `HomeResult` which includes `onboarding_status`, `primary_domain`, `active_domains`, and flags to show CTAs for goal creation or resistance mapping.",
      security: bearerSecurity,
      responses: {
        200: {
          description: "Home",
          content: {
            "application/json": {
              schema: apiSuccessEnvelope({ $ref: "#/components/schemas/HomeResult" }),
            },
          },
        },
        401: { description: "Unauthorized", content: { "application/json": { schema: apiErrorEnvelope } } },
      },
    },
  },
  "/stage1/onboarding/status": {
    get: {
      tags: ["Stage 1 — Home"],
      summary: "Onboarding status",
      security: bearerSecurity,
      responses: {
        200: { description: "OK", content: { "application/json": { schema: apiSuccessEnvelope({ type: "object" }) } } },
      },
    },
  },
  "/stage1/flow": {
    get: {
      tags: ["Stage 1 — Home"],
      summary: "Guidance: new-user vs returning-user flow (human-readable)",
      description: "Returns a short human-readable guide for the frontend to display onboarding tips for new and returning users.",
      security: bearerSecurity,
      responses: {
        200: {
          description: "Flow guidance",
          content: {
            "application/json": {
              schema: apiSuccessEnvelope({
                type: "object",
                properties: {
                  new_user_flow: { type: "string" },
                  existing_user_flow: { type: "string" },
                },
              }),
              example: {
                status: true,
                message: "Flow guidance",
                result: {
                  new_user_flow: "Create Goals → Draft goals for 5 domains → Complete one primary goal → Begin map resistance if ready.",
                  existing_user_flow: "Review active domains → Edit goal details → Activate another domain if membership allows.",
                },
              },
            },
          },
        },
      },
    },
  },
  "/stage1/domains": {
    get: {
      tags: ["Stage 1 — Domains"],
      summary: "List 5 domains + status",
      security: bearerSecurity,
      responses: {
        200: {
          description: "OK",
          content: {
            "application/json": {
              schema: apiSuccessEnvelope({ type: "object" }),
            },
          },
        },
      },
    },
    post: {
      tags: ["Stage 1 — Domains"],
      summary: "Create/update goals (Create Goals wizard)",
      security: bearerSecurity,
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: goalBodySchema,
            example: {
              domain: "income",
              goal_title: "Launch diagnostic funnel + masterclass",
              desired_outcome: "Consistent lead flow + 25 UC sales",
              target_date: "90 days",
              proof_of_success: "25 UC sales in Stripe",
              milestones: {
                day_7: "Finalise rollout",
                day_30: "Funnel live + launch date confirmed",
                day_90: "Consistent lead flow + 25 UC sales",
              },
              today_visible_action: "Send launch date to Lee",
            },
          },
        },
      },
      responses: {
        200: {
          description: "Saved",
          content: {
            "application/json": {
              schema: apiSuccessEnvelope({ type: "object" }),
            },
          },
        },
      },
    },
  },
  "/stage1/domains/{domain}": {
    get: {
      tags: ["Stage 1 — Domains"],
      summary: "Domain detail",
      security: bearerSecurity,
      parameters: [domainParam],
      responses: {
        200: {
          description: "OK",
          content: {
            "application/json": {
              schema: apiSuccessEnvelope({ type: "object" }),
            },
          },
        },
      },
    },
    patch: {
      tags: ["Stage 1 — Domains"],
      summary: "Patch goals",
      security: bearerSecurity,
      parameters: [domainParam],
      requestBody: {
        content: { "application/json": { schema: { type: "object" } } },
      },
      responses: { 200: { description: "OK" } },
    },
  },
  "/stage1/domains/{domain}/activate": {
    patch: {
      tags: ["Stage 1 — Domains"],
      summary: "Activate domain (tier limits)",
      security: bearerSecurity,
      parameters: [domainParam],
      responses: { 200: { description: "OK" } },
    },
  },
};

module.exports = { stage1Paths, goalBodySchema, homeResultSchema };
