/** Free IRL funnel limits — align with euphoriam-frontend FREE_LIMITS */
const MAX_DIAGNOSTICS = Number(process.env.FUNNEL_MAX_DIAGNOSTICS || 3);
const ACCESS_WINDOW_DAYS = Number(process.env.FUNNEL_ACCESS_WINDOW_DAYS || 7);
const LINK_VALIDITY_DAYS = Number(process.env.FUNNEL_LINK_VALIDITY_DAYS || 10);

module.exports = {
  MAX_DIAGNOSTICS,
  ACCESS_WINDOW_DAYS,
  LINK_VALIDITY_DAYS,
};
