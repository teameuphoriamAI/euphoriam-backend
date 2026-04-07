/**
 * Prompt injection guard for funnel diagnostic sessions.
 *
 * Detects common patterns used to extract system instructions, bypass rules,
 * or manipulate the AI into revealing internal configuration.
 *
 * Applied in the Socket.IO user_message handler for funnel (isFunnelMode) sessions.
 */

const INJECTION_PATTERNS = [
  /show\s*(me\s*)?(the\s*)?(brain\s*)?(system\s*)?prompt/i,
  /ignore\s*(previous|all|prior)\s*instructions/i,
  /reveal\s*(system|hidden|internal)\s*(message|prompt|instructions)/i,
  /print\s*(hidden|your|the)\s*prompt/i,
  /show\s*(me\s*)?(your\s*)?(rules|instructions|config|settings)/i,
  /what\s*(are\s*)?(your\s*)?(instructions|rules|prompts)/i,
  /bypass\s*(your\s*)?(instructions|rules|filters)/i,
  /pretend\s*(you\s*(are|have)\s*no\s*(restrictions|rules))/i,
  /act\s*as\s*(if\s*)?(you\s*(are|have)\s*no\s*(restrictions|rules))/i,
  /you\s*are\s*now\s*(a\s*)?(different|new|another)\s*(ai|model|bot|assistant)/i,
  /jailbreak/i,
  /dan\s*mode/i,
  /developer\s*mode/i,
  /override\s*(all\s*)?(safety|restrictions|rules|guidelines)/i,
  /forget\s*(all\s*)?(your\s*)?(previous\s*)?(instructions|training|rules)/i,
  /respond\s*(only\s*)?as\s*(if\s*)?you\s*(have\s*)?no\s*(restrictions|rules|limits)/i,
  /what\s*(is|was)\s*(your\s*)?(system|initial|first)\s*(message|prompt)/i,
  /repeat\s*(your|the)\s*(system\s*)?prompt/i,
  /output\s*(the\s*)?(raw|full|entire)\s*(system|initial)\s*(prompt|message)/i,
];

const REFUSAL_MESSAGE =
  "I'm here to help with your diagnostic questions. I can't assist with requests about internal instructions or system configuration.";

/**
 * Returns true if the given text contains a known injection pattern.
 * @param {string} text
 * @returns {boolean}
 */
const detectInjection = (text = "") =>
  INJECTION_PATTERNS.some((pattern) => pattern.test(text));

/**
 * Check a user message for injection attempts.
 * @param {string} text
 * @returns {{ blocked: boolean, response?: string }}
 */
const guardMessage = (text = "") => {
  if (detectInjection(text)) {
    return { blocked: true, response: REFUSAL_MESSAGE };
  }
  return { blocked: false };
};

module.exports = { detectInjection, guardMessage, REFUSAL_MESSAGE };
