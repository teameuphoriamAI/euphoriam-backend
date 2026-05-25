const { apiSuccessEnvelope, apiErrorEnvelope, bearerSecurity } = require("../common");

/** Matches Next.js paid /chat and /dashboard proxies */
const frontendPaidPaths = {
  "/diagnostics/chatbot-freeform": {
    post: {
      tags: ["Frontend — Paid chat (/chat)"],
      summary: "chatbot-freeform — core chat + finalize",
      description: `
**Next.js:** \`POST /api/diagnostics/chatbot-freeform\`

- Send \`messages[]\` each turn (user + assistant).
- \`finalize: true\` → generate diagnostic/discovery report.
- 25 core Q + up to 6 CB if confidence < 85%.
      `.trim(),
      security: bearerSecurity,
      requestBody: {
        content: {
          "application/json": {
            schema: {
              type: "object",
              properties: {
                messages: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      role: { type: "string", enum: ["user", "assistant"] },
                      content: { type: "string" },
                    },
                  },
                },
                finalize: { type: "boolean", default: false },
                targetCount: { type: "integer", example: 25 },
                introPageText: { type: "string" },
              },
            },
          },
        },
      },
      responses: { 200: { description: "Assistant message or report payload" } },
    },
  },
  "/chat/reset": {
    post: {
      tags: ["Frontend — Paid chat (/chat)"],
      summary: "reset chat session",
      security: bearerSecurity,
      requestBody: {
        content: {
          "application/json": {
            schema: {
              type: "object",
              properties: {
                mode: { type: "string", enum: ["diagnostic", "discovery"] },
              },
            },
          },
        },
      },
      responses: { 200: { description: "Reset OK" } },
    },
  },
  "/chat/getHistory": {
    post: {
      tags: ["Frontend — Paid chat (/chat)"],
      summary: "chat history list (sidebar)",
      security: bearerSecurity,
      responses: { 200: { description: "Chat list" } },
    },
  },
  "/diagnostics/{id}": {
    get: {
      tags: ["Frontend — Paid hub (/dashboard)"],
      summary: "Get diagnostic by id (report + metrics)",
      description: "**Next.js:** `GET /api/diagnostic/{id}`",
      security: bearerSecurity,
      parameters: [
        {
          name: "id",
          in: "path",
          required: true,
          schema: { type: "integer" },
        },
      ],
      responses: { 200: { description: "Diagnostic" } },
    },
  },
  "/diagnostics/pdf-urls": {
    post: {
      tags: ["Frontend — Paid hub (/dashboard)"],
      summary: "List member PDFs",
      security: bearerSecurity,
      responses: { 200: { description: "PDF URLs" } },
    },
  },
  "/discoveries/findByEmail": {
    post: {
      tags: ["Frontend — Paid hub (/dashboard)"],
      summary: "Discovery by email (metrics fallback)",
      description: "**Next.js:** `POST /api/discovery`",
      security: bearerSecurity,
      requestBody: {
        content: {
          "application/json": {
            schema: {
              type: "object",
              properties: { email: { type: "string" } },
            },
          },
        },
      },
      responses: { 200: { description: "Discoveries" } },
    },
  },
};

module.exports = { frontendPaidPaths };
