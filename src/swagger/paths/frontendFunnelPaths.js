const { apiErrorEnvelope } = require("../common");

/** Matches Next.js /funnel/* — token in body/query, not UC JWT */
const frontendFunnelPaths = {
  "/funnel/validate-token": {
    post: {
      tags: ["Frontend — Free funnel"],
      summary: "validate-token — magic link entry",
      description: "**Next.js:** `POST /api/funnel/validate-token` — body includes funnel JWT from `?token=`",
      requestBody: {
        content: {
          "application/json": {
            schema: {
              type: "object",
              properties: { token: { type: "string" } },
            },
          },
        },
      },
      responses: { 200: { description: "Valid session" } },
    },
  },
  "/funnel/access-status": {
    get: {
      tags: ["Frontend — Free funnel"],
      summary: "access-status — 3 reports / 7 days",
      parameters: [
        { name: "token", in: "query", schema: { type: "string" } },
      ],
      responses: { 200: { description: "Remaining diagnostics & days" } },
    },
  },
  "/funnel/start-diagnostic": {
    post: {
      tags: ["Frontend — Free funnel"],
      summary: "start-diagnostic",
      responses: { 200: { description: "Socket session token" } },
    },
  },
  "/funnel/socket-session": {
    post: {
      tags: ["Frontend — Free funnel"],
      summary: "socket-session — resume Q&A",
      responses: { 200: { description: "Socket JWT" } },
    },
  },
  "/funnel/chats": {
    get: {
      tags: ["Frontend — Free funnel"],
      summary: "list funnel chats",
      responses: { 200: { description: "Chat list" } },
    },
  },
  "/funnel/chat/{chatId}": {
    get: {
      tags: ["Frontend — Free funnel"],
      summary: "get funnel chat transcript",
      parameters: [
        { name: "chatId", in: "path", required: true, schema: { type: "integer" } },
      ],
      responses: { 200: { description: "Transcript" } },
    },
  },
  "/funnel/diagnostics": {
    get: {
      tags: ["Frontend — Free funnel"],
      summary: "list completed IRL diagnostics",
      responses: { 200: { description: "Reports list" } },
    },
  },
  "/funnel/report/{diagnosticId}": {
    get: {
      tags: ["Frontend — Free funnel"],
      summary: "IRL report HTML/JSON",
      parameters: [
        { name: "diagnosticId", in: "path", required: true, schema: { type: "integer" } },
        { name: "format", in: "query", schema: { type: "string", enum: ["pdf"] } },
      ],
      responses: { 200: { description: "Report" } },
    },
  },
  "/funnel/report/{diagnosticId}/pdf": {
    get: {
      tags: ["Frontend — Free funnel"],
      summary: "download IRL PDF",
      parameters: [
        { name: "diagnosticId", in: "path", required: true, schema: { type: "integer" } },
      ],
      responses: { 200: { description: "PDF file" } },
    },
  },
  "/funnel/resend-report": {
    post: {
      tags: ["Frontend — Free funnel"],
      summary: "resend-report email",
      responses: { 200: { description: "Email sent" } },
    },
  },
  "/funnel/expired": {
    get: {
      tags: ["Frontend — Free funnel"],
      summary: "expired page copy",
      responses: { 200: { description: "Message + CTA" } },
    },
  },
};

module.exports = { frontendFunnelPaths };
