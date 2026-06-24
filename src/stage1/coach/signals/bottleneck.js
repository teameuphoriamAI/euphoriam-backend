/**
 * Real bottleneck classification — not every stall is resistance.
 */

const BOTTLENECK_TYPES = Object.freeze({
  RESISTANCE: "resistance_gap",
  KNOWLEDGE: "knowledge_gap",
  STRATEGY: "strategy_gap",
  SKILL: "skill_gap",
  RESOURCE: "resource_gap",
  UNCLEAR: "unclear",
});

const STRATEGY_GAP_PATTERN =
  /\b(don'?t\s+(?:have|know)\s+(?:a\s+)?(?:client\s+acquisition|marketing|sales)\s+strategy|no\s+(?:client\s+acquisition|marketing)\s+strategy|don'?t\s+know\s+(?:what\s+works|where\s+to\s+find\s+clients?|how\s+to\s+get\s+clients?)|what\s+to\s+do\s+to\s+get\s+(?:clients?|customers?)|don'?t\s+know\s+(?:how|where|when|what)\s+(?:to|and)|(?:how|where|when|what)\s+.{0,30}\s+and\s+(?:how|where|when|what))\b/i;

const KNOWLEDGE_GAP_PATTERN =
  /\b(don'?t\s+know\s+how|no\s+idea\s+how|not\s+sure\s+how|how\s+do\s+i\s+(?:get|find|start|sell)|don'?t\s+know\s+what\s+to\s+(?:sell|offer|charge|price)|what\s+(?:should\s+i|do\s+i)\s+(?:charge|price|sell))\b/i;

const RESOURCE_GAP_PATTERN =
  /\b(no\s+portfolio|don'?t\s+have\s+(?:a\s+)?(?:portfolio|website|samples?|assets?|list|leads?)|missing\s+(?:tools?|portfolio|website)|need\s+(?:a\s+)?portfolio|no\s+(?:work\s+)?samples?)\b/i;

const SKILL_GAP_PATTERN =
  /\b(can'?t\s+(?:code|sell|pitch|close|build)|not\s+good\s+enough\s+at|don'?t\s+know\s+how\s+to\s+(?:code|build|design|pitch))\b/i;

const RESISTANCE_GAP_PATTERN =
  /\b(avoid|lazy|scared|afraid|procrastinat|invisible|reject|fear|anxious|didn'?t\s+reach|feeling\s+lazy|shutdown|paralyz|overthink(?:ing)?\s+(?:instead\s+of\s+doing)?)\b/i;

const classifyBottleneck = (text, { priorBottleneck = null } = {}) => {
  const t = String(text || "").trim();
  if (!t || t.length < 6) {
    return priorBottleneck || { type: BOTTLENECK_TYPES.UNCLEAR, confidence: "low" };
  }

  const scores = {
    [BOTTLENECK_TYPES.STRATEGY]: 0,
    [BOTTLENECK_TYPES.KNOWLEDGE]: 0,
    [BOTTLENECK_TYPES.RESOURCE]: 0,
    [BOTTLENECK_TYPES.SKILL]: 0,
    [BOTTLENECK_TYPES.RESISTANCE]: 0,
  };

  if (STRATEGY_GAP_PATTERN.test(t)) scores[BOTTLENECK_TYPES.STRATEGY] += 3;
  if (KNOWLEDGE_GAP_PATTERN.test(t)) scores[BOTTLENECK_TYPES.KNOWLEDGE] += 2;
  if (RESOURCE_GAP_PATTERN.test(t)) scores[BOTTLENECK_TYPES.RESOURCE] += 3;
  if (SKILL_GAP_PATTERN.test(t)) scores[BOTTLENECK_TYPES.SKILL] += 2;
  if (RESISTANCE_GAP_PATTERN.test(t)) scores[BOTTLENECK_TYPES.RESISTANCE] += 1;

  if (/\b(how|where|when|what)\b.*\b(how|where|when|what)\b/i.test(t)) {
    scores[BOTTLENECK_TYPES.STRATEGY] += 2;
  }
  if (t.length > 40 && /\bdon'?t\s+know\b/i.test(t) && !RESISTANCE_GAP_PATTERN.test(t)) {
    scores[BOTTLENECK_TYPES.STRATEGY] += 1;
    scores[BOTTLENECK_TYPES.KNOWLEDGE] += 1;
  }

  const ranked = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  const [topType, topScore] = ranked[0];

  if (topScore === 0) {
    if (priorBottleneck?.type && priorBottleneck.type !== BOTTLENECK_TYPES.UNCLEAR) {
      return { ...priorBottleneck, confidence: "carried" };
    }
    if (RESISTANCE_GAP_PATTERN.test(t)) {
      return { type: BOTTLENECK_TYPES.RESISTANCE, confidence: "medium", evidence: t.slice(0, 200) };
    }
    return { type: BOTTLENECK_TYPES.UNCLEAR, confidence: "low" };
  }

  if (
    topType !== BOTTLENECK_TYPES.RESISTANCE &&
    scores[BOTTLENECK_TYPES.RESISTANCE] > 0 &&
    topScore >= 2
  ) {
    return {
      type: topType,
      confidence: topScore >= 3 ? "high" : "medium",
      evidence: t.slice(0, 200),
      not_primary: BOTTLENECK_TYPES.RESISTANCE,
    };
  }

  return {
    type: topType,
    confidence: topScore >= 3 ? "high" : "medium",
    evidence: t.slice(0, 200),
  };
};

const classifyBottleneckFromTranscript = (messages = [], currentMessage = "") => {
  const userTexts = [
    ...(messages || []).filter((m) => m?.role === "user").map((m) => String(m.content || "")),
    String(currentMessage || ""),
  ].filter((t) => t.trim());

  let result = { type: BOTTLENECK_TYPES.UNCLEAR, confidence: "low" };
  for (const t of userTexts.slice(-4)) {
    result = classifyBottleneck(t, { priorBottleneck: result });
  }
  return result;
};

const isNonResistanceBottleneck = (bottleneck) =>
  bottleneck?.type &&
  bottleneck.type !== BOTTLENECK_TYPES.RESISTANCE &&
  bottleneck.type !== BOTTLENECK_TYPES.UNCLEAR;

const bottleneckLabel = (type) => {
  const labels = {
    [BOTTLENECK_TYPES.RESISTANCE]: "resistance (fear, avoidance, procrastination)",
    [BOTTLENECK_TYPES.KNOWLEDGE]: "knowledge (doesn't know how)",
    [BOTTLENECK_TYPES.STRATEGY]: "strategy (doesn't know what works)",
    [BOTTLENECK_TYPES.SKILL]: "skill (can't perform yet)",
    [BOTTLENECK_TYPES.RESOURCE]: "resource (missing assets/tools)",
    [BOTTLENECK_TYPES.UNCLEAR]: "unclear — needs one more specific answer",
  };
  return labels[type] || type;
};

module.exports = {
  BOTTLENECK_TYPES,
  classifyBottleneck,
  classifyBottleneckFromTranscript,
  isNonResistanceBottleneck,
  bottleneckLabel,
};
