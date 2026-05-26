// Tests for funnel JWT token generation and verification.
// These do not require a DB connection.

// Provide a test secret before any module loads
process.env.JWT_ACCESS_SECRET = "test-secret-for-unit-tests";

const {
  generateFunnelToken,
  verifyFunnelToken,
  generateFunnelSessionToken,
  verifyFunnelSessionToken,
} = require("../utils/funnelToken");

// ── generateFunnelToken / verifyFunnelToken ────────────────────────────────────

describe("generateFunnelToken + verifyFunnelToken", () => {
  const EMAIL = "user@example.com";
  const SOURCE = "masterclass-jan-2026";

  test("generates a non-empty JWT string", () => {
    const token = generateFunnelToken({ email: EMAIL });
    expect(typeof token).toBe("string");
    expect(token.split(".")).toHaveLength(3);
  });

  test("verifies a valid token and returns correct payload", () => {
    const token = generateFunnelToken({ email: EMAIL, kajabi_offer_source: SOURCE });
    const payload = verifyFunnelToken(token);

    expect(payload).not.toBeNull();
    expect(payload.email).toBe(EMAIL);
    expect(payload.kajabi_offer_source).toBe(SOURCE);
    expect(typeof payload.nonce).toBe("string");
  });

  test("returns null for a tampered token", () => {
    const token = generateFunnelToken({ email: EMAIL });
    const tampered = token.slice(0, -5) + "XXXXX";
    expect(verifyFunnelToken(tampered)).toBeNull();
  });

  test("returns null for an empty string", () => {
    expect(verifyFunnelToken("")).toBeNull();
  });

  test("returns null for null input", () => {
    expect(verifyFunnelToken(null)).toBeNull();
  });

  test("returns null for undefined input", () => {
    expect(verifyFunnelToken(undefined)).toBeNull();
  });

  test("returns null for a plain user JWT (wrong type)", () => {
    const jwt = require("jsonwebtoken");
    // Simulate a standard user token signed with the funnel secret but wrong type
    const secret = `funnel_${process.env.JWT_ACCESS_SECRET}`;
    const userLikeToken = jwt.sign(
      { email: EMAIL, type: "user_auth" },
      secret,
      { expiresIn: "1d" }
    );
    expect(verifyFunnelToken(userLikeToken)).toBeNull();
  });

  test("throws if email is missing", () => {
    expect(() => generateFunnelToken({ email: "" })).toThrow();
  });

  test("uses provided nonce instead of generating one", () => {
    const nonce = "fixed-nonce-abc";
    const token = generateFunnelToken({ email: EMAIL, nonce });
    const payload = verifyFunnelToken(token);
    expect(payload.nonce).toBe(nonce);
  });

  test("two tokens for same email have different nonces", () => {
    const t1 = generateFunnelToken({ email: EMAIL });
    const t2 = generateFunnelToken({ email: EMAIL });
    const p1 = verifyFunnelToken(t1);
    const p2 = verifyFunnelToken(t2);
    expect(p1.nonce).not.toBe(p2.nonce);
  });
});

// ── generateFunnelSessionToken / verifyFunnelSessionToken ─────────────────────

describe("generateFunnelSessionToken + verifyFunnelSessionToken", () => {
  const PAYLOAD = {
    email: "session@example.com",
    funnel_access_id: "uuid-1234",
    chat_id: 42,
  };

  test("generates a non-empty JWT string", () => {
    const token = generateFunnelSessionToken(PAYLOAD);
    expect(typeof token).toBe("string");
    expect(token.split(".")).toHaveLength(3);
  });

  test("verifies a valid session token and returns correct payload", () => {
    const token = generateFunnelSessionToken(PAYLOAD);
    const decoded = verifyFunnelSessionToken(token);

    expect(decoded).not.toBeNull();
    expect(decoded.email).toBe(PAYLOAD.email);
    expect(decoded.funnel_access_id).toBe(PAYLOAD.funnel_access_id);
    expect(decoded.chat_id).toBe(PAYLOAD.chat_id);
  });

  test("funnel access token cannot be used as a session token", () => {
    const accessToken = generateFunnelToken({ email: PAYLOAD.email });
    const result = verifyFunnelSessionToken(accessToken);
    expect(result).toBeNull();
  });

  test("funnel session token cannot be used as an access token", () => {
    const sessionToken = generateFunnelSessionToken(PAYLOAD);
    const result = verifyFunnelToken(sessionToken);
    expect(result).toBeNull();
  });

  test("returns null for empty string", () => {
    expect(verifyFunnelSessionToken("")).toBeNull();
  });

  test("returns null for null", () => {
    expect(verifyFunnelSessionToken(null)).toBeNull();
  });

  test("returns null for tampered session token", () => {
    const token = generateFunnelSessionToken(PAYLOAD);
    const tampered = token.slice(0, -4) + "ZZZZ";
    expect(verifyFunnelSessionToken(tampered)).toBeNull();
  });
});
