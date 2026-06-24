/** Green Rep names are short observable behaviors — not outcomes or proof sentences. */
const OUTCOME_REP_PATTERN =
  /\b(generate|get\s+(?:a\s+)?client|earn\s+money|make\s+money|get\s+paid|land\s+a\s+client|first\s+paying\s+client|\$\d+|\/hr|per\s+hour)\b/i;

const isPlausibleGreenRepName = (name) => {
  const n = String(name || "").trim();
  if (!n || n.length < 2 || n.length > 55) return false;
  if (n.split(/\s+/).length > 8) return false;
  if (OUTCOME_REP_PATTERN.test(n)) return false;
  if (/\d+\s*dollar|\$|\/hr|per hour|an hour|an hr\b/i.test(n)) return false;
  if (/\b(generated|earned|successfully|that i|i competed|i completed)\b/i.test(n)) {
    return false;
  }
  return true;
};

const isOutcomeRep = (rep) => {
  const blob = [rep?.name, ...(rep?.steps || []), rep?.win_condition].filter(Boolean).join(" ");
  return OUTCOME_REP_PATTERN.test(blob) && !/\b(send|contact|message|publish|create|write|list|identify)\b/i.test(blob);
};

module.exports = { isPlausibleGreenRepName, isOutcomeRep, OUTCOME_REP_PATTERN };
