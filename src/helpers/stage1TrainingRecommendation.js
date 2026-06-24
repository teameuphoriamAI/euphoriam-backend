/**
 * Suggested Training — match map resistance + flip to catalog picks (Nathan "missing link").
 */

const { CONTENT_TYPES, STAGE1_TRAINING_CATALOG, TIER_RANK } = require("../constants/stage1TrainingCatalog");
const { getTier } = require("./membershipDomains");
const { resolveFailureStrategyForMap } = require("./stage1MapStructure");

const SLOT_TYPES = [
  CONTENT_TYPES.MASTERCLASS,
  CONTENT_TYPES.MEDITATION,
  CONTENT_TYPES.RECORDING,
];

const normalizeText = (value) => String(value || "").toLowerCase();

const pickFailureText = (map) => {
  const fs = resolveFailureStrategyForMap(map);
  if (typeof fs === "string") return fs;
  return [fs?.title, fs?.rule, fs?.behaviour, fs?.behavior, map?.protector_rule]
    .filter(Boolean)
    .join(" ");
};

const inferUseCases = (map, failureText) => {
  const blob = normalizeText(
    [
      failureText,
      map?.flip_belief,
      map?.flip_rule,
      map?.contradiction_statement,
      ...(map?.top_3_avoidance_behaviours || []),
    ].join(" "),
  );
  const cases = new Set();
  if (/\b(visible|visibility|seen|show|outreach|speak|share)\b/.test(blob)) {
    cases.add("visibility");
  }
  if (/\b(recover|not enough|collapse|shame|judg)\b/.test(blob)) {
    cases.add("recovery");
  }
  if (/\b(confus|stuck|don't know|unclear)\b/.test(blob)) {
    cases.add("clarity");
  }
  if (/\b(relationship|partner|friend|family|talk|connect)\b/.test(blob)) {
    cases.add("relationship");
  }
  if (/\b(money|income|price|earn|revenue)\b/.test(blob)) {
    cases.add("money");
  }
  if (/\b(action|move|rep|step|do)\b/.test(blob)) {
    cases.add("action");
  }
  if (!cases.size) cases.add("action");
  return [...cases];
};

const parseVortexEo = (map) => {
  const sig = String(map?.signature_id || map?.EO || "").trim();
  const m = sig.match(/^([A-Z]{1,3})/);
  if (m) return m[1];
  const eo = String(map?.EO || "").trim();
  return eo || null;
};

const tierCanAccess = (userTier, minTier) =>
  (TIER_RANK[userTier] ?? 0) >= (TIER_RANK[minTier] ?? 1);

const scoreCatalogItem = (item, ctx) => {
  let score = 0;
  const tags = item.tags || {};
  const failureBlob = normalizeText(ctx.failureText);

  if ((tags.domains || []).includes(ctx.domain)) score += 3;

  for (const kw of tags.resistance || []) {
    if (failureBlob.includes(normalizeText(kw))) score += 2;
    if (normalizeText(ctx.map?.avoid_type).includes(normalizeText(kw))) score += 1;
  }

  for (const uc of tags.use_cases || []) {
    if (ctx.useCases.includes(uc)) score += 2;
  }

  const eo = ctx.vortexEo;
  if (eo && (tags.vortex_eo || []).includes(eo)) score += 2;

  const flipBlob = normalizeText([ctx.map?.flip_belief, ctx.map?.flip_rule].join(" "));
  if (flipBlob && item.type === CONTENT_TYPES.MEDITATION && /\b(visible|safe|seen)\b/.test(flipBlob)) {
    score += 1;
  }

  return score;
};

const buildWhyChosen = (item, map, failureText) => {
  const flip = map?.flip_belief?.trim();
  let why = item.why_template || `Matched to your resistance map for ${map?.goal_title || "this goal"}.`;
  if (flip) {
    why += ` Your flip installs: "${flip.slice(0, 120)}${flip.length > 120 ? "…" : ""}".`;
  } else if (failureText?.trim()) {
    why += ` Resistance in play: ${failureText.trim().slice(0, 100)}${failureText.length > 100 ? "…" : ""}.`;
  }
  return why;
};

const formatPick = (item, map, user, userTier, failureText) => {
  const locked = !tierCanAccess(userTier, item.min_tier);
  return {
    slot: item.type,
    id: item.id,
    type: item.type,
    title: item.title,
    program: item.program,
    week: item.week,
    url: item.url,
    min_tier: item.min_tier,
    locked,
    accessible: !locked,
    why_chosen: buildWhyChosen(item, map, failureText),
  };
};

const pickBestForSlot = (type, catalog, ctx, usedIds) => {
  const ranked = catalog
    .filter((item) => item.type === type && !usedIds.has(item.id))
    .map((item) => ({ item, score: scoreCatalogItem(item, ctx) }))
    .sort((a, b) => b.score - a.score);

  if (!ranked.length) return null;
  const topScore = ranked[0].score;
  const tied = ranked.filter((r) => r.score === topScore);
  return (tied[0] || ranked[0]).item;
};

/**
 * @param {object} opts
 * @param {object} opts.map — domain_map row
 * @param {string} opts.domain
 * @param {object} [opts.user]
 * @param {object[]} [opts.catalog]
 */
const buildSuggestedTraining = ({
  map,
  domain,
  user = null,
  catalog = STAGE1_TRAINING_CATALOG,
}) => {
  if (!map?.map_resistance_complete) {
    return null;
  }

  const userTier = user ? getTier(user) : "bronze";
  const failureText = pickFailureText(map);
  const ctx = {
    map,
    domain,
    failureText,
    useCases: inferUseCases(map, failureText),
    vortexEo: parseVortexEo(map),
  };

  const usedIds = new Set();
  const picks = [];

  for (const slotType of SLOT_TYPES) {
    const item = pickBestForSlot(slotType, catalog, ctx, usedIds);
    if (!item) continue;
    usedIds.add(item.id);
    picks.push(formatPick(item, map, user, userTier, failureText));
  }

  return {
    generated_at: new Date().toISOString(),
    domain,
    goal_title: map.goal_title || null,
    resistance_matched: failureText?.trim().slice(0, 200) || null,
    vortex_signature: map.signature_id || map.EO || null,
    flip_focus: map.flip_belief || map.flip_rule || null,
    membership_tier: userTier,
    picks,
    primary_masterclass: picks.find((p) => p.type === CONTENT_TYPES.MASTERCLASS) || null,
    primary_meditation: picks.find((p) => p.type === CONTENT_TYPES.MEDITATION) || null,
    primary_recording: picks.find((p) => p.type === CONTENT_TYPES.RECORDING) || null,
  };
};

/**
 * Persist suggested_training on domain_map (returns patch object).
 */
const recommendTrainingForMap = ({ map, domain, user, catalog }) => {
  const suggested_training = buildSuggestedTraining({ map, domain, user, catalog });
  if (!suggested_training) return { suggested_training: null };
  return { suggested_training };
};

module.exports = {
  buildSuggestedTraining,
  recommendTrainingForMap,
  scoreCatalogItem,
  inferUseCases,
  tierCanAccess,
};
