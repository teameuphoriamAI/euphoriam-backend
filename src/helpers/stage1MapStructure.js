const { normalizeSuccessStrategy } = require("./stage1SuccessStrategy");
const { enrichProgressMetricsFromMap } = require("./stage1ProgressMetrics");
const {
  EGOIC_ORIENTATIONS,
  LACK_CHANNELS,
  AVOIDANCE_PROTECTORS,
  getSuccessCard,
  getOppositeBehavior,
} = require("../utils/euphoriamMatrix");

const EO_DISPLAY = {
  NE: "Not Enough",
  NC: "Not Capable",
  NS: "Not Safe",
  PL: "Powerless",
  CD: "Can't Depend",
  NON: "Needs Not OK",
  NOV: "Not OK Vulnerable",
  NOH: "Not OK Happy",
};

const LACK_DISPLAY = {
  C: "Connection",
  S: "Security",
  P: "Purpose",
};

const AVOID_DISPLAY = {
  F: "Failure-protector",
  R: "Rejection-protector",
};

function matchVortexCode(value, validCodes) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  const upper = raw.toUpperCase();
  if (validCodes.includes(upper)) return upper;
  for (const code of validCodes) {
    if (upper === code || upper.startsWith(`${code} `) || upper.includes(`+${code}`)) {
      return code;
    }
  }
  return null;
}

/** Parse EO / Lack / Avoid codes from signature_id or partial structure fields. */
function parseVortexCodes(structure) {
  if (!structure || typeof structure !== "object") return null;

  const sig = String(structure.signature_id || "").trim();
  const plusMatch = sig.match(/^([A-Z]{2,3})\+([CSP])\+([FR])$/i);
  const underMatch = sig.match(/^([A-Z]{2,3})_([CSP])_([FR])$/i);
  if (plusMatch) {
    return {
      eo: plusMatch[1].toUpperCase(),
      lack: plusMatch[2].toUpperCase(),
      avoid: plusMatch[3].toUpperCase(),
    };
  }
  if (underMatch) {
    return {
      eo: underMatch[1].toUpperCase(),
      lack: underMatch[2].toUpperCase(),
      avoid: underMatch[3].toUpperCase(),
    };
  }

  const eo = matchVortexCode(structure.EO, Object.keys(EGOIC_ORIENTATIONS));
  const lack = matchVortexCode(structure.lack_channel, Object.keys(LACK_CHANNELS));
  const avoid = matchVortexCode(structure.avoid_type, Object.keys(AVOIDANCE_PROTECTORS));
  if (eo && lack && avoid) {
    return { eo, lack, avoid };
  }
  return null;
}

function expandVortexLabels(structure) {
  const codes = parseVortexCodes(structure);
  if (!codes) return structure;

  const { eo, lack, avoid } = codes;
  const signature_id = `${eo}+${lack}+${avoid}`;

  return {
    ...structure,
    signature_id,
    EO: EO_DISPLAY[eo] || EGOIC_ORIENTATIONS[eo]?.name || structure.EO,
    lack_channel: LACK_DISPLAY[lack] || LACK_CHANNELS[lack]?.name || structure.lack_channel,
    avoid_type:
      AVOID_DISPLAY[avoid] || AVOIDANCE_PROTECTORS[avoid]?.name || structure.avoid_type,
  };
}

function isWeakSuccessStrategy(ss) {
  if (!ss || typeof ss !== "object") return true;
  const behaviour = String(ss.behaviour || ss.behavior || "").trim();
  if (/^UC Module|^https?:\/\//i.test(behaviour)) return true;
  const behaviours = Array.isArray(ss.behaviours) ? ss.behaviours.filter(Boolean) : [];
  const belief = String(ss.belief || "").trim();
  const successRule = String(ss.success_rule || ss.successRule || "").trim();
  if (!behaviour && !belief && !successRule && !behaviours.length) return true;
  if (behaviour.length < 12 && !behaviours.length && !belief) return true;
  return false;
}

function enrichSuccessStrategyFromSignature(structure) {
  const codes = parseVortexCodes(structure);
  if (!codes) return structure;

  const sigId = `${codes.eo}+${codes.lack}+${codes.avoid}`;
  const card = getSuccessCard(sigId);
  const opposites = getOppositeBehavior(codes.eo, codes.lack, codes.avoid);
  const ss =
    structure.success_strategy && typeof structure.success_strategy === "object"
      ? { ...structure.success_strategy }
      : { title: "Success strategy", behaviours: [] };

  if (!isWeakSuccessStrategy(ss)) {
    return structure;
  }

  const eoOps = opposites?.eoOpposites || [];
  const lackOps = opposites?.lackOpposites || [];
  const avoidOps = opposites?.protectorOpposites || [];
  const behaviours = [...new Set([...avoidOps, ...lackOps, ...eoOps].filter(Boolean))].slice(
    0,
    3,
  );

  return {
    ...structure,
    success_strategy: {
      title:
        ss.title && ss.title !== "Success strategy"
          ? ss.title
          : "Structural opposite",
      behaviour:
        avoidOps[0] ||
        lackOps[0] ||
        eoOps[0] ||
        String(ss.behaviour || ss.behavior || "").trim() ||
        "",
      belief: card?.successCard?.iam || ss.belief || undefined,
      success_rule: eoOps[0] || ss.success_rule || ss.successRule || undefined,
      behaviours: behaviours.length ? behaviours : ss.behaviours || [],
    },
  };
}

/** Failure strategy block for home/coach from a domain map row. */
const resolveFailureStrategyForMap = (map) => {
  if (!map || typeof map !== "object") return null;

  const topAvoid = Array.isArray(map.top_3_avoidance_behaviours)
    ? map.top_3_avoidance_behaviours.filter((x) => x != null && String(x).trim())
    : [];

  const fs = map.failure_strategy;
  if (fs && typeof fs === "object") {
    const rule = fs.rule || fs.protector_rule || map.protector_rule;
    let behaviours = Array.isArray(fs.behaviours) ? fs.behaviours.filter(Boolean) : [];
    if (!behaviours.length && topAvoid.length) {
      behaviours = topAvoid.slice(0, 3);
    }
    if (rule?.trim() || behaviours.length) {
      return {
        title: fs.title || "Failure strategy",
        rule: rule ? String(rule).trim() : "",
        behaviours,
      };
    }
  }
  if (typeof fs === "string" && fs.trim()) {
    return { title: "Failure strategy", rule: fs.trim(), behaviours: [] };
  }

  const avoid = Array.isArray(map.top_3_avoidance_behaviours)
    ? map.top_3_avoidance_behaviours.filter((x) => x != null && String(x).trim())
    : [];
  const rule = map.protector_rule?.trim() || null;
  if (rule || avoid.length) {
    return {
      title: "Failure strategy",
      rule: rule || avoid[0] || "",
      behaviours: avoid.slice(0, 3),
    };
  }

  // Maps finalized with loose structure fields only (orbit, lack, avoid type)
  if (map.map_resistance_complete) {
    const orbit = map.orbit_pattern?.trim() || null;
    const lack = map.lack_channel?.trim() || null;
    const avoidType = map.avoid_type?.trim() || null;
    const eo = map.EO?.trim() || null;
    const parts = [orbit, lack, avoidType, eo].filter(Boolean);
    if (parts.length) {
      return {
        title: "Failure strategy",
        rule: parts.join(" · "),
        behaviours: orbit ? [orbit, ...avoid].slice(0, 3) : avoid.slice(0, 3),
      };
    }
  }

  return null;
};

/** Success strategy block when extraction saved only goal/rep fields. */
const resolveSuccessStrategyForMap = (map) => {
  const normalized = normalizeSuccessStrategy(map);
  if (normalized) return normalized;

  if (!map?.map_resistance_complete) return null;

  const rep = map.daily_rep;
  const repName =
    (rep && typeof rep === "object" && rep.name?.trim()) ||
    (typeof rep === "string" && rep.trim()) ||
    map.today_visible_action?.trim() ||
    null;

  const behaviour = map.opposite_behaviour?.trim() || map.opposite_behavior?.trim() || repName;
  const belief = map.opposite_belief?.trim() || map.desired_outcome?.trim() || null;
  const successRule =
    map.success_rule?.trim() ||
    map.proof_of_success?.trim() ||
    map.win_condition?.trim() ||
    (rep && typeof rep === "object" ? rep.win_condition?.trim() : null) ||
    null;

  if (behaviour || belief || successRule) {
    return {
      title: "Success strategy",
      behaviour: behaviour || "",
      belief: belief || undefined,
      success_rule: successRule || undefined,
      behaviours: [],
    };
  }

  return null;
};

/** Fill daily_rep.win_condition from proof_of_success when missing. */
const resolveDailyRepForMap = (map) => {
  const visible = map.today_visible_action?.trim() || null;
  let rep = map.daily_rep;
  if (!rep && visible) {
    rep = { name: visible, steps: [], win_condition: map.proof_of_success || map.win_condition || null };
  }
  if (rep && typeof rep === "object") {
    const win =
      rep.win_condition?.trim() ||
      map.win_condition?.trim() ||
      map.proof_of_success?.trim() ||
      null;
    if (win && !rep.win_condition) {
      rep = { ...rep, win_condition: win };
    }
  }
  return rep;
};

const structureHasVortexSignature = (structure) => {
  if (!structure || typeof structure !== "object") return false;
  const expanded = expandVortexLabels(structure);
  if (String(expanded.signature_id || "").trim()) return true;
  const eo = String(expanded.EO || "").trim();
  const lack = String(expanded.lack_channel || "").trim();
  const avoid = String(expanded.avoid_type || "").trim();
  if (!eo || !lack || !avoid) return false;
  return !(
    matchVortexCode(eo, Object.keys(EGOIC_ORIENTATIONS)) &&
    matchVortexCode(lack, Object.keys(LACK_CHANNELS)) &&
    matchVortexCode(avoid, Object.keys(AVOIDANCE_PROTECTORS))
  );
};

const structureHasExtractedRep = (structure) => {
  const rep = structure?.daily_rep;
  if (rep && typeof rep === "object" && rep.name?.trim()) return true;
  return typeof rep === "string" && Boolean(rep.trim());
};

/** True when finalize produced a complete goal-scoped diagnosis (incl. vortex). */
const structureHasMinimalContent = (structure, options = {}) => {
  if (!structure || typeof structure !== "object") return false;
  const normalized = normalizeExtractedStructure({ ...structure }, options);
  if (!structureHasVortexSignature(normalized)) return false;
  if (!resolveFailureStrategyForMap(normalized)) return false;
  const ss = normalizeSuccessStrategy(normalized);
  if (!ss || isWeakSuccessStrategy(ss)) return false;
  return structureHasExtractedRep(normalized);
};

/** Last-resort extraction — transcript only; never copies goal-form fields. */
const heuristicStructureFromTranscript = (transcript = []) => {
  const userLines = (transcript || [])
    .filter((m) => m && m.role === "user")
    .map((m) => String(m.content || "").trim())
    .filter((c) => c.length >= 12 && !/^[a-z]{0,2}[^a-zA-Z0-9\s]{3,}/i.test(c));

  const avoid = userLines.slice(0, 3).length >= 3
    ? userLines.slice(0, 3)
    : userLines.slice(-3);
  const primaryRule =
    userLines.find((l) => /protect|avoid|rule|tell myself|postpone|delay/i.test(l)) ||
    avoid[0] ||
    null;

  const structure = {
    top_3_avoidance_behaviours: avoid.slice(0, 3),
    protector_rule: primaryRule,
    map_resistance_complete: true,
  };

  if (primaryRule) {
    structure.failure_strategy = {
      title: "Failure strategy",
      rule: primaryRule,
      behaviours: avoid.slice(0, 3),
    };
  }

  structure.progress_metrics = enrichProgressMetricsFromMap(structure, {});
  return structure;
};

/** Prefer non-null extracted fields from newer result over older. */
const mergeExtractedStructures = (base = {}, patch = {}) => {
  const merged = { ...(base && typeof base === "object" ? base : {}) };
  const keys = [
    "signature_id",
    "EO",
    "lack_channel",
    "avoid_type",
    "orbit_pattern",
    "recovery_speed",
    "protector_rule",
    "failure_strategy",
    "top_3_avoidance_behaviours",
    "success_strategy",
    "daily_rep",
    "win_condition",
    "opposite_belief",
    "opposite_behaviour",
    "success_rule",
  ];
  for (const key of keys) {
    const val = patch?.[key];
    if (val == null) continue;
    if (Array.isArray(val) && val.length === 0) continue;
    if (typeof val === "object" && !Array.isArray(val) && Object.keys(val).length === 0) {
      continue;
    }
    merged[key] = val;
  }
  return merged;
};

function isUsableTranscriptAnswer(text) {
  const t = String(text || "").trim();
  if (t.length < 12) return false;
  const letters = t.replace(/[^a-zA-Z]/g, "");
  if (letters.length >= 5 && !/[aeiouAEIOU]/.test(letters)) return false;
  if (/ChromaDB|isLikelyGibberish|timeout of \d+ms/i.test(t)) return false;
  return true;
}

/** Pull a user answer that followed a matching assistant question in the transcript. */
function extractTranscriptAnswerByPatterns(transcript, patterns) {
  const rows = Array.isArray(transcript) ? transcript : [];
  for (let i = 0; i < rows.length - 1; i++) {
    if (rows[i]?.role !== "assistant") continue;
    const content = String(rows[i].content || "");
    if (!patterns.some((pattern) => pattern.test(content))) continue;
    const ans = rows[i + 1]?.role === "user" ? rows[i + 1].content : null;
    if (isUsableTranscriptAnswer(ans)) return String(ans).trim();
  }
  return null;
}

/** Pull a user answer that followed **Q{n}** in the transcript. */
function extractTranscriptAnswer(transcript, qNum) {
  const rows = Array.isArray(transcript) ? transcript : [];
  for (let i = 0; i < rows.length - 1; i++) {
    if (rows[i]?.role !== "assistant") continue;
    const content = rows[i].content || "";
    if (!new RegExp(`\\*\\*Q${qNum}\\b`, "i").test(content)) continue;
    const ans = rows[i + 1]?.role === "user" ? rows[i + 1].content : null;
    if (isUsableTranscriptAnswer(ans)) return String(ans).trim();
  }
  return null;
}

function inferRecoverySpeed(structure, transcript) {
  const existing = String(structure?.recovery_speed || "").trim();
  if (existing) return existing;

  const orbit = String(structure?.orbit_pattern || "").trim().toLowerCase();
  if (/avoid|delay|postpone|comfort/.test(orbit)) return "Slow";
  if (/collapse|overthink|pull back|overwhelm/.test(orbit)) return "Moderate";

  const userText = (Array.isArray(transcript) ? transcript : [])
    .filter((m) => m?.role === "user")
    .map((m) => String(m.content || ""))
    .join(" ")
    .toLowerCase();
  if (/burn out|overwhelm|pull back|lose momentum|one day off/.test(userText)) {
    return "Moderate";
  }
  if (/tomorrow|later|postpone|delay/.test(userText)) return "Slow";
  return "Moderate";
}

/**
 * Fill gaps after LLM extraction — sync related fields and pull transcript insights.
 */
const normalizeExtractedStructure = (structure, options = {}) => {
  if (!structure || typeof structure !== "object") return structure;
  const { transcript = [] } = options;
  let out = expandVortexLabels({ ...structure });

  let top3 = Array.isArray(out.top_3_avoidance_behaviours)
    ? out.top_3_avoidance_behaviours.filter((x) => x != null && String(x).trim()).slice(0, 3)
    : [];

  if (top3.length < 3 && Array.isArray(transcript) && transcript.length) {
    const fromTranscript = (transcript || [])
      .filter((m) => m?.role === "user")
      .map((m) => String(m.content || "").trim())
      .filter(isUsableTranscriptAnswer)
      .filter((line) => /tell myself|delay|later|phone|scroll|distract|avoid|postpone|rest|tomorrow/i.test(line));
    if (fromTranscript.length >= top3.length) {
      top3 = [...new Set(fromTranscript)].slice(0, 3);
      out.top_3_avoidance_behaviours = top3;
    }
  }

  const rule =
    out.protector_rule?.trim() ||
    out.failure_strategy?.rule?.trim() ||
    null;

  if (rule) {
    out.protector_rule = rule;
  }

  const fs =
    out.failure_strategy && typeof out.failure_strategy === "object"
      ? { ...out.failure_strategy }
      : { title: "Failure strategy", rule: rule || "", behaviours: [] };

  if (!fs.rule?.trim() && rule) fs.rule = rule;
  if (!Array.isArray(fs.behaviours) || !fs.behaviours.filter(Boolean).length) {
    fs.behaviours = top3.slice(0, 3);
  }
  fs.title = fs.title || "Failure strategy";
  out.failure_strategy = fs;

  if (!top3.length && fs.behaviours?.length) {
    out.top_3_avoidance_behaviours = fs.behaviours.slice(0, 3);
  }

  out.recovery_speed = inferRecoverySpeed(out, transcript);

  out.core_fear =
    extractTranscriptAnswerByPatterns(transcript, [
      /\*\*Q\d+[^*\n]*[Ff]ear of/i,
      /what specific fear/i,
      /\bafraid of/i,
      /core fear/i,
    ]) ||
    out.core_fear?.trim() ||
    null;

  out.perceived_risk =
    extractTranscriptAnswerByPatterns(transcript, [
      /perceived risk/i,
      /feels risky/i,
      /feels unsafe/i,
      /what feels risky/i,
    ]) ||
    out.perceived_risk?.trim() ||
    null;

  out.past_pattern =
    extractTranscriptAnswerByPatterns(transcript, [
      /past pattern/i,
      /when you['’]ve tried/i,
      /in the past/i,
      /tried multiple times/i,
      /\*\*Q\d+[^*\n]*[Ff]ear of [Dd]isappointment/i,
    ]) ||
    extractTranscriptAnswer(transcript, 8) ||
    out.past_pattern?.trim() ||
    null;

  out.required_role =
    extractTranscriptAnswerByPatterns(transcript, [
      /required role/i,
      /role or identity/i,
      /who do you need to become/i,
      /step into/i,
      /what role must you embody/i,
    ]) ||
    out.required_role?.trim() ||
    null;

  out = enrichSuccessStrategyFromSignature(out);

  if (out.daily_rep && typeof out.daily_rep === "object") {
    const rep = { ...out.daily_rep };
    if (!rep.win_condition?.trim()) {
      rep.win_condition = out.win_condition?.trim() || null;
    }
    if (!Array.isArray(rep.steps)) rep.steps = [];
    out.daily_rep = rep;
    if (rep.win_condition && !out.win_condition?.trim()) {
      out.win_condition = rep.win_condition;
    }
  }

  if (out.success_strategy && typeof out.success_strategy === "object") {
    const ss = { ...out.success_strategy };
    if (!ss.behaviour?.trim() && out.daily_rep?.name?.trim()) {
      ss.behaviour = out.daily_rep.name;
    }
    out.success_strategy = ss;
  }

  return out;
};

/** Attach resolved strategy/rep blocks for API clients (raw DB may have null objects). */
const enrichMapForClient = (map) => {
  if (!map || typeof map !== "object") return map;
  const normalized = normalizeExtractedStructure(map, {
    transcript: map.map_resistance_transcript,
  });
  const failure_strategy = resolveFailureStrategyForMap(normalized);
  const success_strategy = resolveSuccessStrategyForMap(normalized);
  const daily_rep = resolveDailyRepForMap(normalized);
  const progress_metrics = enrichProgressMetricsFromMap(
    { ...normalized, failure_strategy, top_3_avoidance_behaviours: normalized.top_3_avoidance_behaviours },
    normalized.progress_metrics,
  );
  return {
    ...normalized,
    failure_strategy: failure_strategy || normalized.failure_strategy,
    success_strategy: success_strategy || normalized.success_strategy,
    daily_rep: daily_rep || normalized.daily_rep,
    recovery_speed: normalized.recovery_speed || progress_metrics.recovery_speed || null,
    progress_metrics,
    win_condition:
      (daily_rep && typeof daily_rep === "object" ? daily_rep.win_condition : null) ||
      normalized.win_condition ||
      normalized.proof_of_success ||
      null,
  };
};

module.exports = {
  resolveFailureStrategyForMap,
  resolveSuccessStrategyForMap,
  resolveDailyRepForMap,
  enrichMapForClient,
  normalizeExtractedStructure,
  expandVortexLabels,
  parseVortexCodes,
  isWeakSuccessStrategy,
  structureHasVortexSignature,
  structureHasMinimalContent,
  mergeExtractedStructures,
  heuristicStructureFromTranscript,
};
