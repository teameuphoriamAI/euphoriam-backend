const EO_LABELS = {
  NE: "Not Enough",
  NC: "Not Capable",
  NS: "Not Safe",
  PL: "Powerless",
  CD: "Can't Depend",
  NON: "Needs Not OK",
  NOV: "Vulnerable Not OK",
  NOH: "Happy/Comfort Not OK",
};

const LACK_LABELS = {
  C: "Connection",
  S: "Security",
  P: "Purpose",
};

const AVOID_LABELS = {
  F: "Failure",
  R: "Rejection",
};

const expandSignatureId = (sig) => {
  const plus = sig.match(/^([A-Z]{2,3})\+([CSP])\+([FR])$/i);
  if (plus) {
    const eo = EO_LABELS[plus[1].toUpperCase()] || plus[1];
    const lack = LACK_LABELS[plus[2].toUpperCase()] || plus[2];
    const avoid = AVOID_LABELS[plus[3].toUpperCase()] || plus[3];
    return `${eo} + ${lack} + ${avoid}`;
  }

  const under = sig.match(/^([A-Z]{2,3})_([CSP])_([FR])$/i);
  if (under) {
    const eo = EO_LABELS[under[1].toUpperCase()] || under[1];
    const lack = LACK_LABELS[under[2].toUpperCase()] || under[2];
    const avoid = AVOID_LABELS[under[3].toUpperCase()] || under[3];
    return `${eo} + ${lack} + ${avoid}`;
  }

  return sig;
};

const stripMetricsJsonBlock = (text) => {
  if (!text || typeof text !== "string") return "";
  return text
    .replace(/METRICS_JSON_START[\s\S]*?METRICS_JSON_END/gi, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
};

const expandFrameworkAbbreviations = (text) => {
  if (!text || typeof text !== "string") return "";

  let out = text;

  out = out.replace(/\b([A-Z]{2,3})_([CSP])_([FR])\b/g, (_, eo, lack, avoid) =>
    expandSignatureId(`${eo}_${lack}_${avoid}`),
  );
  out = out.replace(/\b([A-Z]{2,3})\+([CSP])\+([FR])\b/g, (_, eo, lack, avoid) =>
    expandSignatureId(`${eo}+${lack}+${avoid}`),
  );

  const replacements = [
    [/\bEO-Orbit\b/gi, "Emotional Origin orbit pattern"],
    [/\bEO\b/g, "Emotional Origin"],
    [/\bQGC\b/g, "Quantum Genius Codes"],
    [/\bCL\b/g, "Consciousness Level"],
    [/\bNE\b/g, "Not Enough"],
    [/\bNC\b/g, "Not Capable"],
    [/\bNS\b/g, "Not Safe"],
    [/\bPL\b/g, "Powerless"],
    [/\bCD\b/g, "Can't Depend"],
    [/\bNON\b/g, "Needs Not OK"],
    [/\bNOV\b/g, "Vulnerable Not OK"],
    [/\bNOH\b/g, "Happy/Comfort Not OK"],
  ];

  for (const [pattern, full] of replacements) {
    out = out.replace(pattern, full);
  }

  return out;
};

const sanitizeUserFacingReportText = (text) =>
  expandFrameworkAbbreviations(stripMetricsJsonBlock(text));

module.exports = {
  stripMetricsJsonBlock,
  expandFrameworkAbbreviations,
  sanitizeUserFacingReportText,
  expandSignatureId,
};
