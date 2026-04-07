const { QueryTypes } = require("sequelize");
const { sequelize, withDbSlot } = require("../config/sequelize");

/**
 * Build the WHERE clause parts and bind parameters for the shared filter set.
 *
 * @param {object} opts
 * @param {string} [opts.date_from]    ISO date string
 * @param {string} [opts.date_to]      ISO date string
 * @param {string} [opts.funnel_source] kajabi_offer_source value
 * @param {string} [opts.report_type]  "invisible_red_line" | "full" | "all"
 * @returns {{ whereClauses: string[], bind: object }}
 */
const buildFilters = ({ date_from, date_to, funnel_source, report_type } = {}) => {
  const whereClauses = [];
  const bind = {};

  // Only aggregate diagnostics that have a structuredPacket
  whereClauses.push(`d.data ? 'structuredPacket'`);

  if (report_type && report_type !== "all") {
    whereClauses.push(`d.report_type = $report_type`);
    bind.report_type = report_type;
  } else {
    // Default: funnel IRL diagnostics only
    whereClauses.push(`d.report_type = 'invisible_red_line'`);
  }

  if (date_from) {
    whereClauses.push(`d."createdAt" >= $date_from::timestamptz`);
    bind.date_from = date_from;
  }

  if (date_to) {
    whereClauses.push(`d."createdAt" <= $date_to::timestamptz`);
    bind.date_to = date_to;
  }

  if (funnel_source) {
    whereClauses.push(`fa.kajabi_offer_source = $funnel_source`);
    bind.funnel_source = funnel_source;
  }

  return { whereClauses, bind };
};

const buildWhereStr = (clauses) =>
  clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";

/**
 * Aggregate market research data from completed funnel diagnostics.
 *
 * Reads from `diagnostic.data.structuredPacket` (JSONB) which is populated
 * by `extractStructuredPacket()` in Phase 3.
 *
 * @param {object} [opts]
 * @param {string} [opts.date_from]
 * @param {string} [opts.date_to]
 * @param {string} [opts.funnel_source]
 * @param {string} [opts.report_type]
 * @returns {Promise<object>} Aggregated market research data object
 */
const getMarketResearchData = async ({
  date_from,
  date_to,
  funnel_source,
  report_type,
} = {}) => {
  const { whereClauses, bind } = buildFilters({ date_from, date_to, funnel_source, report_type });
  const whereStr = buildWhereStr(whereClauses);

  const baseQuery = `
    FROM diagnostics d
    LEFT JOIN funnel_access fa ON fa.id = d.funnel_access_id::uuid
    ${whereStr}
  `;

  // ── 1. Total count ──────────────────────────────────────────────────────────
  const [{ total }] = await withDbSlot(() =>
    sequelize.query(`SELECT COUNT(*) AS total ${baseQuery}`, {
      type: QueryTypes.SELECT, bind,
    })
  );

  // ── 2. EO distribution ─────────────────────────────────────────────────────
  const eoRows = await withDbSlot(() =>
    sequelize.query(
      `SELECT d.data->'structuredPacket'->'diagnostic_packet'->>'EO' AS eo, COUNT(*) AS cnt
       ${baseQuery}
       GROUP BY eo ORDER BY cnt DESC`,
      { type: QueryTypes.SELECT, bind }
    )
  );
  const eo_distribution = {};
  eoRows.forEach((r) => { if (r.eo) eo_distribution[r.eo] = parseInt(r.cnt, 10); });

  // ── 3. Lack distribution ───────────────────────────────────────────────────
  const lackRows = await withDbSlot(() =>
    sequelize.query(
      `SELECT d.data->'structuredPacket'->'diagnostic_packet'->>'lack' AS lack, COUNT(*) AS cnt
       ${baseQuery}
       GROUP BY lack ORDER BY cnt DESC`,
      { type: QueryTypes.SELECT, bind }
    )
  );
  const lack_distribution = {};
  lackRows.forEach((r) => { if (r.lack) lack_distribution[r.lack] = parseInt(r.cnt, 10); });

  // ── 4. Avoid distribution ──────────────────────────────────────────────────
  const avoidRows = await withDbSlot(() =>
    sequelize.query(
      `SELECT d.data->'structuredPacket'->'diagnostic_packet'->>'avoid' AS avoid, COUNT(*) AS cnt
       ${baseQuery}
       GROUP BY avoid ORDER BY cnt DESC`,
      { type: QueryTypes.SELECT, bind }
    )
  );
  const avoid_distribution = {};
  avoidRows.forEach((r) => { if (r.avoid) avoid_distribution[r.avoid] = parseInt(r.cnt, 10); });

  // ── 5. Vortex signatures (EO+Lack+Avoid) ──────────────────────────────────
  const vortexRows = await withDbSlot(() =>
    sequelize.query(
      `SELECT
         CONCAT(
           d.data->'structuredPacket'->'diagnostic_packet'->>'EO', '+',
           d.data->'structuredPacket'->'diagnostic_packet'->>'lack', '+',
           d.data->'structuredPacket'->'diagnostic_packet'->>'avoid'
         ) AS signature,
         COUNT(*) AS cnt
       ${baseQuery}
       GROUP BY signature
       ORDER BY cnt DESC
       LIMIT 10`,
      { type: QueryTypes.SELECT, bind }
    )
  );
  const top_vortex_signatures = vortexRows.map((r) => ({
    signature: r.signature,
    count: parseInt(r.cnt, 10),
    percentage: total > 0 ? `${((parseInt(r.cnt, 10) / parseInt(total, 10)) * 100).toFixed(1)}%` : "0%",
  }));

  // ── 6. Domain distribution ─────────────────────────────────────────────────
  const domainRows = await withDbSlot(() =>
    sequelize.query(
      `SELECT d.data->'structuredPacket'->'diagnostic_packet'->>'domain' AS domain, COUNT(*) AS cnt
       ${baseQuery}
       GROUP BY domain ORDER BY cnt DESC`,
      { type: QueryTypes.SELECT, bind }
    )
  );
  const domain_distribution = {};
  domainRows.forEach((r) => { if (r.domain) domain_distribution[r.domain] = parseInt(r.cnt, 10); });

  // ── 7. Gravity depth distribution ─────────────────────────────────────────
  const gravityRows = await withDbSlot(() =>
    sequelize.query(
      `SELECT (d.data->'structuredPacket'->'diagnostic_packet'->>'gravity_depth')::int AS depth, COUNT(*) AS cnt
       ${baseQuery}
       GROUP BY depth ORDER BY depth`,
      { type: QueryTypes.SELECT, bind }
    )
  );
  const gravity_depth_distribution = {};
  gravityRows.forEach((r) => { if (r.depth != null) gravity_depth_distribution[r.depth] = parseInt(r.cnt, 10); });

  // ── 8. CL estimate average + distribution ─────────────────────────────────
  const [clAvgRow] = await withDbSlot(() =>
    sequelize.query(
      `SELECT AVG((d.data->'structuredPacket'->'diagnostic_packet'->>'CL_estimate')::numeric) AS avg_cl
       ${baseQuery}`,
      { type: QueryTypes.SELECT, bind }
    )
  );
  const cl_estimate_avg = clAvgRow?.avg_cl != null
    ? parseFloat(parseFloat(clAvgRow.avg_cl).toFixed(2))
    : null;

  const clRows = await withDbSlot(() =>
    sequelize.query(
      `SELECT
         CASE
           WHEN (d.data->'structuredPacket'->'diagnostic_packet'->>'CL_estimate')::numeric < 1.5 THEN '1-1.5'
           WHEN (d.data->'structuredPacket'->'diagnostic_packet'->>'CL_estimate')::numeric < 2   THEN '1.5-2'
           WHEN (d.data->'structuredPacket'->'diagnostic_packet'->>'CL_estimate')::numeric < 2.5 THEN '2-2.5'
           WHEN (d.data->'structuredPacket'->'diagnostic_packet'->>'CL_estimate')::numeric < 3   THEN '2.5-3'
           WHEN (d.data->'structuredPacket'->'diagnostic_packet'->>'CL_estimate')::numeric < 4   THEN '3-4'
           ELSE '4-5'
         END AS bucket,
         COUNT(*) AS cnt
       ${baseQuery}
       GROUP BY bucket ORDER BY bucket`,
      { type: QueryTypes.SELECT, bind }
    )
  );
  const cl_estimate_distribution = {};
  clRows.forEach((r) => { if (r.bucket) cl_estimate_distribution[r.bucket] = parseInt(r.cnt, 10); });

  // ── 9. Structure type distribution ────────────────────────────────────────
  const structRows = await withDbSlot(() =>
    sequelize.query(
      `SELECT d.data->'structuredPacket'->'diagnostic_packet'->>'structure_type' AS stype, COUNT(*) AS cnt
       ${baseQuery}
       GROUP BY stype ORDER BY cnt DESC`,
      { type: QueryTypes.SELECT, bind }
    )
  );
  const structure_type_distribution = {};
  structRows.forEach((r) => { if (r.stype) structure_type_distribution[r.stype] = parseInt(r.cnt, 10); });

  // ── 10. Top desired outcomes ───────────────────────────────────────────────
  const outcomeRows = await withDbSlot(() =>
    sequelize.query(
      `SELECT trim(d.data->'structuredPacket'->'diagnostic_packet'->>'desired_outcome') AS outcome, COUNT(*) AS cnt
       ${baseQuery}
       GROUP BY outcome ORDER BY cnt DESC LIMIT 20`,
      { type: QueryTypes.SELECT, bind }
    )
  );
  const top_desired_outcomes = outcomeRows
    .filter((r) => r.outcome)
    .map((r) => ({ text: r.outcome, count: parseInt(r.cnt, 10) }));

  // ── 11. Top orbit patterns ────────────────────────────────────────────────
  const orbitRows = await withDbSlot(() =>
    sequelize.query(
      `SELECT trim(d.data->'structuredPacket'->'diagnostic_packet'->>'orbit_pattern') AS pattern, COUNT(*) AS cnt
       ${baseQuery}
       GROUP BY pattern ORDER BY cnt DESC LIMIT 10`,
      { type: QueryTypes.SELECT, bind }
    )
  );
  const top_orbit_patterns = orbitRows
    .filter((r) => r.pattern)
    .map((r) => ({ text: r.pattern, count: parseInt(r.cnt, 10) }));

  // ── 12. Funnel source distribution ────────────────────────────────────────
  const sourceRows = await withDbSlot(() =>
    sequelize.query(
      `SELECT COALESCE(fa.kajabi_offer_source, 'unknown') AS source, COUNT(*) AS cnt
       ${baseQuery}
       GROUP BY source ORDER BY cnt DESC`,
      { type: QueryTypes.SELECT, bind }
    )
  );
  const funnel_sources = {};
  sourceRows.forEach((r) => { funnel_sources[r.source] = parseInt(r.cnt, 10); });

  // ── 13. Recovery speed distribution ──────────────────────────────────────
  const recoveryRows = await withDbSlot(() =>
    sequelize.query(
      `SELECT d.data->'structuredPacket'->'constraint_packet'->>'recovery_speed' AS speed, COUNT(*) AS cnt
       ${baseQuery}
       GROUP BY speed ORDER BY cnt DESC`,
      { type: QueryTypes.SELECT, bind }
    )
  );
  const recovery_speed_distribution = {};
  recoveryRows.forEach((r) => { if (r.speed) recovery_speed_distribution[r.speed] = parseInt(r.cnt, 10); });

  // ── 14. Contradiction rate distribution ──────────────────────────────────
  const contrRows = await withDbSlot(() =>
    sequelize.query(
      `SELECT d.data->'structuredPacket'->'constraint_packet'->>'contradiction_rate' AS rate, COUNT(*) AS cnt
       ${baseQuery}
       GROUP BY rate ORDER BY cnt DESC`,
      { type: QueryTypes.SELECT, bind }
    )
  );
  const contradiction_rate_distribution = {};
  contrRows.forEach((r) => { if (r.rate) contradiction_rate_distribution[r.rate] = parseInt(r.cnt, 10); });

  return {
    total_diagnostics: parseInt(total, 10),
    date_range: { from: date_from || null, to: date_to || null },
    eo_distribution,
    lack_distribution,
    avoid_distribution,
    top_vortex_signatures,
    domain_distribution,
    gravity_depth_distribution,
    cl_estimate_avg,
    cl_estimate_distribution,
    structure_type_distribution,
    top_desired_outcomes,
    top_orbit_patterns,
    funnel_sources,
    recovery_speed_distribution,
    contradiction_rate_distribution,
  };
};

/**
 * Build a flat array of per-diagnostic rows for CSV export.
 * Emails are anonymised as SHA-256 hashes.
 *
 * @param {object} [opts] - Same filters as getMarketResearchData
 * @returns {Promise<Array<object>>}
 */
const getMarketResearchRows = async ({
  date_from,
  date_to,
  funnel_source,
  report_type,
} = {}) => {
  const { whereClauses, bind } = buildFilters({ date_from, date_to, funnel_source, report_type });
  const whereStr = buildWhereStr(whereClauses);

  const rows = await withDbSlot(() =>
    sequelize.query(
      `SELECT
         d."createdAt"                                                                       AS date,
         encode(digest(COALESCE(d.email, ''), 'sha256'), 'hex')                             AS email_hash,
         d.data->'structuredPacket'->'diagnostic_packet'->>'EO'                             AS eo,
         d.data->'structuredPacket'->'diagnostic_packet'->>'lack'                           AS lack,
         d.data->'structuredPacket'->'diagnostic_packet'->>'avoid'                          AS avoid,
         CONCAT(
           d.data->'structuredPacket'->'diagnostic_packet'->>'EO', '+',
           d.data->'structuredPacket'->'diagnostic_packet'->>'lack', '+',
           d.data->'structuredPacket'->'diagnostic_packet'->>'avoid'
         )                                                                                   AS vortex_signature,
         d.data->'structuredPacket'->'diagnostic_packet'->>'domain'                         AS domain,
         d.data->'structuredPacket'->'diagnostic_packet'->>'desired_outcome'                AS desired_outcome,
         d.data->'structuredPacket'->'diagnostic_packet'->>'current_loop'                   AS current_loop,
         d.data->'structuredPacket'->'diagnostic_packet'->>'orbit_pattern'                  AS orbit_pattern,
         d.data->'structuredPacket'->'diagnostic_packet'->>'structure_type'                 AS structure_type,
         d.data->'structuredPacket'->'diagnostic_packet'->>'gravity_depth'                  AS gravity_depth,
         d.data->'structuredPacket'->'diagnostic_packet'->>'CL_estimate'                    AS cl_estimate,
         d.data->'structuredPacket'->'diagnostic_packet'->>'protector_type'                 AS protector_type,
         d.data->'structuredPacket'->'constraint_packet'->>'contradiction_rate'             AS contradiction_rate,
         d.data->'structuredPacket'->'constraint_packet'->>'recovery_speed'                 AS recovery_speed,
         COALESCE(fa.kajabi_offer_source, 'unknown')                                        AS funnel_source
       FROM diagnostics d
       LEFT JOIN funnel_access fa ON fa.id = d.funnel_access_id::uuid
       ${whereStr}
       ORDER BY d."createdAt" DESC`,
      { type: QueryTypes.SELECT, bind }
    )
  );

  return rows;
};

module.exports = { getMarketResearchData, getMarketResearchRows };
