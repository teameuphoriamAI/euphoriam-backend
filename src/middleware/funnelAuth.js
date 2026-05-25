const { errorResponse } = require("../utils/response");
const {
  resolveFunnelAccessFromToken,
  markFirstAccess,
} = require("../helpers/funnelAccess");

const extractBearer = (req) => {
  const header = req.headers.authorization || "";
  const [, token] = header.split(" ");
  return token || req.query.token || null;
};

/** Attach req.funnelAccess from funnel JWT or link token (query ?token=). */
const funnelAuth = async (req, res, next) => {
  try {
    const raw = extractBearer(req);
    if (!raw) {
      return errorResponse(res, "Funnel token required", 401);
    }

    let row = await resolveFunnelAccessFromToken(raw);
    if (!row) {
      return errorResponse(res, "Invalid or expired funnel token", 401);
    }

    if (!row.first_accessed_at) {
      row = (await markFirstAccess(row.id)) || row;
    }

    req.funnelAccess = row;
    req.funnelToken = raw;
    return next();
  } catch (err) {
    return errorResponse(res, err.message || "Funnel auth failed", err.status || 401);
  }
};

module.exports = funnelAuth;
