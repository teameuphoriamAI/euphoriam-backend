const jwt = require("jsonwebtoken");

const FUNNEL_SECRET =
  process.env.FUNNEL_JWT_SECRET || process.env.JWT_ACCESS_SECRET;
const FUNNEL_EXPIRES_IN = process.env.FUNNEL_JWT_EXPIRES_IN || "10d";

if (!FUNNEL_SECRET) {
  throw new Error("FUNNEL_JWT_SECRET or JWT_ACCESS_SECRET is required for funnel tokens");
}

const signFunnelSession = (payload) =>
  jwt.sign({ ...payload, typ: "funnel" }, FUNNEL_SECRET, {
    expiresIn: FUNNEL_EXPIRES_IN,
  });

const verifyFunnelSession = (token) => {
  const decoded = jwt.verify(token, FUNNEL_SECRET);
  if (decoded.typ && decoded.typ !== "funnel") {
    const err = new Error("Invalid funnel token type");
    err.status = 401;
    throw err;
  }
  return decoded;
};

module.exports = {
  signFunnelSession,
  verifyFunnelSession,
};
