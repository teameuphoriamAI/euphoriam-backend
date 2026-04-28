const { QueryTypes } = require("sequelize");
const { sequelize, withDbSlot } = require("../config/sequelize");

/**
 * Admin cohort:
 * - `uc` — joined `users` row with `membership.isCreatorClub` (Kajabi / Creator Club), see userController.
 * - `non_member` — funnel rows: `diagnostics.funnel_access_id` is set (offer link / IRL).
 * - `both` — no cohort filter.
 * Without `user_audience`, default slice is funnel IRL only (`invisible_red_line` + `structuredPacket`).
 *
 * @returns {"uc" | "non_member" | "both" | null}
 */
const normalizeUserAudience = (user_audience) => {
  const norm = (v) => (v == null || v === "" ? null : String(v).toLowerCase().trim());
  const ua = norm(user_audience);
  if (!ua) return null;
  if (["uc", "uc_member", "member", "unlimited_creator", "diagnostic", "app"].includes(ua)) return "uc";
  if (["non_member", "non-member", "funnel", "redline"].includes(ua)) return "non_member";
  if (["both", "all", "any"].includes(ua)) return "both";
  return null;
};

/**
 * Build the WHERE clause parts and bind parameters for the shared filter set.
 *
 * @param {object} opts
 * @param {string} [opts.date_from]    ISO date string
 * @param {string} [opts.date_to]      ISO date string
 * @param {string} [opts.funnel_source] kajabi_offer_source value
 * @param {string} [opts.user_audience]  "uc" (Creator Club) | "non_member" (funnel) | "both"
 * @returns {{ whereClauses: string[], bind: object, user_audience: "uc" | "non_member" | "both" | "default" | "invalid" }}
 */
const buildFilters = ({ date_from, date_to, funnel_source, user_audience } = {}) => {
  const whereClauses = [];
  const bind = {};

  const cohort = normalizeUserAudience(user_audience);

  if (cohort === "uc") {
    whereClauses.push(`u."id" IS NOT NULL`);
    whereClauses.push(`u.membership @> '{"isCreatorClub": true}'::jsonb`);
  } else if (cohort === "non_member") {
    whereClauses.push(`d.funnel_access_id IS NOT NULL`);
  } else if (cohort === "both") {
    // no cohort predicate
  } else {
    whereClauses.push(`d.report_type = 'invisible_red_line'`);
  }

  // Require structuredPacket only for funnel IRL–style slices (default or non_member); not for uc/both.
  const funnelIrlOnly = cohort === "non_member" || cohort == null;
  if (funnelIrlOnly) {
    whereClauses.push(`d.data ? 'structuredPacket'`);
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

  const rawAudience =
    user_audience == null || user_audience === ""
      ? ""
      : String(user_audience).trim();
  /** Reflects SQL branch: default slice is funnel IRL (`invisible_red_line` + structuredPacket), not the explicit `non_member` cohort predicate. */
  const userAudienceLabel = cohort
    ? cohort
    : !rawAudience
      ? "default"
      : "invalid";

  /** Only Creator Club filtering needs `users`; joining u on every query can hit PG max_locks (OR join + many aggregations). */
  const includeUserJoin = cohort === "uc";

  return {
    whereClauses,
    bind,
    user_audience: userAudienceLabel,
    includeUserJoin,
  };
};

const buildWhereStr = (clauses) =>
  clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";

const USER_JOIN_SQL = `
    LEFT JOIN users u ON (
      d."userId" IS NOT NULL AND u."id" = d."userId"
      OR (
        d."userId" IS NULL
        AND d.email IS NOT NULL
        AND BTRIM(d.email) <> ''
        AND LOWER(BTRIM(u.email)) = LOWER(BTRIM(d.email))
      )
    )`;

const buildBaseFrom = (includeUserJoin, whereStr) => `
    FROM diagnostics d
    LEFT JOIN funnel_access fa ON fa.id = d.funnel_access_id::uuid
    ${includeUserJoin ? USER_JOIN_SQL : ""}
    ${whereStr}
`;

// App diagnostics (UC) store vortex/CL in `data.metrics` (see metricsCalculator). Funnel IRL uses `structuredPacket` from extractStructuredPacket.
const M = `d.data->'metrics'`;
const DP = `d.data->'structuredPacket'->'diagnostic_packet'`;
const CP = `d.data->'structuredPacket'->'constraint_packet'`;
/** metrics.vortexSignature (e.g. "NE+C+F") when eo/lack/avoid not stored separately */
const VSIG = `NULLIF(BTRIM(${M}->>'vortexSignature'), '')`;
const EO_FROM_VS = `NULLIF(BTRIM(split_part((${VSIG})::text, '+', 1)), '')`;
const LACK_FROM_VS = `NULLIF(BTRIM(split_part((${VSIG})::text, '+', 2)), '')`;
const AVOID_FROM_VS = `NULLIF(BTRIM(split_part((${VSIG})::text, '+', 3)), '')`;

const EO_EXPR = `NULLIF(
  BTRIM(COALESCE(
    NULLIF((${DP}->>'EO'), ''),
    NULLIF((${M}->>'eo'), ''),
    NULLIF((${M}->>'EO'), ''),
    NULLIF((${M}->>'emotionalOrigin'), ''),
    (${EO_FROM_VS})
  )),
  ''
)`;
const LACK_EXPR = `NULLIF(
  BTRIM(COALESCE(
    NULLIF(COALESCE(${DP}->>'lack_channel', ${DP}->>'lack'), ''),
    NULLIF((${M}->>'lack'), ''),
    NULLIF((${M}->>'lackChannel'), ''),
    (${LACK_FROM_VS})
  )),
  ''
)`;
const AVOID_DERIVED = `COALESCE(
  NULLIF((${DP}->>'avoid'), ''),
  NULLIF((${CP}->>'avoid'), ''),
  NULLIF(split_part(replace(COALESCE((${DP}->>'signature_primary_id'), (${DP}->>'signature_id'), ''), '_', '+'), '+', 3), ''),
  NULLIF(split_part(replace(COALESCE((${DP}->>'signature_secondary_id'), ''), '_', '+'), '+', 3), '')
)`;
const AVOID_EXPR = `NULLIF(
  BTRIM(COALESCE(
    NULLIF((${AVOID_DERIVED}), ''),
    NULLIF((${M}->>'avoid'), ''),
    NULLIF((${M}->>'avoidanceProtector'), ''),
    (${AVOID_FROM_VS})
  )),
  ''
)`;

/** Prefer explicit EO+Lack+Avoid; else use combined `metrics.vortexSignature` (same as top_vortex query). */
const VORTEX_DISPLAY = `NULLIF(
  BTRIM(COALESCE(
    CASE
      WHEN ${EO_EXPR} IS NOT NULL AND ${LACK_EXPR} IS NOT NULL AND ${AVOID_EXPR} IS NOT NULL
      THEN CONCAT_WS('+', ${EO_EXPR}, ${LACK_EXPR}, ${AVOID_EXPR})
      ELSE NULL
    END,
    (${VSIG})
  )),
  ''
)`;

const CL_VAL = `COALESCE(
  NULLIF((${DP}->>'CL_estimate'), '')::numeric,
  NULLIF((${M}->>'consciousnessLevel'), '')::numeric
)`;
// Raw depth, JSON number edge cases, or infer 1–3 from gravity % (metrics.gravity) when depth never persisted
const GDEPTH_VAL = `(
  COALESCE(
    NULLIF((${DP}->>'gravity_depth'), '')::int,
    NULLIF((${M}->>'gravityDepth'), '')::int,
    NULLIF((${M}->>'gravity_depth'), '')::int,
    CASE
      WHEN d.data->'metrics'->'gravityDepth' IS NOT NULL
        AND jsonb_typeof(d.data->'metrics'->'gravityDepth') = 'number'
      THEN (d.data->'metrics'->'gravityDepth')::text::int
      ELSE NULL
    END,
    CASE
      WHEN NULLIF((${M}->>'gravity'), '') IS NOT NULL
        AND (NULLIF((${M}->>'gravity'), ''))::numeric IS NOT NULL
      THEN
        CASE
          WHEN (NULLIF((${M}->>'gravity'), ''))::numeric < 40 THEN 1
          WHEN (NULLIF((${M}->>'gravity'), ''))::numeric < 70 THEN 2
          ELSE 3
        END
      ELSE NULL
    END
  )
)`;
const FUNNEL_SOURCE_LABEL = `COALESCE(
  NULLIF(fa.kajabi_offer_source, ''),
  CASE WHEN d.funnel_access_id IS NULL THEN 'app_diagnostic' ELSE 'unknown' END
)`;
const VSD = `${M}->'vortexSignatureDetails'`;
/** First segment of signatureId (NE_C_F or NE+C+F) → primary egoic “domain” for charts when life-domain is absent */
const SIG_EO_CODE = `NULLIF(UPPER(BTRIM(split_part(replace(COALESCE(NULLIF((${M}->>'signatureId'), ''), ''), '+', '_'), '_', 1))), '')`;
const DOMAIN_FROM_SIG = `(
  CASE ${SIG_EO_CODE}
    WHEN 'NE' THEN 'Egoic theme: not enough (NE)'
    WHEN 'NC' THEN 'Egoic theme: not capable (NC)'
    WHEN 'NS' THEN 'Egoic theme: not safe (NS)'
    WHEN 'PL' THEN 'Egoic theme: powerless (PL)'
    WHEN 'CD' THEN 'Egoic theme: cannot depend (CD)'
    WHEN 'NON' THEN 'Egoic theme: needs not OK (NON)'
    WHEN 'NOV' THEN 'Egoic theme: vulnerability not OK (NOV)'
    WHEN 'NOH' THEN 'Egoic theme: comfort/happiness not OK (NOH)'
    WHEN 'RE' THEN 'Egoic theme: uncoded (RE)'
    ELSE NULL
  END
)`;
const DOMAIN_EXPR = `NULLIF(BTRIM(COALESCE(
  NULLIF((${DP}->>'domain_primary'), ''),
  NULLIF((${DP}->>'domain'), ''),
  NULLIF((${M}->>'domain'), ''),
  NULLIF((${VSD}->'eo'->>'name'), ''),
  NULLIF((${VSD}->>'name'), ''),
  (${DOMAIN_FROM_SIG})
)), '')`;
// App rows often lack IRL desired_outcome + full vortexSignatureDetails; pull from successCard / integration angle / signature id.
const OUTCOME_EXPR = `NULLIF(BTRIM(COALESCE(
  NULLIF((${DP}->>'desired_outcome'), ''),
  NULLIF((${M}->>'desiredOutcome'), ''),
  NULLIF((${M}#>>'{successCard,fulfilledNeed}'), ''),
  NULLIF((${M}#>>'{successCard,iam}'), ''),
  NULLIF((${M}#>>'{successCard,receivedLanguage}'), ''),
  NULLIF((${M}#>>'{successCard,courageVector}'), ''),
  NULLIF((${M}->>'integrationAngle'), ''),
  NULLIF((${VSD}->>'failurePattern'), ''),
  NULLIF((${VSD}->>'orbitStructure'), ''),
  NULLIF((${VSD}->>'oppositeBehavior'), ''),
  NULLIF((d.data#>>'{metrics,vortexSignatureDetails,failurePattern}'), ''),
  NULLIF((d.data#>>'{metrics,vortexSignatureDetails,orbitStructure}'), ''),
  (CASE
    WHEN NULLIF((${M}->>'signatureId'), '') IS NOT NULL
    THEN CONCAT('Pull (vortex id): ', (${M}->>'signatureId'))
    ELSE NULL
  END)
)), '')`;
/** Compact vortex id (e.g. NE+C+F) or IRL structure_type */
const STRUCT_TYPE_EXPR = `NULLIF(BTRIM(COALESCE(
  NULLIF((${DP}->>'structure_type'), ''),
  NULLIF((${M}->>'structureType'), ''),
  NULLIF((${M}->>'signatureId'), '')
)), '')`;
// When IRL keys missing: use signalCoherence as recovery-load proxy, gravity↔coherence gap as “tension” proxy
const RECOVERY_EXPR = `NULLIF(BTRIM(COALESCE(
  NULLIF((${DP}->>'recovery_speed'), ''),
  NULLIF((${CP}->>'recovery_speed'), ''),
  NULLIF((${M}->>'recoverySpeed'), ''),
  NULLIF((${M}->>'recovery_speed'), ''),
  NULLIF((${M}->>'signalZone'), ''),
  NULLIF((${M}#>>'{componentScores,recoveryAlignment}'), ''),
  (CASE
    WHEN NULLIF((${M}->>'signalCoherence'), '') IS NOT NULL
      AND (NULLIF((${M}->>'signalCoherence'), ''))::numeric IS NOT NULL
    THEN
      CASE
        WHEN (NULLIF((${M}->>'signalCoherence'), ''))::numeric < 40 THEN
          'recovery_proxy: low_signal_coherence (higher load)'
        WHEN (NULLIF((${M}->>'signalCoherence'), ''))::numeric < 70 THEN
          'recovery_proxy: mid_signal_coherence'
        ELSE 'recovery_proxy: high_signal_coherence (lighter load)'
      END
    ELSE NULL
  END)
)), '')`;
const CONTRADICTION_EXPR = `NULLIF(BTRIM(COALESCE(
  NULLIF((${DP}->>'contradiction_rate'), ''),
  NULLIF((${CP}->>'contradiction_rate'), ''),
  NULLIF((${M}->>'contradictionRate'), ''),
  NULLIF((${M}->>'contradiction_rate'), ''),
  NULLIF((${M}#>>'{componentScores,contradictionPenalty}'), ''),
  (CASE
    WHEN NULLIF((${M}->>'gravity'), '') IS NOT NULL
      AND NULLIF((${M}->>'signalCoherence'), '') IS NOT NULL
      AND (NULLIF((${M}->>'gravity'), ''))::numeric IS NOT NULL
      AND (NULLIF((${M}->>'signalCoherence'), ''))::numeric IS NOT NULL
    THEN
      CASE
        WHEN (NULLIF((${M}->>'gravity'), ''))::numeric - (NULLIF((${M}->>'signalCoherence'), ''))::numeric > 25 THEN
          'tension_proxy: gravity_pull >> coherence (high inner split)'
        WHEN (NULLIF((${M}->>'signalCoherence'), ''))::numeric - (NULLIF((${M}->>'gravity'), ''))::numeric > 20 THEN
          'tension_proxy: coherence > gravity (unusual pattern)'
        ELSE 'tension_proxy: relatively balanced'
      END
    ELSE NULL
  END)
)), '')`;
const ORBIT_EXPR = `NULLIF(BTRIM(COALESCE(
  NULLIF((${DP}->>'orbit_pattern'), ''),
  NULLIF((${M}->>'orbitPattern'), '')
)), '')`;

/**
 * Aggregate market research data from completed funnel diagnostics.
 *
 * Reads vortex/CL/depth from `diagnostic.data.structuredPacket` (funnel IRL) and/or
 * `diagnostic.data.metrics` (app diagnostics; see metricsCalculator).
 *
 * @param {object} [opts]
 * @param {string} [opts.date_from]
 * @param {string} [opts.date_to]
 * @param {string} [opts.funnel_source]
 * @param {string} [opts.user_audience]  "uc" | "non_member" | "both" (UC app diagnostics vs funnel IRL vs both)
 * @returns {Promise<object>} Aggregated market research data object
 */
const getMarketResearchData = async ({
  date_from,
  date_to,
  funnel_source,
  user_audience,
} = {}) => {
  const { whereClauses, bind, user_audience: audienceLabel, includeUserJoin } = buildFilters({
    date_from,
    date_to,
    funnel_source,
    user_audience,
  });
  const whereStr = buildWhereStr(whereClauses);
  const baseQuery = buildBaseFrom(includeUserJoin, whereStr);

  // ── 1. Total count ──────────────────────────────────────────────────────────
  const [{ total }] = await withDbSlot(() =>
    sequelize.query(`SELECT COUNT(*) AS total ${baseQuery}`, {
      type: QueryTypes.SELECT, bind,
    })
  );

  // ── 2. EO distribution ─────────────────────────────────────────────────────
  const eoRows = await withDbSlot(() =>
    sequelize.query(
      `SELECT ${EO_EXPR} AS eo, COUNT(*) AS cnt
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
      `SELECT ${LACK_EXPR} AS lack, COUNT(*) AS cnt
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
      `SELECT ${AVOID_EXPR} AS avoid, COUNT(*) AS cnt
       ${baseQuery}
       GROUP BY avoid ORDER BY cnt DESC`,
      { type: QueryTypes.SELECT, bind }
    )
  );
  const avoid_distribution = {};
  avoidRows.forEach((r) => { if (r.avoid) avoid_distribution[r.avoid] = parseInt(r.cnt, 10); });

  // ── 5. Vortex signatures (EO+Lack+Avoid or combined metrics.vortexSignature) ─
  const vortexRows = await withDbSlot(() =>
    sequelize.query(
      `SELECT ${VORTEX_DISPLAY} AS signature, COUNT(*) AS cnt
       ${baseQuery}
       GROUP BY signature
       ORDER BY cnt DESC
       LIMIT 10`,
      { type: QueryTypes.SELECT, bind }
    )
  );
  const top_vortex_signatures = vortexRows
    .filter((r) => r.signature && r.signature.trim())
    .map((r) => ({
      signature: r.signature,
      count: parseInt(r.cnt, 10),
      percentage: total > 0 ? `${((parseInt(r.cnt, 10) / parseInt(total, 10)) * 100).toFixed(1)}%` : "0%",
    }));

  // ── 6. Domain distribution ─────────────────────────────────────────────────
  const domainRows = await withDbSlot(() =>
    sequelize.query(
      `SELECT ${DOMAIN_EXPR} AS domain, COUNT(*) AS cnt
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
      `SELECT (${GDEPTH_VAL}) AS depth, COUNT(*) AS cnt
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
      `SELECT AVG(${CL_VAL}) AS avg_cl
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
           WHEN ${CL_VAL} IS NULL THEN NULL
           WHEN ${CL_VAL} < 1.5 THEN '1-1.5'
           WHEN ${CL_VAL} < 2   THEN '1.5-2'
           WHEN ${CL_VAL} < 2.5 THEN '2-2.5'
           WHEN ${CL_VAL} < 3   THEN '2.5-3'
           WHEN ${CL_VAL} < 4   THEN '3-4'
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
      `SELECT ${STRUCT_TYPE_EXPR} AS stype, COUNT(*) AS cnt
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
      `SELECT ${OUTCOME_EXPR} AS outcome, COUNT(*) AS cnt
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
      `SELECT ${ORBIT_EXPR} AS pattern, COUNT(*) AS cnt
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
      `SELECT ${FUNNEL_SOURCE_LABEL} AS source, COUNT(*) AS cnt
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
      `SELECT ${RECOVERY_EXPR} AS speed, COUNT(*) AS cnt
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
      `SELECT ${CONTRADICTION_EXPR} AS rate, COUNT(*) AS cnt
       ${baseQuery}
       GROUP BY rate ORDER BY cnt DESC`,
      { type: QueryTypes.SELECT, bind }
    )
  );
  const contradiction_rate_distribution = {};
  contrRows.forEach((r) => { if (r.rate) contradiction_rate_distribution[r.rate] = parseInt(r.cnt, 10); });

  const [coverageRow] = await withDbSlot(() =>
    sequelize.query(
      `SELECT
         COUNT(*)::int AS total_rows,
         COUNT(*) FILTER (WHERE ${EO_EXPR} IS NOT NULL)::int AS with_eo,
         COUNT(*) FILTER (WHERE ${LACK_EXPR} IS NOT NULL)::int AS with_lack,
         COUNT(*) FILTER (WHERE ${AVOID_EXPR} IS NOT NULL)::int AS with_avoid,
         COUNT(*) FILTER (WHERE (${VSIG}) IS NOT NULL)::int AS with_vortex_signature_field,
         COUNT(*) FILTER (WHERE ${VORTEX_DISPLAY} IS NOT NULL)::int AS with_resolved_vortex,
         COUNT(*) FILTER (WHERE ${CL_VAL} IS NOT NULL)::int AS with_cl,
         COUNT(*) FILTER (WHERE ${GDEPTH_VAL} IS NOT NULL)::int AS with_gravity_depth,
         COUNT(*) FILTER (WHERE ${DOMAIN_EXPR} IS NOT NULL)::int AS with_domain,
         COUNT(*) FILTER (WHERE ${OUTCOME_EXPR} IS NOT NULL)::int AS with_desired_outcome,
         COUNT(*) FILTER (WHERE ${ORBIT_EXPR} IS NOT NULL)::int AS with_orbit_pattern,
         COUNT(*) FILTER (WHERE ${STRUCT_TYPE_EXPR} IS NOT NULL)::int AS with_structure_type,
         COUNT(*) FILTER (WHERE ${RECOVERY_EXPR} IS NOT NULL)::int AS with_recovery_speed,
         COUNT(*) FILTER (WHERE ${CONTRADICTION_EXPR} IS NOT NULL)::int AS with_contradiction_rate,
         COUNT(*) FILTER (WHERE d.data ? 'structuredPacket')::int AS with_structured_packet,
         COUNT(*) FILTER (WHERE d.data ? 'metrics')::int AS with_metrics_object
       ${baseQuery}`,
      { type: QueryTypes.SELECT, bind }
    )
  );

  return {
    total_diagnostics: parseInt(total, 10),
    user_audience: audienceLabel,
    field_coverage: coverageRow || {},
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
 * Includes real user email for admin export use.
 *
 * @param {object} [opts] - Same filters as getMarketResearchData
 * @returns {Promise<Array<object>>}
 */
const getMarketResearchRows = async ({
  date_from,
  date_to,
  funnel_source,
  user_audience,
} = {}) => {
  const { whereClauses, bind, includeUserJoin } = buildFilters({
    date_from,
    date_to,
    funnel_source,
    user_audience,
  });
  const whereStr = buildWhereStr(whereClauses);
  const fromAndWhere = buildBaseFrom(includeUserJoin, whereStr);

  const rows = await withDbSlot(() =>
    sequelize.query(
      `SELECT
         d."createdAt"                                                                       AS date,
         COALESCE(d.email, '')                                                               AS email,
         ${EO_EXPR}                                                                          AS eo,
         ${LACK_EXPR}                                                                        AS lack,
         ${AVOID_EXPR}                                                                       AS avoid,
         ${VORTEX_DISPLAY}                                                                     AS vortex_signature,
         ${DOMAIN_EXPR}                                                                      AS domain,
         ${OUTCOME_EXPR}                                                                     AS desired_outcome,
         ${DP}->>'current_loop'                                                              AS current_loop,
         ${ORBIT_EXPR}                                                                       AS orbit_pattern,
         ${STRUCT_TYPE_EXPR}                                                                AS structure_type,
         (${GDEPTH_VAL})::text                                                                AS gravity_depth,
         (${CL_VAL})::text                                                                    AS cl_estimate,
         ${DP}->>'protector_type'                                                            AS protector_type,
         ${CONTRADICTION_EXPR}                                                                 AS contradiction_rate,
         ${RECOVERY_EXPR}                                                                      AS recovery_speed,
         (${FUNNEL_SOURCE_LABEL})                                                           AS funnel_source
       ${fromAndWhere}
       ORDER BY d."createdAt" DESC`,
      { type: QueryTypes.SELECT, bind }
    )
  );

  return rows;
};

module.exports = { getMarketResearchData, getMarketResearchRows };
