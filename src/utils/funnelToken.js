const jwt = require("jsonwebtoken");
const crypto = require("crypto");

const { JWT_ACCESS_SECRET, JWT_FUNNEL_SECRET } = process.env;

// Use a dedicated funnel secret if provided, otherwise derive one from the
// main secret with a prefix — this ensures funnel tokens cannot be accepted
// where user auth tokens are expected and vice-versa.
const getFunnelSecret = () => {
  if (!JWT_ACCESS_SECRET) {
    throw new Error("JWT_ACCESS_SECRET is required");
  }
  return JWT_FUNNEL_SECRET || `funnel_${JWT_ACCESS_SECRET}`;
};

const FUNNEL_TOKEN_EXPIRY = "10d";

/**
 * Generate a signed JWT funnel access token.
 *
 * @param {object} payload
 * @param {string} payload.email              - User email
 * @param {string} [payload.kajabi_offer_source] - Campaign/funnel identifier
 * @param {string} [payload.nonce]            - Unique nonce (auto-generated if omitted)
 * @returns {string} Signed JWT string
 */
const generateFunnelToken = ({ email, kajabi_offer_source = null, nonce = null }) => {
  if (!email) throw new Error("email is required to generate a funnel token");

  const tokenPayload = {
    email,
    kajabi_offer_source,
    nonce: nonce || crypto.randomBytes(16).toString("hex"),
    type: "funnel_access",
  };

  return jwt.sign(tokenPayload, getFunnelSecret(), { expiresIn: FUNNEL_TOKEN_EXPIRY });
};

/**
 * Verify and decode a funnel access token.
 *
 * @param {string} token - JWT string to verify
 * @returns {{ email: string, kajabi_offer_source: string|null, nonce: string } | null}
 *   Decoded payload on success, null if invalid or expired.
 */
const verifyFunnelToken = (token) => {
  if (!token) return null;

  try {
    const decoded = jwt.verify(token, getFunnelSecret());

    // Guard: reject tokens that are not explicitly typed as funnel_access
    if (decoded.type !== "funnel_access") return null;

    return {
      email: decoded.email,
      kajabi_offer_source: decoded.kajabi_offer_source || null,
      nonce: decoded.nonce,
    };
  } catch {
    return null;
  }
};

// ── Funnel session tokens ─────────────────────────────────────────────────────
// Short-lived (2 hr) tokens issued by startDiagnostic to authenticate the
// Socket.IO connection for a single funnel diagnostic session.

const FUNNEL_SESSION_EXPIRY = "2h";

/**
 * Generate a short-lived funnel session token.
 *
 * @param {object} payload
 * @param {string} payload.email
 * @param {string} payload.funnel_access_id
 * @param {number|string} payload.chat_id
 * @returns {string} Signed JWT string
 */
const generateFunnelSessionToken = ({ email, funnel_access_id, chat_id }) => {
  return jwt.sign(
    { email, funnel_access_id, chat_id, type: "funnel_session" },
    getFunnelSecret(),
    { expiresIn: FUNNEL_SESSION_EXPIRY }
  );
};

/**
 * Verify and decode a funnel session token.
 *
 * @param {string} token
 * @returns {{ email: string, funnel_access_id: string, chat_id: number|string } | null}
 */
const verifyFunnelSessionToken = (token) => {
  if (!token) return null;
  try {
    const decoded = jwt.verify(token, getFunnelSecret());
    if (decoded.type !== "funnel_session") return null;
    return {
      email: decoded.email,
      funnel_access_id: decoded.funnel_access_id,
      chat_id: decoded.chat_id,
    };
  } catch {
    return null;
  }
};

module.exports = {
  generateFunnelToken,
  verifyFunnelToken,
  generateFunnelSessionToken,
  verifyFunnelSessionToken,
};
