/**
 * OpenAPI 3.0 — Euphoriam backend (Stage 1 + frontend-used APIs)
 * UI: GET /api/docs  |  JSON: GET /api/docs/openapi.json
 */

const {
  DOMAIN_ENUM,
  domainMapSchema,
  apiSuccessEnvelope,
  apiErrorEnvelope,
} = require("./common");
const { stage1Paths, homeResultSchema } = require("./paths/stage1Paths");
const { frontendAuthPaths } = require("./paths/frontendAuthPaths");
const { frontendPaidPaths } = require("./paths/frontendPaidPaths");
const { frontendFunnelPaths } = require("./paths/frontendFunnelPaths");

const openapiSpec = {
  openapi: "3.0.3",
  info: {
    title: "Euphoriam Backend API",
    version: "1.1.0",
    description: `
## How the frontend calls this API

The **browser** usually hits **Next.js** \`/api/*\`, which proxies to this backend (\`BACKEND_URL\`).

### Test Stage 1 in Swagger

1. **Frontend — Auth:** \`POST /diagnostics/checkUser\` with a **paid UC** email → copy \`result.token\`
2. Click **Authorize** → paste token
3. Run **Stage 1 —** endpoints (\`/stage1/*\`) — *not wired in Next.js yet; call backend directly*

### Sections in this doc

| Tag | Used by app today? |
|-----|-------------------|
| **Stage 1** | NEW — Create Goals flow (backend ready) |
| **Frontend — Auth** | /login, verify-otp |
| **Frontend — Paid chat** | /chat, diagnostic Q&A |
| **Frontend — Free funnel** | /funnel/* (magic link, not UC JWT) |

**WebSocket (not in OpenAPI):** \`{BACKEND}/ws/chatbot-freeform\` — paid + funnel Q&A
    `.trim(),
  },
  servers: [
    { url: "/api", description: "This server (relative)" },
    {
      url: "http://localhost:4001/api",
      description: "Local default (set PORT in .env)",
    },
  ],
  tags: [
    { name: "Health", description: "Health check" },
    { name: "Stage 1 — Home", description: "NEW product — dashboard & onboarding" },
    { name: "Stage 1 — Domains", description: "NEW — goals CRUD & activate" },
    { name: "Frontend — Auth (paid UC)", description: "Login → JWT for /chat & Stage 1" },
    { name: "Frontend — Paid chat (/chat)", description: "25Q diagnostic + discovery chat" },
    { name: "Frontend — Paid hub (/dashboard)", description: "Reports & metrics" },
    { name: "Frontend — Free funnel", description: "IRL — 3 reports / 7 days, funnel token" },
  ],
  components: {
    securitySchemes: {
      bearerAuth: {
        type: "http",
        scheme: "bearer",
        bearerFormat: "JWT",
        description:
          "From POST /diagnostics/checkUser (UC) or POST /users/verifyOTP — field `result.token`",
      },
      funnelToken: {
        type: "apiKey",
        in: "query",
        name: "token",
        description: "Funnel magic-link JWT (not UC bearer)",
      },
    },
    schemas: {
      ApiError: apiErrorEnvelope,
      DomainMap: domainMapSchema,
      HomeResult: homeResultSchema,
    },
  },
  paths: {
    "/health": {
      get: {
        tags: ["Health"],
        summary: "Health check",
        responses: {
          200: {
            description: "OK",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    status: { type: "string" },
                    timestamp: { type: "string" },
                  },
                },
              },
            },
          },
        },
      },
    },
    ...frontendAuthPaths,
    ...stage1Paths,
    ...frontendPaidPaths,
    ...frontendFunnelPaths,
  },
};

module.exports = { openapiSpec, DOMAIN_ENUM };
