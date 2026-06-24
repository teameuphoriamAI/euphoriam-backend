/**
 * Setback / gap reports — NOT proof. Shared across continuity, progress, first-session coach.
 */

const SETBACK_OR_GAP_PATTERN =
  /\b(didn'?t|did not|no|not|zero)\s+(?:generate|make|earn|get|land|reach|contact)\b|\bno\s+(?:dollar|income|money|clients?|progress)\b|\bnothing\s+(?:landed|special|happened|generated)\b|\bdidn'?t\s+reach\b|\bno\s+one\b|\blazy\b|\bfeeling\s+lazy\b/i;

const POSITIVE_PROOF_PATTERN =
  /\$\d+|\d+\s*(?:\/hr|per hour|an hr)\b|\bearned\b|\bmade\s+\$?\d|\b(identif|found|listed)\w*\s+(?:\d+\s+)?(?:client|prospect|business|lead)/i;

const isSetbackOrGapReport = (text) => {
  const t = String(text || "").trim();
  if (!t || t.length < 4) return false;
  return SETBACK_OR_GAP_PATTERN.test(t);
};

/** True only for wins / completed outward action — not gaps or failures. */
const isPositiveProofReport = (text) => {
  const t = String(text || "").trim();
  if (!t || t.length < 3) return false;
  if (isSetbackOrGapReport(t)) return false;
  if (/\b(didn'?t|did not|without|no)\b/i.test(t) && /\b(generate|earn|make|reach|contact|client)/i.test(t)) {
    return false;
  }
  if (POSITIVE_PROOF_PATTERN.test(t)) return true;
  if (/\bgenerated\s+\$|\bgenerated\s+\d+\s*dollar/i.test(t)) return true;
  if (/\b(reached out|contacted|booked|closed)\b/i.test(t) && !/\bdidn'?t\b/i.test(t)) return true;
  if (/\b(identif|found|listed)\w*\s+(?:\d+\s+)?(?:client|prospect|business|lead)/i.test(t)) return true;
  if (/\b(sent|messaged|dm|emailed)\b/i.test(t) && !/\bdidn'?t\b/i.test(t)) return true;
  if (/\bcompleted\b/i.test(t) && !/\bdidn'?t\b/i.test(t)) return true;
  if (/\bcompeted\b/i.test(t)) return true;
  if (/\bi did it\b/i.test(t) && !isSetbackOrGapReport(t)) return true;
  return false;
};

module.exports = {
  SETBACK_OR_GAP_PATTERN,
  isSetbackOrGapReport,
  isPositiveProofReport,
};
