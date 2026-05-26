const { rateLimit, ipKeyGenerator } = require("express-rate-limit");

/**
 * Per-IP rate limiter applied to write/state-changing /api/funnel/* routes.
 * Read-only polling endpoints (access-status, expired) are excluded via `skip`.
 * Max 60 requests per minute per IP — generous enough for a normal session that
 * visits several funnel pages in quick succession.
 */
const funnelIpLimit = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  // Use library helper to prevent IPv6 bypass issues.
  // (Relies on Express `req.ip`, so ensure `trust proxy` is configured correctly in production.)
  keyGenerator: (req) => ipKeyGenerator(req),
  message: {
    status: false,
    error: "Too many requests. Please wait a moment and try again.",
  },
  skip: (req) => {
    const p = req.path || "";
    // Never rate-limit internal complete-diagnostic calls (fired by socket, not browser)
    // Skip read-only polling / list endpoints used on hub + chat sidebar
    return (
      p === "/complete-diagnostic" ||
      p === "/access-status" ||
      p === "/expired" ||
      p === "/diagnostics" ||
      p === "/chats" ||
      (p.startsWith("/chat/") && req.method === "GET")
    );
  },
});

/**
 * Stricter per-IP rate limiter for the token creation endpoint.
 * Kajabi should never need more than 1–2 token creations per minute from one IP.
 * Max 5 requests per minute.
 */
const createTokenLimit = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  // Use library helper to prevent IPv6 bypass issues.
  keyGenerator: (req) => ipKeyGenerator(req),
  message: {
    status: false,
    error: "Too many token creation requests. Please try again shortly.",
  },
});

/**
 * Question-submission rate limiter — applied inside the Socket.IO
 * user_message handler for funnel sessions via the exported helper.
 *
 * Implemented as a simple in-memory sliding window (not express-based,
 * since Socket.IO events don't go through Express middleware).
 */
const _questionWindows = new Map();
const QUESTION_WINDOW_MS = 60 * 1000;
const QUESTION_MAX = 20;

/**
 * Check if the socket IP has exceeded the question submission rate limit.
 * @param {string} ip - Client IP address
 * @returns {boolean} true if blocked (rate limit exceeded), false if allowed
 */
const isQuestionRateLimited = (ip) => {
  const now = Date.now();
  const key = ip || "unknown";

  if (!_questionWindows.has(key)) {
    _questionWindows.set(key, []);
  }

  // Prune timestamps older than the window
  const timestamps = _questionWindows
    .get(key)
    .filter((t) => now - t < QUESTION_WINDOW_MS);

  if (timestamps.length >= QUESTION_MAX) {
    _questionWindows.set(key, timestamps);
    return true; // blocked
  }

  timestamps.push(now);
  _questionWindows.set(key, timestamps);
  return false; // allowed
};

// Periodic cleanup of stale entries to prevent memory leak
setInterval(() => {
  const now = Date.now();
  for (const [key, timestamps] of _questionWindows.entries()) {
    const fresh = timestamps.filter((t) => now - t < QUESTION_WINDOW_MS);
    if (fresh.length === 0) {
      _questionWindows.delete(key);
    } else {
      _questionWindows.set(key, fresh);
    }
  }
}, 5 * 60 * 1000);

module.exports = { funnelIpLimit, createTokenLimit, isQuestionRateLimited };
