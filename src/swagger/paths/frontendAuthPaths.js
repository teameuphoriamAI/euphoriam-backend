const { apiSuccessEnvelope, apiErrorEnvelope, bearerSecurity, jwtResultSchema } = require("../common");

/** Matches Next.js: /api/diagnostic/checkUser, /api/users/* */
const frontendAuthPaths = {
  "/diagnostics/checkUser": {
    post: {
      tags: ["Frontend — Auth (paid UC)"],
      summary: "checkUser — login / signup start",
      description: `
**Next.js:** \`POST /api/diagnostic/checkUser\` → this backend route.

- **Paid UC member:** returns \`result.token\` (JWT) — use in **Authorize** for Stage 1 + /chat.
- **Free user:** returns \`funnel_redirect: true\` + \`link\` — use Funnel APIs instead (no JWT).
      `.trim(),
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              required: ["email"],
              properties: {
                email: { type: "string", format: "email" },
                name: { type: "string", description: "Required for new signup" },
                signup: { type: "boolean", description: "true when registering" },
              },
            },
            example: { email: "member@example.com", name: "Test User", signup: false },
          },
        },
      },
      responses: {
        200: {
          description: "UC member — JWT returned",
          content: {
            "application/json": {
              schema: apiSuccessEnvelope(jwtResultSchema),
            },
          },
        },
        400: { description: "Validation / account exists", content: { "application/json": { schema: apiErrorEnvelope } } },
      },
    },
  },
  "/users/verifyOTP": {
    post: {
      tags: ["Frontend — Auth (paid UC)"],
      summary: "verifyOTP — confirm 6-digit code",
      description: "**Next.js:** `POST /api/users/verifyOTP`",
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              required: ["email", "otp"],
              properties: {
                email: { type: "string" },
                otp: { type: "string", example: "123456" },
              },
            },
          },
        },
      },
      responses: {
        200: {
          description: "JWT",
          content: { "application/json": { schema: apiSuccessEnvelope(jwtResultSchema) } },
        },
      },
    },
  },
  "/users/resendOTP": {
    post: {
      tags: ["Frontend — Auth (paid UC)"],
      summary: "resendOTP",
      description: "**Next.js:** `POST /api/users/resendOTP`",
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
      responses: { 200: { description: "OTP resent" } },
    },
  },
  "/users/profile": {
    post: {
      tags: ["Frontend — Auth (paid UC)"],
      summary: "profile — sidebar, membership",
      description: "**Next.js:** `POST /api/users/profile` (Bearer required)",
      security: bearerSecurity,
      responses: { 200: { description: "Profile + membership" } },
    },
  },
  "/users/updateTheme": {
    post: {
      tags: ["Frontend — Auth (paid UC)"],
      summary: "updateTheme — light/dark",
      requestBody: {
        content: {
          "application/json": {
            schema: {
              type: "object",
              properties: { lightTheme: { type: "boolean" } },
            },
          },
        },
      },
      responses: { 200: { description: "OK" } },
    },
  },
  "/auth/login": {
    post: {
      tags: ["Frontend — Auth (paid UC)"],
      summary: "password login (admin-style, optional)",
      description: "Not used by main app login flow; handy for Swagger if user has password set.",
      requestBody: {
        content: {
          "application/json": {
            schema: {
              type: "object",
              properties: {
                email: { type: "string" },
                password: { type: "string" },
              },
            },
          },
        },
      },
      responses: {
        200: {
          content: { "application/json": { schema: apiSuccessEnvelope({ type: "object" }) } },
        },
      },
    },
  },
};

module.exports = { frontendAuthPaths };
