const crypto = require("crypto");
const { sequelize } = require("../config/sequelize");
const { withDbSlot } = require("../config/sequelize");
const {
  MAX_DIAGNOSTICS,
  ACCESS_WINDOW_DAYS,
  LINK_VALIDITY_DAYS,
} = require("./funnelConstants");
const { signFunnelSession, verifyFunnelSession } = require("./funnelToken");

const addDays = (date, days) => {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
};

const mapRow = (row) => {
  if (!row) return null;
  return {
    id: row.id,
    email: row.email,
    link_token: row.link_token,
    link_created_at: row.link_created_at,
    link_expiry: row.link_expiry,
    first_accessed_at: row.first_accessed_at,
    expires_at: row.expires_at,
    diagnostics_completed_count: Number(row.diagnostics_completed_count) || 0,
    report_generated_count: Number(row.report_generated_count) || 0,
    is_blocked: Boolean(row.is_blocked),
    block_reason: row.block_reason,
    metadata: row.metadata || {},
  };
};

const getFunnelAccessById = async (id) => {
  const [rows] = await withDbSlot(() =>
    sequelize.query(
      `SELECT * FROM funnel_access WHERE id = :id LIMIT 1`,
      { replacements: { id } },
    ),
  );
  return mapRow(rows[0]);
};

const getFunnelAccessByLinkToken = async (token) => {
  const [rows] = await withDbSlot(() =>
    sequelize.query(
      `SELECT * FROM funnel_access WHERE link_token = :token LIMIT 1`,
      { replacements: { token } },
    ),
  );
  return mapRow(rows[0]);
};

const getFunnelAccessByEmail = async (email) => {
  const normalized = String(email || "")
    .trim()
    .toLowerCase();
  if (!normalized) return null;
  const [rows] = await withDbSlot(() =>
    sequelize.query(
      `SELECT * FROM funnel_access WHERE LOWER(email) = :email ORDER BY "createdAt" DESC LIMIT 1`,
      { replacements: { email: normalized } },
    ),
  );
  return mapRow(rows[0]);
};

/** Create or return existing funnel_access for a free-tier email. */
const ensureFunnelAccess = async (email, { ip } = {}) => {
  const normalized = String(email || "")
    .trim()
    .toLowerCase();
  if (!normalized) {
    const err = new Error("Email is required");
    err.status = 400;
    throw err;
  }

  const existing = await getFunnelAccessByEmail(normalized);
  if (existing) return existing;

  const now = new Date();
  const linkToken = crypto.randomBytes(32).toString("hex");
  const linkExpiry = addDays(now, LINK_VALIDITY_DAYS);

  const [rows] = await withDbSlot(() =>
    sequelize.query(
      `INSERT INTO funnel_access (
        email, link_token, link_created_at, link_expiry, ip_at_creation, metadata
      ) VALUES (
        :email, :link_token, :link_created_at, :link_expiry, :ip, '{}'::jsonb
      )
      RETURNING *`,
      {
        replacements: {
          email: normalized,
          link_token: linkToken,
          link_created_at: now.toISOString(),
          link_expiry: linkExpiry.toISOString(),
          ip: ip || null,
        },
      },
    ),
  );

  return mapRow(rows[0]);
};

const markFirstAccess = async (id) => {
  const now = new Date();
  const expiresAt = addDays(now, ACCESS_WINDOW_DAYS);
  await withDbSlot(() =>
    sequelize.query(
      `UPDATE funnel_access
       SET first_accessed_at = COALESCE(first_accessed_at, :now),
           expires_at = COALESCE(expires_at, :expires_at),
           ip_at_first_access = COALESCE(ip_at_first_access, :ip),
           "updatedAt" = NOW()
       WHERE id = :id`,
      {
        replacements: {
          id,
          now: now.toISOString(),
          expires_at: expiresAt.toISOString(),
          ip: null,
        },
      },
    ),
  );
  return getFunnelAccessById(id);
};

const computeAccessStatus = (row) => {
  const email = row?.email || null;
  const base = {
    valid: false,
    email,
    diagnostics_remaining: 0,
    days_remaining: 0,
    can_start_new: false,
    reason: "invalid_token",
  };

  if (!row) return base;

  if (row.is_blocked) {
    return {
      ...base,
      reason: row.block_reason || "blocked",
    };
  }

  const now = Date.now();

  if (!row.first_accessed_at && row.link_expiry) {
    if (new Date(row.link_expiry).getTime() < now) {
      return { ...base, email, reason: "link_expired" };
    }
  }

  if (row.expires_at && new Date(row.expires_at).getTime() < now) {
    return {
      ...base,
      email,
      reason: "access_expired",
    };
  }

  const completed = Number(row.diagnostics_completed_count) || 0;
  const diagnostics_remaining = Math.max(0, MAX_DIAGNOSTICS - completed);

  let days_remaining = 0;
  if (row.expires_at) {
    days_remaining = Math.max(
      0,
      Math.ceil((new Date(row.expires_at).getTime() - now) / 86400000),
    );
  } else if (row.link_expiry) {
    days_remaining = Math.max(
      0,
      Math.ceil((new Date(row.link_expiry).getTime() - now) / 86400000),
    );
  }

  if (diagnostics_remaining <= 0) {
    return {
      valid: true,
      email,
      diagnostics_remaining: 0,
      days_remaining,
      can_start_new: false,
      reason: "limit_reached",
    };
  }

  return {
    valid: true,
    email,
    diagnostics_remaining,
    days_remaining,
    can_start_new: true,
    reason: null,
  };
};

const buildFunnelLoginLink = (sessionToken) => {
  const base = (process.env.FRONTEND_URL || "http://localhost:3000").replace(
    /\/$/,
    "",
  );
  return `${base}/free-dashboard?token=${encodeURIComponent(sessionToken)}`;
};

const issueSessionForAccess = (row) => {
  const token = signFunnelSession({
    funnel_access_id: row.id,
    email: row.email,
  });
  return {
    token,
    link: buildFunnelLoginLink(token),
    expires_at: row.expires_at || row.link_expiry,
  };
};

const resolveFunnelAccessFromToken = async (rawToken) => {
  if (!rawToken) return null;

  try {
    const decoded = verifyFunnelSession(rawToken);
    if (decoded.funnel_access_id) {
      return getFunnelAccessById(decoded.funnel_access_id);
    }
    if (decoded.email) {
      return getFunnelAccessByEmail(decoded.email);
    }
  } catch {
    /* fall through to link_token lookup */
  }

  return getFunnelAccessByLinkToken(rawToken);
};

const listFunnelDiagnostics = async (row) => {
  const [diagnostics] = await withDbSlot(() =>
    sequelize.query(
      `SELECT id, email, "pdfUrl", "createdAt", data
       FROM diagnostics
       WHERE funnel_access_id = :funnelId
          OR (LOWER(email) = :email AND funnel_access_id IS NULL)
       ORDER BY "createdAt" DESC
       LIMIT 50`,
      {
        replacements: { funnelId: row.id, email: row.email.toLowerCase() },
      },
    ),
  );

  return (diagnostics || []).map((d) => {
    const data = d.data || {};
    return {
      id: String(d.id),
      created_at: d.createdAt,
      pdf_url: d.pdfUrl || null,
      structure_type: data.structure_type || data.report_type || null,
      domain_primary:
        data.domain_primary ||
        data.metrics?.domain_primary ||
        data.diagnostic_packet?.domain_primary ||
        null,
    };
  });
};

module.exports = {
  ensureFunnelAccess,
  getFunnelAccessById,
  getFunnelAccessByLinkToken,
  getFunnelAccessByEmail,
  markFirstAccess,
  computeAccessStatus,
  issueSessionForAccess,
  resolveFunnelAccessFromToken,
  listFunnelDiagnostics,
  buildFunnelLoginLink,
};
