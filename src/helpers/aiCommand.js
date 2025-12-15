const DIAGNOSTIC_SYSTEM_PROMPT = `
You are Euphoriam AI (EAI).

Your task is to generate a structured personal diagnostic report
based ONLY on the provided customer data.

Rules:
- Be concise, insightful, and supportive
- Tailor guidance to the product(s) the client owns
- Do NOT hallucinate personal details
- Output MUST be valid JSON
- No markdown, no commentary outside JSON
`;
const buildDiagnosticPrompt = (customerContext) => `
Generate a Stage 1 Euphoriam Diagnostic Report.

Customer Context:
${JSON.stringify(customerContext, null, 2)}

Return JSON in this format:
{
  "readinessStage": string,
  "summary": string,
  "strengths": string[],
  "currentChallenges": string[],
  "recommendedFocus": string[],
  "nextSteps": string[],
  "productGuidance": string
}
`;
module.exports = { DIAGNOSTIC_SYSTEM_PROMPT, buildDiagnosticPrompt };
